# Information flow

**REST** for actions and saves. **SSE** for live updates. The browser does **not** open a WebSocket — the **server** connects to Polymarket and Chainlink.

## Channels

| Channel | Direction | For |
|---------|-----------|-----|
| **REST** `/api/...` | Browser → server | Login, settings, toggles, setups, schedule, manual orders |
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

Auto-trade runs on the **server** each tick. The browser only sets toggles and can send **manual** orders.

| Control | Effect |
|---------|--------|
| **Auto Trade** | Server may trade on each tick with the active setup |
| **Use Schedule** | Setup from current UTC cell — [Schedule](doc:schedule) |
| **Allow trade** | Off = demo; on = real orders when the server can execute |

Without schedule, phases come from the graph setup — [Setups & phases](doc:setups-phases).

## Setups and schedule

Saved over REST to the database (`trading_setups_real` / `schedual_setups_real` for **Live**; `trading_setups_replay` / `schedual_setups_replay` for **Replay**). The server picks the active **Live** UTC placement each tick. SSE keeps the schedule board updated.

**Replay** runs via REST `POST /api/schedule-replay` (SSE response: `progress` / `placement` / `done` / `failure`). Body includes `latencyMs` and `fillSuccessPct` (0–100); the worker applies them in `SimulatorEngine` (latency delay, then a random roll per would-be fill). While each card finishes, the worker keeps that card’s window list + fill markers in memory. Card **Open** posts `POST /api/schedule-placements/:id/play` and returns that cached payload when present (same hits as the card); otherwise it re-simulates. When `SCHEDULE_REPLAY_SERVICE_URL` is set, that call is proxied to the recorder’s `/api/internal/schedule-placements/:id/play`.

Live **Fill success** (Market → Trade) tracks CLOB buy/sell outcomes over the rolling 7-day cutoff, broken down by **FAK / FOK / GTD**. Partial match = success. FAK/FOK count on fire/send; GTD counts only after the resting limit is touched while live (then success if any size matched, else miss). Strategy cancels with no touch stay out of the %.

```flow
# Replay roles
Browser -> POST /api/schedule-replay -> Live server
Live server -> POST SCHEDULE_REPLAY_SERVICE_URL -> Recorder worker
Recorder worker -> SimulatorEngine over DATA_DIR ticks -> SSE stats
```

| Control / env | Role |
|---------------|------|
| **Recording** (Market → Trade) | Per-series flag in Mongo — `PATCH /api/markets/:series` |
| `TRADING_EXECUTOR=1` | Live — may place CLOB orders; never runs recorders (toggle still persists) |
| Non-executor process | Starts/stops `MarketRecorder` for each series with Recording on; writes `DATA_DIR` + Mongo heatmap summaries |
| `SCHEDULE_REPLAY_SERVICE_URL` | Live → full URL of recorder `/api/internal/schedule-replay`. Empty = run backtest in-process |
| `SCHEDULE_REPLAY_WORKER_SECRET` | Optional shared secret for the worker endpoint |
| `DATA_DIR` | Local tick/window files (default `./data`) |

Heatmap and Replay load ~**14 days** of `recorded_windows`, then for each UTC weekday×hour keep only the **latest** calendar day in that slot (so a new Monday hour replaces last Monday’s same hour without clearing the rest of the column). Tick/window files older than ~14 days are deleted on the recorder. Windows with a flat asset price for the whole recording are treated as bad data: deleted from Mongo + local files and omitted from heatmap/Replay.

**Trader wallets** (Mongo `trader_wallets`, used for heatmap Wallets / New wallets): each completed window refreshes `lastSeenAt`. The hourly retention job deletes any wallet not seen again within **30 days** (must be active at least once a month to stay in the registry).

**Recording recovery (recorder process):** If Chainlink for an asset goes silent (~20s), RTDS reconnects and the active window for that asset is discarded. Separately, a health watchdog watches for ~**60s** with no book or Chainlink ticks into an active window (after a short grace at window open): it discards that window, force-reconnects Chainlink + CLOB feeds, and restarts the stuck series’ recorder so the next window can start clean.

Wallet credentials in [Settings](doc:settings) unlock Market/Schedule and live signing.
