// Unit test (DB-backed): artifact metadata on both serialization paths.
// Tests: core.artifactMetaByAttachmentIds batch lookup, serializeMsg optional artifactMeta param
// (back-compat: no meta → no artifact keys), and shared.attachMentions REST path carrying the fields.
// Requires infra up: `npm run infra` (pg :5433) and the worktree DB (opentag_channel_artifacts).
// Run: JWT_SECRET=x DAEMON_BOOTSTRAP_KEY=y npx tsx --test --test-force-exit test/artifactMeta.unit.test.ts
import "../src/env.js"; // load .env before any DB/auth/redis import
import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { artifactMetaByAttachmentIds, serializeMsg } from "../src/server/core.ts";
import { attachMentions } from "../src/server/routes-api/shared.ts";

const ts = Date.now();
let serverId = "", ownerId = "", channelId = "", msgId = "";
let attMainId = "", attV1Id = "", attSumId = "", attPlainId = "";

test("setup: seed server/channel/message/attachments + artifact with v1→other-attachment, v2→main-attachment", { timeout: 15000 }, async () => {
  const [u] = await db.insert(schema.users).values({ name: `am_${ts}`, displayName: "Artifact Meta", email: `am_${ts}@t.local` }).returning();
  ownerId = u!.id;
  const [srv] = await db.insert(schema.servers).values({ name: "T", slug: `am-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });
  const [ch] = await db.insert(schema.channels).values({ serverId, name: `am-${ts}`, type: "channel" }).returning();
  channelId = ch!.id;
  await db.insert(schema.channelMembers).values({ channelId, memberType: "user", memberId: ownerId });
  const [msg] = await db.insert(schema.messages).values({ serverId, channelId, senderType: "user", senderId: ownerId, senderName: `am_${ts}`, content: "artifact msg", seq: 1 }).returning();
  msgId = msg!.id;

  const [attMain] = await db.insert(schema.attachments).values({
    messageId: msgId, channelId, serverId, uploaderType: "user", uploaderId: ownerId,
    filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 10, storageKey: `/tmp/am-${ts}-report.pdf`,
  }).returning();
  attMainId = attMain!.id;
  // v1 lives on a DIFFERENT attachment (not linked to the message) — proves selection follows the attachmentId join.
  const [attV1] = await db.insert(schema.attachments).values({
    channelId, serverId, uploaderType: "user", uploaderId: ownerId,
    filename: "report-v1.pdf", mimeType: "application/pdf", sizeBytes: 5, storageKey: `/tmp/am-${ts}-report-v1.pdf`,
  }).returning();
  attV1Id = attV1!.id;

  const [art] = await db.insert(schema.artifacts).values({
    serverId, channelId, name: "report", description: "desc text", createdByType: "user", createdByUserId: ownerId,
  }).returning();
  await db.insert(schema.artifactVersions).values([
    { artifactId: art!.id, serverId, channelId, version: 1, attachmentId: attV1Id, createdByType: "user", createdByUserId: ownerId },
    { artifactId: art!.id, serverId, channelId, version: 2, attachmentId: attMainId, createdByType: "user", createdByUserId: ownerId },
  ]);

  // Second artifact (null description) + a PLAIN attachment on the same message (no version row) —
  // exercises multi-row map construction and per-attachment conditional spread.
  const [attSum] = await db.insert(schema.attachments).values({
    messageId: msgId, channelId, serverId, uploaderType: "user", uploaderId: ownerId,
    filename: "summary.md", mimeType: "text/markdown", sizeBytes: 3, storageKey: `/tmp/am-${ts}-summary.md`,
  }).returning();
  attSumId = attSum!.id;
  const [attPlain] = await db.insert(schema.attachments).values({
    messageId: msgId, channelId, serverId, uploaderType: "user", uploaderId: ownerId,
    filename: "plain.txt", mimeType: "text/plain", sizeBytes: 1, storageKey: `/tmp/am-${ts}-plain.txt`,
  }).returning();
  attPlainId = attPlain!.id;
  const [art2] = await db.insert(schema.artifacts).values({
    serverId, channelId, name: "summary", description: null, createdByType: "user", createdByUserId: ownerId,
  }).returning();
  await db.insert(schema.artifactVersions).values({
    artifactId: art2!.id, serverId, channelId, version: 1, attachmentId: attSumId, createdByType: "user", createdByUserId: ownerId,
  });
});

test("artifactMetaByAttachmentIds returns the version joined via THIS attachment's id (v2, not max/v1)", { timeout: 15000 }, async () => {
  const meta = await artifactMetaByAttachmentIds([attMainId, attV1Id]);
  assert.ok(meta instanceof Map);
  assert.deepEqual(meta.get(attMainId), { artifactName: "report", artifactVersion: 2, artifactDescription: "desc text" });
  // join semantics → v1 here; a wrong max(version)-per-artifact implementation would return v2 for BOTH
  assert.deepEqual(meta.get(attV1Id), { artifactName: "report", artifactVersion: 1, artifactDescription: "desc text" });
  assert.equal(meta.size, 2);
});

test("artifactMetaByAttachmentIds([]) returns an empty Map (no query)", { timeout: 15000 }, async () => {
  const meta = await artifactMetaByAttachmentIds([]);
  assert.ok(meta instanceof Map);
  assert.equal(meta.size, 0);
});

test("serializeMsg with meta merges artifact fields into attachments", { timeout: 15000 }, async () => {
  const msg = (await db.select().from(schema.messages).where(eq(schema.messages.id, msgId)))[0]!;
  const att = (await db.select().from(schema.attachments).where(eq(schema.attachments.id, attMainId)))[0]!;
  const meta = await artifactMetaByAttachmentIds([attMainId]);
  const out: any = serializeMsg(msg, [], [att], [], meta);
  assert.equal(out.attachments[0].artifactName, "report");
  assert.equal(out.attachments[0].artifactVersion, 2);
  assert.equal(out.attachments[0].artifactDescription, "desc text");
});

test("serializeMsg without meta param stays back-compat (no artifactName key)", { timeout: 15000 }, async () => {
  const msg = (await db.select().from(schema.messages).where(eq(schema.messages.id, msgId)))[0]!;
  const att = (await db.select().from(schema.attachments).where(eq(schema.attachments.id, attMainId)))[0]!;
  const out: any = serializeMsg(msg, [], [att]);
  assert.ok(!("artifactName" in out.attachments[0]));
  assert.ok(!("artifactVersion" in out.attachments[0]));
  assert.ok(!("artifactDescription" in out.attachments[0]));
});

test("attachMentions (REST history path) carries artifactVersion on linked attachments", { timeout: 15000 }, async () => {
  const msgs = await db.select().from(schema.messages).where(eq(schema.messages.id, msgId));
  const out: any[] = await attachMentions(msgs);
  const atts = out[0].attachments;
  const main = atts.find((a: any) => a.id === attMainId)!;
  assert.equal(main.artifactName, "report");
  assert.equal(main.artifactVersion, 2);
  assert.equal(main.artifactDescription, "desc text");
});

test("mixed attachments: fields are per-attachment conditional (artifact, second artifact, plain sibling)", { timeout: 15000 }, async () => {
  const msgs = await db.select().from(schema.messages).where(eq(schema.messages.id, msgId));
  const out: any[] = await attachMentions(msgs);
  const atts = out[0].attachments;
  assert.equal(atts.length, 3); // main + summary (artifact-linked) + plain (no version row)
  // second artifact, multi-row map construction, null description survives
  const sum = atts.find((a: any) => a.id === attSumId)!;
  assert.equal(sum.artifactName, "summary");
  assert.equal(sum.artifactVersion, 1);
  assert.equal(sum.artifactDescription, null);
  // plain sibling in the SAME map call gets no artifact keys
  const plain = atts.find((a: any) => a.id === attPlainId)!;
  assert.ok(!("artifactName" in plain));
  assert.ok(!("artifactVersion" in plain));
  assert.ok(!("artifactDescription" in plain));
});

test("cleanup", { timeout: 15000 }, async () => {
  await db.delete(schema.artifactVersions).where(eq(schema.artifactVersions.serverId, serverId));
  await db.delete(schema.artifacts).where(eq(schema.artifacts.serverId, serverId));
  await db.delete(schema.attachments).where(eq(schema.attachments.serverId, serverId));
  await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, msgId));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, channelId));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
});
