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
| **Prediction** | Manipulation / prediction detector. Per-series switch; the label shows **· On** / **· Off**. Detects adverse UP/DOWN Buy quotes vs Gap (visual flag only — does not place or cancel orders). **Settings** (On/Off, Max Quote, Min Quote, Shift, Duration, Trigger Area) can be changed from any host and sync per series; **triggers and scoring run only on the deployed app** (not localhost), so local + Heroku do not double-count. **Max Quote (¢)**, **Min Quote (¢)**, **Shift (¢)**, **Duration (Sec)**, and **Trigger Area** stay visible in the same control; they are disabled (muted) when Off. Active window span between the handles is shown in blue |

| Setting | Meaning |
|---------|---------|
| **Max Quote (¢)** | Max price of the cheapening Buy when Duration starts (1–99, default **90**). For Prediction DOWN that is UP Buy; for Prediction UP that is DOWN Buy |
| **Min Quote (¢)** | Min price of that cheapening Buy when Duration starts (1–99, default **70**). Must be ≤ Max Quote |
| **Shift (¢)** | Minimum drop of that cheapening Buy over Duration (1–50, default **5**). Example: Max Quote **80**, Shift **5** → must reach **≤ 75¢** |
| **Duration (Sec)** | Seconds the condition must hold (compare now vs that many seconds ago) |
| **Trigger Area** | Dual-handle bar over the market window timeline. Time labels under each handle move with the dots (`0:00` → window length, e.g. `5:00` for a 5m market). Only the span between the handles is watched |
| **Prediction** | Full-width status under Trigger Area: **Waiting…** (animated dots) → **Prediction UP/DOWN** on trigger (same green/red fill as triggered Buy quote boxes; survives page refresh until scored). Window end → **Pending**, then only a ✓ / ✕ for **5 seconds** after Gamma marks the market **explicitly resolved** (`umaResolutionStatus` resolved / closed + auto-resolved, with settled ~1/~0 Up/Down prices). Correctness over speed — not mid-book prices, not Chainlink final vs PTB alone, and not the next window’s price. A new trigger in a later window takes over the status UI; the previous Pending keeps resolving in the background and still updates stats. Each trigger also adds a **Prediction UP/DOWN** card in **Positions** (see below). Click the info icon on the switcher for the Gap vs UP/DOWN Buy trigger rules (including Max Quote / Min Quote / Shift) |
| **Right / Wrong** | Per-series counts updated when each official outcome arrives (including background Pending predictions). **Reset** clears both counts for the selected market |

**Trigger:** while Gap stays the same or stronger in its direction, UP Buy gets cheaper and DOWN Buy gets more expensive (mirror for a negative Gap). **On top of that**, when Duration starts the cheapening Buy must be between **Min Quote (¢)** and **Max Quote (¢)**, and over Duration it must drop by at least **Shift (¢)**. On trigger, the price graph container border turns **green** for Prediction UP or **red** for Prediction DOWN, and stays until the window ends.

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
- Live and Demo position cards (buy times in UTC). On held settlements, **Market** / Win / Loss wait for the same explicit Gamma resolution as Prediction (Pending longer is OK); Win/Loss is whether your bet side matched that outcome. Portfolio marks may fill P/L dollars after that, never decide the outcome alone
- **Prediction** cards (when the detector triggers): labeled **Prediction UP/DOWN** (not Bet). Shown in **Live** always, and in **Demo** while Prediction is **On**. Same pending skeleton as trade cards (empty Market / P/L, **Pending…**); after the official outcome, status becomes **Prediction was right** or **Prediction was wrong**. Cards persist across refresh. The Trigger Area status UI is unchanged
- Log of bot / order activity

**Header Market P/L** is the sum of settled trade results for the selected series (fees included), including **manual** and auto/schedule trades. Manual wins/losses count here and in **Live**, but not on [Schedule](doc:schedule) cards or the Schedule total. The wallet balance is your current USDC cash — it only matches Market P/L after accounting for deposits/withdrawals, and only once losing tokens are resolved and winning tokens are redeemed into USDC. Polymarket usually auto-redeems wins; worthless losing tokens may still show as “redeemable” dust (~$0). Settled held trades count once Gamma marks the market explicitly resolved.

Fees: when Polymarket’s trade feed includes the USDC notional, the app uses that for an exact fee; otherwise it estimates from the market’s taker fee curve.

Wallet credentials: [Settings & wallet](doc:settings).
