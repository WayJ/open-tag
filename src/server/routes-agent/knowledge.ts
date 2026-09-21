// Agent-plane knowledge routes: create / list / search / detail / update / delete (/agent-api/knowledge/*).
// Split file from the routes-agent.ts monolith: handleAgentApi resolves the agent and enforces
// requiredScope (knowledge:read / knowledge:write) BEFORE mounting, so `agent` + `serverId` arrive
// pre-resolved and scope-denied requests never reach this file.
// Return contract: true = handled (response sent), false = not ours (caller keeps routing).
// Visibility model (docs/authorization.md tiers): an entry is either private (agentId = its owner)
// or workspace-shared (agentId = null). Read = own private + shared; writes = creator-only (a
// visible-but-foreign entry 404s — never reveal existence).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, ilike, isNull, lt, or } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { readJson, sendErr, sendJson, UUID_RE } from "../util.js";
import { resolveIdOrPrefix } from "../core.js";
import { buildSearchText, escapeLike, makeSnippet, KNOWLEDGE_CONTENT_MAX, KNOWLEDGE_PAGE_SIZE, KNOWLEDGE_TITLE_MAX } from "../knowledge.js";

const K = schema.knowledge;
const NOT_FOUND = "knowledge entry not found";

type Valid = { ok: true; title: string; content: string };
type Invalid = { ok: false; status: number; error: string; extra: Record<string, unknown> };

/** title: trimmed 1..KNOWLEDGE_TITLE_MAX; content: non-empty, ≤KNOWLEDGE_CONTENT_MAX (over-limit 400 carries the limit). Content is stored as given (CLI pipes may keep their trailing newline). */
function validateEntry(title: unknown, content: unknown): Valid | Invalid {
  const t = String(title ?? "").trim();
  if (!t) return { ok: false, status: 400, error: "title required (1-200 chars)", extra: {} };
  if (t.length > KNOWLEDGE_TITLE_MAX) return { ok: false, status: 400, error: `title too long (max ${KNOWLEDGE_TITLE_MAX} chars)`, extra: { limit: KNOWLEDGE_TITLE_MAX } };
  const c = typeof content === "string" ? content : "";
  if (!c.trim()) return { ok: false, status: 400, error: "content required", extra: {} };
  if (c.length > KNOWLEDGE_CONTENT_MAX) return { ok: false, status: 400, error: `content too long (max ${KNOWLEDGE_CONTENT_MAX} chars)`, extra: { limit: KNOWLEDGE_CONTENT_MAX } };
  return { ok: true, title: t, content: c };
}

/** Two-tier read visibility for one agent, always serverId-scoped. */
function visibilityFor(agentId: string, serverId: string, scope: "mine" | "shared" | "all"): SQL {
  const own = eq(K.agentId, agentId);
  const shared = isNull(K.agentId);
  return and(
    eq(K.serverId, serverId),
    scope === "mine" ? own : scope === "shared" ? shared : or(own, shared),
  )!;
}

/** Keyset cursor: `before=<id>` → strictly older than that row's (createdAt, id) tie-broken pair.
 *  The cursor row is resolved within the caller's visibility first; a non-uuid or missing cursor
 *  (deleted, foreign, garbage) degrades to the first page rather than an error. Exported so the
 *  human-plane read-only browse (routes-api/agents.ts) shares the exact same cursor semantics. */
export async function keysetWhere(vis: SQL, before: string | null | undefined): Promise<SQL> {
  const b = (before ?? "").trim();
  if (!b || !UUID_RE.test(b)) return vis;
  const cur = (await db.select({ createdAt: K.createdAt, id: K.id }).from(K).where(and(vis, eq(K.id, b))).limit(1))[0];
  if (!cur) return vis;
  return and(vis, or(lt(K.createdAt, cur.createdAt), and(eq(K.createdAt, cur.createdAt), lt(K.id, cur.id))))!;
}

/** List + search share the pagination contract: limit clamped 1..KNOWLEDGE_PAGE_SIZE, limit+1
 *  sentinel row → hasMore without an exact-boundary false positive (mirrors the messages search route).
 *  Exported so the human-plane read-only browse (routes-api/agents.ts) clamps identically. */
export function clampLimit(raw: string | null): number {
  const n = Math.floor(Number(raw ?? KNOWLEDGE_PAGE_SIZE));
  if (!Number.isFinite(n)) return KNOWLEDGE_PAGE_SIZE;
  return Math.min(Math.max(n, 1), KNOWLEDGE_PAGE_SIZE);
}

export async function handleKnowledgeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  p: string,
  agent: typeof schema.agents.$inferSelect,
  serverId: string,
): Promise<boolean> {
  if (!p.startsWith("/agent-api/knowledge/")) return false;

  // create: {title, content, shared?} → private by default; searchText fixed at write time.
  if (p === "/agent-api/knowledge/create" && method === "POST") {
    const b = await readJson(req);
    const v = validateEntry(b.title, b.content);
    if (!v.ok) return (sendErr(res, v.status, v.error, v.extra), true);
    const shared = !!b.shared;
    const [row] = await db.insert(K).values({
      serverId,
      agentId: shared ? null : agent.id,
      createdByAgentId: agent.id,
      title: v.title,
      content: v.content,
      searchText: buildSearchText(v.title, v.content),
    }).returning();
    return (sendJson(res, 200, { ok: true, id: row!.id, shared, createdAt: row!.createdAt }), true);
  }

  // list: scope=mine|shared|all (default all). No content column — list is for browsing titles.
  if (p === "/agent-api/knowledge/list" && method === "GET") {
    const scopeRaw = url.searchParams.get("scope") ?? "all";
    if (scopeRaw !== "all" && scopeRaw !== "mine" && scopeRaw !== "shared") return (sendErr(res, 400, "scope must be all|mine|shared"), true);
    const limit = clampLimit(url.searchParams.get("limit"));
    const rows = await db.select({
      id: K.id, title: K.title, agentId: K.agentId, createdByAgentId: K.createdByAgentId,
      createdAt: K.createdAt, updatedAt: K.updatedAt,
    }).from(K)
      .where(await keysetWhere(visibilityFor(agent.id, serverId, scopeRaw), url.searchParams.get("before")))
      .orderBy(desc(K.createdAt), desc(K.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit).map((r) => ({ ...r, mine: r.agentId === agent.id, shared: r.agentId === null }));
    return (sendJson(res, 200, { entries, hasMore }), true);
  }

  // search: ILIKE over searchText (own private + shared — scope is fixed to all), snippet built
  // JS-side from content (makeSnippet), escapeLike keeps q literal ("100%" is not a wildcard).
  if (p === "/agent-api/knowledge/search" && method === "GET") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) return (sendErr(res, 400, "q required"), true);
    const limit = clampLimit(url.searchParams.get("limit"));
    const rows = await db.select({
      id: K.id, title: K.title, content: K.content, agentId: K.agentId, createdAt: K.createdAt,
    }).from(K)
      .where(and(
        await keysetWhere(visibilityFor(agent.id, serverId, "all"), url.searchParams.get("before")),
        ilike(K.searchText, `%${escapeLike(q)}%`),
      ))
      .orderBy(desc(K.createdAt), desc(K.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const results = rows.slice(0, limit).map((r) => ({
      id: r.id, title: r.title, snippet: makeSnippet(r.content, q),
      shared: r.agentId === null, mine: r.agentId === agent.id, createdAt: r.createdAt,
    }));
    return (sendJson(res, 200, { results, hasMore }), true);
  }

  // detail: full uuid or 6+ hex short-id prefix (resolveIdOrPrefix; junk → null → 404, never a 500).
  // Another agent's private entry 404s — same non-reveal as the rest of the agent plane.
  // Explicit column select: searchText is an internal derived column and is never exposed.
  if (p === "/agent-api/knowledge/detail" && method === "GET") {
    const raw = (url.searchParams.get("id") ?? "").trim();
    if (!raw) return (sendErr(res, 400, "id required"), true);
    const id = await resolveIdOrPrefix(K, serverId, raw);
    const row = id ? (await db.select({ id: K.id, agentId: K.agentId, createdByAgentId: K.createdByAgentId, title: K.title, content: K.content, createdAt: K.createdAt, updatedAt: K.updatedAt }).from(K).where(and(eq(K.id, id), eq(K.serverId, serverId))))[0] : undefined;
    if (!row || (row.agentId !== null && row.agentId !== agent.id)) return (sendErr(res, 404, NOT_FOUND), true);
    return (sendJson(res, 200, { ...row, mine: row.agentId === agent.id, shared: row.agentId === null }), true);
  }

  // update: creator-only — a visible shared entry created by someone else 404s (write access by
  // provenance, not visibility). searchText refixed from the MERGED title+content.
  if (p === "/agent-api/knowledge/update" && method === "PATCH") {
    const b = await readJson(req);
    const raw = String(b.id ?? "").trim();
    if (!raw) return (sendErr(res, 400, "id required"), true);
    const id = await resolveIdOrPrefix(K, serverId, raw);
    const row = id ? (await db.select().from(K).where(and(eq(K.id, id), eq(K.serverId, serverId))))[0] : undefined;
    if (!row || row.createdByAgentId !== agent.id) return (sendErr(res, 404, NOT_FOUND), true);
    const hasTitle = b.title !== undefined;
    const hasContent = b.content !== undefined;
    if (!hasTitle && !hasContent) return (sendErr(res, 400, "nothing to update (provide title and/or content)"), true);
    let title = row.title;
    let content = row.content;
    if (hasTitle) {
      const v = validateEntry(b.title, row.content);
      if (!v.ok) return (sendErr(res, v.status, v.error, v.extra), true);
      title = v.title;
    }
    if (hasContent) {
      const v = validateEntry(row.title, b.content);
      if (!v.ok) return (sendErr(res, v.status, v.error, v.extra), true);
      content = v.content;
    }
    const updatedAt = new Date();
    // .returning() + 0-rows → 404: the creator pre-check above can race a concurrent delete, and
    // reporting ok:true after an update that hit nothing would silently lie about the outcome.
    const [updated] = await db.update(K).set({ title, content, searchText: buildSearchText(title, content), updatedAt }).where(eq(K.id, id!)).returning({ id: K.id });
    if (!updated) return (sendErr(res, 404, NOT_FOUND), true);
    return (sendJson(res, 200, { ok: true, id: id!, updatedAt }), true);
  }

  // delete: creator-only, hard delete.
  if (p === "/agent-api/knowledge/delete" && method === "DELETE") {
    const raw = (url.searchParams.get("id") ?? "").trim();
    if (!raw) return (sendErr(res, 400, "id required"), true);
    const id = await resolveIdOrPrefix(K, serverId, raw);
    const row = id ? (await db.select().from(K).where(and(eq(K.id, id), eq(K.serverId, serverId))))[0] : undefined;
    if (!row || row.createdByAgentId !== agent.id) return (sendErr(res, 404, NOT_FOUND), true);
    await db.delete(K).where(eq(K.id, id!));
    return (sendJson(res, 200, { ok: true, id: id! }), true);
  }

  return false;
}
