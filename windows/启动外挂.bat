@echo off
rem 真鼠标外挂（CDP 版）。前提：装好 Python 3；浏览器用 --remote-debugging-port=9222 启动
cd /d %~dp0
python "%~dp0..\helper\zhs_clicker.py"
pause
