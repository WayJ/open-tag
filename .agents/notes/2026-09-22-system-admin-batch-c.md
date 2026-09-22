# 2026-09-22 — system-admin 平面 batch C（Task 6-7：用户管理端点 + 系统邀请端点）

**分支**: `feature/system-admin`（worktree `open-tag-system-admin`）
**设计**: `docs/superpowers/specs/2026-09-22-system-admin-plane-design.md` §6-§7

## 需求

Batch C = Task 6（用户管理端点）与 Task 7（系统邀请端点），外加 batch B 评审遗留的
两项修复折入。全部 TDD（红→绿），逐 task 提交。

## 遗留修复（折入 Task 6 commit 8ee162e）

1. `admin.ts` 尾部：`/api/admin/*` 前缀匹配 + guard 通过但无路由命中时，原先
   return false → 落到 gate 2 报误导性的 400 "x-server-id header required"。
   改为 handler 内 404 "not found"。
2. `systemAdmin.api.test.ts` registration-gate 测试：开头显式 PATCH-to-true
   建立前置条件（消除顺序依赖）；恢复 PATCH 移入 try/finally。

## Task 6 — 用户管理端点（commit 8ee162e）

- `GET /api/admin/users`：全量列表 + `q` 过滤（email/name）+ `workspaceCount`
  （serverMembers 聚合），按 createdAt 升序。
- `PATCH /api/admin/users/:id`：`{disabled}` / `{systemRole}`；自守卫——不能禁用
  自己、不能给自己去 system_admin（均 400）；空 patch 400；audit
  `user.disabled` / `user.enabled` / `user.system_role_changed`（含 from→to）。
- `POST /api/admin/users/:id/reset-password`：随机 12 字符 url-safe 临时密码
  （`randomBytes(9).toString("base64url")`），覆写 passwordHash，audit
  `user.password_reset`。一次性返回，不再存储明文。

## Task 7 — 系统邀请端点（commit be8880d）

- 管理端（gate 1.5）：`GET /api/admin/invites`（含派生 status：
  accepted/expired/pending + serverName）、`POST`（email 校验 + 小写化、serverId
  校验、role ∈ {member,admin}、expiresInDays ∈ (0,90] 默认 7、pending dup → 409）、
  `DELETE /:id`（revocation = 硬删，accepted → 409，audit `invite.revoked`）。
- 公共端（gate 0）：`GET /api/auth/system-invite-info?token=`（email 走
  `maskEmail` 掩码——泄漏的 token 不能还原完整地址）+
  `POST /api/auth/accept-system-invite`（限流 10/min/IP）：建号 → 加入目标
  workspace（带 role）→ 自动进 `#all` → 签发 JWT；audit `invite.accepted`。
- **对给定实现片段的三处必要偏离**（评审时注意）：
  1. **410 契约**：任务给的路由片段对 not_found 返回 404，但测试片段断言
     revoked（=硬删→not_found）accept 得 410，两者矛盾。按测试名
     "revoked/expired 410" 的意图统一：accept 端点对一切不可用 token
     （不存在/已撤销/过期/已用）返回 410，原因放 `code: invite_<status>`。
  2. **过期重邀 500 修复**：`system_invites_pending_email_uidx` 部分唯一索引只
     排除 accepted 行，过期的 pending 行仍占位——给定 dup 检查对过期 dup 不
     409，直接 insert 会撞索引 23505 → 500。修复：dup 为未接受且已过期时先硬
     删旧行再插入（与 schema 注释"撤销=硬删"一致），测试新增 inv2b 断言覆盖。
  3. **确定性**：`expiresInDays: 0.00001` ≈ 0.86s，本地回环一个往返大概率赶
     不上过期时刻 → 过期 accept 断言竞态。测试在 accept 前等 1.1s。
  另：expiresInDays 校验移到 dup 查询/删除之前（验证先于副作用）。

## 验证（证据）

- 基线：改动前 `npx tsx --test --test-force-exit src/server/systemAdmin.api.test.ts`
  → 2 pass。
- 红（Task 6）：新场景 `TypeError: Cannot read properties of undefined (reading 'find')`
  —— `/api/admin/users` 无路由，落 gate 2 400，`list.users` undefined。
- 红（Task 7）：`AssertionError: falsy: assert.ok(inv.invite?.token …)` ——
  POST `/api/admin/invites` 命中 Task 6 的 404 fallback。
- 绿：同命令 → 4 pass / 0 fail（复跑一次仍 4/4，时序断言稳定）。
- `npm run typecheck`（root + web）→ exit 0（测试片段一处 `unknown` 上取属性
  补了 `as any`，与文件既有模式一致）。
- CI 全量：`JWT_SECRET=ci-test-secret DAEMON_BOOTSTRAP_KEY=ci-test-bootstrap-key
  npx tsx --test --test-force-exit test/*.unit.test.ts src/daemon/*.test.ts
  web/src/views/*.test.ts` → 725 tests / 722 pass / 0 fail / 3 skip（既知 skip；
  codexRuntime Windows EPERM flake 未出现）。

## 文档同步（docs commit）

`ARCHITECTURE.md`（routes-api auth/admin 组 + systemAdminPolicy helper 行）、
`docs/authorization.md`（system plane 端点清单：users 自守卫、invites 410 契约、
masked email、404 fallback）。FEATURES.md / README 留给整平面收尾 doc 任务
（spec §9），与 batch B 口径一致。

## 评审修复（同日：`fix(admin): invite dup check must consider pending rows only`）

Spec 评审发现并复现的缺陷 + 2 项测试补强：

- **缺陷**：`POST /api/admin/invites` dup 检查 `where(eq(email))[0]` 无排序取
  第一行——同一 email 存在 accepted（旧）+ pending（新）两行时可能返回
  accepted 行 → 409 不触发 → insert 撞 `system_invites_pending_email_uidx`
  23505 → 500。修法：dup 查询加 `isNull(acceptedAt)` 只查 pending 行
  （`and(eq(email), isNull(acceptedAt))`），原「pending 未过期 → 409；
  pending 已过期 → 硬删重插」逻辑不变（`!dup.acceptedAt` 条件随过滤下沉
  移除）。
- **测试**：补回归场景——accepted 邀请存在时同 email 可再建 pending（200）；
  该 pending 仍活时再建 → 409（旧代码下复现 `500 !== 409`）。
- **测试**：410 三路径补 `code` 断言：used → `invite_used`、expired →
  `invite_expired`、revoked（not_found）→ `invite_not_found`。
- 证据：修复前红（`500 !== 409`）；修复后同命令连跑两次 4 pass / 0 fail；
  `npm run typecheck` → exit 0。

## 未验证 / 跳过

- 未跑浏览器 E2E（本批纯 REST，无 UI；dev:e2e 面向 agent runtime，不需要）。
- accept-system-invite 的并发竞态（两请求同 token 同时过 status 检查）未加锁
  ——第二个 insert 会撞 users.email 唯一索引报 500；与 register 既有模式相同
  （先查后插），限流 10/min 缓解，留待 hardening。
- reset-password 无自守卫（管理员重置自己仅无害冗余，JWT 不失效）。
