# Schedule & Heatmap

App header tabs are **Market** | **Schedule** | **Heatmap** (Schedule and Heatmap are separate pages/views). On desktop, switch **Live** vs **Replay** at the bottom of the left column.

Trading on this product is **Trigger-only**. Phase setups, placement cards, **Auto Trade**, and **Use Schedule** are removed. The week grid always shows every UTC hour cell with Trigger stats.

**Mobile (narrow viewports):** a bottom bar holds the side-panel arrow (left) and, on **Schedule** only, the **Live** / **Replay** switcher (right-aligned — hidden on Heatmap). The arrow opens/closes the left column (width animates) so the week/heatmap table can use the full width; it rotates when the panel is closed. There is no Schedule/Heatmap sub-header. Desktop always shows the side panel (no bottom bar).

## Left column

| | **Live** | **Replay** |
|---|----------|------------|
| Purpose | Real Trigger Trade schedule | What-if board over recent history |
| List | **Trade + Active** Market Triggers only (full height; Edit opens Market) | Local **Replay Triggers** + **+ New** |
| Stats on cards | All-time Trade (or Demo) on each trigger card | From last **Run** |

## Schedule grid

- Days × UTC hours — **all 7×24 cells always show** a stats line (green / red / blue dots) and **P/L**, except Replay slots with no usable recordings (missing CLOB, Chainlink, and/or official Gamma outcome — see below)
- Each **Live** cell shows Trigger (and legacy) trade outcomes for that UTC weekday×hour:
  - Each cell always shows the **last occurrence** of that UTC weekday×hour (~**1 week** lookback): **this week’s** day once that hour arrives; otherwise the **same weekday last week** — including days with **zero** buys (gray `$0`). An empty last occurrence is kept; the cell does **not** skip it to show an older week that had trades.
  - **When** that weekday×hour arrives (UTC hour start — same moment recording for the slot begins), the cell **resets** to **this week’s** calendar day. If there are no buys yet, it shows **zero** dots and a **gray** `$0` P/L.
  - **Trigger Trade** when the trigger was **Trade + Active** at the window time (full Active/Paused + Demo/Trade **timeline**). Fills from before the first timeline row still count when that trigger has only ever been recorded as Trade+Active (late timeline seed). Legacy fills with a trigger id and no timeline rows also count. Settled fills with `source: trigger` but a missing trigger id still count on the hour grid
  - **Legacy phase / schedule-placement** fills still in the ledger (from before Trigger-only Schedule) follow the same arrival/reset rule
- **Replay / Heatmap** recordings still use the **latest calendar day with usable recordings** per weekday×hour (independent of Live trade resets)
- Each **day column header** shows the day title and, underneath, that day’s aggregated hour-cell stats (same dots + P/L; gray in Replay). The header’s bottom border is **green** when that day’s total P/L is positive and **red** when negative (default border when flat / no data). There is no per-day Clear control
- Hover a **UTC hour** label to highlight that row across the week; click to pin/unpin (stays until clicked again). Hover a **day column header** to highlight that column; click to pin/unpin — same on Schedule and Heatmap
- Current UTC cell is highlighted
- Header range (**Market** / **Live** / **Schedule**): **Market** = all-time confirmed totals for the series; **Live** = since last header reset; **Schedule** = sum of all hour cells. Manual quote-box buys are removed (legacy manual fills still count in Market/Live only — not on Schedule hour cells)

Replay placements never send live orders. Live Trigger Trade requires **Allow trade** on (Settings → **User**) and a trigger on **Trade** + **Active**.

## Live vs Replay

| | **Live** | **Replay** |
|---|----------|------------|
| Purpose | Real schedule for Trigger Trade | Test Replay Triggers on recordings |
| Triggers | Market Triggers (Mongo) | Browser-local Replay Triggers |
| Hour cells | Live Trigger Trade (timeline-gated) | Before **Run**: gray = usable recorded window count (CLOB + Chainlink + official Gamma) or **No Recordings**; after **Run**: green/red/blue + gray = windows that did not trigger |
| Header total | Same summary chrome | Totals update as replay results arrive |

In **Live**, the left column lists **Trade + Active** Market Triggers only (no Demo/Pause badges). Each Live trigger card shows (under the title) three equally spaced rows: green/blue/red stats (**Sell** / **Win** / **Loss**), then **Stop Loss**, then right-aligned **P/L** — no Reset/Refresh control (Trade stats update from the server automatically). In **Replay**, that list hides and the Replay panel expands — order top→bottom: **Run**, then **Triggers**, then **Settings** (Latency / Fill Success); on desktop the Live/Replay switcher stays under that stack, and on mobile it sits in the bottom bar (right-aligned with the side-panel arrow). The header title’s **Poly** is red on Market and on Live Schedule; **Replay** is blue while Replay is selected. Switching Live ↔ Replay paints each workspace’s hour-cell board immediately from its own in-memory buffer (no cross-flash); Live keeps updating in the background while you are on Replay.

| Control | Meaning |
|---------|---------|
| **Settings** | Container for Replay run inputs below **Triggers**. |
| **Latency (ms)** | Inside **Settings**. Simulated delay for FAK fills and before GTD limits become live. Default **20** (not tied to live feed latency). Frozen for the duration of a **Run**. |
| **Fill Success (%)** | Inside **Settings**. Chance each would-be fill succeeds after latency (random per attempt). Default **90**. **100%** = always fill when the book allows; **0%** = never. Not tied to live fill-success stats. Frozen for the duration of a **Run**. |
| **Triggers** | Replay-only list (same create/edit dialog as Market **Triggers**). Each card shows **Title**, **Pause** / **Active**, then the same three stats rows as Live (green/blue/red **Sell** / **Win** / **Loss**, then **Stop Loss**, then right-aligned **P/L**) from the last **Run** that included that card — with a reset icon centered on the height of the dots and Stop Loss rows. The **⋮** menu has **Edit**, **Duplicate**, and **Delete**. **Duplicate** adds a copy with a new id, empty Replay stats, **Paused**, and a **new random** handle color (same definition otherwise). New cards from **Create** also get a random handle color. **Pause** skips that card on **Run** and keeps its previous stats; **Active** includes it and replaces its stats from the new Run. New cards start **Paused**. On **Run**, every **Active** trigger is applied **independently** on each simulated window (with Latency / Fill Success) — cards do not race each other for a single open slot. The reset icon clears that card’s Replay stats (confirm first) — during a **Run** it stays available on **Paused** cards only. Pause/Active and edits stay frozen for the duration of a **Run**. |

**Replay idle / reset board:** each hour cell’s gray count is the number of **Replay-usable recorded windows** for that UTC weekday×hour (latest calendar day in the ~14-day window). A window counts only when **both** CLOB book and Chainlink tick files are present on disk **and** the recording has an official Gamma Up/Down (`windowOutcome`); missing any of those does not count. Slots with **zero** usable windows show **No Recordings** instead of dots and P/L. Double-click Open Replay still requires a non-zero gray (or post-Run) count. On the idle board, Open Replay shows those recordings **without** buy/sell markers (clean charts).

**Run** clears previous Replay Schedule hour-cell stats, then simulates every UTC hour slot that has usable recordings (top-left first: Monday → Sunday, then earlier UTC hour). While a slot is waiting, it keeps its gray **recorded window** count under a spinner until that hour’s results arrive; **No Recordings** cells stay labeled and do **not** spin. Results stream back **one hour at a time** — gray then means windows that ran with ticks but **did not trigger** a buy. If a finished hour has **all** counts at zero (green/red/blue/gray), the cell shows **No Recordings** instead of a zero-dot row. Those hour-cell results are kept in the browser across **page refresh** until the next **Run**. **Active** Trigger card stats accumulate as hours finish and commit when the Run completes; **Paused** cards are left unchanged. Windows missing **CLOB book** ticks, **Chainlink** ticks, **official Gamma outcome**, or with an empty price path are **skipped** — they do not count toward Run stats or gray “no trade” results, and a slot with none usable shows **No Recordings**.

**Open Replay:** in **Schedule** (not Heatmap), **double-click** an hour cell that has non-zero stats to open the window list + scrubbable price chart for that UTC weekday×hour. Cells still at zeros do nothing. Bottom transport shows play controls and the selected window’s **Official** Up/Down (Gamma payout on the recording; same settlement source as Live held Win/Loss). The price line is Chainlink through the window; the **last point**, **Current**, **PTB**, and **Gap** at window end use the recording’s official open/close so they match Official (no invented tip). Windows without an official Gamma outcome are **omitted** from both **Replay** and **Live** Open Replay (not listed). In **Replay**, windows without a mid-window Chainlink path are also omitted. In **Live**, traded windows still require official Gamma on the recording; Chainlink ticks remain optional for the price path (markers by time; blank chart when ticks were not saved).

| Workspace | What you see |
|-----------|----------------|
| **Live** | **Trade windows only** for the **latest calendar day** that still drives the cell’s Live stats: one list row per window that has Trigger (or legacy phase) fills matching the hour-cell dots (settled position cards + ledger) **and** a recording with official Gamma Up/Down. Chainlink ticks are optional — if missing, the row still appears with ledger markers on the timeline and Hits map (`Y` may be null); the chart notes that ticks were not saved. Empty recorded windows with no trade, or trades whose recording has no Gamma outcome yet, are omitted. |
| **Replay** | **Idle / reset** (gray = recording count): clean recordings only (no buy/sell markers). **After Run**: last **Run** results when available (Latency / Fill Success / Active Replay Triggers); otherwise re-simulates with current Active triggers — only windows with **CLOB book + Chainlink + official Gamma**. |

Phase bands are not shown in either mode.

**Trade dots (per fill, not per window):**

| Trade | Dot |
|-------|-----|
| Sold for profit (Trigger take-profit) | **Green** |
| Held to settlement and market won that side | **Blue** |
| Stop-loss / held loss / other loss | **Red** |

Gray is Replay-only: before a **Run**, recorded window count for the slot; after a **Run**, windows that ran with ticks but never triggered a buy. In Replay, header totals and **Custom** also include gray when present.

Replay Trigger definitions are saved per signed-in user in the browser and are separate from Market Triggers. While a run is in progress, the button switches to **Stop**; **Latency**, **Fill Success**, and **+ New** are disabled. Click **Stop** to cancel. Saving/deleting a Replay Trigger during a run also stops the run. Switching Live ↔ Replay does **not** stop a running job.

Replay uses the same simulation engine as demo Trigger trading. Window times/outcomes come from Mongo (`recorded_windows`), kept in sync with the recorder’s local window JSON. At window end the recorder saves quickly (does not stall the next window), then **polls Gamma in the background for up to 20 minutes** after `windowEnd` to set `windowOutcome` and stamp Gamma’s settlement close as the Chainlink JSONL tip (mid-window Chainlink samples stay as recorded). If Gamma still has not settled after 20 minutes, `windowOutcome` stays unset until a later outcome backfill. The engine needs **CLOB book + Chainlink tick files** under the recorder’s `DATA_DIR` **and** official Gamma. On **Live**/Heroku with `SCHEDULE_REPLAY_SERVICE_URL` set, Open Replay ticks are proxied to that recorder. Windows missing ticks or official Gamma are excluded from **Run**, **Replay** Open Replay, and **Live** Open Replay (idle gray counts and finished all-zero hours show **No Recordings**).

**Bad recordings:** windows where the Chainlink/asset price is flat for the entire window are discarded (see prior behavior).

**Week grid history:** **Live** trade hour cells use the **last occurrence** of each weekday×hour (~**1 week**, zeros included). **Replay / Heatmap** recordings still keep the **latest** day with usable recordings per slot; recording retention defaults to ~**14 days**.

| Role | Env | Behavior |
|------|-----|----------|
| **Recorder** | no `TRADING_EXECUTOR`; **Recording** on for the series (Admin CRM) | Captures ticks/windows; Replay runs against local data |
| **Live** | `TRADING_EXECUTOR=1` | Does not record; set `SCHEDULE_REPLAY_SERVICE_URL` to the recorder |

## Heatmap

Day × hour intensity from recorded windows (e.g. crossings, range). Uses the same **latest weekday×hour** rule as Replay. Flat-price bad recordings are excluded. Slots with **no** recorded data show **No Recordings** (same label as idle Replay Schedule cells) instead of empty metric columns. Use it to see where activity was — it does not trade by itself. Schedule vs Heatmap (header tabs) and Live/Replay are independent.

The left **color index** cards (Crossings, Range, Wallets, New wallets) can be dragged up/down by their handle — that order is the left→right order of the colored columns in each heatmap hour cell. The order is saved in the browser.
