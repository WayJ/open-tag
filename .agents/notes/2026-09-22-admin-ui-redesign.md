# /admin 控制台视觉重构 · 走查与收尾（Task 8-9）

日期：2026-09-22 · worktree `open-tag-admin-ui`（branch `feature/admin-ui`，基线本地 main `82c7a46`）

## 决策链（brainstorming，mockup 见 `.superpowers/brainstorm/manual/`，gitignored）

方向三选一 → **B 现代 SaaS 控制台**；侧栏配色 → **B2 浅色**（同主应用暖灰画布，墨色实底选中）；行操作 → **⋯ 菜单**（替代 3 按钮常显）；实现 → **纯 CSS 零依赖**。spec 2 轮评审、plan 2 轮评审（基线 rebase 问题被评审员抓出）。

## 分批实现（每批 spec + quality 双评审 + 修复回环）

| 批 | commits | 内容 |
|---|---|---|
| A | `42ba617` `c4ed4f0` `8cf192d` `59777e7` | avatar 纯函数（TDD）；`adm-` CSS 段 + RowMenu/StatCard/AdmPill/AdminTable；评审跟进（.sec 冲突改名、锚点下划线、tone 归一化） |
| B | `6f08967` `86d1ce1` `1d4459c` `e3a3564` | B2 双栏壳（lucide 图标 + 返回工作区 + 身份行）；users（统计卡 + 头像列 + ⋯）；invites 内联化（删 CreatedInviteModal）；卡片圆角出血修复 |
| C | `7b3d2d3` `af49976` `d9374eb` `2ef3d6b` `0696934` | workspaces/audit/settings 迁入；i18n 收尾（孤儿 key 清理 ×8）；评审跟进（note 色、aria-label 补齐、.adm-mono/.adm .loadmore 收编）；移动端 nav 横向化 |

## Task 8 浏览器走查（真实栈：worktree server 7801 + built web + `?as=you`）

8/8 通过，截图存主仓 `.shots/`：

| # | 项 | 证据 |
|---|---|---|
| 1 | users 页全貌（侧栏/统计卡/头像列/⋯） | `adminui-users.png` |
| 2 | ⋯ 菜单开合 + Esc 关闭 + 外点 | DOM 断言（menu/separator/aria-expanded → Esc 后消失） |
| 3 | 重置密码 → danger confirm → 临时密码弹窗（adm-modal + code + 复制） | 走查记录（真实触发 `you`，dev-login 不依赖密码） |
| 4 | 邀请内联表单（4 控件 aria 齐、提交按钮条件禁用）→ 链接卡 | `adminui-invites.png` |
| 5 | workspaces 统计卡 + 表 + audit 过滤/等宽/截断 | `adminui-workspaces.png` `adminui-audit.png` |
| 6 | settings 开关行（confirm 逻辑未动） | `adminui-settings.png` |
| 7 | 375px 折叠 | `adminui-mobile-375-fixed.png`（DOM：5 链接同 top=8、left 递增 12→375、nav 可横滚） |
| 8 | en 语言全英文无裸 key | `adminui-en.png` |

### 走查抓出的真 bug（已修 `0696934`）

375px 侧栏未横向折叠：`.adm-side` 转 row 只作用于直接子级 `[logo, .adm-sec, nav, .foot]`，`nav` 内链接仍纵向堆叠（实测盒模型 left 全 12、top 递增）。修 = 媒体查询内 `.adm-side nav { display:flex; flex-direction:row; gap:2px; overflow-x:auto }`。教训：视觉模型第一次误报「未折叠」、DOM 又给出矛盾的 computed style（测了容器没测子级），最后以子级盒模型定案——**布局断言要量叶子盒子，不要只读 computed style**。

### 环境坑（记录备查）

- worktree DB 由 wt:add 在 rebase **前**建：旧 schema 缺 `system_role` 列 → server boot 时 env 提升静默失败（log 有 ERROR）、dev-login 500。修 = `npm run db:push` 后**重启**服务（迁移后重启才是正确部署序）。
- 本地 main 之后又有新提交（`24cc1eb`），合并前需 rebase。

## Task 9 终验

typecheck（root+web）0 错；`web/src/views/*.test.ts` 8/8；`npm --prefix web run build` 绿；zh/en 739/739 键位平价；`git diff 82c7a46..HEAD -- src/` 为空（后端零改动）。

## 已知取舍（不阻塞）

- 底行 ⋯ 菜单向下开、撑长滚动区（.adm-main overflow:auto 兜底，未做翻转定位——单 admin 表行数少，YAGNI）
- audit 过滤切换在途请求可能乱序追加（继承自旧实现，tech-debt I-级未立，量小）
- SettingsTab 加载失败态无页头（保留旧逻辑的早退；五个 tab 中唯一）
