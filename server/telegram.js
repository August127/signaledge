function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: digits })
    : "--";
}

function directionLabel(direction) {
  return direction === "bear" ? "SHORT / SELL WATCH" : "LONG / BUY WATCH";
}

function entryZone(entry, atr, direction) {
  if (!Number.isFinite(entry) || !Number.isFinite(atr)) return null;
  const shallow = atr * 0.15;
  const pullback = atr * 0.35;
  return direction === "bear"
    ? [entry - shallow, entry + pullback]
    : [entry - pullback, entry + shallow];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function riskLabel(riskPercent) {
  if (riskPercent <= 20) return "THẤP";
  if (riskPercent <= 40) return "TRUNG BÌNH";
  if (riskPercent <= 60) return "CAO";
  return "RẤT CAO";
}

function calculateSystemRisk({ row, score }) {
  const total = Number.isFinite(score.total) ? score.total : row.score;
  const failedCount = score.executability?.failed?.length ?? 0;
  const rr = score.evidence?.rr;
  const atrPercentile = score.evidence?.atrPercentile;
  const crystal = String(row.crystal ?? score.evidence?.crystal ?? "").toLowerCase();
  const baseRisk = 100 - (Number.isFinite(total) ? total : 0);
  const failedGatePenalty = failedCount * 8;
  const mtfPenalty = row.aligned ? 0 : 12;
  const rrPenalty = Number.isFinite(rr)
    ? rr >= 1.8 ? 0 : rr >= 1.5 ? 4 : rr >= 1.2 ? 8 : 14
    : 8;
  const atrPenalty = Number.isFinite(atrPercentile)
    ? atrPercentile < 0.28 ? 12 : atrPercentile > 0.9 ? 6 : atrPercentile < 0.4 ? 4 : 0
    : 4;
  const crystalPenalty = crystal.includes("arrow") || crystal.includes("confirmed")
    ? 0
    : crystal.includes("circle") ? 8 : 5;

  return clamp(Math.round(baseRisk + failedGatePenalty + mtfPenalty + rrPenalty + atrPenalty + crystalPenalty), 0, 100);
}

export function buildAPlusTelegramPayload({ row, analysis, quote, snapshotId }) {
  const score = analysis.score;
  const last = analysis.rows.at(-1);
  const atr = analysis.atrValues.at(-1);
  const direction = score.direction ?? row.direction;
  const entry = Number.isFinite(quote?.price) ? quote.price : last?.close;
  const riskConfig = analysis.scannerConfig ?? {};
  const stopMultiplier = Number.isFinite(riskConfig.riskAtrStopMultiplier) ? riskConfig.riskAtrStopMultiplier : 1.5;
  const tp1Multiplier = Number.isFinite(riskConfig.riskTp1AtrMultiplier) ? riskConfig.riskTp1AtrMultiplier : 2.4;
  const tp2Multiplier = Number.isFinite(riskConfig.riskTp2AtrMultiplier) ? riskConfig.riskTp2AtrMultiplier : 3.5;
  const zone = entryZone(entry, atr, direction);
  const stop = Number.isFinite(entry) && Number.isFinite(atr)
    ? direction === "bear" ? entry + atr * stopMultiplier : entry - atr * stopMultiplier
    : null;
  const tp1 = Number.isFinite(entry) && Number.isFinite(atr)
    ? direction === "bear" ? entry - atr * tp1Multiplier : entry + atr * tp1Multiplier
    : null;
  const tp2 = Number.isFinite(entry) && Number.isFinite(atr)
    ? direction === "bear" ? entry - atr * tp2Multiplier : entry + atr * tp2Multiplier
    : null;
  const rr = score.evidence?.rr ?? (Number.isFinite(entry) && Number.isFinite(stop) && Number.isFinite(tp1)
    ? Math.abs(tp1 - entry) / Math.abs(entry - stop)
    : null);
  const gates = score.executability?.gates ?? {};
  const failed = score.executability?.failed?.length ? score.executability.failed.join(", ") : "none";
  const systemRisk = calculateSystemRisk({ row, score });
  const plan = {
    symbol: row.symbol,
    market: row.market,
    timeframe: analysis.timeframe,
    direction,
    side: directionLabel(direction),
    entry,
    zoneLow: zone?.[0] ?? null,
    zoneHigh: zone?.[1] ?? null,
    stop,
    tp1,
    tp2,
    rr,
    atr,
    score: row.score,
    classification: row.classification,
    aligned: row.aligned,
    crystal: row.crystal,
    systemRisk,
    riskLabel: riskLabel(systemRisk),
    snapshotId: snapshotId ?? analysis.sync?.snapshotId ?? "n/a",
  };

  const message = [
    "<b>SignalEdge A+ RANK-UP</b>",
    `<b>${escapeHtml(row.symbol)}</b> · ${escapeHtml(row.market)} · ${escapeHtml(analysis.timeframe)} · ${escapeHtml(plan.side)}`,
    `Score: <b>${row.score}/100 ${escapeHtml(row.classification)}</b> | Risk: <b>${systemRisk}% ${riskLabel(systemRisk)}</b>`,
    `MTF: <b>${row.aligned ? "D1/H4 OK" : "Mixed"}</b> | Crystal: <b>${escapeHtml(row.crystal?.toUpperCase())}</b>`,
    "",
    "<b>Plan tham khảo</b>",
    `Entry: <b>${formatNumber(entry)}</b> | Zone: <b>${zone ? `${formatNumber(zone[0])} - ${formatNumber(zone[1])}` : "--"}</b>`,
    `SL: <b>${formatNumber(stop)}</b> | TP1: <b>${formatNumber(tp1)}</b> | TP2: <b>${formatNumber(tp2)}</b>`,
    `R:R: <b>${Number.isFinite(rr) ? `1:${Number(rr).toFixed(2)}` : "--"}</b> | ATR: <b>${formatNumber(atr)}</b>`,
    "",
    "<b>Căn cứ</b>",
    `Structure ${score.components.structure}/40 · Momentum ${score.components.momentum}/30 · Entry ${score.components.entry}/30`,
    `Crystal ${escapeHtml(score.evidence.crystal)} · BOS ${gates.structure ? "PASS" : "CHECK"} · EMA ${gates.trend ? "PASS" : "CHECK"} · ATR ${gates.volatility ? "PASS" : "CHECK"}`,
    `Failed gates: <b>${escapeHtml(failed)}</b>`,
    "",
    `<b>Snapshot:</b> <code>${escapeHtml(plan.snapshotId)}</code>`,
    "",
    "<i>Đây chỉ là chia sẻ thông tin không phải khuyến nghị đầu tư.</i>",
  ].join("\n");

  return { message, plan };
}

export function formatAPlusTelegramMessage(input) {
  return buildAPlusTelegramPayload(input).message;
}

export function evaluateSignalOutcome(signal, price) {
  if (!Number.isFinite(price) || !Number.isFinite(signal?.entry)) return null;
  const checkpoints = signal.checkpoints ?? {};
  const bear = signal.direction === "bear";
  const pnlPercent = bear
    ? ((signal.entry - price) / signal.entry) * 100
    : ((price - signal.entry) / signal.entry) * 100;
  const hitStop = Number.isFinite(signal.stop) && (bear ? price >= signal.stop : price <= signal.stop);
  const hitTp2 = Number.isFinite(signal.tp2) && (bear ? price <= signal.tp2 : price >= signal.tp2);
  const hitTp1 = Number.isFinite(signal.tp1) && (bear ? price <= signal.tp1 : price >= signal.tp1);

  if (hitStop && !checkpoints.stoploss) {
    return { type: "stoploss", label: "STOPLOSS TOUCHED", final: true, pnlPercent, progressPercent: 100 };
  }
  if (hitTp2 && !checkpoints.tp2) {
    return { type: "tp2", label: "TAKE PROFIT 2 DONE", final: true, pnlPercent, progressPercent: 100 };
  }
  if (hitTp1 && !checkpoints.tp1) {
    const denominator = Math.max(Math.abs(signal.tp1 - signal.entry), 0.00001);
    const progressPercent = clamp(Math.abs(price - signal.entry) / denominator * 100, 0, 999);
    return { type: "tp1", label: "TAKE PROFIT 1 DONE", final: false, pnlPercent, progressPercent };
  }
  return null;
}

export function formatSignalResultTelegramMessage({ signal, price, outcome, observedAt = new Date().toISOString() }) {
  const pnl = Number.isFinite(outcome.pnlPercent) ? `${outcome.pnlPercent >= 0 ? "+" : ""}${outcome.pnlPercent.toFixed(2)}%` : "--";
  const progress = Number.isFinite(outcome.progressPercent) ? `${Math.round(outcome.progressPercent)}%` : "--";
  return [
    `<b>SignalEdge RESULT · ${escapeHtml(outcome.label)}</b>`,
    `<b>${escapeHtml(signal.symbol)}</b> · ${escapeHtml(signal.market)} · ${escapeHtml(signal.timeframe)} · ${escapeHtml(signal.side ?? directionLabel(signal.direction))}`,
    `Giá hiện tại: <b>${formatNumber(price)}</b> | P/L tạm tính: <b>${pnl}</b>`,
    `Tiến độ mục tiêu: <b>${progress}</b> | Entry: <b>${formatNumber(signal.entry)}</b>`,
    `SL: <b>${formatNumber(signal.stop)}</b> | TP1: <b>${formatNumber(signal.tp1)}</b> | TP2: <b>${formatNumber(signal.tp2)}</b>`,
    `<b>Snapshot:</b> <code>${escapeHtml(signal.snapshotId ?? "n/a")}</code>`,
    `<i>${escapeHtml(observedAt)}</i>`,
    "",
    "<i>Đây chỉ là chia sẻ thông tin không phải khuyến nghị đầu tư.</i>",
  ].join("\n");
}

export function createTelegramNotifier({
  token = process.env.TELEGRAM_BOT_TOKEN,
  chatId = process.env.TELEGRAM_CHAT_ID,
  threadId = process.env.TELEGRAM_THREAD_ID,
  fetcher = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const sent = new Map();
  const ttlMs = 24 * 60 * 60 * 1000;
  const configured = Boolean(token && chatId && fetcher);

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [key, timestamp] of sent.entries()) {
      if (timestamp < cutoff) sent.delete(key);
    }
  }

  async function sendMessage({ key, message }) {
    prune();
    if (!configured) return { sent: false, skipped: true, reason: "telegram_not_configured" };
    if (sent.has(key)) return { sent: false, skipped: true, reason: "duplicate" };
    const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_thread_id: threadId || undefined,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`telegram_send_failed:${response.status}:${body.slice(0, 160)}`);
    }
    sent.set(key, now());
    return { sent: true, skipped: false };
  }

  return {
    configured,
    sendMessage,
    sendAPlus: sendMessage,
    sendResult: sendMessage,
  };
}
