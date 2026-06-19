import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Alarm, ArrowDown, ArrowUp, Bell, BookOpen, ChartBar, ChartLineUp, CheckCircle,
  CirclesFour, Clock, Database, Gear, ListMagnifyingGlass, MagnifyingGlass, NotePencil,
  Plus, Pulse, ShieldCheck, SlidersHorizontal, SquaresFour, Star, Target, WarningCircle,
} from "@phosphor-icons/react";
import { api } from "./api.js";
import { TradingChart } from "./TradingChart.jsx";
import { RiskCalculator } from "./RiskCalculator.jsx";
import { AlertsView, PerformanceView, SecurityView, SettingsView, SubscriptionView } from "./RailViews.jsx";
import { LANGUAGES, getCopy } from "./i18n.js";
import { canAccessFeature, canAccessRail, canAccessUniverse, requiredTierForRail } from "./subscription.js";

const GROUPS = [
  { key: "A+", label: "A+ TRADE", className: "trade" },
  { key: "A", label: "A WATCH", className: "watch" },
  { key: "DATA", label: "DATA / CHART", className: "data" },
  { key: "IGNORE", label: "IGNORE", className: "ignore" },
];

const UNIVERSE_OPTIONS = [
  { key: "vn", shortLabel: "VN Stocks" },
  { key: "crypto", shortLabel: "Crypto Top 100" },
];
const UNIVERSE_KEYS = UNIVERSE_OPTIONS.map((option) => option.key);
const VN_MARKETS = new Set(["VN_INDEX", "VN30", "MIDCAP", "VN"]);

function marketBucket(item) {
  if (item?.market === "CRYPTO") return "crypto";
  return VN_MARKETS.has(item?.market) ? "vn" : "vn";
}

function signalAllowedByMode(item, mode) {
  if (item?.classification === "DATA" || item?.dataState || item?.unavailable) return true;
  if (mode === "aggressive") return item?.crystal === "circle" || item?.crystal === "arrow";
  return item?.crystal === "arrow";
}

function universeLabel(key, copy) {
  return copy.universe[key] ?? copy.universe.fallback;
}

function storedChoice(key, fallback, allowed) {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function storedNumber(key, fallback, min, max) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  } catch {
    return fallback;
  }
}

function storedLayers(fallback) {
  try {
    const value = JSON.parse(localStorage.getItem("signaledge-layers") ?? "null");
    return value && typeof value === "object" ? { ...fallback, ...value } : fallback;
  } catch {
    return fallback;
  }
}

const formatPrice = (value) => Number.isFinite(value) ? (value >= 1000 ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : value.toLocaleString("en-US", { maximumFractionDigits: value < 1 ? 4 : 2 })) : "--";
const formatChange = (value) => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "--";
const formatCompact = (value) => {
  if (!Number.isFinite(value)) return "--";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
};
const scoreColor = (score, state) => state ? "data" : score >= 80 ? "good" : score >= 60 ? "watch" : "bad";
const formatSyncTime = (value) => value ? new Date(value).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--:--";

function Metric({ label, value, change, spark, title, delayed, onClick }) {
  const className = `market-metric ${change < 0 ? "negative" : ""} ${delayed ? "delayed" : ""} ${onClick ? "clickable" : ""}`;
  const content = <><div><span>{label}</span><strong>{formatPrice(value)}</strong><small>{formatChange(change)}</small></div>{spark && <ChartLineUp className="sparkline" size={22} />}</>;
  if (onClick) return <button type="button" className={className} title={title} onClick={onClick}>{content}</button>;
  return <div className={className} title={title}>{content}</div>;
}

function MarketHeaderStat({ label, value, accent }) {
  return <div className="market-header-stat"><span>{label}</span><strong className={accent ?? ""}>{value}</strong></div>;
}

function SidebarButton({ icon: Icon, active, title, locked, onClick }) {
  return <button className={`rail-button ${active ? "active" : ""} ${locked ? "locked" : ""}`} title={locked ? `${title} · Upgrade required` : title} onClick={onClick}><Icon size={19} weight={active ? "fill" : "regular"} />{locked && <span className="lock-dot" />}</button>;
}

function WatchlistRow({ row, selected, onSelect, lockedScores = false }) {
  const Icon = row.direction === "bull" ? ArrowUp : ArrowDown;
  const scoreLabel = row.dataState ? (Number.isFinite(row.rs52w) ? `RS ${row.rs52w}` : row.dataState) : row.score;
  const tfLabel = row.dataState ?? (row.aligned ? "D1 H4" : "D1/H4 MIX");
  return (
    <button className={`watch-row ${selected ? "selected" : ""} ${row.unavailable ? "unavailable" : ""}`} onClick={() => onSelect(row)} title={row.reason}>
      <div className="symbol"><strong>{row.symbol}</strong><span>{row.venue}</span></div>
      {lockedScores ? <>
        <span className="score locked-score">LOCK</span>
        <span className={`tf-align market-change ${row.change < 0 ? "bear" : "bull"}`}>{formatChange(row.change)}</span>
        <span className={`direction ${row.direction}`}><b>--</b></span>
      </> : <>
        <span className={`score ${scoreColor(row.score, row.dataState)}`}>{scoreLabel}</span>
        <span className="tf-align">{tfLabel}</span>
        <span className={`direction ${row.direction}`} title={`Crystal: ${row.crystal}`}>
          {row.crystal === "arrow" && <Icon size={14} weight="bold" />}
          {row.crystal === "circle" && <i className={`crystal-state-circle ${row.direction}`} />}
          {row.crystal === "none" && <b>--</b>}
        </span>
      </>}
    </button>
  );
}

function buildCandleFlow(analysis, price) {
  const rows = analysis?.rows?.slice(-40) ?? [];
  const latestPrice = Number.isFinite(price) ? price : rows.at(-1)?.close;
  const sortedAsks = rows
    .map((row) => ({ price: Math.max(row.high, row.close), volume: row.volume, total: row.volume * Math.max(row.high, row.close), time: row.time }))
    .filter((row) => !Number.isFinite(latestPrice) || row.price >= latestPrice * 0.995)
    .sort((left, right) => right.price - left.price)
    .slice(0, 12);
  const sortedBids = rows
    .map((row) => ({ price: Math.min(row.low, row.close), volume: row.volume, total: row.volume * Math.min(row.low, row.close), time: row.time }))
    .filter((row) => !Number.isFinite(latestPrice) || row.price <= latestPrice * 1.005)
    .sort((left, right) => right.price - left.price)
    .slice(0, 12);
  return { asks: sortedAsks, bids: sortedBids, midpoint: latestPrice };
}

function MarketDepthPanel({ flow, price, change, symbol }) {
  const renderRow = (row, side) => (
    <div className={`depth-row ${side}`} key={`${side}-${row.time}-${row.price}`}>
      <span>{formatPrice(row.price)}</span>
      <span>{formatCompact(row.volume)}</span>
      <span>{formatCompact(row.total)}</span>
    </div>
  );
  return <aside className="market-depth-panel">
    <header><strong>Sổ lệnh</strong><span>Candle flow · verified OHLCV</span></header>
    <div className="depth-tools"><span /> <span /> <span /><b>0.01</b></div>
    <div className="depth-head"><span>Giá</span><span>Khối lượng</span><span>Tổng</span></div>
    <div className="depth-list asks">{flow.asks.map((row) => renderRow(row, "ask"))}</div>
    <div className={`depth-mid ${change < 0 ? "negative" : ""}`}>
      <strong>{formatPrice(price)}</strong>
      <small>{formatChange(change)}</small>
    </div>
    <div className="depth-list bids">{flow.bids.map((row) => renderRow(row, "bid"))}</div>
    <footer>{symbol} · không dùng dữ liệu giả</footer>
  </aside>;
}

function buildTradePlan(analysis, price) {
  const atr = analysis?.atrValues?.at(-1);
  const entry = Number.isFinite(price) ? price : analysis?.rows?.at(-1)?.close;
  if (!Number.isFinite(entry) || !Number.isFinite(atr)) return null;
  const direction = analysis?.score?.direction === "bear" ? "bear" : "bull";
  const config = analysis?.scannerConfig ?? {};
  const stopMultiplier = Number.isFinite(config.riskAtrStopMultiplier) ? config.riskAtrStopMultiplier : 1.5;
  const tp1Multiplier = Number.isFinite(config.riskTp1AtrMultiplier) ? config.riskTp1AtrMultiplier : 2.4;
  const tp2Multiplier = Number.isFinite(config.riskTp2AtrMultiplier) ? config.riskTp2AtrMultiplier : 3.5;
  const side = direction === "bear" ? -1 : 1;
  const stop = entry - side * atr * stopMultiplier;
  const tp1 = entry + side * atr * tp1Multiplier;
  const tp2 = entry + side * atr * tp2Multiplier;
  const riskPercent = Math.abs(entry - stop) / Math.max(Math.abs(entry), 0.00001) * 100;
  const rr = analysis?.score?.evidence?.rr ?? Math.abs(tp1 - entry) / Math.max(Math.abs(entry - stop), 0.00001);
  return { entry, stop, tp1, tp2, direction, side, riskPercent, rr };
}

function evaluateTradePlan(plan, price) {
  if (!plan || !Number.isFinite(price)) return { label: "WAIT DATA", progress: 0, pnlPercent: null, className: "wait" };
  const pnlPercent = plan.direction === "bear"
    ? (plan.entry - price) / Math.max(Math.abs(plan.entry), 0.00001) * 100
    : (price - plan.entry) / Math.max(Math.abs(plan.entry), 0.00001) * 100;
  const hitStop = plan.direction === "bear" ? price >= plan.stop : price <= plan.stop;
  const hitTp2 = plan.direction === "bear" ? price <= plan.tp2 : price >= plan.tp2;
  const hitTp1 = plan.direction === "bear" ? price <= plan.tp1 : price >= plan.tp1;
  const denominator = Math.max(Math.abs(plan.tp1 - plan.entry), 0.00001);
  const progress = Math.max(0, Math.min(100, Math.abs(price - plan.entry) / denominator * 100));
  if (hitStop) return { label: "STOP LOSS", progress: 100, pnlPercent, className: "stop" };
  if (hitTp2) return { label: "TP2 DONE", progress: 100, pnlPercent, className: "done" };
  if (hitTp1) return { label: "TP1 DONE", progress: 100, pnlPercent, className: "done" };
  if (pnlPercent > 0) return { label: "TRACKING", progress, pnlPercent, className: "tracking" };
  return { label: "WAIT ENTRY", progress: 0, pnlPercent, className: "wait" };
}

function buildTimelineStages({ analysis, latestCircle, latestArrow, confirmationBars, score, copy }) {
  const direction = latestArrow?.direction ?? latestCircle?.direction ?? score?.direction ?? "bull";
  const reference = latestArrow?.reference ?? latestCircle?.reference;
  const retestDone = (score?.evidence?.retestQuality ?? 0) >= 6 && Boolean(score?.evidence?.structureAligned);
  const entryDone = ["A+", "A"].includes(score?.classification) && Boolean(score?.executability?.gates?.marketData);
  const completed = [
    Boolean(latestCircle),
    Number.isFinite(reference),
    Boolean(latestArrow),
    retestDone,
    entryDone,
  ];
  const currentIndex = Math.max(0, completed.lastIndexOf(true));
  const statusAt = (index) => index < currentIndex && completed[index] ? "done" : index === currentIndex ? "active" : "pending";
  return [
    {
      key: "circle",
      color: "blue",
      status: statusAt(0),
      icon: <CirclesFour size={14} />,
      label: "Circle",
      title: latestCircle ? `Early ${direction}` : "Waiting HA turn",
      detail: latestCircle ? copy.chart.haClosed : "HA direction change pending",
    },
    {
      key: "reference",
      color: "violet",
      status: statusAt(1),
      icon: <Target size={14} />,
      label: "Reference",
      title: Number.isFinite(reference) ? formatPrice(reference) : "--",
      detail: copy.chart.referenceNote,
    },
    {
      key: "arrow",
      color: "green",
      status: statusAt(2),
      icon: direction === "bear" ? <ArrowDown size={14} /> : <ArrowUp size={14} />,
      label: "Arrow",
      title: latestArrow ? `Confirm ${latestArrow.direction}` : copy.chart.waitingConfirm,
      detail: `Break + buffer ATR (${latestArrow?.barsToConfirm ?? 0}/${confirmationBars})`,
    },
    {
      key: "retest",
      color: "neutral",
      status: statusAt(3),
      icon: <Clock size={14} />,
      label: "Retest",
      title: retestDone ? "Quality passed" : "Quality gate",
      detail: copy.chart.holdStructure,
    },
    {
      key: "entry",
      color: "green",
      status: statusAt(4),
      icon: <CheckCircle size={14} />,
      label: "Entry",
      title: `${score?.classification ?? "--"} ${copy.chart.setup}`,
      detail: `Risk R:R 1:${score?.evidence?.rr ?? "--"}`,
    },
  ];
}

function TradePlanWidget({ symbol, plan, price, score, freeChartOnly }) {
  const progress = evaluateTradePlan(plan, price);
  const sideLabel = plan?.direction === "bear" ? "SHORT" : "LONG";
  if (freeChartOnly) {
    return <article className="analytics-card trade-plan-widget locked">
      <h3>TRADE PLAN</h3>
      <div className="trade-plan-locked"><strong>PRO LOCKED</strong><span>Nâng cấp để xem Entry / SL / TP theo hệ thống.</span></div>
    </article>;
  }
  return <article className={`analytics-card trade-plan-widget ${progress.className}`}>
    <h3>TRADE PLAN <span>{symbol}</span></h3>
    <div className="trade-plan-head">
      <div><span>Side</span><strong className={plan?.direction}>{sideLabel}</strong></div>
      <div><span>Score</span><strong>{score?.total ?? "--"}</strong></div>
      <div><span>Status</span><strong>{progress.label}</strong></div>
    </div>
    <div className="trade-plan-levels">
      <span>Entry <b>{formatPrice(plan?.entry)}</b></span>
      <span>SL <b>{formatPrice(plan?.stop)}</b></span>
      <span>TP1 <b>{formatPrice(plan?.tp1)}</b></span>
      <span>TP2 <b>{formatPrice(plan?.tp2)}</b></span>
    </div>
    <div className="trade-progress">
      <div><i style={{ width: `${Math.min(100, progress.progress)}%` }} /></div>
      <span>{Math.round(progress.progress)}% to TP1 · PnL {Number.isFinite(progress.pnlPercent) ? `${progress.pnlPercent >= 0 ? "+" : ""}${progress.pnlPercent.toFixed(2)}%` : "--"}</span>
    </div>
    <footer>Risk {Number.isFinite(plan?.riskPercent) ? `${plan.riskPercent.toFixed(2)}%` : "--"} · R:R 1:{Number.isFinite(plan?.rr) ? plan.rr.toFixed(2) : "--"} · tham khảo</footer>
  </article>;
}

function ScoreRing({ score }) {
  return <div className="score-ring" style={{ "--score": `${score * 3.6}deg` }}><div><strong>{score}</strong><span>/100</span></div></div>;
}

function ScannerBarChart({ buckets }) {
  const maximum = Math.max(1, ...buckets.flatMap((bucket) => [bucket.total, bucket.confirmed]));
  return <div className="bar-chart">{buckets.map((bucket) => <div className="bar-group" key={bucket.label}><div className="bar-values"><div className="bar early" style={{ height: `${Math.max(5, bucket.total / maximum * 100)}%` }}><span>{bucket.total}</span></div><div className="bar confirmed" style={{ height: `${Math.max(5, bucket.confirmed / maximum * 100)}%` }}><span>{bucket.confirmed}</span></div></div><small>{bucket.label}</small></div>)}</div>;
}

function StructureMap({ analysis }) {
  const events = useMemo(() => {
    if (!analysis) return [];
    return [
      ...analysis.structure.events.map((event) => ({ ...event, source: "Structure" })),
      ...analysis.spartan.map((event) => ({ ...event, source: "Spartan" })),
      ...analysis.liquiditySweeps.map((event) => ({ ...event, source: "Liquidity" })),
    ].sort((a, b) => b.time - a.time).slice(0, 12);
  }, [analysis]);
  return <div className="tab-view"><div className="tab-summary"><div><span>Confirmed pivots</span><strong>{analysis?.pivots?.length ?? 0}</strong></div><div><span>BOS / CHOCH</span><strong>{analysis?.structure?.events?.length ?? 0}</strong></div><div><span>Liquidity sweeps</span><strong>{analysis?.liquiditySweeps?.length ?? 0}</strong></div><div><span>Order block</span><strong>{analysis?.orderBlock?.valid ? "VALID" : "NONE"}</strong></div></div><div className="data-table"><div className="data-row head"><span>Time</span><span>Framework</span><span>Event</span><span>Side</span><span>Level</span></div>{events.map((event) => <div className="data-row" key={`${event.source}-${event.time}-${event.type}`}><span>{formatSyncTime(event.time * 1000)}</span><span>{event.source}</span><span>{event.type}</span><span className={event.direction}>{event.direction?.toUpperCase()}</span><span>{formatPrice(event.level ?? event.trigger ?? event.p2?.price ?? 0)}</span></div>)}</div></div>;
}

function JournalView({ entries, onLog, onClear, copy }) {
  return <div className="tab-view"><div className="journal-actions"><div><h2>{copy.journal.title}</h2><p>{copy.journal.description}</p></div><button className="secondary-action" onClick={onLog}>{copy.journal.log}</button><button className="ghost-action" onClick={onClear} disabled={!entries.length}>{copy.journal.clear}</button></div><div className="data-table"><div className="data-row journal head"><span>{copy.journal.logged}</span><span>{copy.journal.symbolTf}</span><span>{copy.journal.score}</span><span>{copy.journal.signal}</span><span>{copy.journal.snapshot}</span></div>{entries.length ? entries.map((entry) => <div className="data-row journal" key={entry.id}><span>{formatSyncTime(entry.loggedAt)}</span><span>{entry.symbol} · {entry.timeframe}</span><span>{entry.score} {entry.classification}</span><span>{entry.signal}</span><span title={entry.snapshotId}>{entry.snapshotId?.slice(0, 8) ?? "--"}</span></div>) : <div className="empty-state">{copy.journal.empty}</div>}</div></div>;
}

function AccessPortal({ plans, loading, error, onActivate }) {
  const [language, setLanguage] = useState(() => localStorage.getItem("signaledge-language") ?? "vi");
  const [selectedTier, setSelectedTier] = useState("free");
  const [accessCode, setAccessCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const vi = language !== "en";
  const tiers = plans?.tiers ?? [];
  const adminRequestOptions = () => ({
    headers: {
      Authorization: `Bearer ${admin?.adminSessionToken ?? ""}`,
      "X-Admin-User": admin?.username ?? "admin",
    },
  });
  const selected = tiers.find((tier) => tier.id === selectedTier) ?? tiers[0];
  const highlights = vi
    ? ["Dữ liệu thật, không fake signal", "A+ scanner + Crystal HA", "Telegram alert tự động", "Phân quyền theo broker-code"]
    : ["Verified market data only", "A+ scanner + Crystal HA", "Automated Telegram alerts", "Broker-code based access"];
  const deployment = vi
    ? ["PostgreSQL lưu user/subscription", "Redis session/cache", "JWT cookie httpOnly", "Admin duyệt broker-code", "Audit log đổi role", "Cloudflare WAF/rate limit"]
    : ["PostgreSQL users/subscriptions", "Redis sessions/cache", "httpOnly JWT cookie", "Admin broker-code approval", "Role-change audit log", "Cloudflare WAF/rate limit"];

  const changeLanguage = (key) => {
    setLanguage(key);
    localStorage.setItem("signaledge-language", key);
  };

  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await onActivate({ requestedTier: selectedTier, accessCode });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="access-page">
      <section className="access-hero">
        <header className="access-brand">
          <div className="brand-mark"><ChartLineUp size={22} weight="bold" /></div>
          <div><strong>SignalEdge</strong><span>Where Signals Become Edge</span></div>
        </header>
        <div className="hero-market">
          <div className="hero-orbit" />
          <div className="hero-candle c1" /><div className="hero-candle c2" /><div className="hero-candle c3" /><div className="hero-candle c4" />
          <div className="hero-signal-card good"><span>VN-INDEX</span><strong>REAL DATA</strong><small>verified feed</small></div>
          <div className="hero-signal-card risk"><span>RISK</span><strong>19%</strong><small>system score</small></div>
        </div>
        <div className="access-copy">
          <p>{vi ? "Cổng truy cập scanner chuyên nghiệp" : "Professional scanner gateway"}</p>
          <h1>{vi ? "Radar tín hiệu cho cổ phiếu và crypto." : "Signal radar for equities and crypto."}</h1>
          <span>{vi ? "Thiết kế nhẹ hơn, tập trung vào dữ liệu, phân quyền theo gói và cảnh báo A+ tự động. Không phải khuyến nghị đầu tư." : "A lighter, data-first access screen with tiered permissions and automated A+ alerts. Not investment advice."}</span>
        </div>
        <div className="hero-highlights">{highlights.map((item) => <span key={item}>{item}</span>)}</div>
      </section>

      <aside className="access-panel">
        <div className="access-panel-top">
          <div><span>{vi ? "Đăng nhập hệ thống" : "System login"}</span><strong>SignalEdge</strong></div>
          <div className="language-toggle">{LANGUAGES.map((item) => <button key={item.key} className={language === item.key ? "active" : ""} onClick={() => changeLanguage(item.key)}>{item.label}</button>)}</div>
        </div>
        <form className="access-form" onSubmit={submit}>
          <label>
            <span>{vi ? "Cấp truy cập" : "Access tier"}</span>
            <select value={selectedTier} onChange={(event) => setSelectedTier(event.target.value)}>
              {tiers.map((tier) => <option value={tier.id} key={tier.id}>{tier.name}</option>)}
            </select>
          </label>
          <label>
            <span>{vi ? "Mã truy cập / xác nhận broker-code" : "Access pass / broker-code verification"}</span>
            <input value={accessCode} onChange={(event) => setAccessCode(event.target.value)} placeholder={selectedTier === "free" ? (vi ? "Free không bắt buộc" : "Free does not require a code") : "SIGNAL / PRO / DESK"} />
          </label>
          {error && <div className="access-error">{error}</div>}
          <button className="access-submit" disabled={loading || submitting}>{submitting ? (vi ? "Đang xác thực..." : "Verifying...") : (vi ? "Vào SignalEdge" : "Enter SignalEdge")}</button>
        </form>

        <div className="login-subscription">
          <h3>{vi ? "Gói đang chọn" : "Selected plan"}</h3>
          <section className={`login-plan ${selected?.id ?? "free"}`}>
            <div><span>{selected?.name ?? "SignalEdge Free"}</span><strong>{selected?.capacity ?? "--"} users</strong></div>
            <p>{selected?.description}</p>
            <small>{vi ? "Điều kiện:" : "Condition:"} <b>{selected?.condition}</b></small>
          </section>
          <div className="mini-plan-grid">
            {tiers.map((tier) => <button key={tier.id} className={selectedTier === tier.id ? "active" : ""} onClick={() => setSelectedTier(tier.id)}><span>{tier.name.replace("SignalEdge ", "")}</span><b>{tier.capacity}</b></button>)}
          </div>
        </div>

        <div className="access-entitlements compact">
          <h3>{vi ? "Quyền mở khóa" : "Unlocked rights"}</h3>
          <div>{selected?.entitlements?.slice(0, 10).map((item) => <span key={item}>{item.replaceAll("_", " ")}</span>)}</div>
        </div>

        <div className="production-stack">
          <h3>{vi ? "Triển khai thật dưới 5000 user" : "Production path under 5000 users"}</h3>
          <div>{deployment.map((item) => <span key={item}>{item}</span>)}</div>
        </div>
      </aside>
    </main>
  );
}

const ADMIN_CONFIG_FIELDS = [
  ["structureBosAtrBuffer", "BOS ATR buffer", "Khoảng đệm xác nhận BOS/CHOCH. Cao hơn = ít fake break hơn."],
  ["spartanP3AtrBuffer", "Spartan P3 buffer", "Độ lệch tối thiểu để P3 hợp lệ trong mô hình 1-2-3."],
  ["spartanBreakAtrBuffer", "Spartan break buffer", "Đệm phá điểm 2 sau cấu trúc 1-2-3."],
  ["liquiditySweepAtrBuffer", "Liquidity sweep buffer", "Đệm quét thanh khoản trước khi đóng nến quay đầu."],
  ["crystalBreakAtrBuffer", "Crystal arrow buffer", "Đệm phá high/low tham chiếu để mũi tên Crystal hợp lệ."],
  ["volatilityGateAtrPercentile", "ATR volatility gate", "Ngưỡng percentile ATR để tín hiệu được phép lên A+."],
  ["atrBandMultiplier", "ATR band multiplier", "Độ rộng band ATR trên chart."],
  ["riskAtrStopMultiplier", "Risk SL ATR", "Hệ số ATR đề xuất dừng lỗ trong thông báo."],
  ["riskTp1AtrMultiplier", "Risk TP1 ATR", "Hệ số ATR đề xuất TP1."],
  ["riskTp2AtrMultiplier", "Risk TP2 ATR", "Hệ số ATR đề xuất TP2."],
];

function AdminPortal({ plans }) {
  const [language, setLanguage] = useState(() => localStorage.getItem("signaledge-language") ?? "vi");
  const [admin, setAdmin] = useState(() => {
    try { return JSON.parse(localStorage.getItem("signaledge-admin-profile") ?? "null"); } catch { return null; }
  });
  const [login, setLogin] = useState({ username: "admin", password: "" });
  const [loginError, setLoginError] = useState("");
  const [users, setUsers] = useState([]);
  const [issuedCode, setIssuedCode] = useState("");
  const [newUser, setNewUser] = useState({ displayName: "", email: "", tier: "pro", brokerCode: "", note: "" });
  const [scannerConfig, setScannerConfig] = useState(null);
  const [presets, setPresets] = useState([]);
  const [adminStatus, setAdminStatus] = useState("");
  const vi = language !== "en";
  const tiers = plans?.tiers ?? [];

  const changeLanguage = (key) => {
    setLanguage(key);
    localStorage.setItem("signaledge-language", key);
  };

  const loadAdminData = async () => {
    const options = adminRequestOptions();
    const [userPayload, configPayload] = await Promise.all([api.adminUsers(options), api.adminScannerConfig(options)]);
    setUsers(userPayload.users ?? []);
    setScannerConfig(configPayload.config ?? {});
    setPresets(configPayload.presets ?? []);
  };

  useEffect(() => {
    if (!admin) return;
    loadAdminData().catch((error) => setAdminStatus(error.message));
  }, [admin]);

  const submitLogin = async (event) => {
    event.preventDefault();
    setLoginError("");
    try {
      const profile = await api.adminLogin(login);
      setAdmin(profile);
      localStorage.setItem("signaledge-admin-profile", JSON.stringify(profile));
    } catch (error) {
      setLoginError(error.status === 401 ? "Sai tài khoản hoặc mật khẩu admin." : error.message);
    }
  };

  const createUser = async (event) => {
    event.preventDefault();
    setAdminStatus("");
    const payload = await api.adminCreateUser(newUser, adminRequestOptions());
    setIssuedCode(payload.accessCode ?? "");
    setNewUser({ displayName: "", email: "", tier: "pro", brokerCode: "", note: "" });
    await loadAdminData();
  };

  const updateConfigValue = (key, value) => {
    setScannerConfig((current) => ({ ...(current ?? {}), [key]: Number(value) }));
  };

  const applyPreset = (preset) => {
    setScannerConfig(preset.values);
    setAdminStatus(vi ? `Đã nạp preset ${preset.name}, bấm Lưu để áp dụng.` : `Preset ${preset.name} loaded. Save to apply.`);
  };

  const saveConfig = async () => {
    setAdminStatus("");
    const payload = await api.adminUpdateScannerConfig(scannerConfig, adminRequestOptions());
    setScannerConfig(payload.config ?? scannerConfig);
    setAdminStatus(vi ? "Đã lưu cấu hình scanner và xóa cache tính toán." : "Scanner config saved and calculation cache invalidated.");
  };

  const signOutAdmin = () => {
    localStorage.removeItem("signaledge-admin-profile");
    setAdmin(null);
  };

  if (!admin) {
    return <main className="admin-page admin-login-page">
      <section className="admin-login-card">
        <div className="access-brand">
          <div className="brand-mark"><ShieldCheck size={22} weight="bold" /></div>
          <div><strong>SignalEdge Admin</strong><span>Where Signals Become Edge</span></div>
        </div>
        <h1>{vi ? "Cổng quản trị riêng" : "Private admin console"}</h1>
        <p>{vi ? "Trang này tách khỏi giao diện thương mại và không hiển thị trong sidebar người dùng." : "This route is separated from the commercial app and hidden from the user sidebar."}</p>
        <form className="access-form" onSubmit={submitLogin}>
          <label><span>Username</span><input value={login.username} onChange={(event) => setLogin((current) => ({ ...current, username: event.target.value }))} autoComplete="username" /></label>
          <label><span>Password</span><input type="password" value={login.password} onChange={(event) => setLogin((current) => ({ ...current, password: event.target.value }))} autoComplete="current-password" /></label>
          {loginError && <div className="access-error">{loginError}</div>}
          <button className="access-submit">Login Admin</button>
        </form>
        <div className="language-toggle">{LANGUAGES.map((item) => <button key={item.key} className={language === item.key ? "active" : ""} onClick={() => changeLanguage(item.key)}>{item.label}</button>)}</div>
      </section>
    </main>;
  }

  return <main className="admin-page">
    <header className="admin-topbar">
      <div className="access-brand"><div className="brand-mark"><ShieldCheck size={22} weight="bold" /></div><div><strong>SignalEdge Admin</strong><span>{vi ? "Quản trị tài khoản, subscription và scanner" : "Accounts, subscriptions and scanner control"}</span></div></div>
      <div className="admin-actions"><div className="language-toggle">{LANGUAGES.map((item) => <button key={item.key} className={language === item.key ? "active" : ""} onClick={() => changeLanguage(item.key)}>{item.label}</button>)}</div><button onClick={signOutAdmin}>Logout</button></div>
    </header>

    <section className="admin-summary">
      <article><span>{vi ? "Admin" : "Admin"}</span><strong>{admin.displayName}</strong><small>{admin.username}</small></article>
      <article><span>{vi ? "Tài khoản đã cấp" : "Issued accounts"}</span><strong>{users.length}</strong><small>{vi ? "local beta store" : "local beta store"}</small></article>
      <article><span>{vi ? "Quy mô mục tiêu" : "Target scale"}</span><strong>{plans?.capacity?.targetMaxUsers ?? 4980}</strong><small>single backend + PostgreSQL + Redis</small></article>
      <article><span>{vi ? "Scanner config" : "Scanner config"}</span><strong>{scannerConfig ? "LIVE" : "LOADING"}</strong><small>{vi ? "cache invalidation khi lưu" : "cache invalidates on save"}</small></article>
    </section>

    <section className="admin-grid">
      <article className="admin-card">
        <h2>{vi ? "Cấp tài khoản mới" : "Issue account"}</h2>
        <p>{vi ? "Tạo mã truy cập riêng theo gói. User dùng mã này ở màn đăng nhập thương mại." : "Create a tier-specific access code for the commercial login screen."}</p>
        <form className="admin-form" onSubmit={createUser}>
          <label><span>{vi ? "Tên hiển thị" : "Display name"}</span><input value={newUser.displayName} onChange={(event) => setNewUser((current) => ({ ...current, displayName: event.target.value }))} required /></label>
          <label><span>Email</span><input type="email" value={newUser.email} onChange={(event) => setNewUser((current) => ({ ...current, email: event.target.value }))} /></label>
          <label><span>Tier</span><select value={newUser.tier} onChange={(event) => setNewUser((current) => ({ ...current, tier: event.target.value }))}>{tiers.map((tier) => <option key={tier.id} value={tier.id}>{tier.name}</option>)}</select></label>
          <label><span>Broker code</span><input value={newUser.brokerCode} onChange={(event) => setNewUser((current) => ({ ...current, brokerCode: event.target.value }))} /></label>
          <label className="span-2"><span>Note</span><textarea value={newUser.note} onChange={(event) => setNewUser((current) => ({ ...current, note: event.target.value }))} /></label>
          <button className="admin-primary">{vi ? "Cấp mã truy cập" : "Issue access code"}</button>
        </form>
        {issuedCode && <div className="issued-code"><span>{vi ? "Mã vừa cấp" : "Issued code"}</span><strong>{issuedCode}</strong><small>{vi ? "Chỉ hiển thị đầy đủ một lần trên màn hình này." : "Shown in full only once here."}</small></div>}
      </article>

      <article className="admin-card">
        <h2>{vi ? "Danh sách tài khoản" : "Accounts"}</h2>
        <div className="admin-table">
          <div className="admin-row head"><span>User</span><span>Tier</span><span>Code</span><span>Status</span></div>
          {users.map((user) => <div className="admin-row" key={user.id}><span><b>{user.displayName}</b><small>{user.email || user.brokerCode || "--"}</small></span><span>{user.tierName}</span><span>{user.accessCodePreview}</span><span>{user.status}</span></div>)}
          {!users.length && <div className="empty-state">{vi ? "Chưa có tài khoản được cấp." : "No issued accounts yet."}</div>}
        </div>
      </article>
    </section>

    <section className="admin-card scanner-admin-card">
      <div className="admin-section-heading"><div><h2>{vi ? "Tinh chỉnh hệ thống scanner" : "Scanner tuning"}</h2><p>{vi ? "Các tham số này tác động trực tiếp tới BOS, Spartan 1-2-3, Liquidity Sweep, Crystal HA, ATR gate và risk template." : "These values feed BOS, Spartan 1-2-3, Liquidity Sweep, Crystal HA, ATR gate and risk templates."}</p></div><button className="admin-primary" onClick={saveConfig} disabled={!scannerConfig}>{vi ? "Lưu & tính lại" : "Save & recalc"}</button></div>
      <div className="preset-grid">{presets.map((preset) => <button key={preset.id} onClick={() => applyPreset(preset)}><strong>{preset.name}</strong><span>{preset.description}</span></button>)}</div>
      {scannerConfig && <div className="config-grid">{ADMIN_CONFIG_FIELDS.map(([key, label, help]) => <label key={key}><span>{label}</span><input type="number" step="0.005" value={scannerConfig[key] ?? ""} onChange={(event) => updateConfigValue(key, event.target.value)} /><small>{help}</small></label>)}</div>}
      {adminStatus && <div className="admin-status">{adminStatus}</div>}
    </section>
  </main>;
}

function UpgradeNotice({ requiredTier, profile, onOpenPlans }) {
  return (
    <div className="tab-view upgrade-view">
      <section>
        <ShieldCheck size={36} weight="fill" />
        <span>SUBSCRIPTION LOCK</span>
        <h2>Cần gói {requiredTier?.toUpperCase()} để mở module này</h2>
        <p>Tài khoản hiện tại: <b>{profile?.tierName ?? "SignalEdge Free"}</b>. Module này đã được khóa ở frontend để khớp mô hình phân quyền; production sẽ enforce thêm ở API gateway.</p>
        <button className="secondary-action" onClick={onOpenPlans}>Xem gói & quyền lợi</button>
      </section>
    </div>
  );
}

function APlusRecommendationPanel({ signal, analysis, price, change, language, onClose, onOpenChart }) {
  if (!signal) return null;
  const row = signal.row;
  const sameChart = analysis?.meta?.symbol === row.symbol;
  const score = sameChart ? analysis?.score : null;
  const last = sameChart ? analysis?.rows?.at(-1) : null;
  const atr = sameChart ? analysis?.atrValues?.at(-1) : null;
  const direction = score?.direction ?? row.direction;
  const side = direction === "bear" ? "SHORT / SELL WATCH" : "LONG / BUY WATCH";
  const entry = Number.isFinite(price) ? price : last?.close;
  const stop = Number.isFinite(entry) && Number.isFinite(atr)
    ? direction === "bear" ? entry + atr * 1.5 : entry - atr * 1.5
    : null;
  const tp1 = Number.isFinite(entry) && Number.isFinite(atr)
    ? direction === "bear" ? entry - atr * 2.4 : entry + atr * 2.4
    : null;
  const tp2 = Number.isFinite(entry) && Number.isFinite(atr)
    ? direction === "bear" ? entry - atr * 3.5 : entry + atr * 3.5
    : null;
  const rr = score?.evidence?.rr ?? (Number.isFinite(entry) && Number.isFinite(stop) && Number.isFinite(tp1) ? Math.abs(tp1 - entry) / Math.abs(entry - stop) : null);
  const vi = language !== "en";
  const reasons = [
    vi ? `Score A+ ${row.score}/100, vượt ngưỡng thực thi.` : `A+ score ${row.score}/100, above execution threshold.`,
    row.aligned ? (vi ? "Đồng thuận đa khung D1/H4." : "D1/H4 multi-timeframe alignment.") : (vi ? "MTF chưa đồng thuận đầy đủ, cần kiểm tra lại." : "MTF is not fully aligned, review required."),
    row.crystal === "arrow" ? (vi ? "Crystal HA đã có mũi tên xác nhận sau break tham chiếu." : "Crystal HA confirmed arrow after reference break.") : (vi ? `Crystal HA trạng thái ${row.crystal}.` : `Crystal HA state: ${row.crystal}.`),
    score?.evidence?.trendAligned ? (vi ? "EMA trend filter đang ủng hộ hướng tín hiệu." : "EMA trend filter supports the signal direction.") : (vi ? "EMA trend filter cần xác nhận thêm." : "EMA trend filter needs more confirmation."),
    score?.evidence?.structureAligned ? (vi ? "Market structure/BOS phù hợp hướng giao dịch." : "Market structure/BOS agrees with the trade direction.") : (vi ? "Cấu trúc thị trường chưa phải căn cứ mạnh nhất." : "Market structure is not the strongest evidence yet."),
    score?.evidence?.atrPercentile >= 0.28 ? (vi ? "Volatility đủ điều kiện theo ATR." : "ATR volatility gate is satisfied.") : (vi ? "ATR thấp, chỉ nên theo dõi nếu biến động cải thiện." : "ATR is low; watch unless volatility improves."),
  ];
  return (
    <aside className="a-plus-panel" role="dialog" aria-live="assertive" aria-label="A+ signal recommendation">
      <header>
        <div><span>{vi ? "Tín hiệu A+ mới" : "New A+ Signal"}</span><strong>{row.symbol}</strong></div>
        <button onClick={onClose} aria-label={vi ? "Đóng bảng tín hiệu" : "Close signal panel"}>×</button>
      </header>
      <div className="a-plus-hero">
        <div><span>{vi ? "Thiên hướng" : "Bias"}</span><strong className={direction === "bear" ? "bear" : "bull"}>{side}</strong></div>
        <div><span>Score</span><strong>{row.score}</strong></div>
        <div><span>MTF</span><strong>{row.aligned ? "YES" : "MIXED"}</strong></div>
        <div><span>Crystal</span><strong>{row.crystal?.toUpperCase()}</strong></div>
      </div>
      <section>
        <h4>{vi ? "Kế hoạch tham khảo" : "Reference Plan"}</h4>
        <div className="a-plus-plan">
          <span>{vi ? "Entry tham khảo" : "Reference entry"}<b>{formatPrice(entry)}</b></span>
          <span>Stop Loss<b>{formatPrice(stop)}</b></span>
          <span>TP1<b>{formatPrice(tp1)}</b></span>
          <span>TP2<b>{formatPrice(tp2)}</b></span>
          <span>R:R<b>{Number.isFinite(rr) ? `1:${Number(rr).toFixed(2)}` : "--"}</b></span>
          <span>{vi ? "Biến động" : "Change"}<b className={change < 0 ? "bear" : "bull"}>{formatChange(change)}</b></span>
        </div>
      </section>
      <section>
        <h4>{vi ? "Căn cứ tín hiệu" : "Signal Evidence"}</h4>
        <ul>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      </section>
      <section className="a-plus-disclaimer">
        {vi
          ? "Thông tin chỉ dùng để tham khảo và tự xây dựng quyết định đầu tư. Không phải khuyến nghị mua/bán chắc chắn, không cam kết lợi nhuận."
          : "For reference and independent decision-making only. Not a guaranteed buy/sell recommendation and not a profit commitment."}
      </section>
      <footer>
        <button className="ghost-action" onClick={onClose}>{vi ? "Để tôi tự đánh giá" : "Review myself"}</button>
        <button className="secondary-action" onClick={onOpenChart}>{vi ? "Mở chart & căn cứ" : "Open chart & evidence"}</button>
      </footer>
    </aside>
  );
}

function CockpitApp({ subscriptionProfile, subscriptionPlans, onSignOut }) {
  const [scanner, setScanner] = useState([]);
  const [selected, setSelected] = useState("FPT");
  const [analysis, setAnalysis] = useState(null);
  const [timeframe, setTimeframe] = useState(() => storedChoice("signaledge-timeframe", "H4", ["D1", "H4"]));
  const [dateRange, setDateRange] = useState("3M");
  const [confirmationBars, setConfirmationBars] = useState(() => storedNumber("signaledge-confirmation-bars", 3, 1, 10));
  const [mode, setMode] = useState(() => storedChoice("signaledge-signal-mode", "confirmed", ["aggressive", "confirmed"]));
  const [activeTab, setActiveTab] = useState("Chart");
  const [loading, setLoading] = useState(true);
  const [alertState, setAlertState] = useState(null);
  const [rankAlert, setRankAlert] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [search, setSearch] = useState("");
  const [universe, setUniverse] = useState(() => storedChoice("signaledge-universe", "vn", UNIVERSE_KEYS));
  const [filterOn, setFilterOn] = useState(false);
  const [thesisTab, setThesisTab] = useState("THESIS");
  const [activeRail, setActiveRail] = useState("Cockpit");
  const [lockedRail, setLockedRail] = useState(null);
  const [layers, setLayers] = useState(() => storedLayers({ ha: false, crystal: true, structure: true, orderBlock: true, ema: true, atr: true }));
  const [sync, setSync] = useState(null);
  const [quotes, setQuotes] = useState({ items: [], indices: [], status: "warming", observedAt: null, transport: null });
  const [quoteError, setQuoteError] = useState(null);
  const [syncError, setSyncError] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [refreshSeconds, setRefreshSeconds] = useState(() => Number(localStorage.getItem("scanner-refresh-seconds") ?? 15));
  const [readable, setReadable] = useState(() => localStorage.getItem("scanner-readable") !== "false");
  const [language, setLanguage] = useState(() => localStorage.getItem("signaledge-language") ?? "vi");
  const [systemStatus, setSystemStatus] = useState(null);
  const [dataDiagnostics, setDataDiagnostics] = useState(null);
  const [systemStatusLoading, setSystemStatusLoading] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [journalEntries, setJournalEntries] = useState(() => {
    try { return JSON.parse(localStorage.getItem("scanner-journal") ?? "[]"); } catch { return []; }
  });
  const [notes, setNotes] = useState(() => {
    try { return JSON.parse(localStorage.getItem("scanner-notes") ?? "{}"); } catch { return {}; }
  });
  const requestSequence = useRef(0);
  const scannerRequestSequence = useRef(0);
  const searchInput = useRef(null);
  const previousAPlusSymbols = useRef(null);
  const copy = getCopy(language);
  const freeChartOnly = !canAccessFeature(subscriptionProfile, "scanner");
  const visibleLayers = freeChartOnly
    ? { ha: false, crystal: false, structure: false, orderBlock: false, ema: false, atr: false }
    : layers;
  const allowedUniverseOptions = useMemo(() => UNIVERSE_OPTIONS.filter((option) => canAccessUniverse(subscriptionProfile, option.key)), [subscriptionProfile]);

  useEffect(() => {
    setDateRange("3M");
  }, [selected, timeframe]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++scannerRequestSequence.current;
    api.scanner(confirmationBars, { signal: controller.signal }).then((payload) => {
      if (sequence !== scannerRequestSequence.current) return;
      setScanner(payload.data.items);
      setSync((current) => ({
        ...current,
        status: current?.chart ? "consistent" : "pending",
        calculationVersion: payload.data.sync.calculationVersion,
        scanner: payload.data.sync,
        scannerSnapshotId: payload.data.sync.snapshotId,
        scannerLatencyMs: payload.transport.latencyMs,
        latencyMs: payload.transport.latencyMs,
        transportCache: payload.transport.cache,
        receivedAt: payload.transport.receivedAt,
        scannerTotal: payload.data.total,
        universeTotal: payload.data.universeTotal,
        unavailableTotal: payload.data.unavailable?.length ?? 0,
        unavailable: payload.data.unavailable ?? [],
      }));
    }).catch((error) => {
      if (!controller.signal.aborted) setSyncError(error.message);
    });
    return () => controller.abort();
  }, [confirmationBars, refreshTick]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    if (!analysis) setLoading(true);
    setSyncError(null);
    api.chart(selected, timeframe, confirmationBars, { signal: controller.signal }).then((payload) => {
      if (sequence !== requestSequence.current) return;
      setAnalysis(payload.data);
      setSync((current) => ({
        ...current,
        status: current?.scanner ? "consistent" : "pending",
        calculationVersion: payload.data.sync.calculationVersion,
        chart: payload.data.sync,
        checkedAt: payload.data.sync.generatedAt,
        chartSnapshotId: payload.data.sync.snapshotId,
        chartLatencyMs: payload.transport.latencyMs,
        latencyMs: payload.transport.latencyMs,
        transportCache: payload.transport.cache,
        receivedAt: payload.transport.receivedAt,
      }));
      setLoading(false);
    }).catch((error) => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setSyncError(error.message);
      setLoading(false);
    });
    return () => controller.abort();
  }, [selected, timeframe, confirmationBars, refreshTick]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible" && navigator.onLine) setRefreshTick((value) => value + 1); };
    const interval = setInterval(refresh, refreshSeconds * 1000);
    const handleOnline = () => { setOnline(true); refresh(); };
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      clearInterval(interval);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [refreshSeconds]);

  useEffect(() => {
    let controller = new AbortController();
    let stopped = false;
    const refreshQuotes = async () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      controller.abort();
      controller = new AbortController();
      try {
        const payload = await api.quotes(null, { signal: controller.signal, timeoutMs: 6000 });
        if (stopped) return;
        setQuotes({ ...payload.data, transport: payload.transport });
        setQuoteError(null);
      } catch (error) {
        if (!controller.signal.aborted && !stopped) setQuoteError(error.message);
      }
    };
    refreshQuotes();
    const interval = setInterval(refreshQuotes, 5000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(interval);
    };
  }, []);

  useEffect(() => { localStorage.setItem("scanner-journal", JSON.stringify(journalEntries)); }, [journalEntries]);
  useEffect(() => { localStorage.setItem("scanner-notes", JSON.stringify(notes)); }, [notes]);
  useEffect(() => { localStorage.setItem("scanner-refresh-seconds", String(refreshSeconds)); }, [refreshSeconds]);
  useEffect(() => { localStorage.setItem("scanner-readable", String(readable)); }, [readable]);
  useEffect(() => { localStorage.setItem("signaledge-language", language); }, [language]);
  useEffect(() => { localStorage.setItem("signaledge-timeframe", timeframe); }, [timeframe]);
  useEffect(() => { localStorage.setItem("signaledge-confirmation-bars", String(confirmationBars)); }, [confirmationBars]);
  useEffect(() => { localStorage.setItem("signaledge-signal-mode", mode); }, [mode]);
  useEffect(() => { localStorage.setItem("signaledge-universe", universe); }, [universe]);
  useEffect(() => { localStorage.setItem("signaledge-layers", JSON.stringify(layers)); }, [layers]);
  useEffect(() => {
    if (!canAccessUniverse(subscriptionProfile, universe)) setUniverse(allowedUniverseOptions[0]?.key ?? "vn");
  }, [allowedUniverseOptions, subscriptionProfile, universe]);
  useEffect(() => {
    const currentAPlus = scanner.filter((item) => item.classification === "A+");
    const currentSymbols = new Set(currentAPlus.map((item) => item.symbol));
    if (!previousAPlusSymbols.current) {
      previousAPlusSymbols.current = currentSymbols;
      return;
    }
    const newRows = currentAPlus.filter((item) => !previousAPlusSymbols.current.has(item.symbol));
    previousAPlusSymbols.current = currentSymbols;
    if (!newRows.length) return;
    const row = newRows.sort((left, right) => right.score - left.score)[0];
    setRankAlert({ row, detectedAt: Date.now() });
    setAlertState({ symbol: row.symbol, policy: `A+ rank-up · ${row.score}/100` });
    setSelected(row.symbol);
    setLockedRail(null);
    setActiveRail("Charts");
    setActiveTab("Chart");
    if (canAccessFeature(subscriptionProfile, "telegramAlert")) {
      api.notifyAPlusTelegram({
        symbol: row.symbol,
        timeframe,
        confirmationBars,
        detectedAt: Date.now(),
      }, {
        idempotencyKey: `a-plus-telegram:${sync?.scannerSnapshotId ?? sync?.scanner?.snapshotId ?? "snapshot"}:${row.symbol}`,
      }).catch((error) => {
        console.warn("A+ Telegram notification skipped", error);
      });
    }
    setTimeout(() => setAlertState(null), 5000);
  }, [scanner, confirmationBars, subscriptionProfile, sync?.scannerSnapshotId, sync?.scanner?.snapshotId, timeframe]);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api.journal({ signal: controller.signal }), api.alerts({ signal: controller.signal })]).then(([journal, alertList]) => {
      setJournalEntries(journal.items);
      setAlerts(alertList.items);
    }).catch((error) => { if (!controller.signal.aborted) console.error(error); });
    return () => controller.abort();
  }, []);

  const quoteMap = useMemo(() => new Map(quotes.items.map((quote) => [quote.symbol, quote])), [quotes.items]);
  const indexMap = useMemo(() => new Map(quotes.indices.map((quote) => [quote.symbol, quote])), [quotes.indices]);
  const displayScanner = useMemo(() => {
    const scannerSymbols = new Set(scanner.map((item) => item.symbol));
    const executableRows = scanner.map((item) => {
      const quote = quoteMap.get(item.symbol);
      return quote ? { ...item, price: quote.price, change: quote.change, quote } : item;
    });
    const quoteOnlyRows = quotes.items
      .filter((quote) => !scannerSymbols.has(quote.symbol) && VN_MARKETS.has(quote.market ?? "VN"))
      .map((quote) => ({
        symbol: quote.symbol,
        venue: quote.venue ?? quote.floor ?? "HOSE",
        market: quote.market ?? "VN",
        price: quote.price,
        change: quote.change,
        score: Number.isFinite(quote.rs52w) ? quote.rs52w : null,
        rs52w: quote.rs52w,
        classification: "DATA",
        direction: quote.change >= 0 ? "bull" : "bear",
        crystal: "none",
        aligned: false,
        dataState: "CHART",
        quote,
      }));
    const rowSymbols = new Set([...scannerSymbols, ...quoteOnlyRows.map((item) => item.symbol)]);
    const unavailableRows = (sync?.unavailable ?? [])
      .filter((item) => !rowSymbols.has(item.symbol))
      .map((item) => ({
        symbol: item.symbol,
        venue: item.venue ?? "--",
        market: item.market,
        price: null,
        change: null,
        score: null,
        classification: "DATA",
        direction: "bear",
        crystal: "none",
        aligned: false,
        dataState: "WAIT",
        unavailable: true,
        reason: item.reason,
      }));
    return [...executableRows, ...quoteOnlyRows, ...unavailableRows].sort((left, right) => {
      if (left.classification === "DATA" && right.classification !== "DATA") return 1;
      if (left.classification !== "DATA" && right.classification === "DATA") return -1;
      return (right.score ?? -1) - (left.score ?? -1);
    });
  }, [scanner, quoteMap, quotes.items, sync?.unavailable]);

  const modeDisplayScanner = useMemo(
    () => displayScanner.filter((item) => signalAllowedByMode(item, mode)),
    [displayScanner, mode],
  );

  const modeScanner = useMemo(
    () => scanner.filter((item) => signalAllowedByMode(item, mode)),
    [scanner, mode],
  );

  const grouped = useMemo(() => {
    const sourceRows = freeChartOnly ? displayScanner : modeDisplayScanner;
    const filtered = sourceRows.filter((item) => {
      const matchesSearch = item.symbol.includes(search.trim().toUpperCase());
      const matchesUniverse = marketBucket(item) === universe;
      const matchesFilter = !filterOn || (item.score ?? 0) >= 70;
      return matchesSearch && matchesUniverse && matchesFilter;
    });
    if (freeChartOnly) {
      return {
        MARKET: filtered.map((item) => ({
          ...item,
          classification: "DATA",
          score: null,
          crystal: "none",
          aligned: false,
          dataState: "CHART",
        })),
      };
    }
    return {
      "A+": filtered.filter((item) => item.classification === "A+"),
      A: filtered.filter((item) => item.classification === "A"),
      DATA: filtered.filter((item) => item.classification === "DATA"),
      IGNORE: filtered.filter((item) => !["A+", "A", "DATA"].includes(item.classification)),
    };
  }, [displayScanner, modeDisplayScanner, search, universe, filterOn, freeChartOnly]);

  const scannerAnalytics = useMemo(() => {
    const activeScanner = modeScanner;
    const total = activeScanner.length;
    const averageScore = total ? Math.round(activeScanner.reduce((sum, item) => sum + item.score, 0) / total) : 0;
    const scoreBuckets = [
      { label: "<60", items: activeScanner.filter((item) => item.score < 60) },
      { label: "60-69", items: activeScanner.filter((item) => item.score >= 60 && item.score < 70) },
      { label: "70-79", items: activeScanner.filter((item) => item.score >= 70 && item.score < 80) },
      { label: "80-100", items: activeScanner.filter((item) => item.score >= 80) },
    ].map((bucket) => ({ label: bucket.label, total: bucket.items.length, confirmed: bucket.items.filter((item) => item.crystal === "arrow").length }));
    const unavailable = sync?.unavailable ?? [];
    const universes = UNIVERSE_OPTIONS.map((option) => {
      const items = activeScanner.filter((item) => marketBucket(item) === option.key);
      const missing = unavailable.filter((item) => marketBucket(item) === option.key).length;
      const average = items.length ? Math.round(items.reduce((sum, item) => sum + item.score, 0) / items.length) : 0;
      return {
        key: option.key,
        label: copy.universe[option.key],
        shortLabel: option.shortLabel,
        count: items.length,
        missing,
        aligned: items.filter((item) => item.aligned).length,
        average,
        aPlus: items.filter((item) => item.classification === "A+").length,
        watch: items.filter((item) => item.classification === "A").length,
        confirmed: items.filter((item) => item.crystal === "arrow").length,
        early: items.filter((item) => item.crystal === "circle").length,
        bullish: items.filter((item) => item.direction === "bull").length,
        bearish: items.filter((item) => item.direction === "bear").length,
        status: items.length ? "LIVE" : missing ? "WAIT DATA" : "EMPTY",
        top: items.slice(0, 4),
      };
    });
    const markets = ["VN_INDEX", "VN30", "MIDCAP", "CRYPTO"].map((market) => {
      const items = scanner.filter((item) => item.market === market);
      return {
        market,
        count: items.length,
        aligned: items.filter((item) => item.aligned).length,
        average: items.length ? Math.round(items.reduce((sum, item) => sum + item.score, 0) / items.length) : 0,
      };
    });
    return {
      total,
      averageScore,
      aligned: activeScanner.filter((item) => item.aligned).length,
      confirmed: activeScanner.filter((item) => item.crystal === "arrow").length,
      early: activeScanner.filter((item) => item.crystal === "circle").length,
      ignored: activeScanner.filter((item) => !["A+", "A"].includes(item.classification)).length,
      executable: activeScanner.filter((item) => item.classification === "A+").length,
      bullish: activeScanner.filter((item) => item.direction === "bull").length,
      bearish: activeScanner.filter((item) => item.direction === "bear").length,
      scoreBuckets,
      markets,
      universes,
      activeUniverse: universes.find((item) => item.key === universe) ?? universes[0],
      top: activeScanner.slice(0, 5),
    };
  }, [modeScanner, scanner, sync?.unavailable, universe, copy]);

  const score = analysis?.score;
  const last = analysis?.rows?.at(-1);
  const selectedRow = displayScanner.find((item) => item.symbol === selected);
  const selectedQuote = quoteMap.get(selected);
  const btcRow = quoteMap.get("BTCUSDT");
  const ethRow = quoteMap.get("ETHUSDT");
  const vnIndex = indexMap.get("VNINDEX");
  const vn30Index = indexMap.get("VN30") ?? indexMap.get("VN30INDEX");
  const marketRegime = !vnIndex && !btcRow ? "DATA WAIT" : !vnIndex ? "CRYPTO LIVE" : !btcRow ? "VN CLOSE" : vnIndex.change >= 0 && btcRow.change >= 0 ? "RISK-ON" : vnIndex.change < 0 && btcRow.change < 0 ? "RISK-OFF" : "MIXED";
  const quoteAgeSeconds = quotes.observedAt ? Math.max(0, Math.round((Date.now() - Date.parse(quotes.observedAt)) / 1000)) : null;
  const latestArrow = analysis?.crystal?.filter((event) => event.type === "arrow").at(-1);
  const latestCircle = analysis?.crystal?.filter((event) => event.type === "circle").at(-1);
  const dataQuality = sync?.chart?.dataQuality;
  const synchronized = online && !syncError && sync?.status === "consistent" && dataQuality?.status !== "blocked";
  const researchData = Boolean(sync?.chart?.executionBlocked || sync?.chart?.source?.includes("fixture"));
  const operational = synchronized && !researchData;
  const selectedDisplayPrice = selectedQuote?.price ?? (researchData ? null : last?.close);
  const selectedDisplayChange = selectedQuote?.change ?? (researchData ? null : selectedRow?.change);
  const marketWindowRows = analysis?.rows?.slice(timeframe === "H4" ? -6 : -1) ?? [];
  const selectedHigh24h = marketWindowRows.length ? Math.max(...marketWindowRows.map((row) => row.high)) : null;
  const selectedLow24h = marketWindowRows.length ? Math.min(...marketWindowRows.map((row) => row.low)) : null;
  const selectedVolume24h = marketWindowRows.reduce((sum, row) => sum + row.volume, 0);
  const selectedTurnover24h = marketWindowRows.reduce((sum, row) => sum + row.volume * row.close, 0);
  const candleFlow = useMemo(() => buildCandleFlow(analysis, selectedDisplayPrice), [analysis, selectedDisplayPrice]);
  const tradePlan = useMemo(() => buildTradePlan(analysis, selectedDisplayPrice), [analysis, selectedDisplayPrice]);
  const timelineStages = useMemo(() => buildTimelineStages({ analysis, latestCircle, latestArrow, confirmationBars, score, copy }), [analysis, latestCircle, latestArrow, confirmationBars, score, copy]);
  const cryptoQuotesLive = quotes.providers?.crypto === "live";
  const activeUniverseLabel = universeLabel(universe, copy);
  const toggleLayer = (layer) => setLayers((current) => ({ ...current, [layer]: !current[layer] }));
  const rowForSymbol = (symbol) => displayScanner.find((item) => item.symbol === symbol) ?? scanner.find((item) => item.symbol === symbol) ?? quoteMap.get(symbol) ?? indexMap.get(symbol);
  const universeForSymbol = (symbol) => {
    const row = rowForSymbol(symbol);
    if (row) return marketBucket(row);
    return symbol.endsWith("USDT") ? "crypto" : "vn";
  };
  const switchSignalMode = (nextMode) => {
    setMode(nextMode);
    setLayers((current) => ({ ...current, crystal: true }));
  };
  const openSymbolChart = (symbol) => {
    const nextUniverse = universeForSymbol(symbol);
    if (canAccessUniverse(subscriptionProfile, nextUniverse)) setUniverse(nextUniverse);
    setSearch("");
    setSelected(symbol);
    setLockedRail(null);
    setActiveRail("Charts");
    setActiveTab("Chart");
  };
  const switchUniverse = (nextUniverse, { selectFirst = true } = {}) => {
    const allowed = allowedUniverseOptions.map((option) => option.key);
    const resolvedUniverse = allowed.includes(nextUniverse) ? nextUniverse : allowed[0] ?? "vn";
    setUniverse(resolvedUniverse);
    setSearch("");
    setFilterOn(false);
    if (!selectFirst) return;
    const first = displayScanner.find((item) => marketBucket(item) === resolvedUniverse && !item.unavailable && (freeChartOnly || signalAllowedByMode(item, mode)))
      ?? displayScanner.find((item) => marketBucket(item) === resolvedUniverse && !item.unavailable);
    if (first?.symbol && first.symbol !== selected) {
      setSelected(first.symbol);
      setLockedRail(null);
      setActiveRail("Charts");
      setActiveTab("Chart");
    }
  };
  const selectWatchlistRow = (row) => {
    if (row.unavailable) {
      setSyncError(`${row.symbol}: ${copy.watchlist.unavailable} (${row.reason ?? "market_data_unavailable"})`);
      return;
    }
    const rowUniverse = marketBucket(row);
    if (rowUniverse !== universe && canAccessUniverse(subscriptionProfile, rowUniverse)) setUniverse(rowUniverse);
    setSelected(row.symbol);
    setLockedRail(null);
    setActiveRail("Charts");
    setActiveTab("Chart");
  };

  const logCurrentSignal = async () => {
    if (!canAccessFeature(subscriptionProfile, "journal")) {
      setLockedRail("Journal");
      setActiveRail("Journal");
      return;
    }
    if (!analysis) return;
    const event = latestArrow ?? latestCircle;
    const entry = await api.createJournalEntry({
      symbol: selected,
      timeframe,
      score: score?.total ?? 0,
      classification: score?.classification ?? "--",
      signal: event ? `${event.type.toUpperCase()} ${event.direction.toUpperCase()}` : "NO SIGNAL",
      snapshotId: analysis.sync?.snapshotId,
      notes: notes[selected] ?? "",
    });
    setJournalEntries((current) => [entry, ...current.filter((item) => item.id !== entry.id)].slice(0, 500));
  };

  const clearJournal = async () => {
    await api.clearJournal();
    setJournalEntries([]);
  };

  const createAlert = async () => {
    if (!canAccessFeature(subscriptionProfile, "alerts")) {
      setLockedRail("Alerts");
      setActiveRail("Alerts");
      return;
    }
    const response = await api.createAlert({ symbol: selected, mode: mode === "confirmed" ? "confirmed" : "watch", channels: ["app", "telegram"] });
    setAlerts((current) => [response, ...current.filter((item) => item.id !== response.id)]);
    setAlertState(response);
    setTimeout(() => setAlertState(null), 3200);
  };

  useEffect(() => {
    if (!["Security", "Settings"].includes(activeRail)) return;
    if (!canAccessRail(subscriptionProfile, activeRail)) return;
    const controller = new AbortController();
    setSystemStatusLoading(true);
    Promise.all([
      api.systemStatus({ signal: controller.signal }),
      api.dataDiagnostics(null, { signal: controller.signal }),
    ]).then(([status, diagnostics]) => {
      setSystemStatus(status);
      setDataDiagnostics(diagnostics);
    }).catch(() => {}).finally(() => setSystemStatusLoading(false));
    return () => controller.abort();
  }, [activeRail, subscriptionProfile]);

  const disableAlert = async (id) => {
    const updated = await api.disableAlert(id);
    setAlerts((current) => current.map((alert) => alert.id === id ? updated : alert));
  };

  const selectRail = (title) => {
    if (!canAccessRail(subscriptionProfile, title)) {
      setLockedRail(title);
      setActiveRail(title);
      return;
    }
    setLockedRail(null);
    setActiveRail(title);
    if (title === "Cockpit" || title === "Charts") setActiveTab("Chart");
    if (title === "Journal") setActiveTab("Journal");
    if (title === "Scanner") {
      setActiveTab("Chart");
      setFilterOn(false);
      setTimeout(() => searchInput.current?.focus(), 0);
    }
  };

  return (
    <div className={`app-shell ${readable ? "readable" : "compact"} ${freeChartOnly ? "free-chart-only" : ""}`}>
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><ChartLineUp size={18} weight="bold" /></div><div className="brand-copy"><strong>SignalEdge</strong><span>Where Signals Become Edge</span></div></div>
        <div className="market-strip">
          <Metric label="VNINDEX" value={vnIndex?.price} change={vnIndex?.change} spark delayed title={vnIndex ? `${vnIndex.source} · ${vnIndex.cadence} · ${formatSyncTime(vnIndex.quotedAt)}` : copy.topbar.noVnIndex} onClick={() => openSymbolChart("VNINDEX")} />
          <Metric label="VN30" value={vn30Index?.price} change={vn30Index?.change} delayed title={vn30Index ? `${vn30Index.source} · ${vn30Index.cadence} · ${formatSyncTime(vn30Index.quotedAt)}` : copy.topbar.noVn30} onClick={() => openSymbolChart("VN30")} />
          <Metric label="BTCUSDT" value={btcRow?.price} change={btcRow?.change} title={btcRow ? `Binance ticker · ${formatSyncTime(btcRow.quotedAt)}` : copy.topbar.waitingBinance} onClick={() => openSymbolChart("BTCUSDT")} />
          <Metric label="ETHUSDT" value={ethRow?.price} change={ethRow?.change} title={ethRow ? `Binance ticker · ${formatSyncTime(ethRow.quotedAt)}` : copy.topbar.waitingBinance} onClick={() => openSymbolChart("ETHUSDT")} />
          <div className="regime"><span>{copy.topbar.marketRegime}</span><strong>{marketRegime}</strong></div>
        </div>
        <div className="top-actions"><div className={`live ${cryptoQuotesLive && !quoteError ? "" : "degraded"}`} title={quoteError ?? `Quote ${quotes.status} · ${quoteAgeSeconds ?? "--"}s · Snapshot ${sync?.chartSnapshotId ?? "pending"} · Data quality ${dataQuality?.score ?? "--"}/100`}><span /> {quoteError ? "QUOTE ERROR" : cryptoQuotesLive ? "CRYPTO LIVE 5S" : researchData ? "RESEARCH DATA" : synchronized ? "SYNCED" : online ? "SYNCING" : "OFFLINE"}</div><label className="global-search"><MagnifyingGlass size={15} /><input ref={searchInput} aria-label={copy.topbar.searchAria} placeholder={copy.topbar.searchPlaceholder} value={search} onChange={(event) => setSearch(event.target.value)} /></label><button className="subscription-pill" onClick={() => selectRail("Plans")} title={subscriptionProfile?.tierName}>{subscriptionProfile?.tier?.toUpperCase() ?? "FREE"}</button><div className="language-toggle" title={copy.topbar.languageTitle}>{LANGUAGES.map((item) => <button key={item.key} className={language === item.key ? "active" : ""} onClick={() => setLanguage(item.key)} aria-label={item.name}>{item.label}</button>)}</div><button aria-label={copy.topbar.alertsAria} title={`${alerts.filter((alert) => alert.enabled).length} alerts armed`} onClick={() => selectRail("Alerts")}><Bell size={18} /></button><button className="avatar" aria-label={copy.topbar.accountAria} onClick={onSignOut}>SE</button></div>
      </header>

      <aside className="nav-rail">
        {[['Cockpit',SquaresFour],['Scanner',ListMagnifyingGlass],['Charts',ChartLineUp],['Performance',ChartBar],['Journal',BookOpen],['Alerts',Bell],['Plans',Star]].map(([title,Icon]) => <SidebarButton key={title} icon={Icon} active={activeRail === title} locked={!canAccessRail(subscriptionProfile, title)} title={title} onClick={() => selectRail(title)} />)}
        <div className="rail-spacer" /><SidebarButton icon={ShieldCheck} active={activeRail === "Security"} locked={!canAccessRail(subscriptionProfile, "Security")} title="Security" onClick={() => selectRail("Security")} /><SidebarButton icon={Gear} active={activeRail === "Settings"} locked={!canAccessRail(subscriptionProfile, "Settings")} title="Settings" onClick={() => selectRail("Settings")} />
      </aside>

      <aside className="watchlist-panel">
        <div className="panel-heading"><div><span>{copy.watchlist.heading}</span><strong>{activeUniverseLabel}</strong></div><div><button aria-label={copy.watchlist.addAria} title={copy.watchlist.addTitle} onClick={() => searchInput.current?.focus()}><Plus size={16} /></button><button aria-label={copy.watchlist.switchAria} title={copy.watchlist.switchTitle} onClick={() => { const keys = allowedUniverseOptions.map((option) => option.key); switchUniverse(keys[(keys.indexOf(universe) + 1) % keys.length] ?? "vn"); }}><CirclesFour size={16} /></button></div></div>
        <div className="watch-controls"><select value={universe} onChange={(event) => switchUniverse(event.target.value)}>{allowedUniverseOptions.map((option) => <option key={option.key} value={option.key}>{copy.universe[option.key]}</option>)}</select><button className={filterOn ? "active" : ""} onClick={() => setFilterOn((value) => !value)} title={freeChartOnly ? "Nâng gói Signal để mở bộ lọc score" : copy.watchlist.filterTitle} disabled={freeChartOnly || !canAccessFeature(subscriptionProfile, "advancedFilters")}><SlidersHorizontal size={16} /></button></div>
        <div className="watch-columns">{freeChartOnly ? <><span>Symbol</span><span>Plan</span><span>Change</span><span>Signal</span></> : <><span>Symbol</span><span>Score</span><span>TF Align</span><span>Crystal</span></>}</div>
        <div className="watch-scroll">
          {(freeChartOnly ? [{ key: "MARKET", label: "MARKET BOARD", className: "data" }] : GROUPS).map((group) => <section className={`watch-group ${group.className}`} key={group.key}><h3>{group.label} <span>({grouped[group.key]?.length ?? 0})</span></h3>{grouped[group.key]?.map((row) => <WatchlistRow key={row.symbol} row={row} selected={selected === row.symbol} onSelect={selectWatchlistRow} lockedScores={freeChartOnly} />)}</section>)}
        </div>
        <footer><span>Live {sync?.scannerTotal ?? scanner.length}/{sync?.universeTotal ?? scanner.length} · {copy.watchlist.missing} {sync?.unavailableTotal ?? 0}</span><span className={`connection ${operational ? "" : "degraded"}`} title={researchData ? "Fixture data · non-executable" : sync?.transportCache}><i /> {researchData ? "RESEARCH" : `${sync?.latencyMs ?? "--"}ms`}</span></footer>
      </aside>

      <main className="workspace">
        <section className="chart-workspace">
          <div className="instrument-bar binance-market-header">
            <div className="instrument market-symbol-block"><Star size={16} weight="fill" /><div><strong>{selected}</strong><span>{analysis?.meta?.venue ?? "--"} · {analysis?.meta?.market ?? "--"}</span></div></div>
            <div className={`instrument-price market-main-price ${selectedDisplayChange < 0 ? "negative" : ""}`} title={selectedQuote ? `Live quote · ${formatSyncTime(selectedQuote.quotedAt)}` : researchData ? copy.chart.noFixturePrice : copy.chart.closedCandlePrice}><strong>{formatPrice(selectedDisplayPrice)}</strong><span>{formatChange(selectedDisplayChange)}</span></div>
            <div className="market-header-stats">
              <MarketHeaderStat label="Biến động 24 giờ" value={formatChange(selectedDisplayChange)} accent={selectedDisplayChange < 0 ? "negative" : "positive"} />
              <MarketHeaderStat label="Giá cao nhất 24h" value={formatPrice(selectedHigh24h)} />
              <MarketHeaderStat label="Giá thấp nhất 24h" value={formatPrice(selectedLow24h)} />
              <MarketHeaderStat label={`Khối lượng 24h (${selected})`} value={formatCompact(selectedVolume24h)} />
              <MarketHeaderStat label="Khối lượng 24h (Value)" value={formatCompact(selectedTurnover24h)} />
              <MarketHeaderStat label="Nguồn" value={sync?.chart?.source ?? "--"} />
            </div>
            <div className="market-header-controls">
              <div className="timeframes">{["D1", "H4"].map((tf) => <button key={tf} className={timeframe === tf ? "active" : ""} onClick={() => setTimeframe(tf)}>{tf}</button>)}</div>
              <div className="date-ranges">{["7D", "1M", "3M"].map((range) => <button key={range} className={dateRange === range ? "active" : ""} onClick={() => setDateRange(range)}>{range}</button>)}</div>
              <div className={`connection-status ${operational ? "" : "degraded"}`} title={`Calc ${sync?.calculationVersion ?? "--"} · Source ${sync?.chart?.source ?? "--"} · ${dataQuality?.checkedFeeds ?? 0} feeds checked`}><Database size={14} /> {researchData ? "RESEARCH" : synchronized ? `SYNC ${formatSyncTime(sync?.chart?.asOf)} · Q${dataQuality?.score ?? "--"}` : "SYNC"}</div>
            </div>
          </div>
          <div className="workspace-tabs">{[["Chart", copy.tabs.chart], ["Structure Map", copy.tabs.structureMap], ["Journal", copy.tabs.journal]].map(([tab, label]) => <button className={activeTab === tab && ["Cockpit", "Scanner", "Charts", "Journal"].includes(activeRail) ? "active" : ""} onClick={() => { selectRail(tab === "Journal" ? "Journal" : "Charts"); setActiveTab(tab); }} key={tab}>{label}</button>)}</div>
          <div className="mode-bar">
            <span>Mode</span><div className="segmented"><button className={mode === "aggressive" ? "active" : ""} onClick={() => switchSignalMode("aggressive")}>Aggressive</button><button className={mode === "confirmed" ? "active" : ""} onClick={() => switchSignalMode("confirmed")}>Confirmed</button></div>
            <p><b>Aggressive</b> = {copy.chart.aggressiveText} <em>Confirmed</em> = {copy.chart.confirmedText}</p>
            <div className="confirm-bars"><span>{copy.chart.confirmBars}</span><button onClick={() => setConfirmationBars((value) => Math.max(1, value - 1))}>-</button><strong>{confirmationBars}</strong><button onClick={() => setConfirmationBars((value) => Math.min(10, value + 1))}>+</button><small>(1-10)</small></div>
          </div>
          <div className="layer-bar">
            {[['ha','Crystal HA Candles'],['crystal','Circles + Arrows'],['structure','123 + BOS / CHOCH / Sweep'],['orderBlock','Order Block'],['ema','EMA 20/50/200'],['atr','ATR Bands']].map(([key,label]) => <button key={key} className={layers[key] ? "active" : ""} onClick={() => toggleLayer(key)}><span />{label}</button>)}
          </div>

          <div className="chart-stage">
            {syncError && <div className="sync-error"><WarningCircle size={15} /><span>{copy.chart.syncError}: {syncError}</span><button onClick={() => setRefreshTick((value) => value + 1)}>{copy.chart.retry}</button></div>}
            {lockedRail && activeRail === lockedRail && <UpgradeNotice requiredTier={requiredTierForRail(lockedRail)} profile={subscriptionProfile} onOpenPlans={() => { setLockedRail(null); setActiveRail("Plans"); }} />}
            {["Cockpit", "Scanner", "Charts"].includes(activeRail) && activeTab === "Chart" && (loading ? <div className="loading"><Pulse size={24} /> {copy.chart.loading}</div> : <div className="binance-trade-layout"><MarketDepthPanel flow={candleFlow} price={selectedDisplayPrice} change={selectedDisplayChange} symbol={selected} /><div className="binance-chart-panel"><TradingChart analysis={analysis} layers={visibleLayers} dateRange={dateRange} lockedPreview={freeChartOnly} signalMode={mode} /></div></div>)}
            {!freeChartOnly && ["Cockpit", "Scanner", "Charts"].includes(activeRail) && activeTab === "Structure Map" && <StructureMap analysis={analysis} />}
            {!lockedRail && activeRail === "Journal" && <JournalView entries={journalEntries} onLog={logCurrentSignal} onClear={clearJournal} copy={copy} />}
            {!lockedRail && activeRail === "Performance" && <PerformanceView analytics={scannerAnalytics} scanner={modeDisplayScanner} copy={copy} />}
            {!lockedRail && activeRail === "Alerts" && <AlertsView alerts={alerts} onDisable={disableAlert} copy={copy} />}
            {activeRail === "Plans" && <SubscriptionView copy={copy} />}
            {!lockedRail && activeRail === "Security" && <SecurityView status={systemStatus} diagnostics={dataDiagnostics} loading={systemStatusLoading} copy={copy} />}
            {!lockedRail && activeRail === "Settings" && <SettingsView status={systemStatus} readable={readable} onReadableChange={setReadable} refreshSeconds={refreshSeconds} onRefreshChange={setRefreshSeconds} copy={copy} />}
          </div>

          <div className="chart-legend"><strong>{copy.chart.legendTitle}</strong><span><i className="bull-circle" /> {copy.chart.bullEarly}</span><span><i className="bear-circle" /> {copy.chart.bearEarly}</span><span><ArrowUp size={14} color="#36d56b" /> {copy.chart.bullConfirm}</span><span><ArrowDown size={14} color="#ff4055" /> {copy.chart.bearConfirm}</span><span><i className="bos-line" /> BOS</span><span><i className="choch-line" /> CHOCH</span></div>
          <div className="event-timeline">
            <div className="timeline-title"><span>{copy.chart.timeline}</span><small>{copy.chart.auditTrail}</small></div>
            {timelineStages.map((stage, index) => <Fragment key={stage.key}>
              <div className={`event ${stage.color} ${stage.status}`}>
                <span>{stage.icon} {stage.label}</span>
                <strong>{stage.title}</strong>
                <small>{stage.detail}</small>
              </div>
              {index < timelineStages.length - 1 && <b className={stage.status === "pending" ? "pending" : ""}>→</b>}
            </Fragment>)}
          </div>
        </section>

        <aside className="thesis-panel">
          <div className="thesis-tabs">{[["THESIS", copy.tabs.thesis], ["NOTES", copy.tabs.notes]].map(([tab, label]) => <button key={tab} className={thesisTab === tab ? "active" : ""} onClick={() => setThesisTab(tab)}>{label}</button>)}</div>
          <div className="thesis-copy"><div><h2>{selected} - {timeframe}</h2><span className={`bias ${score?.direction}`}>{score?.direction === "bear" ? "SHORT" : "LONG"}</span></div>{thesisTab === "THESIS" ? <p>{copy.chart.thesis}</p> : <textarea value={notes[selected] ?? copy.chart.defaultNote} onChange={(event) => setNotes((current) => ({ ...current, [selected]: event.target.value }))} aria-label="Trade notes" />}</div>
          <section className="quant-score"><h3>QUANT SCORE <span>(0-100)</span></h3><div className="score-layout"><ScoreRing score={score?.total ?? 0} /><div className="score-components"><div><i className="purple"><Target size={15} /></i><span>Structure</span><strong>{score?.components?.structure ?? 0}<small>/40</small></strong></div><div><i className="blue"><Pulse size={15} /></i><span>Momentum</span><strong>{score?.components?.momentum ?? 0}<small>/30</small></strong></div><div><i className="orange"><ArrowUp size={15} /></i><span>Entry Quality</span><strong>{score?.components?.entry ?? 0}<small>/30</small></strong></div></div></div></section>
          <section className="evidence"><h3>{copy.chart.crystalEvidence} <WarningCircle size={13} /></h3><div><span>{copy.chart.earlyWarning}</span><strong>+2 / 6</strong><small className="pass">● Closed HA</small></div><div><span>{copy.chart.confirmArrow}</span><strong>{score?.evidence?.crystal === "confirmed" ? "+6 / 6" : "+0 / 6"}</strong><small className={score?.evidence?.crystal === "confirmed" ? "pass" : "pending"}>● {score?.evidence?.crystal}</small></div><div><span>{copy.chart.mtfGate}</span><strong>{analysis?.aligned ? "+5 / 5" : "+1 / 5"}</strong><small className={analysis?.aligned ? "pass" : "pending"}>● {analysis?.aligned ? "D1/H4" : copy.chart.notAligned}</small></div></section>
          <RiskCalculator analysis={analysis} entryPrice={selectedDisplayPrice} copy={copy} />
          <button className="alert-button" onClick={createAlert} disabled={researchData && mode === "confirmed"} title={researchData && mode === "confirmed" ? "Confirmed trade alerts require validated live data" : undefined}><Alarm size={17} weight="fill" /> {researchData && mode === "confirmed" ? copy.chart.liveDataRequired : `${copy.chart.setTradeAlert} (${mode === "confirmed" ? copy.chart.confirmedOnly : copy.chart.watchOnly})`}</button>
        </aside>
      </main>

      <section className="analytics-drawer">
        <div className="analytics-heading"><span>{copy.analytics.heading}</span><div className="analytics-status"><span>{researchData ? "RESEARCH" : `${scannerAnalytics.total} ${copy.analytics.codes}`}</span><span>Q{dataQuality?.score ?? "--"}</span><span>{sync?.transportCache ?? "--"}</span></div></div>
        {scannerAnalytics.universes.map((market) => (
          <article className="analytics-card signal-card market-signal-card" key={market.key}>
            <h3>{market.shortLabel.toUpperCase()} SIGNALS</h3>
            <div className="signal-metrics">
              <div><span>{copy.analytics.aWatch}</span><strong>{market.aPlus} / {market.watch}</strong><small>{market.status}</small></div>
              <div><span>{copy.analytics.arrowCircle}</span><strong>{market.confirmed} / {market.early}</strong><small>{copy.analytics.closedCandles}</small></div>
              <div><span>{copy.analytics.missingFeed}</span><strong>{market.missing}</strong><small>{copy.analytics.noFakeData}</small></div>
            </div>
            <footer>{market.count} {copy.analytics.scored} · {market.aligned} {copy.analytics.mtfAligned} · {copy.analytics.avg} {market.average}</footer>
          </article>
        ))}
        <article className="analytics-card assets"><h3>{copy.analytics.marketCoverage}</h3><div className="asset-head"><span>{copy.analytics.market}</span><span>{copy.analytics.assets}</span><span>{copy.analytics.aligned}</span><span>{copy.analytics.avg}</span></div>{scannerAnalytics.markets.map((row) => <div className="asset-row" key={row.market}><span>{row.market}</span><span>{row.count}</span><span>{row.aligned}</span><span>{row.average}</span></div>)}</article>
        <article className="analytics-card assets"><h3>{copy.analytics.top} {scannerAnalytics.activeUniverse.shortLabel.toUpperCase()}</h3><div className="asset-head"><span>{copy.analytics.asset}</span><span>{copy.analytics.score}</span><span>{copy.analytics.signal}</span><span>{copy.analytics.mtf}</span></div>{scannerAnalytics.activeUniverse.top.length ? scannerAnalytics.activeUniverse.top.map((row) => <div className="asset-row" key={row.symbol}><span>{row.symbol}</span><span>{row.score}</span><span>{row.crystal}</span><span>{row.aligned ? "YES" : "NO"}</span></div>) : <div className="empty-state">{copy.analytics.noSignal}</div>}</article>
        <TradePlanWidget symbol={selected} plan={tradePlan} price={selectedDisplayPrice} score={score} freeChartOnly={freeChartOnly} />
      </section>

      <APlusRecommendationPanel
        signal={rankAlert}
        analysis={analysis}
        price={rankAlert?.row?.symbol === selected ? selectedDisplayPrice : rankAlert?.row?.price}
        change={rankAlert?.row?.symbol === selected ? selectedDisplayChange : rankAlert?.row?.change}
        language={language}
        onClose={() => setRankAlert(null)}
        onOpenChart={() => {
          if (rankAlert?.row?.symbol) setSelected(rankAlert.row.symbol);
          setLockedRail(null);
          setActiveRail("Charts");
          setActiveTab("Chart");
        }}
      />

      {alertState && <div className="toast"><CheckCircle size={20} weight="fill" /><div><strong>Alert armed</strong><span>{alertState.symbol} · {alertState.policy}</span></div></div>}
    </div>
  );
}

export function App() {
  const [plans, setPlans] = useState(null);
  const [profile, setProfile] = useState(() => {
    try { return JSON.parse(localStorage.getItem("signaledge-subscription-profile") ?? "null"); } catch { return null; }
  });
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [accessError, setAccessError] = useState("");
  const adminRoute = window.location.pathname.startsWith("/admin");

  useEffect(() => {
    const controller = new AbortController();
    api.subscriptionPlans({ signal: controller.signal }).then((payload) => {
      setPlans(payload.data ?? payload);
    }).catch((error) => {
      if (!controller.signal.aborted) setAccessError(error.message);
    }).finally(() => setLoadingPlans(false));
    return () => controller.abort();
  }, []);

  const activate = async (payload) => {
    setAccessError("");
    try {
      const activated = await api.activateSubscription(payload);
      setProfile(activated);
      localStorage.setItem("signaledge-subscription-profile", JSON.stringify(activated));
    } catch (error) {
      setAccessError(error.status === 401 ? "Access pass không hợp lệ hoặc chưa được duyệt." : error.message);
      throw error;
    }
  };

  const signOut = () => {
    localStorage.removeItem("signaledge-subscription-profile");
    setProfile(null);
  };

  if (adminRoute) {
    return <AdminPortal plans={plans} />;
  }

  if (!profile) {
    return <AccessPortal plans={plans} loading={loadingPlans} error={accessError} onActivate={activate} />;
  }

  return <CockpitApp subscriptionProfile={profile} subscriptionPlans={plans} onSignOut={signOut} />;
}


