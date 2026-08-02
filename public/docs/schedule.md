# Schedule & Heatmap

Toggle **Schedule** and **Heatmap** on this page. At the bottom of the left column, switch **Live** vs **Replay** workspace.

Trading on this product is **Trigger-only**. Phase setups, placement cards, **Auto Trade**, and **Use Schedule** are removed. The week grid always shows every UTC hour cell with Trigger stats.

## Left column

| | **Live** | **Replay** |
|---|----------|------------|
| Purpose | Real Trigger Trade schedule | What-if board over recent history |
| List | **Trade + Active** Market Triggers only (full height; Edit opens Market) | Local **Replay Triggers** + **Add Trigger** |
| Stats on cards | All-time Trade (or Demo) on each trigger card | From last **Run** |

## Schedule grid

- Days × UTC hours — **all 7×24 cells always show** a stats line (green / red / blue dots) and **P/L** (`0` / `+$0.00` when empty)
- Each cell aggregates outcomes for that UTC weekday×hour in the **current ISO week** (Live):
  - **Trigger Trade** when the trigger was **Trade + Active** at the window time (full Active/Paused + Demo/Trade **timeline**). Fills from before the first timeline row still count when that trigger has only ever been recorded as Trade+Active (late timeline seed). Legacy fills with a trigger id and no timeline rows also count. Settled fills with `source: trigger` but a missing trigger id still count on the hour grid
  - **Legacy phase / schedule-placement** fills still in this week’s ledger (from before Trigger-only Schedule). They stay on the board for the rest of the ISO week and clear only when that weekday×hour is in the **next** ISO week
- Each **day column header** shows the day title and, underneath, that day’s aggregated hour-cell stats (same dots + P/L; gray in Replay). There is no per-day Clear control
- Current UTC cell is highlighted
- Header range (**Market** / **Live** / **Schedule**): **Market** = all-time confirmed totals for the series; **Live** = since last header reset; **Schedule** = sum of all hour cells. **Manual** quote-box buys count in Market/Live only — not on Schedule hour cells

Replay placements never send live orders. Live Trigger Trade requires **Allow trade** on Market and a trigger on **Trade** + **Active**.

## Live vs Replay

| | **Live** | **Replay** |
|---|----------|------------|
| Purpose | Real schedule for Trigger Trade | Test Replay Triggers on recordings |
| Triggers | Market Triggers (Mongo) | Browser-local Replay Triggers |
| Hour cells | Live Trigger Trade (timeline-gated) | Filled when you press **Run** |
| Header total | Same summary chrome | Totals update as replay results arrive |

In **Live**, the left column lists **Trade + Active** Market Triggers only (no Demo/Pause badges). In **Replay**, that list hides and the Replay panel expands — order top→bottom: **Run**, then **Latency** / **Fill Success** / **Triggers**, then the Live/Replay switcher. A blue border frames the whole screen in Replay.

| Control | Meaning |
|---------|---------|
| **Latency (ms)** | Simulated delay for FAK fills and before GTD limits become live. Prefills from live feed latency (Market → Trade / Settings). Frozen for the duration of a **Run**. |
| **Fill Success (%)** | Chance each would-be fill succeeds after latency (random per attempt). **100%** = always fill when the book allows; **0%** = never. Prefills from live **Fill success** total % (last 7 days). Frozen for the duration of a **Run**. |
| **Triggers** | Replay-only list (same create/edit dialog as Market **Triggers**). Each card shows **Title**, **Pause** / **Active**, refresh, **Stop Loss**, and green/blue/red / P/L from the last **Run**. **Pause** skips that card on **Run**; **Active** includes it. New cards start **Paused**. On **Run**, every **Active** trigger is applied on each simulated window (with Latency / Fill Success). Frozen for the duration of a **Run**. |

**Run** simulates every UTC hour slot that has recordings (top-left first: Monday → Sunday, then earlier UTC hour). Results stream back **one hour at a time** into that cell. Trigger card stats accumulate as hours finish, and commit when the Run completes.

**Open Replay:** in **Schedule** (not Heatmap), **double-click** an hour cell that has non-zero stats to open the window list + scrubbable price chart for that UTC weekday×hour. Cells still at zeros do nothing.

| Workspace | What you see |
|-----------|----------------|
| **Live** | This ISO week’s recorded windows for that hour, with **actual** Trigger (and legacy phase) buy/sell markers from your live trade ledger. Price ticks come from the same recorder as Replay. |
| **Replay** | Last **Run** results when available (Latency / Fill Success / Active Replay Triggers); otherwise re-simulates with current Active triggers. |

Phase bands are not shown in either mode.

**Trade dots (per fill, not per window):**

| Trade | Dot |
|-------|-----|
| Sold for profit (Trigger take-profit) | **Green** |
| Held to settlement and market won that side | **Blue** |
| Stop-loss / held loss / other loss | **Red** |

Gray is Replay-only: windows that ran with ticks but never triggered a buy. In Replay, header totals and **Custom** also include gray when present.

Replay Trigger definitions are saved per signed-in user in the browser and are separate from Market Triggers. While a run is in progress, the button switches to **Stop**; **Latency**, **Fill Success**, and **Add Trigger** are disabled. Click **Stop** to cancel. Saving/deleting a Replay Trigger during a run also stops the run. Switching Live ↔ Replay does **not** stop a running job.

Replay uses the same simulation engine as demo Trigger trading. Window times/outcomes come from Mongo (`recorded_windows`); the engine needs **tick files** under the recorder’s `DATA_DIR`. On **Live**/Heroku with `SCHEDULE_REPLAY_SERVICE_URL` set, Open Replay ticks are proxied to that recorder.

**Bad recordings:** windows where the Chainlink/asset price is flat for the entire window are discarded (see prior behavior).

**Week grid history (Replay + Heatmap):** each UTC weekday×hour keeps the **latest** recording for that slot. Hours not re-recorded yet still show last week’s data. Retention defaults to ~**14 days**.

| Role | Env | Behavior |
|------|-----|----------|
| **Recorder** | no `TRADING_EXECUTOR`; **Recording** on for the series (Admin CRM) | Captures ticks/windows; Replay runs against local data |
| **Live** | `TRADING_EXECUTOR=1` | Does not record; set `SCHEDULE_REPLAY_SERVICE_URL` to the recorder |

## Heatmap

Day × hour intensity from recorded windows (e.g. crossings, range). Uses the same **latest weekday×hour** rule as Replay. Flat-price bad recordings are excluded. Use it to see where activity was — it does not trade by itself. Schedule/Heatmap and Live/Replay are independent toggles.

The left **color index** cards (Crossings, Range, Wallets, New wallets) can be dragged up/down by their handle — that order is the left→right order of the colored columns in each heatmap hour cell. The order is saved in the browser.
