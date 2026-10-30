#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zhs_clicker —— 知到看课脚本的"真点击"通道（CDP 版 v3，Windows / macOS / Linux 通用）

为什么不再用 xdotool：
    这台机器是 Wayland 会话，Chromium 跑在 XWayland 上。实测 xdotool 能把指针移过去、
    页面也收得到 hover，但按下/抬起不产生点击（页面 JS 一点反应都没有）。
    CDP 的 Input.dispatchMouseEvent 是浏览器内部派发的真事件（isTrusted=true），
    实测页面的 Vue 复选框、登录按钮、脚本角标都能正常响应。
    副作用：不再依赖 X11/XWayland，也不用管 X 授权。

接口（脚本侧 fetch 即可，无需任何跨域插件）：
    GET /ping                    -> {ok, version, trusted, via, cursor}
    GET /geom                    -> {window, viewport}  只读自检，不点击
    GET /move?x=..&y=..          -> 移动鼠标（页面 CSS 像素）
    GET /click?x=..&y=..         -> 移动 + 按下 + 抬起
    GET /notify?title=..&msg=..  -> 桌面通知 + 提示音
    GET /goto?u=https://...      -> 让课程页跳转（看守用它把跑偏的页面拉回来）
    GET /quit                    -> 退出

坐标约定：页面 CSS 像素，和脚本里 getBoundingClientRect 一致。
"""
from __future__ import annotations

import argparse
import base64
import re
import time
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "3.0"
CDP_PORT = int(os.environ.get("CDP_PORT", "9222"))
STUDY_HOST = "studyvideoh5.zhihuishu.com"
_last = [0.0, 0.0]


# ---------------- 极简 CDP 客户端（不装第三方库） ----------------
def http_json(path):
    with urllib.request.urlopen("http://127.0.0.1:%d%s" % (CDP_PORT, path), timeout=4) as r:
        return json.load(r)


def pick_target():
    """优先课程学习页；没有就挑第一个普通页面。"""
    pages = [t for t in http_json("/json/list") if t.get("type") == "page"]
    for t in pages:
        if STUDY_HOST in t.get("url", ""):
            return t
    return pages[0] if pages else None


class WS:
    def __init__(self, url, timeout=5):
        if not url.startswith("ws://"):
            raise RuntimeError("不是 ws 地址: %s" % url[:40])
        hostport, path = url[5:].split("/", 1)
        host, port = hostport.split(":")
        self.s = socket.create_connection((host, int(port)), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((
            "GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, hostport, key)
        ).encode())
        head = b""
        while b"\r\n\r\n" not in head:
            c = self.s.recv(1)
            if not c:
                raise RuntimeError("CDP 握手中断")
            head += c
        if b"101" not in head.split(b"\r\n")[0]:
            raise RuntimeError("CDP 握手失败")

    def send(self, obj):
        data = json.dumps(obj).encode()
        n = len(data)
        hdr = bytearray([0x81])
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr += struct.pack(">H", n)
        else:
            hdr.append(0x80 | 127)
            hdr += struct.pack(">Q", n)
        mask = os.urandom(4)
        hdr += mask
        self.s.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _read(self, n):
        buf = b""
        while len(buf) < n:
            c = self.s.recv(n - len(buf))
            if not c:
                raise RuntimeError("CDP 连接被关")
            buf += c
        return buf

    def recv(self):
        payload = b""
        while True:
            b1, b2 = self._read(2)
            fin = b1 & 0x80
            ln = b2 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._read(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._read(8))[0]
            if b2 & 0x80:
                mask = self._read(4)
                payload += bytes(x ^ mask[i % 4] for i, x in enumerate(self._read(ln)))
            else:
                payload += self._read(ln)
            if fin:
                return json.loads(payload.decode("utf-8", "replace"))

    def call(self, method, params=None):
        self.send({"id": 1, "method": method, "params": params or {}})
        for _ in range(40):
            msg = self.recv()
            if msg.get("id") == 1:
                return msg
        raise RuntimeError("CDP 无响应: " + method)

    def close(self):
        try:
            self.s.close()
        except Exception:
            pass


def window_of(target):
    """窗口在屏幕上的位置和外框尺寸（CDP 里是设备无关像素）"""
    ver = http_json("/json/version")
    bws = WS(ver["webSocketDebuggerUrl"])
    try:
        r = bws.call("Browser.getWindowForTarget", {"targetId": target["id"]})
        return r["result"]["bounds"]
    finally:
        bws.close()


def viewport_of(target):
    ws = WS(target["webSocketDebuggerUrl"])
    try:
        m = ws.call("Page.getLayoutMetrics")["result"]
        vp = m.get("cssVisualViewport") or m.get("visualViewport") or {}
        return float(vp.get("clientWidth") or 0), float(vp.get("clientHeight") or 0)
    finally:
        ws.close()


def dispatch(kind, x, y):
    """在课程页里派发一次鼠标事件。kind: mouseMoved / mousePressed / mouseReleased"""
    tgt = pick_target()
    if not tgt:
        raise RuntimeError("没有可用的浏览器页面")
    ws = WS(tgt["webSocketDebuggerUrl"])
    try:
        p = {"type": kind, "x": float(x), "y": float(y), "button": "left",
             "clickCount": 1, "buttons": 1 if kind == "mousePressed" else 0, "pointerType": "mouse"}
        ws.call("Input.dispatchMouseEvent", p)
    finally:
        ws.close()


_last_notify = {"key": None, "at": 0.0}
_NOTIFY_GAP = 600.0        # 同类消息 10 分钟内只响一次


def notify(title, msg):
    # 第二道去重闸：把数字抹掉再比。脚本那边按"稳定键"去重，这里防的是脚本换版/重启后
    # 把同一件事重新从头响一遍——真出问题时人只需要被叫一次，不是每分钟被叫一次。
    key = (str(title), re.sub(r"\d+", "#", str(msg)))
    now = time.time()
    if key == _last_notify["key"] and now - _last_notify["at"] < _NOTIFY_GAP:
        return False
    _last_notify["key"], _last_notify["at"] = key, now
    try:
        # 系统通知：Linux / macOS / Windows 各走各的
        if sys.platform == "darwin":
            script = 'display notification %s with title %s sound name "Glass"' % (
                json.dumps(str(msg)), json.dumps(str(title)))
            subprocess.Popen(["osascript", "-e", script])
        elif sys.platform == "win32":
            # Wscript.Shell.Popup：30 秒后自己消失，不挡操作
            ps = "(New-Object -ComObject Wscript.Shell).Popup('%s', 30, '%s', 0x40) | Out-Null" % (
                str(msg).replace("'", "''"), str(title).replace("'", "''"))
            subprocess.Popen(["powershell", "-NoProfile", "-Command", ps])
        else:
            subprocess.Popen(["notify-send", "-a", "智慧树", "-u", "critical", "-t", "0",
                              str(title), str(msg)])
    except Exception:
        pass
    for cmd in (("canberra-gtk-play", "-i", "alarm-clock-elapsed"),
                ("canberra-gtk-play", "-i", "bell"),
                ("paplay", "/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga"),
                ("afplay", "/System/Library/Sounds/Glass.aiff")):
        try:
            subprocess.Popen(list(cmd))
            break
        except Exception:
            continue
    return True


class Handler(BaseHTTPRequestHandler):
    server_version = "zhs_clicker/" + VERSION

    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        # Chromium 从 https 页面访问 127.0.0.1 会先发私有网络预检
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)

        def num(name):
            try:
                return float(q.get(name, [""])[0])
            except ValueError:
                return None

        if u.path == "/ping":
            try:
                ok = pick_target() is not None
                err = "" if ok else "没有浏览器页面"
            except Exception as e:
                ok, err = False, repr(e)
            out = {"ok": ok, "version": VERSION, "trusted": ok, "via": "cdp", "cursor": _last}
            if err:
                out["error"] = err
            self._send(out)
        elif u.path in ("/move", "/click"):
            x, y = num("x"), num("y")
            if x is None or y is None:
                return self._send({"ok": False, "error": "缺少 x/y"}, 400)
            _last[:] = [x, y]
            try:
                dispatch("mouseMoved", x, y)
                if u.path == "/click":
                    dispatch("mousePressed", x, y)
                    dispatch("mouseReleased", x, y)
                self._send({"ok": True, "clicked" if u.path == "/click" else "moved": [x, y],
                            "via": "cdp"})
            except Exception as e:
                self._send({"ok": False, "error": repr(e)})
        elif u.path == "/geom":
            try:
                tgt = pick_target()
                if not tgt:
                    raise RuntimeError("没有可用的页面")
                b = window_of(tgt)
                vw, vh = viewport_of(tgt)
                self._send({"ok": True, "window": b, "viewport": [vw, vh],
                            "note": "点击坐标 = 页面 CSS 像素（脚本那边直接算，无需换算）"})
            except Exception as e:
                self._send({"ok": False, "error": repr(e)})
        elif u.path == "/goto":
            target = (q.get("u") or [""])[0]
            if not target.startswith("https://"):
                return self._send({"ok": False, "error": "只接受 https 地址"}, 400)
            try:
                tgt = pick_target()
                if not tgt:
                    raise RuntimeError("没有可用的页面")
                ws = WS(tgt["webSocketDebuggerUrl"])
                try:
                    ws.call("Page.navigate", {"url": target})
                finally:
                    ws.close()
                self._send({"ok": True, "goto": target[:80]})
            except Exception as e:
                self._send({"ok": False, "error": repr(e)})
        elif u.path == "/notify":
            sent = notify(q.get("title", ["智慧树"])[0][:60], q.get("msg", [""])[0][:160])
            self._send({"ok": True, "sent": bool(sent)})
        elif u.path == "/quit":
            self._send({"ok": True, "bye": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
        else:
            self._send({"ok": False, "error": "未知接口"}, 404)

    def do_POST(self):
        self._send({"ok": False, "error": "只支持 GET"}, 405)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8971)
    ap.add_argument("--quiet", action="store_true", help="（兼容旧参数，忽略）")
    ap.add_argument("--selftest", action="store_true", help="检查能不能连上浏览器调试端口")
    args = ap.parse_args()

    if args.selftest:
        try:
            t = pick_target()
            print("CDP 可用，当前页面: %s (%s)" % (t["url"][:70], t["title"][:30]) if t else "没有页面")
        except Exception as e:
            print("CDP 不可用: %r" % (e,))
        return

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    srv.daemon_threads = True
    sys.stderr.write("[zhs-clicker %s] CDP 点击通道 127.0.0.1:%d (浏览器调试端口 %d)\n"
                     % (VERSION, args.port, CDP_PORT))
    sys.stderr.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
