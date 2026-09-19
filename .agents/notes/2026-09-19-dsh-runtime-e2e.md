# 2026-09-19 · dsh Runtime E2E 验证 + 文档同步（E3）

分支：feature/dsh-runtime（worktree open-tag-dsh-runtime）
范围：E2E 收尾 + doc-sync（ARCHITECTURE / FEATURES / README / tech-debt）+ daemon 0.17.0 版本准备

## E2E 验证了什么（全部当日、本 worktree 隔离栈实测）

- **UI 创建 dsh agent**：运行时下拉出现 DeepSeek Harness；模型下拉经 ACP
  `configOptions` 实时探测出 16 个模型（provider 分组）。
- **双向链路确认两次**：@mention → agent 唤醒 → 真实 LLM 回合
  （zai-coding-cn / glm-5.3）→ 回复落进频道。
- **Activity 轨迹渲染**：thinking → working → online 全程在 UI 呈现。
- **跨重启会话恢复**：重启 daemon 后再次唤醒，日志出现
  `agent started resume:true`，会话延续。
- **单元测试**：56+ 测试文件全绿（含 dshRuntime 纯函数/集成、listModels-dsh 探测）。
- **fake-dsh 集成测试覆盖**：握手、鉴权失败、串行投递、tool 去重、permission
  应答、stop 时序。

## E2E 过程中修了什么

- **模型探测 Windows .cmd 解析**：裸 `spawn()` 打不开 npm 的 `.cmd` shim
  （ENOENT）→ 探测路径改走 `spawnSafe`（85f22fd）。通用 `runList` 驱动仍带同样
  的潜在问题 → tech-debt I110。
- **初始 admission 语义**：原实现等 `session/prompt` 响应（turn 结束）才收
  initial admission，真实 agentic 首回合超过 agentManager 的 3 分钟
  START_ADMISSION_TIMEOUT，健康会话被重启循环 → 改为首个 `session/update`
  即收（4126ffd）。
- **重复 daemon 实例污染 WS**：up/down 循环泄漏的僵尸 daemon 抢占同一
  machineId 的连接槽（1005 振荡）→ 清理进程树后恢复（既有 harness 问题，
  tech-debt 已有记录）。

## 明确跳过的（fail-loud）

- **每回合动态切换模型（live）**：仅单元覆盖（`session/set_config_option`
  解析/去重/未提供值跳过）；E2E 未在真实回合中途换模型。
- **Landing 页引擎图标**：dsh 未加落地页图标（先例：hermes/reasonix 同样未加）。
- **dsh 默认 provider `deepseek-official` 端到端**：本地无对应 API key，改用
  zai-coding-cn / glm-5.3 验证全链路；默认 provider 路径仅代码审查覆盖。

## dsh-bot 自审发现（记录待分诊 → tech-debt I112）

1. 服务端重启后，活跃 agent 无 token 重铸路径（与 I92 同类）。
2. 永久卡死的投递 admission 无自动恢复（与 I96 同类，刻意的防重复偏向）。
3. daemon 注入的 `OPEN_TAG_*` 环境变量对 dsh agent 的 tool 子进程不可见
   （ACP server 拥有进程树，env 不穿透）。

## 本次（E3）文档同步内容

- `ARCHITECTURE.md`：`runtimes.ts` 条目加入 dsh 双条件检测、九→十适配器；
  新增 `dshRuntime.ts` 条目（`listModels.ts` 的 dsh 探测描述 D4 已写准，未动）。
- `FEATURES.md`：P2 新增 dsh runtime 勾选项；P6 动态模型发现句更新（dsh 走
  ACP configOptions；copilot/kimi 仍静态，dsh 为 ACP 先例）。
- `README.md`：Supported runtimes 表加 dsh 行 + dsh 运行前置说明
  （opentag profile 配置命令 + `~/.dsh/.credentials.yaml`）；roadmap 注更新；
  Prerequisites 加 `dsh`；Project status 下加实测证据块。
- `docs/tech-debt-tracker.md`：新开 2026-09-19 小节 + 表格 I108–I112。
- `CHANGELOG.md`：dsh 条目从 [Unreleased] 移入新 `## [0.17.0] - 2026-09-19`
  （Keep-a-Changelog），补 runtime 主条目 + .cmd 探测修复。
- `packages/daemon/package.json`：0.15.1 → **0.17.0**（新 runtime = minor；
  注意 main 本地已有未发布的 0.16.0 bump（a7b3598），故直接取 0.17.0 避免
  合并冲突/版本撞号）。**发布时**仍需走 GitHub Release 触发
  publish-daemon.yml（merged ≠ shipped）。

## 验证

- `npm run typecheck`（根）通过（本提交仅文档 + package.json 版本号，无代码）。
