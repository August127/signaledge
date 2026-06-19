const production = process.env.NODE_ENV === "production";

export const subscriptionTiers = [
  {
    id: "free",
    name: "SignalEdge Free Signal",
    rank: 0,
    capacity: 3500,
    condition: "Dang ky cong dong",
    description: "Free chart va bang ma co ban de theo doi thi truong bang du lieu that.",
    entitlements: ["app_access", "vn_universe", "basic_chart", "plans_view"],
  },
  {
    id: "pro",
    name: "SignalEdge Pro",
    rank: 1,
    capacity: 1479,
    condition: "Xac nhan broker code / ma truy cap do admin cap",
    description: "Mo khoa toan bo scanner VN/Crypto, A+/A signals, Telegram, journal, risk tools va dashboard hieu suat.",
    entitlements: ["app_access", "vn_universe", "crypto_universe", "basic_chart", "scanner_watch", "a_plus_signal", "performance_view", "app_alert", "telegram_alert", "journal", "advanced_filters", "risk_tools", "security_view", "settings_view", "desk_support", "plans_view"],
  },
  {
    id: "admin",
    name: "SignalEdge Admin",
    rank: 2,
    capacity: 1,
    condition: "Owner account",
    description: "Tai khoan owner co toan quyen Pro, xem tat ca tin hieu/chart va quan tri tai khoan, subscription, scanner.",
    entitlements: ["app_access", "vn_universe", "crypto_universe", "basic_chart", "scanner_watch", "a_plus_signal", "performance_view", "app_alert", "telegram_alert", "journal", "advanced_filters", "risk_tools", "security_view", "settings_view", "desk_support", "plans_view", "admin_console", "subscription_admin", "feature_admin"],
  },
];
const tierById = new Map(subscriptionTiers.map((tier) => [tier.id, tier]));

function configuredPasses() {
  const passes = {
    free: process.env.SIGNALEDGE_FREE_PASS,
    pro: process.env.SIGNALEDGE_PRO_PASS,
    admin: process.env.SIGNALEDGE_ADMIN_PASS,
  };
  if (!production) {
    return {
      free: passes.free || "FREE",
      pro: passes.pro || "PRO",
      admin: passes.admin || "ADMIN",
    };
  }
  return passes;
}

export function getSubscriptionTier(tierId = "free") {
  return tierById.get(String(tierId || "free").toLowerCase()) ?? null;
}

export function createSubscriptionProfile(tierId = "free", overrides = {}) {
  const tier = getSubscriptionTier(tierId);
  if (!tier) return null;
  return {
    userId: `local-${tier.id}`,
    displayName: tier.id === "admin" ? "SignalEdge Owner Admin" : tier.id === "free" ? "SignalEdge Member" : `${tier.name} Member`,
    tier: tier.id,
    tierName: tier.name,
    rank: tier.rank,
    entitlements: tier.entitlements,
    status: "active",
    brokerCodeStatus: ["free", "admin"].includes(tier.id) ? "not_required" : "pending_verification",
    expiresAt: null,
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function adminUsername() {
  return process.env.SIGNALEDGE_ADMIN_USERNAME || "admin";
}

export function authenticateAdmin({ username = "", password = "" } = {}) {
  const expectedUsername = adminUsername();
  const expectedPassword = process.env.SIGNALEDGE_ADMIN_PASSWORD || process.env.SIGNALEDGE_ADMIN_PASS || (!production ? "ADMIN" : "");
  const usernameOk = String(username).trim().toLowerCase() === expectedUsername.toLowerCase();
  const passwordOk = Boolean(expectedPassword) && String(password) === expectedPassword;
  if (!usernameOk || !passwordOk) return { ok: false, status: 401, error: "invalid_admin_credentials" };
  return {
    ok: true,
    profile: createSubscriptionProfile("admin", {
      userId: "owner-admin",
      username: expectedUsername,
      displayName: "SignalEdge Owner Admin",
      authMode: "admin-password",
    }),
  };
}

export function subscriptionCapacity() {
  const targetMaxUsers = Number(process.env.SIGNALEDGE_MAX_USERS ?? 4980);
  const tierCapacity = Object.fromEntries(subscriptionTiers.map((tier) => [tier.id, tier.capacity]));
  return { targetMaxUsers, tierCapacity, currentModel: "single-tenant beta access pass" };
}

export function publicSubscriptionPlans() {
  return {
    tiers: subscriptionTiers.map(({ id, name, rank, capacity, condition, description, entitlements }) => ({
      id,
      name,
      rank,
      capacity,
      condition,
      description,
      entitlements,
    })),
    capacity: subscriptionCapacity(),
  };
}

export function activateSubscription({ accessCode = "", requestedTier = "free" } = {}) {
  const normalizedTier = String(requestedTier || "free").toLowerCase();
  const tier = tierById.get(normalizedTier);
  if (!tier) return { ok: false, status: 400, error: "unknown_subscription_tier" };

  const passes = configuredPasses();
  const supplied = String(accessCode || "").trim();
  const expected = passes[tier.id];
  const freeAllowed = tier.id === "free" && (!expected || supplied === "" || supplied === expected);
  const passAllowed = Boolean(expected && supplied === expected);

  if (!freeAllowed && !passAllowed) {
    return { ok: false, status: 401, error: "invalid_subscription_pass", tier: tier.id };
  }

  return {
    ok: true,
    profile: createSubscriptionProfile(tier.id),
  };
}

