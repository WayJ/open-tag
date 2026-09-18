# Channel-Scoped @ Mention Candidates — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Composer 的 @ 自动补全候选由服务端按频道分域下发(公开频道保留拉人;private/dm 仅成员;thread 继承父频道 reach;始终排除自己),客户端不再用全工作区列表。

**Architecture:** 方案 A 单一真源 — `core.mentionCandidates(serverId, ch, requesterId)` 包装既有私有池 `mentionAutoJoinPool` + `channelMembers`;新 human 面 GET 端点下发(带 member 标志、avatarUrl 补齐、自身排除);store 级懒取缓存,`channel:members-updated` 整表失效;Composer 只做查询过滤,失败 fail-closed。

**Tech Stack:** TypeScript, node:test + tsx, drizzle, React context store。

**Spec:** `docs/superpowers/specs/2026-09-18-mention-candidates-design.md`(评审已批准,含全部代码事实核对)。

**Worktree:** `npm run wt:add -- mention-candidates` 后立即 `git reset --hard main`(wt:add 从 origin/main 分叉,本地 main 领先;教训:先提交再 reset,本计划所有提交在 worktree 分支上)。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/server/core.ts` | 修改 | 导出 `mentionCandidates(serverId, ch, requesterId)`(池保持私有) |
| `src/server/routes-api/channels.ts` | 修改 | `GET /api/channels/:id/mention-candidates`(鉴权 + avatarUrl 补齐 + kind 映射) |
| `web/src/lib/mentionCandidates.ts` | 新建 | `handleKey`、`MentionCandidate` 类型、`filterMentionCandidates` 纯函数 |
| `web/src/store.tsx` | 修改 | 候选缓存 Map + 懒取 + members-updated 整表失效 |
| `web/src/views/Composer.tsx` | 修改 | @ 触发懒取;候选来自缓存;删本地 handleKey(改 import) |
| `test/mentionCandidates.integration.ts` | 新建 | 服务端集成(接 `test/integrationDbGuard.ts`) |
| `test/mentionCandidatesFilter.unit.test.ts` | 新建 | 客户端过滤纯函数 + 接线契约(CI glob 覆盖 `test/*.unit.test.ts`) |

既有事实(实现时直接用):
- `core.ts:83` `Member { type:"user"|"agent"; id; name; displayName: string }`
- `core.ts:170-181` `mentionAutoJoinPool`(私有,thread 继承父频道;`channel`→workspace,其余→channelMembers)
- `channels.ts` 惯例:非 UUID 404(:250 附近)、`(id, serverId)` 取行、`canUserReadChannel` + 存在性隐藏 404、成员端点 avatarUrl 拼装(:261-265)
- `store.tsx:369` 已监听 `channel:members-updated`(现只 reload;加缓存清空)
- CI 单测命令:`JWT_SECRET=ci-test-secret DAEMON_BOOTSTRAP_KEY=ci-test-bootstrap-key npx tsx --test --test-force-exit test/*.unit.test.ts src/daemon/*.test.ts web/src/views/*.test.ts`
- 集成测试运行(隔离库):`DATABASE_URL=postgres://opentag:opentag@localhost:5433/opentag_mention_candidates JWT_SECRET=x DAEMON_BOOTSTRAP_KEY=y npx tsx test/mentionCandidates.integration.ts`

---

### Task 1: `core.mentionCandidates`(TDD)

**Files:**
- Modify: `src/server/core.ts`(在 `finalizeAgentActivityRun` 附近的导出区,或 `workspaceMembers` 定义后)
- Test: `test/mentionCandidates.integration.ts`(新建)

- [ ] **Step 1: 写失败测试**(结构照抄 `test/runningActivityRestore.integration.ts`:guard + setup/cleanup + check;直接调 core 函数,不起 HTTP)

setup 建:owner 用户(请求者 R + 人类 H2)、server、公开频道 `pub`、私密频道 `priv`、DM、thread(父 = pub);agent A1(成员)、agent A2(非成员)、system 展示 agent SYS(`creatorType:"system"`)、agent A3(不在任何频道)。成员:pub=[R,H2,A1];priv=[R,A1];dm=[R,A1];thread=[R,A1]。

```ts
import { assertIntegrationDbIsolated } from "./integrationDbGuard.ts";
assertIntegrationDbIsolated("test/mentionCandidates.integration.ts");
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { mentionCandidates } from "../src/server/core.ts";
// check()/failures 计数、setup/cleanup 照 runningActivityRestore.integration.ts 模式;行格式:
// channels.type: pub="channel" priv="private" dm="dm" thread="thread"(带 parentMessageId=pub 里一条消息)
```

断言([1] 段):
- `mentionCandidates(serverId, pubCh, R)`:含 A1(member:true)、A2/H2(member:false 或 true 按成员表)、**不含 R**;A3(工作区 agent)在列(拉人特性);SYS 不在列。
- `priv`/`dm`:仅 R 之外的成员(A1,H2 若成员),A2/A3 不在。
- thread(父=pub):池=工作区(A2 在列),member 标志按 thread 自身成员(A2=false)。

- [ ] **Step 2: RED** — `npx tsx test/…`(带 DATABASE_URL)→ `does not provide an export named 'mentionCandidates'`

- [ ] **Step 3: 最小实现**(core.ts;`Member` 排序:member 优先,再 name 归一化)

```ts
export interface MentionCandidateRow { id: string; name: string; displayName: string; type: "user" | "agent"; member: boolean }

/** Channel-scoped @-mention candidates for the human composer: the channel's members plus everyone
 *  its @-reach may pull in (mentionAutoJoinPool — thread inherits its parent), minus the requester.
 *  Single source of truth for GET /api/channels/:id/mention-candidates; the picker never guesses. */
export async function mentionCandidates(serverId: string, ch: typeof schema.channels.$inferSelect, requesterId: string): Promise<MentionCandidateRow[]> {
  const members = await channelMembers(ch.id);
  const pool = await mentionAutoJoinPool(serverId, ch);
  const memberKeys = new Set(members.map((m) => `${m.type}:${m.id}`));
  const key = (s: string) => s.normalize("NFC").toLowerCase();
  return pool
    .filter((m) => !(m.type === "user" && m.id === requesterId))
    .map((m) => ({ id: m.id, name: m.name, displayName: m.displayName, type: m.type, member: memberKeys.has(`${m.type}:${m.id}`) }))
    .sort((a, b) => Number(a.member !== true) - Number(b.member !== true) || key(a.name).localeCompare(key(b.name)));
}
```

- [ ] **Step 4: GREEN** — 集成 ALL PASS
- [ ] **Step 5: Commit** — `feat(server): core.mentionCandidates — channel-scoped @ pool (test-first)`

### Task 2: HTTP 路由(TDD)

**Files:**
- Modify: `src/server/routes-api/channels.ts`(成员路由旁;import `mentionCandidates` from `"../core.js"`)
- Test: `test/mentionCandidates.integration.ts` 追加 [2] 段(**进程内 `handleApi(req,res,url,method)` + mock req/res**,照 `test/channelAccessB2.integration.ts:75-90` 模式 — 该目录全部带 HTTP 断言的集成测试均此形态,gate 栈完整、无端口;不要 spawn 真实 server)

- [ ] **Step 1: 失败测试**([2] 段;headers = `{authorization: Bearer signUser(R), "x-server-id": serverId}`)
  - `GET /api/channels/:pub/mention-candidates` → 200,`candidates[]` 形状含 `kind:"agent"|"human"`(user→human 映射)、`avatarUrl` 字段(可 null)、A1 `member:true`、无 R;
  - `priv`/`dm` → 200 仅成员;thread → 200 含 A2;
  - **负例**:H2 访问他人 private(非成员)→ 404;跨租户 UUID → 404;`/api/channels/not-a-uuid/mention-candidates` → 404。
- [ ] **Step 2: RED** — 404(路由不存在)
- [ ] **Step 3: 实现**(channels.ts;**注意**:`cone` 裸 `/:id` 正则在前,本路径带后缀无冲突,放在成员路由附近)

```ts
// Channel-scoped @-mention candidates: the picker's single source of truth. Same read gate as the
// members route, existence-hiding 404s (never 403 — IDOR-B2), requester excluded, avatarUrl
// enriched from agents/users (the pool's Member carries names only).
const mcand = /^\/api\/channels\/([^/]+)\/mention-candidates$/.exec(p);
if (mcand && method === "GET") {
  if (!isUuid(mcand[1]!)) return (sendErr(res, 404, "channel not found"), true);
  const ch = (await db.select().from(schema.channels).where(and(eq(schema.channels.id, mcand[1]!), eq(schema.channels.serverId, serverId), isNull(schema.channels.deletedAt))))[0];
  if (!ch) return (sendErr(res, 404, "channel not found"), true);
  if (!(await canUserReadChannel(serverId, ch.id, userId))) return (sendErr(res, 404, "channel not found"), true);
  const rows = await mentionCandidates(serverId, ch, userId);
  const agentIds = rows.filter((r) => r.type === "agent").map((r) => r.id);
  const agAv = agentIds.length ? await db.select({ id: schema.agents.id, avatarUrl: schema.agents.avatarUrl }).from(schema.agents).where(inArray(schema.agents.id, agentIds)) : [];
  const userIds = rows.filter((r) => r.type === "user").map((r) => r.id);
  const usAv = userIds.length ? await db.select({ id: schema.users.id, avatarUrl: schema.users.avatarUrl }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const av = new Map<string, string | null>([...agAv, ...usAv].map((r) => [r.id, r.avatarUrl ?? null]));
  return (sendJson(res, 200, { candidates: rows.map((r) => ({ id: r.id, name: r.name, displayName: r.displayName, avatarUrl: av.get(r.id) ?? null, kind: r.type === "user" ? "human" : "agent", member: r.member })) }), true);
}
```
  - 确认文件头 import 已含 `isNull`(`inArray` 已有;缺则补)。
- [ ] **Step 4: GREEN** — 集成 ALL PASS(含负例)
- [ ] **Step 5: Commit** — `feat(server): GET /api/channels/:id/mention-candidates (auth-negative tested)`

### Task 3: 客户端过滤纯函数(TDD)

**Files:**
- Create: `web/src/lib/mentionCandidates.ts`
- Test: `test/mentionCandidatesFilter.unit.test.ts`(CI glob 覆盖)

- [ ] **Step 1: 失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { filterMentionCandidates, handleKey } from "../web/src/lib/mentionCandidates.ts";

test("filter matches by normalized handle, members first, capped at 8, empty query matches all", () => {
  const pool = [
    { id: "a2", name: "Zed", displayName: "Zed", kind: "agent", member: false },
    { id: "a1", name: "ada", displayName: "Ada", kind: "agent", member: true },
    { id: "h1", name: "Ada-Human", displayName: "AH", kind: "human", member: true },
  ];
  const out = filterMentionCandidates(pool as any, "");
  assert.deepEqual(out.map((c) => c.id), ["a1", "h1", "a2"], "member:true outranks non-member regardless of name order");
  assert.equal(filterMentionCandidates(pool as any, "ada").length, 2);
  assert.equal(filterMentionCandidates([{ id: "x", name: "ADA", kind: "agent", member: true } as any, "ad").length, 1, "NFC+casefold matching");
  assert.equal(filterMentionCandidates(Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, name: `m${i}`, kind: "agent", member: true })) as any, "").length, 8, "cap 8");
  assert.equal(handleKey("ＡＢ"), "ａｂ", "NFC+lowercase only — fullwidth is NOT folded (document the exact semantics we ship)");
});
```

- [ ] **Step 2: RED** — 模块不存在
- [ ] **Step 3: 实现**

```ts
// Channel-scoped @-mention candidates: client side of GET /api/channels/:id/mention-candidates.
// handleKey moves here from Composer (single normalization for pool + filter); the pool itself is
// server-authored — the picker never falls back to the whole workspace.
export const handleKey = (s: string) => s.normalize("NFC").toLowerCase();

export interface MentionCandidate { id: string; name: string; displayName?: string | null; avatarUrl?: string | null; kind: "agent" | "human"; member: boolean }

export function filterMentionCandidates(pool: MentionCandidate[], query: string, limit = 8): MentionCandidate[] {
  const q = handleKey(query ?? "");
  return pool
    .filter((c) => c.name && handleKey(c.name).includes(q))
    .sort((a, b) => Number(b.member) - Number(a.member) || handleKey(a.name).localeCompare(handleKey(b.name)))
    .slice(0, limit);
}
```

- [ ] **Step 4: GREEN**
- [ ] **Step 5: Commit** — `feat(web): filterMentionCandidates pure helper (test-first)`

### Task 4: store 缓存 + Composer 接线(TDD)

**Files:**
- Modify: `web/src/store.tsx`(state 区 + socket 监听 `channel:members-updated` 行旁)
- Modify: `web/src/views/Composer.tsx`(:10 删本地 handleKey 改 import;:120-132 候选来源替换)
- Test: `test/mentionCandidatesFilter.unit.test.ts` 追加契约测试(fs 断言,照 `test/agentReplyPreview.unit.test.ts` 契约段先例)

- [ ] **Step 1: 失败契约测试**

```ts
test("wiring contract: store lazy-caches per channel and wipes on members-updated; Composer fails closed", () => {
  const store = fs.readFileSync(new URL("../web/src/store.tsx", import.meta.url), "utf8");
  const composer = fs.readFileSync(new URL("../web/src/views/Composer.tsx", import.meta.url), "utf8");
  assert.match(store, /mentionCandidatesByChannel/, "per-channel cache in store (survives Composer remounts)");
  assert.match(store, /channel:members-updated[\s\S]{0,200}setMentionCandidatesByChannel\(\{\}\)/, "any membership change wipes the WHOLE cache (thread pools derive from parent members)");
  assert.match(composer, /filterMentionCandidates\(/, "candidates come from the cached server pool");
  assert.doesNotMatch(composer, /\.\.\.agents\.map\(\(a\) => \(\{ name: a\.name/, "no workspace-wide candidate map remains");
  assert.doesNotMatch(composer, /\.\.\.humans\.map\(/, "no whole-workspace humans map remains");
});
```

- [ ] **Step 2: RED** — 断言失败(尚无 wiring)

- [ ] **Step 3: 实现**

store.tsx(类型 import 自 `"./lib/mentionCandidates"` — web 惯例 extensionless;`.js` 后缀会挂 Vite 构建):
```ts
const [mentionCandidatesByChannel, setMentionCandidatesByChannel] = useState<Record<string, MentionCandidate[] | undefined>>({});
const mentionCandidatesInflight = useRef<Set<string>>(new Set());
const loadMentionCandidates = async (channelId: string) => {
  if (mentionCandidatesByChannel[channelId] || mentionCandidatesInflight.current.has(channelId)) return;
  mentionCandidatesInflight.current.add(channelId);
  try {
    const d = await api("GET", `/api/channels/${channelId}/mention-candidates`);
    setMentionCandidatesByChannel((prev) => ({ ...prev, [channelId]: d?.candidates ?? [] }));
  } catch { setMentionCandidatesByChannel((prev) => ({ ...prev, [channelId]: [] })); } // fail-closed: empty pool, never workspace-wide
  finally { mentionCandidatesInflight.current.delete(channelId); }
};
// socket 监听(既有 members-updated 行内追加,同一事件回调里):
sock.on("channel:members-updated", (p: any) => { reload(); setMentionCandidatesByChannel({}); if (p?.channelId) sockRef.current?.emit("join:channel", p.channelId); });
```
**必改两处**:
- `interface Store`(`store.tsx:22-59`)补 `mentionCandidatesByChannel: Record<string, MentionCandidate[] | undefined>;` 与 `loadMentionCandidates: (channelId: string) => Promise<void>;`(value 对象字面量 :399 同步加,否则 TS2353)。
- 工作区切换重置区(`store.tsx:292` 附近,server/slug 切换清 per-workspace state 处)加 `setMentionCandidatesByChannel({})` — 切走期间错过的 members-updated 无失效路径。

Composer.tsx:
```ts
const { api, visibleAgents: agents, machines, uploadOne, attachmentUrl, mentionCandidatesByChannel, loadMentionCandidates } = useStore(); // humans/me drop out: candidates are server-authored now (self excluded server-side)
const channelCandidates = mentionCandidatesByChannel[channelId];
useEffect(() => { if (atQuery !== null && channelCandidates === undefined) void loadMentionCandidates(channelId); }, [atQuery, channelId, channelCandidates, loadMentionCandidates]);
// cands(替换 :129-132 的全工作区 map;label 派生保持渲染行 c.label 不动):
const cands = (atQuery === null ? [] : filterMentionCandidates(channelCandidates ?? [], atQuery))
  .map((c) => ({ ...c, label: c.displayName || c.name }));
```
- 删 `const handleKey = …`(:10)改 `import { filterMentionCandidates, handleKey } from "../lib/mentionCandidates";`
- `reach`/`agents` 其余用途不动(仍用 store agents)。
- [ ] **Step 4: GREEN + typecheck** — 契约过 + `npm run typecheck`
- [ ] **Step 5: Commit** — `feat(web): channel-scoped @ picker with store cache + fail-closed`

### Task 5: 全量回归 + 真跑验证 + 文档 + dev log

- [ ] **Step 1: 全量** — CI 命令全绿(预期 660± tests,既有 2 skip)+ `npm run typecheck`
- [ ] **Step 2: 真跑** — worktree `npm run dev`(或 server+web),Playwright:公开频道 @ 弹成员+非成员且无自己;DM @ 仅对端 agent;@ 后成员变化(加人)再 @ 列表已更新
- [ ] **Step 3: 文档** — ARCHITECTURE.md channels 词条(端点 + core.mentionCandidates 一句)、FEATURES.md 勾选、docs/authorization.md 门禁清单加行(读门 + 存在性隐藏 404)
- [ ] **Step 4: dev log** — `.agents/notes/2026-09-18-mention-candidates.md`
- [ ] **Step 5: Commit** — `docs: mention-candidates sync (ARCHITECTURE/FEATURES/authorization) + dev log`

## 回归红线
- 既有 @ 发送/auto-join 服务端路径零改动;`test/mention.integration.ts`(若为集成)与全部 unit 不动且绿。
- Composer 其余功能(附件、As Task、reach 提示)行为不变。
