// Integration test for /agent-api/artifact/publish|list|versions.
// Mirrors test/taskAssignAgent.integration.ts: real agent token + direct handleAgentApi call.
// Verifies the agent-plane channel artifact endpoints: versioned publish (reusing the attachment
// MIME pipeline), per-channel naming, target/thread/scope guards, list + versions ordering,
// and cross-server isolation.
// Requires infra up: `npm run infra` (pg :5433, redis :6380). Run: npx tsx test/channelArtifacts.integration.ts
import "../src/env.ts";
import { EventEmitter } from "node:events";
import { readdir } from "node:fs/promises";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { handleAgentApi } from "../src/server/routes-agent.ts";
import { agentConfig } from "../src/server/agentConfig.ts";
import { createMessage, createServer } from "../src/server/core.ts";
import { deleteObject } from "../src/server/storage.ts";
import { uploadsDir } from "../src/paths.ts";
import type { AgentScopes } from "../src/server/scopes.ts";

const ts = Date.now();
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

let ownerId = "";
let serverId = "";
let server2Id = "";
let channelId = "";
let channelName = "";
let channel2Id = "";
let privateChannelId = "";
let privateChannelName = "";
let agentId = "";
let agentToken = "";
let scopeAgentId = "";
let scopeAgentToken = "";
let outsiderId = "";
let outsiderToken = "";

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function jsonReq(path: string, token: string, aid: string, body?: unknown) {
  const raw = body ? JSON.stringify(body) : "";
  const readable = Readable.from(raw ? [Buffer.from(raw)] : []);
  return Object.assign(readable, {
    method: "POST",
    url: path,
    headers: {
      authorization: `Bearer ${token}`,
      "x-agent-id": aid,
      "content-type": "application/json",
    },
  }) as unknown as IncomingMessage;
}

function multipartReq(path: string, token: string, aid: string, fields: Record<string, string>, files: { filename: string; mime: string; data: Buffer }[]) {
  const boundary = `otart-${ts}`;
  const head = Buffer.from(
    Object.entries(fields).map(([n, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`).join("")
  );
  const fileParts = files.flatMap((f) => [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\nContent-Type: ${f.mime}\r\n\r\n`),
    f.data,
    Buffer.from(`\r\n`),
  ]);
  const tail = Buffer.from(`--${boundary}--\r\n`);
  const readable = Readable.from([Buffer.concat([head, ...fileParts, tail])]);
  return Object.assign(readable, {
    method: "POST",
    url: path,
    headers: {
      authorization: `Bearer ${token}`,
      "x-agent-id": aid,
      "content-type": `multipart/form-data; boundary=${boundary}`,
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

async function publish(fields: Record<string, string>, token = agentToken, aid = agentId, files?: { filename: string; mime: string; data: Buffer }[]) {
  const fs = files ?? [{ filename: "report.png", mime: "application/octet-stream", data: PNG_HEAD }];
  return call(multipartReq("/agent-api/artifact/publish", token, aid, fields, fs), "/agent-api/artifact/publish");
}

async function setup() {
  const [owner] = await db.insert(schema.users).values({
    name: `owner_art_${ts}`,
    displayName: "Owner",
    email: `owner_art_${ts}@agent-route.local`,
  }).returning();
  ownerId = owner!.id;

  const srv = await createServer(`channel-artifacts-${ts}`, `channel-artifacts-${ts}`, ownerId);
  serverId = srv.id;
  const ch = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.name, "all"))))[0]!;
  channelId = ch.id;
  channelName = ch.name;
  const [ch2] = await db.insert(schema.channels).values({ serverId, name: `lab_${ts}`, type: "channel" }).returning();
  channel2Id = ch2!.id;
  const [priv] = await db.insert(schema.channels).values({ serverId, name: `priv_art_${ts}`, type: "private" }).returning();
  privateChannelId = priv!.id;
  privateChannelName = priv!.name;

  const [agent] = await db.insert(schema.agents).values({
    serverId,
    name: `publisher_${ts}`,
    displayName: "Publisher",
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: ownerId,
  }).returning();
  agentId = agent!.id;

  // Custom-scope agent: everything except attachment:upload (case 8)
  const [scopeAgent] = await db.insert(schema.agents).values({
    serverId,
    name: `noscope_${ts}`,
    displayName: "NoUpload",
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: ownerId,
  }).returning();
  scopeAgentId = scopeAgent!.id;

  // Outsider agent: DEFAULT scopes (all granted) but NO channel memberships (case 7) —
  // its 404 must come from resolveTarget's channel visibility gate, not the scope pre-check.
  const [outsider] = await db.insert(schema.agents).values({
    serverId,
    name: `outsider_${ts}`,
    displayName: "Outsider",
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: ownerId,
  }).returning();
  outsiderId = outsider!.id;

  await db.insert(schema.channelMembers).values([
    { channelId, memberType: "agent", memberId: agentId },
    { channelId: channel2Id, memberType: "agent", memberId: agentId },
  ]).onConflictDoNothing();

  const cfg = await agentConfig(agentId);
  if (!cfg?.agentToken) throw new Error("agent token was not minted");
  agentToken = cfg.agentToken;

  // Second server (cross-tenant isolation, case 10) — artifacts inserted directly, no agent plane
  const srv2 = await createServer(`channel-artifacts-b-${ts}`, `channel-artifacts-b-${ts}`, ownerId);
  server2Id = srv2.id;
  const chB = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, server2Id), eq(schema.channels.name, "all"))))[0]!;

  // Custom scopes for the no-upload agent (written after agentConfig minted its token)
  const granted: AgentScopes = {
    granted: ["inbox:receive", "server:read", "message:read", "message:send", "attachment:view"],
    mode: "custom",
    revision: 1,
    updatedAt: new Date().toISOString(),
  };
  await db.update(schema.agents).set({ scopes: granted }).where(eq(schema.agents.id, scopeAgentId));
  const scopeCfg = await agentConfig(scopeAgentId);
  if (!scopeCfg?.agentToken) throw new Error("scope agent token was not minted");
  scopeAgentToken = scopeCfg.agentToken;

  const outsiderCfg = await agentConfig(outsiderId);
  if (!outsiderCfg?.agentToken) throw new Error("outsider token was not minted");
  outsiderToken = outsiderCfg.agentToken;

  return { server2ChannelId: chB.id, server2Name: `secret_${ts}` };
}

let crossServerArtifactId = "";

async function seedCrossServerArtifact(server2ChannelId: string, name: string) {
  const [att] = await db.insert(schema.attachments).values({
    serverId: server2Id,
    channelId: server2ChannelId,
    uploaderType: "user",
    uploaderId: ownerId,
    filename: `${name}.txt`,
    mimeType: "text/plain",
    sizeBytes: 3,
    storageKey: `cross-${ts}__${name}.txt`,
  }).returning();
  const [art] = await db.insert(schema.artifacts).values({
    serverId: server2Id,
    channelId: server2ChannelId,
    name,
    createdByType: "user",
    createdByUserId: ownerId,
  }).returning();
  await db.insert(schema.artifactVersions).values({
    artifactId: art!.id,
    serverId: server2Id,
    channelId: server2ChannelId,
    version: 1,
    attachmentId: att!.id,
    createdByType: "user",
    createdByUserId: ownerId,
  });
  return art!.id;
}

async function cleanup() {
  for (const sid of [serverId, server2Id]) {
    if (!sid) continue;
    const atts = await db.select({ storageKey: schema.attachments.storageKey }).from(schema.attachments).where(eq(schema.attachments.serverId, sid));
    for (const a of atts) { if (!a.storageKey.startsWith("cross-")) { try { await deleteObject(a.storageKey); } catch { /* */ } } }
    await db.delete(schema.artifactVersions).where(eq(schema.artifactVersions.serverId, sid));
    await db.delete(schema.artifacts).where(eq(schema.artifacts.serverId, sid));
    await db.delete(schema.attachments).where(eq(schema.attachments.serverId, sid));

    const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, sid));
    await db.delete(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.serverId, sid));
    for (const m of msgs) await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
    await db.delete(schema.messages).where(eq(schema.messages.serverId, sid));

    const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, sid));
    for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
    await db.delete(schema.channels).where(eq(schema.channels.serverId, sid));

    await db.delete(schema.agents).where(eq(schema.agents.serverId, sid));
    await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, sid));
    await db.delete(schema.servers).where(eq(schema.servers.id, sid));
  }
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

async function main() {
  const { server2ChannelId } = await setup();
  crossServerArtifactId = await seedCrossServerArtifact(server2ChannelId, `secret_${ts}`);

  console.log("\n[1] first publish → v1, DB rows, MIME pipeline reused (octet-stream PNG → image/png)");
  const p1 = await publish({ channel: `#${channelName}`, name: "design-doc", note: "first drop" });
  check("publish returns 200", p1.status === 200);
  check("publish returns version 1 + name", (p1.body as any).version === 1 && (p1.body as any).name === "design-doc");
  let artRow = (await db.select().from(schema.artifacts).where(and(eq(schema.artifacts.serverId, serverId), eq(schema.artifacts.name, "design-doc"))))[0];
  check("artifact row exists in channel", !!artRow && artRow!.channelId === channelId);
  check("artifact description is null when omitted", artRow?.description === null);
  const verRow = artRow ? (await db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, artRow!.id)))[0] : undefined;
  check("artifact_versions row version=1 with attachmentId", !!verRow && verRow!.version === 1 && !!verRow!.attachmentId);
  const attRow = verRow ? (await db.select().from(schema.attachments).where(eq(schema.attachments.id, verRow!.attachmentId)))[0] : undefined;
  check("attachment went through MIME sniff: octet-stream PNG stored as image/png", attRow?.mimeType === "image/png");
  check("attachment bound to channel + agent uploader", attRow?.channelId === channelId && attRow?.uploaderType === "agent" && attRow?.uploaderId === agentId);

  // Resilience: when the endpoint is missing (RED phase) no row exists — continue with a
  // placeholder id so every later case still runs and reports instead of crashing.
  if (!artRow) (artRow as any) = { id: "00000000-0000-0000-0000-000000000000", channelId };

  console.log("\n[2] republish same name → v2; description update lands on artifacts row");
  const p2 = await publish({ channel: `#${channelName}`, name: "design-doc", description: "final design", note: "second drop" });
  check("republish returns version 2", (p2.body as any).version === 2);
  const art2 = (await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, artRow!.id)))[0];
  check("artifacts.description updated to new value", art2?.description === "final design");
  const verCount = (await db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, artRow!.id))).length;
  check("two version rows for the artifact", verCount === 2);

  console.log("\n[3] same name in a different channel → independent artifact (each v1)");
  const p3 = await publish({ channel: `#lab_${ts}`, name: "design-doc" });
  check("other-channel publish returns version 1", p3.status === 200 && (p3.body as any).version === 1);
  const labArts = await db.select().from(schema.artifacts).where(and(eq(schema.artifacts.serverId, serverId), eq(schema.artifacts.name, "design-doc")));
  check("two artifact rows share the name across channels", labArts.length === 2 && new Set(labArts.map((a) => a.channelId)).size === 2);

  console.log("\n[4] unresolvable target → 404 TARGET_FAILED, no null-channel rows");
  const p4 = await publish({ channel: `#nope_${ts}`, name: "ghost" });
  check("publish to unknown channel → 404", p4.status === 404 && (p4.body as any).code === "TARGET_FAILED");
  const ghosts = await db.select().from(schema.artifacts).where(eq(schema.artifacts.name, "ghost"));
  check("no artifact row was created", ghosts.length === 0);

  console.log("\n[5] thread target → 400 (thread channels are not artifact homes)");
  const parent = await createMessage({ serverId, channelId, senderType: "user", senderId: ownerId, senderName: `owner_art_${ts}`, content: "thread anchor" });
  const p5 = await publish({ channel: `thread:${parent.id.slice(0, 8)}`, name: "thread-art" });
  check("publish to bare thread:shortid target → 400", p5.status === 400);
  const p5b = await publish({ channel: `#${channelName}:${parent.id.slice(0, 8)}`, name: "thread-art" });
  check("publish to #chan:shortid thread form → 400", p5b.status === 400);
  const threadArts = await db.select().from(schema.artifacts).where(eq(schema.artifacts.name, "thread-art"));
  check("no artifact row landed in the thread channel", threadArts.length === 0);

  console.log("\n[6] name validation: empty and 201 chars → 400; stored objects are cleaned up");
  const objsBefore = (await readdir(uploadsDir())).length;
  const p6a = await publish({ channel: `#${channelName}`, name: "   " });
  check("empty name → 400", p6a.status === 400);
  const p6b = await publish({ channel: `#${channelName}`, name: "x".repeat(201) });
  check("201-char name → 400", p6b.status === 400);
  check("failed publishes left no stored objects behind (fail() cleanup contract)", (await readdir(uploadsDir())).length === objsBefore);

  console.log("\n[6b] multi-file publish → 400, all stored objects rejected, no rows");
  const pMulti = await publish({ channel: `#${channelName}`, name: "multi" }, agentToken, agentId, [
    { filename: "a.png", mime: "application/octet-stream", data: PNG_HEAD },
    { filename: "b.png", mime: "application/octet-stream", data: PNG_HEAD },
  ]);
  check("two-file publish → 400 single file required", pMulti.status === 400);
  check("no attachment row for a multi-file publish", ((await db.select().from(schema.attachments).where(and(eq(schema.attachments.serverId, serverId), inArray(schema.attachments.filename, ["a.png", "b.png"])))).length) === 0);
  check("no artifact row for a multi-file publish", ((await db.select().from(schema.artifacts).where(eq(schema.artifacts.name, "multi"))).length) === 0);

  console.log("\n[7] non-member agent (full default scopes) publishing to a private channel → 404 (resolveTarget gate)");
  const p7 = await publish({ channel: `#${privateChannelName}`, name: "sneaky" }, outsiderToken, outsiderId);
  check("non-member private publish → 404 TARGET_FAILED (existence hidden by resolveTarget, not scope)", p7.status === 404 && (p7.body as any).code === "TARGET_FAILED");
  const sneaky = await db.select().from(schema.artifacts).where(eq(schema.artifacts.name, "sneaky"));
  check("no artifact row in the private channel", sneaky.length === 0);

  console.log("\n[8] custom scope without attachment:upload → 403");
  const p8 = await publish({ channel: `#${channelName}`, name: "scoped-out" }, scopeAgentToken, scopeAgentId);
  check("publish without attachment:upload → 403", p8.status === 403 && (p8.body as any).code === "SCOPE_DENIED");

  console.log("\n[9] list → latestVersion + updatedAt desc; versions → desc with note");
  await publish({ channel: `#${channelName}`, name: "alpha", note: "alpha v1" });
  await publish({ channel: `#${channelName}`, name: "zulu", note: "zulu v1" });
  await publish({ channel: `#${channelName}`, name: "alpha", note: "alpha v2" });
  const list = await call(getReq(`/agent-api/artifact/list?channel=${encodeURIComponent(`#${channelName}`)}`, agentToken, agentId), `/agent-api/artifact/list?channel=${encodeURIComponent(`#${channelName}`)}`);
  check("list returns 200", list.status === 200);
  const arts = (list.body as any).artifacts ?? [];
  check("list shows exactly the 3 channel artifacts", arts.length === 3);
  check("list sorted updatedAt desc (alpha republished last)", arts[0]?.name === "alpha" && arts[0]?.latestVersion === 2);
  check("zulu latestVersion is 1", arts.find((a: any) => a.name === "zulu")?.latestVersion === 1);
  check("list rows carry id/name/description/latestAttachmentId/latestMime", !!arts[0]?.id && typeof arts[0]?.name === "string" && !!arts[0]?.latestAttachmentId && arts[0]?.latestMime === "image/png");
  const alphaId = arts.find((a: any) => a.name === "alpha")?.id;
  const vers = await call(getReq(`/agent-api/artifact/versions?id=${alphaId}`, agentToken, agentId), `/agent-api/artifact/versions?id=${alphaId}`);
  check("versions returns 200", vers.status === 200);
  const vrows = (vers.body as any).versions ?? [];
  check("versions sorted desc (2,1) with note + filename + mimeType", vrows.length === 2 && vrows[0]?.version === 2 && vrows[1]?.version === 1);
  check("versions carry note/filename/mimeType", vrows[0]?.note === "alpha v2" && vrows[0]?.filename === "report.png" && vrows[0]?.mimeType === "image/png");
  const versByName = await call(getReq(`/agent-api/artifact/versions?channel=${encodeURIComponent(`#${channelName}`)}&name=zulu`, agentToken, agentId), `/agent-api/artifact/versions?channel=${encodeURIComponent(`#${channelName}`)}&name=zulu`);
  check("versions by channel+name resolves the right artifact", versByName.status === 200 && (versByName.body as any).versions?.[0]?.note === "zulu v1");

  console.log("\n[10] cross-tenant: second server's artifact invisible to list/versions");
  const list2 = await call(getReq(`/agent-api/artifact/list?channel=${encodeURIComponent(`#${channelName}`)}`, agentToken, agentId), `/agent-api/artifact/list?channel=${encodeURIComponent(`#${channelName}`)}`);
  const names = ((list2.body as any).artifacts ?? []).map((a: any) => a.name);
  check("cross-server artifact name absent from list", !names.includes(`secret_${ts}`));
  const vCross = await call(getReq(`/agent-api/artifact/versions?id=${crossServerArtifactId}`, agentToken, agentId), `/agent-api/artifact/versions?id=${crossServerArtifactId}`);
  check("cross-server versions by id → 404", vCross.status === 404);
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* */ } process.exit(1); });
