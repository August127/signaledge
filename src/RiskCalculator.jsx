import { useEffect, useMemo, useState } from "react";

const formatNumber = (value, digits = 2) => Number.isFinite(value)
  ? value.toLocaleString("en-US", { maximumFractionDigits: digits })
  : "--";

export function RiskCalculator({ analysis, entryPrice, copy }) {
  const crypto = analysis?.meta?.market === "CRYPTO";
  const storageKey = crypto ? "scanner-risk-crypto" : "scanner-risk-vn";
  const defaults = crypto ? { accountSize: 10000, riskPercent: 1 } : { accountSize: 500000000, riskPercent: 1 };
  const [settings, setSettings] = useState(() => {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(storageKey) ?? "{}") }; } catch { return defaults; }
  });

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      setSettings({ ...defaults, ...saved });
    } catch {
      setSettings(defaults);
    }
  }, [storageKey]);

  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify(settings)); }, [settings, storageKey]);

  const result = useMemo(() => {
    const atr = analysis?.atrValues?.at(-1);
    if (!Number.isFinite(entryPrice) || !Number.isFinite(atr)) return {};
    const direction = analysis?.score?.direction === "bear" ? -1 : 1;
    const stopDistance = atr * 1.5;
    const riskBudget = settings.accountSize * settings.riskPercent / 100;
    const monetaryRiskPerUnit = stopDistance * (crypto ? 1 : 1000);
    return {
      riskBudget,
      stop: entryPrice - direction * stopDistance,
      tp1: entryPrice + direction * atr * 2.4,
      tp2: entryPrice + direction * atr * 3.5,
      units: monetaryRiskPerUnit > 0 ? (crypto ? riskBudget / monetaryRiskPerUnit : Math.floor(riskBudget / monetaryRiskPerUnit)) : null,
      currency: crypto ? "USDT" : "VND",
    };
  }, [analysis, crypto, entryPrice, settings]);

  const update = (key, value) => setSettings((current) => ({ ...current, [key]: Math.max(0, Number(value) || 0) }));

  return (
    <section className="risk">
      <h3>{copy.risk.title}</h3>
      <label>{copy.risk.accountSize} <input type="number" min="0" value={settings.accountSize} onChange={(event) => update("accountSize", event.target.value)} /><small>{result.currency}</small></label>
      <label>{copy.risk.riskPerTrade} <input type="number" min="0.1" max="10" step="0.1" value={settings.riskPercent} onChange={(event) => update("riskPercent", event.target.value)} /><small>% · {formatNumber(result.riskBudget, 0)}</small></label>
      <div className="risk-grid">
        <label>{copy.risk.entry} <span>{formatNumber(entryPrice)}</span></label>
        <label>{copy.risk.stopLoss} <span>{formatNumber(result.stop)}</span></label>
        <label>{copy.risk.takeProfit1} <span>{formatNumber(result.tp1)}</span></label>
        <label>{copy.risk.takeProfit2} <span>{formatNumber(result.tp2)}</span></label>
      </div>
      <div className="position"><span>{copy.risk.positionSize}</span><strong>{formatNumber(result.units, crypto ? 4 : 0)}</strong><small>{copy.risk.units}</small></div>
    </section>
  );
}
