export const TIER_RANK = { free: 0, pro: 1, admin: 2 };

export const FEATURE_REQUIREMENTS = {
  cockpit: "free",
  scanner: "pro",
  charts: "free",
  plans: "free",
  vnUniverse: "free",
  cryptoUniverse: "pro",
  performance: "pro",
  alerts: "pro",
  telegramAlert: "pro",
  aPlusSignal: "pro",
  journal: "pro",
  advancedFilters: "pro",
  security: "pro",
  settings: "pro",
  adminConsole: "admin",
  subscriptionAdmin: "admin",
  featureAdmin: "admin",
};

export const RAIL_REQUIREMENTS = {
  Cockpit: "free",
  Scanner: "pro",
  Charts: "free",
  Performance: "pro",
  Journal: "pro",
  Alerts: "pro",
  Plans: "free",
  Security: "pro",
  Settings: "pro",
  Admin: "admin",
};

export const UNIVERSE_REQUIREMENTS = {
  vn: "free",
  crypto: "pro",
};

export function tierRank(tier) {
  return TIER_RANK[tier] ?? 0;
}

export function canAccessTier(profile, requiredTier = "free") {
  return tierRank(profile?.tier) >= tierRank(requiredTier);
}

export function canAccessFeature(profile, feature) {
  return canAccessTier(profile, FEATURE_REQUIREMENTS[feature] ?? "free");
}

export function canAccessRail(profile, rail) {
  return canAccessTier(profile, RAIL_REQUIREMENTS[rail] ?? "free");
}

export function canAccessUniverse(profile, universe) {
  return canAccessTier(profile, UNIVERSE_REQUIREMENTS[universe] ?? "free");
}

export function requiredTierForRail(rail) {
  return RAIL_REQUIREMENTS[rail] ?? "free";
}
