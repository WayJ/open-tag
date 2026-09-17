// Manages local agents: spawns processes via the runtime interface, bridges events to the server, and handles delivery/sleep. Runtime protocol details live in each runtime file.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildSystemPrompt, STARTUP_NUDGE, RESUME_NUDGE, ONE_SHOT_WAKE_NUDGE, inboxNotice } from "./prompt.js";
import { seedMemory, applyProfileToMemory } from "./memory.js";
import { ensureOpenTagBin } from "./openTagBin.js";
import { getRuntime } from "./runtimes.js";
import type { Runtime, RuntimeSession, RuntimeCallbacks } from "./runtime.js";
import { createLogger } from "../log.js";
import { agentsDir } from "../paths.js";
import { ResourceBudget, PRESSURE_MEM_MB } from "./resourceBudget.js";
import { readProcessMemoryMB, applyMemoryPressure } from "./resourceLimit.js";
import { DeliveryAdmissionStore } from "./deliveryAdmissionStore.js";
import { resolveProjectDirectory } from "./projectDirectory.js";
import { atomicWriteManagedFile, ensureManagedDirectory, readManagedFile, readManagedMemoryFiles } from "./stateFiles.js";
import { memoryFilesDigest } from "../daemonProtocol.js";

const DATA_DIR = agentsDir();
const IDLE_MS = Number(process.env.OPEN_TAG_IDLE_MS ?? 10 * 60 * 1000); // how long before idle sleep (kills process to save memory; next wake uses --resume)
const DELIVER_DEBOUNCE_MS = Number(process.env.OPEN_TAG_DELIVER_DEBOUNCE_MS ?? 3000); // batching window for deliveries while agent is busy (saves tokens, reduces interruptions)
const ONE_SHOT_DELIVER_DEBOUNCE_MS = Number(process.env.OPEN_TAG_ONE_SHOT_DELIVER_DEBOUNCE_MS ?? process.env.OPEN_TAG_HERMES_DELIVER_DEBOUNCE_MS ?? 500); // One-shot runtimes need a short fixed wait when there is only one live notice.
const PENDING_DELIVER_TTL_MS = Number(process.env.OPEN_TAG_PENDING_DELIVER_TTL_MS ?? 15_000); // start+deliver can arrive back-to-back; keep deliver briefly while start prepares workspace
const MEMORY_UPLOAD_DEBOUNCE_MS = Number(process.env.OPEN_TAG_MEMORY_UPLOAD_DEBOUNCE_MS ?? 2000); // turn-end quiet window before the managed-memory snapshot is read + uploaded

/** Session scope carried in the daemon protocol: one persistent runtime session per (agent, channel|thread). */
export interface AgentScope { type: "channel" | "thread"; id: string; sessionId: string | null }

/** Internal map key for one running (agent, scope) instance. No scope → LEGACY key (`aid:legacy`).
 *  agentIds are uuids without colons, so `key.split(":")[0]` always recovers the agentId. */
export function scopeKey(agentId: string, scope?: Pick<AgentScope, "type" | "id"> | null): string {
  return scope ? `${agentId}:${scope.type}:${scope.id}` : `${agentId}:legacy`;
}
function agentIdOf(key: string): string { return key.split(":")[0]!; }

export interface AgentConfig {
  name: string; displayName: string; description?: string | null;
  model?: string; runtime?: string; projectPath?: string | null; runtimeConfig?: Record<string, unknown> | null; sessionId?: string;
  scope?: AgentScope; // injected by the server on agent:start; absent → LEGACY single-session behavior
  serverUrl: string; serverId: string; agentId: string; agentToken?: string; // per-agent token (slice10); re-sent start for a running agent may omit it (daemon ignores)
}
interface DeliveryAdmission { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; }
interface LifecycleSettlement { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; settled: boolean; }
interface DeliverBuf { count: number; from: string; target: string; targetName: string; firstShort: string; latestShort: string; isTask: boolean; mentioned: boolean; targets: Set<string>; timer: ReturnType<typeof setTimeout>; admissions: DeliveryAdmission[]; streamId?: string; attention?: string; deliveryId?: string; seq?: number; }
export interface DeliverMeta { targetName?: string; msgShort?: string; isTask?: boolean; streamId?: string; turnId?: string; turnMessageCount?: number; attention?: string; deliveryId?: string; seq?: number; scope?: AgentScope; }
interface Running { session: RuntimeSession; config: AgentConfig; sessionId: string | null; initialAdmission: LifecycleSettlement; exit: LifecycleSettlement; idleTimer?: ReturnType<typeof setTimeout>; deliverBufs?: Map<string, DeliverBuf>; deliveryQueue?: DeliverBuf[]; turnActive: boolean; pid: number; }
interface QueuedStart { key: string; agentId: string; config: AgentConfig; enqueuedAt: number; }
interface PendingDeliver { from: string; target: string; mentioned: boolean; meta: DeliverMeta; admission: DeliveryAdmission; }
interface PendingDeliverQueue { items: PendingDeliver[]; timer?: ReturnType<typeof setTimeout>; }
interface DurableDeliveryAdmission { promise: Promise<void>; expiresAt: number; }
interface StartAttempt { promise: Promise<void>; cancelled: boolean; scope?: AgentScope; }
interface ActiveReplyPreview { channelId: string; streamId: string; name: string; eventSeq: number; }
interface AgentManagerOptions {
  dataDir?: string;
  binDir?: string;
  deliverDebounceMs?: number;
  oneShotDeliverDebounceMs?: number;
  pendingDeliverTtlMs?: number;
  idleMs?: number;
  runtimeResolver?: (name: string) => Runtime | null;
  budget?: ResourceBudget;
  beforeRuntimeDelivery?: (agentId: string, meta: Pick<DeliverMeta, "deliveryId" | "seq">) => Promise<void>;
  machineId?: string; // stable machine identity, uplinked with each memory snapshot (wire symmetry; the server uses the connection identity)
  memoryUploadDebounceMs?: number;
}

export class AgentManager {
  // Data-plane state (deliver/start/session) is keyed by scopeKey (agentId:scope); the control plane
  // (stop/sleep/reset/dequeue/profile, runControl's controlTails) stays agentId-granular.
  // `deliveryAdmissions` is keyed by deliveryId (cross-scope dedup fence) — deliberately NOT scoped.
  // memoryUploadTimers/memoryUploadCache are agent-granular by design — memory is an agent-level
  // resource (one managed snapshot per agent; scoped sessions all write the same workspace).
  private agents = new Map<string, Running>();
  private starting = new Map<string, StartAttempt>();
  private pendingDelivers = new Map<string, PendingDeliverQueue>();
  private activeReplyPreviews = new Map<string, ActiveReplyPreview>();
  private deliveryAdmissions = new Map<string, DurableDeliveryAdmission>();
  private deliveryPreparations = new Map<string, Set<Promise<void>>>();
  private deliveryPreparationTails = new Map<string, Promise<void>>();
  private deliveryAdmissionStore: DeliveryAdmissionStore;
  private deliveryEpochs = new Map<string, number>();
  private deliveryCancellationErrors = new Map<string, Error>();
  private controlTails = new Map<string, Promise<void>>();
  private memoryUploadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private memoryUploadCache = new Map<string, string>();
  private replySeq = 0;
  private binDir: string;
  private dataDir: string;
  private deliverDebounceMs: number;
  private oneShotDeliverDebounceMs: number;
  private pendingDeliverTtlMs: number;
  private idleMs: number;
  private runtimeResolver: (name: string) => Runtime | null;
  private beforeRuntimeDelivery: (agentId: string, meta: Pick<DeliverMeta, "deliveryId" | "seq">) => Promise<void>;
  private machineId?: string;
  private memoryUploadDebounceMs: number;
  private budget: ResourceBudget;
  private startQueue: QueuedStart[] = [];
  private log = createLogger("daemon:agents");
  constructor(private send: (msg: unknown) => void, opts: AgentManagerOptions = {}) {
    this.budget = opts.budget ?? new ResourceBudget();
    this.binDir = opts.binDir ?? ensureOpenTagBin();
    this.dataDir = opts.dataDir ?? DATA_DIR;
    this.deliveryAdmissionStore = new DeliveryAdmissionStore(this.dataDir);
    this.deliverDebounceMs = opts.deliverDebounceMs ?? DELIVER_DEBOUNCE_MS;
    this.oneShotDeliverDebounceMs = opts.oneShotDeliverDebounceMs ?? ONE_SHOT_DELIVER_DEBOUNCE_MS;
    this.pendingDeliverTtlMs = opts.pendingDeliverTtlMs ?? PENDING_DELIVER_TTL_MS;
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.runtimeResolver = opts.runtimeResolver ?? getRuntime;
    this.beforeRuntimeDelivery = opts.beforeRuntimeDelivery ?? (async () => {});
    this.machineId = opts.machineId;
    this.memoryUploadDebounceMs = opts.memoryUploadDebounceMs ?? MEMORY_UPLOAD_DEBOUNCE_MS;
    // Memory pressure monitor: every 10s, cap running agents if free < 500 MB
    const pressureTimer = setInterval(() => this.checkMemoryPressure(), 10_000);
    pressureTimer.unref?.();
  }

  private checkMemoryPressure(): void {
    const freeMB = this.budget.availableMemMB();
    if (freeMB >= PRESSURE_MEM_MB) { this.tryDequeue(); return; }
    const agentCount = Math.max(this.agents.size, 1);
    const margin = Math.ceil(400 / agentCount);
    this.log.warn("memory pressure detected", { freeMB, threshold: PRESSURE_MEM_MB, margin, agentCount });
    for (const [id, r] of this.agents) {
      const pid = r.session.pid ?? r.pid;
      if (pid <= 0) continue;
      const actual = readProcessMemoryMB(pid);
      if (actual > 0) {
        this.log.info("pressure: capping agent", { agentId: id, pid, actualMB: actual, limitMB: actual + margin });
        applyMemoryPressure(pid, actual, margin);
      }
    }
    // macOS has no cgroup/job-object support — capping above is a no-op.
    // Sleep the heaviest agent and auto-enqueue it so tryDequeue() resumes it
    // once memory recovers.
    if (process.platform === "darwin" && this.agents.size > 0) {
      let maxRss = -1, maxId = "";
      for (const [id, r] of this.agents) {
        const pid = r.session.pid ?? r.pid;
        if (pid <= 0) continue;
        const rss = readProcessMemoryMB(pid);
        if (rss > maxRss) { maxRss = rss; maxId = id; }
      }
      if (maxId) {
        const config = this.agents.get(maxId)?.config;
        if (config && !this.startQueue.some((q) => q.key === maxId)) { // maxId IS the scope key (agents map key)
          this.startQueue.push({ key: maxId, agentId: agentIdOf(maxId), config, enqueuedAt: Date.now() });
        }
        this.budget.queueLength = this.startQueue.length;
        this.log.warn("darwin: sleeping heaviest agent to relieve memory pressure", { agentId: maxId, rssMB: maxRss });
        void this.sleepScope(maxId).catch((error) => this.log.warn("pressure sleep failed", { agentId: maxId, detail: String(error) }));
      }
    }
  }

  /** Agent ids currently running (one agent may run several scope-keyed runtimes). */
  running(): string[] { return [...new Set([...this.agents.keys()].map(agentIdOf))]; }

  /** True while any scope of this agent is running or starting. Agent-level status reports
   *  (queued/inactive/sleeping/error) must be withheld in that case, so the UI never flips an
   *  agent with a live scope to a dormant state. */
  private hasAliveScope(agentId: string): boolean {
    return [...this.agents.keys()].some((k) => agentIdOf(k) === agentId)
      || [...this.starting.keys()].some((k) => agentIdOf(k) === agentId);
  }

  /** Serialize lifecycle commands for one agent while keeping different agents independent. */
  runControl<T>(agentId: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.controlTails.get(agentId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tail = current.then(() => {}, () => {});
    this.controlTails.set(agentId, tail);
    void tail.finally(() => {
      if (this.controlTails.get(agentId) === tail) this.controlTails.delete(agentId);
    });
    return current;
  }

  stopAll(): void { for (const id of new Set([...this.agents.keys(), ...this.starting.keys()].map(agentIdOf))) void this.stop(id).catch(() => {}); }
  budgetStatus() {
    let actualMemMB = 0;
    for (const r of this.agents.values()) {
      const pid = r.session.pid ?? r.pid;
      if (pid > 0) actualMemMB += readProcessMemoryMB(pid);
    }
    this.budget.agentCount = this.agents.size;
    this.budget.actualUsedMemMB = actualMemMB;
    return this.budget.status();
  }
  queuedAgents(): QueuedStart[] { return [...this.startQueue]; }
  /** Remove every queued start request of this agent (all scopes — user cancelled). */
  dequeue(agentId: string): void {
    const remaining = this.startQueue.filter((q) => q.agentId !== agentId);
    if (remaining.length === this.startQueue.length) return;
    this.startQueue = remaining;
    const error = new Error(`agent dequeued before delivery admission: ${agentId}`);
    this.invalidateDeliveryLifecycle(agentId, error);
    this.rejectPendingDeliver(agentId, error);
    this.budget.queueLength = this.startQueue.length;
    if (this.hasAliveScope(agentId)) return; // a live sibling scope owns the agent-level status
    this.send({ type: "agent:status", agentId, status: "inactive" });
    this.sendAgentActivity(agentId, "offline", "dequeued");
    this.log.info("dequeued", { agentId });
  }

  /** Scope keys for an id that may be a raw agentId (all scopes) or an exact scope key (that scope only). */
  private runningKeys(idOrKey: string): string[] {
    if (this.agents.has(idOrKey)) return [idOrKey];
    return [...this.agents.keys()].filter((k) => agentIdOf(k) === idOrKey);
  }

  // Tear down process: clear timers + remove from map first (critical: deletion before session.stop() lets the onExit has() guard recognize this as an intentional stop, suppressing unexpected sleeping status) + stop runtime. Accepts an agentId (tears down every scope) or an exact scope key (internal scope-granular sleep). Returns whether anything was found.
  private async teardown(idOrKey: string): Promise<boolean> {
    const agentId = agentIdOf(idOrKey);
    // A scope key always contains ":" (agentIds are colon-free uuids) — an exact-key call fences only
    // that scope's delivery lifecycle; a whole-agent call fences every scope the agent has state under.
    const scoped = idOrKey.includes(":");
    const error = new Error(`agent stopped before delivery admission: ${agentId}`);
    const attempts: StartAttempt[] = [];
    if (scoped) {
      this.invalidateDeliveryLifecycleKey(idOrKey, error);
      const attempt = this.starting.get(idOrKey);
      if (attempt) { attempt.cancelled = true; attempts.push(attempt); }
      this.rejectPendingDeliverKey(idOrKey, error);
    } else {
      this.invalidateDeliveryLifecycle(agentId, error);
      for (const [k, attempt] of this.starting) {
        if (agentIdOf(k) !== agentId) continue;
        attempt.cancelled = true;
        attempts.push(attempt);
      }
      this.rejectPendingDeliver(agentId, error);
    }
    const keys = this.runningKeys(idOrKey);
    if (!keys.length) {
      await Promise.all(attempts.map((a) => a.promise.catch(() => {})));
      return attempts.length > 0;
    }
    const runnings: Running[] = [];
    for (const key of keys) {
      const r = this.agents.get(key);
      if (!r) continue;
      runnings.push(r);
      this.finishReplyPreview(key);
      if (r.idleTimer) clearTimeout(r.idleTimer);
      this.rejectBufferedDeliveries(r, error);
      this.agents.delete(key);
    }
    // Dequeue before stopping (tryDequeue must observe freed capacity synchronously, before any await).
    this.tryDequeue();
    // Stop every scope first, then wait: a zombie scope-A process must not delay scope-B's stop.
    for (const r of runnings) r.session.stop();
    for (const r of runnings) await r.exit.promise;
    await Promise.all(attempts.map((a) => a.promise.catch(() => {})));
    return true;
  }
  // User-initiated whole-agent stop (agent:stop control): tears down every scope, emits inactive/offline
  async stop(agentId: string): Promise<void> { if (!await this.teardown(agentId)) return; this.send({ type: "agent:status", agentId, status: "inactive" }); this.sendAgentActivity(agentId, "offline"); }
  // User-initiated whole-agent sleep (agent:sleep control): emits sleeping/sleeping (activity also set to sleeping so the frontend activity+status dual mapping stays consistent; session is preserved for --resume on next wake)
  async sleep(agentId: string): Promise<void> { if (!await this.teardown(agentId)) return; this.log.info("sleep", { agentId }); this.send({ type: "agent:status", agentId, status: "sleeping" }); this.sendAgentActivity(agentId, "sleeping"); }
  // Scope-granular sleep (idle timer / memory pressure / queue yield): stops exactly this scope; the
  // agent-level sleeping report is withheld while a sibling scope of the same agent is still alive,
  // so the UI never sees "sleeping" next to a scope that is still typing.
  private async sleepScope(key: string): Promise<void> {
    if (!await this.teardown(key)) return;
    const agentId = agentIdOf(key);
    this.log.info("sleep scope", { agentId, key });
    if (this.hasAliveScope(agentId)) return; // a sibling scope is alive/starting — no agent-level sleeping
    this.send({ type: "agent:status", agentId, status: "sleeping" });
    this.sendAgentActivity(key, "sleeping");
  }
  /** Try to start the next queued agent if budget allows. */
  private tryDequeue(): void {
    if (this.startQueue.length === 0) return;
    const q = this.startQueue[0]!;
    if (!this.budget.tryAllocate()) return;
    this.startQueue.shift();
    const agentId = q.agentId;
    this.budget.queueLength = this.startQueue.length;
    this.log.info("dequeue -> start", { agentId });
    if (!this.hasAliveScope(agentId)) this.send({ type: "agent:status", agentId, status: "inactive" }); // a live sibling scope owns the agent-level status
    void this.launchStart(agentId, q.key, q.config).catch(() => {});
  }

  /** Reset: stop the process + clear the server-side session (next start will not --resume); wipeWorkspace deletes the entire workspace; clearMemory clears MEMORY.md only. */
  async reset(agentId: string, wipeWorkspace = false, clearMemory = false): Promise<void> {
    // Drop queued scoped starts first: a queued item carries a stale scope.sessionId and must not
    // resurrect a just-reset session chain after a later dequeue. (Must precede teardown — teardown
    // calls tryDequeue(), which would otherwise launch the queued item mid-reset.)
    this.startQueue = this.startQueue.filter((q) => q.agentId !== agentId);
    this.budget.queueLength = this.startQueue.length;
    // Cancel any pending memory upload and drop the digest cache: the workspace was just reset, so
    // the next turn end must re-upload the on-disk (post-reset) snapshot from scratch.
    const pendingMemoryTimer = this.memoryUploadTimers.get(agentId);
    if (pendingMemoryTimer) { clearTimeout(pendingMemoryTimer); this.memoryUploadTimers.delete(agentId); }
    this.memoryUploadCache.delete(agentId);
    // Snapshot the scopes the daemon knows about before teardown removes them: each gets its own
    // null session uplink (the server clears that agent_sessions row); the scope-less legacy null
    // below clears agents.session_id (old column / mixed-fleet compat).
    const knownScopes = new Map<string, AgentScope | undefined>();
    for (const [k, r] of this.agents) if (agentIdOf(k) === agentId) knownScopes.set(k, r.config.scope);
    for (const [k, a] of this.starting) if (agentIdOf(k) === agentId) knownScopes.set(k, a.scope);
    await this.teardown(agentId); // skip stop() to avoid double inactive emit; reset sends its own inactive/offline+detail=reset below
    for (const scope of knownScopes.values()) {
      if (scope) this.send({ type: "agent:session", agentId, sessionId: null, scope: { type: scope.type, id: scope.id } });
    }
    this.send({ type: "agent:session", agentId, sessionId: null });
    const dir = path.join(this.dataDir, agentId);
    if (wipeWorkspace) {
      try { await rm(dir, { recursive: true, force: true }); this.log.info("workspace wiped", { agentId }); }
      catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this.log.warn("wipe failed", { agentId, detail: String(error) });
        throw new Error(`workspace wipe failed: ${error.message}`, { cause: error });
      }
    } else if (clearMemory) {
      try {
        await mkdir(this.dataDir, { recursive: true });
        await ensureManagedDirectory(this.dataDir, agentId);
        await atomicWriteManagedFile(dir, "MEMORY.md", "# Memory\n\n(reset)\n");
        this.log.info("memory cleared", { agentId });
      }
      catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this.log.warn("clearMemory failed", { agentId, detail: String(error) });
        throw new Error(`memory reset failed: ${error.message}`, { cause: error });
      }
    }
    this.send({ type: "agent:status", agentId, status: "inactive" });
    this.sendAgentActivity(agentId, "offline", "reset");
    this.log.info("agent reset", { agentId, wipeWorkspace, clearMemory });
  }
  /** Profile changed on the server (displayName/description) — surgically sync the workspace MEMORY.md
   *  title + `## Role`, preserving the agent's own sections. No-op if the workspace/file doesn't exist
   *  yet (a not-yet-started agent gets fresh values from the DB when start() seeds it). */
  async syncProfile(agentId: string, displayName: string, description?: string | null): Promise<void> {
    const dir = path.join(this.dataDir, agentId);
    let content: string;
    try { content = (await readManagedFile(dir, "MEMORY.md")).toString("utf8"); }
    catch { this.log.debug("syncProfile: no MEMORY.md yet", { agentId }); return; }
    let effectiveDesc = description;
    try {
      const f = (await readManagedFile(dir, "personality.md")).toString("utf8");
      if (f.trim()) effectiveDesc = f;
    } catch {}
    const next = applyProfileToMemory(content, displayName || agentId, effectiveDesc);
    if (next !== content) {
      try { await atomicWriteManagedFile(dir, "MEMORY.md", next); this.log.info("profile synced to MEMORY.md", { agentId }); }
      catch (e) { this.log.warn("syncProfile write failed", { agentId, detail: String(e) }); return; }
    }
    // Keep any running scope's cached config fresh so a later --resume uses the new values.
    for (const key of this.runningKeys(agentId)) {
      const r = this.agents.get(key)!;
      r.config.displayName = displayName; r.config.description = description ?? null;
    }
  }
  private resetIdle(key: string): void {
    const r = this.agents.get(key); if (!r) return;
    if (r.idleTimer) clearTimeout(r.idleTimer);
    r.idleTimer = setTimeout(() => { this.log.info("idle sleep", { agentId: agentIdOf(key), key, idleMs: this.idleMs }); void this.sleepScope(key).catch((error) => this.log.warn("idle sleep failed", { agentId: agentIdOf(key), detail: String(error) })); }, this.idleMs);
  }

  /** Debounced managed-memory uplink: every turn end (any scope) re-arms one agent-granular timer, so
   *  a burst of scope turns collapses into a single read+upload, and unchanged snapshots are dropped
   *  by digest comparison against the last upload. */
  private scheduleMemoryUpload(agentId: string): void {
    const existing = this.memoryUploadTimers.get(agentId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.memoryUploadTimers.delete(agentId);
      void this.uploadMemory(agentId).catch((error) => this.log.warn("memory upload failed", { agentId, detail: String(error) }));
    }, this.memoryUploadDebounceMs);
    timer.unref?.();
    this.memoryUploadTimers.set(agentId, timer);
  }

  private async uploadMemory(agentId: string): Promise<void> {
    const files = await readManagedMemoryFiles(path.join(this.dataDir, agentId));
    const digest = memoryFilesDigest(files);
    if (this.memoryUploadCache.get(agentId) === digest) return; // unchanged since the last upload
    this.memoryUploadCache.set(agentId, digest);
    this.send({ type: "agent:memory", agentId, files, machineId: this.machineId });
  }

  private startReplyPreview(key: string, r: Running, channelId: string, streamId?: string): void {
    const existing = this.activeReplyPreviews.get(key);
    if (existing?.channelId === channelId && (!streamId || existing.streamId === streamId)) return;
    const preview: ActiveReplyPreview = {
      channelId,
      streamId: streamId ?? `${Date.now()}-${++this.replySeq}`,
      name: r.config.displayName || r.config.name || agentIdOf(key),
      eventSeq: 0,
    };
    if (existing) return;
    this.activeReplyPreviews.set(key, preview);
    this.send({ type: "agent:reply", agentId: agentIdOf(key), channelId: preview.channelId, streamId: preview.streamId, name: preview.name, op: "start" });
  }

  private sendAgentActivity(key: string, activity: string, detail = ""): void {
    const preview = this.activeReplyPreviews.get(key);
    this.send({ type: "agent:activity", agentId: agentIdOf(key), activity, detail, channelId: preview?.channelId, streamId: preview?.streamId, runSeq: preview ? ++preview.eventSeq : undefined });
  }

  private sendAgentTrajectory(key: string, entries: { kind?: string; text?: string; toolName?: string; toolInput?: string }[]): void {
    const preview = this.activeReplyPreviews.get(key);
    const contextual = preview ? entries.map((entry) => ({ ...entry, runSeq: ++preview.eventSeq })) : entries;
    this.send({ type: "agent:trajectory", agentId: agentIdOf(key), entries: contextual, channelId: preview?.channelId, streamId: preview?.streamId });
  }

  private finishReplyPreview(key: string, op: "done" | "error" = "done"): void {
    const preview = this.activeReplyPreviews.get(key);
    if (!preview) return;
    this.activeReplyPreviews.delete(key);
    this.send({ type: "agent:reply", agentId: agentIdOf(key), channelId: preview.channelId, streamId: preview.streamId, name: preview.name, op });
    const running = this.agents.get(key);
    // Queue is waiting → sleep this scope so the next one can run
    if (op === "done" && !running?.deliveryQueue?.length && !running?.deliverBufs?.size && this.startQueue.length > 0) {
      const r = this.agents.get(key);
      if (r) {
        this.log.info("reply done, queue waiting — sleeping scope", { agentId: agentIdOf(key), key });
        void this.sleepScope(key).catch((error) => this.log.warn("queued-agent sleep failed", { agentId: agentIdOf(key), detail: String(error) }));
      }
    }
  }

  async start(agentId: string, config: AgentConfig): Promise<void> {
    const key = scopeKey(agentId, config.scope);
    // `starting`/startQueue are scopeKey-granular: a concurrent same-agent different-scope start
    // launches its own runtime instead of joining this attempt, and a queued scope's config can
    // only be overwritten by a start for the same scope.
    const existing = this.starting.get(key);
    if (existing) return existing.promise;
    if (this.agents.has(key)) return;
    // Already queued for this scope — update config and return
    const queuedIdx = this.startQueue.findIndex((q) => q.key === key);
    if (queuedIdx !== -1) {
      this.startQueue[queuedIdx]!.config = config;
      return;
    }

    if (this.budget.tryAllocate()) {
      return this.launchStart(agentId, key, config);
    }

    // Memory pressure → queue
    this.startQueue.push({ key, agentId, config, enqueuedAt: Date.now() });
    this.budget.queueLength = this.startQueue.length;
    if (!this.hasAliveScope(agentId)) { // a live sibling scope owns the agent-level status
      this.send({ type: "agent:status", agentId, status: "queued" });
      this.sendAgentActivity(agentId, "offline", "queued");
    }
    this.log.info("queued (memory pressure)", { agentId, key });
  }

  private launchStart(agentId: string, key: string, config: AgentConfig): Promise<void> {
    const attempt: StartAttempt = { promise: undefined as unknown as Promise<void>, cancelled: false, scope: config.scope };
    this.starting.set(key, attempt);
    attempt.promise = Promise.resolve()
      .then(() => this.startNow(agentId, key, config, attempt))
      .catch(async (error) => { await this.failStart(key, agentId, error); throw error; })
      .finally(() => {
        if (this.starting.get(key) === attempt) this.starting.delete(key);
        this.budget.release();
        this.tryDequeue();
      });
    return attempt.promise;
  }

  private assertStartActive(key: string, attempt: StartAttempt): void {
    if (attempt.cancelled || this.starting.get(key) !== attempt) throw new Error(`agent start cancelled: ${agentIdOf(key)}`);
  }

  private async startNow(agentId: string, key: string, config: AgentConfig, attempt: StartAttempt): Promise<void> {
    this.assertStartActive(key, attempt);
    if (this.agents.has(key)) return;
    const runtime = this.runtimeResolver(config.runtime ?? "claude");
    if (!runtime) {
      this.log.error("no runtime", { runtime: config.runtime });
      this.sendAgentActivity(key, "offline", `no runtime: ${config.runtime}`);
      throw new Error(`no runtime: ${config.runtime ?? "claude"}`);
    }
    if (runtime.experimental) this.log.warn("experimental runtime", { runtime: runtime.name });

    const stateDir = path.join(this.dataDir, agentId);
    const projectDir = config.projectPath ? await resolveProjectDirectory(config.projectPath) : stateDir;
    await mkdir(this.dataDir, { recursive: true });
    await ensureManagedDirectory(this.dataDir, agentId);
    await ensureManagedDirectory(stateDir, "notes");
    this.assertStartActive(key, attempt);
    try { await readManagedFile(stateDir, "MEMORY.md"); } catch (error: any) {
      const replaceUnsafeLink = error instanceof Error && error.message.includes("file is a symbolic link");
      if (error?.code !== "ENOENT" && !replaceUnsafeLink) throw error;
      try {
        await atomicWriteManagedFile(stateDir, "MEMORY.md", seedMemory(config.displayName || config.name, config.description));
      } catch (seedError: any) {
        // Windows: two scopes of one agent cold-starting concurrently both see ENOENT and both seed;
        // the loser's rename onto the winner's fresh target can fail with EPERM/EEXIST. Seed content
        // is identical by construction, so re-read: the file now exists → the sibling won, continue;
        // still missing → this was a real failure, rethrow it.
        if (seedError?.code !== "EPERM" && seedError?.code !== "EEXIST") throw seedError;
        try { await readManagedFile(stateDir, "MEMORY.md"); } catch { throw seedError; }
      }
    }
    this.assertStartActive(key, attempt);

    let personality: string | null | undefined;
    try { personality = (await readManagedFile(stateDir, "personality.md")).toString("utf8"); if (!personality.trim()) personality = undefined; }
    catch { personality = undefined; }
    this.assertStartActive(key, attempt);

    const effectiveDescription = personality ?? config.description;
    // Scoped runs chain onto the scope's own session; a fresh scope (sessionId null) must NOT fall
    // back to the legacy agent-wide session. LEGACY (no scope) keeps the top-level sessionId.
    const resumeSessionId = config.scope ? config.scope.sessionId ?? null : config.sessionId ?? null;

    const systemPrompt = buildSystemPrompt({
      name: config.name, displayName: config.displayName, description: effectiveDescription,
      agentId, serverId: config.serverId, hostname: os.hostname(), os: `${os.platform()} ${os.arch()}`, stateDir, projectDir,
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env, FORCE_COLOR: "0",
      PATH: `${this.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      OPEN_TAG_SERVER_URL: config.serverUrl, OPEN_TAG_AGENT_ID: agentId, OPEN_TAG_AGENT_TOKEN: config.agentToken ?? "",
    };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;

    const running: Running = {
      session: undefined as unknown as RuntimeSession,
      config,
      sessionId: resumeSessionId,
      initialAdmission: this.createLifecycleSettlement(),
      exit: this.createLifecycleSettlement(),
      turnActive: true,
      pid: 0,
    };
    let initialAdmissionSettled = false;
    const completedFailureTurns = new WeakSet<object>();
    const completeTurn = () => {
      if (this.agents.get(key) !== running || !running.turnActive) return;
      running.turnActive = false;
      this.startNextQueuedDelivery(key, running);
      this.scheduleMemoryUpload(agentId);
    };
    const completeFailedTurn = (turnIdentity: object) => {
      if (completedFailureTurns.has(turnIdentity)) return;
      completedFailureTurns.add(turnIdentity);
      completeTurn();
    };
    const cb: RuntimeCallbacks = {
      onSession: (sid) => {
        running.sessionId = sid;
        this.send({ type: "agent:session", agentId, sessionId: sid, ...(running.config.scope ? { scope: running.config.scope } : {}) });
      },
      onInitialTurnAdmission: (error) => {
        if (initialAdmissionSettled) return;
        initialAdmissionSettled = true;
        if (error) {
          running.initialAdmission.reject(error);
          this.rejectPendingDeliverKey(key, error);
        } else {
          running.initialAdmission.resolve();
          this.acceptPendingStartup(key, runtime.name, running);
        }
      },
      onAcceptedTurnFailure: completeFailedTurn,
      onActivity: (activity, detail) => {
        this.resetIdle(key);
        this.sendAgentActivity(key, activity, detail ?? "");
        if (activity === "online") {
          this.finishReplyPreview(key);
          completeTurn();
        } else if (activity === "error") {
          this.finishReplyPreview(key, "error");
        } else if (activity === "sleeping" || activity === "offline") {
          this.finishReplyPreview(key);
        }
      },
      onTrajectory: (entries) => { this.sendAgentTrajectory(key, entries); },
      onExit: (code) => {
        this.log.info("agent exited", { agentId, key, code });
        const exitError = new Error(`runtime exited before delivery admission (${code ?? "signal"})`);
        const startupError = new Error(`runtime exited before initial turn admission (${code ?? "signal"})`);
        running.exit.resolve();
        if (!running.initialAdmission.settled) running.initialAdmission.reject(startupError);
        if (this.agents.get(key) !== running) return;
        this.invalidateDeliveryLifecycleKey(key, exitError);
        this.rejectPendingDeliverKey(key, exitError);
        this.rejectBufferedDeliveries(running, exitError);
        this.agents.delete(key);
        this.tryDequeue();
        // Process died on its own (not intentionally stopped): keep status=sleeping (session preserved, @ can --resume to recover);
        // Non-zero exit code (crash/signal kill) → activity=error to surface the failure; clean exit → sleeping.
        // Only the LAST surviving scope of the agent reports agent-level status/activity — a sibling
        // scope still running must not surface "sleeping"/"error" for the whole agent (M-2).
        const crashed = code !== 0;
        this.finishReplyPreview(key, crashed ? "error" : "done");
        if (this.hasAliveScope(agentId)) return; // a sibling scope is alive/starting — no agent-level report
        this.send({ type: "agent:status", agentId, status: "sleeping" });
        this.sendAgentActivity(key, crashed ? "error" : "sleeping", crashed ? `crashed (exit ${code ?? "signal"})` : "");
      },
      log: this.log,
    };

    // No await between set and runtime.start (single-threaded event loop), so deliver cannot interleave and read an empty session.
    // Deliveries queued during workspace preparation are consumed by the wake nudge itself: every
    // initial prompt (STARTUP/RESUME/ONE_SHOT) already instructs an inbox check, so re-delivering
    // them as an inbox notice would drive a second turn on the same message (agents visibly
    // double-replied on cold start). Messages are persisted server-side — the nudge turn's
    // `message check` pulls them; only the reply preview needs the queued metadata.
    await this.waitForDeliveryPreparations(key);
    this.assertStartActive(key, attempt);
    const pendingDeliverItems = this.pendingDelivers.get(key)?.items ?? [];
    const pendingDeliveryCount = pendingDeliverItems.length;
    const useOneShotWakeNudge = !!runtime.oneShotWake && pendingDeliveryCount > 0;
    const startupDelivery = pendingDeliverItems[0];
    if (startupDelivery?.meta.deliveryId) await this.beforeRuntimeDelivery(agentId, startupDelivery.meta);
    this.assertStartActive(key, attempt);
    this.agents.set(key, running);
    if (startupDelivery) this.startReplyPreview(key, running, startupDelivery.target, startupDelivery.meta.streamId);
    try {
      running.session = runtime.start({
        cwd: projectDir, stateDir, model: config.model, runtimeConfig: config.runtimeConfig, sessionId: resumeSessionId, systemPrompt, env,
        initialPrompt: useOneShotWakeNudge ? ONE_SHOT_WAKE_NUDGE : (resumeSessionId ? RESUME_NUDGE : STARTUP_NUDGE),
      }, cb);
    } catch (cause) {
      running.exit.resolve();
      if (this.agents.get(key) === running) this.agents.delete(key);
      throw cause;
    }
    running.pid = running.session.pid ?? 0;

    await running.initialAdmission.promise;
    this.assertStartActive(key, attempt);
    if (this.agents.get(key) !== running) throw new Error(`runtime exited before start completed: ${agentId}`);

    this.send({ type: "agent:status", agentId, status: "active" });
    if (running.turnActive) this.sendAgentActivity(key, "working", "starting");
    this.log.info("agent started", { agentId, key, runtime: runtime.name, model: config.model ?? "(default)", resume: !!resumeSessionId, experimental: runtime.experimental ?? false });
    this.resetIdle(key);
    if (pendingDeliveryCount > 0 && this.pendingDelivers.has(key)) {
      this.log.debug("pending delivery awaiting startup nudge admission", { agentId, key, runtime: runtime.name, count: pendingDeliveryCount });
    }
  }

  private acceptPendingStartup(key: string, runtime: string, running: Running): void {
    const q = this.pendingDelivers.get(key);
    if (!q) return;
    const [startup, ...queued] = q.items;
    startup?.admission.resolve();
    if (queued.length) {
      const deliveryQueue = running.deliveryQueue ?? [];
      running.deliveryQueue = deliveryQueue;
      for (const item of queued) deliveryQueue.push(this.pendingItemToBuffer(item));
    }
    this.clearPendingDeliver(key);
    this.log.debug("pending deliver consumed by wake nudge", { agentId: agentIdOf(key), key, runtime, count: startup ? 1 : 0, queued: queued.length });
  }

  private pendingItemToBuffer(item: PendingDeliver): DeliverBuf {
    const targetName = item.meta.targetName ?? item.target;
    const short = item.meta.msgShort ?? "";
    return {
      count: item.meta.turnMessageCount ?? 1,
      from: item.from,
      target: item.target,
      targetName,
      firstShort: short,
      latestShort: short,
      isTask: !!item.meta.isTask,
      mentioned: item.mentioned,
      targets: new Set([targetName]),
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      admissions: [item.admission],
      streamId: item.meta.streamId,
      attention: item.meta.attention,
      deliveryId: item.meta.deliveryId,
      seq: item.meta.seq,
    };
  }

  private async failStart(key: string, agentId: string, cause: unknown): Promise<void> {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    // A cancelled start was already invalidated by stop/reset; preserve that more specific
    // lifecycle error for deliveries that were concurrently loading the persistent fence.
    if (!error.message.startsWith("agent start cancelled:")) this.invalidateDeliveryLifecycleKey(key, error);
    const running = this.agents.get(key);
    if (running?.idleTimer) clearTimeout(running.idleTimer);
    if (running) this.rejectBufferedDeliveries(running, error);
    if (running) {
      this.agents.delete(key);
      try { running.session?.stop(); } catch { /* preserve the original startup error */ }
      if (!running.session) running.exit.resolve();
      await running.exit.promise.catch(() => {});
    }
    this.finishReplyPreview(key, "error");
    this.rejectPendingDeliverKey(key, error);
    this.log.warn("agent start failed", { agentId, key, detail: String(error) });
  }

  private rejectBufferedDeliveries(running: Running, error: Error): void {
    for (const buffer of running.deliverBufs?.values() ?? []) {
      clearTimeout(buffer.timer);
      for (const admission of buffer.admissions) admission.reject(error);
    }
    for (const buffer of running.deliveryQueue ?? []) {
      for (const admission of buffer.admissions) admission.reject(error);
    }
    running.deliverBufs = undefined;
    running.deliveryQueue = undefined;
  }

  private deliveryNotice(buffer: DeliverBuf): string {
    return inboxNotice({ count: buffer.count, from: buffer.from, targetName: buffer.targetName, firstShort: buffer.firstShort, latestShort: buffer.latestShort, isTask: buffer.isTask, isDm: buffer.targetName.startsWith("dm:"), changedTargets: buffer.targets.size, mentioned: buffer.mentioned, attention: buffer.attention });
  }

  private startNextQueuedDelivery(key: string, running: Running): void {
    if (running.turnActive || this.agents.get(key) !== running) return;
    const next = running.deliveryQueue?.shift();
    if (!running.deliveryQueue?.length) running.deliveryQueue = undefined;
    if (next) void this.admitBufferedDelivery(key, running, next);
  }

  private async admitBufferedDelivery(key: string, running: Running, buffer: DeliverBuf): Promise<void> {
    const agentId = agentIdOf(key);
    if (this.agents.get(key) !== running) {
      const error = new Error(`agent stopped before delivery admission: ${agentId}`);
      for (const admission of buffer.admissions) admission.reject(error);
      return;
    }
    running.turnActive = true;
    try {
      if (buffer.deliveryId) await this.beforeRuntimeDelivery(agentId, buffer);
      this.startReplyPreview(key, running, buffer.target, buffer.streamId);
      await running.session.deliver(this.deliveryNotice(buffer));
      this.resetIdle(key);
      for (const admission of buffer.admissions) admission.resolve();
      this.log.debug("inbox notice -> agent", { agentId, count: buffer.count, mentioned: buffer.mentioned });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      running.turnActive = false;
      for (const admission of buffer.admissions) admission.reject(error);
      this.finishReplyPreview(key, "error");
      this.log.warn("deliver failed", { agentId, detail: String(error) });
      this.startNextQueuedDelivery(key, running);
    }
  }

  private createAdmission(): DeliveryAdmission {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  private trackDeliveryPreparation(key: string, preparation: Promise<void>): void {
    const pending = this.deliveryPreparations.get(key) ?? new Set<Promise<void>>();
    this.deliveryPreparations.set(key, pending);
    pending.add(preparation);
    void preparation.finally(() => {
      pending.delete(preparation);
      if (!pending.size && this.deliveryPreparations.get(key) === pending) this.deliveryPreparations.delete(key);
    });
  }

  private async waitForDeliveryPreparations(key: string): Promise<void> {
    while (this.deliveryPreparations.get(key)?.size) {
      await Promise.all([...this.deliveryPreparations.get(key)!]);
    }
  }

  private createLifecycleSettlement(): LifecycleSettlement {
    const settlement = { promise: undefined as unknown as Promise<void>, resolve: undefined as unknown as () => void, reject: undefined as unknown as (error: Error) => void, settled: false };
    settlement.promise = new Promise<void>((resolve, reject) => {
      settlement.resolve = () => { if (settlement.settled) return; settlement.settled = true; resolve(); };
      settlement.reject = (error) => { if (settlement.settled) return; settlement.settled = true; reject(error); };
    });
    return settlement;
  }

  private queuePendingDeliver(key: string, item: PendingDeliver): void {
    const agentId = agentIdOf(key);
    let q = this.pendingDelivers.get(key);
    if (!q) {
      // A resource-pressure startQueue is an owned in-memory admission: it has no short TTL,
      // and will be consumed by the startup nudge when capacity returns. Ordinary out-of-order
      // deliver frames still expire loudly so the server can retry instead of silently losing work.
      const resourceQueued = this.startQueue.some((queued) => queued.key === key);
      const timer = resourceQueued ? undefined : setTimeout(() => {
        this.rejectPendingDeliverKey(key, new Error(`pending delivery expired before agent start: ${agentId}`));
        this.log.debug("pending deliver expired", { agentId, key });
      }, this.pendingDeliverTtlMs);
      q = { items: [], timer };
      this.pendingDelivers.set(key, q);
    }
    if (q.items.length >= 10) {
      item.admission.reject(new Error(`pending delivery queue full: ${agentId}`));
      this.log.warn("pending delivery rejected: queue full", { agentId, key, count: q.items.length });
      return;
    }
    q.items.push(item);
    this.log.debug("deliver queued pending start", { agentId, key, count: q.items.length });
  }

  private clearPendingDeliver(key: string): void {
    const q = this.pendingDelivers.get(key);
    if (!q) return;
    if (q.timer) clearTimeout(q.timer);
    this.pendingDelivers.delete(key);
  }

  /** Reject the pending delivers of exactly one scope key. */
  private rejectPendingDeliverKey(key: string, error: Error): void {
    const q = this.pendingDelivers.get(key);
    if (!q) return;
    if (q.timer) clearTimeout(q.timer);
    this.pendingDelivers.delete(key);
    for (const item of q.items) item.admission.reject(error);
  }

  /** Reject the pending delivers of every scope of this agent (whole-agent lifecycle change). */
  private rejectPendingDeliver(agentId: string, error: Error): void {
    for (const key of [...this.pendingDelivers.keys()]) {
      if (agentIdOf(key) !== agentId) continue;
      this.rejectPendingDeliverKey(key, error);
    }
  }

  private debounceMsFor(r: Running): number {
    const runtime = this.runtimeResolver(r.config.runtime ?? "claude");
    return runtime?.oneShotWake ? this.oneShotDeliverDebounceMs : this.deliverDebounceMs;
  }

  /** Resolve only after the runtime or cold-start queue has accepted responsibility for this delivery. */
  deliver(agentId: string, from: string, target: string, mentioned = false, meta: DeliverMeta = {}): Promise<void> {
    const key = scopeKey(agentId, meta.scope);
    if (meta.deliveryId) {
      const now = Date.now();
      const existing = this.deliveryAdmissions.get(meta.deliveryId);
      if (existing && existing.expiresAt > now) {
        this.log.debug("duplicate delivery suppressed", { agentId, deliveryId: meta.deliveryId });
        return existing.promise.then(() => this.beforeRuntimeDelivery(agentId, meta));
      }
      if (existing) this.deliveryAdmissions.delete(meta.deliveryId);
      const predecessor = this.deliveryPreparationTails.get(key) ?? Promise.resolve();
      const epoch = this.deliveryEpochs.get(key) ?? 0;
      let markPrepared!: () => void;
      const preparation = new Promise<void>((resolve) => { markPrepared = resolve; });
      this.deliveryPreparationTails.set(key, preparation);
      this.trackDeliveryPreparation(key, preparation);
      void preparation.finally(() => {
        if (this.deliveryPreparationTails.get(key) === preparation) this.deliveryPreparationTails.delete(key);
      });
      const promise = predecessor.catch(() => {}).then(() => this.admitDurableDelivery(key, from, target, mentioned, meta, epoch, markPrepared));
      const admission: DurableDeliveryAdmission = { promise, expiresAt: Number.POSITIVE_INFINITY };
      this.deliveryAdmissions.set(meta.deliveryId, admission);
      void promise.then(
        () => { admission.expiresAt = Date.now() + 24 * 60 * 60_000; },
        () => { if (this.deliveryAdmissions.get(meta.deliveryId!) === admission) this.deliveryAdmissions.delete(meta.deliveryId!); },
      );
      if (this.deliveryAdmissions.size > 10_000) {
        for (const [id, item] of this.deliveryAdmissions) if (item.expiresAt <= now) this.deliveryAdmissions.delete(id);
      }
      return promise;
    }
    return this.admitDelivery(agentId, from, target, mentioned, meta);
  }

  private async admitDurableDelivery(key: string, from: string, target: string, mentioned: boolean, meta: DeliverMeta, epoch: number, markPrepared: () => void): Promise<void> {
    const agentId = agentIdOf(key);
    const deliveryId = meta.deliveryId!;
    try {
      if (await this.deliveryAdmissionStore.has(deliveryId)) {
        this.log.debug("persisted duplicate delivery suppressed", { agentId, deliveryId });
        await this.beforeRuntimeDelivery(agentId, meta);
        return;
      }
      if ((this.deliveryEpochs.get(key) ?? 0) !== epoch) {
        throw this.deliveryCancellationErrors.get(key) ?? new Error(`agent lifecycle changed before delivery admission: ${agentId}`);
      }
      const admission = this.admitDelivery(agentId, from, target, mentioned, meta);
      markPrepared();
      await admission;
      const expiresAt = Date.now() + 24 * 60 * 60_000;
      try {
        await this.deliveryAdmissionStore.remember(deliveryId, expiresAt);
      } catch (error) {
        // Runtime responsibility was already accepted. NACKing here would make the server retry work
        // that may be running, so ACK and rely on the server's per-recipient admission ledger.
        this.log.error("delivery admission persistence failed", { agentId, deliveryId, detail: String(error) });
      }
    } finally {
      markPrepared();
    }
  }

  /** Fence one scope's delivery lifecycle (per-scope exit/failStart). */
  private invalidateDeliveryLifecycleKey(key: string, error: Error): void {
    this.deliveryEpochs.set(key, (this.deliveryEpochs.get(key) ?? 0) + 1);
    this.deliveryCancellationErrors.set(key, error);
  }

  /** Fence every scope of this agent (whole-agent lifecycle change): any in-flight durable admission
   *  that already captured an older epoch — including epoch 0 for a key with no entry yet — must
   *  observe the bump, so sweep every key the agent currently has state under. */
  private invalidateDeliveryLifecycle(agentId: string, error: Error): void {
    const keys = new Set<string>();
    for (const map of [this.agents, this.starting, this.pendingDelivers, this.deliveryPreparations, this.deliveryPreparationTails, this.deliveryEpochs, this.deliveryCancellationErrors]) {
      for (const k of map.keys()) if (agentIdOf(k) === agentId) keys.add(k);
    }
    for (const key of keys) this.invalidateDeliveryLifecycleKey(key, error);
  }

  private admitDelivery(agentId: string, from: string, target: string, mentioned: boolean, meta: DeliverMeta): Promise<void> {
    const admission = this.createAdmission();
    // Route by (agent, scope): a scoped deliver reaches only that scope's runtime, and the `starting` /
    // pendingDelivers fences below are per-scope too — one scope's startup can no longer swallow a
    // sibling scope's delivery.
    const key = scopeKey(agentId, meta.scope);
    const r = this.agents.get(key);
    if (!r || this.starting.has(key)) {
      this.queuePendingDeliver(key, { from, target, mentioned, meta, admission });
      return admission.promise;
    }
    // New servers already debounce by sender-scoped Conversation Turn. Keep each durable turn isolated
    // here; legacy deliveries without a turn id retain the old per-agent batching behavior.
    const tname = meta.targetName ?? target;
    const short = meta.msgShort ?? "";
    const turnKey = meta.turnId ?? "legacy";
    const buffers = r.deliverBufs ?? new Map<string, DeliverBuf>();
    r.deliverBufs = buffers;
    const b = buffers.get(turnKey);
    if (b) { // accumulate: count++, update latest, keep first unchanged, union target set
      clearTimeout(b.timer); b.count = Math.max(b.count + 1, meta.turnMessageCount ?? 0); b.from = from; b.target = target; b.targetName = tname; b.latestShort = short;
      b.isTask = b.isTask || !!meta.isTask; b.mentioned = b.mentioned || mentioned; b.targets.add(tname); b.streamId = meta.streamId ?? b.streamId; b.attention = meta.attention ?? b.attention; b.deliveryId = meta.deliveryId ?? b.deliveryId; b.seq = meta.seq ?? b.seq;
    }
    const buf: DeliverBuf = b ?? { count: meta.turnMessageCount ?? 1, from, target, targetName: tname, firstShort: short, latestShort: short, isTask: !!meta.isTask, mentioned, targets: new Set([tname]), timer: undefined as any, admissions: [], streamId: meta.streamId, attention: meta.attention, deliveryId: meta.deliveryId, seq: meta.seq };
    buf.admissions.push(admission);
    buf.timer = setTimeout(() => void (async () => {
      buffers.delete(turnKey);
      if (!buffers.size) r.deliverBufs = undefined;
      if (r.turnActive) {
        const queue = r.deliveryQueue ?? [];
        r.deliveryQueue = queue;
        queue.push(buf);
        this.log.debug("inbox notice queued behind active turn", { agentId, count: buf.count, queued: queue.length });
        return;
      }
      await this.admitBufferedDelivery(key, r, buf);
    })(), meta.turnId ? 0 : this.debounceMsFor(r));
    buffers.set(turnKey, buf);
    return admission.promise;
  }
}
