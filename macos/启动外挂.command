#!/bin/bash
# 真鼠标外挂（CDP 版）。前提：python3 可用；浏览器用 --remote-debugging-port=9222 启动
cd "$(dirname "$0")"
exec python3 ../helper/zhs_clicker.py
