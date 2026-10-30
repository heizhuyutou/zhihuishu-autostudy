# AGENT 部署说明

> 用法：把这份文件整个交给你的 AI agent（粘贴，或指给它看这个文件），它照着做就能把看课助手部署到你的机器上。人只需要做两件事：登录智慧树、必要时拖一下验证码滑块。

## 这个项目是什么

智慧树（知到）看课助手：自动播视频、自动答视频里弹的小题、播完自动切下一课、到时长自动停、掉线自己续播。Windows、macOS、Linux 通用。

组成：

| 文件 | 作用 |
| --- | --- |
| `智慧树弹题自动答题.user.js` | 主脚本，当浏览器扩展加载，负责判断（识别弹题、算坐标、决定切课、计时） |
| `helper/zhs_clicker.py` | 外挂，小 HTTP 服务 `127.0.0.1:8971`，负责真鼠标点击（CDP Input 事件，浏览器按真人输入处理） |
| `helper/manifest.json` | 扩展清单（MV3） |
| `windows/` `macos/` `ubuntu/` | 各平台启动器和部署脚本 |

为什么要有外挂：智慧树的弹题组件只认真人鼠标操作，页面里用脚本合成出来的点击它一律忽略（实测五种打法都无效）。作答、关弹窗、切课都必须走外挂的真点击。

## 部署流程

先判断用户操作系统，走对应小节。共同步骤：

1. 拿到仓库文件（`git clone` 或 Download ZIP 解压），下文称「仓库目录」
2. 建扩展目录，放两个文件：仓库目录里 `helper/manifest.json`，以及仓库根目录的 `智慧树弹题自动答题.user.js`（改名 `zhs.user.js`）
3. 浏览器带 `--remote-debugging-port=9222 --user-data-dir=<独立配置目录>` 启动（命令见各平台小节）
4. 装扩展：浏览器打开 `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选扩展目录。（新版 Chrome 稳定版禁了 `--load-extension` 参数，用这种方式装最稳）
5. 让用户自己在浏览器里登录智慧树，勾「保存密码」。**不要替用户输密码**
6. 启动外挂（各平台小节有命令）
7. 打开课程页
8. 按「验收清单」核对

### Windows

前提：装 Python 3（安装时勾上 Add python.exe to PATH）。

```powershell
# 扩展目录和配置目录都在用户目录下
cd $env:USERPROFILE
New-Item -ItemType Directory -Force zhs-ext, zhs-profile
Copy-Item <仓库目录>\helper\manifest.json zhs-ext\
Copy-Item "<仓库目录>\智慧树弹题自动答题.user.js" zhs-ext\zhs.user.js

# 浏览器（Chrome 或 Edge）
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=$env:USERPROFILE\zhs-profile --autoplay-policy=no-user-gesture-required

# 外挂（另开一个窗口，保持开着）
python <仓库目录>\helper\zhs_clicker.py
```

仓库里的 `windows\启动学习页.bat`、`windows\启动外挂.bat` 就是这两步的现成版本。

### macOS

自带 python3。

```bash
mkdir -p ~/zhs-ext ~/zhs-profile
cp <仓库目录>/helper/manifest.json ~/zhs-ext/
cp "<仓库目录>/智慧树弹题自动答题.user.js" ~/zhs-ext/zhs.user.js

open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=$HOME/zhs-profile --autoplay-policy=no-user-gesture-required

python3 <仓库目录>/helper/zhs_clicker.py
```

现成版本：`macos/启动外挂.command`。

### Ubuntu

```bash
cd <仓库目录>/ubuntu && bash 安装到ubuntu.sh
systemctl --user start zhs-clicker.service
```

安装脚本会放好扩展目录、外挂、systemd 服务和看守。**不要 enable 这个服务**（用户明确要求不开机自启）。看守 `supervise.sh` 负责浏览器崩了重开、页面跑偏拉回、外挂停了补起。

## 验收清单

- [ ] `curl http://127.0.0.1:8971/ping` 返回 `{"ok": true, ...}`
- [ ] 浏览器右下角角标显示 `zhs v1.18.6` 和状态（不是空白）
- [ ] 课程页里视频自动播放，或角标显示 `等 08:xx 开播`（没到当日开播时刻）
- [ ] 视频里弹题出现时鼠标自己动，选一个、关闭弹窗
- [ ] 一课播完自动切到下一课，且跳过已看完的
- [ ] （Ubuntu）重新登录后：看守自己拉起浏览器和课程页，外挂自动在

哪条不满足：看 README「十一、排查」。角标是主要状态出口，先看角标。

## 硬性约束（不要做）

- **不要自动拖验证码滑块**（腾讯防水墙按轨迹判人机，硬拖会送风控把柄）。出现就叫用户手动拖，拖完自动继续
- **不要替用户输入密码或任何凭据**，也不要写进文件、日志、提交记录
- **不要把自动作答用于计成绩的测验、考试**。它只用于视频里弹的小题，前提是答对答错不计成绩
- **不要用页面内合成点击替代外挂**（`element.click()` 之类没用，实测无效）
- **不要删 `--user-data-dir` 指向的目录**：登录态、保存的密码都在里面
- **自启按 Ubuntu 小节装好就行**（外挂服务 enable + 桌面自启项拉看守）。只有用户明确说不要自启，才 `systemctl --user disable zhs-clicker.service` 并删 `~/.config/autostart/zhs-chromium.desktop`
- 改了脚本必须重启浏览器才生效（内容脚本在扩展加载时就缓存了）

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 角标 `外挂不通` | 外挂没起来或端口被占。`curl http://127.0.0.1:8971/ping` 确认，重跑外挂 |
| 角标 `需登录` | 登录过期，叫用户去浏览器里重新登录 |
| 装了扩展但角标不出现 | 浏览器是不是带 `--remote-debugging-port=9222` 启动的？扩展是不是加载了改名后的 `zhs.user.js`？ |
| 改了脚本没生效 | 重启浏览器 |
| 只有 Ubuntu 需要额外装东西吗 | 不需要。Ubuntu 的安装脚本多做的是看守（自动重启），其他平台手动开外挂即可 |
