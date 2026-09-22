// src/server/systemAdmin.api.test.ts
// Real-server API tests for the system-admin plane (pattern: agentLifecycle.api.test.ts).
// Runs against the WORKTREE db — creates its own users via direct db inserts.
import "../env.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { eq } from "drizzle-orm";
import { db, schema, sql } from "../db/index.js";
import { hashPassword, signUser } from "./auth.js";

let serverProcess: ChildProcess | null = null;
let base = "";
const suffix = randomUUID().slice(0, 8);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function startServer(): Promise<string> {
  const port = await freePort();
  const chunks: string[] = [];
  serverProcess = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout?.on("data", (chunk) => chunks.push(String(chunk)));
  serverProcess.stderr?.on("data", (chunk) => chunks.push(String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (serverProcess.exitCode != null) throw new Error(`server exited ${serverProcess.exitCode}: ${chunks.join("")}`);
    try { if ((await fetch(`${base}/health`)).ok) return base; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${chunks.join("")}`);
}

function api(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(base + pathname, init);
}
async function insertUser(opts: { email: string; name: string; password: string; systemRole?: string | null; disabledAt?: Date | null }) {
  const [u] = await db.insert(schema.users).values({
    name: opts.name, displayName: opts.name, email: opts.email,
    passwordHash: hashPassword(opts.password),
    systemRole: opts.systemRole ?? null, disabledAt: opts.disabledAt ?? null,
  }).returning();
  return u!;
}

before(async () => { base = await startServer(); });
after(async () => { if (serverProcess?.pid) serverProcess.kill("SIGTERM"); await sql.end(); });

test("disabled user: login 403, existing JWT rejected at gate 1, me exposes systemRole", async () => {
  const admin = await insertUser({ email: `sa1-${suffix}@t.local`, name: `sa1${suffix}`, password: "password-1", systemRole: "system_admin" });
  const victim = await insertUser({ email: `vi1-${suffix}@t.local`, name: `vi1${suffix}`, password: "password-1" });

  const meRes = await api("/api/auth/me", { headers: { authorization: `Bearer ${signUser(admin.id)}` } });
  assert.equal(meRes.status, 200);
  assert.equal(((await meRes.json()) as any).systemRole, "system_admin");

  const okRes = await api("/api/auth/me", { headers: { authorization: `Bearer ${signUser(victim.id)}` } });
  assert.equal(okRes.status, 200);

  await db.update(schema.users).set({ disabledAt: new Date() }).where(eq(schema.users.id, victim.id));
  const rej = await api("/api/auth/me", { headers: { authorization: `Bearer ${signUser(victim.id)}` } });
  assert.equal(rej.status, 401);

  const loginRes = await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: victim.email, password: "password-1" }) });
  assert.equal(loginRes.status, 403);
  assert.equal(((await loginRes.json()) as any).code, "auth_account_disabled");
});
