# 2026-09-19 · DSH Runtime 主体（D2，ACP 客户端，test-first）

分支：feature/dsh-runtime（worktree open-tag-dsh-runtime）
计划：docs/superpowers/plans/2026-09-19-dsh-agent-runtime.md · Task D2（D3 注册/探测在后续 commit）

## 内容

`src/daemon/dshRuntime.ts` 新增 `dshRuntime: Runtime`（experimental），零新依赖——手写
JSON-RPC 2.0 NDJSON 客户端 `DshClient`（仿 codexRuntime 的 CodexClient：stdout 行缓冲、
id→pending map、通知分发、server→client 请求内联回答）。纯函数层新增两个导出：
- `resolveDshModelValue(configOptions, model)` → model select 叶子 `value`（JSON
  [provider, model] 串）；按 model 段、provider/model、原始 value、显示名四种方式匹配；
  未提供 → null（保留会话默认，不发非法值）。id 对齐 D4 parseDshConfigOptions 的
  DiscoveredModel.id（= pair[1]）。
- `resolveDshEffortValue(configOptions, effort)` → reasoning_effort select 的 value/value
  名匹配；dsh 只提供 off/low/high/max，未提供（如 medium）→ null 跳过。

握手序列（任一步失败 → admission.reject + onActivity offline + killTree，fail loud）：
initialize{protocolVersion:1, clientCapabilities.fs 全 false} → authenticate{methodId:
authMethods[0].id ?? "open-tag"}（派生 server authMethods 实为空数组 → 走回退）→
opentag/auth{token}（spawn 时 randomBytes(32) hex 经 argv 传入）→ opentag/setSystemPrompt →
sessionId ? session/resume : session/new{cwd, mcpServers:[]} → cb.onSession →
set_config_option（model/effort 有则发，先于首个 prompt）。

投递：`deliver` 经 createDeliverQueue 严格串行；任务先 await ready 门（握手完成 resolve、
失败/退出 reject），再 per-turn 模型钩子（opts.model/effort ≠ last-sent 才发
set_config_option，last-sent 只在 RPC 成功时更新；config_option_update 通知会刷新
configOptions 缓存），然后 session/prompt——**其响应（stopReason）即本轮 admission 边界**：
resolve=accept+onActivity online，JSON-RPC error=reject。

通知：session/update 按 params.sessionId 过滤后 → mapAcpUpdate→onTrajectory +
acpActivity→onActivity；**tool_call 去重**：ACP 对同一 toolCallId 按
pending→in_progress→completed 多次重发，Set 记已见 id，仅首次映射 trajectory，后续只喂
activity（无 toolCallId 的 tool_call 无法去重、每次都发）。Set 随 sessionId 变更重置。

权限：session/request_permission → permissionAnswer(options) 首个 allow_* →
result{outcome:{outcome:"selected",optionId}}；无 allow 项 → {outcome:"rejected"}；其它
server→client 方法回 -32601（server 永不等待人答）。

stop()（与 claude/codex 的差异，有意为之）：session/cancel 通知 + session/close 请求
（不 await）后 **stdin.end() 走 EOF 优雅关停**——dsh 在 stdin 干净关闭时持久化会话，这
正是下次 wake 可 resume 的前提；1s 宽限后 killTree 兜底（unref）。write() 增加
ended/destroyed 守卫：向已 end 的 stdin 写入会以异步 'error' 事件炸掉无监听的 daemon。

进程事件对齐既有模式：error → admission.reject + settleReady(reject) + closeAllPending +
offline("dsh not found"/"dsh spawn failed") + finish(1)；exit → settleReady + admission +
closeAllPending（在飞 prompt 的 deliver 随之 reject）+ finish(code)。

## 测试（先红后绿）

红：`The requested module './dshRuntime.js' does not provide an export named 'dshRuntime'`。
绿：`npx tsx --test src/daemon/dshRuntime.test.ts` → **24 pass**（12 旧 + 12 新）。
假 dsh：tmpdir 下 node shebang 脚本（codexRuntime.test.ts 同机制，PATH 解析），实现真实
握手 + session/update 流 + request_permission，行为开关走 FAKE_DSH_* env；请求全量落
requests.jsonl 断言。新增用例：正路径握手/时序/token 回显、authMethods 回退与 pick-first、
resume 路径、deliver 串行（turn1 门控证明 turn2 不提前）、tool_call 去重（1 条 trajectory
/ 2 次 working）、permission 应答 allow_once、model+effort 两条 set_config_option 先于
prompt、未提供 model 软跳过、opentag/auth 失败负路径（admission reject + offline + exit
+ 排队 deliver reject）、stop() cancel→close 顺序 + 进程退出。
Windows 坑：假进程 cwd=临时目录，活进程占目录致 rmSync EPERM → cleanup 先 stop 并等
onExit 再删；二次 stop 会多排一个 killTree（同步 taskkill 阻塞后续测试事件循环），已退出
则不再 stop。

## 验证

- 回归：`npx tsx --test` dshRuntime + codexRuntime + claudeRuntime + listModels-dsh →
  **47 pass / 0 fail**。
- `npx tsc --noEmit` 根通过。
- 未做（fail loud）：真机 dsh 冒烟/E2E 属 E2（dev:e2e:up）；runtimes.ts 注册属 D3；
  ARCHITECTURE codemap/CHANGELOG 0.17.0 属 E3（D1/D4 先例亦未在各自任务加 codemap 行）。

## 评审修复（后续 commit：fix: dsh runtime review fixes）

- **I-1**：DshClient 构造器挂 `proc.stdin?.on("error", () => {})`——write 守卫与 OS 落盘
  之间子进程死掉产生的异步 EPIPE 无其它监听者，daemon 无 uncaughtException 处理器，
  一个未处理 'error' 事件会带走所有 agent。
- **M-1**：stop() 顶部 `if (stopped) return;` 幂等；exit 处理器 clearTimeout(killTimer)——
  优雅退出后不再对死 PID 跑同步 taskkill（顺带消除 PID 复用误杀窗口）。
- **M-2**：offline detail 可诊断化——init 失败带 error message（clip 200）；exit 路径
  `dsh exited (N): <stderr 尾巴>`（stderr 保留最近 3 行 ×200 字符环，join 后取尾 200）。
  有意 stop（stopped）不发声；进程死亡时 offline 归 exit 处理器独占（握手 catch 在
  `spawnFailed || reportedExit` 时只 settle，不重复报告）。
- **M-5**：删掉 session/new 里恒真的 `sessionId !== r.sessionId` 分支（clear() 空集合误导
  读者），直接赋值。
- **M-4 首项**：新测试"stop() 于握手期间"——FAKE_DSH_HANG 吞掉 initialize；断言无
  cancel/close、无 session/new、exit 走 EOF+kill、admission 以 /dsh exited/ 拒绝、无
  offline 噪声、无崩溃。
- 不修（按评审裁定）：M-3 UTF-8 分块边界（codex/claude 同样存在，进 tech-debt）；
  I-2 admission-at-turn-end（计划本意，E2 验证项）。

修复后：dshRuntime.test.ts **25 pass**（24+1）；codex/claude/listModels-dsh 回归 23 pass；
`npx tsc --noEmit` 通过。

## I-2 修复（E2E 暴露：admission 在轮末结算 → 3min 启动超时杀掉健康会话）

E2E 实况：glm-5.3 high effort 的真实 agentic 首轮 >180s，而初始 admission 原设计在
session/prompt **响应**（= 轮末）才 settle → agentManager START_ADMISSION_TIMEOUT_MS
(3min) 到期杀掉正在工作的会话 → 重启循环（transcript 已 99KB 真实活动）。

修复：通知处理器在通过 current-session 过滤、排除 config_option_update 后调用
`admission.accept()`——**首个 turn 活动 = 初始 prompt 已被接受并处理中**，与 claude
（stdin 写 ACK）/ codex（turn/start accepted）语义对齐。exactly-once 守卫使后续 update
成为 no-op；响应路径、握手失败、进程退出仍各为兜底结算（无 update 的轮次照常在响应时
settle）。per-delivery 的 protocolAdmission 不变（仍在轮末，投递语义未动）。

测试（先红后绿）：新用例 FAKE_DSH_ADMIT_GATE——假 dsh 先发 agent_message_chunk、再卡在
release 文件上不答 prompt；断言 admission（无错）在 prompt 响应**存在之前**已 settle、
同一条 update 照常喂 onTrajectory、放行后轮末仍到 online。红 = 5s 超时。
连带加固三个原有用例的等待条件（断言不变）：happy/tooldup/perm 原本借"admission=轮末"
隐式等全轮完成，早结算后改为显式 waitFor 终态（online / hello / permission_reply）。

修复后：dshRuntime.test.ts 32 tests / 31 pass / 1 D3 条件跳过（本机装有真 dsh）/ 0 fail；
codex/claude/listModels-dsh 回归 23 pass；`npx tsc --noEmit` 通过。
