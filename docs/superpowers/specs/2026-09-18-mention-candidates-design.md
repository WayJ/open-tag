# Composer @ 候选按频道分域 — 设计

日期:2026-09-18 · 状态:已批准(方案 A,服务端单一真源;v2 已吸收 spec-review 9 条意见) · 分支:`feature/mention-candidates`

## 问题

Composer 的 @ 自动补全候选 = 全工作区 agents + humans(`web/src/views/Composer.tsx:120-132`),
与发消息时服务端的真实 @ 规则漂移:

1. **私密频道 / DM 里可以 @ 非成员** — 服务端 `mentionAutoJoinPool`(`src/server/core.ts:170-181`)
   对 `private`/`dm` 只认现有成员,外来 @ 是静默 no-op → UI 在提供永远无效的选项。
2. **可以 @ 自己** — 无意义提及,列表噪音。
3. 公开频道(`channel` 类型)@ 非成员 → 服务端 auto-join 拉入,**是特性,保留**。

## 方案(已选 A:服务端单一真源)

新增 `GET /api/channels/:id/mention-candidates`(human 面,gate-2/3)。
服务端用**既有**池逻辑算出该频道一条消息可 @ 的全集,客户端懒取后只做查询过滤。
不新增第二份规则副本。

### 服务端

**入口与鉴权**(对齐同族路由惯例,`docs/authorization.md` 四不变式):

- 非 UUID → 404 `channel not found`(参照 `routes-api/channels.ts:250`)。
- 按 `(id, serverId)` 取 channel 行 — 既是租户隔离预检(invariant-1/2),也是传给池的 `ch`。
- `canUserReadChannel(serverId, id, userId)` 读门禁(与 `GET /:id/members` 同门,无新增泄露);
  拒绝走**存在性隐藏 404**(`channel not found`),不是 403(IDOR-B2 惯例,
  `channels.ts:257/299`)。
- 请求者是 human(gate-2 已保证),不经 `allowedMentionAutoJoinPool`(agent 发送者专属规则)。

**核心函数**(池保持私有,不二次导出实现细节):

`core.ts` 新增**导出**的 `mentionCandidates(serverId, ch, requesterId)`:

- `members = channelMembers(ch.id)`;`pool = mentionAutoJoinPool(serverId, ch)`
  (thread 自动继承父频道 reach — 服务端既有语义)。
- 候选 = pool 中排除 `requesterId`;`member` = 是否 ∈ members。
- 路由再从 `agents`/`users` 表补齐 `avatarUrl`(池的 `Member` 不带,
  参照 `channels.ts:261-265` 成员端点的拼装方式),`type:"user"` → `kind:"human"` 映射。
- 排序:member 先、非成员后;同组内 handleKey 归一化排序。

**响应**:

```json
{ "candidates": [
  { "id": "uuid", "name": "dev-bot", "displayName": "Dev Bot",
    "avatarUrl": null, "kind": "agent" | "human", "member": true | false }
] }
```

- `member:false`(可 @ 拉入的非成员)出现于 `channel` **与 `thread`**(thread 池 = 父频道
  reach,非 thread 参与者可被 @ 拉入 thread 本身 — `core.ts:475-490` 发送路径同语义)。
- `private`/`dm` 全为 `member:true`。
- system 展示 agent(`creatorType:"system"`)永不出现(工作区成员池已排除)。

### 客户端(Composer)

- **缓存放 store**(Composer 每频道重挂载):`mentionCandidatesByChannel: Map<channelId, candidates>`,
  首次键入 `@`(`atQuery !== null`,含空 query — 裸 @ 也要弹前 8 条)时懒取一次。
- **失效**:store 已监听 `channel:members-updated`(`store.tsx:369`)— 该事件**清空整张
  候选缓存 Map**(下次键入 @ 重新懒取,代价可忽略)。整表清而非按频道清:thread 的池派生自
  **父频道**成员,事件只携带被变更频道自身的 channelId,按频道清会漏掉"父频道变动 → 子
  thread 缓存陈旧"(被移出父频道的成员仍被 thread 建议)——整表清彻底封死该复发路径。
- 候选 = 缓存列表,沿用现有过滤(`handleKey(name).includes(query)`、上限 8、↑↓ 导航、
  选中插入 — 全部不动)。
- **fail-closed**:获取失败 → 候选为空,不弹面板。绝不回落到全工作区列表
  (本次 bug 的来源)。
- `reach` 提示逻辑(离线/休眠占位)继续用 store 全量 agents,不动。

## 边界

| 场景 | 候选 |
|---|---|
| `channel`(公开) | 成员 + 工作区可拉入者,排除自己 |
| `private` / `dm` | 仅成员,排除自己 |
| `thread` | 按父频道 reach:公开父 → 工作区,私密父 → 父成员(均可拉入 thread) |

## 测试(TDD)

- 服务端集成(`test/mentionCandidates.integration.ts`,接 `integrationDbGuard`):
  - 公开频道:成员 + 非成员,`member` 标志正确,不含请求者;
  - `private`/`dm`:仅成员,不含请求者;
  - thread 继承父频道 reach(公开父 → 工作区候选);
  - system 展示 agent 不出现;
  - **鉴权负例**:普通成员访问他人 private/dm → 404;跨租户 channel UUID → 404;
    非 UUID → 404。
- 客户端单测(仓库既有普通单测形态,如 `web/src/lib/*.test.ts`):候选过滤
  (member 优先、query 匹配、上限 8);store 缓存懒取 + `channel:members-updated` 失效。

## 文档同步

- `ARCHITECTURE.md` routes-api/channels 词条(新端点 + `core.mentionCandidates`)。
- `FEATURES.md` 勾选。
- `docs/authorization.md` 路由门禁清单加一行(读门 + 存在性隐藏 404)。
- 无 schema 变更、无 daemon 变更(不发版)。

## 非目标

- 不改发送时服务端 @ 解析 / auto-join(本就是权威,本次只修 UI 候选)。
- 不改选择器视觉/交互(member 优先排序除外)。
- 不处理 agent 发送者 `inputSenderAllowed` 过滤(agent 面 /agent-api,human UI 不涉及)。
