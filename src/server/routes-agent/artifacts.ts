// Agent-plane channel artifact routes: publish / list / versions (/agent-api/artifact/*).
// First split file extracted from the routes-agent.ts monolith: handleAgentApi resolves the agent
// and enforces requiredScope BEFORE mounting, so `agent` + `serverId` arrive pre-resolved.
// Return contract: true = handled (response sent), false = not ours (caller keeps routing).
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, desc, eq, inArray, max } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { isUuid, sendErr, sendJson } from "../util.js";
import { canAgentReadChannel, resolveTarget } from "../core.js";
import { parseUpload } from "../attachments.js";
import { deleteObject } from "../storage.js";

const pgCode = (e: unknown): string | undefined => (e as any)?.cause?.code ?? (e as any)?.code;

export async function handleArtifactRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  p: string,
  agent: typeof schema.agents.$inferSelect,
  serverId: string,
): Promise<boolean> {
  if (!p.startsWith("/agent-api/artifact/")) return false;

  // publish: multipart (files + channel/target + name + description? + note?) → versioned artifact.
  // Reuses the attachment upload's MIME pipeline (sanitizeMimeType + magic-byte sniff) by inserting
  // a real attachments row, then pointers: artifacts (1 per channel+name) + artifact_versions.
  if (p === "/agent-api/artifact/publish" && method === "POST") {
    const { fields, files } = await parseUpload(req);
    // STRICT single-file contract: parseUpload has already persisted EVERY part to storage by the
    // time it resolves — keeping only files[0] would orphan the rest on disk (no DB row, no cleanup
    // path) and make the "winner" completion-order dependent. Reject and delete all stored objects.
    if (files.length > 1) {
      for (const f of files) await deleteObject(f.storageKey).catch(() => {});
      return (sendErr(res, 400, "single file required"), true);
    }
    const f = files[0];
    if (!f) return (sendErr(res, 400, "file required"), true);
    // Anything that fails below has already stored the object — clean it up on the way out.
    const fail = async (code: number, error: string, extra: Record<string, unknown> = {}) => {
      await deleteObject(f.storageKey).catch(() => {});
      sendErr(res, code, error, extra);
      return true;
    };
    const tgt = await resolveTarget(serverId, fields.channel ?? fields.target ?? "", agent.id);
    if (!tgt) return await fail(404, "target not found", { code: "TARGET_FAILED" });
    const chId = tgt.channelId;
    // Gate on the channel row, not tgt.threadId: resolveTarget normalizes thread targets to the
    // thread channel and always reports threadId=null, so the thread-ness is only visible in ch.type.
    const ch = (await db.select().from(schema.channels).where(eq(schema.channels.id, chId)))[0];
    if (ch?.type === "thread") return await fail(400, "artifacts publish to channels, not threads");
    const name = String(fields.name ?? "").trim();
    if (!name || name.length > 200) return await fail(400, "name required (1-200 chars)");
    const description = String(fields.description ?? "").trim() || null;
    const note = String(fields.note ?? "").trim() || null;
    // Agent-controlled text echoed back by list/versions — cap it (busboy's 1MB field limit is far too generous).
    if (description && description.length > 4000) return await fail(400, "description too long (max 4000 chars)");
    if (note && note.length > 2000) return await fail(400, "note too long (max 2000 chars)");

    const [att] = await db.insert(schema.attachments).values({
      serverId, channelId: chId, uploaderType: "agent", uploaderId: agent.id,
      filename: f.filename, mimeType: f.mimeType, sizeBytes: f.size, storageKey: f.storageKey,
    }).returning();

    const attempt = () => db.transaction(async (tx) => {
      let art = (await tx.select().from(schema.artifacts).where(and(eq(schema.artifacts.serverId, serverId), eq(schema.artifacts.channelId, chId), eq(schema.artifacts.name, name))).limit(1))[0];
      if (!art) {
        [art] = await tx.insert(schema.artifacts).values({ serverId, channelId: chId, name, description, createdByType: "agent", createdByAgentId: agent.id }).returning();
      } else if (description !== null) {
        await tx.update(schema.artifacts).set({ description, updatedAt: new Date() }).where(eq(schema.artifacts.id, art!.id));
      }
      const mx = (await tx.select({ v: max(schema.artifactVersions.version) }).from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, art!.id)))[0]?.v ?? 0;
      const [ver] = await tx.insert(schema.artifactVersions).values({
        artifactId: art!.id, serverId, channelId: chId, version: mx! + 1, attachmentId: att!.id,
        note, createdByType: "agent", createdByAgentId: agent.id,
      }).returning();
      await tx.update(schema.artifacts).set({ updatedAt: new Date() }).where(eq(schema.artifacts.id, art!.id));
      return { artifactId: art!.id, version: ver!.version };
    });
    // (channelId, name) has a partial-free unique index: a concurrent publish of the same name can
    // violate it mid-transaction. Retry once — the retry sees the winner's row and appends a version.
    let out: { artifactId: string; version: number };
    try {
      out = await attempt();
    } catch (e) {
      if (pgCode(e) !== "23505") throw e;
      try {
        out = await attempt();
      } catch (e2) {
        if (pgCode(e2) === "23505") {
          await deleteObject(att!.storageKey).catch(() => {});
          // Both transaction attempts rolled back, so nothing references the attachment row (the
          // artifact_versions attUniq index proves it) — drop it too instead of leaving a dangling row.
          await db.delete(schema.attachments).where(eq(schema.attachments.id, att!.id)).catch(() => {});
          return (sendErr(res, 409, "concurrent publish conflict, retry", { code: "CONCURRENT_PUBLISH" }), true);
        }
        throw e2;
      }
    }
    return (sendJson(res, 200, { ok: true, artifactId: out.artifactId, name, version: out.version, attachmentId: att!.id, filename: att!.filename, mimeType: att!.mimeType }), true);
  }

  // list: artifacts of one channel with their latest version (two-step: versions by artifactIds,
  // max picked in memory — per-channel artifact counts are small). updatedAt descending.
  if (p === "/agent-api/artifact/list" && method === "GET") {
    const tgt = await resolveTarget(serverId, url.searchParams.get("channel") ?? "", agent.id);
    if (!tgt) return (sendErr(res, 404, "channel not found", { code: "TARGET_FAILED" }), true);
    const chId = tgt.channelId; // a thread target resolves to its (artifact-less) thread channel → empty list
    const arts = await db.select().from(schema.artifacts).where(and(eq(schema.artifacts.serverId, serverId), eq(schema.artifacts.channelId, chId)));
    const vers = arts.length
      ? await db.select().from(schema.artifactVersions).where(and(eq(schema.artifactVersions.serverId, serverId), inArray(schema.artifactVersions.artifactId, arts.map((a) => a.id))))
      : [];
    const latest = new Map<string, typeof schema.artifactVersions.$inferSelect>();
    for (const v of vers) {
      const cur = latest.get(v.artifactId);
      if (!cur || v.version > cur.version) latest.set(v.artifactId, v);
    }
    const latestAttIds = [...new Set([...latest.values()].map((v) => v.attachmentId))];
    const atts = latestAttIds.length ? await db.select({ id: schema.attachments.id, mimeType: schema.attachments.mimeType }).from(schema.attachments).where(inArray(schema.attachments.id, latestAttIds)) : [];
    const mimeById = new Map(atts.map((a) => [a.id, a.mimeType]));
    const rows = arts
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((a) => {
        const lv = latest.get(a.id);
        return {
          id: a.id, name: a.name, description: a.description,
          latestVersion: lv?.version ?? null,
          latestAttachmentId: lv?.attachmentId ?? null,
          latestMime: lv ? mimeById.get(lv.attachmentId) ?? null : null,
          updatedAt: a.updatedAt,
        };
      });
    return (sendJson(res, 200, { artifacts: rows }), true);
  }

  // versions: history of one artifact — by id, or by channel+name. 404 when missing or the agent
  // cannot read the artifact's channel (never reveal existence across the channel boundary).
  if (p === "/agent-api/artifact/versions" && method === "GET") {
    const idParam = (url.searchParams.get("id") ?? "").trim();
    const channelParam = url.searchParams.get("channel");
    const nameParam = (url.searchParams.get("name") ?? "").trim();
    let art: typeof schema.artifacts.$inferSelect | undefined;
    if (idParam) {
      // uuid-shape gate: a short id into a uuid column casts → 500 (see util.ts isUuid contract)
      if (!isUuid(idParam)) return (sendErr(res, 404, "artifact not found"), true);
      art = (await db.select().from(schema.artifacts).where(and(eq(schema.artifacts.id, idParam), eq(schema.artifacts.serverId, serverId))))[0];
    } else if (channelParam != null && nameParam) {
      const tgt = await resolveTarget(serverId, channelParam, agent.id);
      if (!tgt) return (sendErr(res, 404, "channel not found", { code: "TARGET_FAILED" }), true);
      art = (await db.select().from(schema.artifacts).where(and(
        eq(schema.artifacts.serverId, serverId),
        eq(schema.artifacts.channelId, tgt.channelId),
        eq(schema.artifacts.name, nameParam),
      )))[0];
    } else {
      return (sendErr(res, 400, "id or channel+name required"), true);
    }
    if (!art) return (sendErr(res, 404, "artifact not found"), true);
    if (!(await canAgentReadChannel(serverId, art.channelId, agent.id))) return (sendErr(res, 404, "artifact not found"), true);
    const rows = await db.select({
      version: schema.artifactVersions.version,
      attachmentId: schema.artifactVersions.attachmentId,
      note: schema.artifactVersions.note,
      createdAt: schema.artifactVersions.createdAt,
      filename: schema.attachments.filename,
      mimeType: schema.attachments.mimeType,
    }).from(schema.artifactVersions)
      .innerJoin(schema.attachments, eq(schema.attachments.id, schema.artifactVersions.attachmentId))
      .where(and(eq(schema.artifactVersions.artifactId, art.id), eq(schema.artifactVersions.serverId, serverId)))
      .orderBy(desc(schema.artifactVersions.version));
    return (sendJson(res, 200, { versions: rows }), true);
  }

  return false;
}
