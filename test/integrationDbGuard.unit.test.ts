import test from "node:test";
import assert from "node:assert/strict";
import { integrationDbName } from "./integrationDbGuard.ts";

test("the integration DB guard names the database it would touch", () => {
  assert.equal(integrationDbName(undefined), "opentag", "unset DATABASE_URL falls back to the LIVE database");
  assert.equal(integrationDbName("postgres://opentag:opentag@localhost:5433/opentag"), "opentag");
  assert.equal(integrationDbName("postgres://opentag:opentag@localhost:5433/opentag_test"), "opentag_test");
  assert.equal(integrationDbName("postgres://opentag:opentag@localhost:5433/opentag_live_activity_restore"), "opentag_live_activity_restore");
  assert.equal(integrationDbName("postgres://u:p@h:5433/opentag_ghost_run_sweep/"), "opentag_ghost_run_sweep", "trailing slash tolerated");
  assert.equal(integrationDbName("postgres://u:p@h:5433/opentag_test?sslmode=require"), "opentag_test", "query string stripped");
});
