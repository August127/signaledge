const formatDateTime = (value) => value ? new Date(value).toLocaleString("vi-VN") : "--";

function SummaryCards({ items }) {
  return <div className="tab-summary">{items.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>;
}

export function PerformanceView({ analytics, scanner, copy }) {
  return <div className="tab-view rail-view">
    <div className="view-heading"><div><h2>{copy.rail.performanceTitle}</h2><p>{copy.rail.performanceDesc}</p></div></div>
    <SummaryCards items={[
      ["Assets live", analytics.total],
      ["Average score", analytics.averageScore],
      ["MTF aligned", analytics.aligned],
      ["Arrow confirmed", analytics.confirmed],
      ["A+ executable", analytics.executable],
    ]} />
    <div className="data-table"><div className="data-row performance head"><span>Symbol</span><span>Market</span><span>Score</span><span>Signal</span><span>MTF</span><span>Class</span></div>
      {scanner.map((row) => <div className="data-row performance" key={row.symbol}><span>{row.symbol}</span><span>{row.market}</span><span>{row.score}</span><span>{row.crystal}</span><span>{row.aligned ? "ALIGNED" : "MIXED"}</span><span>{row.classification}</span></div>)}
    </div>
  </div>;
}

export function AlertsView({ alerts, onDisable, copy }) {
  const armed = alerts.filter((item) => item.enabled).length;
  return <div className="tab-view rail-view">
    <div className="view-heading"><div><h2>{copy.rail.alertTitle}</h2><p>{copy.rail.alertDesc}</p></div></div>
    <SummaryCards items={[["Total alerts", alerts.length], ["Armed", armed], ["Disabled", alerts.length - armed]]} />
    <div className="data-table"><div className="data-row alerts head"><span>Symbol</span><span>Policy</span><span>Channels</span><span>Created</span><span>Status</span><span>Action</span></div>
      {alerts.length ? alerts.map((alert) => <div className="data-row alerts" key={alert.id}><span>{alert.symbol}</span><span>{alert.policy}</span><span>{alert.channels?.join(", ")}</span><span>{formatDateTime(alert.createdAt)}</span><span className={alert.enabled ? "bull" : "muted"}>{alert.enabled ? "ARMED" : "DISABLED"}</span><span><button className="table-action" disabled={!alert.enabled} onClick={() => onDisable(alert.id)}>Disable</button></span></div>) : <div className="empty-state">{copy.rail.noAlerts}</div>}
    </div>
  </div>;
}

export function AdminView({ plans, profile }) {
  const tiers = plans?.tiers ?? [];
  const allEntitlements = [...new Set(tiers.flatMap((tier) => tier.entitlements ?? []))].sort();
  return <div className="tab-view rail-view admin-view">
    <div className="view-heading admin-heading">
      <div>
        <h2>Admin Console</h2>
        <p>Quyền cao nhất: chỉnh chức năng, phân quyền subscription và kiểm soát rollout. Bản beta hiển thị cấu hình từ backend; production sẽ ghi vào PostgreSQL và audit log.</p>
      </div>
      <strong>{profile?.tierName ?? "Admin"}</strong>
    </div>
    <SummaryCards items={[
      ["Active tiers", tiers.length],
      ["Max users", plans?.capacity?.targetMaxUsers ?? "--"],
      ["Model", plans?.capacity?.currentModel ?? "--"],
      ["Admin", profile?.displayName ?? "--"],
    ]} />
    <div className="admin-grid">
      {tiers.map((tier) => <section className={`admin-tier ${tier.id}`} key={tier.id}>
        <header><span>{tier.name}</span><strong>{tier.capacity}</strong></header>
        <p>{tier.description}</p>
        <small>{tier.condition}</small>
        <div>{(tier.entitlements ?? []).map((item) => <b key={item}>{item.replaceAll("_", " ")}</b>)}</div>
      </section>)}
    </div>
    <div className="data-table entitlement-table">
      <div className="data-row entitlement head"><span>Entitlement</span>{tiers.map((tier) => <span key={tier.id}>{tier.id.toUpperCase()}</span>)}</div>
      {allEntitlements.map((entitlement) => <div className="data-row entitlement" key={entitlement}><span>{entitlement.replaceAll("_", " ")}</span>{tiers.map((tier) => <span className={tier.entitlements?.includes(entitlement) ? "bull" : "muted"} key={tier.id}>{tier.entitlements?.includes(entitlement) ? "ON" : "--"}</span>)}</div>)}
    </div>
  </div>;
}

export function SubscriptionView({ copy }) {
  const tiers = copy.plans.tiers;
  return <div className="tab-view rail-view subscription-view">
    <div className="view-heading subscription-heading">
      <div>
        <h2>{copy.plans.title}</h2>
        <p>{copy.plans.desc}</p>
      </div>
    </div>
    <div className="subscription-grid">
      {tiers.map((tier) => <section className={`plan-card ${tier.accent}`} key={tier.name}>
        <div className="plan-title"><span>{tier.name}</span><strong>{tier.price}</strong><small>{tier.audience}</small></div>
        <div className="plan-list"><b>{copy.plans.benefits}</b>{tier.benefits.map((item) => <p key={item}>✓ {item}</p>)}</div>
        <div className="plan-list muted-list"><b>{copy.plans.conditions}</b>{tier.limits.map((item) => <p key={item}>• {item}</p>)}</div>
        <button className="plan-cta">{tier.cta}</button>
      </section>)}
    </div>
    <div className="conversion-panel">
      <section><h3>{copy.plans.funnelTitle}</h3><p>{copy.plans.funnel}</p></section>
      <section><h3>{copy.plans.communityTitle}</h3><p>{copy.plans.zalo}: <b>{copy.plans.updateLater}</b></p><p>{copy.plans.youtube}: <b>{copy.plans.updateChannel}</b></p><p>{copy.plans.tiktok}: <b>{copy.plans.updateChannel}</b></p></section>
      <section><h3>{copy.plans.operatingTitle}</h3><p>{copy.plans.operating}</p></section>
    </div>
  </div>;
}

function providerRows(status) {
  const equity = status?.provider?.providers?.equities;
  if (!equity) return [];
  const providers = equity.providers ?? {};
  return Object.values(providers).map((provider, index) => ({
    layer: index + 1,
    id: provider.id,
    configured: provider.configured !== false,
    connected: Boolean(provider.connected),
    executable: provider.executableSeries ?? 0,
    quality: provider.quality?.status ?? "unknown",
  }));
}

export function SecurityView({ status, diagnostics, loading, copy }) {
  const scale = status?.scale;
  const providers = providerRows(status);
  const quoteSummary = diagnostics?.quoteSummary;
  const seriesSummary = diagnostics?.seriesSummary ?? [];
  return <div className="tab-view rail-view">
    <div className="view-heading"><div><h2>{copy.rail.securityTitle}</h2><p>{copy.rail.securityDesc}</p></div></div>
    {loading ? <div className="loading-inline">{copy.rail.loadingSystem}</div> : <>
      <SummaryCards items={[
        ["System", status?.status?.toUpperCase() ?? "UNKNOWN"],
        ["Data quality", status?.provider?.quality?.status?.toUpperCase() ?? "UNKNOWN"],
        ["Synthetic data", status?.dataPolicy?.syntheticAllowed ? "ALLOWED" : "BLOCKED"],
        ["Horizontal scale", scale?.horizontalReady ? "READY" : "NOT READY"],
      ]} />
      <SummaryCards items={[
        ["Quotes returned", quoteSummary ? `${quoteSummary.returned}/${quoteSummary.requested}` : "--"],
        ["Index quotes", quoteSummary?.indices ?? "--"],
        ["Quote sources", quoteSummary?.sources?.join(", ") || "--"],
        ["Diagnostics", diagnostics?.status?.toUpperCase() ?? "UNKNOWN"],
      ]} />
      <div className="data-table"><div className="data-row providers head"><span>Layer</span><span>Provider</span><span>Configured</span><span>Connected</span><span>Series</span><span>Quality</span></div>
        {providers.map((provider) => <div className="data-row providers" key={provider.id}><span>L{provider.layer}</span><span>{provider.id}</span><span>{provider.configured ? "YES" : "NO"}</span><span>{provider.connected ? "YES" : "NO"}</span><span>{provider.executable}</span><span>{provider.quality}</span></div>)}
      </div>
      <div className="data-table diagnostics-table"><div className="data-row diagnostics head"><span>Timeframe</span><span>Total</span><span>Live</span><span>Executable</span><span>Unavailable</span></div>
        {seriesSummary.map((row) => <div className="data-row diagnostics" key={row.timeframe}><span>{row.timeframe}</span><span>{row.total}</span><span>{row.live}</span><span>{row.executable}</span><span>{row.unavailable}</span></div>)}
      </div>
      {scale?.blockers?.length ? <div className="status-note warning"><strong>{copy.rail.scaleNotReady}</strong><span>{scale.blockers.join(" · ")}</span></div> : null}
    </>}
  </div>;
}

export function SettingsView({ status, readable, onReadableChange, refreshSeconds, onRefreshChange, copy }) {
  const priority = status?.provider?.providers?.equities?.priority ?? [];
  return <div className="tab-view rail-view">
    <div className="view-heading"><div><h2>{copy.rail.settingsTitle}</h2><p>{copy.rail.settingsDesc}</p></div></div>
    <div className="settings-grid">
      <section><h3>{copy.rail.interface}</h3><label><span>{copy.rail.readableTypography}</span><button className={`setting-toggle ${readable ? "active" : ""}`} onClick={() => onReadableChange(!readable)}>{readable ? "ON" : "OFF"}</button></label><label><span>{copy.rail.workspaceRefresh}</span><select value={refreshSeconds} onChange={(event) => onRefreshChange(Number(event.target.value))}><option value={15}>15 seconds</option><option value={30}>30 seconds</option><option value={60}>60 seconds</option></select></label></section>
      <section><h3>{copy.rail.vietnamPriority}</h3>{priority.map((provider, index) => <div className="provider-priority" key={provider}><b>L{index + 1}</b><span>{provider}</span></div>)}<small>{copy.rail.udfNote}</small></section>
      <section><h3>{copy.rail.runtime}</h3><div className="setting-readonly"><span>{copy.rail.calculation}</span><b>{status?.calculationVersion ?? "--"}</b></div><div className="setting-readonly"><span>{copy.rail.cacheEntries}</span><b>{status?.cache?.entries ?? 0}</b></div><div className="setting-readonly"><span>{copy.rail.serverTime}</span><b>{formatDateTime(status?.serverTime)}</b></div></section>
    </div>
  </div>;
}
