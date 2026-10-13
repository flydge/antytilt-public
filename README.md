# AntyTILT

**The risk firewall for crypto traders. Trade the plan, not the emotion.**

Most traders have rules. What they lack is anything that enforces them when a loss
turns into tilt: the urge to win it back, bigger size, more trades. AntyTILT is a
trading terminal with a server-side risk layer that holds those rules for the trader.

- The trader sets the rules once, in a calm moment.
- From then on the server enforces them, not the browser.
- Every order is checked before it is confirmed and again as it is sent. An order
  that breaks a rule never reaches the exchange.
- A trade placed around the app, directly on the venue, is detected by an
  independent watcher and closed under the trader's chosen policy, even with the
  browser closed.
- Every block, close and wallet request lands in an audit trail.

## Venues

| Venue | Market data | Trading in AntyTILT | Enforcement |
|---|---|---|---|
| **BingX** perpetual futures (VST demo and live) | Native live candles, ticker, funding, order book, trades | Market, Limit and Trigger orders; TP/SL by price, ROI or P&L; reduce-only; full and partial close; amend; cross/isolated and leverage | All ten rules before every order; the RM worker cancels pending entries or closes positions opened directly on BingX |
| **Hyperliquid** perpetuals | Native Mainnet and Testnet data for every perpetual | BTC-PERP on Testnet through an API (agent) wallet the owner approves in Phantom: Market and Limit orders, attached and position TP/SL, close, cancel, amend | A dedicated protection agent enforces the daily trade limit, detects entries placed in the Hyperliquid app from account fills and closes them with reduce-only IOC orders |
| **Jupiter Perps** (Solana) | Position, pool and custody reads from Solana RPC | — | The owner verifies the Phantom wallet with Sign-In With Solana and pre-signs a close ticket for a SOL Long position on a durable nonce. AntyTILT stores it encrypted and submits the full-position close request with one confirmation and no new wallet signature; the owner can revoke it on-chain by advancing the nonce |
| Binance, Bybit | Native live chart data | — | — |

## Risk rules

| Rule | What the server does |
|---|---|
| Protective stop | Requires a Stop Loss on new entries, limits its distance and maintains it on the exchange |
| Break-even | Moves protection to entry plus offset after the configured profit is reached |
| Daily loss limit | Blocks new entries after the daily loss in USDT or percent of opening equity |
| Risk per trade | Compares the loss to Stop Loss with equity and rejects oversize entries |
| Maximum leverage | Refuses leverage above the limit |
| Trades per day | Counts new entries per trading day in the trader's timezone |
| Consecutive losses | Tracks the closed-trade losing streak |
| Cooldown | Blocks new entries for the configured pause after a losing streak |
| Exposure | Caps total open exposure relative to equity |
| Open positions | Caps the number of open positions |

The full rule set runs on BingX accounts; the venue table above lists what each
venue enforces. Breach policies: block new entries, cancel pending entries, close
the violating position, or close all positions. Automatic actions on a live account
require the server switches below and the trader's saved automation consent. See
[Risk management logic](./docs/risk-management.ru.md) (in Russian).

## Architecture

```text
Browser ── React terminal
             │
             ▼
Express API ── Risk Guard (preview and pre-send checks)
   │   ├── PostgreSQL: users, sessions, encrypted credentials, RM state, audit
   │   ├── Redis/BullMQ: account queue, renewable locks, worker heartbeat
   │   └── BingX · Hyperliquid · Jupiter (Solana RPC)
   │
RM worker (independent process)
   └── per account: sync positions/orders/fills → evaluate saved profile
       → record decision and event → authorized cancel / protect / close
```

The API and the RM worker run as separate processes, locally and in production,
so closing the browser or restarting the API does not stop monitoring.

## Security

- Email/password accounts with server sessions; session tokens are stored only as
  hashes and sent in `HttpOnly`, `SameSite=Strict` cookies.
- Exchange API secrets and Hyperliquid agent keys are encrypted with AES-256-GCM
  before storage and never returned to the browser.
- The trader's own wallet keys never leave the wallet. Hyperliquid agents are
  approved by the owner and time-limited; Jupiter close tickets are bound to one
  position, one recipient and one durable nonce, and can be revoked on-chain.
- Every trading mutation is idempotent and stored in PostgreSQL; an uncertain
  exchange result is blocked for reconciliation instead of being sent twice.
- Live writes are gated server-side by explicit switches and per-action review.

## Run locally

Requires Node.js 24, PostgreSQL 17 and Redis 8.

```bash
npm install
cp .env.example .env
docker compose up -d postgres redis
npm run db:migrate
npm run dev
```

Open `http://localhost:5173` and create an account. `npm run dev` starts Vite, the
HTTP API and the RM worker.

### Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `REDIS_URL` | Application database and RM queue |
| `CREDENTIALS_ENCRYPTION_KEY` | Base64 32-byte key for exchange credentials (required in production) |
| `ALLOW_LIVE_TRADING` | Allows orders on live BingX accounts |
| `ALLOW_LIVE_RM_AUTOMATION` | Allows automatic RM writes on live accounts (with user consent) |
| `ALLOW_LIVE_TRIGGER_ORDERS` | Allows Trigger Market/Limit orders on live BingX accounts |
| `HL_AGENT_ENCRYPTION_KEY` | Base64 32-byte key for Hyperliquid agent keys |
| `HL_REAL_ACTIONS_CONFIRMED` | Allows Hyperliquid writes signed by approved agents |
| `JUPITER_UI_CONFIG` | Path to the private Jupiter wallet-protection config |

The full list with defaults is in [`.env.example`](./.env.example).

### Jupiter close-ticket operator CLI

```bash
npm run jupiter:ticket -- init-key --key-file <private-dir>/vault.key
npm run jupiter:ticket -- prepare  --config <private-dir>/config.json --binding <private-dir>/binding.json --unsigned <private-dir>/unsigned.bin
npm run jupiter:ticket -- arm      --config <private-dir>/config.json --id <ticket> --packet <private-dir>/signed.bin
npm run jupiter:ticket -- status   --config <private-dir>/config.json --id <ticket>
```

Config, key and packet files live in a private directory outside the repository
with owner-only permissions.

## Tests

```bash
npm run test:risk-guard          # rule evaluation
npm run test:risk-automation     # stops, break-even, automatic actions
npm run test:database            # user isolation, encryption, durable RM state
npm run test:exchange-api        # BingX API and RM integration
npm run test:hyperliquid         # Hyperliquid terminal, agent and protection
npm run test:jupiter-ticket      # Jupiter close tickets
npm run test:jupiter-wallet      # Jupiter wallet verification and ticket lifecycle
npm run build                    # TypeScript and production bundle
```

PostgreSQL integration tests use local PostgreSQL 17 server binaries; set
`POSTGRES_BIN_DIR` if `pg_config` is not on the path.

## Deployment

- [Production deployment on Render](./DEPLOYMENT.md): web/API service, independent
  RM worker, managed PostgreSQL and Redis.
- [Self-hosted deployment with Docker Compose](./LOCAL_DEPLOYMENT.md).

## Terminal

- Lightweight Charts candlesticks and volume with a full drawing workspace: trend
  lines, rays, levels, Fibonacci, rectangles, measurement, long/short position and
  notes; magnet mode, undo/redo, per-user and per-market persistence.
- Searchable catalog of top perpetual markets with one aggregated price stream.
- Native WebSocket streams with stale detection, reconnect/backoff and REST
  recovery; synthetic candles are never presented as exchange data.
- Server-side order preview: book slippage, fees, margin, order cost and
  indicative liquidation.
- Positions, open orders, order and trade history, assets; draggable TP/SL lines
  with a review dialog.

Drawing shortcuts: `V` cursor, `T` trend line, `H` horizontal level, `F` Fibonacci,
`R` rectangle, `M` measurement, `Ctrl/⌘+Z` undo, `Ctrl/⌘+Shift+Z` redo,
`Delete` remove, `Esc` cancel.

## Disclaimer

Trading leveraged derivatives carries a high risk of loss. Software risk controls
cannot guarantee an exit price: slippage, gaps, exchange or network outages and
rejected orders can occur. AntyTILT is provided as is, without warranty.
