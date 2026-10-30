#!/bin/bash
# 看守浏览器：在桌面会话里跑（开机自启就是它），挂了 20 秒内重新打开。
# 为什么不放 systemd：snap 版 Chromium 在 systemd 用户服务里会 SEGV（缺会话环境），
# 放在图形会话里启动就没事。
PROFILE="$HOME/zhs-profile"
START="$HOME/.local/share/zhs-clicker/start.sh"
LOG="$HOME/.local/share/zhs-clicker/supervise.log"
STUDY="https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=4e5f5a59455a4859454a585958435b4b5a"
stray=0
starts=()
helperAt=0

# 认"看课专用实例"：只认真浏览器进程（exe 是 chrome），不能 pgrep -f 数命令行
# （探针、脚本里提到这个路径就会误命中，浏览器没起也会当它在跑）
running() {
  for p in /proc/[0-9]*; do
    exe=$(readlink "$p/exe" 2>/dev/null) || continue
    case "$exe" in */chrome|*/chromium*)
      if tr '\0' ' ' <"$p/cmdline" 2>/dev/null | grep -q -- "--user-data-dir=$PROFILE"; then return 0; fi;;
    esac
  done
  return 1
}

while true; do
  if ! running; then
    now=$(date +%s)
    recent=()
    for t in "${starts[@]}"; do
      [ $((now - t)) -lt 600 ] && recent+=("$t")
    done
    starts=("${recent[@]}")
    if [ ${#starts[@]} -lt 3 ]; then
      starts+=("$now")
      echo "$(date '+%F %T') 拉起来" >>"$LOG"
      setsid "$START" >>"$LOG" 2>&1 &
    else
      echo "$(date '+%F %T') 10 分钟内已经重启 3 次，先不重启了（看日志）" >>"$LOG"
      sleep 300
      starts=()
    fi
  fi
  # 外挂（8971）掉了就补起来：真点击通道一断，自动答题会 defer、切课退化成 JS 点击、
  # 连下面"拉回课程页"都会失灵。脚本侧到量已不再退外挂，这里只兜崩溃/被误杀的情况。
  if ! curl -s --max-time 3 -o /dev/null "http://127.0.0.1:8971/ping"; then
    now=$(date +%s)
    if [ $((now - helperAt)) -ge 60 ]; then
      helperAt=$now
      echo "$(date '+%F %T') 外挂没在听 8971，重启 zhs-clicker.service" >>"$LOG"
      systemctl --user restart zhs-clicker.service >>"$LOG" 2>&1
      sleep 3
    fi
  fi
  # 页面跑偏（知到的公告按钮会把课程页带去 www 主站）→ 连续两次发现就拉回来
  if running; then
    bad=$(python3 - <<'PY' 2>/dev/null
import json, urllib.request
try:
    pages = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=3))
except Exception:
    print(""); raise SystemExit
urls = [p.get("url", "") for p in pages if p.get("type") == "page"]
ok = any("studyvideoh5.zhihuishu.com" in u or "login.zhihuishu.com" in u for u in urls)
print("" if ok or not urls else "bad")
PY
)
    if [ "$bad" = "bad" ]; then
      stray=$((stray + 1))
      if [ $stray -ge 2 ]; then
        echo "$(date '+%F %T') 页面跑到主站了，拉回课程页" >>"$LOG"
        if ! curl -s --max-time 5 --get --data-urlencode "u=$STUDY" "http://127.0.0.1:8971/goto" >/dev/null 2>&1; then
          # 外挂不在也要能把页面拉回来：直接让浏览器开一个新标签（只走 CDP，不依赖 8971）
          curl -s --max-time 5 -X PUT "http://127.0.0.1:9222/json/new?$STUDY" >/dev/null 2>&1
        fi
        stray=0
      fi
    else
      stray=0
    fi
  fi
  sleep 20
done
