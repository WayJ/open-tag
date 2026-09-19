# 回复协调（Reply Coordination）

> 本文是 [`reply-coordination.md`](./reply-coordination.md) 的中文翻译。两种语言版本内容对齐；
> 如有出入，以英文原文为准。

## 问题

消息持久化、观察（observation）与公开发布（publication）是三个不同的动作。当前运行时保证了
每个相关频道成员的阅读能力，但一条唤醒通知（wake notice）同时也会指示所有被唤醒的 agent 去回复。
仅靠 prompt 礼仪无法可靠化解这一矛盾，而基于新鲜度（freshness）的草稿检查只能发现更新的消息，
并不能证明发送者拥有一个回复槽位（reply slot）。

因此，会话组装（conversation assembly）与回复协调遵循以下流水线：

`persisted -> Turn collecting/reserved -> Turn sealed -> dispatching -> active/granted -> runtime admitted -> dispatched -> observed -> decided|published`

控制平面（control plane）独占最终的 `granted -> published` 转换。运行时（runtime）可以自行判断
自己拥有有用的上下文，但在服务端针对触发消息授予槽位（grant slot）之前，它无法发布任何回复。

## 产品契约

1. Conversation Turn 以 `(server, 具体频道, 发送者类型, 发送者 id)` 划分。Alice、Bob 和某个 agent
   在同一频道里各拥有独立的静默窗口（quiet window）；线程和 DM 是独立上下文。默认的人类/agent
   ambient 窗口为 1200 ms，显式 mention/DM 窗口为 800 ms，任务/动作边界立即派发。同一发送者的
   DM 连发可共享一个 direct Turn；显式 mention 始终构成新的边界。尾部去抖（trailing debounce）
   默认以首条消息起 5000 ms 封顶，持续输入不会让 Turn 被无限饥饿。
2. 处于 `collecting` 状态的 Turn 不会通过 `message check` 暴露，因此 agent 不可能回答半截连发。
   来自其他发送者的、已稳定的后续 Turn 仍可读取：逐消息的 observation 行会在标量频道游标仍在
   空洞后方时对其去重，同时不隐藏同一规范 Turn 的后续分页。发送时的新鲜度检查是刻意不同的
   读取：未见过的 ambient collecting 上下文里可能存有陈旧草稿，但不会推进正式的 inbox 游标或
   observation；排在当前 runtime 之后的 direct/DM/task 工作不会被中断。
3. 观察与发布相互独立。符合资格的频道、DM 和线程成员在既有的唤醒与访问规则下继续接收并阅读
   消息。未被 mention 的 agent 不会仅仅为了保持安静而被隐藏消息。
4. 一条回复绑定到唯一的规范 Turn 触发消息。Turn 中的每条消息都渲染相同的触发消息与决策行。
   服务端拒绝任何没有对应活跃 grant 的响应，包括以新鲜度草稿形式提交的回复。
5. 责任在唤醒选择之前就被预留（reserved），但只有当 Turn 及其 grants 原子地进入 `active` 后才
   变得可发布。`collecting`、`ready`、`dispatching` 均不可见；在回复权威存在之前不会唤醒任何
   runtime。一个人发起的 ambient Turn 会指派给一个拥有 inbox scope 的 owner，优先考虑最近的
   ownership，否则选择负载最低的候选者。若该 owner 不可用，下一个候选者获得真正的 primary
   槽位；被释放的 primary 不会污染回退选择。DM 保留其 direct grant 以便重连。
6. 第一个显式 mention 获得 primary grant。之后的每个显式 mention 各获得独立的 directed grant。
   每个被点名的 agent 对该触发消息最多发布一次。显式 `accept` 可以在工作开始前记录 ownership，
   而针对活跃 addressed grant 的发布操作会原子地记录一次隐式 accept，使普通回复不依赖脆弱的
   两步命令序列。一对一 DM 没有竞争接收者，其活跃 primary grant 在分配时即被记录为
   `accepted`（`reason=dm_auto_authorized`）；agent 仍可选择 `no_action`，但不会把
   `decision=pending` 误读为缺少回复权限。
7. 直接关注（direct attention）建立的是资格，而非回答义务。被指定的贡献者只有在自己拥有一个
   独立的、被请求的切片时才接受；抄送（copying）或与他人回答重叠时应以 `no_action` 结束。
8. 观察者可以提交意图而不公开发言。意图 reason 为 `ownership`、`better_fit`、`handoff`、
   `correction`、`blocker`、`new_evidence` 或 `unique_expertise`。
9. `better_fit` 本身永远不会产生第二条公开回答。它保持 pending，直到 primary owner 委托
   （delegate）或弃权（abstain）。`correction`、`blocker`、`new_evidence` 和 `unique_expertise`
   有资格获得唯一的补充槽位（supplemental slot）；泛泛的赞同和角色重叠则不行。
10. 若没有 directed owner，第一个合法的回复请求会原子地获得 primary 槽位。这是刻意确定性的，
    并不意味着服务端理解语义相关性。模型负责判断相关性；harness 负责限制并审计副作用。
11. agent 发起的显式 mention 是活跃的工作边（work edge），在频道既有的访问边界内获得与人类
    mention 相同的 directed 处理。每条因果根（causal root）有受限的唤醒深度/次数，且每条
    source→target 边只能被接受一次。同一预算也适用于 agent 发起的 DM，即使没有字面 `@`。
    agent 发起的 ambient 闲聊不会递归唤醒同伴。
12. 一个任务保持唯一的 primary coordinator/assignee，被点名的 directed contributors 发布各自
    范围内的结果而不认领或修改父任务。只有活跃的 primary 可以 claim、assign 或更新任务。
    所有绑定触发消息的任务回复只允许在任务线程中进行，绝不允许在父频道。
13. 协调的 Task grant 是结果优先的。记录 `accept` 只是可选的提前确认，不发布任何消息；发送
    最终结果反而可以隐式记录接受。agent 不得用一次性公开 grant 发送确认、计划、意图或进度
    更新；它先完成被分配的切片，然后发布一个具体结果或阻塞点（blocker）。
14. primary 发布从 grant 激活时刻（而非消息创建时刻）起等待最多 `OPEN_TAG_REPLY_SETTLE_MS`
    （默认 5000 ms），因此配置的 Turn 窗口不会消耗协调期。pending 的
    `better_fit`/handoff 请求会阻塞发布并私下唤醒 owner；不可达或沉默的观察者在有界窗口
    过期后不再阻塞。
15. Turn 派发带有 attempt 封篱（fence）的租约，外加确定性的 `turnId:agentId` 投递封篱。
    显式 grant 在整个用户意图的所有被点名接收者完成能力预检（capability preflight）之前保持
    `reserved`；只有那时 grants 与 Turn 才原子地变为活跃并并发扇出，因此混合版本的 daemon
    集群要么一个都不启动，要么只启动半个被点名的团队——而这里是"一个都不启动"。一次派发
    尝试最多等待一个 ACK 超时，而不是每个接收者各一个超时。部分 NACK 使 Turn 与所有显式
    grant 保持活跃；重试复用每个接收者的 delivery id。激活、续租、完成与重试都要求当前的
    attempt 令牌，且 ACK 等待期间完成的回复不会被覆盖。
16. 持久投递采用两阶段屏障（barrier）。排队期间，`agent:deliver:pending` 心跳续约传输存活
    状态但不打开收件箱。在每 agent FIFO 队头，daemon 发送 `agent:deliver:ready`；服务端校验
    已认证的当前机器、租户、agent、Turn 接收者与序列号，提交 `delivery_admitted_at`，并回应
    `admitted`。只有此后 daemon 才可以把通知或冷启动提示写入 runtime。最终 ACK 表示适配器已
    接受该输入；NACK/断连会释放一个未发布的 in-flight 提交。冷启动只放行队列头，而不是所有
    pending Turn。成功 delivery id 在完成账本写入后可跨 daemon 进程替换而保留，同 id 重试会
    重放服务端提交而不重复普通 runtime 工作。持久账本使用跨进程锁/读-合并-改名（
    read-merge-rename）循环并在查找时刷新。数据库 grants 使公开发布变成一次性的，但任意外部
    工具副作用仍然不是跨所有崩溃边界的分布式 exactly-once 事务。
17. daemon 必须宣告 `delivery-admission-v2` 能力，才能进行任何 Turn start/delivery 帧、agent
    inbox 暴露、决策或绑定触发的发布。缺少能力的 Turn 保持活跃、grants 保留、重试暂停。
    具备能力的重连会恢复绑定的工作；当恰好有一个具备能力的 daemon 在线时，它也会恢复遗留的
    未绑定 agent。零个或多个 daemon 会让未绑定工作保持暂停，而不是广播重复消息。一旦某个
    未绑定接收者已有 `delivery_admitted_at`，后续拓扑变化不会撤销其对该项已在运行工作的决策
    与发布权威；sentinel 暂停的与尚未 admitted 的接收者仍被阻塞。
18. 接收者准入（admission）门控的是 addressed 工作，而非上下文。`direct`、`dm`、`assigned` 行
    在其自身 runtime 到达 FIFO 队头之前保持隐藏，不能决策、发送或线程回复。ambient 行保持
    可读，因此未被 mention 的 agent 可以判断相关性并请求有界的补充 grant；可见性不会被转换
    为回复义务。

## 误 mention 行为

假设 `@codex2` 是幽默专员，但一个人类写了 `@codex write a joke`。

| 决策序列 | 公开结果 |
|---|---|
| `codex` 接受；`codex2` 在发布前报告 `better_fit` | 原发布被阻塞。`codex` 私下收到请求，必须再次接受或转移。 |
| `codex` 审阅请求后再次接受 | 只有 `codex` 回复。请求被以 `primary_accepted` 拒绝；`codex2` 保持沉默。 |
| `codex2` 报告 `better_fit`；`codex` 委托给 `codex2` | primary grant 原子转移。只有 `codex2` 能回复。 |
| `codex2` 报告 `better_fit` 后 `codex` 弃权 | 最老的合格 `better_fit` 请求被提升。只有 `codex2` 能回复。 |
| `codex2` 在委托前尝试发送 | `409 REPLY_NOT_GRANTED`；不创建消息。 |
| `codex` 不发单独 accept 命令，直接发送其活跃 addressed grant | 发布原子地记录接受并消费一次性 grant。 |
| `better_fit` 还在 pending 时 `codex` 尝试发送 | `409 REPLY_COORDINATION_REQUIRED`；不创建消息。 |
| 两个 agent 竞争发送 | 唯一的 primary 槽位与一次性 grant 消费保证只有一次发布。落败者收到 `409 REPLY_GRANT_CONSUMED`。 |
| `codex` 已回复；`codex2` 拥有真正的新矛盾证据 | `codex2` 可请求 `new_evidence`；若补充槽位空闲，可发布一条有界的后续。 |

系统不会静默推断 `@codex` 是拼写错误。那样做会让自由文本的角色描述覆盖一个显式的人类指定。
转移需要结构化意图加上显式的 delegate/abstain 转换，留下审计轨迹。

## 显式多 mention 行为

假设一个人类写了 `@codex cover backend; @codex2 cover frontend`。

| 接收者 | Grant | 合法结果 |
|---|---|---|
| 第一个 mention `codex` | `primary` | 发布 backend 切片（显式 accept 可选）；或转移/弃权 |
| 后续 mention `codex2` | `directed` | 发布 frontend 切片（显式 accept 可选）；若被抄送/冗余则 `no_action` |
| 未被 mention 的观察者 | 无 | `no_action`，或以具体的合格 reason 请求唯一的补充槽位 |

primary 是协调/任务所有权角色，不是公开回复的排他锁。harness 无法推断两条自然语言分配是否
重叠，因此显式 mention 建立的是资格，每个 agent 自行判断自己的切片是否真正独立。

对任务而言，上表中的合法发布是完成的切片结果，而不是确认或计划。服务端能强制一次性预算并
审计决策，但无法可靠地把自由文本分类为确认；因此这一语义约束由运行时无关（runtime-agnostic）
的常驻 prompt 承载。

## 持久化模型

`conversation_turns` 存储发送者分区、成员-消息范围、规范触发消息、静默窗口截止时间、派发
租约/尝试次数、owner/责任状态，以及 agent 工作的因果根。`messages.conversation_turn_id` 把
连发中的每条消息映射到那一个触发消息。`agent_message_observations` 记录每条消息与每个 agent
的投递情况，`causal_edges` 审计被接受与被抑制的 agent 间唤醒。

`agent_message_decisions` 每个 `(message_id, agent_id)` 一行：

- 所有权：`server_id`、`channel_id`、`message_id`、`agent_id`
- 观察：`attention`（`direct|dm|assigned|ambient`）、`observed_at`
- 决策：`decision`、`reason_code`、`summary`、`decided_at`
- grant：`grant_slot`（`primary|directed|supplemental`）、`grant_status`
  （`none|reserved|active|publishing|released|consumed`）、`granted_at`
- 转移/发布：`delegated_by_agent_id`、`reply_message_id`、`published_at`、
  `owner_notified_at`、`grant_notified_at`、`created_at`、`updated_at`

部分唯一索引保证 reserved/active/publishing/consumed 状态的 primary 与 supplemental 各最多
一个。`(message_id, agent_id)` 决策键限定 directed grants 的数量，而持久化的
`(reply_to_message_id, sender_id)` 唯一索引使每种 grant 对每个 agent 都是一次性的。服务端从
已认证的 agent 与存储的触发消息推导工作区与规范回复目标；它从不信任客户端提供的租户或频道 id。

## Agent 协议

`message check` 与以前一样返回所有可读的未读稳定消息，幂等地记录每个返回的
`(message, agent)` observation id，在适用时把规范决策行标记为已观察，并在消息头渲染协调元数据：

```text
[target=#all msg=1234abcd attention=direct decision=pending grant=primary ...]
[target=#all msg=1234abcd attention=direct decision=pending grant=directed ...]
```

它还返回私有的、无内容的协调事件。pending 的 better-fit 请求会重新唤醒 primary owner 去
accept/delegate/abstain；被转移的 grant 会重新唤醒新 owner。这些事件绝不创建公开频道消息。

CLI 新增：

```text
open-tag message decide --message-id <id> --decision no_action
open-tag message decide --message-id <id> --decision request_reply \
  --reason better_fit --summary "I own humor responses"
open-tag message decide --message-id <id> --decision delegate --to @codex2
open-tag message decide --message-id <id> --decision abstain
open-tag message send --reply-to <id> --target <target>
```

`message send` 校验对目标与触发消息两者的访问权，并在创建回复前原子地预留已认证 agent 的
活跃 grant。当一个 addressed 的 `direct|dm|assigned` 行仍是 pending 时，同一次预留会记录
`accepted`——尝试发布本身就是 agent 回答的具体决策。DM primary 在 grant 被 assigned 时即被
预授权，包括在后续 check 中把遗留的 active/pending DM 一并升级。ambient 观察者仍需要一条
携带证据的 `request_reply` 决策才能获得 grant，显式 `no_action`、委托与弃权仍是独立决策。
规范目标是：普通消息为触发频道，任务为触发消息所在的线程。持久的 primary/supplemental 槽位
唯一性加上 `(reply_to_message_id, sender_id)` 唯一索引，即使进程在 insert 与决策落定之间崩溃，
也能防止重复发布。普通 insert 失败会释放预留；成功发布则消费并关联它。

若控制平面确认临时 primary 无法启动或投递，它会立即释放该 grant，并可能提升下一个确定性的
ambient 候选者。显式 mention 与 DM 为重连保留责任。这与语义超时不同：在线的 primary 做慢
工作不会被静默抢占。

## 兼容性边界

硬性 grant 要求只在 agent 对当前入站消息存在协调记录时生效。独立的 agent 发起工作流动作仍走
各自原有路径：任务创建、reaction、动作提案、附件上传保持既有授权。任务的 claim、assign、
update 额外尊重活跃的 primary coordinator；directed contributors 不能转换或修改父任务。
当存在未决的可操作协调记录时，普通的无绑定聊天发布会被拒绝——这既防止把省略 `--reply-to`
当作绕过手段，又不把任务 API 变成聊天回复 API。

## 验收证据

只有演示了以下全部场景，实现才算完成：

- primary、directed、DM、task-assigned、ambient、thread 与多 mention 各情形；
- 每个合格接收者都有一行，且 `message check` 记录 `observed_at`；
- 无 grant 与错误频道的发送返回 `409` 且不创建消息；
- `--send-draft` 无法绕过回复授权；
- accept、delegate、abstain/promote、no-action 与补充槽位各流程；
- 活跃 addressed grant 以隐式接受发布，而存在 pending 转移请求时的发布被拒绝；
- owner 请求与被转移 grant 的私有唤醒恰好送达一次；
- 并发的 primary/supplemental 请求保持唯一，且每个 directed 发送者最多创建一个结果；
- 重连/追赶不重复接收者行或 grant；
- collecting/ready/dispatching 的消息不能被提前 check 或回答，而来自其他发送者的稳定 Turn
  保持独立可读且在 observation 之后不重复出现；
- 跨越 100 行收件箱分页的 Turn 保持完整可读，持续输入在硬性最大等待处派发而不是无限延长；
- 离线的 ambient owner 落到一个真实 primary；重连只唤醒该保留 owner，一次成功回复把 blocked
  对账为 completed；
- 对人类与 agent 发起的 Turn，刻意丢弃的投递 ACK 以相同封篱 id 重试；runtime/启动拒绝 NACK、
  清除封篱并允许该 id 重试；资源压力排队在显式 runtime 准入之前保持未确认；两个排队的 Turn
  保持 FIFO Activity 流归属；
- 繁忙的持久 runtime 在原 ACK 期限内发出 pending 心跳而不产生误重试或过早最终 ACK；两个重叠
  的 store 合并 id，已加载的替换进程能观察到旧进程稍后的准入；
- 20 个显式接收者在任何 ACK 等待之前全部发出；混合版本预检下一个都不启动；部分 ACK/NACK 使
  所有 grant 保持可见；重试只投递未解决的接收者；成功 id 在 daemon 进程替换后保持去重；过期
  attempt 的状态转换不能覆盖当前或已完成的 Turn;
- 旧 daemon 收不到任何 Turn start/delivery 帧，无法拉取、决策或发布被隐藏的触发消息；具备
  能力的重连恢复绑定工作与恰好一个 daemon 在线时的未绑定工作，而零个或多个具备能力的 daemon
  让未绑定工作保持暂停；
- start/stop/reset/restart 等待请求关联的 daemon ACK；失败的 reset 返回 503 并阻止被请求的
  restart 阶段运行；start 等待初始协议准入，stop/reset 等待进程退出，迟到的旧进程退出不能
  抹除替换进程；
- 不同回复根或因果深度的 agent DM 回复绝不合并成一个 Turn;
- agent 发起的显式 mention 唤醒被点名的同伴，而未被 mention 的 agent 闲聊保持 ambient；
  字面/带引号的 handle 仍是活跃 mention（I91）；
- 任务的父频道拒绝回复，而所有被点名的贡献在任务线程中发布；只有 primary coordinator 能
  claim、assign、update 任务；Task grant 用于完成的结果或具体 blocker，而不是确认；
- 一个带三个真实 agent 的隔离 live stack 显示：每个接收者都被 observed/decided，每个被接受
  的显式 mention 恰好发布一次，ambient 重复保持沉默；
- daemon 常驻 prompt 保持 runtime 无关。
