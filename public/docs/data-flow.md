# Information flow

**REST** for actions and saves. **SSE** for live updates. The browser does **not** open a WebSocket — the **server** connects to Polymarket and Chainlink.

## Channels

| Channel | Direction | For |
|---------|-----------|-----|
| **REST** `/api/...` | Browser → server | Login, settings, toggles, triggers, schedule hour stats, manual orders |
| **SSE** `/api/stream` | Server → browser | Quotes, window, trading state, log, heatmap, schedule |
| **WebSocket** | Server ↔ exchanges | CLOB book + Chainlink (server only) |

```flow
# Browser ↔ Poly Real
Browser -> REST /api -> Server
Server -> SSE /api/stream -> Browser
```

## Live market data

```flow
# Sources
Polymarket CLOB WS -> Server
Chainlink WS -> Server
Polymarket REST (window / PTB) -> Server
Server -> SSE -> Browser
```

| Data | Source |
|------|--------|
| Quotes / book | Polymarket CLOB (server WS) |
| Window / tokens | Polymarket REST |
| PTB | Window open price (REST) |
| Asset price | Chainlink (prefer), else REST |
| Gap / crossings | Server: asset vs PTB |

## Trading

**Trigger Trade** (and optional Prediction Trade) run on the **server**. The browser sets toggles / trigger definitions and can send **manual** orders.

| Control | Effect |
|---------|--------|
| **Allow trade** | Off = demo; on = real orders when the server can execute |
| **Trigger Trade + Active** | Server may place Trigger orders on each tick — [Market](doc:market) |

Phase Auto Trade / Use Schedule are removed.

## Triggers and schedule

Market Triggers are saved over REST (`triggers` collection). Active/Paused and Demo/Trade changes append to `trigger_mode_timeline`. Live Schedule hour cells load via `GET /api/schedule-hour-stats` (current UTC ISO week; timeline-gated Trigger Trade aggregates).

**Replay** runs via REST `POST /api/schedule-replay` (SSE: `progress` / `placement` / `done` / `failure`) over synthetic 1-hour slots with Replay Triggers only. Body includes `latencyMs`, `fillSuccessPct`, and `triggers`. When `SCHEDULE_REPLAY_SERVICE_URL` is set, the run is proxied to the recorder. **Open Replay** uses `POST /api/schedule-placements/:id/play` with synthetic ids (`hour:mon:14`) plus `triggers` / latency / fill success; prefers in-memory windows from the last Run. Open Replay ticks use `GET /api/ticks` (proxied to the recorder when configured).

Live **Fill success** (Market → Trade) tracks CLOB buy/sell outcomes over the rolling 7-day cutoff, broken down by **FAK / FOK / GTD**. Partial match = success. FAK/FOK count on fire/send; GTD counts only after the resting limit is touched while live (then success if any size matched, else miss). Strategy cancels with no touch stay out of the %.

```flow
# Replay roles
Browser -> POST /api/schedule-replay -> Live server
Live server -> POST SCHEDULE_REPLAY_SERVICE_URL -> Recorder worker
Recorder worker -> SimulatorEngine over DATA_DIR ticks -> SSE stats
Browser -> GET /api/ticks -> Live server
Live server -> GET /api/internal/ticks -> Recorder DATA_DIR
```

| Control / env | Role |
|---------------|------|
| **Available / Recording / Retention** (Admin CRM) | Per-series flags in shared Mongo `markets` (CRM writes Mongo directly). Available gates trader UI + APIs; Recording starts capture on recorder sync (~30s); Retention days drive prune |
| `TRADING_EXECUTOR=1` | Live — may place CLOB orders; never runs recorders (Recording flag still persists) |
| Non-executor process | Starts/stops `MarketRecorder` for each series with Recording on; writes `DATA_DIR` + Mongo heatmap summaries |
| `SCHEDULE_REPLAY_SERVICE_URL` | Live → full URL of recorder `/api/internal/schedule-replay`. Empty = run backtest in-process. Same origin is used to proxy Open Replay ticks (`/api/internal/ticks`) and play payloads |
| `SCHEDULE_REPLAY_WORKER_SECRET` | Optional shared secret for the worker endpoint |
| `DATA_DIR` | Local tick/window files (default `./data`) |

Heatmap and Replay load recent `recorded_windows` (default ~**14 days**, overridable per series via Admin CRM retention), then for each UTC weekday×hour keep only the **latest** calendar day in that slot (so a new Monday hour replaces last Monday’s same hour without clearing the rest of the column). Tick/window files older than that retention are deleted on the recorder. Windows with a flat asset price for the whole recording are treated as bad data: deleted from Mongo + local files and omitted from heatmap/Replay.

**Trader wallets** (Mongo `trader_wallets`, used for heatmap Wallets / New wallets): each completed window refreshes `lastSeenAt`. The hourly retention job deletes any wallet not seen again within **30 days** (must be active at least once a month to stay in the registry). Per-window trader address lists are stored in Mongo `window_traders` (pruned with ~14-day recording retention) so Heatmap’s wallet list can show per-user **I WON** / **I LOST**. Trader **P/L** is that wallet’s Polymarket all-time profit from `lb-api.polymarket.com/profit` (cached ~6h on the wallet doc). `GET /api/trader-wallets?series=…&sort=sightings|pnl|iWin|iLost&dir=desc|asc&limit=100` returns the ranked top page (default: top 100 by sightings).

**Recording recovery (recorder process):** If Chainlink for an asset goes silent (~20s), RTDS reconnects and the active window for that asset is discarded. Separately, a health watchdog watches for ~**60s** with no book or Chainlink ticks into an active window (after a short grace at window open): it discards that window, force-reconnects Chainlink + CLOB feeds, and restarts the stuck series’ recorder so the next window can start clean.

Wallet credentials in [Settings](doc:settings) unlock Market/Schedule and live signing.
