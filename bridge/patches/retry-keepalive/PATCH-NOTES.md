`poll-retry-keepalive.patch` 是标准 unified diff。下表按当前基线的 hunk 顺序解释全部 15 处改动；原始行号以补丁 `@@` 为准。补丁不包含线上状态数据。

| 原始位置 | 改动理由与开关边界 |
| --- | --- |
| 1：脚本入口 | 内部保活 worker 不加载 hook 终结协议，只输出职责日志；正常、backup-probe、backup-recover 入口原行为保留 |
| 24：bridge 函数名称 | 保留原不受限桥接调用体，供新结构关闭时调用 |
| 32：新增预算监督器、bridge 包装、state_op guard | 开关打开才产生独立 worker。保活互斥为固定 inode 的非阻塞 flock；15 秒保活槽先于发送锁。微信只有一个受监督 worker 获取原 owner，65 秒总预算；超时终止进程组并通过未修改的 PYLOCK release 释放自己的 lease。开启时 state_op 对既有 STATE 目录 inode 串行 guard 做读改写，避免两线共用冷却与告警文件丢更新；不另建第二份冷却 |
| 106：send_result 默认值 | 分段开关打开而响应不可解析时保守归 unknown；关闭时仍用原 failed 默认值 |
| 115：显式四态解析 | 仅在返回包含 deliveryStatus 时调用与天气相同的离线判断器；旧响应仍走原 chunkCount/sent 解析 |
| 258：同步看门狗候选 | 已有分段进度的 partial/unknown/delivered 不被当成“整条未发送”而作废；unknown 使用独立只读报告，void 表和原 void/ack 实现完全保留 |
| 306：remote_command | 独立保活 worker 中的外部命令保留在受监督进程组，15 秒总超时能覆盖命令后代；旧结构仍采用原 20 秒命令上限和原会话处理 |
| 619：保活分派 | 新开关打开时，第一线及 --backup-keepalive 共用独立互斥，先执行保活再争取发送锁；关闭时原 backup owner 分支逐字保留。backup-recover 与只读 probe 不进入新结构 |
| 705：维护窗口 | 微信新结构中为队列维护设置 3 秒总窗口；关闭时仅有未使用的计时变量 |
| 715：outbox 窗口 | 8 秒整批窗口，预算耗尽停止遍历；保留尚未发送的源文件，不新增发送者 |
| 745：send 参数及异常 | 为 outbox 传稳定逻辑 ID。正常返回统一解析；分段开关打开时非零/截断返回保守判 unknown，防止全文盲重试 |
| 761：partial/unknown 分支 | 源文件保留，不递增旧全文失败次数，不搬到全文失败重试路径。unknown 提取无正文的段序号、ID 和报告协议；已确认报告的事实不重复唤醒 |
| 779：清理窗口 | 新结构中低频 retention 限制 2 秒；不改桥接清理、接收账本或附件语义 |
| 790：保活与报告顺序 | 新结构的保活已经在发送锁前执行，原位置不再重复执行；关闭时照旧调用。新增未知发送事实的主对话 wake；只读 send-reports 在原 void watchdog 前执行，报告确认不能解除发送暂停；看门狗窗口 5 秒 |
| 850：fetch 窗口 | 新结构为 fetch 及原后续确认调用设 42 秒窗口，同时服从 65 秒总上限；下面 defer-ack、fail-closed、状态文件开关、wake/ack 分支逐字不变 |

其他补丁的逐文件理由及前后哈希见 `CHANGES.json`。`hook-send-contract.patch` 仅在候选目录补充发送 ID/四态规则，接收确认协议 A–E 前缀逐字保留；`weather-send-contract.patch` 与轮询共用同一判断器；`watchman-keepalive.patch` 使第二线任务正文准确描述开关打开/关闭时的行为。以上定义和任务均未直接安装到线上。
