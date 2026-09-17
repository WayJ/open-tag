import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { hashToken, newKey } from "./auth.js";

const serverUrl = `http://localhost:${Number(process.env.PORT ?? 7777)}`;
const rawTokens = new Map<string, string>();

/** Session scope carried in the daemon protocol: one persistent runtime session per (agent, channel|thread). */
export type AgentScope = { type: "channel" | "thread"; id: string; sessionId: string | null };

/** Channel context a dispatch carries into config resolution; absent → LEGACY (no scope). */
export type ScopeContext = { channelId: string };

/** Pure mapping from a channel row to its scope kind: a thread keeps its own channel id as a thread
 *  scope; every other channel kind (channel/private/dm) is a channel scope on that same id. */
export function resolveScope(channel: { type: string; id: string }): { type: "channel" | "thread"; id: string } {
  return { type: channel.type === "thread" ? "thread" : "channel", id: channel.id };
}

/** Build the daemon launch config without rotating a token held by an already-running agent.
 *  With a scope context, resolves the (agent, scope) session id from agent_sessions — a missing
 *  channel row (deleted / cross-server) yields no scope at all (LEGACY config). The legacy
 *  agent-wide top-level sessionId keeps flowing either way for mixed-fleet rollout compat. */
export async function agentConfig(agentId: string, scopeCtx?: ScopeContext) {
  const agent = (await db.select().from(schema.agents).where(and(
    eq(schema.agents.id, agentId),
    isNull(schema.agents.deletedAt),
  )))[0];
  if (!agent) return null;

  let token = rawTokens.get(agent.id);
  if (!token && !(agent.status === "active" && agent.agentTokenHash)) {
    token = newKey("sk_agent_");
    rawTokens.set(agent.id, token);
    await db.update(schema.agents).set({ agentTokenHash: hashToken(token) }).where(eq(schema.agents.id, agent.id));
  }

  let scope: AgentScope | undefined;
  if (scopeCtx) {
    const ch = (await db.select().from(schema.channels).where(and(
      eq(schema.channels.id, scopeCtx.channelId),
      eq(schema.channels.serverId, agent.serverId),
      isNull(schema.channels.deletedAt),
    )))[0];
    if (ch) {
      const resolved = resolveScope(ch);
      const session = (await db.select({ sessionId: schema.agentSessions.sessionId }).from(schema.agentSessions).where(and(
        eq(schema.agentSessions.agentId, agent.id),
        eq(schema.agentSessions.scopeType, resolved.type),
        eq(schema.agentSessions.scopeId, scopeCtx.channelId),
      )))[0];
      scope = { ...resolved, sessionId: session?.sessionId ?? null };
    }
  }

  return {
    name: agent.name,
    displayName: agent.displayName,
    description: agent.description,
    model: agent.model,
    runtime: agent.runtime,
    projectPath: agent.projectPath,
    runtimeConfig: agent.runtimeConfig,
    sessionId: agent.sessionId ?? undefined,
    ...(scope ? { scope } : {}),
    serverUrl,
    serverId: agent.serverId,
    agentId: agent.id,
    agentToken: token,
  };
}
