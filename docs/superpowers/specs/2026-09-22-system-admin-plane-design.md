# 系统管理平面（System Admin Plane）设计

日期：2026-09-22
状态：已与需求方逐节确认

## 1. 背景与目标

现状：`POST /api/auth/register` 开放注册，任何人注册即创建个人 workspace（多租户 SaaS 模式）。角色体系只有 workspace 级（`serverMembers.role`: owner/admin/member），`users` 表无系统级角色。

目标（GitLab 自管理版同构）：

1. **系统级管理员**：整个部署的超级管理员，跨 workspace，高于 workspace 角色。第一个用户自动成为系统管理员。
2. **注册开关**：开放注册默认开，系统管理员可关闭；关闭后注册接口 403。
3. **邀请制**：注册关闭后，用户只能通过系统管理员的邀请链接建号。
4. **企业管理后台**：用户管理、workspace 全局视图、审计日志、系统统计。

不动：三平面认证模型（human/agent/daemon）、workspace 角色体系（`serverMembers`/`joinLinks`/`capabilities.ts`）零改动。`src/daemon/**` 零改动。

## 2. 方案选型

选定：**独立系统管理平面**（方案一）。

- 否决「复用 workspace 角色」：系统角色与 workspace 角色耦合，多 workspace 下语义崩坏。
- 否决「表驱动 RBAC」：两个系统角色用不上三表框架，YAGNI。
- 依据：`docs/authorization.md` 三平面模型是承重墙，新增维度（系统平面）显式独立，不塞进 workspace 角色。

## 3. 数据模型

**`users` 表新增两列：**

| 列 | 类型 | 说明 |
|---|---|---|
| `systemRole` | `text null` | `system_admin` 或 null。text 而非 boolean，留扩展空间 |
| `disabledAt` | `timestamp null` | 非空即禁用（软禁用，保数据可恢复；语义对齐 agents 的 `deletedAt`） |

**新表 `system_settings`（单行 KV）：**

```ts
systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),          // "openRegistration"
  value: jsonb("value").notNull(),        // {"enabled": true}
  updatedAt: timestamp,
  updatedByUserId: uuid,                  // references users
})
```

初值 `openRegistration.enabled = true`（GitLab 默认），seed 插入。

**新表 `system_invites`：**

```ts
systemInvites = pgTable("system_invites", {
  id: uuid primaryKey,
  email: text notNull,                    // 目标邮箱
  token: text notNull unique,             // newKey("inv_")
  serverId: uuid references servers,      // 建号后自动加入的 workspace
  role: text default "member",            // serverMembers.role
  createdByUserId: uuid references users,
  expiresAt: timestamp,                   // 默认创建后 7 天
  acceptedAt: timestamp null,             // null = pending
  createdAt: timestamp,
}, (t) => ({
  // 同一 email 同时最多一个待接受邀请（部分唯一索引；撤销 = 硬删行，历史由 audit_logs 承载）
  onePendingPerEmail: uniqueIndex("system_invites_pending_email_uidx").on(t.email).where(sql`accepted_at is null`),
}))
```

与现有 `joinLinks` 并存、语义分离：joinLinks = 已登录用户加入 workspace；system_invites = 无账号者建号。

**新表 `audit_logs`：**

```ts
auditLogs = pgTable("audit_logs", {
  id: uuid primaryKey,
  event: text notNull,                    // 见 §5 事件集
  actorUserId: uuid null,                 // 操作者（登录事件 = 本人）
  targetUserId: uuid null,
  targetServerId: uuid null,
  metadata: jsonb,                        // IP、旧值→新值等
  createdAt: timestamp,
})
```

## 4. API

### 4.1 修改现有端点（`src/server/routes-api/auth.ts`）

| 端点 | 变更 |
|---|---|
| `POST /api/auth/register` | 门逻辑：用户表为空 → 放行且注册者标 `system_admin`（bootstrap）；否则查 `openRegistration`，关 → `403 auth_registration_closed`。审计 `user.registered` |
| `POST /api/auth/login` | 密码验证通过后查 `disabledAt`，非空 → `403 auth_account_disabled`。审计 `user.login` |
| `GET /api/auth/me` | 返回体加 `systemRole` |

### 4.2 新增公共端点（gate 0）

- `GET /api/auth/config` — `{openRegistration: boolean}`，注册页据此显隐注册表单
- `GET /api/auth/system-invite-info?token=` — 邀请落地页信息：valid、email 掩码、workspace 名、邀请人、角色
- `POST /api/auth/accept-system-invite` — body `{token, name, password}`。校验（存在/未过期/未接受/未撤销）→ 建用户（email 取自邀请行，防篡改；email 冲突 → 409）→ 插 `serverMembers`（邀请内角色）→ 进 `#all` 频道 → 标 `acceptedAt` → 返回 JWT。限流同 register

### 4.3 `/api/admin/*` 命名空间

新文件 `src/server/routes-api/admin.ts`，新 **gate 1.5**（dispatch 在 gate 1 之后、gate 2 之前）：登录 + `systemRole = 'system_admin'`，否则 403；不要求 `x-server-id`。

| 端点 | 用途 |
|---|---|
| `GET /api/admin/settings` | 读系统设置 |
| `PATCH /api/admin/settings` | 改 `openRegistration`；审计旧值→新值 |
| `GET /api/admin/users?q=` | 用户列表：id、email、systemRole、disabledAt、createdAt、workspace 计数 |
| `PATCH /api/admin/users/:id` | `{disabled}` / `{systemRole}`。保护：不可禁用/降级自己 |
| `POST /api/admin/users/:id/reset-password` | 生成随机临时密码，响应返回一次 |
| `GET /api/admin/invites` | 邀请列表（含 pending/accepted 状态） |
| `POST /api/admin/invites` | 建邀请 `{email, serverId, role, expiresInDays?}`，返回完整链接 URL |
| `DELETE /api/admin/invites/:id` | 撤销（仅 pending） |
| `GET /api/admin/servers` | workspace 列表 + 成员/agent 计数 |
| `DELETE /api/admin/servers/:id` | 删 workspace（见下方删除设计） |
| `GET /api/admin/stats` | 用户/workspace/agent/机器计数与在线状态 |
| `GET /api/admin/audit-logs` | 分页 `?event=&limit=50&before=` |

**workspace 删除设计**（repo 现无删除路由，FK 多无 cascade，此处定最小可行范围）：事务内按 FK 依赖序显式删全部子表（messages → channel_members → channels → agents → machines → join_links → server_members → servers 为骨架，完整清单以引用 `servers.id` 的表为准——含 attachments、savedMessages、reactions 等，计划时逐一核对），再删 server 行。运行中的 daemon/agent 进程不做主动终止：其 server 行删除后，后续认证/心跳自然失败，进程在下次重连时自行退出。审计 `server.deleted`。

### 4.4 审计事件集

`user.registered`、`user.login`、`user.disabled`、`user.enabled`、`user.system_role_changed`、`user.password_reset`、`invite.created`、`invite.accepted`、`invite.revoked`、`settings.open_registration_changed`、`server.deleted`。

## 5. 禁用执行点

JWT 30 天有效，无 revocation 机制（黑名单表同样要每请求查库，成本相同）→ **统一查库守卫**。

新 `resolveActiveUser(token)`（`src/server/auth.ts`）：`verifyUser` → 查 users 行 → `disabledAt` 非空返回 null。三个入口全换：

| 入口 | 现状 | 改后 |
|---|---|---|
| REST gate 1（`src/server/routes-api/index.ts:41`） | 仅 `verifyUser` | `resolveActiveUser`；顺带取 `systemRole` 供 gate 1.5 |
| WS 连接（`src/server/socketio.ts:36`） | 仅 `verifyUser` | 同上 |
| 公共附件路径（`src/server/routes-api/attachments.ts:125`） | 仅 `verifyUser` | 同上 |

自托管规模下每请求 +1 主键查询可忽略；内存 TTL 缓存 YAGNI，不做。

语义：禁用 = 拦登录 + 拦已有 token 的全部 API/WS；数据保留；启用即恢复。

最后管理员保护：不可禁用/降级自己。不做「全局至少一个 sysadmin」计数检查（自己不删自己即够，YAGNI）。

## 6. 前端

**路由（`web/src/main.tsx`）：**

- 新顶层 `/invite/:token`（公共邀请落地页）、`/admin/*`（不嵌在 `/s/:server` 下，系统级跨 workspace）
- `/admin` 守卫仿 `WorkspaceRoute`：bootstrap 中 skeleton，非 `system_admin` 重定向到自己 workspace
- `/register`：先取 `GET /api/auth/config`，`openRegistration=false` 时禁用注册表单（服务端 403 仍是最终防线）

**视图（新 `web/src/views/Admin.tsx`）：**

页签 `users | invites | workspaces | audit | stats | settings`：

- **users**：表格（email、系统角色、状态、workspace 计数、创建时间）；行操作：禁用/启用、设/撤 system_admin、重置密码（弹窗显示一次）
- **invites**：建邀请表单（email、workspace 下拉、角色、有效期）+ pending 列表 + 复制链接 + 撤销
- **workspaces**：列表 + 计数 + 删除（ConfirmModal）
- **audit**：事件过滤 + 分页表格
- **stats**：计数卡片
- **settings**：开放注册开关

复用现有 `Select`、`ConfirmModal`、`toast`、i18n（zh/en locale 全量补 key，默认语言 zh）。

**入口**：`Layout.tsx` 左侧 icon rail 的 settings 图标旁加「系统管理」，仅 `systemRole === 'system_admin'` 渲染。

**邀请落地页**：调 `system-invite-info`，表单 name + password → `accept-system-invite` → 存 JWT → 跳转该 workspace。风格对齐现有 `JoinPage`。

## 7. 测试策略（TDD）

两层（对齐仓库现状）：

**纯逻辑单测（CI 层，先写）** — 新 `src/server/systemAdminPolicy.ts` + `test/systemAdminPolicy.unit.test.ts`：

- `registrationDecision(userCount, openRegistration)` → `bootstrap | allow | reject`
- 邀请有效性判断、email 掩码

**API 测试（真服务器 + 真 DB，本地跑，红→绿驱动）** — 新 `src/server/systemAdmin.api.test.ts`（仿 `agentLifecycle.api.test.ts`：freePort + spawn + fetch），场景：

1. 空用户表 → 首注册者 `system_admin`；seed 后 `you` 为 `system_admin`（两条授予路径各验）
2. 关注册 → 403 `auth_registration_closed`
3. `GET /api/auth/config` 反映开关
4. 非 sysadmin 访问 `/api/admin/*` → 403
5. 建邀请 → accept → 建号 + 入 workspace + `#all` + `acceptedAt` → JWT 可用
6. 过期/已接受/撤销邀请 → 410/403；同 email 第二个 pending → 409
7. 禁用用户 → login 403、旧 JWT API 拒绝、WS 拒连
8. 不可禁用/降级自己 → 400
9. 重置密码 → 旧密码失效、新密码可登录
10. 审计行存在（注册/登录/禁用/开关变更/邀请）
11. workspace 删除级联：删后成员/频道/消息全清，被删 workspace 的成员 JWT 仍全局有效但 server 级 API 拒绝（gate 2 403 not a member），该 workspace 的 agent token 失效（`resolveAgent` 拒绝）
12. stats 计数

**前端**：路由守卫逻辑抽纯函数单测；页面浏览器验证（worktree `dev:e2e:up` + chrome-devtools MCP）。

## 8. 迁移与存量部署

- DB 变更 additive（加列 + 三新表），`db:push` 安全
- **首管理员三条授予路径，按部署形态各归其位**：
  1. **标准新部署（跑了 `npm run seed`）**：seed.ts 直接把 seeded owner（`you`）标为 `system_admin`（幂等）。之后 `POST /api/auth/setup` 设密码，admin 即就位。注意：标准部署的 users 表从不为空，register 的 bootstrap 分支不会触发。
  2. **未 seed 的全新部署**：`users` 表为空时，首个 `POST /api/auth/register` 注册者自动标 `system_admin`（§4.1 bootstrap）。
  3. **存量部署（已有用户、无任何 system_admin）**：env `SYSTEM_ADMIN_EMAILS`（逗号分隔 email），服务器启动时幂等提升对应用户为 `system_admin`。不用「首个注册者升级」策略——存量开放注册的公开实例上，那等于把管理员送给随机访客。
- **dev-login**（`ALLOW_DEV_LOGIN=true`）是开发态建号路径，绕过注册开关、不授予 `system_admin`。dev / `dev:e2e` 栈的 admin 账号来自 seed 标记（`?as=you`）或 `SYSTEM_ADMIN_EMAILS`。
- `openRegistration` 默认 `true`：存量行为不变，admin 可关
- 不涉及 daemon，无 npm 包发布动作

## 9. 文档同步（同 commit）

`docs/generated/db-schema.md`、`ARCHITECTURE.md`（codemap + gate 1.5）、`docs/authorization.md`（系统平面）、`FEATURES.md`、`README.md`、`docs/PLANS.md`。开发日志 `.agents/notes/`。

## 10. 非目标（YAGNI 清单）

- 邮件发送（邀请链接由 admin 复制分发，同现有 joinLinks 交互）
- 全局「至少一个 sysadmin」计数校验
- 禁用用户 JWT 黑名单 / 内存缓存
- 表驱动 RBAC、组织层级、SSO/LDAP
- workspace 角色体系任何改动
