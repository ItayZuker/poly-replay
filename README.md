# Poly Replay

Schedule-driven Polymarket up/down trading with optional market-data recording and Replay backtests.

One codebase, two process roles:

| Role | Env / UI | Purpose |
|------|----------|---------|
| **Live** | `TRADING_EXECUTOR=1` | UI + real/demo trading. Does **not** record (Recording toggle still saves). |
| **Recorder** | executor off; **Recording** on per series (Market → Trade) | Captures ticks/windows; runs Replay; exposes the replay worker. |

## Requirements

- Node.js 20+
- MongoDB (users, setups, schedule, markets, recorded windows)
- Wallet credentials for live trading (optional for recorder-only)

## Setup

```bash
npm install
npm start
```

Open http://localhost:3848 (or `PORT`)

Product docs: http://localhost:3848/docs

## Environment (roles)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3848` | HTTP listen port |
| `DATA_DIR` | `./data` | Recorded ticks/windows |
| `MONGODB_URI` / `MONGODB_DB` | — / `poly_recorder` | Database |
| `TRADING_EXECUTOR` | off | Allow this process to place CLOB orders |
| `SCHEDULE_REPLAY_SERVICE_URL` | empty | Live → recorder `…/api/internal/schedule-replay` |
| `SCHEDULE_REPLAY_WORKER_SECRET` | empty | Optional worker auth (`x-replay-worker-secret`) |
| `CLOB_HOST` | Polymarket | CLOB REST host |
| `CHAIN_ID` | `137` | Polygon |

### Typical local split

**Recorder** (this machine — collect data + Replay):

```env
# TRADING_EXECUTOR unset
# SCHEDULE_REPLAY_SERVICE_URL unset  → Replay runs in-process
```

Then enable **Recording** for each series under Market → Trade.

**Live** (e.g. Heroku — trade; proxy Replay to recorder):

```env
TRADING_EXECUTOR=1
SCHEDULE_REPLAY_SERVICE_URL=http://your-recorder-host:3848/api/internal/schedule-replay
SCHEDULE_REPLAY_WORKER_SECRET=shared-secret
```

## Data layout (recorder)

```
data/
  {series}/
    ticks/{windowStart}/   # clob-raw / clob-book / chainlink jsonl
    windows/{windowStart}.json
```

Only the last ~7 days are kept (so previous weekday hours remain until re-recorded). Older ticks/windows are deleted hourly on the recorder process (no zip archive).
