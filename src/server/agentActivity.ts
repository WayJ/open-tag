import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export interface AgentActivityItem {
  timestamp: number;
  kind: string;
  activity?: string | null;
  detail?: string | null;
  text?: string | null;
  toolName?: string | null;
  toolInput?: string | null;
}

export interface AgentActivityClaim {
  streamId: string;
  rows: (typeof schema.agentActivityLog.$inferSelect)[];
  items: AgentActivityItem[];
}

export const ACTIVITY_LOG_CAP = 500;

export function activityItem(row: typeof schema.agentActivityLog.$inferSelect): AgentActivityItem {
  return {
    timestamp: row.ts,
    kind: row.kind,
    activity: row.activity,
    detail: row.detail,
    text: row.text,
    toolName: row.toolName,
    toolInput: row.toolInput,
  };
}

export async function pruneAgentActivityLog(agentId: string): Promise<void> {
  const keep = db.select({ id: schema.agentActivityLog.id }).from(schema.agentActivityLog)
    .where(eq(schema.agentActivityLog.agentId, agentId)).orderBy(desc(schema.agentActivityLog.ts)).limit(ACTIVITY_LOG_CAP);
  await db.delete(schema.agentActivityLog).where(and(eq(schema.agentActivityLog.agentId, agentId), notInArray(schema.agentActivityLog.id, keep)));
}

export async function logActivity(serverId: string, agentId: string, e: any, ctx: { channelId?: string | null; streamId?: string | null; runSeq?: number | null } = {}): Promise<AgentActivityItem | null> {
  const kind = e.kind === "tool" ? "tool_start" : (e.kind || (e.toolName ? "tool_start" : "text"));
  const ts = Number(e.timestamp ?? Date.now());
  try {
    const [row] = await db.insert(schema.agentActivityLog).values({
      serverId, agentId, ts, kind,
      activity: e.activity ?? null, detail: e.detail ?? null, text: e.text ?? null,
      toolName: e.toolName ?? null, toolInput: e.toolInput ?? null,
      channelId: ctx.channelId ?? e.channelId ?? null,
      streamId: ctx.streamId ?? e.streamId ?? null,
      runSeq: ctx.runSeq ?? e.runSeq ?? null,
    }).returning();
    await pruneAgentActivityLog(agentId);
    return row ? activityItem(row) : null;
  } catch {
    return null; // observability must never block the agent runtime
  }
}

export async function startAgentActivityRun(serverId: string, agentId: string, channelId: string, streamId: string): Promise<AgentActivityItem> {
  const existing = (await db.select().from(schema.agentActivityLog).where(and(
    eq(schema.agentActivityLog.serverId, serverId),
    eq(schema.agentActivityLog.agentId, agentId),
    eq(schema.agentActivityLog.streamId, streamId),
  )).limit(1))[0];
  if (existing) return activityItem(existing);
  return (await logActivity(serverId, agentId, { kind: "status", activity: "working", detail: "turn", runSeq: 0 }, { channelId, streamId, runSeq: 0 }))
    ?? { timestamp: Date.now(), kind: "status", activity: "working", detail: "turn" };
}

export async function pendingActivityForStream(serverId: string, agentId: string, channelId: string, streamId: string): Promise<AgentActivityClaim> {
  const rows = await db.select().from(schema.agentActivityLog).where(and(
    eq(schema.agentActivityLog.serverId, serverId),
    eq(schema.agentActivityLog.agentId, agentId),
    eq(schema.agentActivityLog.channelId, channelId),
    eq(schema.agentActivityLog.streamId, streamId),
    isNull(schema.agentActivityLog.messageId),
  )).orderBy(asc(schema.agentActivityLog.runSeq), asc(schema.agentActivityLog.ts));
  return { streamId, rows, items: rows.map(activityItem) };
}

export async function claimPendingAgentActivity(serverId: string, agentId: string, channelId: string): Promise<AgentActivityClaim | null> {
  const latest = (await db.select({ streamId: schema.agentActivityLog.streamId }).from(schema.agentActivityLog).where(and(
    eq(schema.agentActivityLog.serverId, serverId),
    eq(schema.agentActivityLog.agentId, agentId),
    eq(schema.agentActivityLog.channelId, channelId),
    isNotNull(schema.agentActivityLog.streamId),
    isNull(schema.agentActivityLog.messageId),
  )).orderBy(desc(schema.agentActivityLog.ts)).limit(1))[0];
  if (latest?.streamId) return pendingActivityForStream(serverId, agentId, channelId, latest.streamId);

  // A run can emit two public messages back-to-back without an activity event between them.
  // Keep the second message on the same run by following the latest still-running segment.
  const running = (await db.select({ streamId: schema.messages.agentActivityStreamId }).from(schema.messages).where(and(
    eq(schema.messages.serverId, serverId),
    eq(schema.messages.channelId, channelId),
    eq(schema.messages.senderId, agentId),
    eq(schema.messages.agentActivityState, "running"),
    isNotNull(schema.messages.agentActivityStreamId),
  )).orderBy(desc(schema.messages.seq)).limit(1))[0];
  return running?.streamId ? pendingActivityForStream(serverId, agentId, channelId, running.streamId) : null;
}

export async function assignActivityRows(rows: (typeof schema.agentActivityLog.$inferSelect)[], messageId: string): Promise<void> {
  if (!rows.length) return;
  await db.update(schema.agentActivityLog).set({ messageId }).where(and(
    isNull(schema.agentActivityLog.messageId),
    inArray(schema.agentActivityLog.id, rows.map((row) => row.id)),
  ));
}

export interface RunningAgentRun {
  agentId: string;
  agentName: string;
  streamId: string;
  startedAt: number;
  items: AgentActivityItem[];
}

/** Upper bound on how old the freshest row of a run may be for page-refresh restore to still show
 *  it as live (daemon wall-clock ceiling from the watchdog design — L3 24h). Guards against
 *  orphaned pending rows (crashed daemon never sent done/error) resurrecting as phantom cards. */
export const RUNNING_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** In-progress runs for a channel, aggregated from unclaimed activity rows (messageId is null)
 *  grouped per agent+streamId. Returned alongside GET /api/messages/channel/:id so a freshly
 *  loaded client can rebuild the live "agent working" card that socket events built pre-refresh.
 *  Liveness guard: the agent must still be a live teammate — not soft-deleted, in an active-ish
 *  status, on an online machine, with a fresh row inside RUNNING_RUN_MAX_AGE_MS. */
export async function runningAgentRunsInChannel(serverId: string, channelId: string): Promise<RunningAgentRun[]> {
  const rows = await db.select().from(schema.agentActivityLog).where(and(
    eq(schema.agentActivityLog.serverId, serverId),
    eq(schema.agentActivityLog.channelId, channelId),
    isNotNull(schema.agentActivityLog.streamId),
    isNull(schema.agentActivityLog.messageId),
    gt(schema.agentActivityLog.ts, Date.now() - RUNNING_RUN_MAX_AGE_MS),
  )).orderBy(asc(schema.agentActivityLog.runSeq), asc(schema.agentActivityLog.ts));
  if (!rows.length) return [];

  const agentIds = [...new Set(rows.map((row) => row.agentId))];
  const ags = await db.select({
    id: schema.agents.id, displayName: schema.agents.displayName,
    status: schema.agents.status, machineId: schema.agents.machineId,
  }).from(schema.agents).where(and(inArray(schema.agents.id, agentIds), isNull(schema.agents.deletedAt)));
  const machineIds = [...new Set(ags.map((a) => a.machineId).filter((m): m is string => !!m))];
  const machines = machineIds.length
    ? await db.select({ id: schema.machines.id, status: schema.machines.status }).from(schema.machines).where(inArray(schema.machines.id, machineIds))
    : [];
  const machineOnline = new Set(machines.filter((m) => m.status === "online").map((m) => m.id));
  const anyMachineOnline = machineOnline.size > 0
    || (await db.select({ id: schema.machines.id }).from(schema.machines).where(and(eq(schema.machines.serverId, serverId), eq(schema.machines.status, "online"))).limit(1)).length > 0;

  const byRun = new Map<string, { agentId: string; streamId: string; startedAt: number; items: AgentActivityItem[] }>();
  for (const row of rows) {
    const agent = ags.find((a) => a.id === row.agentId);
    // Liveness guard: dropped/deactivated agents and offline machines can't be mid-run —
    // their pending rows stay dormant until the agent's next message claims them.
    // A machine-less agent (unbound daemon topology, e.g. seed:dev) passes on any online machine.
    if (!agent || !["active", "starting", "queued"].includes(agent.status)) continue;
    if (agent.machineId ? !machineOnline.has(agent.machineId) : !anyMachineOnline) continue;
    const key = `${row.agentId}:${row.streamId}`;
    const run = byRun.get(key) ?? { agentId: row.agentId, streamId: row.streamId!, startedAt: Number(row.ts), items: [] };
    run.items.push(activityItem(row));
    byRun.set(key, run);
  }
  return [...byRun.values()].map((run) => ({
    ...run,
    agentName: ags.find((a) => a.id === run.agentId)?.displayName ?? "Agent",
  }));
}
