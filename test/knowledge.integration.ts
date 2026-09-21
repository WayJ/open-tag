// Integration test for /agent-api/knowledge/* (agent plane, cases 1-11) and
// GET /api/agents/:id/knowledge (human plane, case 12 — intentionally RED until Task 5).
// Mirrors test/channelArtifacts.integration.ts (agent plane: real agent token + direct
// handleAgentApi call, jsonReq/getReq/mkRes/call) + test/agentMigrate.integration.ts
// (human plane: JWT + direct handleApi call, makeReq/makeRes/apiCall).
// Verifies: two-tier visibility (private agentId-scoped + shared null-agentId), creator-only
// writes, searchText fixation, keyset pagination, literal-safe search (escapeLike) with
// JS-side snippets, short-id detail resolution, scope gating, cross-tenant isolation.
// Requires infra up: `npm run infra` (pg :5433, redis :6380). Run:
//   set -a; source .env; set +a; npx tsx test/knowledge.integration.ts
import "../src/env.ts";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { handleAgentApi } from "../src/server/routes-agent.ts";
import { agentConfig } from "../src/server/agentConfig.ts";
import { createServer } from "../src/server/core.ts";
import { buildSearchText, KNOWLEDGE_CONTENT_MAX, KNOWLEDGE_TITLE_MAX } from "../src/server/knowledge.ts";
import { signUser } from "../src/server/auth.ts";
import { handleApi } from "../src/server/routes-api/index.ts";
import type { AgentScopes } from "../src/server/scopes.ts";

const ts = Date.now();
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

let ownerId = "";
let memberId = "";
let ownerToken = "";
let memberToken = "";
let serverId = "";
let server2Id = "";
let agentAId = "";
let agentAToken = "";
let agentBId = "";
let agentBToken = "";
let scopeAgentId = "";
let scopeAgentToken = "";
let s2AgentId = "";
let s2AgentToken = "";

function jsonReq(path: string, token: string, aid: string, body?: unknown, method = "POST") {
  const raw = body != null ? JSON.stringify(body) : "";
  const readable = Readable.from(raw ? [Buffer.from(raw)] : []);
  return Object.assign(readable, {
    method,
    url: path,
    headers: {
      authorization: `Bearer ${token}`,
      "x-agent-id": aid,
      "content-type": "application/json",
    },
  }) as unknown as IncomingMessage;
}

function getReq(path: string, token: string, aid: string) {
  const readable = Readable.from([] as Buffer[]);
  return Object.assign(readable, {
    method: "GET",
    url: path,
    headers: { authorization: `Bearer ${token}`, "x-agent-id": aid },
  }) as unknown as IncomingMessage;
}

function mkRes() {
  let status = 0;
  let raw = "";
  const emitter = new EventEmitter();
  const finished = EventEmitter.once(emitter, "finish");
  const res = Object.assign(emitter, {
    statusCode: 0,
    headersSent: false,
    setHeader() {},
    writeHead(c: number) { status = c; this.statusCode = c; },
    end(d?: string | Buffer) { raw = d ? String(d) : ""; emitter.emit("finish"); },
  }) as unknown as ServerResponse;
  return { res, done: () => finished, status: () => status, body: () => (raw ? JSON.parse(raw) : {}) };
}

async function call(req: IncomingMessage, path: string) {
  const { res, done, status, body: getBody } = mkRes();
  await handleAgentApi(req, res, new URL(`http://localhost${path}`), (req as any).method ?? "GET");
  await done();
  return { status: status(), body: getBody() };
}

// ── human-plane helpers (agentMigrate style) ──
function makeReq(o: { method: string; path: string; token: string; serverId: string; body?: object }): IncomingMessage {
  const s = o.body ? JSON.stringify(o.body) : "";
  const r = Readable.from(s ? [Buffer.from(s)] : ([] as Buffer[]));
  return Object.assign(r, { method: o.method, url: o.path, headers: { authorization: `Bearer ${o.token}`, "x-server-id": o.serverId, "content-type": "application/json" } }) as unknown as IncomingMessage;
}
function makeRes() {
  let status = 0, body = "";
  const em = new EventEmitter();
  const res = Object.assign(em, { statusCode: 0, headersSent: false, setHeader() {}, writeHead(c: number) { status = c; this.statusCode = c; }, end(d?: string | Buffer) { body = d ? String(d) : ""; em.emit("finish"); } }) as unknown as ServerResponse;
  return { res, getStatus: () => status, getBody: () => body };
}
async function apiCall(o: { method: string; path: string; token: string; serverId: string; body?: object }) {
  const PORT = Number(process.env.PORT ?? 7801);
  const { res, getStatus, getBody } = makeRes();
  const url = new URL(o.path, `http://localhost:${PORT}`);
  try { await handleApi(makeReq(o), res, url, o.method); }
  catch (e: unknown) { res.writeHead(500); res.end(JSON.stringify({ error: "internal", detail: e instanceof Error ? e.message : String(e) })); }
  let parsed: unknown; try { parsed = JSON.parse(getBody()); } catch { parsed = getBody(); }
  return { status: getStatus(), body: parsed as any };
}

async function kCreate(token: string, aid: string, body: { title: string; content: string; shared?: boolean }) {
  return call(jsonReq("/agent-api/knowledge/create", token, aid, body), "/agent-api/knowledge/create");
}
async function kList(token: string, aid: string, qs = "") {
  return call(getReq(`/agent-api/knowledge/list${qs}`, token, aid), `/agent-api/knowledge/list${qs}`);
}
async function kSearch(token: string, aid: string, q: string) {
  return call(getReq(`/agent-api/knowledge/search?q=${encodeURIComponent(q)}`, token, aid), `/agent-api/knowledge/search?q=${encodeURIComponent(q)}`);
}
async function kDetail(token: string, aid: string, id: string) {
  return call(getReq(`/agent-api/knowledge/detail?id=${encodeURIComponent(id)}`, token, aid), `/agent-api/knowledge/detail?id=${encodeURIComponent(id)}`);
}
async function kUpdate(token: string, aid: string, body: { id: string; title?: string; content?: string }) {
  return call(jsonReq("/agent-api/knowledge/update", token, aid, body, "PATCH"), "/agent-api/knowledge/update");
}
async function kDelete(token: string, aid: string, id: string) {
  return call(jsonReq(`/agent-api/knowledge/delete?id=${encodeURIComponent(id)}`, token, aid, undefined, "DELETE"), `/agent-api/knowledge/delete?id=${encodeURIComponent(id)}`);
}
const dbRow = async (id: string) => !id ? undefined : (await db.select().from(schema.knowledge).where(eq(schema.knowledge.id, id)))[0];

async function setup() {
  const [owner] = await db.insert(schema.users).values({
    name: `owner_kb_${ts}`,
    displayName: "Owner",
    email: `owner_kb_${ts}@agent-route.local`,
  }).returning();
  ownerId = owner!.id;
  ownerToken = signUser(ownerId);
  const [member] = await db.insert(schema.users).values({
    name: `mem_kb_${ts}`,
    displayName: "Member",
    email: `mem_kb_${ts}@t.local`,
  }).returning();
  memberId = member!.id;
  memberToken = signUser(memberId);

  const srv = await createServer(`agent-knowledge-${ts}`, `agent-knowledge-${ts}`, ownerId);
  serverId = srv.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: memberId, role: "member" });

  const srv2 = await createServer(`agent-knowledge-b-${ts}`, `agent-knowledge-b-${ts}`, ownerId);
  server2Id = srv2.id;

  const mkAgent = async (sid: string, name: string) => {
    const [a] = await db.insert(schema.agents).values({
      serverId: sid,
      name,
      displayName: name,
      runtime: "claude",
      model: "sonnet",
      creatorType: "user",
      creatorId: ownerId,
    }).returning();
    const cfg = await agentConfig(a!.id);
    if (!cfg?.agentToken) throw new Error("agent token was not minted");
    return { id: a!.id, token: cfg.agentToken };
  };
  ({ id: agentAId, token: agentAToken } = await mkAgent(serverId, `kba_${ts}`));
  ({ id: agentBId, token: agentBToken } = await mkAgent(serverId, `kbb_${ts}`));
  ({ id: scopeAgentId, token: scopeAgentToken } = await mkAgent(serverId, `kbnoscope_${ts}`));
  ({ id: s2AgentId, token: s2AgentToken } = await mkAgent(server2Id, `kbs2_${ts}`));

  // Custom-scope agent: several grants but NEITHER knowledge scope (case 10).
  const granted: AgentScopes = {
    granted: ["inbox:receive", "server:read", "message:read", "message:send"],
    mode: "custom",
    revision: 1,
    updatedAt: new Date().toISOString(),
  };
  await db.update(schema.agents).set({ scopes: granted }).where(eq(schema.agents.id, scopeAgentId));
  const scopeCfg = await agentConfig(scopeAgentId);
  if (!scopeCfg?.agentToken) throw new Error("scope agent token was not minted");
  scopeAgentToken = scopeCfg.agentToken;
}

async function cleanup() {
  for (const sid of [serverId, server2Id]) {
    if (!sid) continue;
    await db.delete(schema.knowledge).where(eq(schema.knowledge.serverId, sid));
    const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, sid));
    for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
    await db.delete(schema.channels).where(eq(schema.channels.serverId, sid));
    await db.delete(schema.agents).where(eq(schema.agents.serverId, sid));
    await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, sid));
    await db.delete(schema.servers).where(eq(schema.servers.id, sid));
  }
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  await db.delete(schema.users).where(eq(schema.users.id, memberId));
}

async function main() {
  await setup();

  console.log("\n[1] create private → 200, row agentId=A createdByAgentId=A searchText fixed");
  const content1 = "prod 用 prod-up.sh 部署,先 build 再 push";
  const c1 = await kCreate(agentAToken, agentAId, { title: "部署约定", content: content1 });
  check("create returns 200 with id", c1.status === 200 && typeof (c1.body as any).id === "string");
  check("create echoes shared=false + createdAt", (c1.body as any).shared === false && !!(c1.body as any).createdAt);
  const id1 = ((c1.body as any).id as string) || "00000000-0000-0000-0000-000000000000"; // RED-phase placeholder: later cases still run and report
  const row1 = id1 ? await dbRow(id1) : undefined;
  check("DB row: private to A, created by A", !!row1 && row1!.agentId === agentAId && row1!.createdByAgentId === agentAId && row1!.serverId === serverId);
  check("DB row searchText = title\\n\\ncontent", row1?.searchText === buildSearchText("部署约定", content1));

  console.log("\n[2] create shared → row agentId=null");
  const c2 = await kCreate(agentAToken, agentAId, { title: "共享约定", content: "全员可见的共享知识", shared: true });
  check("shared create returns 200", c2.status === 200);
  const id2 = (c2.body as any).id as string;
  check("create echoes shared=true", (c2.body as any).shared === true);
  const row2 = id2 ? await dbRow(id2) : undefined;
  check("DB row: agentId=null (shared tier), createdBy=A", !!row2 && row2!.agentId === null && row2!.createdByAgentId === agentAId);

  console.log("\n[3] validation: title empty/201 chars, content empty/32KB+1 → 400");
  const v1 = await kCreate(agentAToken, agentAId, { title: "   ", content: "x" });
  check("blank title → 400", v1.status === 400);
  const v2 = await kCreate(agentAToken, agentAId, { title: "x".repeat(KNOWLEDGE_TITLE_MAX + 1), content: "x" });
  check("201-char title → 400", v2.status === 400 && (v2.body as any).limit === KNOWLEDGE_TITLE_MAX);
  const v3 = await kCreate(agentAToken, agentAId, { title: "t", content: "" });
  check("empty content → 400", v3.status === 400);
  const v4 = await kCreate(agentAToken, agentAId, { title: "t", content: "x".repeat(KNOWLEDGE_CONTENT_MAX + 1) });
  check("32KB+1 content → 400 with limit", v4.status === 400 && (v4.body as any).limit === KNOWLEDGE_CONTENT_MAX);
  const v5 = await kCreate(agentAToken, agentAId, { title: "t", content: "x".repeat(KNOWLEDGE_CONTENT_MAX) });
  check("exactly 32KB content → 200", v5.status === 200);
  const idMax = (v5.body as any).id as string;

  console.log("\n[4] list scopes: all/mine/shared, no content leak, derived mine/shared flags");
  const listA = await kList(agentAToken, agentAId, "?scope=all");
  check("A list all → 200 with exactly the 3 entries so far", listA.status === 200 && (listA.body as any).entries?.length === 3);
  const entriesA: any[] = (listA.body as any).entries ?? [];
  const e1 = entriesA.find((e) => e.id === id1);
  const e2 = entriesA.find((e) => e.id === id2);
  check("list rows carry id/title/agentId/createdByAgentId/createdAt/updatedAt", !!e1 && "title" in e1 && "agentId" in e1 && "createdByAgentId" in e1 && "createdAt" in e1 && "updatedAt" in e1);
  check("list rows do NOT leak content", entriesA.every((e) => !("content" in e) && !("searchText" in e)));
  check("private entry derived mine=true shared=false", e1?.mine === true && e1?.shared === false);
  check("shared entry derived shared=true", e2?.shared === true && e2?.mine === false);
  const mineA = await kList(agentAToken, agentAId, "?scope=mine");
  check("A scope=mine → only the private entry", mineA.status === 200 && ((mineA.body as any).entries ?? []).every((e: any) => e.mine === true) && ((mineA.body as any).entries ?? []).some((e: any) => e.id === id1) && !((mineA.body as any).entries ?? []).some((e: any) => e.id === id2));
  const sharedA = await kList(agentAToken, agentAId, "?scope=shared");
  check("A scope=shared → only the shared entry", sharedA.status === 200 && ((sharedA.body as any).entries ?? []).some((e: any) => e.id === id2) && !((sharedA.body as any).entries ?? []).some((e: any) => e.id === id1));
  const listB = await kList(agentBToken, agentBId, "?scope=all");
  const entriesB: any[] = (listB.body as any).entries ?? [];
  check("B sees the shared entry", entriesB.some((e) => e.id === id2));
  check("B does NOT see A's private entry", !entriesB.some((e) => e.id === id1) && !entriesB.some((e) => e.id === idMax));
  const mineB = await kList(agentBToken, agentBId, "?scope=mine");
  check("B scope=mine → empty (has not created anything)", mineB.status === 200 && ((mineB.body as any).entries ?? []).length === 0);

  console.log("\n[5] pagination: 55 entries → default limit 50 + before keyset second page of 5");
  const madeIds: string[] = [];
  for (let i = 0; i < 55; i++) {
    const r = await kCreate(agentBToken, agentBId, { title: `bulk_${ts}_${String(i).padStart(2, "0")}`, content: `bulk content ${i}` });
    if (r.status === 200) madeIds.push((r.body as any).id);
  }
  check("55 bulk entries created", madeIds.length === 55);
  const page1 = await kList(agentBToken, agentBId, "?scope=mine");
  const rows1: any[] = (page1.body as any).entries ?? [];
  check("page1 defaults to 50 rows with hasMore=true", rows1.length === 50 && (page1.body as any).hasMore === true);
  const page1Set = new Set(rows1.map((r) => r.id));
  check("page1 rows all distinct", page1Set.size === 50);
  const tailId = rows1[rows1.length - 1]?.id;
  const page2 = await kList(agentBToken, agentBId, `?scope=mine&before=${encodeURIComponent(tailId)}`);
  const rows2: any[] = (page2.body as any).entries ?? [];
  check("page2 via before cursor → remaining 5 rows with hasMore=false", rows2.length === 5 && (page2.body as any).hasMore === false);
  check("page2 rows disjoint from page1", rows2.every((r) => !page1Set.has(r.id)));
  check("both pages together cover all 55", new Set([...rows1, ...rows2].map((r) => r.id)).size === 55);

  console.log("\n[6] search: hits + snippet + visibility + literal % (escapeLike)");
  const c6priv = await kCreate(agentAToken, agentAId, { title: "db-note", content: "这是数据库设计文档,成功率 100%" });
  const id6priv = (c6priv.body as any).id as string;
  const c6shared = await kCreate(agentAToken, agentAId, { title: "db-shared", content: "共享的数据库设计原则,参考 100x 案例", shared: true });
  const id6shared = (c6shared.body as any).id as string;
  const sA = await kSearch(agentAToken, agentAId, "数据库");
  const hitsA: any[] = (sA.body as any).results ?? [];
  check("A search 数据库 → 200 hits both own+shared", sA.status === 200 && hitsA.some((h) => h.id === id6priv) && hitsA.some((h) => h.id === id6shared));
  check("search results carry id/title/snippet/shared/mine/createdAt", hitsA.length > 0 && hitsA.every((h) => typeof h.id === "string" && typeof h.title === "string" && typeof h.snippet === "string" && "createdAt" in h));
  const privHit = hitsA.find((h) => h.id === id6priv);
  check("snippet contains the hit segment (± ellipsis)", !!privHit && privHit.snippet.includes("数据库"));
  const sB = await kSearch(agentBToken, agentBId, "数据库");
  const hitsB: any[] = (sB.body as any).results ?? [];
  check("B search 数据库 → only the shared entry, never A's private", sB.status === 200 && hitsB.some((h) => h.id === id6shared) && !hitsB.some((h) => h.id === id6priv));
  const sForeignWord = await kSearch(agentBToken, agentBId, "prod-up.sh");
  check("B searching A's private-only word → 0 hits", sForeignWord.status === 200 && ((sForeignWord.body as any).results ?? []).length === 0);
  const sPct = await kSearch(agentAToken, agentAId, "100%");
  const hitsPct: any[] = (sPct.body as any).results ?? [];
  check("q=100% matches only the literal % entry, not the 100x one (escapeLike)", hitsPct.length === 1 && hitsPct[0]?.id === id6priv);
  const sEmpty = await kSearch(agentAToken, agentAId, "   ");
  check("blank q → 400", sEmpty.status === 400);

  console.log("\n[7] detail: full id + 8-char short id; forged/junk ids → 404 (never 500)");
  const dFull = await kDetail(agentAToken, agentAId, id1);
  check("detail by full id → 200 with content", dFull.status === 200 && (dFull.body as any).content === content1 && (dFull.body as any).title === "部署约定");
  check("detail response never exposes searchText/serverId", !("searchText" in (dFull.body as any)) && !("serverId" in (dFull.body as any)));
  const short1 = id1.slice(0, 8);
  const dShort = await kDetail(agentAToken, agentAId, short1);
  check("detail by 8-char short id → 200 same entry", dShort.status === 200 && (dShort.body as any).id === id1);
  const dForged = await kDetail(agentAToken, agentAId, "deadbeef");
  check("forged 8-hex short id → 404", dForged.status === 404);
  const dJunk = await kDetail(agentAToken, agentAId, "zz!@#");
  check("non-hex junk id → 404 (not 500)", dJunk.status === 404);
  const dForeign = await kDetail(agentBToken, agentBId, id1);
  check("B detail of A's private entry → 404 (invisible, no leak)", dForeign.status === 404);

  console.log("\n[8] update: creator-only, searchText refixed, updatedAt bumped");
  const preRow = await dbRow(id1);
  const u1 = await kUpdate(agentAToken, agentAId, { id: id1, title: "部署约定v2", content: "prod 用 prod-up.sh + db:push:prod" });
  check("A updates own entry → 200", u1.status === 200 && (u1.body as any).ok === true);
  const postRow = await dbRow(id1);
  check("searchText refixed from merged title+content", postRow?.searchText === buildSearchText("部署约定v2", "prod 用 prod-up.sh + db:push:prod"));
  check("updatedAt bumped", !!postRow && !!preRow && postRow!.updatedAt.getTime() >= preRow!.updatedAt.getTime() && postRow!.content === "prod 用 prod-up.sh + db:push:prod");
  const uTitleOnly = await kUpdate(agentAToken, agentAId, { id: id1, title: "部署约定v3" });
  const rowTitleOnly = await dbRow(id1);
  check("title-only update keeps content, refixes searchText", uTitleOnly.status === 200 && rowTitleOnly?.title === "部署约定v3" && rowTitleOnly?.content === "prod 用 prod-up.sh + db:push:prod" && rowTitleOnly?.searchText === buildSearchText("部署约定v3", "prod 用 prod-up.sh + db:push:prod"));
  const c8shared = await kCreate(agentBToken, agentBId, { title: "B的共享条目", content: "B created this shared note", shared: true });
  const id8shared = (c8shared.body as any).id as string;
  const u2 = await kUpdate(agentAToken, agentAId, { id: id8shared, title: "劫持" });
  check("A updates B's (visible shared) entry → 404 creator-only", u2.status === 404);
  check("B's entry untouched after the 404", (await dbRow(id8shared))?.title === "B的共享条目");
  const u3 = await kUpdate(agentAToken, agentAId, { id: "00000000-0000-0000-0000-000000000000", title: "ghost" });
  check("A updates nonexistent id → 404", u3.status === 404);

  console.log("\n[9] delete: creator deletes own; other agent's → 404");
  const c9 = await kCreate(agentAToken, agentAId, { title: "待删条目", content: "delete me" });
  const id9 = (c9.body as any).id as string;
  const del1 = await kDelete(agentAToken, agentAId, id9);
  check("creator delete → 200 ok", del1.status === 200 && (del1.body as any).ok === true && (del1.body as any).id === id9);
  check("DB row gone (hard delete)", !(await dbRow(id9)));
  const mineAAfter = await kList(agentAToken, agentAId, "?scope=mine");
  check("deleted entry absent from list", !((mineAAfter.body as any).entries ?? []).some((e: any) => e.id === id9));
  const del2 = await kDelete(agentBToken, agentBId, id1);
  check("B deletes A's private entry → 404", del2.status === 404);
  check("A's entry still exists after B's 404", !!(await dbRow(id1)));

  console.log("\n[10] scope gating: without knowledge:write/read → 403 on all six endpoints");
  const g1 = await kCreate(scopeAgentToken, scopeAgentId, { title: "t", content: "c" });
  check("create without knowledge:write → 403 SCOPE_DENIED", g1.status === 403 && (g1.body as any).code === "SCOPE_DENIED");
  const g2 = await kUpdate(scopeAgentToken, scopeAgentId, { id: id1, title: "x" });
  check("update without knowledge:write → 403", g2.status === 403 && (g2.body as any).code === "SCOPE_DENIED");
  const g3 = await kDelete(scopeAgentToken, scopeAgentId, id1);
  check("delete without knowledge:write → 403", g3.status === 403 && (g3.body as any).code === "SCOPE_DENIED");
  const g4 = await kList(scopeAgentToken, scopeAgentId);
  check("list without knowledge:read → 403", g4.status === 403 && (g4.body as any).code === "SCOPE_DENIED");
  const g5 = await kSearch(scopeAgentToken, scopeAgentId, "数据库");
  check("search without knowledge:read → 403", g5.status === 403 && (g5.body as any).code === "SCOPE_DENIED");
  const g6 = await kDetail(scopeAgentToken, scopeAgentId, id1);
  check("detail without knowledge:read → 403", g6.status === 403 && (g6.body as any).code === "SCOPE_DENIED");

  console.log("\n[11] tenant isolation: server2's agent sees nothing from server1 (incl. shared)");
  const t1 = await kList(s2AgentToken, s2AgentId);
  check("server2 agent list → empty", t1.status === 200 && ((t1.body as any).entries ?? []).length === 0);
  const t2 = await kSearch(s2AgentToken, s2AgentId, "数据库");
  check("server2 agent search of server1's shared word → 0 hits", t2.status === 200 && ((t2.body as any).results ?? []).length === 0);
  const t3 = await kDetail(s2AgentToken, s2AgentId, id2);
  check("server2 agent detail of server1's shared id → 404", t3.status === 404);

  console.log("\n[12] human plane: owner read-only browse (JWT) — RED until Task 5");
  const h1 = await apiCall({ method: "GET", path: `/api/agents/${agentAId}/knowledge`, token: ownerToken, serverId });
  const hRows: any[] = h1.body?.entries ?? h1.body?.knowledge ?? [];
  check("owner browse → 200 with A private + shared", h1.status === 200 && hRows.some((r) => r.id === id1) && hRows.some((r) => r.id === id2));
  check("human rows include content + createdBy mapped to agent handle", hRows.some((r) => r.id === id1 && r.content === buildSearchText("部署约定v3", "prod 用 prod-up.sh + db:push:prod").split("\n\n").slice(1).join("\n\n") && r.createdBy === `kba_${ts}`));
  const h2 = await apiCall({ method: "GET", path: `/api/agents/${agentAId}/knowledge?scope=private`, token: ownerToken, serverId });
  check("?scope=private → only agentId=A rows", h2.status === 200 && ((h2.body?.entries ?? h2.body?.knowledge ?? []) as any[]).some((r) => r.id === id1) && !((h2.body?.entries ?? h2.body?.knowledge ?? []) as any[]).some((r) => r.id === id2));
  const h3 = await apiCall({ method: "GET", path: `/api/agents/${agentAId}/knowledge?scope=shared`, token: ownerToken, serverId });
  check("?scope=shared → only shared rows", h3.status === 200 && ((h3.body?.entries ?? h3.body?.knowledge ?? []) as any[]).some((r) => r.id === id2) && !((h3.body?.entries ?? h3.body?.knowledge ?? []) as any[]).some((r) => r.id === id1));
  const h4 = await apiCall({ method: "GET", path: `/api/agents/${agentAId}/knowledge`, token: memberToken, serverId });
  check("plain member (no manageAgents) → 403", h4.status === 403);

  return { id1 };
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* */ } process.exit(1); });
