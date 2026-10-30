@echo off
rem 用带调试端口的 Chromium 系浏览器打开课程页，登录态存在独立配置目录里（别删）
rem 把下面的课程地址换成你自己的（登录智慧树后进课程页复制地址）
set PROFILE=%USERPROFILE%\zhs-profile
set URL=https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=你的课程ID
start "" "chrome.exe" --remote-debugging-port=9222 --user-data-dir="%PROFILE%" --autoplay-policy=no-user-gesture-required "%URL%"
