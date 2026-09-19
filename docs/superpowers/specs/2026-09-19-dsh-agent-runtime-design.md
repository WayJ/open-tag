# open-tag × DeepSeek Harness：dsh agent runtime 接入设计

- 日期：2026-09-19
- 状态：待评审
- 范围：两个仓库、两个交付物（open-tag 新 runtime + dsh-work 新插件）
- 关联：`docs/tech-debt-tracker.md` I39（ACP probe / 模型发现）、`.agents/notes/2026-09-19-dsh-requirement-system-prompt-file.md`（早期需求草稿，本文取代其技术方案部分）

## 1. 背景与目标

open-tag 的 agent runtime 面向多 harness（claude/codex/copilot/kimi/opencode/pi/cursor/hermes/reasonix 共 9 个）。目标：新增第 10 个 runtime —— DeepSeek Harness（`dsh`），使 open-tag daemon 能像驱动 claude 一样驱动 dsh agent：持久 teammate、wake/sleep 生命周期、跨重启 resume、模型/effort 可选、轨迹流回 UI。

**硬约束：不改 deepseek-harness 源码**（git submodule 隔离）。dsh 侧一切能力以 out-of-tree 插件交付。

## 2. 关键决策（含已否决方案）

| # | 决策 | 否决的替代 | 理由 |
|---|---|---|---|
| D1 | 通信基于**标准 ACP v1**（JSON-RPC over stdio），不改协议、不分叉版本号 | 完全自定义协议；ACP + `protocolVersion: 2` 分叉 | `session/new` 响应自带 config options（活模型目录），`set_config_option` 选 model/effort，`session/resume` 续会话 —— 标准面已覆盖全部需求；分叉版本号零收益、失去标准客户端互操作。将来真有缺口走 LSP 式 `opentag/*` 附加方法 |
| D2 | dsh 侧交付物 = **独立插件 `dsh-opentag-agent-runtime`**，自带**派生版 ACP server** | 给 dsh-acp 打运行时补丁挂方法；给 dsh 上游提 PR | dsh-acp 的 JSON-RPC app 封闭在其 `apply()` 内部，无导出扩展点；运行时拦截脆弱（dsh 是 developer preview）。派生（MIT，import 同批内部服务 `agents`/`sessions`/`llm`/`sessionPersistence` + ACP SDK）自包含、确定性 |
| D3 | system prompt 经**协议调用参数**注入（`opentag/setSystemPrompt`），一次性、进程级不可变 | env 文件路径；AGENTS.md 注入；envelope 包进首条消息 | 调用参数无长度限制（argv 撞 Windows ~32K 上限）；不落盘不进 env（不扩散进子进程 environ）；进程内不可变 = 对齐 claude runtime `--append-system-prompt` 的既有语义（open-tag 每次 wake 重新 spawn，prompt 每次 spawn 现算，动态性发生在 wake 粒度） |
| D4 | 注入接口**仅允许本机 daemon 调用**：per-spawn 随机 token 握手 | 无鉴权；公网监听 | 主边界是 OS（stdio 管道句柄仅父进程持有）；token 是纵深防御 + 显式契约。不防本机可起进程的攻击者（机器信任边界，与现有 9 runtime 同立场） |
| D5 | 专用 profile **`opentag`**（从 acp 模板派生），插件装在其中 | 装进用户 `acp` profile | 与用户自己的 acp 自动化隔离；open-tag 探测 `$DSH_HOME/profiles/opentag` 存在即知能力可用 |
| D6 | **无 envelope 兜底阶段** | 先 envelope 跑通再切注入 | 两侧都由本方开发，插件第一天即提供注入；探测失败直接报"runtime 未安装"，不静默降级 |
| D7 | 模型发现 = `session/new` config options 直读 | ACP probe（I39 的 copilot/kimi 思路）；静态列表 | 免 probe、免缓存，动态准确。I39 中 dsh 部分由此销账 |

## 3. 架构

```
open-tag daemon (每 agent 一 wake 周期一进程)
  agentManager ──spawn──▶ dsh --profile opentag [--resume 相关参数由插件侧 session 管理]
  dshRuntime.ts ◀──ACP v1 + opentag/* 扩展（NDJSON, stdin/stdout）──▶ 插件派生 ACP server
                                                            │
                                              Cordis 服务树: agents / sessions / llm /
                                              sessionPersistence / systemPrompt(complete section)
```

### 3.1 dsh-work 侧：`plugins/dsh-opentag-agent-runtime`

新目录，结构仿 `plugins/brand-profile`：

```
plugins/dsh-opentag-agent-runtime/
├── package.json          # name: dsh-opentag-agent-runtime; dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml      # 本插件作为 bundle 插入；override system-prompt config
├── src/
│   ├── index.ts          # 插件入口：token 解析、握手状态机、prompt 存储、complete section 注册
│   ├── acp-server.ts     # 派生 ACP server（自 dsh-acp index.ts 派生，加 opentag/* 方法与门禁）
│   ├── auth.ts           # token 校验（constant-time）、authorized 状态
│   └── prompt-section.ts # complete:true section + 未注入即 fail 的变量哨兵
├── tests/                # vitest 单测（见 §7）
└── lib/                  # esbuild 产物（build.mjs，仿 brand-profile）
```

**cordis.patch.yml** 职责：
1. 以 app 插件身份插入 profile（替代默认 acp 插件位 —— 本插件自带派生 server，`@deepseek-ai/dsh-acp` 不再挂载）。
2. override `system-prompt` config：`includeHarnessIdentity: false`、清空 acp 模板的 `personaPrefix`/`personaSuffix`（官方语义："compatibility deployment owns the complete system prompt"）。

**协议扩展**（JSON-RPC，标准 ACP 方法之外新增两个，均需先通过握手）：

| 方法 | 参数 | 行为 |
|---|---|---|
| `opentag/auth` | `{token: string}` | 校验 token（constant-time）→ 标记 authorized；失败则后续 `opentag/*` 全拒 |
| `opentag/setSystemPrompt` | `{text: string}` | 必须已 authorized；text 非空；**每进程仅一次**，二次调用报错；存储后注册 `ctx.systemPrompt.section({name:"opentag-standing-prompt", complete:true, interpolate:false, text})` |

**门禁（fail-loud，不依赖拦截 ACP 分发）**：启动即注册 complete section，其 text 引用未解析变量 `{{opentag_standing_prompt}}`；`setSystemPrompt` 前该变量解析器抛错 → dsh-system-prompt 官方语义"unresolved variables fail assembly" → 任何 `session/new` 尝试立即失败并给出明确错误。注入后变量解析为存储文本。

**token 传递**：daemon spawn 时 argv `--opentag-auth-token <hex32>`（app 参数，经 dsh-cmdline 共享快照解析）；daemon 同步生成同值用于握手。

**权限**：派生 server 内置 permission 自动 allow-first（与 open-tag 其它 runtime 的 bypass 立场一致）。

### 3.2 open-tag 侧：`src/daemon/dshRuntime.ts`

- `start(opts, cb)`：
  1. `crypto.randomBytes(32).toString("hex")` 生成 token
  2. `spawnSafe("dsh", ["--profile", "opentag", "--opentag-auth-token", token], …)`
  3. NDJSON 行缓冲（仿 codexRuntime）；`initialize`（protocolVersion 1）→ `authenticate` → `opentag/auth` → `opentag/setSystemPrompt {text: opts.systemPrompt}`
  4. `sessionId` 存在则 `session/resume`，否则 `session/new {cwd: opts.cwd, mcpServers: []}`；响应 config options 上报 server（动态模型列表）
  5. `opts.model` / `runtimeConfig.reasoningEffort` → `session/set_config_option`
- `deliver(text)`：`session/prompt`（per-session 单飞，排队串行，admission 复用 `protocolAdmission`，exactly-once）
- `session/update` 通知 → `TrajectoryEntry[]` 映射（assistant message block → thinking/text/tool；tool lifecycle → onActivity working）
- `session/request_permission` → 自动选第一个 allow 选项
- `stop()`：`session/cancel` + `session/close` → killTree 兜底
- pure 部分导出供单测：`buildDshArgs`、ACP 消息编解码、`mapAcpUpdate→TrajectoryEntry`、permission 应答策略、prompt 队列状态机
- 注册：`runtimes.ts` REG 增加 `dsh`；`detectRuntimes()` 探测 `dsh` 于 PATH **且** `$DSH_HOME/profiles/opentag` 存在（`DSH_HOME` 默认 `~/.dsh`），缺一不列
- UI：`web/src/views/Members.tsx` RUNTIMES 增加 `{value:"dsh", label:"DeepSeek Harness"}`
- 模型列表：`runtimeModels.ts` DYNAMIC_RUNTIMES 增加 `dsh`，daemon 侧 `probe-models` 处理 dsh 时经活 agent 或临时 `session/new` config options 获取（实现时定，倾向临时连接 probe，60s 缓存沿用）

### 3.3 数据流（一次 wake 周期）

```
idle 10min → kill ──▶ 消息到达 → agentManager.start()
  → buildSystemPrompt(ctx)（每次 spawn 现算：description/personality 变更下次 wake 生效）
  → spawn dsh → ACP 握手 → auth → setSystemPrompt → session/new|resume → set_config_option
  → deliver(RESUME_NUDGE|initialPrompt) → session/update 流 → turnDone → onActivity("online")
  → … 后续 deliver 排队 … → idle → kill（sessionId 已存 DB，下次 resume）
```

## 4. 错误处理

| 故障 | 行为 |
|---|---|
| `dsh` 不在 PATH / profile 不存在 | detectRuntimes 不列出；强配则 spawn 失败 → onActivity offline + 明确原因 |
| token 校验失败 | `opentag/*` 拒绝；未注入 prompt → session/new 被 assembly 哨兵挡下，错误信息含指引 |
| `setSystemPrompt` 空 text / 二次调用 | 显式 JSON-RPC error |
| `session/new` 先于注入 | assembly fail（哨兵变量），错误说明"persona not injected" |
| prompt 中途失败 / 进程退出 | 对应 deliver 的 admission reject；onExit 走既有恢复路径 |
| dsh 内部服务 API 变更（升级破坏派生 server） | 插件测试 + E2E 拦截；版本 peerDep 声明锁定已知兼容范围 |

## 5. 安全模型

1. **传输边界**：stdio 管道句柄仅 spawn 父进程（daemon）持有；跨机器物理不可达；agent 工具面（shell 等）无法写父进程管道 → agent 不能自行改写人设。
2. **握手**：per-spawn 一次性随机 token（32B hex），argv 传递、协议回显校验、constant-time 比较。防未来传输形态变化 / 调试工具误用。
3. **注入语义**：一次性 + authorized 前置 + assembly 哨兵，三重保证"人设必来自 daemon 且仅一次"。
4. **明确不防**：本机可任意起进程的攻击者（可直接跑任意 harness CLI，机器信任边界，与现有 runtime 同立场）。
5. **`description`→prompt 注入**：属 open-tag 授权域（谁能建 agent），归 `docs/authorization.md` 既有范畴，本设计不新增面。

## 6. 部署与交付

- **dsh-work**：插件包 + README（profile 建立两条命令：`dsh --profile opentag --from-default-profile acp`、`dsh plugin --profile opentag add <plugin-path>`；构建 `node build.mjs`；dsh submodule 需 `build:lib:host`）。首次部署后手工 smoke：initialize+auth+setSystemPrompt+session/new。
- **open-tag**：无需新 env；daemon 发版纪律照常 —— `src/daemon/**` 进 bundle → bump `packages/daemon/package.json` + GitHub Release + CHANGELOG 条目（**merged ≠ shipped**）。
- 文档同步（同 commit）：ARCHITECTURE.md codemap、FEATURES.md checkbox、README Verified（E2E 证据）、tech-debt-tracker（I39 dsh 部分销账 / 记录派生 server 维护债）。

## 7. 测试策略（TDD，两侧先写测试）

**插件（vitest）**：
- auth：token 匹配/不匹配/未设置 argv、constant-time、authorized 状态迁移
- setSystemPrompt：空 text、未 auth、二次调用、成功后 section 注册参数（complete/interpolate/name）
- 哨兵：注入前变量解析抛错（assembly fail）、注入后返回文本、文本含 `{{…}}` 不被二次插值（单遍插值假设以测试钉死）
- patch：`--dump-config` 断言 system-prompt config 覆盖生效、acp 原插件不挂载
- 派生 server：opentag/* 门禁矩阵 + 标准 ACP 方法回归（沿用 dsh-acp 测试思路，mock transport `config.stream`）

**open-tag（vitest）**：
- buildDshArgs（token、profile、resume 分支）
- update→Trajectory 映射（各 block 类型、tool lifecycle、未知类型忽略）
- permission 自动应答策略
- deliver 队列串行 + admission exactly-once
- detectRuntimes 探测逻辑（PATH + profile 目录两条件）

**集成 / 实跑（verification bar）**：
- `wt:add -- dsh-runtime` 隔离栈 → `dev:e2e:up` → 浏览器建 dsh agent → 收发消息、轨迹显示、sleep/wake resume、模型切换
- 手工 curl ACP 负路径（错 token、空 prompt、二次注入）

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| dsh 内部服务 API 是 developer preview，升级破坏派生 server | peerDep 范围锁定；插件测试为升级哨兵；派生范围最小化（只改入口与新增方法，核心 session/prompt 逻辑 import 原包） |
| 单遍插值假设不成立（prompt 内 `{{…}}` 被再解析） | 测试钉死；不成立则退化为"未注入时注册占位 complete section 抛错"方案 |
| profile 建立对用户有上手成本 | README 两条命令 + open-tag 报错信息直接给出这两条 |
| 派生 server 与上游 acp 漂移 | tech-debt 记账，升级 dsh 时 diff 上游 index.ts |

## 9. 非目标（YAGNI）

- 运行中热更 prompt（需要时 daemon bounce 进程即可，零协议改动）
- per-channel 人设（open-tag 身份模型是 agent 级，频道上下文走消息投递）
- ACP 版本分叉 / 上游化（当前无缺口；上游化另行评估）
- MCP server 挂载透传（open-tag agent 用本机 CLI，暂无需求）
- open-tag daemon 自动 bootstrap profile（先文档手工，有痛点再做）

## 10. 工作流

- open-tag：worktree `dsh-runtime`（`npm run wt:add`，已建，branch `feature/dsh-runtime`）
- dsh-work：`git worktree add ../dsh-work-opentag feature/opentag-agent-runtime`
- 两侧 TDD 红→绿→重构；spec 随 open-tag 分支提交
