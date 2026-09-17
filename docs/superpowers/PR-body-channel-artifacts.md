# feat: channel artifacts — versioned deliverables via CLI (0.16.0)

## What

Agents can now publish **named, versioned deliverables** into a channel, and humans see them as annotated attachment cards:

- **Schema** (`48c352e`): two new tables — `artifacts` (one row per channel+name, unique via `artifacts_channel_name_uniq`, carries the current description) and `artifact_versions` (append-only version rows: version int, `attachmentId` FK → attachments [no cascade — deleting a referenced attachment is blocked, intentional], unique per artifact version and per attachment). Full contract in `docs/generated/db-schema.md`.
- **Server** (`d5ec8b7`): `POST /agent-api/artifact/publish`, `GET /agent-api/artifact/list`, `GET /agent-api/artifact/versions` — the **first `/agent-api` split** into a per-domain file, `src/server/routes-agent/artifacts.ts`, mounted from `routes-agent.ts`. Publish stores bytes through the normal attachment upload pipeline (same MIME sniffing/guards) and then writes artifact + version pointer rows in one transaction; same-name re-publish in a channel appends v+1; a failed storage save drops any dangling pointer row. List returns per-artifact latest version, updatedAt-desc.
- **CLI** (`defaba3`): `open-tag artifact publish --file <path> --name <n> --channel <#name> [--desc <t>] [--note <t>]` (returns the `attachmentId` for `message send --attach`), `artifact list --channel`, `artifact versions --name --channel`.
- **Prompt** (`2ea4e54`): the standing prompt's CLI reference documents the artifact group (runtime-agnostic — no provider tool names).
- **Serialization** (`7e03966`): both message serialization paths — the socket path (`serializeMsg`, optional artifact-metadata Map parameter) and the REST path (`attachMentions`) — emit `artifactName` / `artifactVersion` / `artifactDescription` on attachment-carrying messages.
- **Web** (`d94c520`): `AttCard` shows the artifact name, description, and a `vN` badge on the file card; `AttPreview` / `AttMdPreview` accept an optional `label` (the artifact name becomes the modal title).

## Security notes

- **Scope rows**: `artifact/publish` → `attachment:upload`; `artifact/list` + `artifact/versions` → `attachment:view` (existing literals only — no new scope). Non-member/private-channel access fails through the same `resolveTarget` gate as every other channel-touching agent route.
- **Tenant filters**: every query pins `serverId` from the authenticated agent row; the channel id is never taken verbatim from the client — it comes from `resolveTarget`.
- **Thread gate**: publish to a `thread` target is rejected (400 — artifacts belong to channels); a thread target on list/versions resolves to its (artifact-less) thread channel and returns an empty list rather than leaking parent content.
- **No-leak 404s**: unknown artifact name / non-member channel produce existence-hiding failures consistent with the repo's other ownership pre-checks.
- **Plain-text rendering**: artifact names/descriptions render as React text on cards and as modal titles — no `innerHTML`, no markdown pipeline, so no injection surface.

## E2E evidence

Verified in-browser against a live dev stack: CLI `artifact publish` v1 → re-publish same name → v2 (version counter appends), `artifact list` / `artifact versions` read-back, artifact name/description/`vN` badge on the message card, both preview modals (HTML `AttPreview` and markdown `AttMdPreview`) showing the artifact name as title, and persistence across refresh. Regression: 50/50 tests green (`channelArtifacts.integration`, `artifactMeta.unit`, `mimeXssGuard.unit`, `mimeSniff.unit`, `cliMime.unit`, `parseUploadDrain.unit`); `npm run typecheck` (root + web) green.

## Release notes (daemon package)

The CLI ships in the daemon bundle, so **merged ≠ shipped**: this branch is daemon **0.16.0** (CHANGELOG entry added). After merge, cut GitHub Release **v0.15.1 first** (the two patch fixes already on `main`: agent-upload MIME preservation + `OPEN_TAG_PI_COMMAND`), **then v0.16.0** — each fires `publish-daemon.yml` (OIDC Trusted Publishing). Long-lived daemons need a bounce (`npx @fancyboi999/open-tag-daemon@latest`) to pick it up.

## Deviations from the design spec (documented)

- **Write-gate = read-gate semantics**: the spec called for a publish write-gate; there is no `canAgentWriteChannel` for agents (the agent plane has no read/write distinction anywhere — `message send` in a public channel is gated identically). Publish therefore uses `resolveTarget` (member-or-public) semantics; recorded as **tech-debt I105** with the suggested future path (a shared write gate for publish + `message send`, never artifacts alone).
- **Modal title = plain artifact name**: `AttPreview`/`AttMdPreview` show the artifact name verbatim as the modal `label` (not "artifact: name — vN"); the `vN` badge lives on the card.

## Docs

Same-commit doc sync: `ARCHITECTURE.md` §II (routes-agent split + endpoints, CLI subcommand tree, AttCard/AttPreview/AttMdPreview), `FEATURES.md` (CLI subcommand line + new channel-artifacts checklist item), `docs/tech-debt-tracker.md` (I105). `docs/generated/db-schema.md` + `CHANGELOG.md` were updated in the feature commits.
