# 2026-09-22 — system-admin 平面 batch B（Task 4-5：禁用执行点 + 注册门 + admin settings）

**分支**: `feature/system-admin`（worktree `open-tag-system-admin`）
**设计**: `docs/superpowers/specs/2026-09-22-system-admin-plane-design.md` §4-§5

## 需求

Batch B = Task 4（resolveActiveUser + 禁用执行点 + me.systemRole）与 Task 5（注册门 +
`/api/auth/config` + admin settings + 审计）。全部 TDD（红→绿），逐 task 提交。

## Task 4 — 禁用执行点（commit 6041bee）

- `src/server/auth.ts`：新增 `resolveActiveUser(token)` —— JWT 校验 → 活用户行 → 拒
  `disabledAt`；返回 `{id, systemRole}` 供 admin gate 复用（免二次查询）。
- 执行点接入（disabled 用户即刻失去全部访问，含已签发的 30d JWT）：
  - REST gate 1（`routes-api/index.ts`）
  - socket.io 握手（`socketio.ts`，connection 回调本就 async）
  - 公共附件 token 路径（`routes-api/attachments.ts` handlePublicAttachmentGet）
- 登录口：密码验证通过后 `403 auth_account_disabled`（`routes-api/auth.ts`）。
- `GET /api/auth/me` 增加 `systemRole`（null 安全）。
- 新建 `routes-api/admin.ts`（gate 1.5 shell：非 system_admin → 403）。
- 测试 `src/server/systemAdmin.api.test.ts`（真实 server + 直插 DB 用户）。

## Task 5 — 注册门 + settings（commit 54bcbd9）

- register：rate-limit 后插入注册门 —— `registrationDecision(count, openRegistration)`，
  reject → `403 auth_registration_closed`；bootstrap（空表首注册者）→ 插入行带
  `systemRole="system_admin"`；注册成功 `logAudit("user.registered", …)`。
- 登录成功 `logAudit("user.login", …)`（带 ip）。
- 公共 `GET /api/auth/config`（gate 0，UX-only 探针；403 仍是唯一 enforcement）。
- `/api/admin/settings` GET / PATCH（gate 1.5 内）：PATCH 校验 boolean、写 KV
  `setOpenRegistration`、`logAudit("settings.open_registration_changed", {from,to})`。

## 验证（证据）

- 红灯（Task 4）：`me` 无 systemRole —— `AssertionError: + undefined - 'system_admin'`；
  红灯（Task 5）：`/api/auth/config` 不存在 —— `+ undefined - true`。
- 绿灯：`JWT_SECRET=ci-test-secret DAEMON_BOOTSTRAP_KEY=ci-test-bootstrap-key npx tsx --test
  --test-force-exit src/server/systemAdmin.api.test.ts` → 2 pass / 0 fail。
- `npm run typecheck`（root + web）→ exit 0。
- CI 全量：`npx tsx --test --test-force-exit test/*.unit.test.ts src/daemon/*.test.ts
  web/src/views/*.test.ts` → 725 tests / 722 pass / 0 fail / 3 skip（既知 skip）。
- 既有回归排查：`agentLifecycle` / `projectDirectory` api 测试通过；`replyCoordination` /
  `conversationTurns` 两文件在 **base commit 9de3fe0 上同样失败**（DM 非规范名被
  `classifyAgentDm` 判 invalid → 403 forbidden）—— 与本 batch 无关，已记
  `docs/tech-debt-tracker.md` I114。

## 文档同步（同 batch commit）

`ARCHITECTURE.md`（routes-api gate 列表 + auth.ts + 系统平面模块行）、
`docs/authorization.md`（human 平面校验者、公共端点清单、enforcement order 步骤 1、
system plane 段落）。FEATURES.md / README / db-schema.md 留给整平面收尾的 doc 任务
（spec §9），见 batch B 报告。

## 未验证 / 跳过

- 未跑真实浏览器 E2E（本批纯 REST；`dev:e2e` 栈面向 agent runtime，任务说明判为不需要）。
- socket.io / 附件路径的禁用行为无专门 e2e（代码路径与 REST gate 同源
  `resolveActiveUser`；REST 侧已测）。
