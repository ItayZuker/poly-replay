# Market

Live trading console for the selected series.

## Trade controls

| Control | Meaning |
|---------|---------|
| **Allow trade** | Off = demo; on = real orders when other gates pass |
| **Auto Trade** | Bot may trade using the active setup; label shows **· On** / **· Off** |
| **Use Schedule** | With Auto Trade: the UTC schedule cell picks the setup; label shows **· On** / **· Off** |
| **Size** | Manual / fallback order size |
| **Manipulation Detector** | Per-series switch; the label shows **· On** / **· Off**. Detects adverse UP/DOWN Buy quotes vs Gap (visual flag only — does not place or cancel orders). **Duration (Sec)** and **Window area** stay visible in the same control; they are disabled (muted) when Off |

| Setting | Meaning |
|---------|---------|
| **Duration (Sec)** | Seconds the condition must hold (compare now vs that many seconds ago) |
| **Window area** | Dual-handle bar over the market window timeline (`0:00` → window length, e.g. `5:00` for a 5m market). Only the span between the handles is watched |

**Trigger:** while Gap stays the same or stronger in its direction, UP Buy gets cheaper and DOWN Buy gets more expensive (mirror for a negative Gap). On trigger, the price graph container border turns **blue** for up to **10 seconds**, or until the window ends — whichever is sooner.

Feed **Latency** is shown in the Settings page header. **Fill success** lives under Settings → **Stats**. See [Settings & wallet](doc:settings).

**Available markets**, **Recording**, and per-series **retention** are managed in the separate **Admin CRM** (not in this trader UI). Only available series appear in the market picker; trading APIs reject unavailable series. Recording still runs only on non-`TRADING_EXECUTOR` processes. On the recorder, stalled Chainlink (~20s) discards the active window and reconnects; a broader silence watchdog (~60s with no book/Chainlink ticks) reconnects feeds and restarts that series’ recorder. See [Information flow](doc:data-flow).

Scheduled live: **Allow trade** + **Auto Trade** + **Use Schedule** on.

Edit phases on the chart: **Auto Trade** on, **Use Schedule** off.

## Chart and phases

Shows PTB, price, gap, and **3 phases** for the active setup. Click a phase band to edit when editable.

| Mode | Source of phases | Editable on chart? |
|------|------------------|--------------------|
| Auto Trade on, Use Schedule off | Graph setup | Yes |
| Use Schedule on | Schedule setup for current UTC slot | No — edit on [Schedule](doc:schedule) |

Field reference: [Setups & phases](doc:setups-phases).

## Quotes, positions, log

- Up/Down quotes; click to place manual orders when trading is armed
- Live and Demo position cards (buy times in UTC)
- Log of bot / order activity

**Header Market P/L** is the sum of settled trade results for the selected series (fees included). The wallet balance is your current USDC cash — it only matches Market P/L after accounting for deposits/withdrawals, and only once losing tokens are resolved and winning tokens are redeemed into USDC. Polymarket usually auto-redeems wins; worthless losing tokens may still show as “redeemable” dust (~$0).

Fees: when Polymarket’s trade feed includes the USDC notional, the app uses that for an exact fee; otherwise it estimates from the market’s taker fee curve.

Wallet credentials: [Settings & wallet](doc:settings).
