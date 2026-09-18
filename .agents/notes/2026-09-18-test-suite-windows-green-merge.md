# 2026-09-18 · test-symlink-junction 合并记录

`feature/test-symlink-junction` → `main`(merge commit 12b3e7b,--no-ff)。两个提交:

1. `47954db` junction 替代目录 symlink(9 用例两平台真断言;2 个 MEMORY.md 文件 symlink
   用例 Windows 免特权物理无解 → 带原因 skip)。helper `src/daemon/testLinks.ts`。
2. `fcfbe58` 剩余 4 失败:pi ×3(假命令不满足 e79be8c 后的"干净 turn 须 ≥1 JSON 事件"
   契约 — 纯逻辑,全平台皆挂;修假命令,仅 pi 生效门控,hermes stdout=回复文本不能掺行)
   + reasonix ×1(断言硬编码 POSIX 分隔符,改 path.join 构建期望值)。

结果:Windows 本机全量单测 643 tests / 641 pass / 0 fail / 2 skip(此前 15 fail)。

## 调查中的仓库级发现

- **GitHub Actions 从未运行过**(API `total_count: 0`)— pi 类全平台失败从未被 CI 抓到。
  Actions 未触发原因待查(仓库设置/工作流条件)。
- 此前我声称"CI Linux 绿"是未验证假设,已在调查中作废并纠正。

## 验证

合并前:分支 typecheck 绿 + 6 文件 110 tests(108 pass / 0 fail / 2 skip);
合并后:main typecheck 绿 + runtimeStop/reasonix 45/45。worktree 与分支已清理。
