# 2026-09-22 — system-admin 平面 batch F（Task 14 浏览器验证 + Task 15 文档收尾）

**分支**: `feature/system-admin`（worktree `open-tag-system-admin`）
**计划**: `docs/superpowers/plans/2026-09-22-system-admin-plane.md` §Task 14-15
**基线**: `3539abc`（batch E 评审跟进 + 验证期两项修复之后）

## Task 14 — 浏览器验证（real-run 层，10 场景）

隔离栈（`npm run dev:e2e:up`）+ 浏览器逐项验证，全部通过：

1. dev-login `?as=you` → 侧边栏出现「系统管理」入口（Shield 图标，仅
   `me.systemRole === "system_admin"` 渲染）。
2. 入口 → `/admin` 控制台加载；Users 页签列出 `you`（system_admin）。
   截图 `admin-users.png`。
3. Settings 页签关闭开放注册 → `/register` 渲染「注册已关闭」面板
   （UX 探测 `GET /api/auth/config`；服务端 403 才是执法层）。
4. Settings 重新开启 → `/register` 表单恢复。
5. Invites 页签创建邀请（email + open-tag workspace + member 角色，默认 7 天）
   → 一次性链接弹窗 + 复制（`/invite/<inv_…>`）。
6. 登出态打开邀请链接 → 用户名+密码表单 → accept → 建号成功、落进目标
   workspace、`#all` 可见。
7. Users 页签禁用该新用户 → 其旧 JWT 调 API 立即 401（REST gate 1 拒绝，
   30 天 JWT 即刻失效）。
8. 被禁用户重新登录 → 403 `auth_account_disabled`。
9. Audit 页签：上述全部动作都有行（`user.login` / `settings.open_registration_changed`
   ×2 / `invite.created` / `invite.accepted` / `user.disabled` …）。
   截图 `admin-audit.png`。
10. Workspaces 页签：stats 卡（users/servers/agents/machines）数字与实际一致；
    删除一个 scratch workspace 级联成功，列表与 stats 刷新。
    截图 `admin-workspaces.png`。

截图存 `.shots/`（gitignored，按惯例不入库）：`admin-users.png`、
`admin-audit.png`、`admin-workspaces.png`。

## 验证中发现并修复的两个问题（commit `3539abc`）

1. **SPA allowlist 漏 `/admin` 与 `/invite/:token`（硬刷新 404）**：
   `src/server/staticRoutes.ts` 只放行 `/`、`/features`、`/login`、`/register`、
   `/join/*`、`/s/*` —— 生产模式下直接打开或刷新 `/admin` / 邀请链接会 404
   （dev 模式 vite 兜底，单测没拦住）。补 allowlist，并新增
   `test/staticRoutes.unit.test.ts` 把每个顶层客户端路由钉死在 allowlist 里。
2. **dev-login 载荷缺 `systemRole`**：`?as=you` 的 me 对象没有 systemRole，
   store bootstrap 短路后 admin rail 不显示 —— sysadmin dev 会话看不到入口。
   dev-login 用户对象补 `systemRole`（对齐 `/api/auth/me` 的返回）。

## Task 15 — 文档收尾（本 commit）

- `docs/generated/db-schema.md`：users 两列（systemRole / disabledAt）+ 三新表
  （`system_settings`、`system_invites` 含 partial unique index
  `system_invites_pending_email_uidx`、`audit_logs` 含两索引）。
- `FEATURES.md`：新增 P8「System Admin Plane」五条勾选。
- `README.md`：Project status 补浏览器验证证据块；Quick start 后补
  `SYSTEM_ADMIN_EMAILS` 可选环境变量小节。
- `docs/PLANS.md`：Completed slice history 挂 spec + plan 索引条目（状态 done）。
- `docs/tech-debt-tracker.md`：新增 I122（codexRuntime 测试 Windows 并行全量
  偶发 EPERM，单跑绿，与本特性无关）。

（`ARCHITECTURE.md` 与 `docs/authorization.md` 已由 batch B/C/D 随批同步，本批核对无缺口。）

## 平面总结（batch A–F，commits `ef13bb5..3539abc`）

- **A**（`5261a89`→`9de3fe0`）：schema（users 两列 + 三表）、
  `systemAdminPolicy` 纯函数、settings KV + `SYSTEM_ADMIN_EMAILS` 启动提升、
  audit 助手、seed 标 owner 为 system_admin。顺带修既有测试漂移
  clipboardFallback（`a2f6d34`，CommandTabs 抽取 `8f63c68` 的跟进，与本特性无关）。
- **B**（`6041bee`/`54bcbd9`）：`resolveActiveUser` 三入口禁用执行（REST gate 1 /
  socket.io / 公共附件 token 路径）、login 403、`me.systemRole`、注册门 +
  `/api/auth/config` + admin settings toggle + 审计、gate 1.5 shell。
- **C**（`8ee162e`/`be8880d`）：用户管理端点（列表 / 禁用 / 角色 / 重置密码 +
  自守卫）、系统邀请管理端 + 公共 info/accept（统一 410 契约、过期重邀 500 修复）。
- **D**（`88eefc1`/`f4eeb74`）：workspace 列表 + 硬级联删除（全子表 FK 枚举 +
  `SERVER_DELETE_TABLES` 反射元测试保穷尽）、stats、audit-logs 查询；
  `SYSTEM_ADMIN_EMAILS` 幂等 / 只提升测试。
- **E**（`8b80c39`→`0e1af66`）：前端全套 —— adminGuard（TDD）、`/admin` 外壳 +
  五页签、rail 入口、`/invite/:token` 落地页、注册页门、i18n（zh/en admin 块
  各 80 键）+ 评审跟进。
- **F**（`3539abc` + 本 commit）：浏览器验证 10 场景 + 两个验证期修复 + 文档收尾。

每批均 typecheck（root + web）+ 对应测试层绿后提交；过程中的 tech-debt
I114-I121 已随批记录（本批补 I122）。**daemon 零改动 —— 无 daemon 发版项。**

## 已知问题 / 未验证

- AuditTab actor/target 显示截断 id（用户名/工作区名未解析）；
  audit 游标同刻多行可能跳行（I119 口径，已知）。
- SystemInvitePage 对「邮箱已注册」的 409 文案略欠精确（batch E 已记录，流程限制）。
- socket.io / 公共附件路径的禁用行为无专门浏览器 e2e —— 与 REST gate 1 同源
  `resolveActiveUser`，API 层已测。
