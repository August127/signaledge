export function scaleReadiness(env = process.env) {
  const requestedInstances = Math.max(1, Number(env.INSTANCE_COUNT ?? 1));
  const capabilities = {
    sharedCache: Boolean(env.REDIS_URL),
    sharedPersistence: Boolean(env.DATABASE_URL),
    distributedRateLimit: false,
    backgroundWorkers: false,
    realtimeFanout: false,
    statelessApi: false,
  };
  const blockers = [];
  if (!capabilities.sharedCache) blockers.push("Redis shared cache is not configured");
  if (!capabilities.sharedPersistence) blockers.push("PostgreSQL persistence is not configured");
  if (!capabilities.distributedRateLimit) blockers.push("Rate limiting is process-local");
  if (!capabilities.backgroundWorkers) blockers.push("Scanner jobs still run in the API process");
  if (!capabilities.realtimeFanout) blockers.push("No shared realtime fanout layer");
  if (!capabilities.statelessApi) blockers.push("Snapshot cache and operations are instance-local");
  return {
    deploymentMode: env.DEPLOYMENT_MODE ?? "single-node",
    requestedInstances,
    singleNodeReady: true,
    horizontalReady: blockers.length === 0,
    target: "10k-concurrent-users",
    capabilities,
    blockers,
  };
}

export function dataPolicy(env = process.env) {
  const fixtureExplicitlyAllowed = env.NODE_ENV === "test" || env.ALLOW_FIXTURE_DATA === "true";
  return {
    mode: env.DATA_PROVIDER ?? "hybrid",
    syntheticAllowed: (env.DATA_PROVIDER ?? "hybrid") === "fixture" && fixtureExplicitlyAllowed,
    productionFailClosed: true,
  };
}
