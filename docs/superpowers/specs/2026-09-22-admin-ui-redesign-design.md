# /admin 控制台视觉重构设计（Admin Console UI Redesign）

日期：2026-09-22
状态：已与需求方逐项确认（方向 mockup 三选一 → B；侧栏配色 → B2 浅色；行操作 → ⋯ 菜单；实现方式 → 纯 CSS 无依赖）

## 1. 背景与目标

系统管理平面（`/admin`，功能已完成并验证）目前视觉为功能优先：inline style + 拼用主应用类，密度与层次未经设计。本次为**纯视觉/交互重构**：后端 API、数据机制、路由守卫、i18n 机制全部不动（users 统计卡新增一次已有端点 fetch 为唯一豁免，见 §5）；仅改 `web/src/views/admin/*`、`web/src/views/Admin.tsx`、`web/src/styles.css`（及 zh/en locale 增量 key）。

已确认的设计决策（mockup 评审记录在 `.superpowers/brainstorm/manual/`，gitignored）：

| 决策点 | 结论 |
|---|---|
| 设计方向 | **B · 现代 SaaS 控制台**（Linear/Vercel 式：侧栏导航 + 统计卡 + 高密度表格） |
| 侧栏配色 | **B2 · 浅色侧栏**（与主应用同暖灰画布 `--canvas-soft`，选中项墨色实底反白） |
| 行操作 | **⋯ 菜单**（替代 3 按钮常显；危险项红字 + 分隔线） |
| 实现方式 | **纯 CSS 设计系统升级**，零新依赖，复用现有 CSS 变量 |

## 2. 布局与导航（Admin.tsx 重构）

双栏布局，替换现有 inline style 外壳：

```
┌─────────────┬──────────────────────────────────┐
│ 侧栏 200px   │ 内容区（--canvas 底）               │
│ ◧ open-tag  │ ┌ 页头行：标题 + 主操作按钮 ──────┐ │
│   系统管理    │ ├ [统计卡行（该页有则显示）]      │ │
│ 管理         │ ├ 内容卡（白底/hairline/shadow-1  │ │
│  ◉ 用户      │ │  /8px 圆角）                   │ │
│  ✉ 邀请      │ └───────────────────────────────┘ │
│  ▦ Workspaces│                                   │
│  ≡ 审计日志  │                                   │
│  ⚙ 设置      │                                   │
│ ─────────    │                                   │
│  ↩ 返回工作区 │                                   │
│  ● You·管理员 │                                   │
└─────────────┴──────────────────────────────────┘
```

- 侧栏：`--canvas-soft` 底 + 右侧 1px hairline；分组小标签「管理」；导航项沿用路由参数驱动（`/admin/:section`），选中态 = 墨色（`--ink`）实底 + 反白，hover = `--surface-strong`
- 底部固定两行：「返回工作区」（`nav('/s/:slug/channel')`）+ 当前管理员身份（头像点 + displayName）
- 内容区每页签统一节奏：**页头行（标题 + 主操作）→ 统计卡行（可选）→ 内容卡**
- 响应式 ≤768px：侧栏折叠为顶部横向页签（同一组导航项，不做抽屉）

## 3. 新组件（均在 `web/src/views/admin/`）

| 组件 | 职责 | 接口要点 |
|---|---|---|
| `RowMenu.tsx` | ⋯ 按钮 + 绝对定位浮层菜单 | items: `{label, danger?, onClick}[]`；外点/Esc 关闭；打开时唯一（打开新菜单关旧菜单）；z-index 高于表格 |
| `StatCard.tsx` | 统计卡 | `{label, value, note?}` |
| `AdmPill.tsx` | 状态胶囊 | `{tone: "green"\|"red"\|"blue"\|"neutral", children}`，色值取 tint 板 |
| `AdminTable.tsx` | 表格薄封装 | 统一 thead（小号大写灰）、行 hover、空态、右对齐列支持；children 传 rows |

弹窗仅剩**临时密码**一处（users 页），保留现有 `modal-bg`/`modal` 结构，仅打磨内边距/宽度（类：`adm-modal`）；邀请创建的 `CreatedInviteModal` **删除**——邀请整条流内联化（见 §4 invites）。confirm 流程（`useConfirm`）不动。

## 4. 各页签规格

### users
- 页头：标题「用户」+ 搜索框（右）+ 主按钮「＋ 邀请用户」（跳 `/admin/invites`）
- 统计卡行 4 张（`/api/admin/stats`）：用户总数 / 已禁用 / 系统管理员 / Workspaces
- 表格列：头像圆点（email 首字母，tint 色按 email hash 取 `--g-mint/lav/sky/peach`）+ email · 系统角色（AdmPill blue=系统管理员 / —）· 状态（green 正常 / red 已禁用）· WS 数 · 加入时间 · ⋯ 菜单
- ⋯ 菜单项：禁用/启用、撤销/设为管理员（confirm）、重置密码（confirm）——逻辑与现状一致，仅收纳进菜单

### invites
- 页头主按钮「＋ 生成邀请」→ 展开**内联表单卡**（非弹窗）：email、workspace 下拉、角色、有效期；提交成功在表单卡内显示**内联链接卡**（完整链接 + 复制按钮，沿用 copyText；1.5s「已复制」反馈），`CreatedInviteModal` 删除
- 列表行：email · workspace · 角色 · 状态 pill（pending=blue / accepted=green / expired=neutral）· 创建/到期 · ⋯（pending：复制链接、撤销(danger)）

### workspaces
- 统计卡行（现 stats 四卡迁入页头下）+ 表格：名称 · slug · 所有者 · 成员 · Agents · 创建时间 · ⋯（删除，danger + confirm）

### audit
- 事件过滤下拉移入页头右侧；表格：时间 · 事件（等宽字体小标签）· 操作者/目标（截断 + title）· metadata（等宽、单行截断）
- 「加载更多」居中按钮，行为不变（createdAt 游标）

### settings
- 设置卡：每行 = label + 说明 + 控件；开放注册开关行保留 confirm + 回弹逻辑，视觉对齐新系统

## 5. 样式架构

- `styles.css` 末尾新增一段 `/* ── admin console (B2 light sidebar SaaS) ── */`，全部类名 `adm-` 前缀，预计 150-200 行
- 仅新增 2 个变量：`--adm-side-w: 200px`、`--adm-r: 8px`；其余全部引用现有 token（`--canvas/--canvas-soft/--surface/--surface-strong/--ink/--body/--muted/--hair/--shadow-1/--tint-*/--g-*`）。注：green pill 文字色用现有 `--success`（tint-green 无配套 -ink 变体）
- users 页统计卡新增一次 `GET /api/admin/stats` 请求（UsersTab 现无此调用）——数据层不重构、不加端点，仅多一个已有端点的 fetch
- 现有 admin 组件里的 inline style 全部迁入 `adm-` 类并删除

## 6. i18n

新增 key（zh/en 同步）：`admin.backToWorkspace`（返回工作区）、`admin.navGroup`（侧栏分组「管理」）、`admin.menu.*`（⋯ 菜单项：禁用用户/启用用户/设为系统管理员/撤销系统管理员/重置密码/复制链接/撤销邀请/删除 workspace）、`admin.users.inviteCta`（＋ 邀请用户）、`admin.stats.totalUsers`（用户总数）、`admin.stats.disabledUsers`（已禁用）、`admin.invites.createCta`（＋ 生成邀请）。「系统管理员」复用 `admin.users.sysAdmin`、「Workspaces」复用 `admin.workspaces.statsServers`。已有 key 复用，不改语义。

## 7. 验证

- `npm run typecheck` + `npm --prefix web run build` + 现有 web 单测全绿（`adminGuard.test.ts` 等不受影响——纯视觉重构，路由与数据逻辑零改动）
- 浏览器走查（chrome-devtools/Playwright + 截图 `.shots/`）：5 页签新貌、⋯ 菜单开合/外点关闭、confirm 弹窗、临时密码弹窗、邀请内联表单→成功链接卡、≤768px 折叠布局、zh/en 双语抽查
- 无障碍抽查：菜单键盘可达（Esc/Tab）、按钮 aria-label

## 8. 非目标（YAGNI）

- 不引组件库/动画库；不加暗色模式；不做侧栏可折叠/抽屉
- 不动后端任何端点、不动路由守卫逻辑、不重构数据层（users 统计卡仅新增一次已有端点的 fetch，见 §5）
- 不做主应用（工作区）其他页面的视觉统一——仅 `/admin`
- 无新增单测目标（纯样式；RowMenu 交互由浏览器走查覆盖）
