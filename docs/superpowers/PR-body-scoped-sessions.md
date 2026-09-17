# PR body — feat: scoped sessions — one persistent runtime session per (agent, channel|thread)

> Saved by the doc-sync task: `gh pr create` failed unauthenticated
> (`To get started with GitHub CLI, please run: gh auth login`).
> Open: https://github.com/WayJ/open-tag/pull/new/feature/scoped-sessions and paste this body.

## Model change

An agent previously kept **one** runtime session chain: a busy agent head-of-line-blocked every other thread/channel waiting on it. This PR makes the session unit **(agent, scope)** where scope = `channel` or `thread` (a thread keeps its own channel id as a thread scope; channel/private/dm are channel scopes on their own id):

- **Same scope** → strict FIFO, unchanged (server-persisted, recipient-invisible, no Activity preview until the current turn returns to terminal `online`).
- **Different scopes of the same agent** → **concurrent** runtime sessions; head-of-line blocking across threads/channels removed.
- LEGACY (no scope) → the old single agent-wide chain backed by `agents.session_id` (manual restart, reconnect catch-up, older daemons).

## Server

- `agent_sessions` table (unique `(agentId, scopeType, scopeId)`): one persistent session per (agent, scope).
- Scope resolution at dispatch: `agentConfig(agentId, scopeCtx?)` maps the channel context → scope and reads the per-scope session id; unknown/deleted channel → LEGACY config. Five deliver/start sites thread the scope through; `agent:start` carries `config.scope`, `agent:deliver` carries `msg.scope`.
- D→S `agent:session` uplink with a valid scope upserts `agent_sessions`; scope-less/invalid uplinks keep writing the legacy `agents.session_id` (old-daemon compat).
- `resetAgent` clears every `agent_sessions` row for the agent.

## Daemon

- All per-instance state re-keyed by `scopeKey(agentId, scope)` — the full 8-site migration: start queue, `starting` claims, pending delivers, the five delivery-fence maps, and the running map. Same-scope turns serialize; sibling scopes spawn their own runtimes.
- Idle-sleep at `sleepScope` granularity with a last-survivor status rule (a crashed scope only reports error/offline when it is the last surviving scope); per-agent lifecycle controls (stop/sleep/reset/profile, `controlTails`) stay agentId-granular; `resetAgent` clears every scope.
- LEGACY dispatch (no scope on start/deliver) keeps the single agent-wide chain.

## Verification

- **Unit**: 18 `agentManagerScope` checks (scopeKey mapping, concurrent sibling scopes, per-scope pending queues, epoch isolation, last-survivor status, reset uplinks, dequeue semantics) + 8 `artifactMeta` checks — all pass.
- **Integration**: 27 `scopedSessions` checks (server scope resolution, protocol injection, `agent_sessions` upsert/legacy split, reset clearing) — all pass.
- Old `agentManager` suite: **zero modifications required** (LEGACY behavior preserved).
- **E2E (real claude runtime)**: dual-thread triggers 80 ms apart → two `claude` processes spawned concurrently with distinct scope keys → per-scope pending queues → independent session ids in `agent_sessions` → parallel correct replies (T1 done / T2 done ~6 s apart) → daemon bounce → both scopes `resume:true` → replies correct after resume.
- `npm run typecheck` clean (root + web).

## Release note (merged ≠ shipped)

This touches `src/daemon/**` (shipped in the npm bundle). The daemon package version stays at **0.15.1** with these changes **Unreleased** — release deliberately deferred (same window as the channel-artifacts changes). Self-hosted machines running `npx @fancyboi999/open-tag-daemon` keep single-chain behavior until the next package Release is cut and daemons are bounced; the server-side LEGACY fallback keeps everything compatible in the meantime.

## Docs

`ARCHITECTURE.md` (scheduling model, `agentConfig` scope resolution, `ws.ts` uplink, daemon state keying, §III invariant, §IV protocol extension + LEGACY semantics) · `FEATURES.md` checkbox · `docs/generated/db-schema.md` (landed with the schema commit) · tech-debt entries (MEMORY.md multi-scope write race, `agents.session_id` legacy, release deferral, epoch-map cosmetics, M-5a test gap).
