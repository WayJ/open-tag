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
