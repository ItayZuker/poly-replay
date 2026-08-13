# Getting started

## 1. Account

**Sign up** with email and password. Wallet is not required yet.

## 2. Credentials

In **Settings → Credentials**, save both:

1. **Funder address** — Polymarket proxy / profile wallet (holds USDC)
2. **Private key** — EOA signer (encrypted; not shown again after save)

Market, Schedule, and Replay stay locked until both are saved. Details: [Settings & wallet](doc:settings).

## 3. Market

Pick a series in the header (e.g. BTC/ETH 5m or 15m).

## 4. Preview

Keep **Allow trade** off under Settings → **User**. Create a **Trigger**, leave it on **Demo** + **Active**, and watch the log / Demo stats. More: [Market](doc:market).

## 5. Schedule and Replay

Open **Schedule** — every UTC hour cell shows Trigger Trade stats for the latest day of that weekday×hour (other days stay until that slot plays again). The left column lists your Market Triggers. Details: [Schedule](doc:schedule).

Open **Replay** to add local Replay Triggers, set Latency / Fill Success, and press **Run** to test over recordings.

## 6. Go live

1. Confirm credentials and balance
2. Turn **Allow trade** on (Settings → **User**)
3. Set the trigger to **Trade** + **Active**
4. Start small; watch the log, positions, and Schedule hour cells
