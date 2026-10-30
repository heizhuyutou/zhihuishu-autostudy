#!/bin/bash
# 打开"看课专用"的 Chromium：独立配置目录，只装我们这一个扩展。
# 装好后开机自动跑（~/.config/autostart/zhs-chromium.desktop），也可以手动双击运行。
URL="https://wisdom-mooc.zhihuishu.com/study/index?recruitAndCourseId=4e5e5c51425d4859454a5859594559425b"
PROFILE="$HOME/zhs-profile"
EXT="$HOME/zhs-ext"
CHROME="/snap/bin/chromium"

# 不强走 X11：点击现在全走 CDP，用不着 X11；而且 snap 版 Chromium 新版在
# GDK_BACKEND=x11 + Wayland 会话下会启动即崩（GDK_IS_WAYLAND_DISPLAY 断言失败）

# 从 cron/systemd/ssh 拉起来时没有 X 授权：自己补上（桌面会话里本来就是好的）
export DISPLAY="${DISPLAY:-:0}"
if [ -z "$XAUTHORITY" ]; then
  for f in /run/user/"$(id -u)"/.mutter-Xwaylandauth.*; do
    [ -e "$f" ] && export XAUTHORITY="$f" && break
  done
fi

# 认"看课专用实例"是不是在跑：只认真浏览器进程（exe 是 chrome），
# 不能用 pgrep -f 数命令行——任何提到这个路径的命令（探针、脚本）都会误命中。
running() {
  for p in /proc/[0-9]*; do
    exe=$(readlink "$p/exe" 2>/dev/null) || continue
    case "$exe" in */chrome|*/chromium*)
      if tr '\0' ' ' <"$p/cmdline" 2>/dev/null | grep -q -- "--user-data-dir=$PROFILE"; then return 0; fi;;
    esac
  done
  return 1
}

if running; then
  # 已经在跑：只是再开一个标签页，别起第二个进程（否则扩展/配置会打架）
  exec "$CHROME" --user-data-dir="$PROFILE" "$URL"
fi

exec "$CHROME" \
  --user-data-dir="$PROFILE" \
  --load-extension="$EXT" \
  --no-proxy-server \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --password-store=basic \
  --no-first-run \
  --no-default-browser-check \
  --disable-sync \
  --disable-features=Translate,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights \
  --autoplay-policy=no-user-gesture-required \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  "$URL"
