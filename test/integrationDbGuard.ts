// Guard for real-DB integration tests: refuse to run against the LIVE main database.
// `src/db/index.ts` falls back to `postgres://opentag:opentag@localhost:5433/opentag` when
// DATABASE_URL is unset — an integration test started bare would silently seed/truncate the
// developer's real workspace DB (this actually happened: test agents leaked into `opentag`).
// Allowed: any explicitly isolated database (worktree DBs like `opentag_<name>`, or `*_test`).
// Refused: the bare fallback `opentag`.
export function integrationDbName(databaseUrl: string | undefined, fallback = "postgres://opentag:opentag@localhost:5433/opentag"): string {
  return (databaseUrl ?? fallback).replace(/\/+$/, "").split("/").pop()!.split("?")[0]!;
}

export function assertIntegrationDbIsolated(label: string, env: NodeJS.ProcessEnv = process.env): void {
  if (integrationDbName(env.DATABASE_URL) === "opentag") {
    console.error(
      `✗ ${label}: refusing to run against the live database 'opentag'.\n` +
      "  Set DATABASE_URL to an isolated DB, e.g.:\n" +
      `    DATABASE_URL=postgres://opentag:opentag@localhost:5433/opentag_test npx tsx ${label}\n` +
      "  (unset DATABASE_URL falls back to the live 'opentag')",
    );
    process.exit(1);
  }
}
