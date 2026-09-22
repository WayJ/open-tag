# 2026-09-22 — system-admin 平面 batch E（Task 10-13：前端 /admin 控制台 + /invite 落地页）

**分支**: `feature/system-admin`（worktree `open-tag-system-admin`）
**计划**: `docs/superpowers/plans/2026-09-22-system-admin-plane.md` §Task 10-13
**基线**: `4d22f2b`（batch D review follow-ups 之后）

## 需求

Batch E = 前端四件套：Task 10（adminGuard 纯函数 TDD + `/admin` 路由 +
`me.systemRole`）、Task 11（Admin 外壳 + Users/Settings 页签 + i18n）、Task 12
（Invites/Workspaces+stats/Audit 页签）、Task 13（Layout 入口 + `/invite/:token`
落地页 + 注册页门）。后端 API 面 batch A-D 已全部就绪。UI 的浏览器验证是
Task 14（下一批），本批门槛 = typecheck + 单测 + web build 全绿。

## Task 10 — adminGuard + 路由 + store（commit 8b80c39）

- TDD 红→绿：先写 `web/src/views/adminGuard.test.ts`（node:test 断言四种
  decision），跑一次确认 `ERR_MODULE_NOT_FOUND`（红），再实现
  `adminRouteDecision({ready, authState, systemRole})` → 绿。
- `main.tsx`：新 `AdminRoute` 组件（skeleton→`WorkspaceSkeleton`、anon→
  `/login`、authed 非管理员→回 `/s/:slug/channel`（保留 query）、sysadmin→
  `<Admin>`）；路由 `/admin` 与 `/admin/:section` 为顶层路由（在 `/s/:server`
  之前），`/invite/:token` → `SystemInvitePage`。
- `store.tsx`：`Me` 加 `systemRole?: string | null`（bootstrap 的
  `/api/auth/me` 已返回该字段，无需改请求）。
- 占位：`Admin.tsx` + `Auth.tsx` 里的 `SystemInvitePage` 先 return null，
  保证 typecheck 通过，后续 task 填实（最终无残留占位）。

## Task 11 — 外壳 + Users/Settings（commit c31dcb3）

- `Admin.tsx`：全屏 flex 布局（顶层路由，不在 workspace Layout 内）；页签由
  URL 驱动（`/admin/:section`），切换走 `useNavigate`（不是 pushState）；
  未知 section 落 users。`AdminApi` 类型从 Admin.tsx 导出，五个 tab 组件共用。
- `UsersTab`：搜索（回车）、禁用/启用、提/撤 sysadmin、重置密码；临时密码
  一次性弹窗（`TempPasswordModal`，Esc 可关，copyText 复制 + 已复制态）。
  服务端 self-guard（"cannot disable/demote yourself" 400）经 `form-err`
  显示——api() 对非 2xx 返回 `{error}` JSON 而不抛错，逐个 mutation 检查。
- `SettingsTab`：开放注册开关（GET/PATCH `/api/admin/settings`），翻转前
  confirm。**受控 checkbox 回弹**：取消 confirm / PATCH 被拒时 `open` 状态
  不变但 DOM 已被用户点开，用 `forceRender` 计数器触发重渲染让 React 把
  checkbox 拉回 `checked={open}`。
- 占位 Invites/Workspaces/Audit tab（本 commit 内 null 渲染，下一 commit 填实）。

## Task 12 — Invites/Workspaces/Audit（commit 362a28d）

- `InvitesTab`：复用 misc.tsx InvitesSettings 的 `.inv-new/.inv-list/.inv-item`
  样式族。表单（email + workspace select（`/api/admin/servers` 拉取并预选
  第一个）+ 角色 member/admin + 有效期天数默认 7）→ POST → 弹一次性链接
  弹窗（`${location.origin}${url}`，复制按钮）。列表行：状态徽章（复用
  `.inv-role` chip 样式）+ email + serverName/role/创建/到期；仅 pending 行
  显示复制链接与撤销（confirm danger）；409 重复邀请等错误进 `form-err`。
- `WorkspacesTab`：顶部 stats 卡（users total/禁用、servers、agents 活跃/总、
  machines 在线/总，复用 `.card`）+ workspace 表；删除 = confirm(danger) →
  DELETE → 刷新（含 stats）。不阻止删除 open-tag 本身（管理员的判断）。
- `AuditTab`：事件下拉（全部 + 后端 11 个 AuditEvent 原名）；表：时间/事件/
  actor/target（截断 8 位 id，title 悬停全量）/metadata（JSON.stringify 截断，
  title 全量）；「加载更多」用 `before=` = 末行 createdAt ISO 游标（后端
  `lt(createdAt)` 严格小于，同刻多行会跳——已知 I119 口径）。

## Task 13 — 入口 + /invite 落地页 + 注册门（commit 9c12605）

- `Layout.tsx` icon rail：settings 齿轮旁条件渲染 Shield 图标入口
  （`me?.systemRole === "system_admin"` 才显示），`nav("/admin")`，样式与
  兄弟项一致（`t im` + `t-label` 悬停标签 + title）。
- `Auth.tsx` `SystemInvitePage`（镜像 JoinPage，独立于 StoreProvider）：
  `system-invite-info` 拉取 → invalid 时无效面板 + 去登录链接；valid 时
  inviter 短语（`invitedBy`/`youAreInvited` 组合，沿用 JoinPage 模式）+
  掩码 email + 工作区 + 角色的简介，表单只要用户名+密码（email 由邀请
  固定，accept 接口从 link 取，不重收）→ `accept-system-invite` →
  `finishAuth(token, workspaceHome(token))`。410/409 错误码
  （`invite_used/expired/not_found/revoked`、`auth_register_*`）经
  `authErrorMessage` → `auth.errors.*` 翻译。
- 注册页门（UX only）：`AuthPage mode="register"` 挂载时 GET
  `/api/auth/config`；`openRegistration === false` 渲染关闭面板（说明 +
  去登录）；探测失败 fail-open（表单照常，服务端 403 仍是执法层）；
  探测期间显示 loading 卡（避免表单闪现后被换掉）。login 模式零改动。
- main.tsx 无需再动：Task 10 的 import 已指向 Auth.tsx 的真导出。

## 对任务给定片段的偏离（评审时注意）

1. **modal 类名**：片段里的 `modal-backdrop`/`modal` 实际是 `modal-bg`/`modal`
   （ConfirmModal/DaemonUpdateModal 同款），已对齐。
2. **`t("common.ok")` 不存在**：SettingsTab confirm 按钮改用 `t("confirm.confirm")`
   （zh「确认」/ en "Confirm"）。
3. **复制一律走 `copyText`**（lib/clipboard.ts，带 execCommand 回退），不用裸
   `navigator.clipboard`（非安全上下文会静默失败）——临时密码与邀请链接都如此。
4. **api() 错误形态**：store 的 api() 对非 2xx 不抛错、返回 `{error}` JSON——
   所有 tab 的 load/mutation 都检查 `r?.error` 并入 `form-err`，而不是 catch。
5. **Admin 页签条无现成类**：内联样式 + `var(--hair)`/`var(--ink-2)` 变量
   （无新 CSS 类；活跃页签下划线式）。表格同理（仓库无表格类，Members 是
   卡片列表）。
6. **inviteIntro 拆两段**：`{invitedBy|youAreInvited}{inviteIntro(email,
   serverName, role)}`——避免 inviterName 为 null 时出现「你被邀请 邀请你」。

## 验证（证据）

- 红（Task 10）：`npx tsx --test --test-force-exit web/src/views/adminGuard.test.ts`
  → ERR_MODULE_NOT_FOUND，1 fail。
- 绿（Task 10）：同命令 → 1 pass / 0 fail。
- 最终全量单测：`JWT_SECRET=ci-test-secret DAEMON_BOOTSTRAP_KEY=ci-test-bootstrap-key
  npx tsx --test --test-force-exit web/src/views/*.test.ts` → **6 tests /
  6 pass / 0 fail**（adminGuard 1 + 既有 projectDirectoryPickerPaths 5）。
- `npm run typecheck`（root + web 两 tsconfig）→ exit 0（每个 task 后各跑一次）。
- `npm --prefix web run build` → ✓ built（每个 task 后各跑一次；Task 13 后含
  landing prerender 正常）。
- locale 键奇偶校验：node 脚本 flatten 对比 zh/en 键集合 → 双向零缺失；
  `admin` 块各 80 键。
- zh/en JSON 均通过 JSON.parse（每次改后）。

## 已知问题 / 未验证

- **浏览器验证未跑**（Task 14，下一批）：守卫跳转、tab 切换、临时密码弹窗、
  邀请落地页闭环、注册关闭面板均未经真实浏览器过一遍。
- AuditTab actor/target 显示截断 id（不解析用户名/工作区名——需再拉
  `/api/admin/users` 建映射，暂保持最小实现，title 悬停有全量 id）。
- AuditTab `before` 游标与后端 I119 同口径：同一毫秒的多行可能跳行。
- SystemInvitePage 的 409 `auth_register_email_taken` 文案是「请直接登录」——
  对邀请场景略欠精确（既有账号无法 accept 系统邀请，属流程限制，非本批 UI
  能修）；文案含义（邮箱已注册）仍正确传达。
- api() 在「已登录但无 workspace」时会等 serverId 1.8s 才发请求（60×30ms
  循环）——sysadmin 无 workspace 的极端情况下 admin 页签首刷慢一点；admin
  端点本身不校验 x-server-id（gate 1.5 在 gate 2 之前），功能不受影响。
