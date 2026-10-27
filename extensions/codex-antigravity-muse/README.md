# Codex-Antigravity-Muse · 额度悬浮球

这是 Muse-Codex-微信互通系统的一个拓展功能：一个 Windows 桌面悬浮球，
把你在用的几个 AI 额度放在一个球里看，不用来回翻各个应用。

它适合同时用 Muse、Codex、Antigravity 的人：Muse 派活、Codex 实施、
Antigravity（Google AI Pro）做备用额度池，球里能同时看到它们的剩余额度。

## 球里有哪几组

| 组 | 说明 |
|---|---|
| Codex Plus | ChatGPT Plus 里的 Codex 额度：5 小时窗口 + 周窗口 |
| Gemini | Antigravity 里的 Gemini 组：5 小时 + 周 |
| Claude | Antigravity 里的 Claude 组：5 小时 + 周（Antigravity 官方叫它 Claude and GPT models，这里按默认用途只叫 Claude，因为 GPT 那边已经有 Codex 了） |
| Gemini 4 Argon | Antigravity 里的 Argon：只有周窗口 |

注意：Muse 本身没有额度接口，所以球里没有 Muse 的额度数字；
“Muse”在名字里指的是这套工作流（Muse 派活），不是一个可读的额度池。

## 数据从哪里来（不编数）

- **Codex（实时优先）**：启动本机 `codex.exe app-server --listen stdio://`，
  依次发 `initialize`、`initialized`、`account/read`、`account/rateLimits/read`，
  取 `rateLimitsByLimitId.codex` 的 `primary`（5 小时）和 `secondary`（周），
  剩余 = 100 - 已用百分比。登录凭据由 Codex 自己读，悬浮球不直接打开、
  解析你的登录文件。找不到 `codex` 命令时，改用本机已有的 Codex 登录
  问 ChatGPT 后端 `GET /backend-api/wham/usage`（token 只发给 chatgpt.com，
  不写日志、不存文件）；再失败才回落到本机 Codex 会话文件的最后记录。
- **Antigravity**：以交互模式跑本机 `agy`，把 `/usage` 写进 stdin 管道，
  解析它打到 stdout 的 TSV 百分比。`agy --print /usage` 不可用，它会把
  `/usage` 当成模型提问而超时。agy 自己处理登录，悬浮球不读、不存、
  不输出任何授权文件或凭证。官方不公开 token 数，所以这里只显示百分比。
- **用量表**：本机 Codex 会话文件里的 `token_count` 记录（最近 10 个会话）；
  Antigravity 的行不计 token 数，只显示百分比变化。

首次启动时 Antigravity 没有占位数据，第一次自动采集成功后才会显示；
Codex 找不到记录时显示“暂无数据”，不编百分比。

## 用起来

1. 先决条件（都在你自己的电脑上做一次）：
   - 装好 Codex（桌面应用或命令行版均可）并用你的 ChatGPT 账号登录过；
   - 装好 Antigravity CLI（`agy`）并用你的 Google 账号登录过，且 `agy` 在 PATH 里。
     云主机上的登录不能给 Windows 用，Windows 上要自己再登录一次。
2. 打包（需要联网一次，下载 Electron 与 electron-builder）：
   ```bash
   cd extensions/codex-antigravity-muse
   npm install
   npm run check
   npm run pack
   ```
   产物在 `dist/win-unpacked/`，里面有 `QuotaFloat.exe`，把整个文件夹
   发给要用的电脑即可，免安装。
3. 双击 `QuotaFloat.exe`：屏幕上出现悬浮球，点击打开仪表盘（620×720，
   无滚动条）。顶部栏右侧有“刷新数据”按钮，所有标签页都能看到；
   托盘菜单也有“刷新数据”。
4. 拖动悬浮球：松手时离屏幕左/右边缘 ≤30px 就自动贴边，变成窄条；
   窄条两行：大字是 5 小时剩余（主），小字是周剩余（次），Argon 只显示周。
   点击窄条恢复完整球。关闭仪表盘窗口不会退出，悬浮球和托盘继续运行；
   退出请右键托盘图标 → 退出。
5. 设置页：浅色 / 暗色 / 跟随系统，开机自启开关，Codex 与 Antigravity 的
   来源与最后采集时间。没有手动填写入口。

## 已知限制

- 未做安装包、自动更新、代码签名；首次运行 Windows SmartScreen 可能
  提示未知发布者，点“运行”即可（未签名是个人小工具的常见情况，不是
  查出了病毒）。
- 仪表盘按 620×720 设计；屏幕可用高度小于约 760px 时窗口可能被系统裁切。
- Codex 的用量表只反映本机 Codex 会话，在别的设备上用的 Codex 不会
  出现在用量表里，但实时额度（app-server / 后端接口）是全账号的。

## 文件

| 文件 | 作用 |
|---|---|
| `main.js` | 主进程：悬浮球与贴边、仪表盘、托盘、定时扫描、IPC、开机自启 |
| `preload.js` | 向渲染进程暴露受限的 `window.QF` |
| `scanner.js` | 本地 Codex 会话文件扫描 |
| `antigravity.js` | `agy /usage` 管道采集与解析 |
| `codex-live.js` | `codex app-server` 实时查询 |
| `codex-api.js` | ChatGPT 后端接口备用查询 |
| `seed.json` | 首次启动占位（通用版为空，第一次采集后替换） |
| `renderer/` | 仪表盘与悬浮球界面 |
| `assets/icon.png` | 图标 |

本拓展与主仓库同为 MIT 协议。
