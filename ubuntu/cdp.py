#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""cdp.py —— 不装任何依赖，用调试端口看 Chromium 里那个页面到底在干嘛。

用法：
    python3 cdp.py                   # 打印页面状态（URL、标题、角标、视频、cookie）
    python3 cdp.py 'JS 表达式'        # 在页面里执行任意 JS 并打印返回值

前提：Chromium 是用 --remote-debugging-port=9222 启动的（start.sh 已经带了）。
"""
import base64
import json
import os
import socket
import ssl  # noqa: F401
import struct
import sys
import urllib.request

PORT = int(os.environ.get("CDP_PORT", "9222"))

DEFAULT_JS = r"""JSON.stringify({
  href: location.href,
  title: document.title,
  badge: (document.getElementById('zhs-badge') || {}).textContent || '(没有角标)',
  passwordBox: !!document.querySelector('input[type=password]'),
  cookies: document.cookie.length,
  videos: [...document.querySelectorAll('video')].map(v => ({
    paused: v.paused, t: +v.currentTime.toFixed(1), dur: v.duration, ready: v.readyState
  }))
})"""


def targets():
    with urllib.request.urlopen("http://127.0.0.1:%d/json/list" % PORT, timeout=5) as r:
        return json.load(r)


def ws_connect(url):
    assert url.startswith("ws://")
    rest = url[5:]
    hostport, path = rest.split("/", 1)
    path = "/" + path
    host, port = hostport.split(":")
    s = socket.create_connection((host, int(port)), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((
        "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, hostport, key)
    ).encode())
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = s.recv(1)
        if not chunk:
            raise RuntimeError("握手中断")
        head += chunk
    if b"101" not in head.split(b"\r\n")[0]:
        raise RuntimeError("握手失败: %r" % head[:120])
    return s


def ws_send(s, text):
    data = text.encode()
    header = bytearray([0x81])
    n = len(data)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header += struct.pack(">H", n)
    else:
        header.append(0x80 | 127)
        header += struct.pack(">Q", n)
    mask = os.urandom(4)
    header += mask
    s.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def ws_recv(s):
    def rd(n):
        buf = b""
        while len(buf) < n:
            c = s.recv(n - len(buf))
            if not c:
                raise RuntimeError("连接被关")
            buf += c
        return buf

    payload = b""
    while True:
        b1, b2 = rd(2)
        fin, opcode = b1 & 0x80, b1 & 0x0F
        ln = b2 & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", rd(2))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", rd(8))[0]
        if b2 & 0x80:
            mask = rd(4)
            payload += bytes(x ^ mask[i % 4] for i, x in enumerate(rd(ln)))
        else:
            payload += rd(ln)
        if fin:
            return payload.decode("utf-8", "replace")
        if opcode == 0x9:   # ping
            ws_send(s, "")


def evaluate(js, target_url_part=None):
    pages = [t for t in targets() if t.get("type") == "page"]
    if target_url_part:
        pages = [t for t in pages if target_url_part in t.get("url", "")] or pages
    if not pages:
        raise SystemExit("没有可用的页面")
    tgt = pages[0]
    s = ws_connect(tgt["webSocketDebuggerUrl"])
    ws_send(s, json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {
        "expression": js, "returnByValue": True, "awaitPromise": True}}))
    for _ in range(30):
        msg = json.loads(ws_recv(s))
        if msg.get("id") == 1:
            r = msg.get("result", {})
            if "exceptionDetails" in r:
                return "JS 报错: " + json.dumps(r["exceptionDetails"], ensure_ascii=False)[:300]
            return r.get("result", {}).get("value")
    return "(没等到结果)"


def click_at(x, y, target_url_part=None):
    """用 CDP 在页面里派发一次鼠标点击（可信事件，能触发 autofill / 普通按钮）。"""
    pages = [t for t in targets() if t.get("type") == "page"]
    if target_url_part:
        pages = [t for t in pages if target_url_part in t.get("url", "")] or pages
    tgt = pages[0]
    s = ws_connect(tgt["webSocketDebuggerUrl"])
    mid = 0
    for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
        mid += 1
        ws_send(s, json.dumps({"id": mid, "method": "Input.dispatchMouseEvent", "params": {
            "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1}}))
        for _ in range(20):
            m = json.loads(ws_recv(s))
            if m.get("id") == mid:
                break
    return "clicked %s,%s" % (x, y)


if __name__ == "__main__":
    if sys.argv[1:2] == ["--click"]:
        print(click_at(float(sys.argv[2]), float(sys.argv[3])))
        raise SystemExit
    expr = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_JS
    out = evaluate(expr)
    if isinstance(out, str) and out.startswith("{"):
        try:
            print(json.dumps(json.loads(out), ensure_ascii=False, indent=2))
        except ValueError:
            print(out)
    else:
        print(out)
