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

**Replay** runs via REST `POST /api/schedule-replay` (SSE response: `progress` / `placement` / `done` / `failure`).

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

Wallet credentials in [Settings](doc:settings) unlock Market/Schedule and live signing.
