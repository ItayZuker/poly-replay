# Market

Live trading console for the selected series.

## Trade controls

| Control | Meaning |
|---------|---------|
| **Allow trade** | Off = demo; on = real orders when other gates pass |
| **Auto Trade** | Bot may trade using the active setup |
| **Use Schedule** | With Auto Trade: the UTC schedule cell picks the setup |
| **Size** | Manual / fallback order size |
| **Recording** | Per-series: capture ticks/windows for Replay and Heatmap |

Below **Recording**, Trade also shows live execution metrics (each on its own row):

| Metric | Meaning |
|--------|---------|
| **Latency** | Same feed latency as the Settings header (ms) |
| **Fill success** | Rolling last **7 days** (independent of the ~14-day weekday×hour recording overlay). Shows a **total %** plus **FAK / FOK / GTD** rows (`successes/attempts · %`). **Partial fill = success**. **FAK/FOK:** count when the order is fired/sent. **GTD:** count only when the limit was **touched** while live (ask/bid/trade at the limit) — strategy cancels with no touch are ignored (neither success nor miss). **—** until the first countable attempt |

**Recording** is stored per market (e.g. `btc-5m` on, `eth-5m` off). A process with `TRADING_EXECUTOR` on saves the toggle but does not capture data — run a non-executor instance (or leave executor off locally) to actually record. See [Information flow](doc:data-flow).

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
