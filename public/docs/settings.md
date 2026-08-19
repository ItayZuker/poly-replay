# Account

## Account tabs

**User**, **Settings**, **Stats**, and **Credentials** share one Account card (tab switcher).

### User

Display name and email for your account. Also log out, or permanently delete your account.

### Settings

Three sections, top to bottom: **Global**, **Market**, **Replay**.

**Global** — **Allow trade** (**Off** / **On**): Off = demo; On = real orders when other gates pass — turning **Off** also moves every Trigger card that was on **Trade** back to **Demo**.

**Market** — **Current price** is one account-wide dropdown. The same choice applies to every series (BTC/ETH/SOL, 5 Min and 15 Min) for **Current**, **Gap**, live **triggers** (Trade and Demo), and the replay price line:

| Choice | Meaning |
|--------|---------|
| **Raw Chainlink** (default) | Last Chainlink RTDS tick (`btc/usd` / `eth/usd` / `sol/usd`), rounded to 2 decimals |
| **30s Avg** | Official 30-second Chainlink TWAP on every market |
| **60s Avg** | Official 60-second Chainlink TWAP on every market |

Recordings always store the **raw** socket tick. If 30s or 60s Avg is selected, replay rebuilds that averaged line (and trigger Gap / $ change) from those raw ticks.

**PTB** is unchanged (first in-window Chainlink, then REST `openPrice`).

**Replay** — **Latency (ms)** and **Fill Success (%)** are Replay Run inputs (not live feed latency or Stats fill success):

| Field | Meaning |
|-------|---------|
| **Latency (ms)** | Simulated delay for FAK fills and before GTD limits become live. Default **20**. Frozen for the duration of a Replay **Run**. |
| **Fill Success (%)** | Chance each would-be fill succeeds after latency (random per attempt). Default **90**. **100%** = always fill when the book allows; **0%** = never. Frozen for the duration of a Replay **Run**. |

Live feed **Latency (ms)** is shown in the Account page header (not an input).

### Stats

| Metric | Meaning |
|--------|---------|
| **Fill success** | Rolling last **7 days** (independent of the ~7-day weekday×hour recording overlay). Shows a **total %** plus **FAK / FOK / GTD** rows (`successes/attempts · %`). **Partial fill = success**. **FAK/FOK:** count when the order is fired/sent. **GTD:** count only when the limit was **touched** while live (ask/bid/trade at the limit) — strategy cancels with no touch are ignored (neither success nor miss). **—** until the first countable attempt |

Feed **Latency (ms)** is shown in the Account page header (not in this tab).

### Credentials

Both are required to unlock Market, Schedule, and Replay:

| Field | Meaning |
|-------|---------|
| **Funder address** | Polymarket proxy / profile wallet that holds USDC |
| **Private key** | EOA signer for CLOB orders (encrypted; not shown again after save) |

In-app info next to each field shows where to find values on Polymarket.

## Wallet gate

If either credential is missing, Market, Schedule, and Replay stay locked until both are saved.

## Safety

- Never share your private key
- Start with **Allow trade** off (demo) under **Settings** → **Global** after saving credentials
- Confirm the funder matches the wallet you fund with USDC

## Process roles (server env)

These are set on the **server**, not in this UI:

| Variable | Meaning |
|----------|---------|
| `TRADING_EXECUTOR` | This process may place real CLOB orders (and will not record) |
| `SCHEDULE_REPLAY_SERVICE_URL` | On a live process: URL of the recorder’s replay worker (also used to proxy Open Replay `/api/ticks`) |
| `SCHEDULE_REPLAY_WORKER_SECRET` | Optional shared secret between live and recorder |

Per-series **Available**, **Recording**, and **retention days** are Admin CRM controls (not env vars and not trader Market toggles). See [Market](doc:market) and [Information flow](doc:data-flow).
