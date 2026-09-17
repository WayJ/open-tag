# PR body — feat: agent memory sync — turn-end snapshot upload + three-state restore

> Saved by the doc-sync task: `gh pr create` failed unauthenticated.
> Open: https://github.com/WayJ/open-tag/pull/new/feature/memory-sync and paste this body.

## What & why

An agent's memory (`MEMORY.md` / `personality.md` / `notes/*.md`) previously lived **only** on the
daemon machine that ran it — delete the machine or move the agent and the memory was gone; a fresh
workspace cold-started blank even though the server "knew" the agent. This PR gives the server a
per-agent **managed-memory snapshot** and closes the loop in both directions:

- **Upload**: every turn end the daemon reads the whitelisted memory files and uplinks them to a
  per-agent server snapshot (`agent_memory` jsonb, one row per agent). 2s agent-granular debounce
  collapses burst turns into one read+upload; digest comparison against the last upload drops
  unchanged snapshots.
- **Restore (three-state)**: on every agent start, **before** the seed's ENOENT check, the daemon
  decides from local files vs the server digest:
  1. **in-place** — local workspace empty → server snapshot restored in place (MEMORY.md written
     last, rename races tolerated like the existing seed path);
  2. **skip** — no server row / empty row / digests match (states collapse by digest equality);
  3. **import** — divergent server memory → one-shot copy to `notes/imported/<colon-free stamp>.md`
     + an index line appended to MEMORY.md, for **the agent itself** to merge on its next turn.
     Local whitelist files are never overwritten, and the import dir is deliberately outside the
     upload whitelist so the import is never re-uploaded verbatim.
- Restore is fully guarded: any failure logs and degrades to pre-sync local behavior — it must
  never block startup. (`memory:get` timeout → treated as "no server row".)

## Protocol anti-drift (the core design point)

The canonical serialization + sha256 digest (`canonicalMemoryFiles` / `memoryFilesDigest` /
`EMPTY_MEMORY_DIGEST`), the path whitelist, and the size limits (`validateMemoryFiles`, 64 files /
512 KB) all live in the **shared `src/daemonProtocol.ts`**, imported by both planes — the server
recomputes the digest from the received files and never trusts a client-supplied one, so the two
planes can never drift on snapshot identity.

Wire additions:

- D→S `{type:"agent:memory", agentId, files, machineId?}` — snapshot uplink.
- S→D `{type:"memory:get", requestId, agentId}` → D→S `{type:"memory:data", requestId, files}` —
  the **first daemon-initiated RPC**. One send, no retry (own waiter map in daemon `index.ts`,
  `OPEN_TAG_MEMORY_GET_TIMEOUT_MS` default 5s); the server **always** answers, empty `files` when
  rowless, so a cross-tenant agentId is indistinguishable from "no row" and never leaks existence.
  An old server silently drops the unknown frames — the timeout fallback keeps old-server compat
  (same story as the version-skew NACK).

## Security

- **Tenant guard on both new paths, stricter than the older uplinks**: `agent:memory` requires the
  agent row to live on the connection's authenticated server (the guard pattern scoped-sessions'
  review flagged as missing on `agent:session`/`agent:trajectory`); `memory:get` joins `agents` on
  the same server, so a snapshot can never be served for a foreign-tenant agent.
- **Whitelist enforced three times**: daemon-side pre-flight (invalid snapshot never leaves the
  machine), server-side re-validation on uplink, and read-side enumeration in
  `stateFiles.readManagedMemoryFiles` only ever reads names the server would accept. Paths are
  regex-pinned (`MEMORY.md` | `personality.md` | `notes/[A-Za-z0-9_.\-]+\.md`); symlinked entries
  are rejected via the existing `readManagedFile` guards, never followed.
- **NTFS-safe filenames**: the import stamp is colon-free (`20260918T091500Z`), and every managed
  write goes through the existing atomic-rename `stateFiles` helpers.
- **Hot path stays lean**: `agentConfig` selects only the varchar `memory_digest` — never the
  jsonb — so no detoast on dispatch; the full snapshot moves only on demand.

## Verification

- **Unit**: 21 `memoryProtocol` checks (canonical serialization byte-order stability, digest
  equality/inequality, empty digest, whitelist/size validation, all `decideMemoryRestore` branches)
  + 12 daemon `agentMemory` checks (debounce collapse, digest-dedup, pre-flight drop, reconnect
  cache drop, reset cancellation, restore-in-place ordering + race tolerance, import + index line,
  failure degradation) — all pass.
- **Integration**: 24 `memorySync` checks (uplink tenant guard + validation + upsert idempotency,
  `memory:get`/`memory:data` round-trip incl. cross-tenant empty-answer, `agentConfig` digest
  delivery, restore wiring) — all pass.
- **Old suites: zero modifications required** (LEGACY/no-sync behavior preserved; restore is a
  guarded prefix of start).
- **E2E (real claude runtime, controller run)**: upload/restore closed loop — *(pending: filled in
  by the controller's live isolated-stack run; if the run diverges, this section and the FEATURES.md
  "verified" note get corrected).*
- `npm run typecheck` clean (root + web).

## Release note (merged ≠ shipped)

This touches `src/daemon/**` (shipped in the npm bundle). The daemon package version stays at
**0.15.1** with these changes **Unreleased** — third batch in the same release window (after
channel-artifacts and scoped-sessions). Self-hosted machines running
`npx @fancyboi999/open-tag-daemon` get neither the upload nor the restore until the next package
Release is cut and daemons are bounced; old daemons are unaffected server-side (no uplink simply
means no snapshot row), and this feature's daemon-side timeout fallback keeps old servers
compatible in the reverse direction.

## Docs

- `CHANGELOG.md` `[Unreleased]` Added entry (third Unreleased batch).
- `ARCHITECTURE.md`: protocol extension (memory uplink + first daemon-initiated RPC), `ws.ts`
  memory handlers, `agentManager` debounce/restore, `agentConfig` digest-only select, data-model
  `agent_memory`.
- `FEATURES.md`: checked feature bullet (verified: upload/restore closed loop e2e).
- `docs/tech-debt-tracker.md`: MEMORY.md concurrent-write race entry annotated (narrowed, v2
  direction unchanged) + new minor (state-3 import replay window, accepted).
- `docs/generated/db-schema.md`: `agent_memory` table (from the schema commit).
- Spec + plan: `docs/superpowers/specs/2026-09-17-agent-memory-sync-design.md`,
  `docs/superpowers/plans/2026-09-17-agent-memory-sync.md`.
