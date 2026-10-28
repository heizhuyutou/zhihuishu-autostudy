#!/bin/bash
# 打开"看课专用"的 Chromium：独立配置目录，只装我们这一个扩展。
# 装好后开机自动跑（~/.config/autostart/zhs-chromium.desktop），也可以手动双击运行。
URL="https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=4e5f5a59455a4859454a585958435b4b5a"
PROFILE="$HOME/zhs-profile"
EXT="$HOME/zhs-ext"
CHROME="/snap/bin/chromium"

# 必须走 X11：xdotool 只能点 X 窗口；另外在没有完整桌面会话时 GTK 会试 Wayland 然后崩
export GDK_BACKEND=x11

# 从 cron/systemd/ssh 拉起来时没有 X 授权：自己补上（桌面会话里本来就是好的）
export DISPLAY="${DISPLAY:-:0}"
if [ -z "$XAUTHORITY" ]; then
  for f in /run/user/"$(id -u)"/.mutter-Xwaylandauth.*; do
    [ -e "$f" ] && export XAUTHORITY="$f" && break
  done
fi

if pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null 2>&1; then
  # 已经在跑：只是再开一个标签页，别起第二个进程（否则扩展/配置会打架）
  exec "$CHROME" --user-data-dir="$PROFILE" "$URL"
fi

exec "$CHROME" \
  --user-data-dir="$PROFILE" \
  --load-extension="$EXT" \
  --ozone-platform=x11 \
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
