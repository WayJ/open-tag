# 2026-09-22 · CLI `--attach` 变长参数修复(tech-debt I123)

## 背景

Live agent 反馈:`message send --attach <idA> --attach <idB>` 只带上最后一个附件,误以为"不支持多附件"。根因是 commander.js 非变长 option 重复传参默认 last-wins、静默覆盖——功能本身一直支持逗号分隔(`--attach <idA>,<idB>`),是参数解析层吞参误导了 agent。记入 `docs/tech-debt-tracker.md` I123 后用户拍板直接修复。

## 改动

- `src/cli/index.ts` `message send`:`option("--attach <ids>")` → `option("--attach <ids...>")`(变长)。commander 对变长 option 收集为 `string[]`,重复传参自然合并。
- 解析改为 `flatMap` 先展开重复传参得到的数组、再按逗号切分——两种用法(重复 flag / 逗号分隔)等价兼容。array-guard(`Array.isArray`)保留旧单字符串形态的容错。
- 修法取舍:变长合并(①)而非重复报错(②)。对 agent(LLM)用户,重复传参直接生效比报错教用法省一轮往返;不做 satisfies-both 混合——变长本身就是唯一解析路径。

## 验证

- `npm run typecheck`(root + web)通过。
- 补充单测(用户确认):`src/cli/attach.ts` 抽纯函数 `attachmentIdsFrom`(index.ts import 即 parseAsync,不能直接测;照 mime.ts 先例),`test/cliAttach.unit.test.ts` 5 例——重复 flag 合并(I123 回归锁)、逗号兼容、trim/去空、去重、commander 端到端解析。10/10 通过(含 cliMime 兄弟套件)。
- CLI 全量 option 扫描(`grep -oE 'option\("--[a-z-]+'`):其余 flag 均为单值语义(路径/文本/计数),无同类静默 last-wins 风险。

## 文档同步

- `docs/tech-debt-tracker.md` I123 → ✅ Done(同 commit)。
- `ARCHITECTURE.md` codemap / `FEATURES.md` 无需改:两者只描述 `message send --attach` 用法本身,未写死单值/逗号细节;`prompt.ts` 的 `--attach <id>` 示例在变长语义下依旧正确。

## 未验证 / 残留

- 未跑真实 E2E(dev server + 真实附件上传);commander 解析层已实测,`attachmentIds` 之后的请求体结构与改动前一致(`split` 产物同为 `string[]`),服务端无感知。
- 未提交 git(用户未要求)。
