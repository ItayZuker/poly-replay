/**
 * Schedule week grid: every UTC weekday×hour cell shows Trigger Trade stats + P/L.
 * Live and Replay keep separate in-memory boards so workspace toggles paint instantly
 * without flashing the other mode’s stats.
 * Live: GET /api/schedule-hour-stats (latest calendar day per slot).
 * Replay: baseline gray = recorded window counts; Run SSE fills green/red/blue/gray.
 */
(function () {
  const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

  /** @type {Map<string, object>} */
  let liveSlotStats = new Map();
  /** @type {Map<string, object>} */
  let replaySlotStats = new Map();
  /** @type {Map<string, number>} recorded window counts (latest day per slot). */
  let recordingCounts = new Map();
  let fetchTimer = null;
  let fetchInFlight = false;
  let baselineFetchInFlight = false;
  /** True while Schedule Replay Run is in progress. */
  let replayRunning = false;
  /** Slot keys that have received a Replay Run result (spinner clears). */
  let replayResolvedKeys = new Set();

  function slotKey(day, hour) {
    return `${day}:${Number(hour)}`;
  }

  function emptySlot(day, hour) {
    return {
      day,
      hour: Number(hour),
      green: 0,
      red: 0,
      blue: 0,
      gray: 0,
      stopLoss: 0,
      pnl: 0,
      hasData: false,
      isBaseline: false,
    };
  }

  function normalizeSlot(raw, day, hour) {
    const base = emptySlot(day, hour);
    if (!raw || typeof raw !== "object") return base;
    const green = Math.max(0, Math.round(Number(raw.green) || 0));
    const red = Math.max(0, Math.round(Number(raw.red) || 0));
    const blue = Math.max(0, Math.round(Number(raw.blue) || 0));
    const gray = Math.max(0, Math.round(Number(raw.gray) || 0));
    const stopLoss = Math.max(0, Math.round(Number(raw.stopLoss) || 0));
    const pnl = Number(raw.pnl) || 0;
    const isBaseline = raw.isBaseline === true;
    const hasData =
      raw.hasData === true || green + red + blue + gray > 0 || Math.abs(pnl) > 1e-9;
    return {
      day,
      hour: Number(hour),
      green,
      red,
      blue,
      gray,
      stopLoss,
      pnl,
      hasData,
      isBaseline,
    };
  }

  function isReplayWorkspace() {
    return (
      document.getElementById("page-schedule-heatmap")?.classList.contains("is-replay-workspace") ??
      false
    );
  }

  function isHeatmapView() {
    return (
      document.getElementById("page-schedule-heatmap")?.classList.contains("is-heatmap-view") ?? false
    );
  }

  function selectedSeries() {
    return window.getSelectedSeries?.() || "btc-5m";
  }

  /** Active board for the current workspace (Live vs Replay). */
  function activeSlotStats() {
    return isReplayWorkspace() ? replaySlotStats : liveSlotStats;
  }

  function ensureMapFilled(map) {
    for (const day of DAYS) {
      for (let hour = 0; hour < 24; hour++) {
        const key = slotKey(day, hour);
        if (!map.has(key)) map.set(key, emptySlot(day, hour));
      }
    }
  }

  function ensureAllEmpty() {
    ensureMapFilled(activeSlotStats());
  }

  function formatPnlAbs(n) {
    return Math.abs(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function formatPnl(pnl, hasData) {
    // Live arrived-empty slots use hasData + $0 with gray (is-neutral).
    if (!hasData) return "+$0.00";
    const n = Number(pnl) || 0;
    const abs = formatPnlAbs(n);
    if (n > 0) return `+$${abs}`;
    if (n < 0) return `-$${abs}`;
    return `$${abs}`;
  }

  function pnlClass(pnl, hasData) {
    // Zero / no buys → gray label (not green/red).
    if (!hasData) return "is-neutral";
    if (pnl > 0) return "is-positive";
    if (pnl < 0) return "is-negative";
    return "is-neutral";
  }

  function appendDot(parent, color, value) {
    const item = document.createElement("span");
    item.className = "schedule-placement-stat";
    const dot = document.createElement("span");
    dot.className = `schedule-placement-dot schedule-placement-dot-${color}`;
    dot.setAttribute("aria-hidden", "true");
    const count = document.createElement("span");
    count.className = "schedule-placement-stat-count";
    count.textContent = String(value);
    item.append(dot, count);
    parent.appendChild(item);
  }

  function buildStatsDom(stats, includeGray) {
    const wrap = document.createElement("div");
    wrap.className = "schedule-hour-slot-stats";
    const dots = document.createElement("div");
    dots.className = "schedule-placement-stats-dots";
    appendDot(dots, "green", stats.green);
    appendDot(dots, "red", stats.red);
    appendDot(dots, "blue", stats.blue);
    if (includeGray) appendDot(dots, "gray", stats.gray ?? 0);
    const pnl = document.createElement("div");
    pnl.className = `schedule-placement-pnl ${pnlClass(stats.pnl, stats.hasData)}`;
    pnl.textContent = formatPnl(stats.pnl, stats.hasData);
    wrap.append(dots, pnl);
    return wrap;
  }

  function buildNoRecordingsDom() {
    const wrap = document.createElement("div");
    wrap.className = "schedule-hour-slot-stats is-no-recordings";
    const label = document.createElement("div");
    label.className = "schedule-hour-slot-no-recordings";
    label.textContent = "No Recordings";
    wrap.appendChild(label);
    return wrap;
  }

  function recordingCountFor(day, hour) {
    return recordingCounts.get(slotKey(day, hour)) ?? 0;
  }

  function baselineSlot(day, hour) {
    const count = recordingCountFor(day, hour);
    if (count <= 0) {
      return { ...emptySlot(day, hour), isBaseline: true };
    }
    return normalizeSlot(
      {
        green: 0,
        red: 0,
        blue: 0,
        gray: count,
        stopLoss: 0,
        pnl: 0,
        hasData: true,
        isBaseline: true,
      },
      day,
      hour,
    );
  }

  /** Apply recording-count baseline to Replay slots that are not Run-resolved. */
  function applyBaselineToUnresolved() {
    ensureMapFilled(replaySlotStats);
    for (const day of DAYS) {
      for (let hour = 0; hour < 24; hour++) {
        const key = slotKey(day, hour);
        if (replayResolvedKeys.has(key)) continue;
        const prev = replaySlotStats.get(key);
        if (prev && prev.hasData && !prev.isBaseline) continue;
        replaySlotStats.set(key, baselineSlot(day, hour));
      }
    }
  }

  /** Strip Schedule Trigger stats / spinners from hour cells (Heatmap must stay untouched). */
  function clearScheduleChromeFromSlots() {
    for (const day of DAYS) {
      const col = document.querySelector(`.schedule-day-column[data-day="${day}"]`);
      if (!col) continue;
      for (const el of col.querySelectorAll(".schedule-hour-slot")) {
        el.querySelector(".schedule-hour-slot-stats")?.remove();
        el.querySelector(".schedule-hour-slot-loading")?.remove();
        el.classList.remove("has-slot-stats", "is-stats-loading", "is-no-recordings");
        const heatRow = el.querySelector(".schedule-heatmap-row");
        if (heatRow) heatRow.hidden = false;
      }
    }
  }

  /** Show Trigger stats (Schedule) or heatmap metric cells (Heatmap). */
  function syncView() {
    const heatmap = isHeatmapView();
    if (heatmap) {
      clearScheduleChromeFromSlots();
      return;
    }
    for (const day of DAYS) {
      const col = document.querySelector(`.schedule-day-column[data-day="${day}"]`);
      if (!col) continue;
      for (const el of col.querySelectorAll(".schedule-hour-slot")) {
        const heatRow = el.querySelector(".schedule-heatmap-row");
        if (heatRow) heatRow.hidden = true;
      }
    }
    paint();
  }

  function slotShowsReplaySpinner(day, hour) {
    if (!replayRunning || !isReplayWorkspace() || isHeatmapView()) return false;
    if (replayResolvedKeys.has(slotKey(day, hour))) return false;
    // No Recordings cells never spin — nothing to simulate.
    if (recordingCountFor(day, hour) <= 0) return false;
    return true;
  }

  /** True when green/red/blue/gray are all 0 and P/L is flat (empty Run / empty slot). */
  function slotCountsAreEmpty(stats) {
    const green = Math.max(0, Math.round(Number(stats?.green) || 0));
    const red = Math.max(0, Math.round(Number(stats?.red) || 0));
    const blue = Math.max(0, Math.round(Number(stats?.blue) || 0));
    const gray = Math.max(0, Math.round(Number(stats?.gray) || 0));
    const pnl = Number(stats?.pnl) || 0;
    return green + red + blue + gray === 0 && Math.abs(pnl) < 1e-9;
  }

  /**
   * Display model for a Replay cell:
   * - Run result (resolved) → green/red/blue/gray from sim (gray = no-trigger windows)
   * - Idle / pending Run → gray = recorded window count; empty slots → "No Recordings"
   * - All-zero counts (incl. gray) after a Run → "No Recordings" (not a zero-dot row)
   */
  function displayStatsForSlot(day, hour, stats) {
    const key = slotKey(day, hour);
    const count = recordingCountFor(day, hour);
    const resolved = replayResolvedKeys.has(key) || (stats.hasData === true && !stats.isBaseline);

    if (resolved) {
      if (!stats.hasData || slotCountsAreEmpty(stats)) {
        return { kind: "no-recordings" };
      }
      return { kind: "stats", stats };
    }

    if (count > 0) {
      return { kind: "stats", stats: baselineSlot(day, hour) };
    }
    return { kind: "no-recordings" };
  }

  function paintSlotElement(el, day, hour) {
    // Replay / Live Schedule paints must never mutate Heatmap cells.
    if (isHeatmapView()) return;

    const map = activeSlotStats();
    const stats = map.get(slotKey(day, hour)) || emptySlot(day, hour);
    el.querySelector(".schedule-hour-slot-stats")?.remove();
    el.querySelector(".schedule-hour-slot-loading")?.remove();
    const heatRow = el.querySelector(".schedule-heatmap-row");
    if (heatRow) heatRow.hidden = true;

    const loading = slotShowsReplaySpinner(day, hour);
    el.classList.toggle("is-stats-loading", loading);
    el.classList.remove("is-no-recordings");

    if (isReplayWorkspace()) {
      const display = displayStatsForSlot(day, hour, stats);
      if (display.kind === "no-recordings") {
        // Stay on "No Recordings" during Run — no spinner, no zeros flash.
        el.classList.toggle("has-slot-stats", false);
        el.classList.toggle("is-stats-loading", false);
        el.classList.add("is-no-recordings");
        el.appendChild(buildNoRecordingsDom());
        return;
      }
      const show = display.stats;
      el.classList.toggle("has-slot-stats", show.hasData === true);
      // Pending Run: keep gray recording count visible under the spinner.
      el.appendChild(buildStatsDom(show, true));
      if (loading) {
        const overlay = document.createElement("div");
        overlay.className = "schedule-hour-slot-loading";
        overlay.setAttribute("aria-label", "Simulating");
        overlay.setAttribute("aria-busy", "true");
        const spinner = document.createElement("span");
        spinner.className = "schedule-hour-slot-spinner";
        spinner.setAttribute("aria-hidden", "true");
        overlay.appendChild(spinner);
        el.appendChild(overlay);
      }
      return;
    }

    el.classList.toggle("has-slot-stats", stats.hasData === true);
    el.appendChild(buildStatsDom(stats, false));
  }

  function paint() {
    if (isHeatmapView()) return;
    ensureAllEmpty();
    for (const day of DAYS) {
      const col = document.querySelector(`.schedule-day-column[data-day="${day}"]`);
      if (!col) continue;
      for (const el of col.querySelectorAll(".schedule-hour-slot")) {
        const hour = Number(el.dataset.hour);
        if (!Number.isFinite(hour)) continue;
        paintSlotElement(el, day, hour);
      }
    }
  }

  /**
   * Instant Live ↔ Replay board swap (call right after the workspace CSS class flips).
   * Does not clear the other mode’s buffer.
   */
  function showActiveWorkspace() {
    ensureMapFilled(liveSlotStats);
    ensureMapFilled(replaySlotStats);
    if (isReplayWorkspace() && !replayRunning) {
      applyBaselineToUnresolved();
    }
    if (!isHeatmapView()) paint();
    notifyDayHeaders();
    window.SchedulePlacements?.syncHeaderSummaryControls?.();
  }

  function setReplayRunning(on) {
    replayRunning = Boolean(on);
    if (replayRunning) {
      replayResolvedKeys = new Set();
      // Clear prior Run results but keep recording-count baseline under spinners.
      replaySlotStats = new Map();
      ensureMapFilled(replaySlotStats);
      applyBaselineToUnresolved();
    } else {
      applyBaselineToUnresolved();
    }
    if (!isHeatmapView()) paint();
    notifyDayHeaders();
  }

  /** Write Live hour stats (keeps updating even while Replay is visible). */
  function applySlots(list) {
    ensureMapFilled(liveSlotStats);
    if (Array.isArray(list)) {
      for (const raw of list) {
        const day = String(raw?.day || "").toLowerCase();
        const hour = Number(raw?.hour);
        if (!DAYS.includes(day) || !Number.isFinite(hour) || hour < 0 || hour > 23) continue;
        liveSlotStats.set(slotKey(day, hour), normalizeSlot(raw, day, hour));
      }
    }
    // Only repaint when Live is the visible workspace.
    if (!isReplayWorkspace() && !isHeatmapView()) {
      paint();
      notifyDayHeaders();
      window.SchedulePlacements?.syncHeaderSummaryControls?.();
    }
  }

  /**
   * Clear the active workspace board only.
   * Does not wipe the other mode’s cached slots (toggle must stay instant).
   */
  function clearAll() {
    if (isReplayWorkspace()) {
      replaySlotStats = new Map();
      replayResolvedKeys = new Set();
      ensureMapFilled(replaySlotStats);
      applyBaselineToUnresolved();
    } else {
      liveSlotStats = new Map();
      ensureMapFilled(liveSlotStats);
    }
    if (!isHeatmapView()) paint();
    notifyDayHeaders();
  }

  /** Series change: drop both boards so neither shows the previous market. */
  function clearBothWorkspaces() {
    liveSlotStats = new Map();
    replaySlotStats = new Map();
    replayResolvedKeys = new Set();
    recordingCounts = new Map();
    ensureMapFilled(liveSlotStats);
    ensureMapFilled(replaySlotStats);
    if (isReplayWorkspace() && !replayRunning) applyBaselineToUnresolved();
    if (!isHeatmapView()) paint();
    notifyDayHeaders();
  }

  function applyReplayPlacementStat(data) {
    if (!data) return;
    const id = String(data.placementId || data._id || "");
    const m = /^hour:([a-z]+):(\d{1,2})$/i.exec(id);
    let day = data.day;
    let hour = data.startHour ?? data.hour;
    if (m) {
      day = m[1].toLowerCase();
      hour = Number(m[2]);
    }
    day = String(day || "").toLowerCase();
    hour = Number(hour);
    if (!DAYS.includes(day) || !Number.isFinite(hour)) return;
    const next = normalizeSlot(
      {
        green: data.green,
        red: data.red,
        blue: data.blue,
        gray: data.gray,
        stopLoss: data.stopLoss,
        pnl: data.pnl,
        hasData: data.hasData !== false,
        isBaseline: false,
      },
      day,
      hour,
    );
    if (data.hasData === true || next.hasData) next.hasData = true;
    if (data.hasData === false) next.hasData = false;
    const key = slotKey(day, hour);
    ensureMapFilled(replaySlotStats);
    replaySlotStats.set(key, next);
    replayResolvedKeys.add(key);
    // Paint only when Replay is visible (Run can finish while user is on Live).
    if (isReplayWorkspace() && !isHeatmapView()) {
      const col = document.querySelector(`.schedule-day-column[data-day="${day}"]`);
      const el = col?.querySelector(`.schedule-hour-slot[data-hour="${hour}"]`);
      if (el) paintSlotElement(el, day, hour);
      else paint();
      notifyDayHeaders();
    }
  }

  /**
   * Fetch Live hour stats into the Live buffer.
   * Always updates the buffer (even in Replay) so toggling back is instant / fresh.
   */
  async function refreshLive() {
    if (fetchInFlight) {
      if (fetchTimer) clearTimeout(fetchTimer);
      fetchTimer = setTimeout(() => {
        fetchTimer = null;
        void refreshLive();
      }, 200);
      return;
    }
    fetchInFlight = true;
    try {
      const res = await fetch("/api/schedule-hour-stats", { credentials: "same-origin" });
      if (!res.ok) return;
      const body = await res.json().catch(() => null);
      if (Array.isArray(body?.slots)) applySlots(body.slots);
    } catch {
      /* ignore */
    } finally {
      fetchInFlight = false;
    }
  }

  /**
   * Load recorded window counts and seed Replay cells (gray = count, or No Recordings).
   * Does not overwrite Run-resolved slots. Safe to call while Live is visible (buffer only).
   */
  async function refreshReplayBaseline(series) {
    if (replayRunning) return;
    if (baselineFetchInFlight) return;
    baselineFetchInFlight = true;
    try {
      const s = series || selectedSeries();
      const res = await fetch(
        `/api/schedule-replay-slot-counts?series=${encodeURIComponent(s)}`,
        { credentials: "same-origin" },
      );
      if (!res.ok) return;
      const body = await res.json().catch(() => null);
      const next = new Map();
      if (Array.isArray(body?.slots)) {
        for (const raw of body.slots) {
          const day = String(raw?.day || "").toLowerCase();
          const hour = Number(raw?.hour);
          if (!DAYS.includes(day) || !Number.isFinite(hour)) continue;
          next.set(slotKey(day, hour), Math.max(0, Math.round(Number(raw.windowCount) || 0)));
        }
      }
      recordingCounts = next;
      applyBaselineToUnresolved();
      if (isReplayWorkspace() && !isHeatmapView()) {
        paint();
        notifyDayHeaders();
        window.SchedulePlacements?.syncHeaderSummaryControls?.();
      }
    } catch {
      /* ignore */
    } finally {
      baselineFetchInFlight = false;
    }
  }

  function effectiveSlotForTotals(day, hour) {
    const map = activeSlotStats();
    const stats = map.get(slotKey(day, hour)) || emptySlot(day, hour);
    if (!isReplayWorkspace() || replayRunning) return stats;
    const display = displayStatsForSlot(day, hour, stats);
    if (display.kind === "no-recordings") return emptySlot(day, hour);
    return display.stats;
  }

  function totals() {
    ensureAllEmpty();
    let pnl = 0;
    let green = 0;
    let red = 0;
    let blue = 0;
    let gray = 0;
    let hasData = false;
    for (const day of DAYS) {
      for (let hour = 0; hour < 24; hour++) {
        const stats = effectiveSlotForTotals(day, hour);
        if (!stats.hasData) continue;
        hasData = true;
        pnl += stats.pnl || 0;
        green += stats.green || 0;
        red += stats.red || 0;
        blue += stats.blue || 0;
        gray += stats.gray || 0;
      }
    }
    return { hasData, pnl, green, red, blue, gray };
  }

  /** Sum of one weekday’s 24 UTC hour cells (day column header). */
  function dayTotals(day) {
    ensureAllEmpty();
    const d = String(day || "").toLowerCase();
    let pnl = 0;
    let green = 0;
    let red = 0;
    let blue = 0;
    let gray = 0;
    let hasData = false;
    if (!DAYS.includes(d)) {
      return { hasData, pnl, green, red, blue, gray };
    }
    for (let hour = 0; hour < 24; hour++) {
      const stats = effectiveSlotForTotals(d, hour);
      if (!stats.hasData) continue;
      hasData = true;
      pnl += stats.pnl || 0;
      green += stats.green || 0;
      red += stats.red || 0;
      blue += stats.blue || 0;
      gray += stats.gray || 0;
    }
    return { hasData, pnl, green, red, blue, gray };
  }

  function notifyDayHeaders() {
    window.SchedulePlacements?.updateDayHeaderPnls?.();
  }

  function getSlot(day, hour) {
    const map = activeSlotStats();
    const stats = map.get(slotKey(day, hour)) || emptySlot(day, hour);
    if (isReplayWorkspace() && !replayRunning) {
      const display = displayStatsForSlot(day, hour, stats);
      if (display.kind === "no-recordings") {
        return { ...emptySlot(day, hour), noRecordings: true };
      }
      return display.stats;
    }
    return stats;
  }

  /** Build 168 synthetic 1h placements + a buy-disabled setup for trigger-only Replay. */
  function buildTriggerOnlyReplayBoard(series) {
    const setupId = "__trigger_only__";
    const phaseOff = {
      buyEnabled: false,
      buyShares: 10,
      buyTrigger: 40,
      buyOptimize: false,
      buyOrderType: "GTD",
      minGap: 0,
      maxGap: 0,
      gapVsPtb: "with",
      buyAbortOnCrossing: 0,
      sellProfitCents: 20,
    };
    const setup = {
      _id: setupId,
      title: "Triggers",
      series: series || "",
      setup: {
        phaseSplit: [1 / 3, 2 / 3],
        phases: [phaseOff, phaseOff, phaseOff],
      },
    };
    const placements = [];
    for (const day of DAYS) {
      for (let hour = 0; hour < 24; hour++) {
        placements.push({
          _id: `hour:${day}:${hour}`,
          setupId,
          series: series || "",
          title: `${day.toUpperCase()} ${hour}:00`,
          day,
          startHour: hour,
          durationHours: 1,
        });
      }
    }
    return { setups: [setup], placements };
  }

  function init() {
    ensureMapFilled(liveSlotStats);
    ensureMapFilled(replaySlotStats);
    syncView();
    // Warm both buffers so the first Live ↔ Replay toggle has data ready.
    void refreshLive();
    void refreshReplayBaseline();
  }

  window.ScheduleHourSlots = {
    init,
    paint,
    syncView,
    showActiveWorkspace,
    clearAll,
    clearBothWorkspaces,
    applySlots,
    applyReplayPlacementStat,
    setReplayRunning,
    refreshLive,
    refreshReplayBaseline,
    totals,
    dayTotals,
    getSlot,
    buildTriggerOnlyReplayBoard,
    DAYS,
  };
})();
