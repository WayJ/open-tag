# 2026-09-18 · Agent Memory Sync（记忆上行/恢复）

合并 commit：见 git log（Merge branch 'feature/memory-sync'）→ main
分支：feature/memory-sync（8 commits，worktree open-tag-memory-sync）
主库迁移：db:push 已建 agent_memory（合并即时执行）

## 功能

跨机迁移的数据地基：agent 记忆白名单（MEMORY.md/personality.md/notes/*.md）
turn 结束去抖 2s 上行 server（agent_memory 一行 jsonb + 规范 digest）；agent 启动时
三态恢复——同内容跳过 / 空机原位落盘 / 分叉导入 notes/imported/<无冒号时间戳>.md
+ MEMORY.md 索引行，由 agent 下一 turn 自主合并后上行收敛。

- 协议防漂移：canonical 序列化（路径字节序 + U+0001 分隔 + sha256）放
  src/daemonProtocol.ts 双侧共享；jsonb 键序陷阱单测正面锁死
- 热路径零膨胀：config 只带 memoryDigest（varchar 列不 detoast）；全量走
  memory:get/memory:data RPC（首个 daemon 发起 RPC，5s 单发超时）
- 安全：上行租户守卫（比旧 uplink 邻居更严）+ 白名单三道校验 + 预发送校验 +
  重连清缓存（断窗丢包自愈）
- e2e 全闭环：上传/态1/态3+收敛（agent 合并后 server 行回到本地内容）

## 验证

单测 42（协议 21 + daemon 12 + memory 9）+ 集成 24 + 旧套件零修改；浏览器/CLI
e2e 四态实测。评审 3 轮 spec + 4 轮 task + 终审 Ready to merge。

## 附带发现（预存基建 bug，tech-debt 在案）

dev-e2e-up.sh：(a) OPEN_TAG_HOME 解析后从不 export——daemon 落默认 ~/.open-tag，
worktree 数据隔离实际靠调用者 shell 泄漏 env 才成立；(b) down 的 pidfile 杀不到
npx 孙进程——每 up/down 周期泄一个僵尸 daemon，同 machineId 互踢 WS（1005 flap）。

## 发版（第三批 Unreleased）

channel-artifacts + scoped-sessions + memory-sync 三批积压，下次 Release 一次清 +
各机 bounce daemon。
