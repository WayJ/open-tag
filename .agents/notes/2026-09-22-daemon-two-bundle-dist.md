# 2026-09-22 · 服务端分发 daemon bundle — 两件套分发（Task 2.5，插入于 Task 3 后）

分支：feature/server-daemon-dist（worktree open-tag-server-daemon-dist）
计划：server-daemon-dist plan ·「命令形态」2026-09-22 修订节（Task 1–3 已合入）

## 背景

bundled daemon 在运行时把 agent 侧 CLI 解析为同目录 sibling `agent-cli.mjs`（src/daemon/openTagBin.ts:15-24）。
此前只分发 `cli.mjs` 单文件 → 目标机缺 sibling → 回退 repo 模式（npx tsx，无仓库）→ agent 的 `open-tag` 命令坏。
npm 包能工作正因两文件同 ship 一个 dist/；服务端单文件下载必须把两个文件取到同一目录。未动 src/daemon/**。

## 内容

- `src/server/daemonBundle.ts`：新增 `DAEMON_BUNDLE_DIR` / `DAEMON_AGENT_CLI_PATH`（同目录 sibling）；
  `DaemonBundleKind`（"cli" | "agent-cli"）+ `daemonBundlePath(which)` 映射；`serveDaemonBundle(res, which, head)`
  按类分发（内部仍走 `serveDaemonBundleFrom` 测试缝，headers/404 行为不变）；`daemonBundleExists(baseDir)`
  改为可注入且**两文件都在**才 true（半套 = 不可分发）。
- `src/server/index.ts`：dispatch 扩为 `/daemon/cli.mjs` + `/daemon/agent-cli.mjs` 双路径（GET+HEAD）。
- `web/src/machineUi.ts`：`BUNDLE_CMD_BASH` / `BUNDLE_CMD_POWERSHELL` 改为两件套一键命令——
  bash `mkdir -p /tmp/open-tag && curl cli.mjs && curl agent-cli.mjs && node cli.mjs …`；
  PowerShell `New-Item -Force -ItemType Directory $env:TEMP\open-tag | Out-Null; 两次 Invoke-WebRequest; node …`。
  两文件落同一目录（sibling 要求）。

## 验证

- TDD：先红后绿。`test/daemonBundle.unit.test.ts` 重写（exists 矩阵：双真/缺任一假/空假；agent-cli 服务行为；
  默认路径 sibling 同目录断言；`daemonBundlePath` 映射）；两命令测试改新字符串（全串 deepEqual）。
- `npx tsx --test --test-force-exit test/daemonBundle.unit.test.ts test/daemonConnectCommand.unit.test.ts
  test/machineUpdateGuide.unit.test.ts` → 17/17 pass。
- `npm run typecheck`（root + web）→ exit 0。
- 真实冒烟（worktree 已构建 packages/daemon/dist）：`daemonBundleExists()` = true；GET cli 200/395288B、
  GET agent-cli 200/140440B（content-length 均与盘上文件一致）；HEAD 双 200 空 body 带正确 content-length。
- 未验证（fail loud）：浏览器端到端（Task 6 统一活栈验证）；目标机真实双文件下载后运行。
