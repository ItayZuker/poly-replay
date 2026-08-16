# Information flow

**REST** for actions and saves. **SSE** for live updates. The browser does **not** open a WebSocket — the **server** connects to Polymarket and Chainlink.

## Channels

| Channel | Direction | For |
|---------|-----------|-----|
| **REST** `/api/...` | Browser → server | Login, settings, toggles, triggers, schedule hour stats, Trigger/Prediction orders |
| **SSE** `/api/stream` | Server → browser | Quotes, chainlink ticks, trading (positions/markers + `statsRevision`), window (sparse), log, schedule (live stats + Replay slot counts are REST + browser cache) |
| **WebSocket** | Server ↔ exchanges | CLOB book + Chainlink (server only) |

```flow
# Browser ↔ Poly Replay
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
| Quotes (best bid/ask + size) | Polymarket CLOB (server WS); SSE `quotes` every book change |
| Chart points | Chainlink WS → SSE `chainlink-tick` (client appends); full `priceHistory` only on SSE connect / window roll / series change |
| Window / tokens | Polymarket REST; full SSE `window` (history + trading) on connect, market-window roll, and rare REST-driven pushes — not every tick |
| Positions (open / pending) / markers / phases | SSE `trading` (~250ms coalesce) — settled Positions via REST + browser cache |
| Settled Positions (last 24h) | `GET /api/trading/positions` → browser `localStorage`; refresh on `statsRevision` |
| PTB | Live Market: first in-window Chainlink tick — label **PTB (Chainlink)** — then Polymarket crypto-price `openPrice` — **PTB (REST)** (follow updates until they freeze it; never prior-window; never Gamma). Recordings append Chainlink → REST changes to `ptbHistory` and store Gamma `eventMetadata.priceToBeat` separately (`gammaPtb`). Open Replay scrubs that history, then Gamma on the last tick (**PTB (GAMMA)**) |
| Asset price / Current | Live Market: Chainlink RTDS (`btc/usd` / `eth/usd` / `sol/usd`), rounded like Polymarket’s page (2 decimals for BTC ≥ 1000) — not replaced by Gamma. Open Replay last tick: Gamma `eventMetadata.finalPrice` |
| Gap / crossings | Server: Current − PTB — **no gap** (and gap-based triggers do not fire) until the first in-window Chainlink PTB is present |

## Trading

**Trigger Trade** is the only live order path (server-side). Manual quote orders and Prediction Trade are disabled. Graph quote boxes are display-only. The browser sets **Allow trade** and trigger definitions (**Demo** / **Trade**).

| Control | Effect |
|---------|--------|
| **Allow trade** | Off = demo; on = real orders when the server can execute |
| **Trigger Trade** | Server may place Trigger orders on each tick — [Market](doc:market) |

Trigger FAK/FOK buys send `minPrice` / `maxPrice` for the user’s Ask band and size by **Start Shares** (limit at live Ask inside the band). A fill outside that band (or oversized) still opens the position and follows Sell/hold; the Positions card is flagged `triggerMiss` (**Trigger Miss** label). `POST /api/trading/order` may return `triggerMiss: true`.

Phase Auto Trade / Use Schedule are removed.

## Triggers and schedule

Market Triggers are saved over REST (`triggers` collection), scoped **per user × series**. Demo/Trade changes append to `trigger_mode_timeline` (historical Pause rows stay so past Schedule attribution is not rewritten). `GET /api/triggers/:id/stats` returns Trade totals plus `activeMs` (sum of Trade intervals) and `demoActiveMs` (sum of Demo intervals) from that timeline. On `TRADING_EXECUTOR`, **Demo** triggers are evaluated server-side against live books (feedLatencyMs delays FAK/FOK only; Buy/Sell GTD ignore feed latency); Demo Positions cards and `demoStats` are written on the server (browser reflects SSE only — no client Demo scorer). **Trade Buy GTD** rests are placed and polled on that host (RAM). After a dyno restart the executor reattaches live CLOB buys via `getOpenOrders` (no extra Mongo collection) so fills still become Positions / Trade stats. Trade cards race one open position at a time (first fill until sell or window end). Held Open Positions settle Win/Loss from Gamma only (hard poll ~20m after window end, then light retries; no token-mark fallback); recordings use the same Gamma \windowOutcome\. Positions UI cards live in Mongo `position_cards` (per user × series; Open + last 24h settled). The Live dyno keeps only **open / pending-confirm** cards in RAM for trading + SSE; settled gallery is `GET /api/trading/positions` + browser cache (refreshed on `statsRevision`). Demo Positions are removed when their Market Trigger is deleted. Localhost (non-executor) reloads open Positions + trigger BUY/SELL `liveUi` from Mongo on page load / SSE reconnect (refresh) — not on a polling timer. Durable Real trade rows live in Mongo `trading_stat_events` (not removed by Positions Clear). The Live dyno does **not** keep the full ledger in RAM: boot loads hot Positions + activation only; Schedule/Live aggregates query Mongo on demand (`GET /api/schedule-hour-stats`, `GET /api/schedule-placement-stats`, `GET /api/trading/session-memory?mode=live`). The browser caches hour-slot stats (and refreshes when SSE `trading.statsRevision` changes). Each weekday×hour shows the **last occurrence** of that slot (~**1 week**): this week once the hour arrives, otherwise the same weekday last week — including all-zero days (gray `$0`); empty last occurrences are not skipped for an older week with fills.

**Replay** idle cells load usable recorded-window counts via `GET /api/schedule-replay-slot-counts` (gray = count of windows with **CLOB book + Chainlink tick files + official Gamma** `windowOutcome`; slots with zero show **No Recordings**). On Live with `SCHEDULE_REPLAY_SERVICE_URL`, the tick-file check is proxied to the recorder (`POST /api/internal/ticks/presence` with `requireBook: true`); Gamma presence comes from Mongo/`recorded_windows`. **Run** uses REST `POST /api/schedule-replay` (SSE: `progress` / `placement` / `done` / `failure`) over synthetic 1-hour slots with Replay Triggers only — gray then becomes no-trigger windows. Finished hour-cell stats are stored in browser `localStorage` (per user + series) so a page refresh keeps them; the next **Run** clears that snapshot first. Body includes `latencyMs`, `fillSuccessPct`, and `triggers`. When `SCHEDULE_REPLAY_SERVICE_URL` is set, the run is proxied to the recorder. **Open Replay** uses `POST /api/schedule-placements/:id/play` with synthetic ids (`hour:mon:14`). Idle Replay board sends `recordingsOnly: true` (clean windows, no buy/sell markers). After a **Run**, Replay mode sends `triggers` / latency / fill success (last Run cache or re-sim; may proxy to the recorder). Live mode sends `live: true` and builds windows + **real ledger markers** from Mongo `trading_stat_events` (queried on demand, not held in dyno RAM). When `SCHEDULE_REPLAY_SERVICE_URL` is set, Live Open Replay asks the recorder which windows still have Chainlink tick files (`POST /api/internal/ticks/presence`) so trading hosts without a local `DATA_DIR` do not show an empty list. **Replay** Open Replay / **Run** and **Live** Open Replay omit windows missing CLOB book, Chainlink ticks (Replay), or **official Gamma** outcome. Live still only needs Chainlink for the price path once Gamma is present. Open Replay ticks use `GET /api/ticks` (proxied to the recorder when configured). The recorder creates a window stub at open with PTB unset, follows published crypto-price `openPrice` (and updates Mongo when that published open changes), finalizes without stalling, then background-polls Gamma for up to **20 minutes** after `windowEnd` before leaving `windowOutcome` unset — Gamma sets recorded PTB / Current from `priceToBeat` / `finalPrice`.

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
| Non-executor process | Starts/stops `MarketRecorder` for each series with Recording on; writes `DATA_DIR` + Mongo `recorded_windows` summaries |
| `SCHEDULE_REPLAY_SERVICE_URL` | Live → full URL of recorder `/api/internal/schedule-replay`. Empty = run backtest in-process. Same origin is used to proxy Open Replay ticks (`/api/internal/ticks`), tick presence (`/api/internal/ticks/presence`), and Replay play payloads |
| `SCHEDULE_REPLAY_WORKER_SECRET` | Optional shared secret for the worker endpoint |
| `DATA_DIR` | Local tick/window files (default `./data`) |

Replay uses recent `recorded_windows` in Mongo (default ~**7 days**, overridable per series via Admin CRM retention), then for each UTC weekday×hour keep only the **latest** calendar day in that slot (so a new Monday hour replaces last Monday’s same hour without clearing the rest of the column). Idle Replay gray counts come from `GET /api/schedule-replay-slot-counts` (usable windows with CLOB book + Chainlink ticks + official Gamma). Tick/window files older than that retention are deleted on the recorder. Windows with a flat asset price for the whole recording are treated as bad data: deleted from Mongo + local files and omitted from Replay.

**CLOB book capture (recorder process):** At each window open the recorder **REST-seeds** the YES/NO order books (and again ~30s before rollover for the next window), then writes an opening `clob-book` tick stamped at `windowStart` so Replay sees early Asks (including cheap ~1¢ sides) that Live Demo can fill on. Each snapshot stores the **top 5** bid and ask levels per side. While the window is open it keeps sampling books on the recorder poll (~500ms) whenever the book changes, plus every WebSocket update; at finalize it forces a last in-window book tick. Identical consecutive books are not rewritten. Chainlink ticks are unchanged.

**Recording recovery (recorder process):** If Chainlink for an asset goes silent (~20s), RTDS reconnects and the active window for that asset is discarded. A health watchdog also covers two silence cases (after a short grace at window open): ~**60s** with **no book and no Chainlink** ticks discards that window, force-reconnects Chainlink + CLOB, and restarts the stuck series’ recorder; ~**20s** with **no CLOB book ticks** while Chainlink is still flowing force-reconnects only the market WebSocket and re-subscribes tokens (keeps the window so Chainlink capture continues). Window rollover (official close wait + save) always clears the in-progress finalize lock so a failed save cannot stall Recording forever.

Wallet credentials in [Settings](doc:settings) unlock Market, Schedule, and Replay, and live signing.
