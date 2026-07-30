# Market

Live trading console for the selected series.

## Trade controls

| Control | Meaning |
|---------|---------|
| **Allow trade** | Off = demo; on = real orders when other gates pass |
| **Manual Override** | Per-series **Buy** and **Sell** dropdowns (`FAK` or `FOK`, default **FOK**). Used when you click the quote Buy/Sell boxes (not phase Auto Trade) |
| **Auto Trade** | Bot may trade using the active setup; label shows **· On** / **· Off** |
| **Size** | Manual / fallback order size |
| **Use Schedule** | With Auto Trade: the UTC schedule cell picks the setup; label shows **· On** / **· Off** |
| **Prediction** | Manipulation / prediction detector. Per-series switch; the label shows **· On** / **· Off**. Detects adverse UP/DOWN Buy quotes vs Gap (does not auto-place or cancel orders). Under Trigger Area, half-width disabled **Buy** / **Sell** quote boxes sit side by side; on trigger they become live **Buy** / **Sell** for that side (same style, live price, hover/press, latch, order path, Size, Manual Override, and armed/demo gates as the quote boxes above the graph). **Settings** (On/Off, Max Quote, Min Quote, Duration, Shift, Profit prediction, Trigger Area) can be changed from any host and sync per series; **triggers and scoring run only on the deployed app** (not localhost), so local + Heroku do not double-count. **Max Quote (¢)**, **Min Quote (¢)**, **Duration (Sec)**, **Shift (¢)**, **Profit prediction (¢)**, and **Trigger Area** stay visible in the same control; they are disabled (muted) when Off. Active window span between the handles is shown in blue |

| Setting | Meaning |
|---------|---------|
| **Max Quote (¢)** | Max price of the cheapening Buy when Duration starts (1–99, default **90**). For Prediction DOWN that is UP Buy; for Prediction UP that is DOWN Buy |
| **Min Quote (¢)** | Min price of that cheapening Buy when Duration starts (1–99, default **70**). Must be ≤ Max Quote |
| **Duration (Sec)** | Seconds the condition must hold (compare now vs that many seconds ago) |
| **Shift (¢)** | Minimum drop of that cheapening Buy over Duration (1–50, default **5**). Example: Max Quote **80**, Shift **5** → must reach **≤ 75¢** |
| **Profit prediction (¢)** | After trigger: predicted-side Buy must rise by at least this many ¢ sometime before window end for **Right** (1–50, default **5**). Window outcome is ignored |
| **Trigger Area** | Dual-handle bar over the market window timeline. Time labels under each handle move with the dots (`0:00` → window length, e.g. `5:00` for a 5m market). Only the span between the handles is watched |
| **Prediction** | Two half-width controls under Trigger Area: disabled **Buy** and **Sell** quote boxes (`—`). On trigger, they become live **Buy** / **Sell** for the predicted side (same quote-box look, live Ask/Bid, hover lift, press, and fill latch as the graph Buy/Sell boxes — Sell stays gated until you hold that side, same as above the graph). After Buy or Sell fills, the button latches like the graph quotes. Survives page refresh until scored. **Right** as soon as the predicted-side Buy rises by **Profit prediction (¢)** from its trigger price; otherwise **Wrong** when the window ends (left shows ✓ / ✕ for **5 seconds**, right returns to disabled Sell; then both reset to disabled Buy / Sell). A new window also resets to disabled Buy / Sell until the next trigger. A previous unscored prediction keeps watching Profit prediction in the background and still updates stats. Each trigger also adds a **Prediction UP/DOWN** card in **Positions** (see below). Click the info icon on the switcher for the Gap vs UP/DOWN Buy trigger rules (including Max Quote / Min Quote / Shift / Profit prediction) |
| **Right / Wrong** | Per-series counts updated when each prediction is scored by Profit prediction (including background parked predictions). **Reset** clears both counts for the selected market |

**Trigger:** while Gap stays the same or stronger in its direction, UP Buy gets cheaper and DOWN Buy gets more expensive (mirror for a negative Gap). **On top of that**, when Duration starts the cheapening Buy must be between **Min Quote (¢)** and **Max Quote (¢)**, and over Duration it must drop by at least **Shift (¢)**. On trigger, the price graph container border turns **green** for Prediction UP or **red** for Prediction DOWN, and stays until the window ends. **Score:** the predicted side’s Buy must rise by at least **Profit prediction (¢)** from its price at trigger, anytime before window end — not whether that side wins the market.

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

- Up/Down quotes; click to place manual orders when trading is armed (order type from Trade → **Manual Override**)
- Live and Demo position cards (buy times in UTC). On held settlements, **Market** / Win / Loss settle on the same official outcome clock as Prediction (completed crypto-price, else explicit Gamma — no extra portfolio wait); Win/Loss is whether your bet side matched that outcome. Portfolio marks may refine P/L dollars after that, never decide the outcome alone
- **Prediction** cards (when the detector triggers): labeled **Prediction UP/DOWN** (not Bet). Shown in **Live** always, and in **Demo** while Prediction is **On**. Rows are Trigger time and Source (**Pending…** / Confirmed) only — no Market or P/L. After Profit prediction scoring (Right on hit, Wrong at window end), status shows a ✓ or ✕ (same icons as the Trigger Area result). Cards persist across refresh. The Trigger Area status UI is unchanged
- Log of bot / order activity

**Header Market P/L** is the sum of settled trade results for the selected series (fees included), including **manual** and auto/schedule trades. Manual wins/losses count here and in **Live**, but not on [Schedule](doc:schedule) cards or the Schedule total. The wallet balance is your current USDC cash — it only matches Market P/L after accounting for deposits/withdrawals, and only once losing tokens are resolved and winning tokens are redeemed into USDC. Polymarket usually auto-redeems wins; worthless losing tokens may still show as “redeemable” dust (~$0). Settled held trades count once the official outcome is known (completed crypto-price, else explicit Gamma).

Fees: when Polymarket’s trade feed includes the USDC notional, the app uses that for an exact fee; otherwise it estimates from the market’s taker fee curve.

Wallet credentials: [Settings & wallet](doc:settings).
