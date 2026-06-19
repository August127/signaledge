import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAPlusTelegramPayload,
  createTelegramNotifier,
  evaluateSignalOutcome,
  formatAPlusTelegramMessage,
  formatSignalResultTelegramMessage,
} from "./telegram.js";

const analysis = {
  timeframe: "H4",
  rows: [{ close: 100 }],
  atrValues: [2],
  score: {
    direction: "bull",
    components: { structure: 38, momentum: 27, entry: 24 },
    evidence: { crystal: "confirmed", rr: 1.6 },
    executability: { gates: { structure: true, trend: true, volatility: true }, failed: [] },
  },
  sync: { snapshotId: "snapshot-1" },
};

const row = { symbol: "FPT", market: "VN30", score: 89, classification: "A+", aligned: true, crystal: "arrow" };

test("A+ Telegram formatter is compact and includes plan, risk, entry zone, and disclaimer", () => {
  const message = formatAPlusTelegramMessage({ row, analysis, quote: { price: 101 }, snapshotId: "scanner-1" });
  assert.match(message, /SignalEdge A\+ RANK-UP/);
  assert.match(message, /Plan tham khảo/);
  assert.match(message, /Entry: <b>101/);
  assert.match(message, /Zone: <b>100\.3 - 101\.3/);
  assert.match(message, /Risk: <b>19% THẤP/);
  assert.match(message, /Đây chỉ là chia sẻ thông tin không phải khuyến nghị đầu tư/);
});

test("A+ payload exposes a trackable plan and result formatter reports TP progress", () => {
  const { plan } = buildAPlusTelegramPayload({ row, analysis, quote: { price: 101 }, snapshotId: "scanner-1" });
  assert.equal(plan.entry, 101);
  assert.equal(plan.tp1, 105.8);
  const outcome = evaluateSignalOutcome({ ...plan, checkpoints: {} }, 105.8);
  assert.equal(outcome.type, "tp1");
  assert.equal(outcome.final, false);
  const result = formatSignalResultTelegramMessage({ signal: plan, price: 105.8, outcome, observedAt: "2026-06-18T00:00:00.000Z" });
  assert.match(result, /SignalEdge RESULT · TAKE PROFIT 1 DONE/);
  assert.match(result, /P\/L tạm tính: <b>\+4\.75%/);
});

test("Telegram notifier skips duplicates and missing configuration", async () => {
  const unconfigured = createTelegramNotifier({ token: "", chatId: "", fetcher: async () => ({ ok: true }) });
  assert.deepEqual(await unconfigured.sendAPlus({ key: "x", message: "m" }), { sent: false, skipped: true, reason: "telegram_not_configured" });

  let calls = 0;
  const configured = createTelegramNotifier({
    token: "token",
    chatId: "chat",
    now: () => 1_000,
    fetcher: async () => {
      calls += 1;
      return { ok: true };
    },
  });
  assert.equal((await configured.sendAPlus({ key: "snapshot:FPT", message: "m" })).sent, true);
  assert.deepEqual(await configured.sendResult({ key: "snapshot:FPT", message: "m" }), { sent: false, skipped: true, reason: "duplicate" });
  assert.equal(calls, 1);
});
