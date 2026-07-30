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
| **Prediction** | Manipulation / prediction detector. Per-series switch; the label shows **· On** / **· Off**. Detects adverse UP/DOWN Buy quotes vs Gap. Under it, **Trade** · On/Off (active only when **Allow trade** and **Prediction** are both On — turning either Off forces Trade Off and disables it). Under Trigger Area, half-width **Buy** / **Sell** quote boxes show the simulated or live fill look (see below). **Settings** sync per series; **triggers and scoring run only on the deployed app** (not localhost). Settings stay visible when Prediction is On (disabled/muted when Off). |

| Setting | Meaning |
|---------|---------|
| **Trade** | When **On** (requires Allow trade + Prediction On): detector places a real Buy on trigger and a real Sell when Profit hits, using Prediction **Shares** and Prediction Buy/Sell **FAK/FOK**. **Race with phase Auto Trade** (same as Replay): from the start of the window either side may buy first; while one position is open the other cannot buy; after that position sells both may race again. When **Off**: same UI/scoring as sim (no orders). Replay has no Trade switch — Prediction On implies sim trades there |
| **Order type** | Prediction Trade **Buy** / **Sell** `FAK` or `FOK` (default **FOK**). Separate from Manual Override |
| **Shares** | Share count for Prediction Trade buys (1–100000, default **10**). Sells use held shares |
| **Max Quote (¢)** | Max price of the cheapening Buy when Duration starts (1–99, default **90**). For Prediction DOWN that is UP Buy; for Prediction UP that is DOWN Buy |
| **Min Quote (¢)** | Min price of that cheapening Buy when Duration starts (1–99, default **70**). Must be ≤ Max Quote |
| **Duration (Sec)** | Seconds the condition must hold (compare now vs that many seconds ago) |
| **Shift (¢)** | Minimum drop of that cheapening Buy over Duration (1–50, default **5**). Example: Max Quote **80**, Shift **5** → must reach **≤ 75¢** |
| **Profit prediction (¢)** | After trigger: predicted-side **Sell** (Bid) must reach the locked trigger **Buy** + this many ¢ sometime before window end for **Right** (1–50, default **5**). Window outcome is ignored |
| **Trigger Area** | Dual-handle bar over the market window timeline. Time labels under each handle move with the dots (`0:00` → window length, e.g. `5:00` for a 5m market). Only the span between the handles is watched |
| **Prediction** | Two half-width controls under Trigger Area: disabled **Buy** and **Sell** quote boxes (`—`). On trigger: **Buy** locks at the trigger Buy (latched fill look — colored background, locked price + live Ask beside it) and stays **disabled**; **Sell** is the only active control with a live Bid. With **Trade Off** this is visual/sim only; with **Trade On** the same moment places the real Buy, and Sell at Profit places the real Sell. **Right** when Sell reaches locked Buy + **Profit prediction (¢)** — Sell latches with a ✓ next to the price briefly, then both reset. **Wrong** at window end shows an ✕ on Sell for the same brief time, then both reset. After a **Right**, if time remains in **Trigger Area**, the detector can fire again. Each trigger also adds a **Prediction UP/DOWN** card in **Positions**. Click the info icon for Gap vs UP/DOWN Buy trigger rules |
| **Right / Wrong** | Per-series counts updated when each prediction is scored by Profit prediction (including re-triggers after Right and background parked predictions). **Reset** clears both counts for the selected market |

**Trigger:** while Gap stays the same or stronger in its direction, UP Buy gets cheaper and DOWN Buy gets more expensive (mirror for a negative Gap). **On top of that**, when Duration starts the cheapening Buy must be between **Min Quote (¢)** and **Max Quote (¢)**, and over Duration it must drop by at least **Shift (¢)**. On trigger, the price graph container border turns **green** for Prediction UP or **red** for Prediction DOWN, and stays until the window ends. **Score:** buy at the trigger Buy, then Sell (Bid) must reach that price + **Profit prediction (¢)** anytime before window end — not whether that side wins the market.

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
- **Prediction** cards (when the detector triggers): labeled **Prediction UP/DOWN** (not Bet). Shown in **Live** always, and in **Demo** while Prediction is **On**. Rows are Trigger time and Source (**Pending…** / Confirmed) only — no Market or P/L. After Profit prediction scoring (Right when Sell hits target, Wrong at window end), status shows a ✓ or ✕; when **Trade** was **Off** for that trigger, **Sim** appears to the left of the icon. Cards persist across refresh. Trigger Area Sell briefly shows the same ✓ / ✕ next to its price before resetting
- Log of bot / order activity (manual quote clicks log submit / placed / ignored / failed)

**Header Market P/L** is the sum of settled trade results for the selected series (fees included), including **manual** and auto/schedule trades. Manual wins/losses count here and in **Live**, but not on [Schedule](doc:schedule) cards or the Schedule total. The wallet balance is your current USDC cash — it only matches Market P/L after accounting for deposits/withdrawals, and only once losing tokens are resolved and winning tokens are redeemed into USDC. Polymarket usually auto-redeems wins; worthless losing tokens may still show as “redeemable” dust (~$0). Settled held trades count once the official outcome is known (completed crypto-price, else explicit Gamma).

Fees: when Polymarket’s trade feed includes the USDC notional, the app uses that for an exact fee; otherwise it estimates from the market’s taker fee curve.

Wallet credentials: [Settings & wallet](doc:settings).
