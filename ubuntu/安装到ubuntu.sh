#!/bin/bash
# 把看课脚本 + 真鼠标外挂装到这台 Ubuntu（用户级，不需要 sudo）
# 用法：bash 安装到ubuntu.sh          （可反复跑，幂等）
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/zhs-clicker"
EXT="$HOME/zhs-ext"
USERSCRIPT="$HERE/../智慧树弹题自动答题.user.js"

[ -f "$USERSCRIPT" ] || { echo "找不到 $USERSCRIPT"; exit 1; }
mkdir -p "$DEST" "$EXT" "$HOME/.config/systemd/user" "$HOME/.config/autostart"

# 1) 点击器
install -m 755 "$HERE/../helper/zhs_clicker.py" "$DEST/zhs_clicker.py"
# 2) 学习页启动器 + 看守
install -m 755 "$HERE/启动学习页.sh" "$DEST/start.sh"
install -m 755 "$HERE/supervise.sh" "$DEST/supervise.sh"
# 3) 扩展（把油猴脚本原样当内容脚本用）
install -m 644 "$USERSCRIPT" "$EXT/zhs.user.js"
install -m 644 "$HERE/../helper/manifest.json" "$EXT/manifest.json"
# 4) 两个 systemd 用户服务：外挂 + 浏览器，都是崩了自动拉起
install -m 644 "$HERE/zhs-clicker.service" "$HOME/.config/systemd/user/zhs-clicker.service"
# 5) 学习页桌面自启（放在图形会话里启动：snap 版 Chromium 在 systemd 下会崩）
mkdir -p "$HOME/.config/autostart"
sed "s#__HOME__#$HOME#g" "$HERE/zhs-chromium.desktop" > "$HOME/.config/autostart/zhs-chromium.desktop"
systemctl --user disable zhs-chromium.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/zhs-chromium.service"

systemctl --user daemon-reload
systemctl --user enable --now zhs-clicker.service
systemctl --user restart zhs-clicker.service
loginctl enable-linger "$USER" 2>/dev/null || true

sleep 1
echo "--- 自检 ---"
echo -n "外挂: "; curl -s --max-time 3 http://127.0.0.1:8971/ping || echo "不通"
echo
echo "扩展: $(ls "$EXT" | tr '\n' ' ')"
echo "服务: 外挂 $(systemctl --user is-enabled zhs-clicker.service)/$(systemctl --user is-active zhs-clicker.service)"
echo "浏览器: 桌面自启 $(test -f "$HOME/.config/autostart/zhs-chromium.desktop" && echo 已装)，看守脚本 $(test -x "$DEST/supervise.sh" && echo 已装)"
