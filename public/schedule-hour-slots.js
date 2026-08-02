/**
 * Schedule week grid: every UTC weekday×hour cell shows Trigger Trade stats + P/L.
 * Live: GET /api/schedule-hour-stats (current ISO week).
 * Replay: filled from Run SSE (synthetic hour placements).
 */
(function () {
  const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

  /** @type {Map<string, object>} */
  let slotStats = new Map();
  let fetchTimer = null;
  let fetchInFlight = false;
  /** True while Schedule Replay Run is in progress. */
  let replayRunning = false;
  /** Slot keys that have received a result this run (spinner clears). */
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
    const hasData =
      raw.hasData === true || green + red + blue + gray > 0 || Math.abs(pnl) > 1e-9;
    return { day, hour: Number(hour), green, red, blue, gray, stopLoss, pnl, hasData };
  }

  function ensureAllEmpty() {
    for (const day of DAYS) {
      for (let hour = 0; hour < 24; hour++) {
        const key = slotKey(day, hour);
        if (!slotStats.has(key)) slotStats.set(key, emptySlot(day, hour));
      }
    }
  }

  function formatPnlAbs(n) {
    return Math.abs(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function formatPnl(pnl, hasData) {
    if (!hasData) return "+$0.00";
    const n = Number(pnl) || 0;
    const abs = formatPnlAbs(n);
    if (n > 0) return `+$${abs}`;
    if (n < 0) return `-$${abs}`;
    return `$${abs}`;
  }

  function pnlClass(pnl, hasData) {
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

  /** Strip Schedule Trigger stats / spinners from hour cells (Heatmap must stay untouched). */
  function clearScheduleChromeFromSlots() {
    for (const day of DAYS) {
      const col = document.querySelector(`.schedule-day-column[data-day="${day}"]`);
      if (!col) continue;
      for (const el of col.querySelectorAll(".schedule-hour-slot")) {
        el.querySelector(".schedule-hour-slot-stats")?.remove();
        el.querySelector(".schedule-hour-slot-loading")?.remove();
        el.classList.remove("has-slot-stats", "is-stats-loading");
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
    return (
      replayRunning &&
      isReplayWorkspace() &&
      !isHeatmapView() &&
      !replayResolvedKeys.has(slotKey(day, hour))
    );
  }

  function paintSlotElement(el, day, hour) {
    // Replay / Live Schedule paints must never mutate Heatmap cells.
    if (isHeatmapView()) return;

    const stats = slotStats.get(slotKey(day, hour)) || emptySlot(day, hour);
    el.querySelector(".schedule-hour-slot-stats")?.remove();
    el.querySelector(".schedule-hour-slot-loading")?.remove();
    const heatRow = el.querySelector(".schedule-heatmap-row");
    if (heatRow) heatRow.hidden = true;

    const loading = slotShowsReplaySpinner(day, hour);
    el.classList.toggle("is-stats-loading", loading);
    // While spinning, always show zeros under the overlay (reset at Run start).
    const display = loading ? emptySlot(day, hour) : stats;
    el.classList.toggle("has-slot-stats", !loading && stats.hasData === true);
    el.appendChild(buildStatsDom(display, isReplayWorkspace()));

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

  function setReplayRunning(on) {
    replayRunning = Boolean(on);
    if (replayRunning) {
      replayResolvedKeys = new Set();
      // Reset every cell to zeros under the spinner when Run is clicked.
      slotStats = new Map();
      ensureAllEmpty();
    }
    // Update Schedule board only — never touch Heatmap DOM mid-run.
    if (!isHeatmapView()) paint();
    notifyDayHeaders();
  }

  function applySlots(list) {
    ensureAllEmpty();
    if (Array.isArray(list)) {
      for (const raw of list) {
        const day = String(raw?.day || "").toLowerCase();
        const hour = Number(raw?.hour);
        if (!DAYS.includes(day) || !Number.isFinite(hour) || hour < 0 || hour > 23) continue;
        slotStats.set(slotKey(day, hour), normalizeSlot(raw, day, hour));
      }
    }
    paint();
    notifyDayHeaders();
    window.SchedulePlacements?.syncHeaderSummaryControls?.();
  }

  function clearAll() {
    slotStats = new Map();
    ensureAllEmpty();
    if (!isHeatmapView()) paint();
    notifyDayHeaders();
  }

  function applyReplayPlacementStat(data) {
    if (!data) return;
    const id = String(data.placementId || data._id || "");
    // Synthetic ids: hour:mon:14
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
    const prev = slotStats.get(slotKey(day, hour)) || emptySlot(day, hour);
    const next = normalizeSlot(
      {
        green: data.green,
        red: data.red,
        blue: data.blue,
        gray: data.gray,
        stopLoss: data.stopLoss,
        pnl: data.pnl,
        hasData: data.hasData !== false,
      },
      day,
      hour,
    );
    // Prefer incoming hasData during a run even if zeros.
    if (data.hasData === true || next.hasData || prev.hasData) next.hasData = true;
    const key = slotKey(day, hour);
    slotStats.set(key, next);
    replayResolvedKeys.add(key);
    // Keep Heatmap hour cells stable while Replay streams results in the background.
    if (!isHeatmapView()) {
      const col = document.querySelector(`.schedule-day-column[data-day="${day}"]`);
      const el = col?.querySelector(`.schedule-hour-slot[data-hour="${hour}"]`);
      if (el) paintSlotElement(el, day, hour);
      else paint();
    }
    notifyDayHeaders();
  }

  async function refreshLive() {
    if (isReplayWorkspace()) return;
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

  function totals() {
    ensureAllEmpty();
    let pnl = 0;
    let green = 0;
    let red = 0;
    let blue = 0;
    let gray = 0;
    let hasData = false;
    for (const stats of slotStats.values()) {
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
      const stats = slotStats.get(slotKey(d, hour)) || emptySlot(d, hour);
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
    return slotStats.get(slotKey(day, hour)) || emptySlot(day, hour);
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
    ensureAllEmpty();
    syncView();
    if (!isReplayWorkspace() && !isHeatmapView()) void refreshLive();
  }

  window.ScheduleHourSlots = {
    init,
    paint,
    syncView,
    clearAll,
    applySlots,
    applyReplayPlacementStat,
    setReplayRunning,
    refreshLive,
    totals,
    dayTotals,
    getSlot,
    buildTriggerOnlyReplayBoard,
    DAYS,
  };
})();
