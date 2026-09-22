# 2026-09-22 · 服务端分发 daemon bundle — UI 平台 tab 命令框（Task 3）

分支：feature/server-daemon-dist（worktree open-tag-server-daemon-dist）
计划：server-daemon-dist plan · Task 3（Task 1 server 端点 / Task 2 命令构造已合入）

## 内容

- 新增 `web/src/views/CommandTabs.tsx`：渲染 `DaemonCommandSet` —— `custom` 单 codebox；
  `platform` 双 tab（bash / PowerShell，复用现有 `seg-pill`/`seg-opt` 分段控件样式，UA 检测仅在
  mount 时一次）。复制按钮 + Copied 闪动 + `window.prompt` 回退由组件自持（原向导逻辑原样迁移）。
  接入向导（ConnectComputerWizard connect 步）与 DaemonUpdateModal 共用。
- `web/src/store.tsx`：新增 `daemonBundleAvailable: boolean`，与 `daemonCommandTemplate` 同路——
  reload 拉取与 socket `machine:status` 重取两处均 `!!mc.daemonBundleAvailable`。
- 两处视图改调 `daemonConnectCommands` / `daemonUpdateCommands`（Task 2 新签名，修掉 web tsc 仅剩的
  2 个红），删各自本地 copied/copy。
- machineUi.ts 折叠清理（Task 2 评审）：`renderDaemonCommand` 收紧为 `(template: string, ...)` 纯占位符
  替换（内部 blank→DEFAULT 死分支删除）；抽 `DaemonCommandOpts` 公共类型去重 3 处内联字面量。
- i18n：新增 `misc.cmdTabBash` / `misc.cmdTabPowershell`（en/zh 同文）；`computersNoMachineHint`
  改写——不再承诺 npm 下载，改为「拿到可直接运行的接入命令（需 Node.js ≥ 20）」。

## 验证

- `npx tsx --test --test-force-exit test/daemonConnectCommand.unit.test.ts test/machineUpdateGuide.unit.test.ts
  test/daemonBundle.unit.test.ts` → 14/14 pass。
- `npm run typecheck`（root + web 两个 tsc）→ exit 0。
- 本任务无新增可单测的纯逻辑（渲染组件）；浏览器 E2E 在 Task 6（fail loud，未在本任务验证）。
