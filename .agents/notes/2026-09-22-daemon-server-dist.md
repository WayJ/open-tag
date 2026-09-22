# 2026-09-22 — daemon 由 server 分发（去 npm 连接命令）

**分支**: `feature/server-daemon-dist`（worktree `open-tag-server-daemon-dist`）
**计划**: `docs/superpowers/plans/2026-09-22-daemon-server-distribution.md`

## 需求

连接/重连/更新 daemon 的命令不再依赖 npm（`npx @fancyboi999/open-tag-daemon@latest`）或本地
repo（`npx tsx …/src/daemon/index.ts`）—— 目标机器直接从本 server 拿 daemon。

## 方案演进（两次用户修正）

1. **v1 单 bundle**：`GET /daemon/cli.mjs` + 平台一键命令（curl/Invoke-WebRequest 两行下载）。
2. **v1.5 双 bundle**：发现 `openTagBin.ts:15-24` 在 bundled 模式找同目录 sibling
   `agent-cli.mjs` 作 agent 侧 CLI —— 只发 cli.mjs 会让目标机回退 repo 模式（无仓库 → agent 的
   `open-tag` 命令坏）。补 `GET /daemon/agent-cli.mjs`，命令变 mkdir + 2×curl + node。
3. **v2 安装脚本端点（最终）**：用户反馈命令太长。server 按查询参数生成安装脚本，
   命令缩成一行 pipe：
   - bash: `curl -fsSL "{origin}/daemon/install.sh?server={origin}&key={key}" | bash`
   - PowerShell: `iwr -useb "{origin}/daemon/install.ps1?server={origin}&key={key}" | iex`
   脚本把两个 bundle 装到稳定目录 `~/.open-tag/daemon`（sibling 布局）再启动 daemon。

## 落地内容

- `src/server/daemonBundle.ts`：4 个公开端点（cli.mjs / agent-cli.mjs GET+HEAD `no-cache`
  + content-length；install.sh / install.ps1 GET `no-store`、缺参 400）；`shQuote`/`psQuote`
  转义；`daemonBundleExists` = 双文件都在；非 ENOENT 读取错误 warn。
- `GET /api/servers/:id/machines` 增加 `daemonBundleAvailable`（store 两处解析点都挂）。
- web：`DaemonCommandSet`（custom | platform）+ `daemonConnectCommands`/`daemonUpdateCommands`
  （template > bundle > npx 回退）；`CommandTabs` 平台 tab 组件；向导 + 更新弹窗接入；
  locales 去 npx 文案。
- 部署：Dockerfile build 阶段 `pkg:daemon:build` + runtime COPY dist；`prod-up.sh` 同步。
- 不动 `src/daemon/**` → 无 daemon 发版；无 DB 变更。

## 验证证据

- 单测 24/24（daemonBundle + 两命令测试，含引号注入、400、HEAD、双文件矩阵）。
- `npm run typecheck`（root+web）干净。
- Docker 构建实跑：镜像内双 bundle 存在、`node cli.mjs --help` 正常、路径解析命中。
- 活栈 E2E（worktree 7801）：四端点 curl 全 200（脚本 `no-store`、bundle shebang、缺参 400）；
  bundle 目录改名 → 404 + 修复提示 → 恢复 200（回退路径成立）；
  浏览器向导双 tab + 真实 key 内嵌；**逐字执行 bash 一行命令 → daemon 上线
  （`online · daemon 0.18.0`，runtimes 探测到 claude/dsh）→ 向导自动进入 Connected**。
  截图：`.shots/e2e-wizard-tabs.png`、`.shots/e2e-connected.png`。
- key 不落 server 日志（实测 grep = 0；index.ts 只记 pathname）。

## 已知取舍

- key 出现在 install 脚本 URL 查询串（与 UI 明文展示同级；`no-store`；自托管场景接受）。
- dev 用 tsx 起 server 且未跑 `pkg:daemon:build` 时端点 404、UI 回退 npx 命令（有意保留）。
- `AGENTS.zh.md`（主 checkout 未跟踪文件）已同步 CMD_TEMPLATE 措辞，留维护者单独提交。

## 提交链

8225a4d → bbb7019 → 11fd71f → 7d0e32f → 8f63c68 → 76bbd06/6244199 → c8e6f6c/adc5bbd →
f4c7e6a → 2ab8854 → f86a861 →（本提交）
