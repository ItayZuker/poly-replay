# Settings & wallet

## Account tabs

**User**, **Stats**, and **Credentials** share one Settings card (tab switcher).

### User

Display name and email for your account. **Allow trade** (**Off** / **On**): Off = demo; On = real orders when other gates pass — turning **Off** also moves every Trigger card that was on **Trade** back to **Demo**. Also log out, or permanently delete your account.

### Stats

| Metric | Meaning |
|--------|---------|
| **Fill success** | Rolling last **7 days** (independent of the ~14-day weekday×hour recording overlay). Shows a **total %** plus **FAK / FOK / GTD** rows (`successes/attempts · %`). **Partial fill = success**. **FAK/FOK:** count when the order is fired/sent. **GTD:** count only when the limit was **touched** while live (ask/bid/trade at the limit) — strategy cancels with no touch are ignored (neither success nor miss). **—** until the first countable attempt |

Feed **Latency (ms)** is shown in the Settings page header (not in this tab).

### Credentials

Both are required to unlock Market and Schedule:

| Field | Meaning |
|-------|---------|
| **Funder address** | Polymarket proxy / profile wallet that holds USDC |
| **Private key** | EOA signer for CLOB orders (encrypted; not shown again after save) |

In-app info next to each field shows where to find values on Polymarket.

## Wallet gate

If either credential is missing, Market and Schedule stay locked until both are saved.

## Safety

- Never share your private key
- Start with **Allow trade** off (demo) under **User** after saving credentials
- Confirm the funder matches the wallet you fund with USDC

## Process roles (server env)

These are set on the **server**, not in this UI:

| Variable | Meaning |
|----------|---------|
| `TRADING_EXECUTOR` | This process may place real CLOB orders (and will not record) |
| `SCHEDULE_REPLAY_SERVICE_URL` | On a live process: URL of the recorder’s replay worker (also used to proxy Open Replay `/api/ticks`) |
| `SCHEDULE_REPLAY_WORKER_SECRET` | Optional shared secret between live and recorder |

Per-series **Available**, **Recording**, and **retention days** are Admin CRM controls (not env vars and not trader Market toggles). See [Market](doc:market) and [Information flow](doc:data-flow).
