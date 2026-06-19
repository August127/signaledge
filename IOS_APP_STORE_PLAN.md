# SignalEdge iOS / App Store Plan

## Executive Decision

Use a native iOS shell for App Store distribution, not a thin WebView-only wrapper.

Recommended implementation:

1. Keep the current SignalEdge backend as the source of truth for scanner, market data, subscription state, alerts, and admin control.
2. Build an iOS app with SwiftUI + StoreKit 2 + Sign in with Apple.
3. Embed the existing chart/workspace only where it is technically efficient, but add native app value around it: watchlists, push alerts, biometrics, subscription management, notification history, saved signal cards, and iOS-optimized onboarding.
4. Do not market the app as a brokerage, exchange, crypto wallet, or automated investment adviser unless the owner has the required licenses and legal review.

## App Store Risk Notes

Apple review risk is material for this product because it is in the investing/trading category.

High-risk items:

- Unlocking `Signal Pro` inside iOS via broker-code conversion can be rejected if it acts as a non-IAP mechanism for digital features.
- A WebView-only clone of the web app can be rejected for insufficient native functionality.
- Trading or investment claims must be conservative, with visible disclaimers and no guaranteed profit language.
- If crypto features imply exchange, wallet, futures, or securities trading, licensing requirements become much stricter.

Safe positioning:

- "Market scanner and education tool"
- "Technical analysis dashboard"
- "Signal monitoring and risk workflow"
- "Information only, not investment advice"

Avoid positioning:

- "Guaranteed winrate"
- "Buy/sell recommendation service"
- "Automated trading"
- "Crypto exchange / wallet"
- "Broker replacement"

## Subscription Model For iOS

For App Store release:

- `Free Signal`: free app tier.
- `Signal Pro Monthly`: auto-renewable StoreKit subscription.
- `Signal Pro Annual`: auto-renewable StoreKit subscription.
- `Admin`: not sold in App Store; assigned server-side to owner/operator accounts.

Broker-code conversion should be handled carefully:

- Do not show external payment or broker-code CTA as the unlock path inside the iOS app unless legal/App Review confirms the model is acceptable for the target storefront.
- If broker-code conversion remains a business goal, handle it outside the iOS purchase UI and avoid app wording that directs users to bypass IAP.
- Server can still map entitlements from App Store receipts and admin-approved accounts, but the iOS app should offer StoreKit purchase for paid digital features.

## Native Features Required To Avoid "Repackaged Website" Risk

Minimum native features for v1:

- Sign in with Apple.
- StoreKit subscription screen and restore purchases.
- APNs push notification for A+ signals.
- Biometric unlock with Face ID / Touch ID for session protection.
- Native notification center for signal history.
- Native watchlist and saved symbols.
- iOS-safe responsive layout for chart, signal card, and scanner list.
- In-app privacy policy, terms, and risk disclaimer.
- Demo account or demo mode for App Review.

Nice-to-have after v1:

- Home Screen widgets for VNINDEX, BTCUSDT, and latest A+ count.
- Lock Screen Live Activity only if compliant and useful.
- Siri/App Shortcuts for "Open VNINDEX" or "Show latest A+ signals".
- Offline cache for last market snapshot.

## Technical Architecture

Current production target remains valid for under 5000 users:

- Single Node/Express backend.
- PostgreSQL for users, subscriptions, audit log.
- Redis for session/cache/rate-limited scanner snapshots.
- Cloudflare WAF/rate limit in front.
- HTTPS-only public API.
- Pino structured logs.
- APNs and Telegram notification workers.

iOS app integration:

- `GET /api/workspace/:symbol`
- `GET /api/scanner`
- `GET /api/quotes`
- `POST /api/auth/apple`
- `POST /api/storekit/verify-receipt`
- `POST /api/device-tokens`
- `GET /api/subscription/me`
- `POST /api/notifications/a-plus-telegram` remains admin/server-triggered, not user-facing purchase logic.

## Delivery Roadmap

Phase 1 - App Store readiness audit:

- Legal review for financial/investing wording.
- Remove any in-app copy that implies guaranteed result.
- Add Privacy Policy, Terms, Disclaimer, Contact Support.
- Add App Review demo account.
- Add App Store metadata and screenshots.

Phase 2 - iOS MVP:

- Create native SwiftUI app.
- Implement login, language switch, free/pro entitlement display.
- Implement StoreKit 2 subscriptions and restore purchases.
- Implement push notification registration.
- Use existing API for scanner/chart.
- Add native A+ signal detail card.

Phase 3 - TestFlight:

- Internal TestFlight.
- External TestFlight with 20-50 trusted users.
- Crash/performance review.
- Subscription sandbox testing.
- App Review notes prepared with demo account and backend availability.

Phase 4 - App Store submission:

- Upload build from Xcode or Transporter.
- Fill privacy labels and encryption/export compliance.
- Submit subscriptions and app together.
- Provide review notes explaining:
  - Information-only market scanner.
  - No trade execution.
  - No crypto wallet/exchange.
  - Data sources.
  - Demo login.

## Immediate Web App Cleanup Follow-up

Recommended next engineering refactors:

- Split `src/App.jsx` into `Topbar`, `WatchlistPanel`, `Workspace`, `ScannerAnalytics`, and `LoginGate`.
- Split `src/styles.css` into base, layout, chart, panels, subscription, admin.
- Split `server/market-data.js` by provider: Binance, SSI, KBS, 24HMoney, TradingView UDF.
- Add a formal lint/format script.
- Add CI command: `npm ci && npm test && npm run build && npm run benchmark`.
- Keep deterministic fixture provider test-only and blocked in production unless explicitly allowed.
