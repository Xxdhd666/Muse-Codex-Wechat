本清单供复核后部署使用；本次没有执行任何线上替换、开关启用、真实发送或登录操作。所有补丁以本目录 `baseline/` 的当前线上快照为基线，不能套到第 1 件修复之前的旧版本。

1. **复核基线并暂停现有入口。**

   先暂停现有微信轮询、第二线、天气发送，以及可能调用同一桥接的既有消费者/MCP 发送；等待正在运行的实例自然结束。不要启动另一个收信/发送循环，不手工删锁，不改登录态。现有锁的释放/恢复仍只用原协议。检查当前版本未漂移：

   ```bash
   set -euo pipefail
   JOB_DIR=/home/hatch/workspace/codex-jobs/fix-retry-keepalive-20261024
   cd "$JOB_DIR"
   python3 test-support/verify-delivery.py
   ```

   此检查只读取已列入清单的源码、脚本、任务定义和两个新开关的存在性；不读取凭据或运行队列。它核对 `BASELINE-SHA256.json` 中 132 个文件，任何冲突、哈希差异、fuzz 或 offset 都停止。开关首次部署前必须不存在。不要通过忽略哈希、强制打补丁或降级基线来继续。

2. **备份源码并在隔离目录应用全部补丁。**

   `baseline/` 已是修改前的源码快照，含原 0770 轮询脚本、原 hook 定义和包含第 1 件修复的桥接。部署时为这份已核对快照再留一份只读源备份；不要复制账号、登录文件或整个运行 state。

   ```bash
   RELEASE_DIR="$(mktemp -d "$JOB_DIR/deploy-stage.XXXXXX")"
   cp -a "$JOB_DIR/baseline" "$RELEASE_DIR/source-backup"
   cp -a "$JOB_DIR/baseline" "$RELEASE_DIR/staged"
   ```

   对下表每一行，在对应 `staged/<组件>` 上先 dry-run，再正式应用。所有组件完成验证前均不得发布其中任意一个。

   | 组件 | 补丁 | 部署目标 |
   | --- | --- | --- |
   | bridge | bridge-send-retry.patch | 原桥接源码目录 |
   | poll | poll-retry-keepalive.patch | hooks/scripts/wechat-ilink-poll.sh |
   | hook | hook-send-contract.patch | hooks/definitions/wechat-ilink-poll.json，仅发送结果提示词 |
   | weather | weather-send-contract.patch | 原天气任务正文 |
   | watchman | watchman-keepalive.patch | 原第二线任务正文 |

   例如轮询补丁：

   ```bash
   patch --batch --forward --fuzz=0 --dry-run -p1 -d "$RELEASE_DIR/staged/poll" -i "$JOB_DIR/poll-retry-keepalive.patch"
   patch --batch --forward --fuzz=0 -p1 -d "$RELEASE_DIR/staged/poll" -i "$JOB_DIR/poll-retry-keepalive.patch"
   bash -n "$RELEASE_DIR/staged/poll/wechat-ilink-poll.sh"
   ```

   其他四行使用相同参数及各自目录/补丁。检查输出无 offset；与 `candidate/` 逐文件比对，结果必须完全一致。不要直接在 live 上试补丁。`test-support/verify-delivery.py` 已对五份补丁完成同样的隔离应用和一致性验证。

3. **部署支持代码，仍不开启两个新行为。**

   保持第 1 步入口暂停。桥接只安装 `CHANGES.json` 中 component=bridge 的新增/改动文件；其余源码不覆盖。先安装新增模块和判断器，再安装引用它们的源码。每个文件均在目标目录写临时文件、保持原权限、校验后 `os.replace` 或同目录 `mv`；禁止原地写入正被解释器读取的源码。新增账本模块/测试/文档不包含运行状态。

   轮询必须按以下同目录原子 rename 方式安装，权限保持 **0770**：

   ```bash
   POLL_LIVE="$HOME/hooks/scripts/wechat-ilink-poll.sh"
   POLL_NEXT="$(mktemp "$HOME/hooks/scripts/.wechat-ilink-poll.next.XXXXXX")"
   cat "$RELEASE_DIR/staged/poll/wechat-ilink-poll.sh" > "$POLL_NEXT"
   chmod 0770 "$POLL_NEXT"
   bash -n "$POLL_NEXT"
   cmp "$RELEASE_DIR/staged/poll/wechat-ilink-poll.sh" "$POLL_NEXT"
   mv -T "$POLL_NEXT" "$POLL_LIVE"
   test "$(stat -c %a "$POLL_LIVE")" = 770
   ```

   hook 定义也在同目录校验 JSON 后原子替换，保持原 0660，只增加发送结果规则；不改变 enabled、轮询间隔 60 秒、超时 90 秒、接收协议 A–E 或调度入口。天气和第二线安装相应任务正文，并通过原有平台确认实际加载的新正文；文件更新本身不能证明平台已加载。

   不创建 `segmented-retry.enabled`、`keepalive-decoupled.enabled`。**不要移除或改写现有 `inbound-defer-ack.enabled`**，不要恢复旧 hook 提示词覆盖接收协议。新支持代码全部就位后恢复原有入口，观察至少 3 个正常轮询周期：收信终结结果、三类职责日志和原有 defer-ack 路径。此阶段没有分段账本的消息必须仍走旧发送路径和旧保活结构。

4. **先单独开启第 2 件。**

   暂停并排空既有发送事务，确认 hook/天气已使用稳定逻辑 ID 和同一四态契约，再创建开关；保活开关继续不存在。

   ```bash
   STATE_DIR="$HOME/workspace/custom-connectors/wechat-ilink/state"
   install -m 0600 /dev/null "$STATE_DIR/.segmented-retry.enabled.next"
   mv -T "$STATE_DIR/.segmented-retry.enabled.next" "$STATE_DIR/segmented-retry.enabled"
   ```

   恢复原入口并观察。outbox 使用 `outbox:<文件名>`，天气使用 `weather:<日期>`，消费者回复使用 `inbound:<原消息ID>:reply:<序号>`。同一逻辑消息重试保持 ID 和正文不变。MCP 调用方同样传 `deliveryId`。未给 ID 时按接收者及正文识别同一消息，重复正文的独立新消息必须另给稳定 ID，不能借此绕过待确认记录。

   看到 delivered 才可说完整送达；queued 不再写另一条 outbox；partial 只能按原 ID 续发；unknown 停止自动发送。待确认查询：

   ```bash
   WX_STATE_DIR="$STATE_DIR" node "$HOME/workspace/custom-connectors/wechat-ilink-bridge/src/cli/index.js" queue send-reports --account BOT_ACCOUNT --json
   ```

   该维护命令不加载登录凭据，也不联网。主对话实际报告后，按返回协议使用 `queue send-report-ack` 确认**报告事实**，不会解除发送暂停。不可删除账本、换 ID 或把全文重新排队来清故障。

5. **再单独开启第 3 件。**

   暂停第一线与第二线，并等待全部旧结构实例结束，再创建独立保活开关，防止旧 owner 串行化与新结构同时运行。

   ```bash
   install -m 0600 /dev/null "$STATE_DIR/.keepalive-decoupled.enabled.next"
   mv -T "$STATE_DIR/.keepalive-decoupled.enabled.next" "$STATE_DIR/keepalive-decoupled.enabled"
   ```

   恢复原有两线；不要增加调度入口。确认保活在争取 `.outbox.lock` 前执行；独立 `.codex-keepalive.mutex` 忙时返回 75，不等待发送锁；两线仍对同一 `.codex-remote.json` 启动前预约，冷却仍为 600 秒。

   总预算：保活 15 秒、微信职责 65 秒，预留约 10 秒给原 90 秒外层；微信内部维护 3 秒、outbox 8 秒、清理 2 秒、报告/看门狗 5 秒、fetch/后续确认窗口 42 秒，并受 65 秒总上限约束。预算不足会跳过本轮后续发送。发送被截断后有在途账本就进入待确认，不盲目重试。微信总预算超时时，先终止该受监督进程组，再经原 PYLOCK release 释放它自己的 lease；陌生/不确定 owner 留给原自愈规则。

6. **最后由复核方做真实消息验收。**

   本次仅完成离线验收，没有真实发送、真实账号或登录操作。上线观察稳定后，用原来唯一的 hook 消费者接收一条真实测试消息并回复，核对微信端实收、CLI 四态、账本段序号和 receiver complete。再验证一条跨段回复；不要为了制造丢响应而在真实账号上强杀发送。故障注入仅使用已交付的离线测试。`rc=0` 不能证明微信实收，进程身份成功也不能证明 Codex 远端 connected。

7. **第 2 件独立关闭/回滚。**

   只暂停并排空正在进行的发送事务/第一线；保留第 3 件开关。只执行：

   ```bash
   rm -- "$STATE_DIR/segmented-retry.enabled"
   ```

   恢复既有入口。未进入新账本的消息恢复旧行为；已入账的 delivered 仍不重发，partial/inflight/unknown 保持保护或暂停。保留 `.segmented-send.ledger`、原 delivery queue/outbox、voids、报告凭据、已确认 ID 和去重账本。此为独立功能回滚；支持模块和结果判断器保留，不能把它们换回忽略账本的旧代码。首次从未启用、没有新账本时才可另行复核源码回退；不把运行状态恢复成旧备份。

8. **第 3 件独立关闭/回滚。**

   暂停第一线、第二线并排空新结构实例；保留第 2 件开关。只执行：

   ```bash
   rm -- "$STATE_DIR/keepalive-decoupled.enabled"
   ```

   恢复既有入口后，保活回到原发送 owner 内执行，第二线也恢复原 owner 协议。保留 `.codex-remote.json` 的 last_attempt/失败次数/通知事实，不重置 600 秒冷却；`.codex-keepalive.mutex` 文件保留，不删除正在使用的互斥 inode。不整份反向应用组合轮询补丁，以免连带撤销第 2 件的消费端支持或第 1 件的接收确认修复。

9. **部署后验证与复测。**

   只检查已发布源码哈希、权限、语法、原有日志和实际加载的任务正文；不要读取凭据。首次部署前的 `verify-delivery.py` 专门核对旧基线，部署后不应再拿旧基线去覆盖新源码。离线复测命令见 REPORT.md；测试辅助层只用于测试，不安装到线上，不设置线上 NODE_OPTIONS。
