# Schedule & Heatmap

Toggle **Schedule** and **Heatmap** on this page. At the bottom of the setups list, switch **Live** vs **Replay** workspace.

## Setups

Reusable templates — full fields: [Setups & phases](doc:setups-phases).

- Create, edit, reorder, delete
- **3 phases** with buy/sell rules
- Drag onto the UTC week grid to place
- Deleting a setup **always** asks for confirmation; if it is on the schedule, the prompt notes that those cards will be removed with it
- Removing a **locked** schedule card (already traded) also asks for confirmation

**Add setup** works the same in Live and Replay; each workspace stores its own setups and placements.

## Schedule grid

- Days × UTC hours
- Place or clear setups (drag onto a cell, drop on a day header to fill that column, or drop on the **UTC** header to fill the whole week in one request)
- Current UTC cell is highlighted
- Double-click a placement to highlight it; double-click a **day header** to highlight all cards in that column (double-click again to clear that column’s highlight). Highlighted cards feed the **Custom** header total (and still work with Heatmap)
- Header range (**Market** / **Live** / **Schedule**): **Market** = all-time confirmed totals for the selected market series; **Live** = since last header reset; **Schedule** = sum of cards on the week grid. **Manual** buys (quote-box overrides) count in **Market** and **Live** only — they do **not** appear on Schedule cards or in the Schedule total. Switching ranges shows a spinner on the totals icon while values load.
- Counts and P/L always show numeric values (`0` / `+$0.00`) when empty — never dashes

With **Use Schedule** + **Auto Trade** on [Market](doc:market), the **Live** setup on the current cell drives trading for that series. Replay placements never trade.

## Live vs Replay

| | **Live** | **Replay** |
|---|----------|------------|
| Purpose | Real schedule for auto-trade | What-if board over recent history |
| Setups | Own list | Own list (separate from Live) |
| Placements | Own week grid | Own week grid |
| Card stats | Auto/schedule live trade outcomes (not manual buys) | Filled when you press **Run** |
| Header total | Same summary chrome (**Market** = series all-time, **Live** = since reset, **Schedule** = sum of cards) | Same — totals update as replay results arrive |

In **Replay** (on the Live/Replay switcher), a blue border frames the whole screen so the workspace is obvious. The footer expands upward (quick transition) so a **Run** button and its inputs appear above the Live/Replay switcher — order top→bottom: **Run**, then **Latency** / **Fill Success** / **Triggers**, then the switcher. Switching back to **Live** collapses that panel.

| Control | Meaning |
|---------|---------|
| **Latency (ms)** | Simulated delay for FAK fills and before GTD limits become live. Prefills from live feed latency (Market → Trade / Settings). Frozen for the duration of a **Run**. |
| **Fill Success (%)** | Chance each would-be fill succeeds after latency (random per attempt). **100%** = always fill when the book allows; **0%** = never. Prefills from live **Fill success** total % (last 7 days). Frozen for the duration of a **Run**. |
| **Triggers** | Replay-only list of detector triggers (same create/edit dialog as Market **Triggers**). Each card shows **Title** plus a **Stop Loss** exit-reason count on one row, then green/blue/red dots (**Success** / held win / **Fail**) with P/L on the next from the last completed **Run** (no Demo/Trade or Pause/Active toggles; green already means Take Profit success). Take Profit / Stop Loss are **¢ offsets from the buy fill** (same as Market; **100** disables that exit). Held to window end without TP/SL → **blue** (win) / **red** (loss) on the Trigger card; green is a profitable Take Profit exit. Fees can still make a Take Profit exit Fail. **Add Trigger** opens the shared dialog; definitions are saved per signed-in user in the browser and are separate from Market Triggers. On **Run**, every listed trigger is applied on each simulated window (with Latency / Fill Success), racing phase Auto Trade the same way (one open position at a time). Frozen for the duration of a **Run**. |

It sends the placed cards (and their setups) for the areas they cover on the week grid. For each card it loads recorded ticks in that day/hour slot and runs the same simulation engine as demo trading. Cards are processed **top-left first** (Monday → Sunday, then earlier UTC hour). Results stream back **one card at a time** (green / red / blue / gray + PnL). Trigger card stats accumulate on the footer Trigger cards as each schedule card finishes, and commit when the Run completes.

**Trade dots (per fill, not per window):** each settled trade counts as its own colored dot in header totals, card stats, and the Open Replay window list:
| Trade | Dot |
|-------|-----|
| Sold for profit (phase or Trigger take-profit sell) | **Green** |
| Sold for loss (phase) | **Red** |
| Held to settlement and market won that side | **Blue** |
| Held to settlement and market lost that side | **Red** |
| Trigger take-profit sell (profitable) | **Green** |
| Trigger held to window end, market won | **Blue** |
| Trigger stop-loss / held loss / other loss | **Red** |

Gray is Replay-only: windows that ran with ticks but never triggered a buy. In Replay, the header totals and **Custom** (highlighted) totals also include the gray count. The top summary shows the **total**. Cards with **no windows/ticks** in their slot stay full color after a **Run** and show a centered **No Data** label; cards that ran over recordings use the completed stats look (including zeros if nothing hit).

After a **Run**, cards that have tick data show **Open** in the card ⋮ menu. **Open** launches the **Open Replay** popup for that card’s windows: a scrollable window list (all trade dots on the left + PnL), graph playback with scrubber/speed, and a hits view (targets map — hover a buy or sell hit to ring both sides of that trade pair). During graph playback, once the playhead enters the **Duration** span before a Trigger buy, a full-height tinted band marks that span (green for UP, red for DOWN) and grows with the playhead until the buy — **each** trigger hit in the window gets its own band. Once the playhead reaches a buy time, a side badge appears (and updates to the latest reached hit) to the right of the back/play/forward controls (green/red fill). Above the graph (graph view only), **PTB**, **Current**, and **Gap** boxes (equal width) update with the scrubber/playhead from Chainlink ticks. Below them, UP/DOWN **Buy** / **Sell** quote boxes (same Market styling) update from book ticks loaded only for the selected window; a box latches with the triggered look when the playhead reaches that window’s sim buy/sell hit (independent of Triggers). Each additional buy/sell fill at/before the playhead adds another locked ¢ to the left of older locks (newest leftmost, then older fills, then the live quote). On the graph, the scrubber bar shows an elapsed-time label (`m:ss`) that moves with the playhead. The price line uses **Chainlink** ticks only (no book-price fallback), anchors the end of the window to the **official recorded close** (drawn at window end), and colors green/red from the stored market **up/down** outcome (same source as Settlement) — not from the last live tick vs PTB alone. If that close sits on the wrong side of PTB for the outcome, the end point is mirrored by the same |Gap| (or a tiny offset) so the tip and Gap sign match Settlement. Click a phase band to open that phase’s settings **view-only** (not editable). The price line and buy/sell hits reveal up to the scrubber (drag to the end of the window for the full line and all hits). The popup shows the **same** windows and fills as the card stats from that run (not a fresh random re-roll of Fill success). After a server restart, press **Run** again before Open so hits match the card.

Replay schedule cards stay **editable** (move, resize, remove, place) — they are never locked like Live cards after a trade. Replay setups can also be edited in the setup editor while placed; on **Live**, phases stay locked until you remove the setup’s placements. While a run is in progress, the button switches to **Stop** and the refresh arrows icon spins (same accent pulse style); **Latency**, **Fill Success**, and **Triggers** (Add Trigger) are disabled (muted) and keep the values captured when **Run** started — live Latency/Fill prefill resumes only after the run ends or is stopped. Click **Stop** to cancel. Changing a card on the Replay schedule also stops the run. Saving an edit (or deleting) a Replay **Trigger** during a run also stops the run. Switching between **Live** and **Replay** does **not** stop a running job — progress keeps applying and is restored when you return to Replay.

Replay uses the same simulation engine as demo trading. Window times/outcomes come from Mongo (`recorded_windows`, same as the heatmap); the engine still needs **tick files** under the recorder’s `DATA_DIR` (book + Chainlink) for each window. If ticks were pruned or Dropbox only kept recent files locally, those day/hour cards stay empty even though the heatmap still shows activity. Enable **Recording** per series in **Admin CRM**, and keep `DATA_DIR` fully available on the recorder. On **Live**/Heroku with `SCHEDULE_REPLAY_SERVICE_URL` set, Open Replay’s `GET /api/ticks` is proxied to that recorder (same secret as the replay worker), so the graph and metric boxes work without tick files on the live dyno.

**Bad recordings:** windows where the Chainlink/asset price is **flat for the entire window** (min = max) are discarded — removed from Mongo, local window/tick files, and in-memory heatmap/Replay indexes. They are not used by Replay or the Heatmap. New flats are rejected at finalize; existing flats are purged on server start (and when Replay encounters them in ticks).

**Week grid history (Replay + Heatmap):** each UTC weekday×hour slot keeps the **latest** recording for that slot. A new day does **not** wipe last week’s whole column — new windows **override only the hour being recorded**. Hours not re-recorded yet still show last week’s data for that slot. Disk/Mongo retention defaults to ~**14 days** (per-series override in Admin CRM) so previous weekday hours can survive until replaced.

| Role | Env | Behavior |
|------|-----|----------|
| **Recorder** | no `TRADING_EXECUTOR`; **Recording** on for the series (Admin CRM) | Captures ticks/windows; Replay runs against local data (or serves the worker endpoint, including `/api/internal/ticks`) |
| **Live** | `TRADING_EXECUTOR=1` | Does **not** record (toggle still saves); set `SCHEDULE_REPLAY_SERVICE_URL` to the recorder’s `/api/internal/schedule-replay` (also proxies Open Replay ticks) |

If `SCHEDULE_REPLAY_SERVICE_URL` is empty, Replay runs in-process on this server (typical for a local recorder). Optional `SCHEDULE_REPLAY_WORKER_SECRET` protects the worker endpoints (`x-replay-worker-secret` header).

## Heatmap

Day × hour intensity from recorded windows (e.g. crossings, range). Uses the same **latest weekday×hour** rule as Replay (new hour overrides that slot only; missing hours keep the previous week). Flat-price bad recordings are excluded (see above). Use it to choose where to place setups — it does not trade by itself. Schedule/Heatmap and Live/Replay are independent toggles. On a recorder process, new windows update the heatmap as they finalize.

The left **color index** cards (Crossings, Range, Wallets, New wallets) can be dragged up/down by their handle — that order is the left→right order of the colored columns in each heatmap hour cell. The order is saved in the browser.

On the **Wallets** card, an open icon (top-right of the title row) replaces the heatmap week grid with trader wallets recorded for the **currently selected market**. While that list is open, the Wallets card shows a blue highlight border (around the whole card, including outside the drag handle), the icon switches to a close (×) control, dragging/reordering of all color-index cards is disabled, and the other cards (Crossings, Range, New wallets) use a muted disabled look. Columns: address (links to Polymarket profile, with an open icon beside each address), that trader’s all-time Polymarket **P/L**, sightings, and **I WON** / **I LOST** for *your* settled trades in windows where that wallet was present. Default list is the **top 100 by sightings** (most → least). Click **P/L**, **Sightings**, **I WON**, or **I LOST** to re-fetch the top 100 for that ranking (high→low, then low→high); a spinner appears left of the active sort label while loading. Click the close icon to return to the heatmap. Changing the market while the list is open reloads it. Win/loss counts need per-window trader lists (stored going forward with recording retention); older windows without that list do not contribute.
