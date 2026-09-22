# 系统管理平面（System Admin Plane）实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 open-tag 上加系统管理平面：系统管理员（首用户）、开放注册开关、管理员邀请建号、企业管理后台（用户/workspace/审计/统计）。

**Architecture:** `users` 表加 `systemRole`/`disabledAt`；新表 `system_settings`（KV）、`system_invites`（邀请建号）、`audit_logs`（审计）；`/api/admin/*` 新 gate 1.5（登录 + system_admin）；禁用用户由 `resolveActiveUser` 在 REST gate 1 / WS / 公共附件三入口统一拦截；前端新 `/admin/*` 控制台 + `/invite/:token` 落地页。workspace 角色体系与 daemon 零改动。

**Tech Stack:** TypeScript / node:http + Drizzle / node:test + tsx（单测 CI 层、`.api.test.ts` 真服务器层）/ React + react-router + react-i18next。

**Spec:** `docs/superpowers/specs/2026-09-22-system-admin-plane-design.md`（本 worktree 内）。

**Worktree:** `d:/OpenSource/open-tag-system-admin`，branch `feature/system-admin`，自有 DB/端口/`.env`（`DATABASE_URL` 指向 `opentag_system-admin`）。所有命令默认在此目录跑。

**验证命令：**
- 单测（CI 层）：`npx tsx --test --test-force-exit test/systemAdminPolicy.unit.test.ts test/authGuards.web.test.ts`
- API 测试：`npx tsx --test --test-force-exit src/server/systemAdmin.api.test.ts`（需 worktree 的 postgres+redis 已起：`npm run infra`）
- 类型：`npm run typecheck`
- 浏览器：`npm run dev:e2e:up` → chrome-devtools MCP

---

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/db/schema.ts` | 改 | users 两列 + 三新表 |
| `src/server/systemAdminPolicy.ts` | 建 | 纯函数：注册门决策、email 掩码、邀请状态 |
| `src/server/systemSettings.ts` | 建 | 设置读写 + `SYSTEM_ADMIN_EMAILS` 启动提升 |
| `src/server/audit.ts` | 建 | `logAudit` 写审计行 |
| `src/server/auth.ts` | 改 | `resolveActiveUser` |
| `src/server/routes-api/index.ts` | 改 | gate 1 换 `resolveActiveUser`；挂 admin 路由 |
| `src/server/routes-api/auth.ts` | 改 | register 门、login 禁用、me.systemRole、config、邀请两端点 |
| `src/server/routes-api/admin.ts` | 建 | `/api/admin/*` 全部端点 |
| `src/server/routes-api/attachments.ts` | 改 | 公共附件路径换 `resolveActiveUser` |
| `src/server/socketio.ts` | 改 | WS 连接换 `resolveActiveUser` |
| `src/db/seed.ts` | 改 | `you` 标 `system_admin` |
| `test/systemAdminPolicy.unit.test.ts` | 建 | 单测 |
| `src/server/systemAdmin.api.test.ts` | 建 | 真服务器 API 测试（跨任务累加场景） |
| `web/src/adminGuard.ts` | 建 | `/admin` 路由守卫纯函数 + 单测 |
| `web/src/store.tsx` | 改 | `Me.systemRole` |
| `web/src/main.tsx` | 改 | `/admin`、`/invite/:token` 路由 |
| `web/src/views/Admin.tsx` | 建 | 控制台外壳 + 页签路由 |
| `web/src/views/admin/*.tsx` | 建 | Users/Invites/Workspaces/Audit/Stats/Settings 六页签 |
| `web/src/views/Auth.tsx` | 改 | 注册页读 config；新 `SystemInvitePage` |
| `web/src/Layout.tsx` | 改 | icon rail 系统管理入口（settings 图标旁） |
| `web/src/locales/zh.json` / `en.json` | 改 | admin.* key |
| 文档 | 改 | 见 Task 22 |

---

### Task 0: 基线

- [ ] **Step 1: 验证 worktree 基线绿**

```bash
cd d:/OpenSource/open-tag-system-admin
npm run typecheck
npx tsx --test --test-force-exit test/*.unit.test.ts src/daemon/*.test.ts web/src/views/*.test.ts
```
Expected: 全 PASS。若基线红，先停，报告。

---

### Task 1: Schema 变更 + db:push

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: users 表加两列**（`passwordHash` 行后）：

```ts
  systemRole: text("system_role"),                   // system_admin | null — deployment-wide admin (see docs/authorization.md); separate from server_members.role
  disabledAt: timestamp("disabled_at", withTimezoneOpts), // non-null = disabled: blocks login + all API/WS via resolveActiveUser; data kept (soft-disable)
```

注意：现有列写法是 `timestamp("created_at", { withTimezone: true })`——照抄内联 `{ withTimezone: true }`，别发明 `withTimezoneOpts`。

- [ ] **Step 2: 文件末尾（joinLinks 之后）加三张表**：

```ts
// ── System settings (KV, GET/PATCH /api/admin/settings) ──────
// Deployment-wide settings, sysadmin-only. Single-row-per-key; seeded with openRegistration=true.
export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),                     // "openRegistration"
  value: jsonb("value").notNull(),                   // {"enabled": true}
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── System invites (admin-created account-creation links) ──────
// Distinct from join_links: a join_link adds an EXISTING user to a workspace; a system_invite
// CREATES the account (register-closed path). Revocation = hard delete; history lives in audit_logs.
export const systemInvites = pgTable("system_invites", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),           // inv_-prefixed random string
  serverId: uuid("server_id").notNull().references(() => servers.id), // workspace the new user joins
  role: text("role").default("member").notNull(),    // server_members.role granted on accept
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }), // default 7d at creation
  acceptedAt: timestamp("accepted_at", { withTimezone: true }), // null = pending
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // one pending invite per email (partial unique; a re-invite after accept/revoke is allowed)
  pendingEmailUniq: uniqueIndex("system_invites_pending_email_uidx").on(t.email).where(sql`accepted_at is null`),
}));

// ── Audit log (GET /api/admin/audit-logs) ──────────
// System-plane events only; append-only. metadata: ip / old→new values etc.
export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  event: text("event").notNull(),                    // user.registered | user.login | user.disabled | user.enabled | user.system_role_changed | user.password_reset | invite.created | invite.accepted | invite.revoked | settings.open_registration_changed | server.deleted
  actorUserId: uuid("actor_user_id").references(() => users.id),
  targetUserId: uuid("target_user_id").references(() => users.id),
  targetServerId: uuid("target_server_id").references(() => servers.id),
  metadata: jsonb("metadata").default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ byEvent: index("audit_logs_event_idx").on(t.event), byCreated: index("audit_logs_created_idx").on(t.createdAt) }));
```

- [ ] **Step 3: push 到 worktree DB**

```bash
npm run db:push
```
Expected: `Changes applied`，无 destructive 提示。

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat(schema): system admin plane — users.systemRole/disabledAt, system_settings, system_invites, audit_logs"
```

---

### Task 2: systemAdminPolicy 纯函数（TDD）

**Files:**
- Create: `src/server/systemAdminPolicy.ts`
- Test: `test/systemAdminPolicy.unit.test.ts`

- [ ] **Step 1: 先写失败测试**

```ts
// test/systemAdminPolicy.unit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { inviteStatus, maskEmail, registrationDecision } from "../src/server/systemAdminPolicy.js";

test("registrationDecision: empty users table bootstraps the first sysadmin", () => {
  assert.equal(registrationDecision(0, true), "bootstrap");
  assert.equal(registrationDecision(0, false), "bootstrap"); // bootstrap wins even if the setting says closed
});
test("registrationDecision: existing users obey the toggle", () => {
  assert.equal(registrationDecision(3, true), "allow");
  assert.equal(registrationDecision(3, false), "reject");
});
test("maskEmail hides the local part and domain middle", () => {
  assert.equal(maskEmail("alice@example.com"), "a***e@e***.com");
  assert.equal(maskEmail("a@b.co"), "a@b.co"); // too-short local/domain fall through unchanged
});
test("inviteStatus: not_found / expired / used / valid", () => {
  assert.equal(inviteStatus(null), "not_found");
  assert.equal(inviteStatus({ expiresAt: new Date(Date.now() - 1000), acceptedAt: null }), "expired");
  assert.equal(inviteStatus({ expiresAt: null, acceptedAt: new Date() }), "used");
  assert.equal(inviteStatus({ expiresAt: new Date(Date.now() + 60_000), acceptedAt: null }), "valid");
});
```

- [ ] **Step 2: 跑，验证红**

Run: `npx tsx --test --test-force-exit test/systemAdminPolicy.unit.test.ts`
Expected: FAIL — cannot find module `../src/server/systemAdminPolicy.js`。

- [ ] **Step 3: 最小实现**

```ts
// src/server/systemAdminPolicy.ts
// Pure decision functions for the system-admin plane. No db imports — unit-testable in CI (no infra),
// wired into routes by auth.ts / admin.ts. See docs/superpowers/specs/2026-09-22-system-admin-plane-design.md.

export type RegistrationDecision = "bootstrap" | "allow" | "reject";

/** Registration gate: an empty users table (fresh unseeded deploy) bootstraps the FIRST registrant as
 *  system_admin regardless of the toggle; after that the openRegistration setting decides. */
export function registrationDecision(userCount: number, openRegistration: boolean): RegistrationDecision {
  if (userCount === 0) return "bootstrap";
  return openRegistration ? "allow" : "reject";
}

/** Mask an email for public invite-info: keep first+last local char and first domain char + TLD. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 2) return email; // too short to mask meaningfully
  const [local, domain] = [email.slice(0, at), email.slice(at + 1)];
  const dot = domain.lastIndexOf(".");
  if (dot < 1 || dot + 2 > domain.length) return email; // no sane TLP split — leave as-is
  const tld = domain.slice(dot);
  const domHead = domain.slice(0, dot);
  if (local.length < 3 || domHead.length < 2) return email;
  return `${local[0]}***${local[local.length - 1]}@${domHead[0]}***${tld}`;
}

export type InviteStatus = "valid" | "not_found" | "expired" | "used";
export function inviteStatus(
  invite: { expiresAt: Date | string | null; acceptedAt: Date | string | null } | null | undefined,
  now = Date.now(),
): InviteStatus {
  if (!invite) return "not_found";
  if (invite.acceptedAt != null) return "used";
  if (invite.expiresAt != null && new Date(invite.expiresAt as any).getTime() < now) return "expired";
  return "valid";
}
```

- [ ] **Step 4: 跑，验证绿** — 同 Step 2 命令，Expected: 4 tests PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/systemAdminPolicy.ts test/systemAdminPolicy.unit.test.ts
git commit -m "feat(policy): registration gate / email mask / invite status pure functions (TDD)"
```

---

### Task 3: audit helper + systemSettings 读写 + env 提升

**Files:**
- Create: `src/server/audit.ts`、`src/server/systemSettings.ts`
- Modify: `src/db/seed.ts`

无独立测试（被 Task 4+ 的 API 测试覆盖写入行为）。

- [ ] **Step 1: `src/server/audit.ts`**

```ts
// Append-only system-plane audit trail. Fire-and-forget style call sites; never throws into a route
// (a failed audit write must not break the audited action — but it DOES await, so failures surface in tests).
import { db, schema } from "../db/index.js";

export type AuditEvent =
  | "user.registered" | "user.login" | "user.disabled" | "user.enabled" | "user.system_role_changed"
  | "user.password_reset" | "invite.created" | "invite.accepted" | "invite.revoked"
  | "settings.open_registration_changed" | "server.deleted";

export async function logAudit(event: AuditEvent, opts: {
  actorUserId?: string | null; targetUserId?: string | null; targetServerId?: string | null;
  metadata?: Record<string, unknown>;
} = {}): Promise<void> {
  await db.insert(schema.auditLogs).values({ event, ...opts });
}
```

- [ ] **Step 2: `src/server/systemSettings.ts`**

```ts
// System settings KV + first-admin bootstrap helpers. Default openRegistration=true (GitLab parity).
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export async function openRegistrationEnabled(): Promise<boolean> {
  const row = (await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, "openRegistration")))[0];
  return !row || (row.value as { enabled?: boolean })?.enabled !== false; // absent row = default true
}

export async function setOpenRegistration(enabled: boolean, byUserId: string): Promise<void> {
  await db.insert(schema.systemSettings)
    .values({ key: "openRegistration", value: { enabled }, updatedByUserId: byUserId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: { enabled }, updatedByUserId: byUserId, updatedAt: new Date() } });
}

/** Legacy-deploy escape hatch: SYSTEM_ADMIN_EMAILS=a@b.c,d@e.f promotes those existing users to
 *  system_admin at boot. Idempotent, promote-only (never demotes), missing emails are skipped silently. */
export async function promoteSystemAdminsFromEnv(): Promise<void> {
  const raw = process.env.SYSTEM_ADMIN_EMAILS ?? "";
  const emails = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!emails.length) return;
  for (const email of emails) {
    const u = (await db.select().from(schema.users).where(eq(schema.users.email, email)))[0];
    if (u && u.systemRole !== "system_admin") {
      await db.update(schema.users).set({ systemRole: "system_admin" }).where(eq(schema.users.id, u.id));
      console.log(`[system-admin] promoted ${email} to system_admin`);
    }
  }
}
```

- [ ] **Step 3: seed.ts 标记首管理员**（`you` 的 insert 加字段）：

```ts
  const [you] = await db.insert(users).values({
    name: "you", displayName: "You", email: "you@open-tag.local",
    systemRole: "system_admin", // seeded deploy: the workspace owner is the deployment admin (spec §8 path a)
  }).returning();
```

（seed 幂等分支不动——已 seed 的库靠 `SYSTEM_ADMIN_EMAILS`。）

- [ ] **Step 4: 服务器启动时调用提升** — 找 `src/server/index.ts` 里 db 初始化后的启动段（搜 `listen(`），在 listen 前加：

```ts
import { promoteSystemAdminsFromEnv } from "./systemSettings.js";
// ...
await promoteSystemAdminsFromEnv();
```

- [ ] **Step 4b: worktree `.env` 加提升行**（worktree DB 已被 wt:add seed 过，幂等 seed 不会回填 `you` 的 systemRole——env 提升是这里的首管理员来源）：

```bash
echo "SYSTEM_ADMIN_EMAILS=you@open-tag.local" >> d:/OpenSource/open-tag-system-admin/.env
```

（dev:e2e 栈与 API 测试 spawn 的服务器都读这份 .env。）

- [ ] **Step 5: typecheck** — `npm run typecheck`，Expected: 0 error。

- [ ] **Step 6: Commit**

```bash
git add src/server/audit.ts src/server/systemSettings.ts src/db/seed.ts src/server/index.ts
git commit -m "feat(system): audit log helper, settings KV, SYSTEM_ADMIN_EMAILS boot promotion, seed marks owner sysadmin"
```

---

### Task 4: resolveActiveUser + 禁用执行点 + me.systemRole（TDD）

**Files:**
- Modify: `src/server/auth.ts`、`src/server/routes-api/index.ts`、`src/server/routes-api/auth.ts`（me）、`src/server/routes-api/attachments.ts`、`src/server/socketio.ts`
- Test: `src/server/systemAdmin.api.test.ts`（新建，本任务起累加场景）

- [ ] **Step 1: 建测试文件，先写本任务的红测**

```ts
// src/server/systemAdmin.api.test.ts
// Real-server API tests for the system-admin plane (pattern: agentLifecycle.api.test.ts).
// Runs against the WORKTREE db (opentag_system-admin) — creates its own users via direct db inserts.
import "../../env.js" — 注意：文件在 src/server/ 下，即 `import "../env.js";`
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { eq } from "drizzle-orm";
import { db, schema, sql } from "../db/index.js";
import { hashPassword, signUser } from "./auth.js";

let serverProcess: ChildProcess | null = null;
let base = "";
const suffix = randomUUID().slice(0, 8);

async function freePort(): Promise<number> { /* verbatim from agentLifecycle.api.test.ts */ }
async function startServer(): Promise<string> { /* verbatim; return base */ }

function api(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(base + pathname, init);
}
async function insertUser(opts: { email: string; name: string; password: string; systemRole?: string | null; disabledAt?: Date | null }) {
  const [u] = await db.insert(schema.users).values({
    name: opts.name, displayName: opts.name, email: opts.email,
    passwordHash: hashPassword(opts.password),
    systemRole: opts.systemRole ?? null, disabledAt: opts.disabledAt ?? null,
  }).returning();
  return u!;
}

before(async () => { base = await startServer(); });
after(async () => { if (serverProcess?.pid) serverProcess.kill("SIGTERM"); await sql.end(); });

test("disabled user: login 403, existing JWT rejected at gate 1, me exposes systemRole", async () => {
  const admin = await insertUser({ email: `sa1-${suffix}@t.local`, name: `sa1${suffix}`, password: "password-1", systemRole: "system_admin" });
  const victim = await insertUser({ email: `vi1-${suffix}@t.local`, name: `vi1${suffix}`, password: "password-1" });

  // me exposes systemRole (admin)
  const meRes = await api("/api/auth/me", { headers: { authorization: `Bearer ${signUser(admin.id)}` } });
  assert.equal(meRes.status, 200);
  assert.equal((await meRes.json()).systemRole, "system_admin");

  // active user passes gate 1 (any authed route; /api/auth/me again is enough)
  const okRes = await api("/api/auth/me", { headers: { authorization: `Bearer ${signUser(victim.id)}` } });
  assert.equal(okRes.status, 200);

  // disable → old JWT rejected (401 at gate 1, indistinguishable from invalid token)
  await db.update(schema.users).set({ disabledAt: new Date() }).where(eq(schema.users.id, victim.id));
  const rej = await api("/api/auth/me", { headers: { authorization: `Bearer ${signUser(victim.id)}` } });
  assert.equal(rej.status, 401);

  // login: correct password → 403 account_disabled (code auth_account_disabled)
  const loginRes = await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: victim.email, password: "password-1" }) });
  assert.equal(loginRes.status, 403);
  assert.equal((await loginRes.json()).code, "auth_account_disabled");
});
```

注意：startServer/freePort 直接抄 [agentLifecycle.api.test.ts](../../../src/server/agentLifecycle.api.test.ts)（同目录）。`serverProcess` 赋值在 startServer 内。

- [ ] **Step 2: 跑，验证红**

Run: `npx tsx --test --test-force-exit src/server/systemAdmin.api.test.ts`
Expected: FAIL（403/401 断言失败——现在禁用用户仍可通过；me 无 systemRole）。

- [ ] **Step 3: 实现**

`src/server/auth.ts` 末尾加：

```ts
/** Gate-1 user resolution: JWT verify → live user row → reject soft-disabled accounts.
 *  Single source of truth for "is this token's user currently allowed in" — used by REST gate 1,
 *  the socket.io handshake, and the public-attachment token path, so a disabled user loses ALL
 *  access with the flip of disabledAt, even for already-issued 30d JWTs. Returns the row (id +
 *  systemRole) so the admin gate reuses it without a second query. */
export async function resolveActiveUser(token: string | null) {
  const userId = verifyUser(token);
  if (!userId) return null;
  const u = (await db.select({ id: schema.users.id, systemRole: schema.users.systemRole, disabledAt: schema.users.disabledAt })
    .from(schema.users).where(eq(schema.users.id, userId)))[0];
  if (!u || u.disabledAt) return null;
  return u;
}
```

`src/server/routes-api/index.ts` gate 1 改（保留原注释精神）：

```ts
  // ---- gate 1: require a logged-in, non-disabled user ----
  const activeUser = await resolveActiveUser(bearer(req));
  if (!activeUser) return (sendErr(res, 401, "unauthorized"), true);
  const userId = activeUser.id; // gate 2 below reads this
  const user: UserCtx = { ...base, userId };
  if (await handleAuthedAuth(user)) return true;
  if (await handleAdminRoutes(user, activeUser.systemRole)) return true; // gate 1.5: system-admin namespace, no x-server-id
  if (await handleServersUserScope(user)) return true;
```

（`handleAdminRoutes` Task 7 建文件；本任务先建空壳返回 false，避免断链——直接现在建 `src/server/routes-api/admin.ts`：）

```ts
// /api/admin/* — the system-admin plane (gate 1.5: any logged-in user reaches here; every route
// inside requires systemRole === "system_admin"). Dispatched between gate 1 and gate 2 in index.ts.
import type { UserCtx } from "./ctx.js";
import { sendErr } from "../util.js";

export async function handleAdminRoutes(ctx: UserCtx, systemRole: string | null): Promise<boolean> {
  if (!ctx.p.startsWith("/api/admin/")) return false;
  if (systemRole !== "system_admin") return (sendErr(ctx.res, 403, "system admin required"), true);
  return false; // routes land in later tasks
}
```

`src/server/socketio.ts:36` 一带：`const uid = verifyUser(...)` 换 `const u = await resolveActiveUser(auth.token ?? null); const uid = u?.id ?? null;`（确认该函数是 async 上下文）。

`src/server/routes-api/attachments.ts:125`：`const uid = verifyUser(url.searchParams.get("token") ?? bearer(req))` 换 `const uid = (await resolveActiveUser(url.searchParams.get("token") ?? bearer(req)))?.id ?? null;`

`src/server/routes-api/auth.ts`：
- login 分支，密码验证通过后、返回 200 前加：

```ts
    if (u.disabledAt) return (sendErr(res, 403, "account disabled", { code: "auth_account_disabled" }), true);
```

- `/api/auth/me` GET 返回体加 `systemRole: u.systemRole ?? null`。

- [ ] **Step 4: 跑，验证绿** — 同 Step 2。Expected: PASS。
- [ ] **Step 5: `npm run typecheck`** + 单测全量（CI 层命令），Expected: 绿。
- [ ] **Step 6: Commit**

```bash
git add src/server/auth.ts src/server/routes-api/index.ts src/server/routes-api/admin.ts src/server/routes-api/auth.ts src/server/routes-api/attachments.ts src/server/socketio.ts src/server/systemAdmin.api.test.ts
git commit -m "feat(auth): resolveActiveUser blocks disabled users at REST/WS/attachment gates; login 403; me.systemRole (TDD)"
```

---

### Task 5: 注册门 + /api/auth/config + 审计（TDD）

**Files:**
- Modify: `src/server/routes-api/auth.ts`
- Test: `src/server/systemAdmin.api.test.ts`（累加）

- [ ] **Step 1: 红测（追加到测试文件）**

```ts
test("registration gate: obeys openRegistration toggle; admin can flip it; config reflects it", async () => {
  const admin = await insertUser({ email: `sa2-${suffix}@t.local`, name: `sa2${suffix}`, password: "password-1", systemRole: "system_admin" });
  const atok = signUser(admin.id);
  const hdr = { authorization: `Bearer ${atok}`, "content-type": "application/json" };

  // default open → register succeeds
  assert.equal((await api("/api/auth/config")).status, 200);
  assert.equal((await (await api("/api/auth/config")).json()).openRegistration, true);
  const reg1 = await api("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `rg1${suffix}`, email: `rg1-${suffix}@t.local`, password: "password-1" }) });
  assert.equal(reg1.status, 200);

  // close it via admin settings → register 403 with code, config reflects false
  const patch = await api("/api/admin/settings", { method: "PATCH", headers: hdr, body: JSON.stringify({ openRegistration: false }) });
  assert.equal(patch.status, 200);
  assert.equal((await (await api("/api/auth/config")).json()).openRegistration, false);
  const reg2 = await api("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `rg2${suffix}`, email: `rg2-${suffix}@t.local`, password: "password-1" }) });
  assert.equal(reg2.status, 403);
  assert.equal((await reg2.json()).code, "auth_registration_closed");

  // restore for later tasks/tests
  await api("/api/admin/settings", { method: "PATCH", headers: hdr, body: JSON.stringify({ openRegistration: true }) });
});
```

（依赖 Task 7 的 settings 端点——**本任务与 Task 7 交替**：先在本任务把 settings 端点做出来（见 Step 3 的 admin.ts 增量），测试一次红绿。）

- [ ] **Step 2: 跑红** — 同上命令，Expected: FAIL（config 404 / register 不受开关影响）。

- [ ] **Step 3: 实现**

`routes-api/auth.ts` register 分支开头（rate limit 之后）插入门逻辑：

```ts
    const [{ cnt }] = await db.select({ cnt: count() }).from(schema.users);
    const decision = registrationDecision(Number(cnt), await openRegistrationEnabled());
    if (decision === "reject") return (sendErr(res, 403, "registration is closed — ask a system admin for an invite", { code: "auth_registration_closed" }), true);
```

（`count` 从 drizzle-orm 导入；`registrationDecision`、`openRegistrationEnabled` 导入。）注册成功 return 前：`decision === "bootstrap"` 时给 insert values 加 `systemRole: "system_admin"`，并在两处成功路径后 `await logAudit("user.registered", { targetUserId: u!.id, metadata: { bootstrap: decision === "bootstrap", ip: clientIp(req) } });`。

新公共端点（gate 0，`handlePublicAuth` 内）：

```ts
  // Public registration-state probe: the /register page uses it to disable the form upfront.
  // The server-side 403 on POST /api/auth/register remains the enforcement; this is UX only.
  if (p === "/api/auth/config" && method === "GET") {
    return (sendJson(res, 200, { openRegistration: await openRegistrationEnabled() }), true);
  }
```

login 成功 return 前：`await logAudit("user.login", { targetUserId: u.id, metadata: { ip: clientIp(req) } });`

`routes-api/admin.ts`（gate 守卫之后）：

```ts
  if (ctx.p === "/api/admin/settings" && ctx.method === "GET") {
    return (sendJson(ctx.res, 200, { openRegistration: await openRegistrationEnabled() }), true);
  }
  if (ctx.p === "/api/admin/settings" && ctx.method === "PATCH") {
    const b = await readJson(ctx.req);
    if (typeof b.openRegistration !== "boolean") return (sendErr(ctx.res, 400, "openRegistration boolean required"), true);
    const before = await openRegistrationEnabled();
    await setOpenRegistration(b.openRegistration, ctx.userId);
    await logAudit("settings.open_registration_changed", { actorUserId: ctx.userId, metadata: { from: before, to: b.openRegistration } });
    return (sendJson(ctx.res, 200, { openRegistration: b.openRegistration }), true);
  }
```

- [ ] **Step 4: 跑绿 + typecheck**
- [ ] **Step 5: Commit**

```bash
git add src/server/routes-api/auth.ts src/server/routes-api/admin.ts src/server/systemAdmin.api.test.ts
git commit -m "feat(auth): registration gate + /api/auth/config + admin settings toggle + audit (TDD)"
```

---

### Task 6: 用户管理端点（TDD）

**Files:**
- Modify: `src/server/routes-api/admin.ts`
- Test: `src/server/systemAdmin.api.test.ts`（累加）

- [ ] **Step 1: 红测**

```ts
test("admin users: list, disable/enable, grant/revoke sysadmin, self-guard, reset password", async () => {
  const admin = await insertUser({ email: `sa3-${suffix}@t.local`, name: `sa3${suffix}`, password: "password-1", systemRole: "system_admin" });
  const hdr = { authorization: `Bearer ${signUser(admin.id)}`, "content-type": "application/json" };
  const pleb = await insertUser({ email: `pl3-${suffix}@t.local`, name: `pl3${suffix}`, password: "password-1" });

  // non-admin gets 403
  const forb = await api("/api/admin/users", { headers: { authorization: `Bearer ${signUser(pleb.id)}` } });
  assert.equal(forb.status, 403);

  // list contains pleb with systemRole null + workspaceCount 0
  const list = await (await api("/api/admin/users", { headers: hdr })).json();
  const row = list.users.find((x: any) => x.id === pleb.id);
  assert.ok(row && row.systemRole === null && row.workspaceCount === 0 && row.disabledAt === null);

  // disable pleb → login 403; enable → login 200
  await api(`/api/admin/users/${pleb.id}`, { method: "PATCH", headers: hdr, body: JSON.stringify({ disabled: true }) });
  assert.equal((await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: pleb.email, password: "password-1" }) })).status, 403);
  await api(`/api/admin/users/${pleb.id}`, { method: "PATCH", headers: hdr, body: JSON.stringify({ disabled: false }) });
  assert.equal((await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: pleb.email, password: "password-1" }) })).status, 200);

  // self-guard: cannot disable or demote self
  assert.equal((await api(`/api/admin/users/${admin.id}`, { method: "PATCH", headers: hdr, body: JSON.stringify({ disabled: true }) })).status, 400);
  assert.equal((await api(`/api/admin/users/${admin.id}`, { method: "PATCH", headers: hdr, body: JSON.stringify({ systemRole: null }) })).status, 400);

  // grant + revoke sysadmin
  await api(`/api/admin/users/${pleb.id}`, { method: "PATCH", headers: hdr, body: JSON.stringify({ systemRole: "system_admin" }) });
  assert.equal((await (await api("/api/auth/me", { headers: { authorization: `Bearer ${signUser(pleb.id)}` } })).json()).systemRole, "system_admin");
  await api(`/api/admin/users/${pleb.id}`, { method: "PATCH", headers: hdr, body: JSON.stringify({ systemRole: null }) });

  // reset password: old fails, temp works, response returns it once
  const rst = await api(`/api/admin/users/${pleb.id}/reset-password`, { method: "POST", headers: hdr });
  assert.equal(rst.status, 200);
  const temp = (await rst.json()).tempPassword as string;
  assert.ok(typeof temp === "string" && temp.length >= 10);
  assert.equal((await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: pleb.email, password: "password-1" }) })).status, 401);
  assert.equal((await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: pleb.email, password: temp }) })).status, 200);
});
```

- [ ] **Step 2: 跑红** — Expected: FAIL（admin/users 404 → 走到 gate 2 400）。

- [ ] **Step 3: 实现（admin.ts 追加）**

```ts
  // users list
  if (ctx.p === "/api/admin/users" && ctx.method === "GET") {
    const q = (ctx.url.searchParams.get("q") ?? "").toLowerCase();
    const rows = await db.select().from(schema.users);
    const mems = await db.select({ userId: schema.serverMembers.userId }).from(schema.serverMembers);
    const counts = new Map<string, number>();
    for (const m of mems) counts.set(m.userId, (counts.get(m.userId) ?? 0) + 1);
    const users = rows
      .filter((u) => !q || u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q))
      .sort((a, b) => a.createdAt < b.createdAt ? -1 : 1)
      .map((u) => ({ id: u.id, name: u.name, displayName: u.displayName, email: u.email, systemRole: u.systemRole ?? null, disabledAt: u.disabledAt, createdAt: u.createdAt, workspaceCount: counts.get(u.id) ?? 0 }));
    return (sendJson(ctx.res, 200, { users }), true);
  }
  // patch user (disable / systemRole)
  {
    const m = /^\/api\/admin\/users\/([^/]+)$/.exec(ctx.p);
    if (m && ctx.method === "PATCH") {
      if (!isUuid(m[1]!)) return (sendErr(ctx.res, 404, "not found"), true);
      const target = (await db.select().from(schema.users).where(eq(schema.users.id, m[1]!)))[0];
      if (!target) return (sendErr(ctx.res, 404, "user not found"), true);
      const b = await readJson(ctx.req);
      const patch: Record<string, unknown> = {};
      if (b.disabled !== undefined) {
        if (typeof b.disabled !== "boolean") return (sendErr(ctx.res, 400, "disabled must be boolean"), true);
        if (target.id === ctx.userId) return (sendErr(ctx.res, 400, "cannot disable yourself"), true);
        patch.disabledAt = b.disabled ? new Date() : null;
      }
      if (b.systemRole !== undefined) {
        if (b.systemRole !== null && b.systemRole !== "system_admin") return (sendErr(ctx.res, 400, "systemRole must be system_admin or null"), true);
        if (target.id === ctx.userId && b.systemRole === null) return (sendErr(ctx.res, 400, "cannot demote yourself"), true);
        patch.systemRole = b.systemRole;
      }
      if (!Object.keys(patch).length) return (sendErr(ctx.res, 400, "nothing to update"), true);
      await db.update(schema.users).set(patch).where(eq(schema.users.id, target.id));
      if ("disabledAt" in patch) await logAudit(patch.disabledAt ? "user.disabled" : "user.enabled", { actorUserId: ctx.userId, targetUserId: target.id });
      if ("systemRole" in patch) await logAudit("user.system_role_changed", { actorUserId: ctx.userId, targetUserId: target.id, metadata: { from: target.systemRole ?? null, to: patch.systemRole as string | null } });
      return (sendJson(ctx.res, 200, { ok: true }), true);
    }
    // reset password
    const rm = /^\/api\/admin\/users\/([^/]+)\/reset-password$/.exec(ctx.p);
    if (rm && ctx.method === "POST") {
      if (!isUuid(rm[1]!)) return (sendErr(ctx.res, 404, "not found"), true);
      const target = (await db.select().from(schema.users).where(eq(schema.users.id, rm[1]!)))[0];
      if (!target) return (sendErr(ctx.res, 404, "user not found"), true);
      const temp = crypto.randomBytes(9).toString("base64url"); // 12 chars, url-safe
      await db.update(schema.users).set({ passwordHash: hashPassword(temp) }).where(eq(schema.users.id, target.id));
      await logAudit("user.password_reset", { actorUserId: ctx.userId, targetUserId: target.id });
      return (sendJson(ctx.res, 200, { tempPassword: temp }), true);
    }
  }
```

（文件头补 imports：`crypto`、`count` 不需要此处、`eq`、`isUuid`、`readJson`、`sendJson`、`sendErr`、`db`、`schema`、`logAudit`、`hashPassword`。）

- [ ] **Step 4: 跑绿 + typecheck**
- [ ] **Step 5: Commit**

```bash
git add src/server/routes-api/admin.ts src/server/systemAdmin.api.test.ts
git commit -m "feat(admin): user list / disable / role / reset-password endpoints (TDD)"
```

---

### Task 7: 系统邀请端点（TDD）

**Files:**
- Modify: `src/server/routes-api/auth.ts`（公共两端点）、`src/server/routes-api/admin.ts`（CRUD）
- Test: `src/server/systemAdmin.api.test.ts`（累加）

- [ ] **Step 1: 红测**

```ts
test("system invites: create → info → accept creates account & joins workspace; dup pending 409; revoked 410; expired 410", async () => {
  const admin = await insertUser({ email: `sa4-${suffix}@t.local`, name: `sa4${suffix}`, password: "password-1", systemRole: "system_admin" });
  const hdr = { authorization: `Bearer ${signUser(admin.id)}`, "content-type": "application/json" };
  const srv = (await db.select().from(schema.servers).where(eq(schema.servers.slug, "open-tag")))[0]!;

  const inv = await (await api("/api/admin/invites", { method: "POST", headers: hdr, body: JSON.stringify({ email: `in4-${suffix}@t.local`, serverId: srv.id, role: "member" }) })).json();
  assert.ok(inv.invite?.token && inv.url?.includes("/invite/"));

  // dup pending → 409
  assert.equal((await api("/api/admin/invites", { method: "POST", headers: hdr, body: JSON.stringify({ email: `in4-${suffix}@t.local`, serverId: srv.id }) })).status, 409);

  // public info masks email
  const info = await (await api(`/api/auth/system-invite-info?token=${inv.invite.token}`)).json();
  assert.equal(info.valid, true);
  assert.ok(!info.email.includes(`in4-${suffix}`)); // masked
  assert.equal(info.serverSlug, "open-tag");

  // accept → account created, member of server + #all, JWT works
  const acc = await api("/api/auth/accept-system-invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: inv.invite.token, name: `in4${suffix}`, password: "password-1" }) });
  assert.equal(acc.status, 200);
  const { token: newTok } = await acc.json();
  const me = await (await api("/api/auth/me", { headers: { authorization: `Bearer ${newTok}` } })).json();
  assert.equal(me.email, `in4-${suffix}@t.local`);
  const newMem = (await db.select().from(schema.serverMembers).where(eq(schema.serverMembers.userId, me.id)))[0];
  assert.ok(newMem && newMem.serverId === srv.id && newMem.role === "member");

  // second accept of same token → 410
  assert.equal((await api("/api/auth/accept-system-invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: inv.invite.token, name: "x", password: "password-1" }) })).status, 410);

  // revoke flow: create → DELETE → accept 410
  const inv2 = await (await api("/api/admin/invites", { method: "POST", headers: hdr, body: JSON.stringify({ email: `in5-${suffix}@t.local`, serverId: srv.id, expiresInDays: 0.00001 }) })).json();
  // expiresInDays tiny → already expired on arrival
  assert.equal((await api("/api/auth/accept-system-invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: inv2.invite.token, name: "y", password: "password-1" }) })).status, 410);
  // explicit revoke
  const inv3 = await (await api("/api/admin/invites", { method: "POST", headers: hdr, body: JSON.stringify({ email: `in6-${suffix}@t.local`, serverId: srv.id }) })).json();
  assert.equal((await api(`/api/admin/invites/${inv3.invite.id}`, { method: "DELETE", headers: hdr })).status, 200);
  assert.equal((await api("/api/auth/accept-system-invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: inv3.invite.token, name: "z", password: "password-1" }) })).status, 410);

  // non-admin cannot create invites
  const pleb = await insertUser({ email: `pl4-${suffix}@t.local`, name: `pl4${suffix}`, password: "password-1" });
  assert.equal((await api("/api/admin/invites", { method: "POST", headers: { authorization: `Bearer ${signUser(pleb.id)}`, "content-type": "application/json" }, body: JSON.stringify({ email: "x@y.zz", serverId: srv.id }) })).status, 403);
});
```

- [ ] **Step 2: 跑红**

- [ ] **Step 3: 实现**

`routes-api/auth.ts`（handlePublicAuth）：

```ts
  if (p === "/api/auth/system-invite-info" && method === "GET") {
    const tok = url.searchParams.get("token") ?? "";
    const link = tok ? (await db.select().from(schema.systemInvites).where(eq(schema.systemInvites.token, tok)))[0] : undefined;
    const status = inviteStatus(link);
    if (status !== "valid") return (sendJson(res, 200, { valid: false, reason: status }), true);
    const srv = (await db.select().from(schema.servers).where(eq(schema.servers.id, link!.serverId)))[0];
    if (!srv) return (sendJson(res, 200, { valid: false, reason: "server_gone" }), true);
    const inviter = link!.createdByUserId ? (await db.select().from(schema.users).where(eq(schema.users.id, link!.createdByUserId)))[0] : null;
    return (sendJson(res, 200, { valid: true, email: maskEmail(link!.email), serverName: srv.name, serverSlug: srv.slug, inviterName: inviter?.displayName || inviter?.name || null, role: link!.role }), true);
  }
  if (p === "/api/auth/accept-system-invite" && method === "POST") {
    const rl = rateLimit("auth:sysinvite", clientIp(req), 10);
    if (!rl.ok) return (sendErr(res, 429, "too many requests", { retryAfter: rl.retryAfter }), true);
    const b = await readJson(req);
    const link = b.token ? (await db.select().from(schema.systemInvites).where(eq(schema.systemInvites.token, String(b.token))))[0] : undefined;
    const status = inviteStatus(link);
    if (status === "not_found") return (sendErr(res, 404, "invalid invite"), true);
    if (status !== "valid") return (sendErr(res, 410, status === "expired" ? "invite expired" : "invite already used", { code: `invite_${status}` }), true);
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 64) return (sendErr(res, 400, "invalid name", { code: "auth_register_name_invalid" }), true);
    const pwErr = passwordError(b.password);
    if (pwErr) return (sendErr(res, 400, pwErr, { code: "auth_password_invalid" }), true);
    const email = link!.email;
    const dup = (await db.select().from(schema.users).where(or(eq(schema.users.email, email), eq(schema.users.name, name))))[0];
    if (dup) return (sendErr(res, 409, dup.email === email ? "email already registered" : "username already taken", { code: dup.email === email ? "auth_register_email_taken" : "auth_register_username_taken" }), true);
    const [u] = await db.insert(schema.users).values({ name, displayName: name, email, passwordHash: hashPassword(String(b.password)) }).returning();
    await db.insert(schema.serverMembers).values({ serverId: link!.serverId, userId: u!.id, role: link!.role });
    await db.update(schema.systemInvites).set({ acceptedAt: new Date() }).where(eq(schema.systemInvites.id, link!.id));
    const all = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, link!.serverId), eq(schema.channels.name, "all"))))[0];
    if (all) await db.insert(schema.channelMembers).values({ channelId: all.id, memberType: "user", memberId: u!.id }).onConflictDoNothing();
    await logAudit("invite.accepted", { targetUserId: u!.id, targetServerId: link!.serverId, metadata: { ip: clientIp(req) } });
    return (sendJson(res, 200, { token: signUser(u!.id), user: { id: u!.id, name: u!.name } }), true);
  }
```

`routes-api/admin.ts`：

```ts
  if (ctx.p === "/api/admin/invites" && ctx.method === "GET") {
    const rows = await db.select().from(schema.systemInvites);
    const srvs = await db.select({ id: schema.servers.id, name: schema.servers.name }).from(schema.servers);
    const nameById = new Map(srvs.map((s) => [s.id, s.name]));
    return (sendJson(ctx.res, 200, { invites: rows.map((r) => ({ ...r, serverName: nameById.get(r.serverId) ?? null, status: r.acceptedAt ? "accepted" : (r.expiresAt && new Date(r.expiresAt as any).getTime() < Date.now() ? "expired" : "pending") })) }), true);
  }
  if (ctx.p === "/api/admin/invites" && ctx.method === "POST") {
    const b = await readJson(ctx.req);
    if (!isValidEmail(b.email)) return (sendErr(ctx.res, 400, "invalid email"), true);
    if (!isUuid(String(b.serverId ?? ""))) return (sendErr(ctx.res, 400, "invalid serverId"), true);
    const srv = (await db.select().from(schema.servers).where(eq(schema.servers.id, String(b.serverId))))[0];
    if (!srv) return (sendErr(ctx.res, 404, "server not found"), true);
    if (b.role !== undefined && !["member", "admin"].includes(String(b.role))) return (sendErr(ctx.res, 400, "role must be member or admin"), true);
    const dup = (await db.select().from(schema.systemInvites).where(eq(schema.systemInvites.email, String(b.email).toLowerCase())))[0];
    if (dup && !dup.acceptedAt && !(dup.expiresAt && new Date(dup.expiresAt as any).getTime() < Date.now())) return (sendErr(ctx.res, 409, "a pending invite for this email already exists"), true);
    const days = b.expiresInDays != null ? Number(b.expiresInDays) : 7;
    if (!Number.isFinite(days) || days <= 0 || days > 90) return (sendErr(ctx.res, 400, "expiresInDays must be in (0, 90]"), true);
    const [inv] = await db.insert(schema.systemInvites).values({
      email: String(b.email).toLowerCase(), token: newKey("inv_"), serverId: srv.id,
      role: b.role != null ? String(b.role) : "member", createdByUserId: ctx.userId,
      expiresAt: new Date(Date.now() + days * 86_400_000),
    }).returning();
    await logAudit("invite.created", { actorUserId: ctx.userId, targetServerId: srv.id, metadata: { email: inv!.email } });
    return (sendJson(ctx.res, 200, { invite: inv, url: `/invite/${inv!.token}` }), true);
  }
  {
    const m = /^\/api\/admin\/invites\/([^/]+)$/.exec(ctx.p);
    if (m && ctx.method === "DELETE") {
      if (!isUuid(m[1]!)) return (sendErr(ctx.res, 404, "not found"), true);
      const [inv] = await db.select().from(schema.systemInvites).where(eq(schema.systemInvites.id, m[1]!));
      if (!inv) return (sendErr(ctx.res, 404, "invite not found"), true);
      if (inv.acceptedAt) return (sendErr(ctx.res, 409, "invite already accepted"), true);
      await db.delete(schema.systemInvites).where(eq(schema.systemInvites.id, inv.id));
      await logAudit("invite.revoked", { actorUserId: ctx.userId, metadata: { email: inv.email } });
      return (sendJson(ctx.res, 200, { ok: true }), true);
    }
  }
```

- [ ] **Step 4: 跑绿 + typecheck**
- [ ] **Step 5: Commit**

```bash
git add src/server/routes-api/auth.ts src/server/routes-api/admin.ts src/server/systemAdmin.api.test.ts
git commit -m "feat(invite): admin-created account invites — public info + accept-creates-account (TDD)"
```

---

### Task 8: workspace 列表/删除 + stats + audit-logs（TDD）

**Files:**
- Modify: `src/server/routes-api/admin.ts`
- Test: `src/server/systemAdmin.api.test.ts`（累加）

- [ ] **Step 1: 红测**

```ts
test("admin servers/stats/audit: list counts, delete cascades, audit rows exist", async () => {
  const admin = await insertUser({ email: `sa5-${suffix}@t.local`, name: `sa5${suffix}`, password: "password-1", systemRole: "system_admin" });
  const hdr = { authorization: `Bearer ${signUser(admin.id)}`, "content-type": "application/json" };
  const srv = (await db.select().from(schema.servers).where(eq(schema.servers.slug, "open-tag")))[0]!;

  // build a throwaway workspace with one channel + one member, then delete it
  const [tmp] = await db.insert(schema.servers).values({ name: `tmp-${suffix}`, slug: `tmp-${suffix}`, ownerId: admin.id }).returning();
  const [ch] = await db.insert(schema.channels).values({ serverId: tmp!.id, name: "all", type: "channel" }).returning();
  await db.insert(schema.channelMembers).values({ channelId: ch!.id, memberType: "user", memberId: admin.id });
  await db.insert(schema.serverMembers).values({ serverId: tmp!.id, userId: admin.id, role: "owner" });
  await db.insert(schema.messages).values({ serverId: tmp!.id, channelId: ch!.id, senderType: "user", senderId: admin.id, seq: 1n, body: "x" });

  const list = await (await api("/api/admin/servers", { headers: hdr })).json();
  const tmpRow = list.servers.find((s: any) => s.id === tmp!.id);
  assert.ok(tmpRow && tmpRow.memberCount === 1 && tmpRow.agentCount === 0);

  // member JWT still valid globally, but server-scoped API now 403 (gate 2 membership gone)
  assert.equal((await api(`/api/admin/servers/${tmp!.id}`, { method: "DELETE", headers: hdr })).status, 200);
  assert.equal((await db.select().from(schema.servers).where(eq(schema.servers.id, tmp!.id))).length, 0);
  assert.equal((await db.select().from(schema.channels).where(eq(schema.channels.serverId, tmp!.id))).length, 0);
  assert.equal((await db.select().from(schema.messages).where(eq(schema.messages.serverId, tmp!.id))).length, 0);
  const scoped = await api("/api/channels", { headers: { authorization: `Bearer ${signUser(admin.id)}`, "x-server-id": tmp!.id } });
  assert.equal(scoped.status, 403); // membership row gone → gate-2 "not a member of this server"

  // stats shape
  const stats = await (await api("/api/admin/stats", { headers: hdr })).json();
  assert.ok(typeof stats.users.total === "number" && typeof stats.servers === "number" && typeof stats.agents.total === "number" && typeof stats.machines.online === "number");

  // audit rows exist for earlier events
  const logs = await (await api("/api/admin/audit-logs?event=server.deleted&limit=10", { headers: hdr })).json();
  assert.ok(logs.logs.length >= 1 && logs.logs[0].event === "server.deleted");
});
```

（注意：messages 表插入字段名以 schema 为准——seq 是 bigint、body/sender 字段实现时对齐 `src/db/schema.ts` 190 行起。）

- [ ] **Step 2: 跑红**

- [ ] **Step 3: 实现（admin.ts 追加）**

```ts
  if (ctx.p === "/api/admin/servers" && ctx.method === "GET") {
    const srvs = await db.select().from(schema.servers);
    const mems = await db.select({ serverId: schema.serverMembers.serverId }).from(schema.serverMembers);
    const ags = await db.select({ serverId: schema.agents.serverId }).from(schema.agents).where(isNull(schema.agents.deletedAt));
    const mc = new Map<string, number>(), ac = new Map<string, number>();
    for (const m of mems) mc.set(m.serverId, (mc.get(m.serverId) ?? 0) + 1);
    for (const a of ags) ac.set(a.serverId, (ac.get(a.serverId) ?? 0) + 1);
    const owners = new Map((await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users)).map((u) => [u.id, u.name]));
    return (sendJson(ctx.res, 200, { servers: srvs.map((s) => ({ id: s.id, name: s.name, slug: s.slug, ownerName: owners.get(s.ownerId) ?? null, memberCount: mc.get(s.id) ?? 0, agentCount: ac.get(s.id) ?? 0, createdAt: s.createdAt })) }), true);
  }
  {
    const m = /^\/api\/admin\/servers\/([^/]+)$/.exec(ctx.p);
    if (m && ctx.method === "DELETE") {
      if (!isUuid(m[1]!)) return (sendErr(ctx.res, 404, "not found"), true);
      const srv = (await db.select().from(schema.servers).where(eq(schema.servers.id, m[1]!)))[0];
      if (!srv) return (sendErr(ctx.res, 404, "server not found"), true);
      await db.transaction(async (tx) => {
        const sid = srv.id;
        // leaf → root, explicit deletes (FKs have no cascade). Full set = every table referencing
        // servers.id (verify with: grep -n "references(() => servers.id)" src/db/schema.ts).
        for (const t of [schema.agentMessageObservations, schema.agentMessageDecisions, schema.causalEdges, schema.messageMentions, schema.reactions, schema.savedMessages, schema.agentActivityLog]) await tx.delete(t).where(eq(t.serverId as any, sid));
        await tx.delete(schema.artifactVersions).where(inArray(schema.artifactVersions.artifactId, (await tx.select({ id: schema.artifacts.id }).from(schema.artifacts).where(eq(schema.artifacts.serverId, sid))).map((r) => r.id).length ? (await tx.select({ id: schema.artifacts.id }).from(schema.artifacts).where(eq(schema.artifacts.serverId, sid))).map((r) => r.id) : ["00000000-0000-0000-0000-000000000000"]));
        await tx.delete(schema.messages).where(eq(schema.messages.serverId, sid));
        await tx.delete(schema.attachments).where(eq(schema.attachments.serverId, sid));
        await tx.delete(schema.artifacts).where(eq(schema.artifacts.serverId, sid));
        for (const t of [schema.channelMembers, schema.reminders, schema.knowledge, schema.conversationTurns]) await tx.delete(t).where(eq(t.serverId as any, sid));
        await tx.delete(schema.agentSessions).where(eq(schema.agentSessions.serverId, sid));
        await tx.delete(schema.agentMemory).where(eq(schema.agentMemory.serverId, sid));
        await tx.delete(schema.agents).where(eq(schema.agents.serverId, sid));
        await tx.delete(schema.machines).where(eq(schema.machines.serverId, sid));
        await tx.delete(schema.channels).where(eq(schema.channels.serverId, sid));
        for (const t of [schema.serverSidebarPrefs, schema.joinLinks, schema.systemInvites, schema.serverMembers]) await tx.delete(t).where(eq(t.serverId as any, sid));
        await tx.delete(schema.servers).where(eq(schema.servers.id, sid));
      });
      await logAudit("server.deleted", { actorUserId: ctx.userId, targetServerId: srv.id, metadata: { name: srv.name, slug: srv.slug } });
      return (sendJson(ctx.res, 200, { ok: true }), true);
    }
  }
  if (ctx.p === "/api/admin/stats" && ctx.method === "GET") {
    const users = await db.select({ systemRole: schema.users.systemRole, disabledAt: schema.users.disabledAt }).from(schema.users);
    const [{ serverCount }] = await db.select({ serverCount: count() }).from(schema.servers);
    const ags = await db.select({ activity: schema.agents.activity, deletedAt: schema.agents.deletedAt }).from(schema.agents);
    const machs = await db.select({ status: schema.machines.status }).from(schema.machines);
    return (sendJson(ctx.res, 200, {
      users: { total: users.length, disabled: users.filter((u) => u.disabledAt).length, systemAdmins: users.filter((u) => u.systemRole === "system_admin").length },
      servers: Number(serverCount),
      agents: { total: ags.filter((a) => !a.deletedAt).length, active: ags.filter((a) => !a.deletedAt && ["thinking", "working"].includes(a.activity ?? "")).length },
      machines: { total: machs.length, online: machs.filter((x) => x.status === "online").length },
    }), true);
  }
  if (ctx.p === "/api/admin/audit-logs" && ctx.method === "GET") {
    const limit = Math.min(Math.max(Number(ctx.url.searchParams.get("limit") ?? 50), 1), 200);
    const ev = ctx.url.searchParams.get("event");
    const before = ctx.url.searchParams.get("before"); // createdAt ISO cursor
    const conds: any[] = [];
    if (ev) conds.push(eq(schema.auditLogs.event, ev));
    if (before && !Number.isNaN(Date.parse(before))) conds.push(lt(schema.auditLogs.createdAt, new Date(before)));
    const rows = await db.select().from(schema.auditLogs)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.auditLogs.createdAt)).limit(limit);
    return (sendJson(ctx.res, 200, { logs: rows }), true);
  }
```

**实现注意（务必执行）：**
1. 上面的删除顺序是骨架——动手前先跑 `grep -n "references(() => servers.id)" src/db/schema.ts` 逐一核对**每张**引用表都出现在事务里；漏一张 = 500 FK violation（测试会暴露，补上再绿）。`agentMessageObservations` 等表若无 serverId 列则按其实际外键（messageId/channelId）改用 inArray 子查询删，同 artifactVersions 的模式。
2. `lt`/`desc`/`isNull`/`inArray`/`and`/`count` 补 import。分页用 `before=<createdAt ISO>` + `lt(schema.auditLogs.createdAt, new Date(before))`，别用 uuid 比较。
3. `db.transaction` 确认 `src/db/index.ts` 导出支持（drizzle postgres 支持）。

- [ ] **Step 4: 跑绿 + typecheck + 全量回归**（Task 4-8 测试同跑）
- [ ] **Step 5: Commit**

```bash
git add src/server/routes-api/admin.ts src/server/systemAdmin.api.test.ts
git commit -m "feat(admin): server list/delete cascade, stats, audit-logs endpoints (TDD)"
```

---

### Task 9: 后端收尾验证

- [ ] **Step 0: 补 env 提升测试**（api.test.ts 追加；直调函数，不起服务器路径）：

```ts
test("SYSTEM_ADMIN_EMAILS promotion: idempotent, promote-only", async () => {
  const u = await insertUser({ email: `envp-${suffix}@t.local`, name: `envp${suffix}`, password: "password-1" });
  process.env.SYSTEM_ADMIN_EMAILS = u.email;
  try {
    await promoteSystemAdminsFromEnv();
    await promoteSystemAdminsFromEnv(); // twice — idempotent
    const row = (await db.select().from(schema.users).where(eq(schema.users.id, u.id)))[0]!;
    assert.equal(row.systemRole, "system_admin");
    // promote-only: clearing env must not demote
    delete process.env.SYSTEM_ADMIN_EMAILS;
    await promoteSystemAdminsFromEnv();
    const row2 = (await db.select().from(schema.users).where(eq(schema.users.id, u.id)))[0]!;
    assert.equal(row2.systemRole, "system_admin");
  } finally { delete process.env.SYSTEM_ADMIN_EMAILS; }
});
```

（`promoteSystemAdminsFromEnv` 从 `./systemSettings.js` 导入。）

- [ ] **Step 1: 全量验证**

```bash
npx tsx --test --test-force-exit test/systemAdminPolicy.unit.test.ts test/*.unit.test.ts src/daemon/*.test.ts web/src/views/*.test.ts
npx tsx --test --test-force-exit src/server/systemAdmin.api.test.ts
npm run typecheck
```
Expected: 全绿。红则修（`systematic-debugging`）。

- [ ] **Step 2: seed 幂等重跑一次** `npm run seed`（对已 seed 库应 "nothing to do"），确认无崩。

- [ ] **Step 3: Commit（若有修复）**

---

### Task 10: 前端 — adminGuard 纯函数 + 路由 + store（TDD）

**Files:**
- Create: `web/src/adminGuard.ts`、Test: `web/src/adminGuard.test.ts`
- Modify: `web/src/store.tsx`、`web/src/main.tsx`

- [ ] **Step 1: 红测**

```ts
// web/src/adminGuard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { adminRouteDecision } from "./adminGuard.ts";

test("admin route gate: skeleton while bootstrapping, deny non-admin, allow sysadmin", () => {
  assert.equal(adminRouteDecision({ ready: false, authState: "loading", systemRole: null }), "skeleton");
  assert.equal(adminRouteDecision({ ready: true, authState: "anon", systemRole: null }), "login");
  assert.equal(adminRouteDecision({ ready: true, authState: "authed", systemRole: null }), "workspace");
  assert.equal(adminRouteDecision({ ready: true, authState: "authed", systemRole: "system_admin" }), "admin");
});
```

（跑法对齐 web 现有单测：`npx tsx --test --test-force-exit web/src/adminGuard.test.ts`，并把文件名加进 CI 命令清单 — 查 `.github/workflows/ci.yml` 的 web glob 是 `web/src/views/*.test.ts`，把 adminGuard.test.ts 放 `web/src/views/` 下或改 glob。**选放 `web/src/views/adminGuard.test.ts`**，零 CI 改动。）

- [ ] **Step 2: 跑红**

- [ ] **Step 3: 实现**

```ts
// web/src/views/adminGuard.ts — pure routing decision for /admin/* (no React/DOM; unit-tested like routing.ts)
export type AdminRouteDecision = "skeleton" | "login" | "workspace" | "admin";
export function adminRouteDecision(s: { ready: boolean; authState: "loading" | "authed" | "anon"; systemRole: string | null }): AdminRouteDecision {
  if (!s.ready) return "skeleton";
  if (s.authState !== "authed") return "login";
  return s.systemRole === "system_admin" ? "admin" : "workspace";
}
```

`web/src/store.tsx`：`Me` 接口加 `systemRole?: string | null;`（bootstrap 的 me fetch 不用改——`/api/auth/me` 已返回）。

`web/src/main.tsx`：

```tsx
function AdminRoute() {
  const { slug, ready, authState, me } = useStore();
  const loc = useLocation();
  switch (adminRouteDecision({ ready, authState, systemRole: me?.systemRole ?? null })) {
    case "skeleton": return <WorkspaceSkeleton />;
    case "login": return <Navigate to="/login" replace />;
    case "workspace": return <Navigate to={`/s/${slug}/channel${loc.search}`} replace />;
    default: return <Admin />;
  }
}
// Routes 里（/s/:server 之前）：
<Route path="/admin" element={<AdminRoute />} />
<Route path="/admin/:section" element={<AdminRoute />} />
<Route path="/invite/:token" element={<SystemInvitePage />} />
```

（`Admin`、`SystemInvitePage` 本任务先建最小占位导出，Task 11/15 填实。）

- [ ] **Step 4: 跑绿 + `npm run typecheck`**
- [ ] **Step 5: Commit**

```bash
git add web/src/views/adminGuard.ts web/src/views/adminGuard.test.ts web/src/store.tsx web/src/main.tsx
git commit -m "feat(web): /admin route gate + me.systemRole (TDD)"
```

---

### Task 11: Admin 控制台 — 外壳 + Users/Settings 页签

**Files:**
- Create: `web/src/views/Admin.tsx`、`web/src/views/admin/UsersTab.tsx`、`web/src/views/admin/SettingsTab.tsx`
- Modify: locale 两份（key 见 Step 3）

- [ ] **Step 1: Admin.tsx 外壳**（页签 = 路由参数；样式对齐 misc.tsx 的 `.head`/`.sec`/sidebar item 模式）：

```tsx
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useStore } from "../store.tsx";
import { UsersTab } from "./admin/UsersTab.tsx";
import { InvitesTab } from "./admin/InvitesTab.tsx";        // Task 12（先占位）
import { WorkspacesTab } from "./admin/WorkspacesTab.tsx";  // Task 12（先占位）
import { AuditTab } from "./admin/AuditTab.tsx";            // Task 12（先占位）
import { SettingsTab } from "./admin/SettingsTab.tsx";

const TABS = ["users", "invites", "workspaces", "audit", "settings"] as const;
export function Admin() {
  const { section } = useParams();
  const nav = useNavigate();
  const { t } = useTranslation();
  const { api } = useStore();
  const tab = (TABS as readonly string[]).includes(section ?? "") ? (section as typeof TABS[number]) : "users";
  return (
    <div className="admin-page">
      <div className="head"><h1>{t("admin.title")}</h1><small>{t("admin.subtitle")}</small></div>
      <div className="admin-tabs">
        {TABS.map((x) => <button key={x} className={"item" + (x === tab ? " active" : "")} onClick={() => nav(`/admin/${x}`)}>{t(`admin.tab.${x}`)}</button>)}
      </div>
      <div className="scroll">
        {tab === "users" && <UsersTab api={api} />}
        {tab === "settings" && <SettingsTab api={api} />}
        {/* invites / workspaces / audit: Task 12 */}
      </div>
    </div>
  );
}
```

（占位 tab 文件先导出 `export function InvitesTab() { return null; }` 等。`stats` 并入 workspaces 页顶部计数行——比独立页签省一个组件，spec 的「统计面板」功能不缺。）

- [ ] **Step 2: UsersTab.tsx**（完整逻辑；表格/按钮 className 参考 Members.tsx 同类元素）：

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "../../ConfirmModal.tsx";
export function UsersTab({ api }: { api: (m: string, p: string, b?: unknown) => Promise<any> }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [tempPw, setTempPw] = useState<{ email: string; pw: string } | null>(null);
  const load = async () => setUsers((await api("GET", `/api/admin/users?q=${encodeURIComponent(q)}`))?.users ?? []);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  const patch = async (id: string, body: unknown) => { setBusy(true); try { await api("PATCH", `/api/admin/users/${id}`, body); await load(); } finally { setBusy(false); } };
  const resetPw = async (u: any) => {
    if (!(await confirm({ title: t("admin.users.resetConfirm", { email: u.email }), message: t("admin.users.resetMessage"), confirmLabel: t("admin.users.resetBtn"), danger: true }))) return;
    const r = await api("POST", `/api/admin/users/${u.id}/reset-password`);
    if (r?.tempPassword) setTempPw({ email: u.email, pw: r.tempPassword });
  };
  return (
    <div className="admin-users">
      <input placeholder={t("admin.users.search")} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} />
      <table><thead><tr><th>{t("admin.users.email")}</th><th>{t("admin.users.role")}</th><th>{t("admin.users.status")}</th><th>{t("admin.users.workspaces")}</th><th>{t("admin.users.created")}</th><th></th></tr></thead>
        <tbody>{users.map((u) => (
          <tr key={u.id}>
            <td>{u.email}</td>
            <td>{u.systemRole === "system_admin" ? t("admin.users.sysAdmin") : "—"}</td>
            <td>{u.disabledAt ? t("admin.users.disabled") : t("admin.users.active")}</td>
            <td>{u.workspaceCount}</td>
            <td>{new Date(u.createdAt).toLocaleDateString()}</td>
            <td>
              <button className="action-btn" disabled={busy} onClick={() => patch(u.id, { disabled: !u.disabledAt })}>{u.disabledAt ? t("admin.users.enable") : t("admin.users.disable")}</button>
              <button className="action-btn" disabled={busy} onClick={() => patch(u.id, { systemRole: u.systemRole ? null : "system_admin" })}>{u.systemRole ? t("admin.users.demote") : t("admin.users.promote")}</button>
              <button className="action-btn" disabled={busy} onClick={() => resetPw(u)}>{t("admin.users.resetBtn")}</button>
            </td>
          </tr>))}</tbody></table>
      {tempPw && (
        <div className="modal-backdrop" onClick={() => setTempPw(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t("admin.users.tempPwTitle", { email: tempPw.email })}</h3>
            <p><code>{tempPw.pw}</code></p>
            <p>{t("admin.users.tempPwNote")}</p>
            <button className="action-btn" onClick={() => { navigator.clipboard?.writeText(tempPw.pw); }}>{t("admin.users.copy")}</button>
          </div>
        </div>)}
    </div>
  );
}
```

- [ ] **Step 3: SettingsTab.tsx**

```tsx
export function SettingsTab({ api }: { api: (m: string, p: string, b?: unknown) => Promise<any> }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [open, setOpen] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api("GET", "/api/admin/settings").then((r) => setOpen(!!r?.openRegistration)); }, [api]);
  const flip = async (v: boolean) => {
    if (!(await confirm({ title: t("admin.settings.regConfirmTitle"), message: v ? t("admin.settings.regOpenMsg") : t("admin.settings.regCloseMsg"), danger: !v }))) return;
    setBusy(true); try { const r = await api("PATCH", "/api/admin/settings", { openRegistration: v }); if (r && !r.error) setOpen(v); } finally { setBusy(false); }
  };
  if (open === null) return null;
  return (
    <div>
      <div className="kv"><b>{t("admin.settings.openRegistration")}</b>
        <label><input type="checkbox" checked={open} disabled={busy} onChange={(e) => flip(e.target.checked)} /> {open ? t("admin.settings.open") : t("admin.settings.closed")}</label>
      </div>
      <p className="empty">{t("admin.settings.regHint")}</p>
    </div>
  );
}
```

- [ ] **Step 4: locale keys**（`web/src/locales/zh.json` + `en.json` 同 key）：

```json
"admin": {
  "title": "系统管理", "subtitle": "部署级管理控制台",
  "tab": { "users": "用户", "invites": "邀请", "workspaces": "Workspaces", "audit": "审计日志", "settings": "设置" },
  "users": { "search": "搜索邮箱/用户名", "email": "邮箱", "role": "系统角色", "status": "状态", "workspaces": "Workspaces", "created": "创建时间", "sysAdmin": "系统管理员", "active": "正常", "disabled": "已禁用", "enable": "启用", "disable": "禁用", "promote": "设为管理员", "demote": "撤销管理员", "resetBtn": "重置密码", "resetConfirm": "重置 {{email}} 的密码？", "resetMessage": "当前密码立即失效。", "tempPwTitle": "{{email}} 的临时密码", "tempPwNote": "仅显示一次，请复制交付给用户。", "copy": "复制" },
  "settings": { "openRegistration": "开放注册", "open": "开放", "closed": "已关闭", "regConfirmTitle": "更改开放注册？", "regOpenMsg": "开启后任何人可自行注册。", "regCloseMsg": "关闭后仅系统管理员邀请可建号。", "regHint": "关闭注册后，新用户由管理员在「邀请」页签创建。" },
  "invites": { "email": "邮箱", "workspace": "加入 Workspace", "role": "角色", "expires": "有效期（天）", "create": "创建邀请", "link": "邀请链接", "copy": "复制", "revoke": "撤销", "pending": "待接受", "accepted": "已接受", "expired": "已过期", "createdOk": "邀请已创建", "member": "成员", "admin": "管理员" },
  "workspaces": { "name": "名称", "owner": "所有者", "members": "成员", "agents": "Agents", "created": "创建时间", "delete": "删除", "deleteConfirm": "删除 workspace「{{name}}」？", "deleteMessage": "频道、消息、成员关系将全部删除，不可恢复。", "statsUsers": "用户", "statsServers": "Workspaces", "statsAgents": "Agents（活跃）", "statsMachines": "机器（在线）", "statsDisabled": "禁用用户" },
  "audit": { "event": "事件", "actor": "操作者", "time": "时间", "details": "详情", "all": "全部事件", "loadMore": "加载更多" }
}
```
（en.json 翻译同结构英文。`auth.errors.auth_registration_closed` / `auth_account_disabled` 两个 error code 也补进两份 locale。）

- [ ] **Step 5: typecheck + 单测全量**
- [ ] **Step 6: Commit**

```bash
git add web/src/views/Admin.tsx web/src/views/admin/ web/src/locales/
git commit -m "feat(web): admin console shell + users/settings tabs + i18n"
```

---

### Task 12: Admin 控制台 — Invites/Workspaces(+stats)/Audit 页签

**Files:**
- Create: `web/src/views/admin/InvitesTab.tsx`、`WorkspacesTab.tsx`、`AuditTab.tsx`
- Modify: `web/src/views/Admin.tsx`（挂载三页签）

- [ ] **Step 1: InvitesTab**（表单 email + workspace 下拉(从 `/api/admin/servers` 取) + 角色 member/admin + 有效期默认 7 → POST；列表含复制链接 `location.origin + url`、撤销）
- [ ] **Step 2: WorkspacesTab**（顶部 `/api/admin/stats` 计数卡；server 表格 + 成员/agent 计数 + 删除走 confirm(danger)）
- [ ] **Step 3: AuditTab**（事件下拉过滤 + `createdAt` 游标 loadMore；metadata JSON.stringify 展示）
- [ ] **Step 4: Admin.tsx 挂载三页签（去掉占位）**
- [ ] **Step 5: typecheck + Commit**

```bash
git add web/src/views/Admin.tsx web/src/views/admin/
git commit -m "feat(web): invites/workspaces/audit admin tabs"
```

（数据流全部走 store 的 `api` helper；错误弹 toast `t("common.error")` 模式对齐 Computers 页。）

---

### Task 13: 侧边栏入口 + /invite/:token 落地页 + 注册页门

**Files:**
- Modify: `web/src/Layout.tsx`（icon rail，settings 图标旁）、`web/src/views/Auth.tsx`、`web/src/main.tsx`

- [ ] **Step 1: Layout.tsx**：左侧 icon rail 的 settings 入口旁加条件项（仅 `me?.systemRole === "system_admin"` 渲染，`me` 从 `useStore()` 解构）：react-router `<Link to="/admin">` + `t("admin.entry")`（补 key：zh "系统管理" / en "System Admin"）。注意入口文件是 Layout.tsx 的 rail，**不是** ChatSidebar（那是频道列表）。
- [ ] **Step 2: Auth.tsx 加 `SystemInvitePage`**（仿 `JoinPage`：独立于 StoreProvider，fetch `/api/auth/system-invite-info?token=`；invalid → 提示 + 去登录；valid → name + password 表单 → `accept-system-invite` → `finishAuth(token, await workspaceHome(token))`）：

```tsx
export function SystemInvitePage() {
  const { token } = useParams();
  const { t } = useTranslation();
  const [info, setInfo] = useState<any>(null);
  const [name, setName] = useState(""); const [password, setPassword] = useState("");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { fetch(`/api/auth/system-invite-info?token=${encodeURIComponent(token ?? "")}`).then((r) => r.json()).then(setInfo).catch(() => setInfo({ valid: false })); }, [token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const r = await fetch("/api/auth/accept-system-invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, name, password }) });
      const d = await r.json().catch(() => null);
      if (!r.ok) { setErr(authErrorMessage(t, d, t("auth.inviteFailed"))); return; }
      finishAuth(d.token, await workspaceHome(d.token));
    } finally { setBusy(false); }
  };
  if (!info) return null;
  if (!info.valid) return <AuthShell title={t("auth.inviteInvalidTitle")}><p>{t("auth.inviteInvalid")}</p><a href="/login">{t("auth.toLogin")}</a></AuthShell>;
  return (
    <AuthShell title={t("auth.inviteTitle", { server: info.serverName })}>
      <p>{t("auth.inviteIntro", { inviter: info.inviterName ?? "?", email: info.email })}</p>
      <form onSubmit={submit}>
        <label className="auth-field"><span>{t("auth.usernameLabel")}</span><input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label className="auth-field"><span>{t("auth.passwordLabel")}</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {err && <div className="form-err" role="alert">{err}</div>}
        <button disabled={busy}>{busy ? "…" : t("auth.inviteJoin")}</button>
      </form>
    </AuthShell>
  );
}
```

（`AuthShell` 若 Auth.tsx 无此抽象，用 JoinPage 同款外层结构内联；locale 补 `auth.invite*` key 两份。）

- [ ] **Step 3: 注册页门**：`AuthPage mode="register"` 挂载时 fetch `/api/auth/config`；`openRegistration === false` → 表单替换为「注册已关闭」+ 去登录链接（`t("auth.registrationClosed")` 补 key）。
- [ ] **Step 4: typecheck + Commit**

```bash
git add web/src/Layout.tsx web/src/views/Auth.tsx web/src/locales/
git commit -m "feat(web): sysadmin sidebar entry + /invite landing + registration-closed gate"
```

---

### Task 14: 浏览器验证（real-run 层）

- [ ] **Step 1: 起隔离栈**

```bash
cd d:/OpenSource/open-tag-system-admin
npm run dev:e2e:up
```
（需要 claude CLI 认证；产物：dev-login URL `http://localhost:$PORT/?as=you`。）

- [ ] **Step 2: chrome-devtools MCP（--isolated）逐项验证并截图存 `.shots/`：**
  1. `?as=you` 登录 → 侧边栏出现「系统管理」
  2. `/admin` users 页签：列表含 you（system_admin）
  3. settings 页签：关闭开放注册 → `/register` 显示已关闭 → 重新开启
  4. invites：建邀请（email + open-tag workspace）→ 复制链接
  5. 无痕/登出开邀请链接 → 表单 → 建号成功落进 workspace、#all 可见
  6. users 页签禁用新用户 → 该用户 token 失效被踢/401
  7. audit 页签：上述事件全有行
  8. workspaces 页签：计数正确；stats 卡片数字合理
- [ ] **Step 3: `npm run dev:e2e:down`**
- [ ] **Step 4: 记录证据**（截图文件名列表写进 dev log，Task 15）

---

### Task 15: 文档同步 + 开发日志

**Files:**
- Modify: `docs/generated/db-schema.md`、`ARCHITECTURE.md`、`docs/authorization.md`、`FEATURES.md`、`README.md`、`docs/PLANS.md`
- Create: `.agents/notes/2026-09-22-system-admin.md`

- [ ] **Step 1: db-schema.md** — 按文件头规则从 `src/db/schema.ts` 重新生成/补四项变更（users 两列 + 三表 + 索引）。
- [ ] **Step 2: ARCHITECTURE.md** — codemap 加 `routes-api/admin.ts`、`systemAdminPolicy.ts`、`systemSettings.ts`、`audit.ts`；§路由分发处把 gate 1.5 写进分发链（gate 1 → **admin gate** → gate 2）；`web/src/views/Admin.tsx` + `adminGuard.ts` 进 web 段。
- [ ] **Step 3: docs/authorization.md** — 新「系统平面」一节：`systemRole` 语义、gate 1.5、禁用执行点（三入口）、与三平面的关系表；`SYSTEM_ADMIN_EMAILS` bootstrap；审计事件表。
- [ ] **Step 4: FEATURES.md** 勾选 + **README.md** "Verified" 段补浏览器验证证据（引用 Task 14 截图清单）+ `.env` 说明补 `SYSTEM_ADMIN_EMAILS`。
- [ ] **Step 5: docs/PLANS.md** 挂本计划条目（链接 spec + plan，状态 done）。
- [ ] **Step 6: `.agents/notes/2026-09-22-system-admin.md` 开发日志**（做了什么/决策/证据/坑）。
- [ ] **Step 7: 全量终验**

```bash
npm run typecheck
npx tsx --test --test-force-exit test/*.unit.test.ts src/daemon/*.test.ts web/src/views/*.test.ts
npx tsx --test --test-force-exit src/server/systemAdmin.api.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add docs/ .agents/notes/ README.md FEATURES.md
git commit -m "docs: sync system admin plane (schema/authz/codemap/features) + dev log"
```

---

## 完成定义

- [ ] 全部 checkbox 打勾；三层验证（单测/API/浏览器）证据在手
- [ ] `npm run typecheck` 绿；CI 层单测全绿（含新增两个测试文件）
- [ ] daemon 零改动（`git diff --stat origin/main -- src/daemon packages` 为空）
- [ ] 文档同步完成（AGENTS.md doc-sync 表逐行核对）
- [ ] spec §7 测试矩阵核对：场景 2-6、8-10、12 API 测试覆盖；场景 1 的决策逻辑单测覆盖（空表 bootstrap 在共享 worktree DB 上不可 API 测），授予路径（seed 标记 + env 提升）浏览器/直调测试验证；场景 7 的 WS 拒连与场景 11 的 agent-token 失效**降级为浏览器/人工验证**（root 无 socket.io-client 依赖，为此加包不值当）；场景 11 的 gate-2 403 已有 API 断言

## 明确不做（对照 spec §10）

邮件发送、JWT 黑名单、sysadmin 全局计数保护、RBAC 框架、workspace 角色改动。
