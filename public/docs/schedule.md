# Schedule & Heatmap

Toggle **Schedule** and **Heatmap** on this page. At the bottom of the setups list, switch **Live** vs **Simulator** workspace.

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
- Double-click a placement to highlight it; highlighted cards feed the **Custom** header total (and still work with Heatmap)
- Header range (**Market** / **Live** / **Schedule**): **Market** = all-time confirmed totals for the selected market series; **Live** = since last header reset; **Schedule** = sum of cards on the week grid. Switching ranges shows a spinner on the totals icon while values load.
- Counts and P/L always show numeric values (`0` / `+$0.00`) when empty — never dashes

With **Use Schedule** + **Auto Trade** on [Market](doc:market), the **Live** setup on the current cell drives trading for that series. Replay placements never trade.

## Live vs Replay

| | **Live** | **Replay** |
|---|----------|------------|
| Purpose | Real schedule for auto-trade | What-if board over recent history |
| Setups | Own list | Own list (separate from Live) |
| Placements | Own week grid | Own week grid |
| Card stats | Live trade outcomes | Filled when you press **Replay** |
| Header total | Same summary chrome (**Market** = series all-time, **Live** = since reset, **Schedule** = sum of cards) | Same — totals update as replay results arrive |

In **Replay** (**Simulator** on the switcher), a blue border frames the whole screen so the workspace is obvious. The footer expands upward (quick transition) so a **Replay** button and its inputs appear above the Live/Simulator switcher — order top→bottom: **Replay**, then **Latency** / **Fill success**, then the switcher. Switching back to **Live** collapses that panel.

| Control | Meaning |
|---------|---------|
| **Latency (ms)** | Simulated delay for FAK fills and before GTD limits become live. Prefills from live feed latency (Market → Trade / Settings). |
| **Fill success (%)** | Chance each would-be fill succeeds after latency (random per attempt). **100%** = always fill when the book allows; **0%** = never. Prefills from live **Fill success** (last 7 days). |

It sends the placed cards (and their setups) for the areas they cover on the week grid. For each card it loads recorded ticks in that day/hour slot and runs the same simulation engine as demo trading. Cards are processed **top-left first** (Monday → Sunday, then earlier UTC hour). Results stream back **one card at a time** (green / red / blue / gray + PnL). Gray is Replay-only: windows that ran with ticks but never triggered a buy. The top summary shows the **total**. Cards with **no windows/ticks** in their slot stay full color after Replay and show a centered **No Data** label; cards that ran over recordings use the completed stats look (including zeros if nothing hit).

Replay schedule cards stay **editable** (move, resize, remove, place) — they are never locked like Live cards after a trade. Replay setups can also be edited in the setup editor while placed; on **Live**, phases stay locked until you remove the setup’s placements. While Replay is running, the button switches to **Stop** (stop icon, same style with a color pulse); click it to cancel. Changing a card on the Replay schedule also stops the run. Switching between **Live** and **Simulator** does **not** stop a running Replay — progress keeps applying and is restored when you return to Simulator.

Replay uses the same simulation engine as demo trading. Window times/outcomes come from Mongo (`recorded_windows`, same as the heatmap); the engine still needs **local tick files** under `DATA_DIR` (book + Chainlink) for each window. If ticks were pruned or Dropbox only kept recent files locally, those day/hour cards stay empty even though the heatmap still shows activity. Turn **Recording** on per series under Market → Trade, and keep `DATA_DIR` fully available on disk for the rolling week.

| Role | Env | Behavior |
|------|-----|----------|
| **Recorder** | no `TRADING_EXECUTOR`; **Recording** on for the series | Captures ticks/windows; Replay runs against local data (or serves the worker endpoint) |
| **Live** | `TRADING_EXECUTOR=1` | Does **not** record (toggle still saves); set `SCHEDULE_REPLAY_SERVICE_URL` to the recorder’s `/api/internal/schedule-replay` |

If `SCHEDULE_REPLAY_SERVICE_URL` is empty, Replay runs in-process on this server (typical for a local recorder). Optional `SCHEDULE_REPLAY_WORKER_SECRET` protects the worker endpoint (`x-replay-worker-secret` header).

## Heatmap

Day × hour intensity from recorded windows (e.g. crossings, range). Use it to choose where to place setups — it does not trade by itself. Schedule/Heatmap and Live/Simulator are independent toggles. On a recorder process, new windows update the heatmap as they finalize.
