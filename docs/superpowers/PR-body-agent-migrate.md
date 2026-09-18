# feat(server): agent migrate endpoint (stop-settle/rebind/session-reset)

Closes the cross-machine trilogy: machine routing (`agents.machineId`) → memory sync (`agent_memory` + three-state restore) → **orchestration** (`POST /api/agents/:id/migrate`). One operator call moves an agent from machine A to machine B: stop on the old machine (when possible) → rebind → the next dispatch routes by the new `machineId`, whose daemon auto-restores memory on first start.

**Spec:** `docs/superpowers/specs/2026-09-18-agent-migrate-design.md` (two review rounds) · **Plan:** `docs/superpowers/plans/2026-09-18-agent-migrate.md`

## What

- **`core.migrateAgent(serverId, agentId, targetMachineId, actor)`** — validation order is load-bearing:
  1. **404** unknown/soft-deleted agent (serverId-scoped)
  2. **200 idempotent `{alreadyThere:true}`** when target == current machine — **before** the online check (a temporarily-offline machine you're already bound to must succeed, not 409)
  3. **409 `machine-offline`** for any target that is not a same-tenant (`machines.serverId`) **online** machine (`status==="online" && isMachineConnected`) — cross-tenant walks the same 409, no existence leak
- **Three-branch stop** on the old machine:
  - online + agent `starting/active/queued` → `agent:stop` via `requestAgentControl` with the 30s settle ACK (`agent-control-ack-v1`); failure → **503 `stop-failed`, no rebind** (DB untouched)
  - online + agent `inactive/sleeping` → skip stop (no in-flight state)
  - old machine entirely offline → skip stop, rebind anyway (dead-machine flagship)
- **Transactional rebind**: `machineId` = target + `status=inactive` / `activity=offline` (real post-migration enums, `stopAgent` precedent) + `publishAgentState` UI push, plus **full session-pointer reset** — `delete agent_sessions where agentId` + `agents.sessionId = null` (`resetAgent` precedent: a stale scope sessionId would break the new machine's first `--resume`; the claude runtime has no missing-session fallback). Audit line via server log (`agent migrated {actor, fromMachineId, toMachineId, stopped}`).
- **`POST /api/agents/:id/migrate`** in `routes-api/agents.ts`, behind `manageAgents` (same tier as the other agent lifecycle ops). Human plane only — **zero new agent-plane/daemon-plane endpoints, zero daemon protocol changes → no daemon release item** (merged == shipped for the server).

## Verification (TDD)

- **RED**: `test/agentMigrate.integration.ts` first run — 18 checks failed (route absent, every call 404 `not found`).
- **GREEN**: all **27 checks pass** across the six spec branches:
  1. unknown agent → 404 · offline target → 409 `machine-offline` · member (no `manageAgents`) → 403
  2. running agent, both machines online → `agent:stop` lands on the **old** machine's daemon only, settles (`rpc:ack`), rebind + `agent_sessions` cleared + legacy `sessionId` cleared + `inactive/offline`
  3. old machine's daemon refuses stop (`rpc:nack`) → 503 `stop-failed: stop refused by daemon`, **machineId unchanged**
  4. old machine offline + agent `active` → 200, direct rebind (no stop frame anywhere)
  5. `sleeping` agent → skip stop, direct rebind; same-machine call while that machine is **offline** → 200 `{alreadyThere:true}` (idempotence precedes the online check)
  6. cross-tenant target machine → 409, machineId unchanged
  - Harness: real DB + `handleApi` called directly with a JWT (mirrors `agentCreateRequiresMachine.integration.ts`); fake machine daemons via `registerDaemon` + `registerMachineConn` + `registerDaemonCapabilities([agent-control-ack-v1])` answering `rpc:ack`/`rpc:nack` with the `sourceWs` binding (mirrors `scopedSessions.integration.ts`).
- **Regressions**: `memorySync.integration` ✅ · `scopedSessions.integration` ✅ · `channelArtifacts.integration` ✅ · `agentMachineOfflineState` 2/2 ✅ · `agentStopControls` 7/7 ✅. Root + web `tsc --noEmit` clean. (DB-backed suites run sequentially per tech-debt I97.)

## Skipped / deferred (fail-loud)

- **Dual-daemon live e2e (plan step 1.6): skipped** — blocked by the pre-existing dev-e2e harness bugs (tracked 2026-09-18 in `docs/tech-debt-tracker.md`: `dev-e2e-up.sh` never exports `OPEN_TAG_HOME` to children; `dev-e2e-down.sh` leaks one zombie daemon per cycle that fights over the machine WS slot). A two-daemon run is unreliable by construction until those are fixed → **tech-debt I107** records the test-gap; the API-level integration covers all six contract branches at the boundary the endpoint owns.
- **Orphan-token residual (documented, accepted for v1)** — when the old machine is network-partitioned (not dead), migrate's offline branch rebinds without stopping it, and the partitioned daemon's agent process keeps a valid `sk_agent_*` token (ready-reconcile queries by machineId, so rebind never evicts it). Same exposure class as DELETE agent's pre-C4 handling → **tech-debt I106**; cheapest future hardening = rotate `agentTokenHash` on rebind-from-offline.
- **UI affordance**: spec non-goal — API first; agent-profile migrate button is a later slice (closes the last residue of tech-debt **I77**, now archived as resolved).

## Doc-sync (same PR)

`ARCHITECTURE.md` (codemap agents group + new migrate invariant), `FEATURES.md` checkbox, `docs/tech-debt-tracker.md` (I77 closed → archive; I106/I107 opened), spec + plan committed.
