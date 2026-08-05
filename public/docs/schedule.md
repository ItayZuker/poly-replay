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

- Days × UTC hours — **all 7×24 cells always show** a stats line (green / red / blue dots) and **P/L**, except Replay slots with no recordings (see below)
- Each cell aggregates outcomes for that UTC weekday×hour from the **latest calendar day** that still has fills in the ~14-day history window (Live) — same override rule as Replay/Heatmap recordings. A new ISO week (Monday) does **not** wipe Tue–Sun; only that weekday×hour is replaced when it plays again:
  - **Trigger Trade** when the trigger was **Trade + Active** at the window time (full Active/Paused + Demo/Trade **timeline**). Fills from before the first timeline row still count when that trigger has only ever been recorded as Trade+Active (late timeline seed). Legacy fills with a trigger id and no timeline rows also count. Settled fills with `source: trigger` but a missing trigger id still count on the hour grid
  - **Legacy phase / schedule-placement** fills still in the ledger (from before Trigger-only Schedule). They stay on the board until that weekday×hour is overridden by a newer day
- Each **day column header** shows the day title and, underneath, that day’s aggregated hour-cell stats (same dots + P/L; gray in Replay). The header’s bottom border is **green** when that day’s total P/L is positive and **red** when negative (default border when flat / no data). There is no per-day Clear control
- Current UTC cell is highlighted
- Header range (**Market** / **Live** / **Schedule**): **Market** = all-time confirmed totals for the series; **Live** = since last header reset; **Schedule** = sum of all hour cells. Manual quote-box buys are removed (legacy manual fills still count in Market/Live only — not on Schedule hour cells)

Replay placements never send live orders. Live Trigger Trade requires **Allow trade** on Market and a trigger on **Trade** + **Active**.

## Live vs Replay

| | **Live** | **Replay** |
|---|----------|------------|
| Purpose | Real schedule for Trigger Trade | Test Replay Triggers on recordings |
| Triggers | Market Triggers (Mongo) | Browser-local Replay Triggers |
| Hour cells | Live Trigger Trade (timeline-gated) | Before **Run**: gray = recorded window count (or **No Recordings**); after **Run**: green/red/blue + gray = windows that did not trigger |
| Header total | Same summary chrome | Totals update as replay results arrive |

In **Live**, the left column lists **Trade + Active** Market Triggers only (no Demo/Pause badges). Each Live trigger card shows (under the title) three equally spaced rows: green/blue/red stats, then **Stop Loss**, then right-aligned **P/L** — no Reset/Refresh control (Trade stats update from the server automatically). In **Replay**, that list hides and the Replay panel expands — order top→bottom: **Run**, then **Latency** / **Fill Success** / **Triggers**, then the Live/Replay switcher. A blue border frames the whole screen in Replay. Switching Live ↔ Replay paints each workspace’s hour-cell board immediately from its own in-memory buffer (no cross-flash); Live keeps updating in the background while you are on Replay.

| Control | Meaning |
|---------|---------|
| **Latency (ms)** | Simulated delay for FAK fills and before GTD limits become live. Prefills from live feed latency (Market → Trade / Settings). Frozen for the duration of a **Run**. |
| **Fill Success (%)** | Chance each would-be fill succeeds after latency (random per attempt). **100%** = always fill when the book allows; **0%** = never. Prefills from live **Fill success** total % (last 7 days). Frozen for the duration of a **Run**. |
| **Triggers** | Replay-only list (same create/edit dialog as Market **Triggers**). Each card shows **Title**, **Pause** / **Active**, reset, **Stop Loss**, and green/blue/red / P/L from the last **Run** that included that card. The **⋮** menu has **Edit**, **Duplicate**, and **Delete**. **Duplicate** adds a copy with a new id, empty Replay stats, and **Paused** (same definition otherwise). **Pause** skips that card on **Run** and keeps its previous stats; **Active** includes it and replaces its stats from the new Run. New cards start **Paused**. On **Run**, every **Active** trigger is applied on each simulated window (with Latency / Fill Success). The reset icon clears that card’s Replay stats (confirm first) — during a **Run** it stays available on **Paused** cards only. Pause/Active and edits stay frozen for the duration of a **Run**. |

**Replay idle / reset board:** each hour cell’s gray count is the number of **recorded windows** for that UTC weekday×hour (latest calendar day in the ~14-day window). Slots with **zero** recordings show **No Recordings** instead of dots and P/L. Double-click Open Replay still requires a non-zero gray (or post-Run) count. On the idle board, Open Replay shows those recordings **without** buy/sell markers (clean charts).

**Run** clears previous Replay Schedule hour-cell stats, then simulates every UTC hour slot that has recordings (top-left first: Monday → Sunday, then earlier UTC hour). While a slot is waiting, it keeps its gray **recorded window** count under a spinner until that hour’s results arrive; **No Recordings** cells stay labeled and do **not** spin. Results stream back **one hour at a time** — gray then means windows that ran with ticks but **did not trigger** a buy. If a finished hour has **all** counts at zero (green/red/blue/gray), the cell shows **No Recordings** instead of a zero-dot row. Those hour-cell results are kept in the browser across **page refresh** until the next **Run**. **Active** Trigger card stats accumulate as hours finish and commit when the Run completes; **Paused** cards are left unchanged. Windows with **no Chainlink tick files** (or book-only / empty price path) are **skipped** — they do not count toward Run stats or gray “no trade” results.

**Open Replay:** in **Schedule** (not Heatmap), **double-click** an hour cell that has non-zero stats to open the window list + scrubbable price chart for that UTC weekday×hour. Cells still at zeros do nothing. Bottom transport shows play controls and the selected window’s **Official** Up/Down (Polymarket crypto-price / Gamma on the recording). The price line is Chainlink through the window; the **last point**, **Current**, **PTB**, and **Gap** at window end use the recording’s official open/close so they match Official (no invented tip). If the recording lacks official outcome + open/close, the chart shows **No official settlement data for this window**. In **Replay**, windows without a mid-window Chainlink path are omitted. In **Live**, traded windows stay in the list even without Chainlink (markers by time; blank price path).

| Workspace | What you see |
|-----------|----------------|
| **Live** | **Trade windows only** for the **latest calendar day** that still drives the cell’s Live stats: one list row per window that has Trigger (or legacy phase) fills matching the hour-cell dots (settled position cards + ledger). Chainlink ticks are optional — if missing, the row still appears with ledger markers on the timeline and Hits map (`Y` may be null); the chart notes that ticks were not saved. Empty recorded windows with no trade are omitted. |
| **Replay** | **Idle / reset** (gray = recording count): clean recordings only (no buy/sell markers). **After Run**: last **Run** results when available (Latency / Fill Success / Active Replay Triggers); otherwise re-simulates with current Active triggers — only windows with Chainlink ticks. |

Phase bands are not shown in either mode.

**Trade dots (per fill, not per window):**

| Trade | Dot |
|-------|-----|
| Sold for profit (Trigger take-profit) | **Green** |
| Held to settlement and market won that side | **Blue** |
| Stop-loss / held loss / other loss | **Red** |

Gray is Replay-only: before a **Run**, recorded window count for the slot; after a **Run**, windows that ran with ticks but never triggered a buy. In Replay, header totals and **Custom** also include gray when present.

Replay Trigger definitions are saved per signed-in user in the browser and are separate from Market Triggers. While a run is in progress, the button switches to **Stop**; **Latency**, **Fill Success**, and **Add Trigger** are disabled. Click **Stop** to cancel. Saving/deleting a Replay Trigger during a run also stops the run. Switching Live ↔ Replay does **not** stop a running job.

Replay uses the same simulation engine as demo Trigger trading. Window times/outcomes come from Mongo (`recorded_windows`), kept in sync with the recorder’s local window JSON (official crypto-price / Gamma at finalize, and any outcome backfill). The engine needs **Chainlink tick files** under the recorder’s `DATA_DIR`. On **Live**/Heroku with `SCHEDULE_REPLAY_SERVICE_URL` set, Open Replay ticks are proxied to that recorder. Missing tick files are excluded from **Run** and from **Replay** Open Replay. **Live** Open Replay still lists every traded window for the hour cell; ticks are shown when present and skipped with ledger markers when not.

**Bad recordings:** windows where the Chainlink/asset price is flat for the entire window are discarded (see prior behavior).

**Week grid history (Live stats + Replay + Heatmap):** each UTC weekday×hour keeps the **latest** day for that slot. Hours not re-traded / re-recorded yet still show last week’s data. Retention defaults to ~**14 days**.

| Role | Env | Behavior |
|------|-----|----------|
| **Recorder** | no `TRADING_EXECUTOR`; **Recording** on for the series (Admin CRM) | Captures ticks/windows; Replay runs against local data |
| **Live** | `TRADING_EXECUTOR=1` | Does not record; set `SCHEDULE_REPLAY_SERVICE_URL` to the recorder |

## Heatmap

Day × hour intensity from recorded windows (e.g. crossings, range). Uses the same **latest weekday×hour** rule as Replay. Flat-price bad recordings are excluded. Slots with **no** recorded data show **No Recordings** (same label as idle Replay Schedule cells) instead of empty metric columns. Use it to see where activity was — it does not trade by itself. Schedule/Heatmap and Live/Replay are independent toggles.

The left **color index** cards (Crossings, Range, Wallets, New wallets) can be dragged up/down by their handle — that order is the left→right order of the colored columns in each heatmap hour cell. The order is saved in the browser.
