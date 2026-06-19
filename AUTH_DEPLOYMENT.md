# SignalEdge Auth & Deployment

Muc tieu giai doan nay: van hanh on dinh duoi 5000 user bang mot backend Node/Express, PostgreSQL, Redis va Cloudflare phia truoc. Chua can microservices cho den khi tai thuc te vuot nang luc single backend.

## Production Stack

- Edge: Cloudflare WAF, bot protection, rate limit theo IP va route.
- App: Node/Express single backend, build React/Vite vao `dist`.
- Database: PostgreSQL luu state ben vung: user/subscription access codes, scanner config, audit, alerts, journal va Telegram signal tracking.
- Cache: Redis luu cache ngan han cho quotes/scanner de giam tai API va provider.
- Auth hien tai: access pass theo tier va admin token. Buoc tiep theo moi can JWT cookie httpOnly day du.
- Admin: trang `/admin` rieng, quan ly user, cap ma truy cap va tinh chinh scanner config.

## Access Model

| Tier | Quyen chinh | Dieu kien |
| --- | --- | --- |
| Free Signal | Chart co ban, bang ma VN co ban, xem thong tin goi | Dang ky cong dong |
| Signal Pro | VN + Crypto scanner, score, A+/A signal, Crystal HA, Telegram alert, journal, risk tools | Ma truy cap/broker-code do admin cap |
| Admin | Toan quyen Pro + quan tri subscription, cap user, chinh scanner config | Owner account |

## Current Persistence

Khi co `DATABASE_URL`, app dung bang PostgreSQL:

```sql
create table if not exists signaledge_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
```

State keys hien tai:

- `scanner-config`
- `admin-users`
- `telegram-signals`
- `operations`

Khi khong co `DATABASE_URL`, app fallback ve `.data/*.json` de dev local khong bi vo.

## Redis Runtime Cache

Khi co `REDIS_URL`, app cache ngan han:

- `/api/quotes`: TTL 2 giay.
- `/api/scanner`: TTL 2 giay.

Header `X-Redis-Cache` se cho biet `HIT`, `MISS` hoac `DISABLED`.

## Environment

Production bat buoc dat qua dashboard host/GitHub secrets, khong commit vao repo:

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=8787
DATABASE_URL=postgres://...
PGSSLMODE=require
REDIS_URL=redis://...
REDIS_KEY_PREFIX=signaledge:
SCANNER_API_TOKEN=...
METRICS_TOKEN=...
EVIDENCE_PRIVATE_KEY_B64=...
JWT_COOKIE_SECRET=...
SIGNALEDGE_ADMIN_USERNAME=admin
SIGNALEDGE_ADMIN_PASSWORD=...
SIGNALEDGE_ADMIN_PASS=...
SIGNALEDGE_PRO_PASS=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
ALLOW_FIXTURE_DATA=false
COOKIE_SECURE=true
DEPLOYMENT_MODE=single-node
INSTANCE_COUNT=1
```

## Build And Start

```bash
npm ci
npm test
npm run build
npm start
```

Render/Railway/Fly setting:

- Root directory: `scanner-cockpit`
- Build command: `npm ci && npm test && npm run build`
- Start command: `npm start`
- Health check: `/api/health/ready`

## GitHub Flow

- `main`: production.
- `staging`: staging/pre-production.
- `codex/*`: fix/feature branch.
- Pull request phai pass CI: `npm test` va `npm run build`.
- Secrets chi nam trong GitHub Actions secrets hoac dashboard cua host.

## Operational Guardrails

- Khong commit `.env`, `.data`, token Telegram, DB URL, Redis URL.
- `ALLOW_FIXTURE_DATA=false` trong production.
- `/api/health` phai hien `persistence.mode=postgresql` truoc khi mo user that.
- `/api/health` phai hien `runtimeCache.enabled=true` neu da gan Redis.
- Neu health `degraded` do feed VN thieu ma, app van chay nhung can theo doi `dataQuality`.
- Moi thay doi scanner config can test lai `npm test`, `npm run build` va benchmark API.

## Scale Plan Under 5000 Users

- Beta: 1 app instance + 1 PostgreSQL + 1 Redis.
- Khi user tang: 2 app instances sau Cloudflare/load balancer.
- Chua scale nhieu instance neu chua tach background scanner worker.
- Theo doi p95 latency, provider health, Redis hit rate, Telegram failures va DB connection pool.
