# Muse-Codex-微信互通系统

效果：

- 微信上可以和 Muse 聊天，也可以派 Muse 干活
- 在微信或 Muse 端和 Muse 提想法；稍复杂的项目想落地时，Muse 就派 Codex 去实施：发句话，Codex 就去写代码、修东西、跑任务，结果回给你
- 不需要 VPN：你这边只用微信就行，不用翻墙、不用配代理
- 不需要你电脑开着：Muse 本身就是一台电脑，跑完可以直接在 Muse 的电脑上运行，也可以打包回你自己的电脑运行
- Codex 主机一直在后台待命，掉线了自己拉起来，不消耗额度
- 额度窗口每天自动起跑，不用你操心（针对 Plus 的 5 小时窗口，可选开启）
- 消息不丢、不重复、不迟到重发

用起来是什么样：

- 比如：不用开电脑，微信上发一句“让 Codex 来吧 用 6.1sol 高 ”，Codex 就在云上开工，跑完把结果发回微信；全程不用 VPN
- 主对话聊的内容同步一份到微信，微信聊的在主对话留备份
- 语音消息带微信转写，直接在微信里发语音也完全没问题
- Muse服务器重启也能自己恢复，不用你动手

这份东西是给同时用 Muse、Codex、微信的人用的：照着下面走一遍，就能把这套互通跑起来。

## 可靠性

- 多轮自动化验证和真实消息验收通过，收发稳定
- 长消息按段发送，到哪算哪，不会全文重发
- 一条消息只走一条路到微信，绝不重复

## 新手 5 分钟上手（不用往下看了，直接交给muse让它给你配好得了）

### 0. 你需要先有

- Muse：助手和云虚拟机都由它提供，不用你自己准备 Linux（目前在 Muse 的 Ubuntu 24.04 云虚拟机上跑通）
- Codex 主机（Muse），已经登录（只有用保活／起跑才需要）
- 微信 iLink 桥接已经登录，能收发机器人消息
- Node.js、Python 3（Muse 的虚拟机里已有）
- 定时：Muse 的 hook／定时每 60 秒跑轮询脚本；不用 Muse 的话，也可以用 cron、systemd 自己跑

### 1. 拿代码，填 4 个占位符

在所有模板文件里搜索这 4 个尖括号，逐一换成你自己的值：

| 占位符 | 是什么 | 去哪找 |
| --- | --- | --- |
| `<BOT_ACCOUNT>` | 机器人账号，如 `xxx_im.bot` | 桥接登录成功后给你的账号 |
| `<OWNER_ID>` | 机主微信 ID | 你自己的微信 ID（桥接侧） |
| `<USER_NAME>` | 你希望助手怎么称呼你 | 自己定 |
| `<ASSISTANT_NAME>` | 助手名字 | 自己定 |

### 2. 改 2 个路径

都在 `bridge/wechat-ilink-poll.sh` 开头：

- `BRIDGE_DIR`：桥接仓库的路径（默认 `$HOME/workspace/custom-connectors/wechat-ilink-bridge`）
- `WX_STATE_DIR`：桥接状态目录（也可以用环境变量覆盖，不改脚本）

### 3. 放文件、接定时

- 轮询脚本 `bridge/wechat-ilink-poll.sh` → 每 60 秒跑一次
- 看守判定器 `bridge/watchman-health.py` → 每 30 分钟跑一次（可选，第二线）
- 开关文件默认一个都不建＝新功能全关，先跑旧行为
- `bridge/wechat-ilink-poll.json` 是 Muse 的 hook 定义格式：如果你不用 Muse，照着里面的提示词和 60 秒间隔，用你自己的定时办法跑轮询脚本就行，核心可移植的是脚本本身

### 4. 开功能（按顺序，每步观察几轮再开下一个）

1. 先不开开关，跑几轮，确认收信／发信正常
2. 建 `inbound-defer-ack.enabled` → 发一条微信，确认回复一次、不重复
3. 建 `segmented-retry.enabled` → 发一条长消息（多段），确认断点续发
4. 建 `keepalive-decoupled.enabled` → 确认 Codex 保活槽正常

### 5. 验一下

跑仓库自带的 `scripts/check-setup.sh`：它会检查占位符是否还有残留、脚本语法是否通过、关键文件是否齐全。刚下载时占位符还没填，它会如实列出未填项——这不是报错，是待办清单。

## 目录说明

- `bridge/`：微信侧集成
  - `wechat-ilink-poll.sh`：每分钟轮询脚本（收信、发件箱发送、同步看守、Codex 保活都在里面；开关关闭时行为与旧版一致）
  - `wechat-ilink-poll.json`：hook 定义模板（收信确认协议＋发送规则，使用前填占位符）
  - `watchman-health.py`：第二线巡检判定器（只读）
  - `patches/`：两次修复的补丁（收信确认握手；分段续发＋保活拆锁）＋部署说明
- `codex-host/`：Codex 主机侧
  - `verify_window.py`：核对额度窗口（读会话记录的 resets_at）
  - `kickoff.md`：每天 4 档起跑规则
- `scripts/check-setup.sh`：新手自检脚本

## 三个开关（state 目录下，文件存在＝开，不存在＝关；删文件即单独回滚）

- `inbound-defer-ack.enabled`：收信先接管、处理完再确认，消息不会丢
- `segmented-retry.enabled`：长消息按段记进度发送
- `keepalive-decoupled.enabled`：保活独立运行，微信收发与 Codex 保活互不影响

## 运行规矩

- 一物一径：同一内容只走一条路到微信
- 重启自愈：机器重启后自动恢复
- 换线上脚本必须原子替换（临时文件＋mv），不原地写

## 归属与边界

- 桥接本体是第三方开源仓库（DONGH4O/wechat-ilink-bridge），本项目是集成层，不含桥接本体代码（补丁形式引用）
- 不含：登录凭据、登录状态、队列、账本、日志、聊天记录；模板里的账号／用户 ID 均为占位符，使用前替换成你自己的值
- 补丁为脱敏后的参考版：其中的占位符需替换回真实值后才能对应到你自己的环境

## 部署顺序（摘要，详见 `bridge/patches/retry-keepalive/DEPLOY.md`）

1. 核对基线哈希 → 隔离打补丁 → 校验
2. 先装桥接文件，再装轮询脚本、hook 定义（原子替换）
3. 开关保持关闭，观察若干轮 → 单开第 2 件观察 → 单开第 3 件观察 → 真实消息验收

## 拓展功能：Codex-Antigravity-Muse 额度悬浮球

见 `extensions/codex-antigravity-muse/`。

一个 Windows 桌面悬浮球，把 Codex Plus、Antigravity（Gemini / Claude / Argon）
的剩余额度放在一个球里看，适合同时用 Muse、Codex、Antigravity 的人。
Codex 走 `codex app-server` 实时查询，Antigravity 走本机 `agy /usage` 自动采集，
不手动填数、不读登录文件。打包方法与使用说明见该目录下的 README。
