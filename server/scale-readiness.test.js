import test from "node:test";
import assert from "node:assert/strict";
import { dataPolicy, scaleReadiness } from "./scale-readiness.js";

test("scale readiness does not claim horizontal capacity before shared infrastructure exists", () => {
  const status = scaleReadiness({ INSTANCE_COUNT: "4", DEPLOYMENT_MODE: "cluster" });
  assert.equal(status.horizontalReady, false);
  assert.equal(status.requestedInstances, 4);
  assert.ok(status.blockers.length >= 4);
});

test("hybrid market data policy forbids synthetic data", () => {
  assert.equal(dataPolicy({ DATA_PROVIDER: "hybrid" }).syntheticAllowed, false);
  assert.equal(dataPolicy({ DATA_PROVIDER: "fixture", ALLOW_FIXTURE_DATA: "false" }).syntheticAllowed, false);
});
