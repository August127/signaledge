import test from "node:test";
import assert from "node:assert/strict";
import { activateSubscription, publicSubscriptionPlans, subscriptionCapacity } from "./subscription.js";

test("subscription plans expose a capacity model below 5000 users", () => {
  const plans = publicSubscriptionPlans();
  assert.equal(plans.capacity.targetMaxUsers, 4980);
  assert.deepEqual(plans.tiers.map((tier) => tier.id), ["free", "pro", "admin"]);
  assert.ok(plans.tiers.find((tier) => tier.id === "free").entitlements.includes("vn_universe"));
  assert.ok(!plans.tiers.find((tier) => tier.id === "free").entitlements.includes("scanner_watch"));
  assert.ok(plans.tiers.find((tier) => tier.id === "pro").entitlements.includes("scanner_watch"));
  assert.ok(plans.tiers.find((tier) => tier.id === "admin").entitlements.includes("subscription_admin"));
});

test("development access passes activate the expected entitlement profile", () => {
  const denied = activateSubscription({ requestedTier: "pro", accessCode: "WRONG" });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 401);

  const removedTier = activateSubscription({ requestedTier: "signal", accessCode: "SIGNAL" });
  assert.equal(removedTier.ok, false);
  assert.equal(removedTier.status, 400);

  const free = activateSubscription({ requestedTier: "free" });
  assert.equal(free.ok, true);
  assert.equal(free.profile.tier, "free");
  assert.ok(!free.profile.entitlements.includes("telegram_alert"));

  const pro = activateSubscription({ requestedTier: "pro", accessCode: "PRO" });
  assert.equal(pro.ok, true);
  assert.equal(pro.profile.tier, "pro");
  assert.ok(!pro.profile.entitlements.includes("us_universe"));
  assert.ok(pro.profile.entitlements.includes("journal"));

  const admin = activateSubscription({ requestedTier: "admin", accessCode: "ADMIN" });
  assert.equal(admin.ok, true);
  assert.equal(admin.profile.tier, "admin");
  assert.ok(admin.profile.entitlements.includes("scanner_watch"));
  assert.ok(admin.profile.entitlements.includes("telegram_alert"));
  assert.ok(admin.profile.entitlements.includes("journal"));
  assert.ok(admin.profile.entitlements.includes("admin_console"));
  assert.equal(admin.profile.brokerCodeStatus, "not_required");
});

test("capacity helper is explicit for production sizing discussions", () => {
  const capacity = subscriptionCapacity();
  const totalCapacity = Object.values(capacity.tierCapacity).reduce((sum, value) => sum + value, 0);
  assert.equal(totalCapacity, capacity.targetMaxUsers);
});
