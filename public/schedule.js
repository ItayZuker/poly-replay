/** Schedule page — drag setups onto day/hour grid, persist to Mongo. */
(function () {
  const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const DROP_DURATIONS = [2, 1.5, 1];
  const MIN_DURATION = 1;
  const STATS_CACHE_STORAGE_KEY = "poly-real:schedule-placement-stats";
  const REPLAY_LATENCY_STORAGE_KEY = "poly-real:schedule-replay-latency-ms";
  const REPLAY_FILL_SUCCESS_STORAGE_KEY = "poly-real:schedule-replay-fill-success-pct";
  const REPLAY_PREDICTION_STORAGE_KEY = "poly-real:schedule-replay-prediction";
  const DEFAULT_REPLAY_LATENCY_MS = 150;
  const DEFAULT_REPLAY_FILL_SUCCESS_PCT = 100;
  const DEFAULT_REPLAY_PREDICTION = {
    enabled: true,
    maxQuoteCents: 90,
    minQuoteCents: 70,
    shiftCents: 5,
    riseCents: 5,
    sensitivitySec: 5,
    shares: 10,
    buyOrderType: "FOK",
    sellOrderType: "FOK",
    areaStart: 0,
    areaEnd: 1,
  };
  const REPLAY_PRED_THUMB_PX = 12;
  /** Live real-trade stats — do not reuse sim backtest caches. */

  let placements = [];
  let placementStats = new Map();
  /** Placement IDs included in the next stats batch fetch. */
  let statsPendingIds = new Set();
  let statsBatchFetching = false;
  let statsPendingEnqueueIds = null;
  let statsAbortController = null;
  let statsEventSource = null;
  let statsWaitingForSetups = false;
  /** When set, the active stats fetch only recomputes placements for this setup on the server. */
  let statsFetchSetupId = null;
  /** When true, the active stats fetch skips the header progress bar (single-card incremental refresh). */
  let statsFetchQuiet = false;
  /** Per-series heatmap data version (`windowStart:savedAt`) for stats cache invalidation. */
  let heatmapSeriesVersions = {};
  let dragState = null;
  /** Pending/active drag from the setups list: reorder in-column or place on grid. */
  let listDragState = null;
  let moveDragState = null;
  let resizeState = null;
  let openMenuId = null;
  let dropPreviewEl = null;
  let headerFillPreviewDay = null;
  /** True while previewing a UTC-header drop that fills every day column. */
  let headerFillPreviewWeek = false;
  const busyDays = new Set();
  let framedPlacementIds = new Set();
  /** Placements that have started ≥1 window — locked until removed. */
  let lockedPlacementIds = new Set();
  /** Pinned UTC hour rows (0–23). */
  let pinnedUtcHours = new Set();
  /** Transient UTC hour under the pointer, or null when not hovering the column. */
  let hoveredUtcHour = null;

  function snapStartTime(frac) {
    const slot = Math.max(0, Math.min(47, Math.round(frac * 48)));
    return slot / 2;
  }

  function snapEndTime(frac) {
    const slot = Math.max(1, Math.min(48, Math.round(frac * 48)));
    return slot / 2;
  }

  function startTimeFromPointer(body, clientY) {
    const rect = body.getBoundingClientRect();
    if (rect.height <= 0) return 0;
    const frac = (clientY - rect.top) / rect.height;
    return snapStartTime(frac);
  }

  function endTimeFromPointer(body, clientY) {
    const rect = body.getBoundingClientRect();
    if (rect.height <= 0) return MIN_DURATION;
    const frac = (clientY - rect.top) / rect.height;
    return snapEndTime(frac);
  }

  function isSchedulePage() {
    const page = document.getElementById("page-schedule-heatmap");
    return page && !page.hidden;
  }

  function isScheduleView() {
    return isSchedulePage() && !document.getElementById("page-schedule-heatmap")?.classList.contains("is-heatmap-view");
  }

  /** Current UTC weekday key + fractional hour for the schedule grid. */
  function getUtcScheduleClock() {
    const now = new Date();
    const day = DAYS[(now.getUTCDay() + 6) % 7];
    const hour =
      now.getUTCHours() +
      now.getUTCMinutes() / 60 +
      now.getUTCSeconds() / 3600;
    return { day, hour, hourSlot: now.getUTCHours() };
  }

  /** Last highlight key — avoid restarting pulse (causes visible border flicker). */
  let lastNowHighlightKey = "";

  /**
   * Now highlights:
   * - UTC hour label
   * - Current day×hour cell (Schedule stats + Heatmap) — pulsing red frame
   * Animations share one wall-clock phase via --schedule-pulse-delay on :root.
   */
  function syncNowHighlights() {
    const { day, hourSlot } = getUtcScheduleClock();
    const onSchedule = isScheduleView();
    const highlightKey = `${isSchedulePage() ? 1 : 0}|${onSchedule ? 1 : 0}|${day}|${hourSlot}`;

    document.querySelectorAll(".schedule-utc-hour").forEach((el) => {
      el.classList.toggle(
        "is-now",
        isSchedulePage() && Number(el.dataset.hour) === hourSlot,
      );
    });

    document.querySelectorAll(".schedule-day-column").forEach((col) => {
      const isToday = col.dataset.day === day;
      col.querySelectorAll(".schedule-hour-slot").forEach((slot) => {
        slot.classList.toggle(
          "is-now",
          isSchedulePage() && isToday && Number(slot.dataset.hour) === hourSlot,
        );
      });
    });

    // Only resync animation phase when the live target changes. Restarting every
    // call briefly drops is-pulse-synced and the red border flickers.
    if (highlightKey !== lastNowHighlightKey) {
      lastNowHighlightKey = highlightKey;
      const periodMs = 1300;
      document.documentElement.style.setProperty(
        "--schedule-pulse-delay",
        `${-(Date.now() % periodMs)}ms`,
      );
      restartPulseAnimations();
    } else {
      // Cards rebuilt with is-live but lost is-pulse-synced — restore without restart.
      document
        .querySelectorAll(".schedule-utc-hour.is-now, .schedule-hour-slot.is-now")
        .forEach((el) => el.classList.add("is-pulse-synced"));
    }
  }

  /** Restart pulse animations so every active highlight shares the same phase. */
  function restartPulseAnimations() {
    const els = document.querySelectorAll(
      ".schedule-utc-hour.is-now, .schedule-hour-slot.is-now",
    );
    els.forEach((el) => el.classList.remove("is-pulse-synced"));
    // Force style recalc so removing the class actually stops the animation.
    void document.documentElement.offsetWidth;
    els.forEach((el) => el.classList.add("is-pulse-synced"));
  }

  function rangesOverlap(aStart, aDur, bStart, bDur) {
    return aStart < bStart + bDur && bStart < aStart + aDur;
  }

  function columnPlacements(day, excludeId) {
    return placements.filter((p) => p.day === day && p._id !== excludeId);
  }

  function canPlace(day, startHour, durationHours, excludeId) {
    if (startHour < 0 || durationHours < MIN_DURATION || startHour + durationHours > 24) return false;
    const others = columnPlacements(day, excludeId);
    for (const p of others) {
      if (rangesOverlap(startHour, durationHours, p.startHour, p.durationHours)) return false;
    }
    return true;
  }

  function findDropPlacement(day, dropTime) {
    const startSlot = Math.round(dropTime * 2);
    for (let slot = startSlot; slot < 48; slot++) {
      const startHour = slot / 2;
      for (const durationHours of DROP_DURATIONS) {
        if (canPlace(day, startHour, durationHours)) {
          return { day, startHour, durationHours };
        }
      }
    }
    return null;
  }

  function freeDurationAt(day, startHour, excludeId) {
    if (startHour < 0 || startHour >= 24) return 0;
    let end = 24;
    for (const p of columnPlacements(day, excludeId)) {
      if (p.startHour > startHour && p.startHour < end) end = p.startHour;
    }
    return end - startHour;
  }

  function fitDurationInGap(preferredDurationHours, availableHours) {
    if (availableHours < MIN_DURATION) return null;
    const fitted = Math.min(preferredDurationHours, availableHours);
    const snapped = Math.floor(fitted * 2) / 2;
    if (snapped >= MIN_DURATION) return snapped;
    return MIN_DURATION;
  }

  function findMovePlacement(day, dropTime, preferredDurationHours, excludeId) {
    const primarySlot = Math.round(dropTime * 2);
    const slots = [];
    for (let slot = primarySlot; slot < 48; slot++) slots.push(slot);
    for (let slot = primarySlot - 1; slot >= 0; slot--) slots.push(slot);

    let best = null;
    for (const slot of slots) {
      const startHour = slot / 2;
      if (startHour + MIN_DURATION > 24) continue;
      const available = freeDurationAt(day, startHour, excludeId);
      const durationHours = fitDurationInGap(preferredDurationHours, available);
      if (durationHours == null) continue;
      if (!canPlace(day, startHour, durationHours, excludeId)) continue;

      const dist = Math.abs(slot - primarySlot);
      if (
        !best ||
        dist < best.dist ||
        (dist === best.dist && durationHours > best.durationHours)
      ) {
        best = { day, startHour, durationHours, dist };
      }
    }

    return best ? { day: best.day, startHour: best.startHour, durationHours: best.durationHours } : null;
  }

  function dayFromElement(el) {
    const col = el?.closest?.(".schedule-day-column");
    return col?.dataset?.day ?? null;
  }

  function getDayBody(day) {
    const col = document.querySelector(`.schedule-day-column[data-day="${day}"]`);
    return col?.querySelector(".schedule-day-body") ?? null;
  }

  function getPlacementLayer(day) {
    const col = document.querySelector(`.schedule-day-column[data-day="${day}"]`);
    return col?.querySelector(".schedule-placements-layer") ?? null;
  }

  function clearDropPreview() {
    if (dropPreviewEl) {
      dropPreviewEl.remove();
      dropPreviewEl = null;
    }
  }

  function clearHeaderFillPreview() {
    document
      .querySelectorAll(
        ".schedule-day-header.is-fill-drop-target, .schedule-utc-header.is-fill-drop-target",
      )
      .forEach((header) => header.classList.remove("is-fill-drop-target"));
    document.querySelectorAll(".schedule-column-fill-preview").forEach((el) => el.remove());
    headerFillPreviewDay = null;
    headerFillPreviewWeek = false;
  }

  function appendColumnFillPreview(day, setupId) {
    const layer = getPlacementLayer(day);
    if (!layer) return;
    const preview = document.createElement("div");
    preview.className = "schedule-column-fill-preview";
    preview.style.setProperty(
      "--setup-color",
      window.getSetupColorById?.(setupId) || "#58a6ff",
    );
    for (let index = 0; index < 12; index += 1) {
      const card = document.createElement("div");
      card.className = "schedule-column-fill-preview-card";
      card.style.top = `${(index / 12) * 100}%`;
      card.style.height = `${100 / 12}%`;
      preview.appendChild(card);
    }
    layer.appendChild(preview);
  }

  function showHeaderFillPreview(day, setupId) {
    if (
      !headerFillPreviewWeek &&
      headerFillPreviewDay === day &&
      document.querySelector(`.schedule-day-column[data-day="${day}"] .schedule-column-fill-preview`)
    ) {
      return;
    }
    clearHeaderFillPreview();
    const column = document.querySelector(`.schedule-day-column[data-day="${day}"]`);
    const header = column?.querySelector(".schedule-day-header");
    if (!header || !getPlacementLayer(day)) return;
    header.classList.add("is-fill-drop-target");
    appendColumnFillPreview(day, setupId);
    headerFillPreviewDay = day;
  }

  function showWeekFillPreview(setupId) {
    if (
      headerFillPreviewWeek &&
      document.querySelectorAll(".schedule-column-fill-preview").length === DAYS.length
    ) {
      return;
    }
    clearHeaderFillPreview();
    document.querySelector(".schedule-utc-header")?.classList.add("is-fill-drop-target");
    for (const day of DAYS) {
      const header = document.querySelector(
        `.schedule-day-column[data-day="${day}"] .schedule-day-header`,
      );
      header?.classList.add("is-fill-drop-target");
      appendColumnFillPreview(day, setupId);
    }
    headerFillPreviewWeek = true;
  }

  function setDayBusy(day, busy) {
    const column = document.querySelector(`.schedule-day-column[data-day="${day}"]`);
    const wrap = column?.querySelector(".schedule-day-body-wrap");
    const button = column?.querySelector(".schedule-day-clear-button");
    if (!column || !wrap) return;
    column.classList.toggle("is-day-busy", busy);
    if (button) button.disabled = busy;
    wrap.querySelector(".schedule-day-loading")?.remove();
    if (!busy) return;
    const overlay = document.createElement("div");
    overlay.className = "schedule-day-loading";
    overlay.setAttribute("aria-label", "Updating day schedule");
    overlay.innerHTML = '<span class="schedule-day-spinner" aria-hidden="true"></span>';
    wrap.appendChild(overlay);
  }

  function discardDayPlacementState(day, previous) {
    for (const placement of previous) {
      framedPlacementIds.delete(placement._id);
      removePlacementFromCache(placement._id);
    }
    updateDayHeaderPnls();
    updateWeekHeaderSummary();
  }

  async function clearDay(day) {
    if (busyDays.has(day)) return;
    interruptReplayIfRunning("schedule changed");
    const previous = placements.filter((placement) => placement.day === day);
    if (previous.length === 0) return;

    const lockedCount = previous.filter((p) => isPlacementLocked(p._id)).length;
    if (lockedCount > 0) {
      const dayLabel =
        document.querySelector(`.schedule-day-column[data-day="${day}"] .schedule-day-title`)
          ?.textContent || day;
      const confirmed = window.confirm(
        `Clear ${dayLabel}?\n\nIt has ${lockedCount} locked card${lockedCount === 1 ? "" : "s"}. Those will be removed and this cannot be undone.`,
      );
      if (!confirmed) return;
    }

    busyDays.add(day);
    clearHeaderFillPreview();
    setDayBusy(day, true);
    try {
      const res = await fetch(
        `/api/schedule-placements/day/${encodeURIComponent(day)}?${seriesQuery()}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Clear day failed (${res.status})`);
      }
      const next = await res.json();
      // Surgical DOM sync handles framed/cache cleanup for removed day cards.
      syncPlacementsDom(Array.isArray(next) ? next : placements.filter((p) => p.day !== day));
      window.updateSetupListPlacementCounts?.();
    } catch (err) {
      console.error(err);
      await loadPlacements();
    } finally {
      busyDays.delete(day);
      setDayBusy(day, false);
    }
  }

  async function fillDay(day, setupId, title) {
    if (busyDays.has(day)) return;
    interruptReplayIfRunning("schedule changed");
    const previous = placements.filter((placement) => placement.day === day);
    busyDays.add(day);
    clearHeaderFillPreview();
    setDayBusy(day, true);
    try {
      const res = await fetch("/api/schedule-placements/replace-day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withSeries({ day, setupId, title })),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Fill day failed (${res.status})`);
      }
      placements = await res.json();
      discardDayPlacementState(day, previous);
      renderPlacements();
      if (typeof window.refreshScheduleSetupsList === "function") {
        void window.refreshScheduleSetupsList();
      }
    } catch (err) {
      console.error(err);
      await loadPlacements();
    } finally {
      busyDays.delete(day);
      setDayBusy(day, false);
    }
  }

  async function fillWeek(setupId, title) {
    if (DAYS.some((day) => busyDays.has(day))) return;
    interruptReplayIfRunning("schedule changed");
    const previousByDay = Object.fromEntries(
      DAYS.map((day) => [day, placements.filter((placement) => placement.day === day)]),
    );
    clearHeaderFillPreview();
    for (const day of DAYS) {
      busyDays.add(day);
      setDayBusy(day, true);
    }
    try {
      const res = await fetch("/api/schedule-placements/replace-week", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withSeries({ setupId, title })),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Fill week failed (${res.status})`);
      }
      const next = await res.json();
      placements = Array.isArray(next) ? next : placements;
      for (const day of DAYS) {
        discardDayPlacementState(day, previousByDay[day] || []);
      }
      renderPlacements();
      if (typeof window.refreshScheduleSetupsList === "function") {
        void window.refreshScheduleSetupsList();
      }
    } catch (err) {
      console.error(err);
      await loadPlacements();
    } finally {
      for (const day of DAYS) {
        busyDays.delete(day);
        setDayBusy(day, false);
      }
    }
  }

  function showDropPreview(day, startHour, durationHours, setupId) {
    clearDropPreview();
    const layer = getPlacementLayer(day);
    if (!layer) return;
    dropPreviewEl = document.createElement("div");
    dropPreviewEl.className = "schedule-drop-preview";
    dropPreviewEl.style.top = `${(startHour / 24) * 100}%`;
    dropPreviewEl.style.height = `${(durationHours / 24) * 100}%`;
    const color = window.getSetupColorById?.(setupId) || "#58a6ff";
    dropPreviewEl.style.setProperty("--setup-color", color);
    layer.appendChild(dropPreviewEl);
  }

  function initPlacementLayers() {
    document.querySelectorAll(".schedule-day-column").forEach((col) => {
      const day = col.dataset.day;
      const body = col.querySelector(".schedule-day-body");
      if (!body || !day) return;

      if (!body.parentElement?.classList.contains("schedule-day-body-wrap")) {
        const wrap = document.createElement("div");
        wrap.className = "schedule-day-body-wrap";
        body.parentNode.insertBefore(wrap, body);
        wrap.appendChild(body);
        const layer = document.createElement("div");
        layer.className = "schedule-placements-layer";
        layer.dataset.day = day;
        wrap.appendChild(layer);
      } else if (!body.parentElement.querySelector(".schedule-placements-layer")) {
        const layer = document.createElement("div");
        layer.className = "schedule-placements-layer";
        layer.dataset.day = day;
        body.parentElement.appendChild(layer);
      }
    });
  }

  function initDayHeaderControls() {
    document.querySelectorAll(".schedule-day-column").forEach((column) => {
      const day = column.dataset.day;
      const header = column.querySelector(".schedule-day-header");
      if (!day || !header || header.dataset.dayHeaderBound === "1") return;
      header.dataset.dayHeaderBound = "1";
      // Remove legacy Clear (Can) control if still present from an older session.
      header.querySelector(".schedule-day-clear-button")?.remove();
      if (!header.querySelector(".schedule-day-header-stats")) {
        const host = document.createElement("div");
        host.className = "schedule-day-header-stats";
        host.setAttribute("aria-label", "Day totals");
        header.appendChild(host);
      }
    });
    updateDayHeaderPnls();
  }

  function highlightedUtcHours() {
    const hours = new Set(pinnedUtcHours);
    if (hoveredUtcHour != null) hours.add(hoveredUtcHour);
    return hours;
  }

  function setUtcRowHover(hour) {
    hoveredUtcHour = hour;
    updateUtcRowHighlight();
  }

  function restoreUtcRowHover() {
    hoveredUtcHour = null;
    updateUtcRowHighlight();
  }

  function updateUtcRowHighlight() {
    const utcBody = document.querySelector(".schedule-utc-body");
    if (utcBody) {
      utcBody.querySelectorAll(".schedule-utc-hour").forEach((el, index) => {
        el.classList.toggle("is-row-pinned", pinnedUtcHours.has(index));
        el.classList.toggle("is-row-hover", hoveredUtcHour != null && index === hoveredUtcHour);
      });
    }

    const hours = [...highlightedUtcHours()].sort((a, b) => a - b);
    document.querySelectorAll(".schedule-day-body-wrap").forEach((wrap) => {
      wrap.querySelectorAll(".schedule-row-highlight").forEach((el) => el.remove());
      for (const hour of hours) {
        const highlight = document.createElement("div");
        highlight.className = "schedule-row-highlight is-active";
        if (pinnedUtcHours.has(hour)) highlight.classList.add("is-pinned");
        highlight.style.setProperty("--hover-hour", String(hour));
        highlight.setAttribute("aria-hidden", "true");
        wrap.appendChild(highlight);
      }
    });
  }

  function utcHourFromEventTarget(utcBody, target) {
    const hourEl = target.closest(".schedule-utc-hour");
    if (!hourEl || hourEl.parentElement !== utcBody) return null;
    return [...utcBody.children].indexOf(hourEl);
  }

  function bindUtcRowHover() {
    const utcBody = document.querySelector(".schedule-utc-body");
    if (!utcBody || utcBody.dataset.hoverBound === "1") return;
    utcBody.dataset.hoverBound = "1";
    utcBody.addEventListener("mouseover", (e) => {
      const hour = utcHourFromEventTarget(utcBody, e.target);
      if (hour == null) return;
      setUtcRowHover(hour);
    });
    utcBody.addEventListener("mouseleave", () => restoreUtcRowHover());
    utcBody.addEventListener("click", (e) => {
      const hour = utcHourFromEventTarget(utcBody, e.target);
      if (hour == null) return;
      if (pinnedUtcHours.has(hour)) pinnedUtcHours.delete(hour);
      else pinnedUtcHours.add(hour);
      updateUtcRowHighlight();
    });
  }

  function closeMenus() {
    openMenuId = null;
    document.querySelectorAll(".schedule-placement-menu").forEach((m) => m.remove());
    document.querySelectorAll(".schedule-placement-menu-btn").forEach((btn) => {
      btn.setAttribute("aria-expanded", "false");
    });
  }

  function positionPlacementMenu(menu, anchor) {
    const rect = anchor.getBoundingClientRect();
    const gap = 4;
    const menuHeight = menu.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const openDown = spaceBelow >= menuHeight || spaceBelow >= spaceAbove;

    let top = openDown ? rect.bottom + gap : rect.top - menuHeight - gap;
    top = Math.max(gap, Math.min(top, window.innerHeight - menuHeight - gap));

    menu.style.top = `${top}px`;
    menu.style.left = `${rect.right}px`;
    menu.style.transform = "translateX(-100%)";
    menu.classList.toggle("opens-up", !openDown);
  }

  function formatPlacementPnl(pnl, _hasData) {
    const n = pnl != null && Number.isFinite(Number(pnl)) ? Number(pnl) : 0;
    const sign = n >= 0 ? "+" : "-";
    const abs = Math.abs(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${sign}$${abs}`;
  }

  function pnlSignClass(pnl, _hasData, _includeNeutral = false) {
    const n = pnl != null && Number.isFinite(Number(pnl)) ? Number(pnl) : 0;
    if (n > 0) return "is-positive";
    if (n < 0) return "is-negative";
    return "is-neutral";
  }

  function setPnlSignClass(el, pnl, hasData, includeNeutral = false) {
    el.classList.remove("is-positive", "is-negative", "is-neutral");
    const cls = pnlSignClass(pnl, hasData, includeNeutral);
    if (cls) el.classList.add(cls);
  }

  function appendStatItem(parent, color, value, _hasData) {
    const item = document.createElement("span");
    item.className = "schedule-placement-stat";
    const dot = document.createElement("span");
    dot.className = `schedule-placement-dot schedule-placement-dot-${color}`;
    dot.setAttribute("aria-hidden", "true");
    const count = document.createElement("span");
    count.className = "schedule-placement-stat-count";
    const n = value != null && Number.isFinite(Number(value)) ? Number(value) : 0;
    count.textContent = String(n);
    item.append(dot, count);
    parent.appendChild(item);
  }

  function selectedSeries() {
    return window.getSelectedSeries?.() || "btc-5m";
  }

  function workspaceMode() {
    return window.getScheduleWorkspaceMode?.() || "live";
  }

  function isReplayWorkspace() {
    return workspaceMode() === "replay";
  }

  function seriesQuery() {
    return `series=${encodeURIComponent(selectedSeries())}&mode=${encodeURIComponent(workspaceMode())}`;
  }

  function withSeries(body) {
    return { ...body, series: selectedSeries(), mode: workspaceMode() };
  }

  function statsCacheVersion() {
    return isReplayWorkspace() ? "replay-3" : "live-1";
  }

  function simLatencyMs() {
    if (isReplayWorkspace()) return readReplayLatencyMs();
    if (typeof window.getSimLatencyMs === "function") {
      return window.getSimLatencyMs();
    }
    return DEFAULT_REPLAY_LATENCY_MS;
  }

  function simFillSuccessPct() {
    if (isReplayWorkspace()) return readReplayFillSuccessPct();
    const live = window.getLiveFillSuccessPct?.();
    if (typeof live === "number" && Number.isFinite(live)) {
      return Math.max(0, Math.min(100, live));
    }
    return DEFAULT_REPLAY_FILL_SUCCESS_PCT;
  }

  function setupFingerprint(setupId) {
    const doc = window.getScheduleSetupById?.(setupId);
    if (doc?.setup) return JSON.stringify(doc.setup);
    return `id:${setupId}`;
  }

  /** UTC date — rolling 7-day backtest window shifts daily. */
  function rollingCutoffDayUtc() {
    return new Date().toISOString().slice(0, 10);
  }

  function heatmapVersionForSeries(series) {
    return heatmapSeriesVersions[series] ?? "0";
  }

  function syncHeatmapSeriesVersions(state) {
    if (!state?.seriesDataVersions) return false;
    const series = selectedSeries();
    const prev = heatmapVersionForSeries(series);
    heatmapSeriesVersions = { ...state.seriesDataVersions };
    const next = heatmapVersionForSeries(series);
    return next !== prev;
  }

  function onHeatmapUpdated(state) {
    // Placement card stats are live trade counters (not heatmap backtests).
    // Only track heatmap versions for any future cache keys — do not refetch
    // the active card on every heatmap ingest (that caused stats flicker).
    syncHeatmapSeriesVersions(state);
  }

  function placementCacheKey(placement) {
    return [
      statsCacheVersion(),
      selectedSeries(),
      placement._id,
      placement.day,
      placement.startHour,
      placement.durationHours,
      placement.setupId,
      setupFingerprint(placement.setupId),
      simLatencyMs(),
      simFillSuccessPct(),
      heatmapVersionForSeries(selectedSeries()),
      rollingCutoffDayUtc(),
    ].join("|");
  }

  function readStatsCache() {
    try {
      const raw = localStorage.getItem(STATS_CACHE_STORAGE_KEY);
      if (!raw) return { version: statsCacheVersion(), entries: {} };
      const parsed = JSON.parse(raw);
      if (parsed?.version !== statsCacheVersion() || typeof parsed.entries !== "object") {
        return { version: statsCacheVersion(), entries: {} };
      }
      return parsed;
    } catch {
      return { version: statsCacheVersion(), entries: {} };
    }
  }

  function writeStatsCache(cache) {
    try {
      localStorage.setItem(STATS_CACHE_STORAGE_KEY, JSON.stringify(cache));
    } catch {
      // ignore quota / private mode
    }
  }

  function cachedStatsForPlacement(placement) {
    const cache = readStatsCache();
    const entry = cache.entries?.[placement._id];
    if (!entry?.stats || entry.cacheKey !== placementCacheKey(placement)) return null;
    return entry.stats;
  }

  function saveStatsToCache(statsList) {
    const cache = readStatsCache();
    const liveIds = new Set(placements.map((p) => p._id));
    for (const id of Object.keys(cache.entries)) {
      if (!liveIds.has(id)) delete cache.entries[id];
    }
    for (const stats of statsList) {
      const placement = placements.find((p) => p._id === stats.placementId);
      if (!placement) continue;
      cache.entries[placement._id] = {
        cacheKey: placementCacheKey(placement),
        stats,
        savedAt: Date.now(),
      };
    }
    writeStatsCache(cache);
  }

  function hydrateStatsFromCache(placementIds) {
    const idSet = placementIds ? new Set(placementIds) : null;
    const replay = isReplayWorkspace();
    for (const placement of placements) {
      if (idSet && !idSet.has(placement._id)) continue;
      const cached = cachedStatsForPlacement(placement);
      if (!cached) continue;
      // Replay cards stay editable — never inherit live-style locks from cache.
      if (replay) {
        placementStats.set(placement._id, { ...cached, locked: false });
        continue;
      }
      placementStats.set(placement._id, cached);
      if (cached.locked === true || cached.hasData === true) {
        lockedPlacementIds.add(placement._id);
        placementStats.set(placement._id, { ...cached, locked: true });
      }
    }
  }

  function placementIdsNeedingFetch(placementIds) {
    const ids = [];
    for (const id of placementIds) {
      const placement = placements.find((p) => p._id === id);
      if (!placement) continue;
      if (!cachedStatsForPlacement(placement)) ids.push(id);
    }
    return ids;
  }

  function resolveLoadingPlacementIds(options = {}) {
    const { placementIds, setupId, all } = options;
    if (all) return placements.map((p) => p._id);
    if (setupId) {
      return placements.filter((p) => p.setupId === setupId).map((p) => p._id);
    }
    if (placementIds?.length) return placementIds;
    return placements.map((p) => p._id);
  }

  function mergePendingIds(current, next) {
    if (!current?.length) return next ? [...next] : null;
    if (!next?.length) return [...current];
    const merged = new Set([...current, ...next]);
    return [...merged];
  }

  function removeFromStatsPending(placementId) {
    statsPendingIds.delete(placementId);
  }

  function enqueueStatsFetch(placementIds, options = {}) {
    const force = options.force === true;
    if (options.setupId) statsFetchSetupId = options.setupId;
    else if (force && !options.setupId) statsFetchSetupId = null;
    if (options.quiet === true) statsFetchQuiet = true;
    else if (options.quiet === false) statsFetchQuiet = false;
    let added = false;
    for (const id of placementIds) {
      const placement = placements.find((p) => p._id === id);
      if (!placement) continue;

      const cached = !force ? cachedStatsForPlacement(placement) : null;
      if (cached) {
        placementStats.set(id, cached);
        removeFromStatsPending(id);
        continue;
      }

      if (!statsPendingIds.has(id)) {
        statsPendingIds.add(id);
        added = true;
      }
    }

    applyCardStatsStates();
    if (added && !statsBatchFetching) void processStatsQueue();
  }

  function buildLoadingOverlay() {
    const overlay = document.createElement("div");
    overlay.className = "schedule-placement-loading";
    overlay.setAttribute("aria-hidden", "true");
    const spinner = document.createElement("span");
    spinner.className = "schedule-placement-spinner";
    overlay.appendChild(spinner);
    return overlay;
  }

  const DELETE_CAN_SVG =
    '<svg class="schedule-delete-can-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<g class="schedule-delete-can-lid">' +
    '<path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/>' +
    "</g>" +
    '<g class="schedule-delete-can-body">' +
    '<path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" d="M6.5 7.5l.8 12.2A1.5 1.5 0 0 0 8.8 21h6.4a1.5 1.5 0 0 0 1.5-1.3l.8-12.2"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" d="M10 11v6M14 11v6"/>' +
    "</g>" +
    "</svg>";

  function buildDeleteLoadingOverlay() {
    const overlay = document.createElement("div");
    overlay.className = "schedule-placement-loading schedule-placement-loading--delete";
    overlay.setAttribute("aria-hidden", "true");
    const can = document.createElement("span");
    can.className = "schedule-delete-can";
    can.innerHTML = DELETE_CAN_SVG;
    overlay.appendChild(can);
    return overlay;
  }

  function isLightHexColor(color) {
    const raw = String(color || "").trim();
    const hex = raw.startsWith("#") ? raw.slice(1) : raw;
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return false;
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const toLin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const luminance = 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
    return luminance > 0.55;
  }

  function setupColorFromEl(el) {
    if (!el) return "#58a6ff";
    const fromVar = getComputedStyle(el).getPropertyValue("--setup-color").trim();
    if (fromVar) return fromVar;
    return el.dataset.setupId
      ? window.getSetupColorById?.(el.dataset.setupId) || "#58a6ff"
      : "#58a6ff";
  }

  function setPlacementDeleting(placementId, deleting) {
    const card =
      document.querySelector(
        `.schedule-placement-card[data-placement-id="${CSS.escape(String(placementId))}"]`,
      ) ?? null;
    if (!card) return;
    card.classList.toggle("is-deleting", deleting);
    card.classList.toggle("is-light-setup", false);
    card.querySelector(".schedule-placement-loading--delete")?.remove();
    if (!deleting) return;
    card.classList.toggle("is-light-setup", isLightHexColor(setupColorFromEl(card)));
    // Force paint before the network call so the solid fill + can is visible.
    card.appendChild(buildDeleteLoadingOverlay());
    void card.offsetWidth;
  }

  function cardShowsStats(placementId) {
    return placementStats.has(placementId);
  }

  function cardStatsMuted(placementId) {
    // Replay: never mute — empty slots stay full color (with "No Data" after a run).
    // Live still mutes cards that have no completed stats.
    if (isReplayWorkspace()) return false;
    if (!placementStats.has(placementId)) return true;
    return placementStats.get(placementId)?.hasData !== true;
  }

  function cardStatsShowLoading(placementId) {
    // Only show Replay spinners on the Simulator board — not while viewing Live.
    if (replayRunning && isReplayWorkspace() && !placementStats.has(placementId)) {
      return true;
    }
    return (
      statsBatchFetching &&
      statsPendingIds.has(placementId) &&
      !(statsFetchQuiet && placementStats.has(placementId))
    );
  }

  function applyCardStatsVisualState(card, placementId) {
    // Quiet refreshes (e.g. heatmap version bump) keep existing numbers visible —
    // showing a loading state on the live card makes the red border flicker.
    card.classList.toggle("is-stats-loading", cardStatsShowLoading(placementId));
    card.classList.toggle("is-stats-waiting", false);
    card.classList.toggle("is-stats-muted", cardStatsMuted(placementId));
  }

  function dayColumnTotals(day) {
    if (typeof window.ScheduleHourSlots?.dayTotals === "function") {
      return window.ScheduleHourSlots.dayTotals(day);
    }
    return { hasData: false, pnl: 0, green: 0, red: 0, blue: 0, gray: 0 };
  }

  function updateDayHeaderPnls() {
    const includeGray = isReplayWorkspace();
    for (const day of DAYS) {
      const col = document.querySelector(`.schedule-day-column[data-day="${day}"]`);
      const host = col?.querySelector(".schedule-day-header-stats");
      if (!host) continue;
      const { hasData, pnl, green, red, blue, gray } = dayColumnTotals(day);
      host.replaceChildren();
      const dots = document.createElement("div");
      dots.className = "schedule-placement-stats-dots";
      appendStatItem(dots, "green", green ?? 0, hasData);
      appendStatItem(dots, "red", red ?? 0, hasData);
      appendStatItem(dots, "blue", blue ?? 0, hasData);
      if (includeGray) appendStatItem(dots, "gray", gray ?? 0, hasData);
      const pnlEl = document.createElement("div");
      pnlEl.className = "schedule-placement-pnl";
      pnlEl.textContent = formatPlacementPnl(pnl, hasData);
      setPnlSignClass(pnlEl, pnl, hasData, true);
      host.append(dots, pnlEl);
    }
  }

  function highlightedTotals() {
    let totalPnl = 0;
    let green = 0;
    let red = 0;
    let blue = 0;
    let gray = 0;
    let hasAny = false;

    for (const placementId of framedPlacementIds) {
      if (!cardShowsStats(placementId)) continue;
      const stats = placementStats.get(placementId);
      if (stats?.hasData !== true) continue;
      hasAny = true;
      totalPnl += stats.pnl ?? 0;
      green += stats.green ?? 0;
      red += stats.red ?? 0;
      blue += stats.blue ?? 0;
      gray += stats.gray ?? 0;
    }

    return { hasData: hasAny, pnl: totalPnl, green, red, blue, gray };
  }

  function clearAllFramedPlacements() {
    if (framedPlacementIds.size === 0) return;
    framedPlacementIds.clear();
    applyPlacementFrameStates();
  }

  function updateHighlightedHeaderSummary() {
    const container = document.getElementById("schedule-highlighted-summary");
    if (!container) return;

    const visible = framedPlacementIds.size > 0;
    container.hidden = !visible;
    if (!visible) return;

    const { hasData, pnl, green, red, blue, gray } = highlightedTotals();
    const dotsEl = container.querySelector(".schedule-highlighted-stats-dots");
    const pnlEl = container.querySelector(".schedule-highlighted-pnl");

    container.classList.remove("is-summary-positive", "is-summary-negative", "is-summary-neutral");
    if (!hasData || pnl == null || !Number.isFinite(pnl) || pnl === 0) {
      container.classList.add("is-summary-neutral");
    } else if (pnl > 0) {
      container.classList.add("is-summary-positive");
    } else {
      container.classList.add("is-summary-negative");
    }

    if (dotsEl) {
      dotsEl.replaceChildren();
      appendStatItem(dotsEl, "green", green, hasData);
      appendStatItem(dotsEl, "red", red, hasData);
      appendStatItem(dotsEl, "blue", blue, hasData);
      if (isReplayWorkspace()) {
        appendStatItem(dotsEl, "gray", gray ?? 0, hasData);
      }
    }

    if (pnlEl) {
      pnlEl.textContent = formatPlacementPnl(pnl, hasData);
      setPnlSignClass(pnlEl, pnl, hasData, true);
    }
  }

  function bindHighlightedSummaryClear() {
    const btn = document.getElementById("schedule-highlighted-clear");
    if (!btn || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => clearAllFramedPlacements());
  }

  function weekTotals() {
    if (typeof window.ScheduleHourSlots?.totals === "function") {
      return window.ScheduleHourSlots.totals();
    }
    return { hasData: false, pnl: 0, green: 0, red: 0, blue: 0, gray: 0 };
  }

  const SUMMARY_RANGE_STORAGE_KEY = "poly-real:header-stats-range";
  const DEMO_HITS_STORAGE_KEY = "poly-real:demo-hits";

  let headerSummaryRange = "schedule";
  let headerSummaryFetchTimer = null;
  /** In-flight Market totals fetch (coalesced — see fetchHeaderSummaryTotals). */
  let headerMarketFetchPromise = null;
  let headerMarketFetchSeries = null;
  /** All-time Market totals per series from session-memory. */
  let headerMarketTotals = {};
  /** Full Live-range totals (every real outcome since reset), not just schedule cards. */
  let liveSessionTotals = { hasData: false, green: 0, red: 0, blue: 0, pnl: 0 };
  /** Local-only auto-engine hits (survive page refresh; cleared by reset). */
  let demoHitsStore = { byWindow: {}, totals: { hasData: false, green: 0, red: 0, blue: 0, pnl: 0 } };

  function emptyTotals() {
    return { hasData: false, green: 0, red: 0, blue: 0, pnl: 0 };
  }

  function normalizeSessionTotals(totals) {
    return {
      hasData: totals?.hasData === true || totals?.hasBalance === true,
      green: totals?.green ?? 0,
      red: totals?.red ?? 0,
      blue: totals?.blue ?? 0,
      pnl: totals?.pnl ?? 0,
    };
  }

  function recomputeDemoTotals(byWindow) {
    let green = 0;
    let red = 0;
    let blue = 0;
    let pnl = 0;
    let hasAny = false;
    for (const hit of Object.values(byWindow)) {
      if (!hit) continue;
      hasAny = true;
      green += hit.green ?? 0;
      red += hit.red ?? 0;
      blue += hit.blue ?? 0;
      pnl += hit.pnl ?? 0;
    }
    return { hasData: hasAny, green, red, blue, pnl };
  }

  function demoHitsStorageKey() {
    return typeof window.userScopedStorageKey === "function"
      ? window.userScopedStorageKey(DEMO_HITS_STORAGE_KEY)
      : DEMO_HITS_STORAGE_KEY;
  }

  function loadDemoHitsStore() {
    try {
      const raw =
        localStorage.getItem(demoHitsStorageKey()) ||
        localStorage.getItem(DEMO_HITS_STORAGE_KEY);
      if (!raw) return { byWindow: {}, totals: emptyTotals() };
      const parsed = JSON.parse(raw);
      const byWindow =
        parsed?.byWindow && typeof parsed.byWindow === "object" ? parsed.byWindow : {};
      return { byWindow, totals: recomputeDemoTotals(byWindow) };
    } catch {
      return { byWindow: {}, totals: emptyTotals() };
    }
  }

  function persistDemoHitsStore() {
    try {
      localStorage.setItem(
        demoHitsStorageKey(),
        JSON.stringify({ byWindow: demoHitsStore.byWindow }),
      );
    } catch {
      // ignore quota / private mode
    }
  }

  function classifyDemoLastWindow(lastWindow) {
    if (!lastWindow || lastWindow.plLabel === "No trade") return null;
    const pl = Number(lastWindow.pl) || 0;
    let green = 0;
    let red = 0;
    let blue = 0;
    if (lastWindow.sold) {
      if (pl > 0) green = 1;
      else red = 1;
    } else if (lastWindow.positionWon === true) {
      blue = 1;
    } else if (lastWindow.positionWon === false) {
      red = 1;
    } else {
      return null;
    }
    return { green, red, blue, pnl: pl };
  }

  function shouldCollectDemoHits(trading) {
    const cfg = trading?.config;
    if (!cfg?.autoTrade) return false;
    if (cfg.startTrading) return false;
    if (cfg.useSchedule) return true;
    // Auto Trade without schedule uses the graph phase setup.
    return Boolean(trading?.phaseSetup || trading?.phasesVisible);
  }

  function ingestDemoLastWindow(lastWindow, trading) {
    if (!shouldCollectDemoHits(trading)) return false;
    const hit = classifyDemoLastWindow(lastWindow);
    if (!hit || !lastWindow?.windowKey) return false;
    if (demoHitsStore.byWindow[lastWindow.windowKey]) return false;
    demoHitsStore.byWindow[lastWindow.windowKey] = hit;
    demoHitsStore.totals = recomputeDemoTotals(demoHitsStore.byWindow);
    persistDemoHitsStore();
    return true;
  }

  function clearDemoHitsStore() {
    demoHitsStore = { byWindow: {}, totals: emptyTotals() };
    try {
      localStorage.removeItem(demoHitsStorageKey());
      localStorage.removeItem(DEMO_HITS_STORAGE_KEY);
    } catch {
      // ignore
    }
    if (typeof window.clearDemoPositionCards === "function") {
      window.clearDemoPositionCards();
    }
  }

  function mergeHeaderTotals(a, b) {
    const left = a ?? emptyTotals();
    const right = b ?? emptyTotals();
    return {
      hasData: left.hasData === true || right.hasData === true,
      green: (left.green ?? 0) + (right.green ?? 0),
      red: (left.red ?? 0) + (right.red ?? 0),
      blue: (left.blue ?? 0) + (right.blue ?? 0),
      pnl: (left.pnl ?? 0) + (right.pnl ?? 0),
    };
  }

  /** Live range: real trades since reset + local demo hits since reset. */
  function liveRangeTotals() {
    return mergeHeaderTotals(normalizeSessionTotals(liveSessionTotals), demoHitsStore.totals);
  }

  function scheduleTotals() {
    return weekTotals();
  }

  function applyLiveSessionTotals(totals) {
    if (!totals) return;
    liveSessionTotals = normalizeSessionTotals(totals);
    if (headerSummaryRange === "live") {
      renderHeaderSummaryTotals(liveRangeTotals());
    } else if (headerSummaryRange === "schedule") {
      renderHeaderSummaryTotals(scheduleTotals());
    } else if (headerSummaryRange === "market") {
      scheduleHeaderSummaryRefresh();
    }
  }

  function applyDemoLastWindow(lastWindow, trading) {
    const changed = ingestDemoLastWindow(lastWindow, trading);
    if (changed && headerSummaryRange === "live") {
      renderHeaderSummaryTotals(liveRangeTotals());
    }
  }

  function liveStatsFingerprint(stats) {
    if (!stats) return "";
    return [
      stats.placementId,
      stats.hasData === true ? 1 : 0,
      stats.locked === true ? 1 : 0,
      stats.green ?? 0,
      stats.red ?? 0,
      stats.blue ?? 0,
      stats.pnl ?? 0,
    ].join("|");
  }

  /** Merge live card stats; never flap zeros (hasData) back to dashes. */
  function shouldApplyPlacementStats(prev, next) {
    if (!next?.placementId) return false;
    if (liveStatsFingerprint(prev) === liveStatsFingerprint(next)) return false;
    // Keep armed zeros / fills if a partial snapshot briefly reports empty.
    if (prev?.hasData === true && next.hasData !== true) return false;
    if (prev?.hasData === true && next.hasData === true) {
      const prevHits = (prev.green ?? 0) + (prev.red ?? 0) + (prev.blue ?? 0);
      const nextHits = (next.green ?? 0) + (next.red ?? 0) + (next.blue ?? 0);
      // Don't collapse real fills back to armed-zeros on a flaky snapshot.
      if (prevHits > 0 && nextHits === 0 && Math.abs(next.pnl ?? 0) < 1e-9) return false;
    }
    return true;
  }

  function applyLivePlacementStats(statsList, sessionTotals, demoLastWindow, trading) {
    if (isReplayWorkspace()) return;
    if (sessionTotals) {
      liveSessionTotals = normalizeSessionTotals(sessionTotals);
    }
    if (demoLastWindow !== undefined) {
      ingestDemoLastWindow(demoLastWindow, trading);
    }
    // Hour cells are the Live Schedule board (Trigger Trade aggregates).
    void window.ScheduleHourSlots?.refreshLive?.();
    if (sessionTotals) applyLiveSessionTotals(sessionTotals);
    else if (headerSummaryRange === "live") {
      renderHeaderSummaryTotals(liveRangeTotals());
    } else if (headerSummaryRange === "schedule") {
      renderHeaderSummaryTotals(weekTotals());
    }
  }

  function loadHeaderSummaryPrefs() {
    try {
      const savedRange = localStorage.getItem(SUMMARY_RANGE_STORAGE_KEY);
      if (savedRange === "demo" || savedRange === "all") {
        headerSummaryRange = savedRange === "all" ? "market" : "live";
      } else if (savedRange === "live" || savedRange === "market" || savedRange === "schedule") {
        headerSummaryRange = savedRange;
      } else if (savedRange === "week" || savedRange === "timeframe") {
        // Legacy ranges removed from the dropdown — closest match is Schedule.
        headerSummaryRange = "schedule";
      }
    } catch {
      // ignore
    }
  }

  function saveHeaderSummaryPrefs() {
    try {
      localStorage.setItem(SUMMARY_RANGE_STORAGE_KEY, headerSummaryRange);
    } catch {
      // ignore
    }
  }

  function liveWeekTotals() {
    return liveSessionTotals;
  }

  function renderHeaderSummaryTotals(totals) {
    const container = document.getElementById("schedule-week-summary");
    if (!container) return;
    container.hidden = false;
    const hasData = totals?.hasData === true;
    const pnl = totals?.pnl ?? 0;
    const green = totals?.green ?? 0;
    const red = totals?.red ?? 0;
    const blue = totals?.blue ?? 0;
    const gray = totals?.gray ?? 0;
    const dotsEl = container.querySelector(".schedule-week-stats-dots");
    const pnlEl = container.querySelector(".schedule-week-pnl");

    if (dotsEl) {
      dotsEl.replaceChildren();
      appendStatItem(dotsEl, "green", green, hasData);
      appendStatItem(dotsEl, "red", red, hasData);
      appendStatItem(dotsEl, "blue", blue, hasData);
      if (isReplayWorkspace()) {
        appendStatItem(dotsEl, "gray", gray, hasData);
      }
    }

    if (pnlEl) {
      pnlEl.textContent = formatPlacementPnl(pnl, hasData);
      setPnlSignClass(pnlEl, pnl, hasData);
    }

    // Money bag icon (non-Live ranges) tracks the P/L sign color.
    const resetBtn = document.getElementById("schedule-week-reset");
    if (resetBtn) setPnlSignClass(resetBtn, pnl, hasData);
  }

  async function fetchHeaderSummaryTotals() {
    const mode = headerSummaryRange;

    if (mode === "live") {
      renderHeaderSummaryTotals(liveRangeTotals());
      return liveRangeTotals();
    }
    if (mode === "schedule") {
      const totals = scheduleTotals();
      renderHeaderSummaryTotals(totals);
      return totals;
    }

    // Market (default / unknown → treat as market all-time for selected series).
    const series = selectedSeries();
    const cached = headerMarketTotals[series];
    if (cached) renderHeaderSummaryTotals(cached);

    // Coalesce concurrent fetches: SSE-driven refreshes fire every ~1.5s while the
    // browser's per-host connection pool is busy (SSE streams + polling), so requests
    // can take seconds. Starting a new request per refresh starved the header forever —
    // each retry invalidated the previous response before it could render.
    if (headerMarketFetchPromise && headerMarketFetchSeries === series) {
      return headerMarketFetchPromise;
    }

    const params = new URLSearchParams({ mode: "market", series });
    headerMarketFetchSeries = series;
    headerMarketFetchPromise = (async () => {
      try {
        const res = await fetch(`/api/trading/session-memory?${params}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Session memory failed (${res.status})`);
        }
        const data = await res.json();
        const totals = normalizeSessionTotals({
          hasData: data.hasData === true,
          green: data.green ?? 0,
          red: data.red ?? 0,
          blue: data.blue ?? 0,
          pnl: data.pnl ?? 0,
        });
        headerMarketTotals[series] = totals;
        // A late response is still the right data as long as the user is still
        // looking at Market for this series.
        if (headerSummaryRange === "market" && selectedSeries() === series) {
          renderHeaderSummaryTotals(totals);
        }
        return totals;
      } catch (err) {
        console.warn("Header summary fetch failed:", err);
        if (headerSummaryRange === "market" && selectedSeries() === series) {
          renderHeaderSummaryTotals(headerMarketTotals[series] ?? emptyTotals());
        }
        return null;
      } finally {
        headerMarketFetchPromise = null;
        headerMarketFetchSeries = null;
      }
    })();
    return headerMarketFetchPromise;
  }

  function scheduleHeaderSummaryRefresh() {
    if (headerSummaryRange !== "market") return;
    if (headerSummaryFetchTimer != null) return;
    headerSummaryFetchTimer = window.setTimeout(() => {
      headerSummaryFetchTimer = null;
      void fetchHeaderSummaryTotals();
    }, 1500);
  }

  function updateWeekHeaderSummary() {
    if (headerSummaryRange === "live") {
      renderHeaderSummaryTotals(liveRangeTotals());
      return;
    }
    if (headerSummaryRange === "schedule") {
      renderHeaderSummaryTotals(scheduleTotals());
      return;
    }
    const cached = headerMarketTotals[selectedSeries()];
    if (cached) renderHeaderSummaryTotals(cached);
  }

  /** Reset is a Live-only action; other ranges show a passive money bag icon. */
  function syncHeaderSummaryResetButton() {
    const btn = document.getElementById("schedule-week-reset");
    if (!btn) return;
    const isLive = headerSummaryRange === "live";
    const loading = btn.classList.contains("is-loading");
    btn.classList.toggle("is-money-mode", !isLive);
    // Prefer aria-disabled over the disabled attribute so P/L icon colors are not muted by UA styles.
    btn.disabled = false;
    btn.setAttribute("aria-disabled", isLive && !loading ? "false" : "true");
    btn.tabIndex = isLive && !loading ? 0 : -1;
    if (loading) {
      btn.setAttribute("aria-label", "Loading totals");
      btn.title = "Loading totals";
      return;
    }
    if (isLive) {
      btn.setAttribute("aria-label", "Reset Live counts");
      btn.title = "Reset Live counts (demo + real since last reset)";
    } else {
      btn.setAttribute("aria-label", "Stats totals");
      btn.title = "Totals";
    }
  }

  function setHeaderSummaryLoading(loading) {
    const btn = document.getElementById("schedule-week-reset");
    if (!btn) return;
    btn.classList.toggle("is-loading", loading);
    btn.setAttribute("aria-busy", loading ? "true" : "false");
    syncHeaderSummaryResetButton();
  }

  /** Paint the icon spinner, then load totals for the selected header range. */
  async function refreshHeaderSummaryWithLoader() {
    setHeaderSummaryLoading(true);
    // Two frames so the spinner paints before sync Live/Schedule work.
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    try {
      if (headerSummaryRange === "market") {
        const series = selectedSeries();
        const cached = headerMarketTotals[series];
        if (cached) {
          renderHeaderSummaryTotals(cached);
          setHeaderSummaryLoading(false);
          void fetchHeaderSummaryTotals();
          return;
        }
      }
      await fetchHeaderSummaryTotals();
    } finally {
      setHeaderSummaryLoading(false);
    }
  }

  function syncHeaderSummaryControls() {
    const select = document.getElementById("schedule-summary-range");
    if (!select) return;
    select.value = headerSummaryRange;
    syncHeaderSummaryResetButton();
  }

  function setHeaderSummaryRange(range) {
    const select = document.getElementById("schedule-summary-range");
    if (!select) return;

    const allowed = new Set(["live", "market", "schedule"]);
    const next = allowed.has(range) ? range : headerSummaryRange;

    if (next === headerSummaryRange && select.value === next) return;

    headerSummaryRange = next;
    select.value = next;
    saveHeaderSummaryPrefs();
    syncHeaderSummaryControls();
    void refreshHeaderSummaryWithLoader();
  }

  function onSelectedSeriesChanged() {
    if (headerSummaryRange !== "market") return;
    void refreshHeaderSummaryWithLoader();
  }

  function emptyLiveStats(placementId) {
    return {
      placementId,
      hasData: false,
      green: 0,
      red: 0,
      blue: 0,
      pnl: 0,
    };
  }

  async function resetWeekCounts() {
    try {
      const res = await fetch("/api/trading/positions/clear", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Reset failed (${res.status})`);
      }
    } catch (err) {
      console.warn("Week count reset failed:", err);
      return;
    }

    // Header Live totals only — schedule placement cards keep collecting.
    liveSessionTotals = emptyTotals();
    clearDemoHitsStore();
    if (headerSummaryRange === "live") {
      renderHeaderSummaryTotals(liveRangeTotals());
    } else if (headerSummaryRange === "schedule") {
      renderHeaderSummaryTotals(scheduleTotals());
    } else {
      void fetchHeaderSummaryTotals();
    }
  }

  function bindWeekSummaryReset() {
    const btn = document.getElementById("schedule-week-reset");
    if (!btn || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      if (headerSummaryRange !== "live") return;
      void resetWeekCounts();
    });
    syncHeaderSummaryResetButton();
  }

  function bindHeaderSummaryRange() {
    const select = document.getElementById("schedule-summary-range");
    if (select && select.dataset.bound !== "1") {
      select.dataset.bound = "1";
      select.addEventListener("change", () => {
        const allowed = new Set(["live", "market", "schedule"]);
        headerSummaryRange = allowed.has(select.value) ? select.value : "schedule";
        select.value = headerSummaryRange;
        saveHeaderSummaryPrefs();
        if (headerSummaryFetchTimer != null) {
          window.clearTimeout(headerSummaryFetchTimer);
          headerSummaryFetchTimer = null;
        }
        syncHeaderSummaryControls();
        void refreshHeaderSummaryWithLoader();
      });
    }
    syncHeaderSummaryControls();
  }

  function setHeaderStatsProgress(fraction, options = {}) {
    const wrap = document.getElementById("header-stats-progress");
    const bar = wrap?.querySelector(".header-stats-progress-bar");
    if (!wrap || !bar) return;
    if (fraction == null || !Number.isFinite(fraction) || fraction < 0) {
      if (!options.indeterminate) {
        wrap.hidden = true;
        wrap.setAttribute("aria-hidden", "true");
        wrap.classList.remove("is-indeterminate");
        bar.style.width = "0%";
        bar.style.transform = "";
      }
      return;
    }
    wrap.hidden = false;
    wrap.setAttribute("aria-hidden", "false");
    if (options.indeterminate) {
      wrap.classList.add("is-indeterminate");
      bar.style.width = "";
      bar.style.transform = "";
      return;
    }
    wrap.classList.remove("is-indeterminate");
    bar.style.transform = "";
    bar.style.width = `${Math.min(100, Math.max(0, fraction * 100))}%`;
  }

  function showHeaderStatsProgressIndeterminate() {
    setHeaderStatsProgress(0, { indeterminate: true });
  }

  function hideHeaderStatsProgress() {
    setHeaderStatsProgress(null);
  }

  function closeStatsEventSource() {
    if (statsEventSource) {
      statsEventSource.close();
      statsEventSource = null;
    }
  }

  function fetchStatsWithProgress(series, signal, options = {}) {
    return new Promise((resolve, reject) => {
      closeStatsEventSource();
      const quiet = options.quiet === true;
      if (!quiet) showHeaderStatsProgressIndeterminate();

      let url = `/api/schedule-placement-stats/stream?series=${encodeURIComponent(series)}&mode=${encodeURIComponent(workspaceMode())}`;
      if (options.setupId) {
        url += `&setupId=${encodeURIComponent(options.setupId)}`;
      }
      if (options.placementIds?.length) {
        url += `&placementIds=${encodeURIComponent(options.placementIds.join(","))}`;
      }
      const es = new EventSource(url);
      statsEventSource = es;
      let settled = false;
      let lastProgressFraction = 0;

      const finish = (err, stats) => {
        if (settled) return;
        settled = true;
        closeStatsEventSource();
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        if (err) reject(err);
        else resolve(stats);
      };

      const onAbort = () => {
        closeStatsEventSource();
        finish(new DOMException("Aborted", "AbortError"));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      es.addEventListener("progress", (e) => {
        if (quiet) return;
        try {
          const payload = JSON.parse(e.data);
          const { completed, total, indeterminate } = payload;
          if (indeterminate) {
            showHeaderStatsProgressIndeterminate();
            return;
          }
          if (total > 0) {
            lastProgressFraction = completed / total;
            setHeaderStatsProgress(lastProgressFraction);
          } else if (completed === 0) {
            showHeaderStatsProgressIndeterminate();
          }
        } catch {
          // ignore malformed progress
        }
      });

      es.addEventListener("open", () => {
        if (!quiet) showHeaderStatsProgressIndeterminate();
      });

      es.addEventListener("done", (e) => {
        signal?.removeEventListener("abort", onAbort);
        if (!quiet && lastProgressFraction > 0) {
          setHeaderStatsProgress(Math.min(1, lastProgressFraction));
        }
        try {
          finish(null, JSON.parse(e.data));
        } catch {
          // Empty / malformed done — treat as no stats rather than failing the batch.
          finish(null, []);
        }
      });

      es.addEventListener("failure", (e) => {
        signal?.removeEventListener("abort", onAbort);
        try {
          const body = JSON.parse(e.data);
          finish(new Error(body.error || "Stats stream failed"));
        } catch {
          finish(new Error("Stats stream failed"));
        }
      });

      es.onerror = () => {
        if (settled) return;
        signal?.removeEventListener("abort", onAbort);
        finish(new Error("Stats stream connection failed"));
      };
    });
  }

  function syncReplayNoDataLabel(card, showNoData) {
    card.classList.toggle("is-no-data", showNoData);
    let label = card.querySelector(".schedule-placement-no-data");
    if (showNoData) {
      if (!label) {
        label = document.createElement("div");
        label.className = "schedule-placement-no-data";
        label.textContent = "No Data";
        card.querySelector(".schedule-placement-card-body")?.appendChild(label);
      }
      return;
    }
    label?.remove();
  }

  function applyCardStatsStates() {
    document.querySelectorAll(".schedule-placement-card").forEach((card) => {
      const placementId = card.dataset.placementId;
      const showValues = cardShowsStats(placementId);
      const stats = placementStats.get(placementId);
      const hasData = showValues && stats?.hasData === true;
      // Replay finished with no windows/ticks in this slot.
      const showNoData =
        isReplayWorkspace() && showValues && stats != null && stats.hasData !== true;

      applyCardStatsVisualState(card, placementId);
      syncPlacementLockUi(card, placementId);
      syncReplayNoDataLabel(card, showNoData);

      let overlay = card.querySelector(".schedule-placement-loading");
      const isLoading = cardStatsShowLoading(placementId);
      if (isLoading && !overlay) {
        card.appendChild(buildLoadingOverlay());
      } else if (!isLoading && overlay) {
        overlay.remove();
      }

      const dots = card.querySelector(".schedule-placement-stats-dots");
      const pnlEl = card.querySelector(".schedule-placement-pnl");
      if (dots) {
        dots.replaceChildren();
        if (!showNoData) {
          appendStatItem(dots, "green", stats?.green ?? 0, hasData);
          appendStatItem(dots, "red", stats?.red ?? 0, hasData);
          appendStatItem(dots, "blue", stats?.blue ?? 0, hasData);
          // Replay only: windows that ran with ticks but never triggered a buy.
          if (isReplayWorkspace()) {
            appendStatItem(dots, "gray", stats?.gray ?? 0, hasData);
          }
        }
      }
      if (pnlEl) {
        if (showNoData) {
          pnlEl.textContent = "";
          setPnlSignClass(pnlEl, 0, false);
        } else {
          const pnl = stats?.pnl;
          pnlEl.textContent = formatPlacementPnl(pnl, hasData);
          setPnlSignClass(pnlEl, pnl, hasData);
        }
      }
    });
    updateDayHeaderPnls();
    updateWeekHeaderSummary();
    updateHighlightedHeaderSummary();
    if (framedPlacementIds.size > 0) applyPlacementFrameStates();
  }

  function setupsLoadedForPlacementIds(placementIds) {
    return placementIds.every((id) => {
      const placement = placements.find((p) => p._id === id);
      if (!placement) return true;
      return Boolean(window.getScheduleSetupById?.(placement.setupId)?.setup);
    });
  }

  async function processStatsQueue() {
    if (statsBatchFetching || statsPendingIds.size === 0) return;
    if (placements.length === 0) return;

    const pendingIds = [...statsPendingIds];
    if (!setupsLoadedForPlacementIds(pendingIds)) {
      statsWaitingForSetups = true;
      return;
    }
    statsWaitingForSetups = false;

    statsBatchFetching = true;
    if (statsAbortController) statsAbortController.abort();
    closeStatsEventSource();
    statsAbortController = new AbortController();
    const signal = statsAbortController.signal;
    const series = selectedSeries();

    const setupId = statsFetchSetupId;
    const quiet = statsFetchQuiet && pendingIds.length === 1;
    const allPlacementIds = placements.map((p) => p._id);
    const isPartialFetch =
      pendingIds.length > 0 && pendingIds.length < allPlacementIds.length;
    const placementIds = isPartialFetch ? pendingIds : undefined;

    if (!quiet) showHeaderStatsProgressIndeterminate();
    applyCardStatsStates();

    try {
      const stats = await fetchStatsWithProgress(series, signal, {
        setupId,
        placementIds,
        quiet,
      });
      if (signal.aborted) return;

      for (const stat of stats) {
        if (stat?.locked === true || stat?.hasData === true) {
          lockedPlacementIds.add(stat.placementId);
        }
        const prev = placementStats.get(stat.placementId);
        if (!shouldApplyPlacementStats(prev, stat)) continue;
        placementStats.set(stat.placementId, {
          ...stat,
          locked:
            stat.locked === true ||
            stat.hasData === true ||
            lockedPlacementIds.has(stat.placementId),
        });
      }
      statsPendingIds.clear();
    } catch (err) {
      if (err?.name !== "AbortError") {
        console.error(err);
      }
    } finally {
      statsBatchFetching = false;
      statsFetchSetupId = null;
      statsFetchQuiet = false;
      closeStatsEventSource();
      if (!quiet) hideHeaderStatsProgress();
      if (statsPendingEnqueueIds?.length) {
        const pending = statsPendingEnqueueIds;
        statsPendingEnqueueIds = null;
        enqueueStatsFetch(pending);
      }
      applyCardStatsStates();
    }
  }

  async function scheduleStatsRefresh(options = {}) {
    if (isReplayWorkspace() && !options.fromReplay) {
      applyCardStatsStates();
      return;
    }
    if (placements.length === 0) {
      placementStats.clear();
      lockedPlacementIds.clear();
      statsPendingIds.clear();
      statsBatchFetching = false;
      applyCardStatsStates();
      return;
    }

    // Live trade stats: always refetch (no sim backtest cache).
    const idsToLoad = resolveLoadingPlacementIds(options);
    const needsFetch = idsToLoad.filter((id) => placements.some((p) => p._id === id));
    applyCardStatsStates();

    if (needsFetch.length === 0) {
      statsWaitingForSetups = false;
      return;
    }

    statsPendingEnqueueIds = mergePendingIds(statsPendingEnqueueIds, needsFetch);

    if (!setupsLoadedForPlacementIds(statsPendingEnqueueIds)) {
      statsWaitingForSetups = true;
      applyCardStatsStates();
      return;
    }

    enqueueStatsFetch(statsPendingEnqueueIds, {
      force: options.force === true || options.force == null,
      quiet: options.quiet,
      setupId: options.setupId,
    });
    statsPendingEnqueueIds = null;
  }

  /** @deprecated Use scheduleStatsRefresh — kept for app.js callers */
  async function loadPlacementStats(options = {}) {
    return scheduleStatsRefresh(options);
  }

  function applyStatsToCards() {
    applyCardStatsStates();
  }

  function placementsSignature(list) {
    return JSON.stringify(
      [...list]
        .map((p) => ({
          _id: p._id,
          day: p.day,
          startHour: Number(p.startHour),
          durationHours: Number(p.durationHours),
          setupId: p.setupId,
          title: p.title ?? "",
        }))
        .sort((a, b) => String(a._id).localeCompare(String(b._id))),
    );
  }

  function placementContentKey(p) {
    return `${p.day}|${Number(p.startHour)}|${Number(p.durationHours)}|${p.setupId}|${p.title ?? ""}`;
  }

  function removePlacementCardEl(placementId) {
    document
      .querySelectorAll(`.schedule-placement-card[data-placement-id="${CSS.escape(placementId)}"]`)
      .forEach((el) => el.remove());
  }

  function getPlacementsForSetup(setupId) {
    if (!setupId) return [];
    const id = String(setupId);
    return placements.filter((p) => String(p.setupId) === id);
  }

  function getLockedCountForSetup(setupId) {
    return getPlacementsForSetup(setupId).filter((p) => isPlacementLocked(p._id)).length;
  }

  function getLockedCountForDay(day) {
    return placements.filter((p) => p.day === day && isPlacementLocked(p._id)).length;
  }

  function removePlacementsForSetup(setupId) {
    if (!setupId) return false;
    const id = String(setupId);
    const next = placements.filter((p) => String(p.setupId) !== id);
    if (next.length === placements.length) return false;
    interruptReplayIfRunning("schedule changed");
    return syncPlacementsDom(next);
  }

  /** Apply a new placements list without rebuilding unchanged cards. */
  function syncPlacementsDom(next) {
    const prev = placements;
    const prevById = new Map(prev.map((p) => [p._id, p]));
    const nextById = new Map(next.map((p) => [p._id, p]));
    const affectedDays = new Set();
    const removed = [];
    const added = [];
    const changed = [];

    for (const p of prev) {
      if (!nextById.has(p._id)) {
        removed.push(p);
        affectedDays.add(p.day);
      }
    }
    for (const p of next) {
      const old = prevById.get(p._id);
      if (!old) {
        added.push(p);
        affectedDays.add(p.day);
        continue;
      }
      if (placementContentKey(old) !== placementContentKey(p)) {
        changed.push(p);
        affectedDays.add(old.day);
        affectedDays.add(p.day);
      }
    }

    placements = next;

    if (removed.length === 0 && added.length === 0 && changed.length === 0) {
      return false;
    }

    for (const p of removed) {
      framedPlacementIds.delete(p._id);
      removePlacementFromCache(p._id);
      removePlacementCardEl(p._id);
    }

    for (const p of changed) {
      removePlacementCardEl(p._id);
      const layer = getPlacementLayer(p.day);
      if (layer) layer.appendChild(buildPlacementCard(p));
    }

    for (const p of added) {
      const layer = getPlacementLayer(p.day);
      if (layer) layer.appendChild(buildPlacementCard(p));
    }

    for (const day of affectedDays) {
      refreshDayPlacementEdgeClasses(day);
    }

    // Removals only: never rewrite every card's stats DOM (that flashes the whole board).
    if (added.length > 0 || changed.length > 0) {
      applyCardStatsStates();
    } else {
      updateDayHeaderPnls();
      updateWeekHeaderSummary();
      updateHighlightedHeaderSummary();
      applyPlacementFrameStates();
      syncNowHighlights();
    }
    window.updateSetupListPlacementCounts?.();
    return true;
  }

  function framedGroupsForDay(day) {
    const framed = placements
      .filter((p) => p.day === day && framedPlacementIds.has(p._id))
      .sort((a, b) => a.startHour - b.startHour || a._id.localeCompare(b._id));

    const groups = [];
    for (const placement of framed) {
      const tone = frameToneForPlacement(placement._id);
      const endHour = placement.startHour + placement.durationHours;
      const last = groups.at(-1);
      if (last && last.tone === tone && last.endHour === placement.startHour) {
        last.endHour = endHour;
        last.placementIds.push(placement._id);
      } else {
        groups.push({
          tone,
          startHour: placement.startHour,
          endHour,
          placementIds: [placement._id],
        });
      }
    }
    return groups;
  }

  function renderFramedGroupOverlays() {
    document.querySelectorAll(".schedule-frame-group").forEach((el) => el.remove());
    if (!isSchedulePage() || framedPlacementIds.size === 0) return;

    for (const day of DAYS) {
      const layer = getPlacementLayer(day);
      if (!layer) continue;
      for (const group of framedGroupsForDay(day)) {
        const overlay = document.createElement("div");
        overlay.className = `schedule-frame-group is-frame-group-${group.tone}`;
        overlay.setAttribute("aria-hidden", "true");
        overlay.style.top = `${(group.startHour / 24) * 100}%`;
        overlay.style.height = `${((group.endHour - group.startHour) / 24) * 100}%`;
        layer.appendChild(overlay);
      }
    }
  }

  function frameToneForPlacement(placementId) {
    const stats = placementStats.get(placementId);
    const showValues = cardShowsStats(placementId);
    const hasData = showValues && stats?.hasData === true;
    if (!hasData) return "neutral";

    const green = stats.green ?? 0;
    const red = stats.red ?? 0;
    const blue = stats.blue ?? 0;
    const pnl = stats.pnl;
    const allZero =
      green === 0 &&
      red === 0 &&
      blue === 0 &&
      (pnl == null || !Number.isFinite(pnl) || pnl === 0);
    if (allZero) return "neutral";

    if (pnl != null && Number.isFinite(pnl)) {
      if (pnl > 0) return "positive";
      if (pnl < 0) return "negative";
    }
    return "neutral";
  }

  function togglePlacementFrame(placementId) {
    if (framedPlacementIds.has(placementId)) {
      framedPlacementIds.delete(placementId);
    } else {
      framedPlacementIds.add(placementId);
    }
    applyPlacementFrameStates();
  }

  function applyPlacementFrameStates() {
    document.querySelectorAll(".schedule-placement-card").forEach((card) => {
      const placementId = card.dataset.placementId;
      const isFramed = framedPlacementIds.has(placementId);
      card.classList.toggle("is-framed", isFramed);
      card.classList.remove("is-frame-positive", "is-frame-negative", "is-frame-neutral");
      if (!isFramed) return;

      const tone = frameToneForPlacement(placementId);
      if (tone === "positive") {
        card.classList.add("is-frame-positive");
      } else if (tone === "negative") {
        card.classList.add("is-frame-negative");
      } else {
        card.classList.add("is-frame-neutral");
      }
    });
    renderFramedGroupOverlays();
    updateHighlightedHeaderSummary();
  }

  function renderPlacements(options = {}) {
    const { reloadStats = true, statsOptions } = options;
    if (reloadStats) {
      const idsToLoad = resolveLoadingPlacementIds(statsOptions ?? {});
      hydrateStatsFromCache(idsToLoad);
    }
    DAYS.forEach((day) => {
      const layer = getPlacementLayer(day);
      if (!layer) return;
      layer.replaceChildren();

      const dayPlacements = placements.filter((x) => x.day === day);
      // Always mount every placement (even if the schedule page is hidden).
      // View visibility is CSS-driven so Schedule ↔ Heatmap does not rebuild cards.
      for (const p of dayPlacements) {
        layer.appendChild(buildPlacementCard(p));
      }
    });
    if (reloadStats) {
      void scheduleStatsRefresh(statsOptions ?? {});
    } else {
      applyCardStatsStates();
    }
    applyPlacementFrameStates();
    syncNowHighlights();
    window.updateSetupListPlacementCounts?.();
  }

  function getPlacementCountsBySetup() {
    const counts = {};
    for (const placement of placements) {
      const id = String(placement.setupId || "");
      if (!id) continue;
      counts[id] = (counts[id] || 0) + 1;
    }
    return counts;
  }

  function formatScheduleTime(hours) {
    const totalMinutes = Math.round(hours * 60);
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  function isPlacementLocked(placementId) {
    if (isReplayWorkspace()) return false;
    if (!placementId) return false;
    if (lockedPlacementIds.has(placementId)) return true;
    const stats = placementStats.get(placementId);
    return stats?.locked === true || stats?.hasData === true;
  }

  const PLACEMENT_DRAG_HANDLE_SVG =
    '<svg viewBox="0 0 8 14" aria-hidden="true"><circle cx="2" cy="2" r="1.2" fill="currentColor"/><circle cx="6" cy="2" r="1.2" fill="currentColor"/><circle cx="2" cy="7" r="1.2" fill="currentColor"/><circle cx="6" cy="7" r="1.2" fill="currentColor"/><circle cx="2" cy="12" r="1.2" fill="currentColor"/><circle cx="6" cy="12" r="1.2" fill="currentColor"/></svg>';
  const PLACEMENT_LOCK_HANDLE_SVG =
    '<svg viewBox="0 0 12 14" aria-hidden="true"><path fill="currentColor" d="M6 1.5a2.75 2.75 0 0 0-2.75 2.75V6H2.5A1.5 1.5 0 0 0 1 7.5v4A1.5 1.5 0 0 0 2.5 13h7A1.5 1.5 0 0 0 11 11.5v-4A1.5 1.5 0 0 0 9.5 6H8.75V4.25A2.75 2.75 0 0 0 6 1.5zm-1.25 2.75A1.25 1.25 0 0 1 6 3a1.25 1.25 0 0 1 1.25 1.25V6h-2.5V4.25z"/></svg>';

  function syncPlacementLockUi(card, placementId) {
    if (!card) return;
    const locked = isPlacementLocked(placementId);
    card.classList.toggle("is-locked", locked);
    const handle = card.querySelector(".schedule-placement-drag-handle");
    if (!handle) return;
    if (locked) {
      handle.classList.add("is-lock-icon");
      handle.setAttribute("aria-label", "Locked after first window");
      handle.title = "Locked — started at least one window";
      handle.innerHTML = PLACEMENT_LOCK_HANDLE_SVG;
    } else {
      handle.classList.remove("is-lock-icon");
      handle.setAttribute("aria-label", "Drag to move");
      handle.title = "Drag to move";
      handle.innerHTML = PLACEMENT_DRAG_HANDLE_SVG;
    }
  }

  function buildPlacementCard(placement) {
    const endHour = placement.startHour + placement.durationHours;
    const dayOthers = placements.filter((x) => x.day === placement.day && x._id !== placement._id);
    const hasPlacementAbove = dayOthers.some((p) => p.startHour + p.durationHours === placement.startHour);
    const hasPlacementBelow = dayOthers.some((p) => p.startHour === endHour);

    const card = document.createElement("div");
    const isShort = placement.durationHours < 2;
    const isCompact = placement.durationHours < 1.5;
    const locked = isPlacementLocked(placement._id);
    card.className = "schedule-placement-card";
    if (hasPlacementAbove) card.classList.add("has-placement-above");
    if (hasPlacementBelow) card.classList.add("has-placement-below");
    if (isShort) card.classList.add("is-short");
    if (isCompact) card.classList.add("is-compact");
    if (moveDragState?.placementId === placement._id) card.classList.add("is-move-source");
    if (framedPlacementIds.has(placement._id)) card.classList.add("is-framed");
    if (locked) card.classList.add("is-locked");
    card.dataset.placementId = placement._id;
    card.dataset.setupId = placement.setupId;
    card.style.top = `${(placement.startHour / 24) * 100}%`;
    card.style.height = `${(placement.durationHours / 24) * 100}%`;
    card.style.setProperty("--duration-hours", String(placement.durationHours));
    const setupColor = window.getSetupColorById?.(placement.setupId) || "#58a6ff";
    card.style.setProperty("--setup-color", setupColor);

    const dragHandle = document.createElement("div");
    dragHandle.className = "schedule-placement-drag-handle";
    if (locked) {
      dragHandle.classList.add("is-lock-icon");
      dragHandle.setAttribute("aria-label", "Locked after first window");
      dragHandle.title = "Locked — started at least one window";
      dragHandle.innerHTML = PLACEMENT_LOCK_HANDLE_SVG;
    } else {
      dragHandle.setAttribute("aria-label", "Drag to move");
      dragHandle.title = "Drag to move";
      dragHandle.innerHTML = PLACEMENT_DRAG_HANDLE_SVG;
      dragHandle.addEventListener("mousedown", (e) => startMoveDrag(e, placement._id));
    }

    const cardBody = document.createElement("div");
    cardBody.className = "schedule-placement-card-body";

    const resizeTop = document.createElement("div");
    resizeTop.className = "schedule-placement-resize schedule-placement-resize-top";
    resizeTop.title = "Resize start";

    const resizeBottom = document.createElement("div");
    resizeBottom.className = "schedule-placement-resize schedule-placement-resize-bottom";
    resizeBottom.title = "Resize end";

    const topBand = document.createElement("div");
    topBand.className = "schedule-placement-hour-band schedule-placement-hour-band-top";

    const startCell = document.createElement("div");
    startCell.className = "schedule-placement-band-cell schedule-placement-start-cell";
    const startTime = document.createElement("div");
    startTime.className = "schedule-placement-time";
    startTime.textContent = formatScheduleTime(placement.startHour);
    startCell.appendChild(startTime);

    const menuCell = document.createElement("div");
    menuCell.className = "schedule-placement-band-cell schedule-placement-menu-cell";

    const menuWrap = document.createElement("div");
    menuWrap.className = "schedule-placement-menu-wrap";

    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "schedule-placement-menu-btn";
    menuBtn.setAttribute("aria-label", "Placement options");
    menuBtn.setAttribute("aria-haspopup", "menu");
    menuBtn.setAttribute("aria-expanded", "false");
    menuBtn.innerHTML = "&#8942;";

    menuBtn.addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });

    menuBtn.addEventListener("dblclick", (e) => {
      e.stopPropagation();
    });

    menuBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (openMenuId === placement._id) {
        closeMenus();
        return;
      }
      closeMenus();
      openMenuId = placement._id;
      menuBtn.setAttribute("aria-expanded", "true");
      const menu = document.createElement("div");
      menu.className = "schedule-placement-menu schedule-placement-menu-floating";
      menu.dataset.placementId = placement._id;
      menu.setAttribute("role", "menu");
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "schedule-placement-menu-item";
      removeBtn.setAttribute("role", "menuitem");
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void removePlacement(placement._id);
      });

      const showValues = cardShowsStats(placement._id);
      const stats = placementStats.get(placement._id);
      const canPlay = isReplayWorkspace() && showValues && stats?.hasData === true;
      if (canPlay) {
        const playMenuBtn = document.createElement("button");
        playMenuBtn.type = "button";
        playMenuBtn.className = "schedule-placement-menu-item";
        playMenuBtn.setAttribute("role", "menuitem");
        playMenuBtn.textContent = "Open";
        playMenuBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          closeMenus();
          const hint =
            (stats?.green ?? 0) +
            (stats?.red ?? 0) +
            (stats?.blue ?? 0) +
            (stats?.gray ?? 0);
          window.SchedulePlay?.open?.(placement._id, {
            windowCountHint: hint,
            latencyMs: readReplayLatencyMs(),
            fillSuccessPct: readReplayFillSuccessPct(),
            prediction: null,
            triggers: window.ScheduleReplayTriggers?.listForRun?.() ?? [],
            series: placement.series || selectedSeries(),
            setup: null,
          });
        });
        menu.appendChild(playMenuBtn);
      }
      menu.appendChild(removeBtn);
      document.body.appendChild(menu);
      positionPlacementMenu(menu, menuBtn);
    });

    menuWrap.appendChild(menuBtn);
    menuCell.appendChild(menuWrap);
    if (!isCompact) topBand.appendChild(startCell);
    topBand.appendChild(menuCell);

    const bottomBand = document.createElement("div");
    bottomBand.className = "schedule-placement-hour-band schedule-placement-hour-band-bottom";
    const endCell = document.createElement("div");
    endCell.className = "schedule-placement-band-cell";
    const endTime = document.createElement("div");
    endTime.className = "schedule-placement-time";
    endTime.textContent = formatScheduleTime(endHour);
    endCell.appendChild(endTime);
    bottomBand.appendChild(endCell);

    const middleBand = document.createElement("div");
    middleBand.className = "schedule-placement-hour-band schedule-placement-hour-band-middle";

    const statsCell = document.createElement("div");
    statsCell.className = "schedule-placement-band-cell schedule-placement-stats-cell";
    const dots = document.createElement("div");
    dots.className = "schedule-placement-stats-dots";
    const stats = placementStats.get(placement._id);
    const isLoading = statsBatchFetching && statsPendingIds.has(placement._id);
    const showValues = cardShowsStats(placement._id);
    const hasData = showValues && stats?.hasData === true;
    const showNoData =
      isReplayWorkspace() && showValues && stats != null && stats.hasData !== true;
    if (!showNoData) {
      appendStatItem(dots, "green", stats?.green ?? 0, hasData);
      appendStatItem(dots, "red", stats?.red ?? 0, hasData);
      appendStatItem(dots, "blue", stats?.blue ?? 0, hasData);
      if (isReplayWorkspace()) {
        appendStatItem(dots, "gray", stats?.gray ?? 0, hasData);
      }
    }
    statsCell.appendChild(dots);

    const pnlCell = document.createElement("div");
    pnlCell.className = "schedule-placement-band-cell schedule-placement-pnl-cell";
    const pnl = document.createElement("div");
    pnl.className = "schedule-placement-pnl";
    if (!showNoData) {
      const pnlValue = stats?.pnl;
      pnl.textContent = formatPlacementPnl(pnlValue, hasData);
      setPnlSignClass(pnl, pnlValue, hasData);
    }
    pnlCell.appendChild(pnl);

    middleBand.append(statsCell, pnlCell);

    cardBody.append(resizeTop, topBand, middleBand);
    if (!isShort) cardBody.appendChild(bottomBand);
    cardBody.appendChild(resizeBottom);

    card.append(dragHandle, cardBody);

    card.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePlacementFrame(placement._id);
    });

    applyCardStatsVisualState(card, placement._id);
    syncReplayNoDataLabel(card, showNoData);
    if (isLoading) card.appendChild(buildLoadingOverlay());

    resizeTop.addEventListener("mousedown", (e) => startResize(e, placement._id, "top"));
    resizeBottom.addEventListener("mousedown", (e) => startResize(e, placement._id, "bottom"));

    return card;
  }

  function removePlacementFromCache(placementId) {
    removeFromStatsPending(placementId);
    placementStats.delete(placementId);
    lockedPlacementIds.delete(placementId);
    const cache = readStatsCache();
    if (!cache.entries?.[placementId]) return;
    delete cache.entries[placementId];
    writeStatsCache(cache);
  }

  /** Update abutting-edge classes for cards on one day without rebuilding the layer. */
  function refreshDayPlacementEdgeClasses(day) {
    const dayPlacements = placements.filter((x) => x.day === day);
    for (const p of dayPlacements) {
      const card = document.querySelector(
        `.schedule-placement-card[data-placement-id="${CSS.escape(p._id)}"]`,
      );
      if (!card) continue;
      const endHour = p.startHour + p.durationHours;
      const others = dayPlacements.filter((x) => x._id !== p._id);
      const hasAbove = others.some((o) => o.startHour + o.durationHours === p.startHour);
      const hasBelow = others.some((o) => o.startHour === endHour);
      card.classList.toggle("has-placement-above", hasAbove);
      card.classList.toggle("has-placement-below", hasBelow);
    }
  }

  async function removePlacement(id) {
    closeMenus();
    const card = document.querySelector(
      `.schedule-placement-card[data-placement-id="${CSS.escape(String(id))}"]`,
    );
    if (card?.classList.contains("is-deleting")) return;

    interruptReplayIfRunning("schedule changed");
    const placement = placements.find((p) => p._id === id);
    const locked = isPlacementLocked(id);
    if (locked) {
      const title = placement?.title ? `"${placement.title}"` : "this card";
      const confirmed = window.confirm(
        `Remove ${title} from the schedule?\n\nIt is locked (already traded). This cannot be undone.`,
      );
      if (!confirmed) return;
    }

    setPlacementDeleting(id, true);
    // Let the solid fill + can paint before the delete request.
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    try {
      const res = await fetch(
        `/api/schedule-placements/${encodeURIComponent(id)}?${seriesQuery()}`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== 204) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Remove failed (${res.status})`);
      }
      syncPlacementsDom(placements.filter((p) => p._id !== id));
    } catch (err) {
      console.error(err);
      setPlacementDeleting(id, false);
    }
  }

  function startResize(e, placementId, edge) {
    if (!isScheduleView()) return;
    if (framedPlacementIds.has(placementId)) return;
    if (isPlacementLocked(placementId)) return;
    e.preventDefault();
    e.stopPropagation();
    const placement = placements.find((p) => p._id === placementId);
    if (!placement) return;
    resizeState = {
      placementId,
      edge,
      startHour: placement.startHour,
      durationHours: placement.durationHours,
      endTime: placement.startHour + placement.durationHours,
      day: placement.day,
    };
    document.body.classList.add("is-schedule-resizing");
  }

  function updateResizePreview(clientY) {
    if (!resizeState) return;
    const body = getDayBody(resizeState.day);
    if (!body) return;
    const placement = placements.find((p) => p._id === resizeState.placementId);
    if (!placement) return;

    let startHour = resizeState.startHour;
    let durationHours = resizeState.durationHours;

    if (resizeState.edge === "top") {
      const snappedStart = startTimeFromPointer(body, clientY);
      startHour = Math.min(snappedStart, resizeState.endTime - MIN_DURATION);
      durationHours = resizeState.endTime - startHour;
    } else {
      const snappedEnd = endTimeFromPointer(body, clientY);
      const endTime = Math.max(snappedEnd, resizeState.startHour + MIN_DURATION);
      durationHours = endTime - resizeState.startHour;
    }

    if (!canPlace(resizeState.day, startHour, durationHours, resizeState.placementId)) return;

    placement.startHour = startHour;
    placement.durationHours = durationHours;
    renderPlacements({ reloadStats: false });
  }

  async function commitResize() {
    if (!resizeState) return;
    const placement = placements.find((p) => p._id === resizeState.placementId);
    resizeState = null;
    document.body.classList.remove("is-schedule-resizing");
    if (!placement) return;

    interruptReplayIfRunning("schedule changed");
    try {
      const res = await fetch(
        `/api/schedule-placements/${encodeURIComponent(placement._id)}?${seriesQuery()}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            withSeries({
              day: placement.day,
              startHour: placement.startHour,
              durationHours: placement.durationHours,
            }),
          ),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Update failed (${res.status})`);
      }
      const updated = await res.json();
      placements = placements.map((p) => (p._id === updated._id ? updated : p));
      renderPlacements({ statsOptions: { placementIds: [updated._id] } });
    } catch (err) {
      console.error(err);
      await loadPlacements();
    }
  }

  function startMoveDrag(e, placementId) {
    if (!isScheduleView()) return;
    if (framedPlacementIds.has(placementId)) return;
    if (isPlacementLocked(placementId)) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    closeMenus();
    const placement = placements.find((p) => p._id === placementId);
    if (!placement) return;
    moveDragState = {
      placementId,
      setupId: placement.setupId,
      durationHours: placement.durationHours,
      preview: null,
    };
    document.body.classList.add("is-schedule-moving");
    cardFromPlacementId(placementId)?.classList.add("is-move-source");
  }

  function cardFromPlacementId(placementId) {
    return document.querySelector(`.schedule-placement-card[data-placement-id="${placementId}"]`);
  }

  function updateMoveDragPreview(clientX, clientY) {
    if (!moveDragState) return;
    const el = document.elementFromPoint(clientX, clientY);
    const day = dayFromElement(el);
    clearDropPreview();
    if (!day) return;
    const body = getDayBody(day);
    if (!body) return;
    const dropTime = startTimeFromPointer(body, clientY);
    const proposal = findMovePlacement(
      day,
      dropTime,
      moveDragState.durationHours,
      moveDragState.placementId,
    );
    if (proposal) {
      moveDragState.preview = proposal;
      showDropPreview(proposal.day, proposal.startHour, proposal.durationHours, moveDragState.setupId);
    } else {
      moveDragState.preview = null;
    }
  }

  async function commitMove() {
    if (!moveDragState) return;
    const { placementId, preview } = moveDragState;
    moveDragState = null;
    clearDropPreview();
    document.body.classList.remove("is-schedule-moving");

    const placement = placements.find((p) => p._id === placementId);
    if (!placement || !preview) {
      renderPlacements({ reloadStats: false });
      return;
    }

    if (
      placement.day === preview.day &&
      placement.startHour === preview.startHour &&
      placement.durationHours === preview.durationHours
    ) {
      renderPlacements({ reloadStats: false });
      return;
    }

    interruptReplayIfRunning("schedule changed");
    try {
      const res = await fetch(
        `/api/schedule-placements/${encodeURIComponent(placementId)}?${seriesQuery()}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            withSeries({
              day: preview.day,
              startHour: preview.startHour,
              durationHours: preview.durationHours,
            }),
          ),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Move failed (${res.status})`);
      }
      const updated = await res.json();
      placements = placements.map((p) => (p._id === updated._id ? updated : p));
      renderPlacements({ statsOptions: { placementIds: [updated._id] } });
    } catch (err) {
      console.error(err);
      await loadPlacements();
    }
  }

  function startDragFromList(e, setupId, title) {
    if (!isScheduleView()) return;
    if (e.button !== 0) return;
    e.preventDefault();
    const item = e.currentTarget?.closest?.(".schedule-setup-item") ?? null;
    const list = document.getElementById("schedule-setups-list");
    if (!item || !list) return;
    listDragState = {
      setupId,
      title,
      item,
      list,
      startX: e.clientX,
      startY: e.clientY,
      mode: null,
      orderChanged: false,
      placeholder: null,
      offsetX: 0,
      offsetY: 0,
      itemHeight: 0,
      originIds: [...list.querySelectorAll(".schedule-setup-item")].map((el) => el.dataset.setupId),
    };
  }

  function clearFloatingListItemStyles(item) {
    if (!item) return;
    item.classList.remove("is-list-reordering");
    item.style.left = "";
    item.style.top = "";
    item.style.width = "";
  }

  function isListItemFloating(item) {
    return Boolean(item?.classList.contains("is-list-reordering") && item.parentNode === document.body);
  }

  function settleFloatingListItem() {
    if (!listDragState?.item) return;
    const { list, item, placeholder } = listDragState;
    if (placeholder?.parentNode) {
      placeholder.parentNode.insertBefore(item, placeholder);
      placeholder.remove();
    } else if (item.parentNode !== list) {
      list.appendChild(item);
    }
    listDragState.placeholder = null;
    clearFloatingListItemStyles(item);
    document.body.classList.remove("is-schedule-list-reordering");
  }

  function positionFloatingListItem(clientX, clientY) {
    if (!listDragState?.item || !isListItemFloating(listDragState.item)) return;
    const { item, offsetX, offsetY } = listDragState;
    item.style.left = `${clientX - offsetX}px`;
    item.style.top = `${clientY - offsetY}px`;
  }

  function makeListPlaceholder(heightPx) {
    const placeholder = document.createElement("div");
    placeholder.className = "schedule-setup-reorder-placeholder";
    placeholder.style.height = `${Math.max(36, heightPx || 0)}px`;
    return placeholder;
  }

  /** Rebuild list in origin order with a gap where the floating card belongs. */
  function rebuildListWithOriginPlaceholder(list, orderedIds, floatingId, heightPx) {
    const byId = new Map(
      [...list.querySelectorAll(".schedule-setup-item")].map((el) => [el.dataset.setupId, el]),
    );
    list.replaceChildren();
    let placeholder = null;
    for (const id of orderedIds) {
      if (id === floatingId) {
        placeholder = makeListPlaceholder(heightPx);
        list.appendChild(placeholder);
        continue;
      }
      const el = byId.get(id);
      if (el) list.appendChild(el);
    }
    if (!placeholder) {
      placeholder = makeListPlaceholder(heightPx);
      list.appendChild(placeholder);
    }
    return placeholder;
  }

  function liftListItem(clientX, clientY) {
    if (!listDragState) return;
    const { list, item } = listDragState;
    if (isListItemFloating(item)) {
      positionFloatingListItem(clientX, clientY);
      return;
    }
    const rect = item.getBoundingClientRect();
    const placeholder = makeListPlaceholder(rect.height);
    list.insertBefore(placeholder, item);

    listDragState.placeholder = placeholder;
    listDragState.offsetX = clientX - rect.left;
    listDragState.offsetY = clientY - rect.top;
    listDragState.itemHeight = rect.height;

    item.classList.add("is-list-reordering");
    item.style.width = `${rect.width}px`;
    document.body.appendChild(item);
    positionFloatingListItem(clientX, clientY);
    document.body.classList.add("is-schedule-list-reordering");
  }

  function beginListReorderMode(clientX, clientY) {
    if (!listDragState || listDragState.mode === "reorder") return;

    // Returning from the schedule column — keep the float, clear place preview.
    if (listDragState.mode === "place") {
      dragState = null;
      clearDropPreview();
      clearHeaderFillPreview();
      document.body.classList.remove("is-schedule-dragging");
      listDragState.mode = "reorder";
      document.body.classList.add("is-schedule-list-reordering");
      positionFloatingListItem(clientX, clientY);
      return;
    }

    listDragState.mode = "reorder";
    liftListItem(clientX, clientY);
  }

  function beginListPlaceMode(clientX, clientY) {
    if (!listDragState || listDragState.mode === "place") return;
    const { list, item, originIds, setupId } = listDragState;

    if (listDragState.mode === "reorder") {
      if (listDragState.placeholder?.parentNode) {
        listDragState.placeholder.remove();
      }
      listDragState.placeholder = rebuildListWithOriginPlaceholder(
        list,
        originIds,
        setupId,
        listDragState.itemHeight || item.getBoundingClientRect().height,
      );
      listDragState.orderChanged = false;
      if (!isListItemFloating(item)) {
        liftListItem(clientX, clientY);
      } else {
        positionFloatingListItem(clientX, clientY);
        document.body.classList.add("is-schedule-list-reordering");
      }
    } else {
      liftListItem(clientX, clientY);
    }

    listDragState.mode = "place";
    dragState = {
      setupId: listDragState.setupId,
      title: listDragState.title,
      preview: null,
      headerDay: null,
      headerWeek: false,
    };
    document.body.classList.add("is-schedule-dragging");
    positionFloatingListItem(clientX, clientY);
  }

  function restoreListOrder(list, orderedIds) {
    if (!list || !orderedIds?.length) return;
    const byId = new Map(
      [...list.querySelectorAll(".schedule-setup-item")].map((el) => [el.dataset.setupId, el]),
    );
    for (const id of orderedIds) {
      const el = byId.get(id);
      if (el) list.appendChild(el);
    }
  }

  function updateListReorder(clientX, clientY) {
    if (!listDragState || listDragState.mode !== "reorder") return;
    const { list, item, placeholder } = listDragState;
    if (!placeholder) return;
    positionFloatingListItem(clientX, clientY);

    const siblings = [...list.querySelectorAll(".schedule-setup-item")].filter((el) => el !== item);
    let inserted = false;
    for (const sibling of siblings) {
      const rect = sibling.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (clientY < mid) {
        if (placeholder.nextElementSibling !== sibling) {
          list.insertBefore(placeholder, sibling);
          listDragState.orderChanged = true;
        }
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      const last = list.lastElementChild;
      if (last !== placeholder) {
        list.appendChild(placeholder);
        listDragState.orderChanged = true;
      }
    }
  }

  function resolveListDragMode(clientX, clientY) {
    if (!listDragState || listDragState.mode) return;
    const dx = clientX - listDragState.startX;
    const dy = clientY - listDragState.startY;
    if (Math.hypot(dx, dy) < 6) return;

    const listRect = listDragState.list.getBoundingClientRect();
    const inListColumn = clientX <= listRect.right + 24 && clientX >= listRect.left - 8;
    if (inListColumn) {
      beginListReorderMode(clientX, clientY);
      updateListReorder(clientX, clientY);
      return;
    }
    beginListPlaceMode(clientX, clientY);
    updateDragPreview(clientX, clientY);
  }

  function updatePendingListDrag(clientX, clientY) {
    if (!listDragState) return;
    if (!listDragState.mode) {
      resolveListDragMode(clientX, clientY);
      return;
    }
    const listRect = listDragState.list.getBoundingClientRect();
    if (listDragState.mode === "reorder") {
      // Dragging out of the column onto the calendar switches to place mode.
      if (clientX > listRect.right + 36) {
        beginListPlaceMode(clientX, clientY);
        updateDragPreview(clientX, clientY);
        return;
      }
      updateListReorder(clientX, clientY);
      return;
    }
    // Place mode: dragging back into the side list resumes reorder.
    if (clientX <= listRect.right + 12 && clientX >= listRect.left - 8) {
      beginListReorderMode(clientX, clientY);
      updateListReorder(clientX, clientY);
      return;
    }
    positionFloatingListItem(clientX, clientY);
    updateDragPreview(clientX, clientY);
  }

  async function commitListReorder() {
    if (!listDragState) return;
    const { list, originIds, orderChanged } = listDragState;
    settleFloatingListItem();
    const orderedIds = [...list.querySelectorAll(".schedule-setup-item")].map(
      (el) => el.dataset.setupId,
    );
    listDragState = null;

    if (!orderChanged) return;
    const unchanged =
      orderedIds.length === originIds.length &&
      orderedIds.every((id, i) => id === originIds[i]);
    if (unchanged) return;

    try {
      const res = await fetch(
        `/api/trading-setups/reorder?mode=${encodeURIComponent(workspaceMode())}`,
        {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds, mode: workspaceMode() }),
      },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Reorder failed (${res.status})`);
      }
      const setups = await res.json();
      if (typeof window.applyScheduleSetupsOrder === "function") {
        window.applyScheduleSetupsOrder(setups);
      } else if (typeof window.refreshScheduleSetupsList === "function") {
        void window.refreshScheduleSetupsList();
      }
    } catch (err) {
      console.error(err);
      restoreListOrder(list, originIds);
      if (typeof window.refreshScheduleSetupsList === "function") {
        void window.refreshScheduleSetupsList();
      }
    }
  }

  function endFloatingListPlace() {
    if (!listDragState) return;
    const { list, originIds } = listDragState;
    settleFloatingListItem();
    restoreListOrder(list, originIds);
    listDragState = null;
  }

  async function commitListDrag() {
    if (!listDragState) return;
    const mode = listDragState.mode;
    if (mode === "reorder") {
      await commitListReorder();
      return;
    }
    if (mode === "place") {
      endFloatingListPlace();
      await commitDrop();
      return;
    }
    // Click without meaningful drag — cancel.
    listDragState = null;
  }

  function cancelListDrag() {
    if (!listDragState) return;
    if (listDragState.mode === "reorder" || listDragState.mode === "place") {
      const { list, originIds } = listDragState;
      settleFloatingListItem();
      restoreListOrder(list, originIds);
    }
    if (listDragState.mode === "place" || dragState) {
      dragState = null;
      clearDropPreview();
      clearHeaderFillPreview();
      document.body.classList.remove("is-schedule-dragging");
    }
    listDragState = null;
  }

  function updateDragPreview(clientX, clientY) {
    if (!dragState) return;
    const el = document.elementFromPoint(clientX, clientY);
    clearDropPreview();
    dragState.preview = null;
    dragState.headerDay = null;
    dragState.headerWeek = false;

    const utcHeader = el?.closest?.(".schedule-utc-header");
    if (utcHeader) {
      if (DAYS.some((day) => busyDays.has(day))) {
        clearHeaderFillPreview();
        return;
      }
      dragState.headerWeek = true;
      showWeekFillPreview(dragState.setupId);
      return;
    }

    const day = dayFromElement(el);
    if (!day || busyDays.has(day)) {
      clearHeaderFillPreview();
      return;
    }
    const header = el?.closest?.(".schedule-day-header");
    if (header) {
      dragState.headerDay = day;
      showHeaderFillPreview(day, dragState.setupId);
      return;
    }
    clearHeaderFillPreview();
    const body = getDayBody(day);
    if (!body) return;
    const dropTime = startTimeFromPointer(body, clientY);
    const proposal = findDropPlacement(day, dropTime);
    if (proposal) {
      dragState.preview = proposal;
      showDropPreview(proposal.day, proposal.startHour, proposal.durationHours, dragState.setupId);
    } else {
      dragState.preview = null;
    }
  }

  async function commitDrop() {
    if (!dragState?.preview && !dragState?.headerDay && !dragState?.headerWeek) {
      dragState = null;
      clearDropPreview();
      clearHeaderFillPreview();
      document.body.classList.remove("is-schedule-dragging");
      return;
    }

    const { setupId, title, preview, headerDay, headerWeek } = dragState;
    dragState = null;
    clearDropPreview();
    clearHeaderFillPreview();
    document.body.classList.remove("is-schedule-dragging");

    interruptReplayIfRunning("schedule changed");
    if (headerWeek) {
      await fillWeek(setupId, title);
      return;
    }
    if (headerDay) {
      await fillDay(headerDay, setupId, title);
      return;
    }

    try {
      const res = await fetch("/api/schedule-placements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withSeries({
            setupId,
            title,
            day: preview.day,
            startHour: preview.startHour,
            durationHours: preview.durationHours,
          }),
        ),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Place failed (${res.status})`);
      }
      const created = await res.json();
      placements.push(created);
      renderPlacements({ statsOptions: { placementIds: [created._id] } });
      if (typeof window.refreshScheduleSetupsList === "function") {
        void window.refreshScheduleSetupsList();
      }
    } catch (err) {
      console.error(err);
    }
  }

  function bindGlobalPointer() {
    window.addEventListener("mousemove", (e) => {
      if (listDragState) updatePendingListDrag(e.clientX, e.clientY);
      else if (dragState) updateDragPreview(e.clientX, e.clientY);
      if (moveDragState) updateMoveDragPreview(e.clientX, e.clientY);
      if (resizeState) updateResizePreview(e.clientY);
    });

    window.addEventListener("mouseup", () => {
      if (listDragState) void commitListDrag();
      else if (dragState) void commitDrop();
      if (moveDragState) void commitMove();
      if (resizeState) void commitResize();
    });

    window.addEventListener("blur", () => {
      if (listDragState) {
        cancelListDrag();
      } else if (dragState) {
        dragState = null;
        clearDropPreview();
        clearHeaderFillPreview();
        document.body.classList.remove("is-schedule-dragging");
      }
      if (moveDragState) {
        moveDragState = null;
        clearDropPreview();
        document.body.classList.remove("is-schedule-moving");
        renderPlacements({ reloadStats: false });
      }
      if (resizeState) {
        resizeState = null;
        document.body.classList.remove("is-schedule-resizing");
        void loadPlacements();
      }
    });

    document.addEventListener("click", (e) => {
      if (
        !e.target.closest(".schedule-placement-menu-btn") &&
        !e.target.closest(".schedule-placement-menu") &&
        !e.target.closest(".schedule-placement-menu-wrap")
      ) {
        closeMenus();
      }
    });
  }

  function bindSetupItem(item, setup) {
    const handle = item.querySelector(".schedule-setup-drag-handle");
    if (!handle) return;
    handle.addEventListener("mousedown", (e) => startDragFromList(e, setup._id, setup.title));
  }

  function onSetupsRendered(setups) {
    document.querySelectorAll(".schedule-setup-item").forEach((item) => {
      const setupId = item.dataset.setupId;
      const setup = setups.find((s) => s._id === setupId);
      if (setup) bindSetupItem(item, setup);
    });
    if (statsWaitingForSetups && isScheduleView() && placements.length > 0) {
      void scheduleStatsRefresh();
    }
  }

  async function loadPlacements(options = {}) {
    const expectedMode = options.expectedMode || workspaceMode();
    try {
      const res = await fetch(`/api/schedule-placements?${seriesQuery()}`);
      if (workspaceMode() !== expectedMode) return;
      if (!res.ok) {
        placements = [];
        renderPlacements({ reloadStats: false });
        return;
      }
      const next = await res.json();
      if (workspaceMode() !== expectedMode) return;
      placements = Array.isArray(next) ? next : [];
      const reloadStats =
        options.reloadStats !== false && !isReplayWorkspace();
      renderPlacements({
        reloadStats,
        statsOptions: options.statsOptions,
      });
      if (isReplayWorkspace() && options.reloadStats !== false) {
        applyCardStatsStates();
        updateWeekHeaderSummary();
        updateHighlightedHeaderSummary();
      }
    } catch {
      if (workspaceMode() !== expectedMode) return;
      placements = [];
      renderPlacements({ reloadStats: false });
    }
  }

  function clearWorkspaceBoard() {
    closeMenus();
    clearDropPreview();
    clearHeaderFillPreview();
    if (statsAbortController) {
      try {
        statsAbortController.abort();
      } catch {
        // ignore
      }
    }
    closeStatsEventSource();
    placementStats.clear();
    lockedPlacementIds.clear();
    framedPlacementIds.clear();
    statsPendingIds.clear();
    statsBatchFetching = false;
    syncPlacementsDom([]);
    if (!isReplayWorkspace() || activeReplayStats.size === 0) {
      window.ScheduleHourSlots?.clearAll?.();
    }
    updateWeekHeaderSummary();
    updateHighlightedHeaderSummary();
    syncNowHighlights();
  }

  function restoreActiveReplayStatsToBoard() {
    if (!isReplayWorkspace() || activeReplayStats.size === 0) return;
    // Rebuild synthetic hour placements so ids resolve after workspace toggle.
    if (
      !placements.length &&
      typeof window.ScheduleHourSlots?.buildTriggerOnlyReplayBoard === "function"
    ) {
      placements = window.ScheduleHourSlots.buildTriggerOnlyReplayBoard(selectedSeries()).placements;
    }
    for (const [placementId, stats] of activeReplayStats) {
      placementStats.set(placementId, { ...stats });
      window.ScheduleHourSlots?.applyReplayPlacementStat?.(stats);
    }
    applyCardStatsStates();
    window.ScheduleHourSlots?.paint?.();
  }

  async function onWorkspaceModeChanged(mode) {
    // Keep a running Replay alive across Live ↔ Simulator toggles.
    const expectedMode = mode || workspaceMode();
    clearWorkspaceBoard();
    placements = [];
    if (expectedMode === "replay") {
      setHeaderSummaryRange("schedule");
      lockedPlacementIds.clear();
      restoreActiveReplayStatsToBoard();
      syncReplayPredictionTotalsUi();
      syncReplayPredictionAreaUi();
      if (replayRunning) showHeaderStatsProgressIndeterminate();
      else hideHeaderStatsProgress();
      window.ScheduleHourSlots?.paint?.();
    } else {
      hideHeaderStatsProgress();
      window.ScheduleHourSlots?.clearAll?.();
      void window.ScheduleHourSlots?.refreshLive?.();
    }
    syncHeaderSummaryControls();
    updateDayHeaderPnls();
    updateWeekHeaderSummary();
    updateHighlightedHeaderSummary();
    syncNowHighlights();
    syncReplayRunButton();
  }

  function parseSseChunk(buffer, onEvent) {
    let rest = buffer;
    let sep;
    while ((sep = rest.indexOf("\n\n")) >= 0) {
      const raw = rest.slice(0, sep);
      rest = rest.slice(sep + 2);
      let event = "message";
      const dataLines = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          // SSE: optional single space after "data:"
          const payload = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
          dataLines.push(payload);
        }
      }
      if (dataLines.length === 0) continue;
      const dataText = dataLines.join("\n");
      let parsed;
      try {
        parsed = JSON.parse(dataText);
      } catch (parseErr) {
        // Never abort the whole Replay for one bad chunk — log and continue.
        window.appendLogEntry?.({
          level: "warn",
          source: "client",
          message: `Replay SSE skipped bad ${event} chunk: ${parseErr?.message || parseErr}`,
        });
        continue;
      }
      try {
        onEvent(event, parsed);
      } catch (handlerErr) {
        window.appendLogEntry?.({
          level: "warn",
          source: "client",
          message: `Replay SSE handler error (${event}): ${handlerErr?.message || handlerErr}`,
        });
      }
    }
    return rest;
  }

  function applyReplayPlacementStat(stats) {
    if (!stats?.placementId) return;
    const next = {
      placementId: stats.placementId,
      hasData: stats.hasData === true,
      green: stats.green ?? 0,
      red: stats.red ?? 0,
      blue: stats.blue ?? 0,
      gray: stats.gray ?? 0,
      pnl: stats.pnl ?? 0,
      predictionRight: stats.predictionRight ?? 0,
      predictionWrong: stats.predictionWrong ?? 0,
      locked: false,
    };
    activeReplayStats.set(stats.placementId, next);
    window.ScheduleReplayTriggers?.accumulatePlacementTriggerStats?.(stats.triggerStats);
    // Update the visible board only while Simulator is active.
    if (!isReplayWorkspace()) return;
    placementStats.set(stats.placementId, { ...next });
    window.ScheduleHourSlots?.applyReplayPlacementStat?.(next);
    applyCardStatsStates();
    updateDayHeaderPnls();
    updateWeekHeaderSummary();
    updateHighlightedHeaderSummary();
    syncReplayPredictionTotalsUi();
  }

  /**
   * Only after a full Replay finishes: mark cards that never got a result as no-data.
   * Do NOT call this on Stop/abort — that made Sat/Sun look “done with zeros” while still unsimulated.
   */
  function finalizeReplayCardStats() {
    for (const placementId of activeReplayPlacementIds) {
      if (activeReplayStats.has(placementId)) continue;
      activeReplayStats.set(placementId, {
        placementId,
        hasData: false,
        green: 0,
        red: 0,
        blue: 0,
        gray: 0,
        pnl: 0,
        predictionRight: 0,
        predictionWrong: 0,
        locked: false,
      });
    }
    if (!isReplayWorkspace()) return;
    restoreActiveReplayStatsToBoard();
    updateWeekHeaderSummary();
    updateHighlightedHeaderSummary();
    syncReplayPredictionTotalsUi();
  }

  function clearReplayLoadingOnly() {
    if (!isReplayWorkspace()) return;
    applyCardStatsStates();
    updateWeekHeaderSummary();
    updateHighlightedHeaderSummary();
  }

  let replayRunning = false;
  /** Frozen Latency / Fill success / Prediction for the in-flight run (null when idle). */
  let replayRunLockedLatencyMs = null;
  let replayRunLockedFillSuccessPct = null;
  /** @type {{ enabled: boolean, maxQuoteCents: number, minQuoteCents: number, shiftCents: number, riseCents: number, sensitivitySec: number, areaStart: number, areaEnd: number } | null} */
  let replayRunLockedPrediction = null;
  let replayPredictionAreaStart = DEFAULT_REPLAY_PREDICTION.areaStart;
  let replayPredictionAreaEnd = DEFAULT_REPLAY_PREDICTION.areaEnd;
  /** @type {"start" | "end" | null} */
  let replayPredictionAreaDrag = null;
  /** @type {AbortController | null} */
  let replayAbort = null;
  let replayStopReason = null;
  /** Survives Live ↔ Simulator toggles while a Replay is in flight / finished. */
  let activeReplayStats = new Map();
  /** Placement IDs included in the current Replay run. */
  let activeReplayPlacementIds = new Set();

  const REPLAY_SPIN_ICON =
    '<svg class="schedule-replay-spin-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3.5 12a8.5 8.5 0 0 1 14.3-6.2L21 9"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M21 3v6h-6"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M20.5 12a8.5 8.5 0 0 1-14.3 6.2L3 15"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 21v-6h6"/>' +
    "</svg>";

  function readReplayLatencyMs() {
    const input = document.getElementById("schedule-replay-latency-input");
    const raw = input ? Number(input.value) : Number.NaN;
    if (!Number.isFinite(raw)) return DEFAULT_REPLAY_LATENCY_MS;
    return Math.max(0, Math.min(10000, Math.floor(raw)));
  }

  function persistReplayLatencyMs(ms) {
    try {
      localStorage.setItem(REPLAY_LATENCY_STORAGE_KEY, String(ms));
    } catch {
      // ignore
    }
  }

  function readReplayFillSuccessPct() {
    const input = document.getElementById("schedule-replay-fill-success-input");
    const raw = input ? Number(input.value) : Number.NaN;
    if (!Number.isFinite(raw)) return DEFAULT_REPLAY_FILL_SUCCESS_PCT;
    return Math.max(0, Math.min(100, raw));
  }

  function persistReplayFillSuccessPct(pct) {
    try {
      localStorage.setItem(REPLAY_FILL_SUCCESS_STORAGE_KEY, String(pct));
    } catch {
      // ignore
    }
  }

  function seriesWindowDurationSec() {
    const series = selectedSeries();
    const match = String(series).match(/(\d+)\s*m\b/i);
    if (match) return Math.max(60, Number(match[1]) * 60);
    return 300;
  }

  function normalizeReplayPredictionArea(startRaw, endRaw) {
    let start = Number(startRaw);
    let end = Number(endRaw);
    if (!Number.isFinite(start)) start = DEFAULT_REPLAY_PREDICTION.areaStart;
    if (!Number.isFinite(end)) end = DEFAULT_REPLAY_PREDICTION.areaEnd;
    start = Math.max(0, Math.min(1, start));
    end = Math.max(0, Math.min(1, end));
    const minSpan = 0.02;
    if (end - start < minSpan) {
      if (start > 1 - minSpan) {
        start = 1 - minSpan;
        end = 1;
      } else {
        end = Math.min(1, start + minSpan);
      }
    }
    return { areaStart: start, areaEnd: end };
  }

  function normalizeReplayPredictionMaxQuote(value) {
    const n = Math.round(Number(value));
    return Math.max(1, Math.min(99, Number.isFinite(n) ? n : DEFAULT_REPLAY_PREDICTION.maxQuoteCents));
  }

  function normalizeReplayPredictionMinQuote(value) {
    const n = Math.round(Number(value));
    return Math.max(1, Math.min(99, Number.isFinite(n) ? n : DEFAULT_REPLAY_PREDICTION.minQuoteCents));
  }

  function normalizeReplayPredictionQuoteBand(minRaw, maxRaw) {
    const maxQuoteCents = normalizeReplayPredictionMaxQuote(maxRaw);
    let minQuoteCents = normalizeReplayPredictionMinQuote(minRaw);
    if (minQuoteCents > maxQuoteCents) minQuoteCents = maxQuoteCents;
    return { minQuoteCents, maxQuoteCents };
  }

  function normalizeReplayPredictionShift(value) {
    const n = Math.round(Number(value));
    return Math.max(1, Math.min(50, Number.isFinite(n) ? n : DEFAULT_REPLAY_PREDICTION.shiftCents));
  }

  function normalizeReplayPredictionRise(value) {
    const n = Math.round(Number(value));
    return Math.max(1, Math.min(50, Number.isFinite(n) ? n : DEFAULT_REPLAY_PREDICTION.riseCents));
  }

  function normalizeReplayPredictionSensitivity(value) {
    const n = Math.round(Number(value));
    return Math.max(1, Math.min(120, Number.isFinite(n) ? n : DEFAULT_REPLAY_PREDICTION.sensitivitySec));
  }

  function fmtReplayPredictionAreaTime(frac, durationSec = seriesWindowDurationSec()) {
    const total = Math.max(0, Math.round(Number(frac) * Number(durationSec)));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function replayPredThumbLeftCss(frac) {
    const f = Math.max(0, Math.min(1, Number(frac) || 0));
    return `calc(${f} * (100% - ${REPLAY_PRED_THUMB_PX}px))`;
  }

  function replayPredThumbCenterCss(frac) {
    const f = Math.max(0, Math.min(1, Number(frac) || 0));
    return `calc(${f} * (100% - ${REPLAY_PRED_THUMB_PX}px) + ${REPLAY_PRED_THUMB_PX / 2}px)`;
  }

  function isReplayPredictionEnabled() {
    if (!document.getElementById("schedule-replay-prediction")) return false;
    if (replayRunLockedPrediction) return Boolean(replayRunLockedPrediction.enabled);
    const toggle = document.getElementById("replay-prediction-enabled");
    return toggle ? Boolean(toggle.checked) : false;
  }

  function normalizeReplayPredictionShares(value) {
    const n = Math.floor(Number(value));
    return Math.max(
      1,
      Math.min(100000, Number.isFinite(n) && n > 0 ? n : DEFAULT_REPLAY_PREDICTION.shares),
    );
  }

  function normalizeReplayPredictionOrderType(value) {
    return value === "FAK" || value === "FOK" ? value : DEFAULT_REPLAY_PREDICTION.buyOrderType;
  }

  function readReplayPredictionConfig() {
    if (replayRunLockedPrediction) {
      return { ...replayRunLockedPrediction };
    }
    const maxQuoteInput = document.getElementById("replay-prediction-max-quote");
    const minQuoteInput = document.getElementById("replay-prediction-min-quote");
    const shiftInput = document.getElementById("replay-prediction-shift");
    const riseInput = document.getElementById("replay-prediction-rise");
    const durationInput = document.getElementById("replay-prediction-duration");
    const sharesInput = document.getElementById("replay-prediction-shares");
    const buyTypeSelect = document.getElementById("replay-prediction-buy-order-type");
    const sellTypeSelect = document.getElementById("replay-prediction-sell-order-type");
    const area = normalizeReplayPredictionArea(
      replayPredictionAreaStart,
      replayPredictionAreaEnd,
    );
    const quotes = normalizeReplayPredictionQuoteBand(
      minQuoteInput?.value,
      maxQuoteInput?.value,
    );
    return {
      enabled: isReplayPredictionEnabled(),
      maxQuoteCents: quotes.maxQuoteCents,
      minQuoteCents: quotes.minQuoteCents,
      shiftCents: normalizeReplayPredictionShift(shiftInput?.value),
      riseCents: normalizeReplayPredictionRise(riseInput?.value),
      sensitivitySec: normalizeReplayPredictionSensitivity(durationInput?.value),
      shares: normalizeReplayPredictionShares(sharesInput?.value),
      buyOrderType: normalizeReplayPredictionOrderType(buyTypeSelect?.value),
      sellOrderType: normalizeReplayPredictionOrderType(sellTypeSelect?.value),
      areaStart: area.areaStart,
      areaEnd: area.areaEnd,
    };
  }

  /** Payload for Run / Open: settings object when On, null when Off. */
  function replayPredictionRequestBody() {
    const config = readReplayPredictionConfig();
    if (!config.enabled) return null;
    return {
      maxQuoteCents: config.maxQuoteCents,
      minQuoteCents: config.minQuoteCents,
      shiftCents: config.shiftCents,
      riseCents: config.riseCents,
      sensitivitySec: config.sensitivitySec,
      shares: config.shares,
      buyOrderType: config.buyOrderType,
      sellOrderType: config.sellOrderType,
      areaStart: config.areaStart,
      areaEnd: config.areaEnd,
    };
  }

  function persistReplayPredictionConfig(config) {
    const quotes = normalizeReplayPredictionQuoteBand(
      config?.minQuoteCents,
      config?.maxQuoteCents,
    );
    const next = {
      enabled: config?.enabled == null ? isReplayPredictionEnabled() : Boolean(config.enabled),
      maxQuoteCents: quotes.maxQuoteCents,
      minQuoteCents: quotes.minQuoteCents,
      shiftCents: normalizeReplayPredictionShift(config?.shiftCents),
      riseCents: normalizeReplayPredictionRise(config?.riseCents),
      sensitivitySec: normalizeReplayPredictionSensitivity(config?.sensitivitySec),
      shares: normalizeReplayPredictionShares(config?.shares),
      buyOrderType: normalizeReplayPredictionOrderType(config?.buyOrderType),
      sellOrderType: normalizeReplayPredictionOrderType(config?.sellOrderType),
      ...normalizeReplayPredictionArea(config?.areaStart, config?.areaEnd),
    };
    try {
      localStorage.setItem(REPLAY_PREDICTION_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
    return next;
  }

  function syncReplayPredictionAreaUi() {
    const area = normalizeReplayPredictionArea(
      replayPredictionAreaStart,
      replayPredictionAreaEnd,
    );
    replayPredictionAreaStart = area.areaStart;
    replayPredictionAreaEnd = area.areaEnd;
    const durationSec = seriesWindowDurationSec();
    const range = document.getElementById("replay-prediction-area-range");
    const startThumb = document.getElementById("replay-prediction-area-start");
    const endThumb = document.getElementById("replay-prediction-area-end");
    const startLabel = document.getElementById("replay-prediction-area-start-label");
    const endLabel = document.getElementById("replay-prediction-area-end-label");
    const span = Math.max(0, replayPredictionAreaEnd - replayPredictionAreaStart);
    if (range) {
      range.style.left = replayPredThumbCenterCss(replayPredictionAreaStart);
      range.style.width = `calc(${span} * (100% - ${REPLAY_PRED_THUMB_PX}px))`;
    }
    if (startThumb) startThumb.style.left = replayPredThumbLeftCss(replayPredictionAreaStart);
    if (endThumb) endThumb.style.left = replayPredThumbLeftCss(replayPredictionAreaEnd);
    if (startLabel) {
      startLabel.textContent = fmtReplayPredictionAreaTime(replayPredictionAreaStart, durationSec);
      startLabel.style.left = replayPredThumbCenterCss(replayPredictionAreaStart);
    }
    if (endLabel) {
      endLabel.textContent = fmtReplayPredictionAreaTime(replayPredictionAreaEnd, durationSec);
      endLabel.style.left = replayPredThumbCenterCss(replayPredictionAreaEnd);
    }
  }

  function syncReplayPredictionTotalsUi() {
    let right = 0;
    let wrong = 0;
    for (const stats of activeReplayStats.values()) {
      right += Number(stats?.predictionRight) || 0;
      wrong += Number(stats?.predictionWrong) || 0;
    }
    const rightEl = document.getElementById("replay-prediction-right");
    const wrongEl = document.getElementById("replay-prediction-wrong");
    if (rightEl) rightEl.textContent = String(right);
    if (wrongEl) wrongEl.textContent = String(wrong);
  }

  function resetReplayPredictionTotalsUi() {
    const rightEl = document.getElementById("replay-prediction-right");
    const wrongEl = document.getElementById("replay-prediction-wrong");
    if (rightEl) rightEl.textContent = "0";
    if (wrongEl) wrongEl.textContent = "0";
  }

  function applyReplayPredictionInputsFromConfig(config) {
    const quotes = normalizeReplayPredictionQuoteBand(
      config?.minQuoteCents,
      config?.maxQuoteCents,
    );
    const next = {
      enabled: config?.enabled == null ? true : Boolean(config.enabled),
      maxQuoteCents: quotes.maxQuoteCents,
      minQuoteCents: quotes.minQuoteCents,
      shiftCents: normalizeReplayPredictionShift(config?.shiftCents),
      riseCents: normalizeReplayPredictionRise(config?.riseCents),
      sensitivitySec: normalizeReplayPredictionSensitivity(config?.sensitivitySec),
      shares: normalizeReplayPredictionShares(config?.shares),
      buyOrderType: normalizeReplayPredictionOrderType(config?.buyOrderType),
      sellOrderType: normalizeReplayPredictionOrderType(config?.sellOrderType),
      ...normalizeReplayPredictionArea(config?.areaStart, config?.areaEnd),
    };
    const toggle = document.getElementById("replay-prediction-enabled");
    const maxQuoteInput = document.getElementById("replay-prediction-max-quote");
    const minQuoteInput = document.getElementById("replay-prediction-min-quote");
    const shiftInput = document.getElementById("replay-prediction-shift");
    const riseInput = document.getElementById("replay-prediction-rise");
    const durationInput = document.getElementById("replay-prediction-duration");
    const sharesInput = document.getElementById("replay-prediction-shares");
    const buyTypeSelect = document.getElementById("replay-prediction-buy-order-type");
    const sellTypeSelect = document.getElementById("replay-prediction-sell-order-type");
    if (toggle) toggle.checked = next.enabled;
    if (maxQuoteInput) maxQuoteInput.value = String(next.maxQuoteCents);
    if (minQuoteInput) minQuoteInput.value = String(next.minQuoteCents);
    if (shiftInput) shiftInput.value = String(next.shiftCents);
    if (riseInput) riseInput.value = String(next.riseCents);
    if (durationInput) durationInput.value = String(next.sensitivitySec);
    if (sharesInput) sharesInput.value = String(next.shares);
    if (buyTypeSelect) buyTypeSelect.value = next.buyOrderType;
    if (sellTypeSelect) sellTypeSelect.value = next.sellOrderType;
    replayPredictionAreaStart = next.areaStart;
    replayPredictionAreaEnd = next.areaEnd;
    syncReplayPredictionAreaUi();
    syncReplayPredictionEnabledUi();
    return next;
  }

  function syncReplayPredictionEnabledUi() {
    const enabled = isReplayPredictionEnabled();
    const root = document.getElementById("schedule-replay-prediction");
    const settings = document.getElementById("schedule-replay-prediction-settings");
    const label = document.getElementById("replay-prediction-label");
    const toggle = document.getElementById("replay-prediction-enabled");
    const maxQuoteInput = document.getElementById("replay-prediction-max-quote");
    const minQuoteInput = document.getElementById("replay-prediction-min-quote");
    const shiftInput = document.getElementById("replay-prediction-shift");
    const riseInput = document.getElementById("replay-prediction-rise");
    const durationInput = document.getElementById("replay-prediction-duration");
    const sharesInput = document.getElementById("replay-prediction-shares");
    const buyTypeSelect = document.getElementById("replay-prediction-buy-order-type");
    const sellTypeSelect = document.getElementById("replay-prediction-sell-order-type");
    const startThumb = document.getElementById("replay-prediction-area-start");
    const endThumb = document.getElementById("replay-prediction-area-end");
    root?.classList.toggle("is-disabled", !enabled);
    if (settings) settings.setAttribute("aria-hidden", enabled ? "false" : "true");
    if (label) label.textContent = enabled ? "Prediction · On" : "Prediction · Off";
    const settingsLocked = !enabled || replayRunning;
    for (const input of [
      maxQuoteInput,
      minQuoteInput,
      shiftInput,
      riseInput,
      durationInput,
      sharesInput,
      buyTypeSelect,
      sellTypeSelect,
    ]) {
      if (!input) continue;
      input.disabled = settingsLocked;
      input.setAttribute("aria-disabled", settingsLocked ? "true" : "false");
    }
    if (startThumb) startThumb.disabled = settingsLocked;
    if (endThumb) endThumb.disabled = settingsLocked;
    if (toggle) {
      toggle.disabled = replayRunning;
      toggle.setAttribute("aria-disabled", replayRunning ? "true" : "false");
    }
  }

  function markReplayInputUserEdited(input) {
    if (input) input.dataset.userEdited = "1";
  }

  /** Prefill Latency / Fill success from live metrics unless the user edited them. */
  function syncReplayInputsFromLive() {
    if (!isReplayWorkspace() || replayRunning) return;

    const latencyInput = document.getElementById("schedule-replay-latency-input");
    if (latencyInput && latencyInput.dataset.userEdited !== "1") {
      const liveMs = window.getSimLatencyMs?.();
      if (Number.isFinite(liveMs)) {
        const ms = Math.max(0, Math.min(10000, Math.floor(liveMs)));
        if (latencyInput.value !== String(ms)) {
          latencyInput.value = String(ms);
          persistReplayLatencyMs(ms);
        }
      }
    }

    const fillInput = document.getElementById("schedule-replay-fill-success-input");
    if (fillInput && fillInput.dataset.userEdited !== "1") {
      const livePct = window.getLiveFillSuccessPct?.();
      if (typeof livePct === "number" && Number.isFinite(livePct)) {
        const pct = Math.max(0, Math.min(100, Math.round(livePct * 10) / 10));
        if (fillInput.value !== String(pct)) {
          fillInput.value = String(pct);
          persistReplayFillSuccessPct(pct);
        }
      }
    }
  }

  function applyReplayRunLockedInputs() {
    const latencyInput = document.getElementById("schedule-replay-latency-input");
    const fillInput = document.getElementById("schedule-replay-fill-success-input");
    if (latencyInput && replayRunLockedLatencyMs != null) {
      latencyInput.value = String(replayRunLockedLatencyMs);
    }
    if (fillInput && replayRunLockedFillSuccessPct != null) {
      fillInput.value = String(replayRunLockedFillSuccessPct);
    }
    if (replayRunLockedPrediction) {
      applyReplayPredictionInputsFromConfig(replayRunLockedPrediction);
    }
  }

  function setReplayInputsLocked(locked) {
    const controls = document.getElementById("schedule-replay-controls");
    controls?.classList.toggle("is-locked", locked);
    const latencyInput = document.getElementById("schedule-replay-latency-input");
    const fillInput = document.getElementById("schedule-replay-fill-success-input");
    for (const input of [latencyInput, fillInput]) {
      if (!input) continue;
      input.disabled = locked;
      input.setAttribute("aria-disabled", locked ? "true" : "false");
    }
    window.ScheduleReplayTriggers?.setLocked?.(locked);
    if (locked) applyReplayRunLockedInputs();
    syncReplayPredictionEnabledUi();
  }

  function bindReplayPredictionAreaSlider() {
    const track = document
      .getElementById("replay-prediction-area-slider")
      ?.querySelector(".manipulation-area-track");
    if (!track || track.dataset.bound === "1") return;
    track.dataset.bound = "1";

    const fracFromEvent = (event) => {
      const rect = track.getBoundingClientRect();
      const travel = rect.width - REPLAY_PRED_THUMB_PX;
      if (travel <= 0) return 0;
      return Math.max(0, Math.min(1, (event.clientX - rect.left - REPLAY_PRED_THUMB_PX / 2) / travel));
    };

    const onMove = (event) => {
      if (!replayPredictionAreaDrag || replayRunning || !isReplayPredictionEnabled()) return;
      const frac = fracFromEvent(event);
      if (replayPredictionAreaDrag === "start") {
        replayPredictionAreaStart = Math.min(frac, replayPredictionAreaEnd - 0.02);
      } else {
        replayPredictionAreaEnd = Math.max(frac, replayPredictionAreaStart + 0.02);
      }
      syncReplayPredictionAreaUi();
    };

    const onUp = () => {
      if (!replayPredictionAreaDrag) return;
      replayPredictionAreaDrag = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (replayRunning || !isReplayPredictionEnabled()) {
        applyReplayRunLockedInputs();
        return;
      }
      persistReplayPredictionConfig(readReplayPredictionConfig());
    };

    for (const thumb of track.querySelectorAll("[data-thumb]")) {
      thumb.addEventListener("pointerdown", (event) => {
        if (replayRunning || thumb.disabled || !isReplayPredictionEnabled()) return;
        event.preventDefault();
        replayPredictionAreaDrag =
          thumb.getAttribute("data-thumb") === "end" ? "end" : "start";
        thumb.setPointerCapture?.(event.pointerId);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
    }
  }

  function initReplayPredictionInputs() {
    // Prediction footer removed — keep helpers as no-ops when DOM is absent.
    if (!document.getElementById("schedule-replay-prediction")) return;
    let stored = null;
    try {
      const raw = localStorage.getItem(REPLAY_PREDICTION_STORAGE_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
    applyReplayPredictionInputsFromConfig(stored || DEFAULT_REPLAY_PREDICTION);

    const enabledToggle = document.getElementById("replay-prediction-enabled");
    const maxQuoteInput = document.getElementById("replay-prediction-max-quote");
    const minQuoteInput = document.getElementById("replay-prediction-min-quote");
    const shiftInput = document.getElementById("replay-prediction-shift");
    const riseInput = document.getElementById("replay-prediction-rise");
    const durationInput = document.getElementById("replay-prediction-duration");
    if (enabledToggle && enabledToggle.dataset.bound !== "1") {
      enabledToggle.dataset.bound = "1";
      enabledToggle.addEventListener("change", () => {
        if (replayRunning) {
          applyReplayRunLockedInputs();
          return;
        }
        persistReplayPredictionConfig(readReplayPredictionConfig());
        syncReplayPredictionEnabledUi();
      });
    }
    const bindQuoteInput = (input) => {
      if (!input || input.dataset.bound === "1") return;
      input.dataset.bound = "1";
      const commit = () => {
        if (replayRunning || input.disabled || !isReplayPredictionEnabled()) {
          applyReplayRunLockedInputs();
          return;
        }
        const next = persistReplayPredictionConfig(readReplayPredictionConfig());
        if (maxQuoteInput) maxQuoteInput.value = String(next.maxQuoteCents);
        if (minQuoteInput) minQuoteInput.value = String(next.minQuoteCents);
      };
      input.addEventListener("change", commit);
      input.addEventListener("blur", commit);
      input.addEventListener("input", () => {
        if (replayRunning || input.disabled) applyReplayRunLockedInputs();
      });
    };
    bindQuoteInput(maxQuoteInput);
    bindQuoteInput(minQuoteInput);
    if (shiftInput && shiftInput.dataset.bound !== "1") {
      shiftInput.dataset.bound = "1";
      const commit = () => {
        if (replayRunning || shiftInput.disabled || !isReplayPredictionEnabled()) {
          applyReplayRunLockedInputs();
          return;
        }
        const next = persistReplayPredictionConfig(readReplayPredictionConfig());
        shiftInput.value = String(next.shiftCents);
      };
      shiftInput.addEventListener("change", commit);
      shiftInput.addEventListener("blur", commit);
      shiftInput.addEventListener("input", () => {
        if (replayRunning || shiftInput.disabled) applyReplayRunLockedInputs();
      });
    }
    if (riseInput && riseInput.dataset.bound !== "1") {
      riseInput.dataset.bound = "1";
      const commit = () => {
        if (replayRunning || riseInput.disabled || !isReplayPredictionEnabled()) {
          applyReplayRunLockedInputs();
          return;
        }
        const next = persistReplayPredictionConfig(readReplayPredictionConfig());
        riseInput.value = String(next.riseCents);
      };
      riseInput.addEventListener("change", commit);
      riseInput.addEventListener("blur", commit);
      riseInput.addEventListener("input", () => {
        if (replayRunning || riseInput.disabled) applyReplayRunLockedInputs();
      });
    }
    if (durationInput && durationInput.dataset.bound !== "1") {
      durationInput.dataset.bound = "1";
      const commit = () => {
        if (replayRunning || durationInput.disabled || !isReplayPredictionEnabled()) {
          applyReplayRunLockedInputs();
          return;
        }
        const next = persistReplayPredictionConfig(readReplayPredictionConfig());
        durationInput.value = String(next.sensitivitySec);
      };
      durationInput.addEventListener("change", commit);
      durationInput.addEventListener("blur", commit);
      durationInput.addEventListener("input", () => {
        if (replayRunning || durationInput.disabled) applyReplayRunLockedInputs();
      });
    }
    const sharesInput = document.getElementById("replay-prediction-shares");
    if (sharesInput && sharesInput.dataset.bound !== "1") {
      sharesInput.dataset.bound = "1";
      const commit = () => {
        if (replayRunning || sharesInput.disabled || !isReplayPredictionEnabled()) {
          applyReplayRunLockedInputs();
          return;
        }
        const next = persistReplayPredictionConfig(readReplayPredictionConfig());
        sharesInput.value = String(next.shares);
      };
      sharesInput.addEventListener("change", commit);
      sharesInput.addEventListener("blur", commit);
      sharesInput.addEventListener("input", () => {
        if (replayRunning || sharesInput.disabled) applyReplayRunLockedInputs();
      });
    }
    const bindOrderType = (select) => {
      if (!select || select.dataset.bound === "1") return;
      select.dataset.bound = "1";
      select.addEventListener("change", () => {
        if (replayRunning || select.disabled || !isReplayPredictionEnabled()) {
          applyReplayRunLockedInputs();
          return;
        }
        const next = persistReplayPredictionConfig(readReplayPredictionConfig());
        select.value =
          select.id === "replay-prediction-sell-order-type"
            ? next.sellOrderType
            : next.buyOrderType;
      });
    };
    bindOrderType(document.getElementById("replay-prediction-buy-order-type"));
    bindOrderType(document.getElementById("replay-prediction-sell-order-type"));

    bindReplayPredictionAreaSlider();
    syncReplayPredictionAreaUi();
    syncReplayPredictionEnabledUi();
    syncReplayPredictionTotalsUi();
  }

  function initReplayLatencyInput() {
    const latencyInput = document.getElementById("schedule-replay-latency-input");
    if (latencyInput && latencyInput.dataset.bound !== "1") {
      latencyInput.dataset.bound = "1";
      try {
        const stored = Number(localStorage.getItem(REPLAY_LATENCY_STORAGE_KEY));
        if (Number.isFinite(stored)) {
          latencyInput.value = String(Math.max(0, Math.min(10000, Math.floor(stored))));
        }
      } catch {
        // keep default
      }
      const commitLatency = () => {
        if (replayRunning || latencyInput.disabled) {
          applyReplayRunLockedInputs();
          return;
        }
        markReplayInputUserEdited(latencyInput);
        const ms = readReplayLatencyMs();
        latencyInput.value = String(ms);
        persistReplayLatencyMs(ms);
      };
      latencyInput.addEventListener("change", commitLatency);
      latencyInput.addEventListener("blur", commitLatency);
      latencyInput.addEventListener("input", () => {
        if (replayRunning || latencyInput.disabled) {
          applyReplayRunLockedInputs();
          return;
        }
        markReplayInputUserEdited(latencyInput);
      });
    }

    const fillInput = document.getElementById("schedule-replay-fill-success-input");
    if (fillInput && fillInput.dataset.bound !== "1") {
      fillInput.dataset.bound = "1";
      try {
        const stored = Number(localStorage.getItem(REPLAY_FILL_SUCCESS_STORAGE_KEY));
        if (Number.isFinite(stored)) {
          fillInput.value = String(Math.max(0, Math.min(100, stored)));
        }
      } catch {
        // keep default
      }
      const commitFill = () => {
        if (replayRunning || fillInput.disabled) {
          applyReplayRunLockedInputs();
          return;
        }
        markReplayInputUserEdited(fillInput);
        const pct = readReplayFillSuccessPct();
        fillInput.value = String(pct);
        persistReplayFillSuccessPct(pct);
      };
      fillInput.addEventListener("change", commitFill);
      fillInput.addEventListener("blur", commitFill);
      fillInput.addEventListener("input", () => {
        if (replayRunning || fillInput.disabled) {
          applyReplayRunLockedInputs();
          return;
        }
        markReplayInputUserEdited(fillInput);
      });
    }

    // Prediction footer removed — Triggers section replaces it.
    try {
      initReplayPredictionInputs();
    } catch {
      /* prediction DOM may be absent */
    }
    window.ScheduleReplayTriggers?.init?.();
    window.ScheduleLiveTriggers?.init?.();

    // Prefer live feed latency / 7-day fill success when available.
    syncReplayInputsFromLive();
  }

  function syncReplayRunButton() {
    const btn = document.getElementById("schedule-replay-run-btn");
    if (!btn) return;
    btn.disabled = false;
    btn.classList.toggle("is-stop", replayRunning);
    btn.setAttribute("aria-pressed", replayRunning ? "true" : "false");
    setReplayInputsLocked(replayRunning);
    if (replayRunning) {
      btn.title = "Stop run";
      btn.innerHTML = `<span>Stop</span>${REPLAY_SPIN_ICON}`;
    } else {
      btn.title = "Run placed cards over recorded windows";
      btn.innerHTML = `<span>Run</span>${REPLAY_SPIN_ICON}`;
    }
  }

  function stopReplay(reason = "stopped") {
    if (!replayRunning) return;
    replayStopReason = reason;
    if (replayAbort) {
      replayAbort.abort();
      replayAbort = null;
    }
  }

  function interruptReplayIfRunning(reason = "schedule changed") {
    if (!replayRunning) return;
    // Workspace toggles must not abort Replay — only schedule/trigger edits / explicit Stop.
    if (reason === "workspace changed") return;
    stopReplay(reason);
    const message =
      reason === "schedule changed"
        ? "Replay stopped — schedule changed"
        : reason === "triggers changed"
          ? "Replay stopped — triggers changed"
          : "Replay stopped";
    window.appendLogEntry?.({
      level: "info",
      source: "client",
      message,
    });
  }

  function toggleReplay() {
    if (replayRunning) {
      stopReplay("user");
      window.appendLogEntry?.({
        level: "info",
        source: "client",
        message: "Replay stopped",
      });
      return;
    }
    void runReplay();
  }

  async function runReplay() {
    if (!isReplayWorkspace() || replayRunning) return;
    const triggers = window.ScheduleReplayTriggers?.listForRun?.() ?? [];
    if (!triggers.length) {
      window.appendLogEntry?.({
        level: "warn",
        source: "client",
        message: "Add and Activate at least one Replay Trigger before pressing Run",
      });
      return;
    }

    const board =
      typeof window.ScheduleHourSlots?.buildTriggerOnlyReplayBoard === "function"
        ? window.ScheduleHourSlots.buildTriggerOnlyReplayBoard(selectedSeries())
        : null;
    if (!board?.placements?.length) {
      window.appendLogEntry?.({
        level: "warn",
        source: "client",
        message: "Could not build hour-slot Replay board",
      });
      return;
    }

    replayAbort = new AbortController();
    const { signal } = replayAbort;
    replayStopReason = null;
    const latencyMs = readReplayLatencyMs();
    const fillSuccessPct = readReplayFillSuccessPct();
    replayRunLockedLatencyMs = latencyMs;
    replayRunLockedFillSuccessPct = fillSuccessPct;
    replayRunLockedPrediction = null;
    persistReplayLatencyMs(latencyMs);
    persistReplayFillSuccessPct(fillSuccessPct);
    window.ScheduleReplayTriggers?.resetRunStats?.();
    replayRunning = true;
    syncReplayRunButton();
    placementStats.clear();
    lockedPlacementIds.clear();
    activeReplayStats.clear();
    // Reset hour cells to zeros + spinners (setReplayRunning clears stats).
    window.ScheduleHourSlots?.setReplayRunning?.(true);
    resetReplayPredictionTotalsUi();
    applyCardStatsStates();
    updateWeekHeaderSummary();
    updateHighlightedHeaderSummary();
    showHeaderStatsProgressIndeterminate();
    const dayOrder = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
    const orderedPlacements = [...board.placements].sort((a, b) => {
      const dayDiff = (dayOrder[a.day] ?? 99) - (dayOrder[b.day] ?? 99);
      if (dayDiff !== 0) return dayDiff;
      if (a.startHour !== b.startHour) return a.startHour - b.startHour;
      return String(a._id).localeCompare(String(b._id));
    });
    // Keep in-memory placements aligned so Open Replay / locks can resolve hour ids.
    placements = orderedPlacements;
    activeReplayPlacementIds = new Set(orderedPlacements.map((p) => p._id));
    const first = orderedPlacements[0];
    window.appendLogEntry?.({
      level: "info",
      source: "client",
      message: `Replay started for ${orderedPlacements.length} hour slot(s) — top-left first (${first.day} @ ${first.startHour}h), latency ${latencyMs} ms, fill success ${fillSuccessPct}%, ${triggers.length} trigger(s)…`,
    });

    const setups = board.setups;

    let gotDoneEvent = false;
    try {
      const res = await fetch("/api/schedule-replay", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        signal,
        body: JSON.stringify({
          series: selectedSeries(),
          placements: orderedPlacements,
          setups,
          latencyMs,
          fillSuccessPct,
          prediction: null,
          triggers,
        }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Replay failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let failure = null;
      let doneStats = null;

      const handleSseEvent = (event, data) => {
        if (event === "progress") {
          if (!isReplayWorkspace()) return;
          const { completed, total, indeterminate } = data || {};
          if (indeterminate) showHeaderStatsProgressIndeterminate();
          else if (total > 0) setHeaderStatsProgress(completed / total);
        } else if (event === "placement") {
          applyReplayPlacementStat(data);
          if (isReplayWorkspace() && data?.progress?.total > 0) {
            setHeaderStatsProgress(data.progress.completed / data.progress.total);
          }
        } else if (event === "done") {
          doneStats = data;
          gotDoneEvent = true;
        } else if (event === "failure") {
          failure = data;
        }
      };

      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush any pending UTF-8 sequence before final parse.
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        buffer = parseSseChunk(buffer, handleSseEvent);
      }
      if (!signal.aborted && buffer.trim()) {
        parseSseChunk(`${buffer}\n\n`, handleSseEvent);
      }

      if (failure && !signal.aborted) {
        throw new Error(failure.error || "Replay failed");
      }
      // On a full done: apply server stats. Skip empty placeholders for cards never simulated
      // when the run was aborted (partial done).
      const doneList = Array.isArray(doneStats)
        ? doneStats
        : Array.isArray(doneStats?.stats)
          ? doneStats.stats
          : null;
      if (doneList) {
        for (const stats of doneList) {
          if (signal.aborted && stats?.hasData !== true && !placementStats.has(stats.placementId)) {
            continue;
          }
          applyReplayPlacementStat(stats);
        }
      } else if (doneStats == null && !signal.aborted) {
        window.appendLogEntry?.({
          level: "warn",
          source: "client",
          message: "Replay ended without a full result stream — try again (or use fewer cards)",
        });
      }
      const withData = [...activeReplayStats.values()].filter((s) => s.hasData === true).length;
      const replayCardCount = activeReplayPlacementIds.size || orderedPlacements.length;
      const pending = [...activeReplayPlacementIds].filter((id) => !activeReplayStats.has(id)).length;
      if (!signal.aborted && gotDoneEvent) {
        if (withData === 0) {
          window.appendLogEntry?.({
            level: "warn",
            source: "client",
            message:
              "Replay finished with no card stats — tick files are missing on disk (heatmap alone is not enough). Check DATA_DIR / Dropbox sync; keep Recording on to rebuild history.",
          });
        } else {
          window.appendLogEntry?.({
            level: "success",
            source: "client",
            message: `Replay finished — ${withData}/${replayCardCount} card(s) had tick data to simulate`,
          });
        }
      } else if (signal.aborted || !gotDoneEvent) {
        window.appendLogEntry?.({
          level: "info",
          source: "client",
          message:
            pending > 0
              ? `Replay stopped early — ${withData} card(s) have stats; ${pending} card(s) were not simulated yet (not zero trades)`
              : `Replay stopped — kept stats for ${withData}/${replayCardCount} card(s)`,
        });
      }
    } catch (err) {
      if (err?.name === "AbortError" || signal.aborted) {
        // Stopped by user / schedule edit — already logged when requested.
      } else {
        window.appendLogEntry?.({
          level: "error",
          source: "client",
          message: `Replay: ${err.message || err}`,
        });
      }
    } finally {
      hideHeaderStatsProgress();
      replayAbort = null;
      replayRunning = false;
      replayStopReason = null;
      replayRunLockedLatencyMs = null;
      replayRunLockedFillSuccessPct = null;
      replayRunLockedPrediction = null;
      syncReplayRunButton();
      // Unlock live prefill again now that the run's frozen values are released.
      syncReplayInputsFromLive();
      // Full completion only: fill remaining cards as no-data.
      // Early stop: leave unfinished cards without stats so they don't look like zero-trade results.
      if (gotDoneEvent && !signal.aborted) {
        finalizeReplayCardStats();
        window.ScheduleReplayTriggers?.commitRunStatsToCards?.();
      } else {
        clearReplayLoadingOnly();
        syncReplayPredictionTotalsUi();
      }
      window.ScheduleHourSlots?.setReplayRunning?.(false);
    }
  }

  function setPlacements(data) {
    const series = selectedSeries();
    const raw = Array.isArray(data) ? data : [];
    // Keep the current market's board if an SSE payload is for another series.
    if (raw.length > 0 && raw[0]?.series && raw[0].series !== series) {
      return;
    }
    // All-series broadcasts (e.g. setup title/delete) must not mix markets onto the board.
    const next = raw.some((p) => p?.series)
      ? raw.filter((p) => !p.series || p.series === series)
      : raw;
    if (placementsSignature(placements) === placementsSignature(next)) return;
    // Surgical DOM sync — do not rebuild every card on delete/add/move echoes.
    syncPlacementsDom(next);
  }

  function onViewChange() {
    closeMenus();
    clearDropPreview();
    clearHeaderFillPreview();
    moveDragState = null;
    document.body.classList.remove("is-schedule-moving");
    // Toggle hour-slot Trigger stats vs heatmap metric cells.
    window.ScheduleHourSlots?.syncView?.();
    updateDayHeaderPnls();
    updateHighlightedHeaderSummary();
    syncNowHighlights();
  }

  /** Open Replay popup for a synthetic hour cell (`hour:mon:14`). Live = real fills; Replay = sim. */
  function openHourSlotReplay(day, hour) {
    if (!isScheduleView()) return;
    if (!DAYS.includes(day) || !Number.isFinite(hour) || hour < 0 || hour > 23) return;
    const placementId = `hour:${day}:${hour}`;
    const slot = window.ScheduleHourSlots?.getSlot?.(day, hour);
    const hint =
      (slot?.green ?? 0) +
      (slot?.red ?? 0) +
      (slot?.blue ?? 0) +
      (slot?.gray ?? 0);
    // All-zero stats → nothing to open.
    if (hint <= 0 || slot?.hasData !== true) return;
    const live = !isReplayWorkspace();
    window.SchedulePlay?.open?.(placementId, {
      windowCountHint: hint,
      latencyMs: live ? 0 : readReplayLatencyMs(),
      fillSuccessPct: live ? 100 : readReplayFillSuccessPct(),
      prediction: null,
      triggers: live ? [] : window.ScheduleReplayTriggers?.listForRun?.() ?? [],
      series: selectedSeries(),
      setup: null,
      live,
    });
  }

  function bindHourSlotOpenReplay() {
    const page = document.getElementById("page-schedule-heatmap");
    if (!page || page.dataset.hourOpenBound === "1") return;
    page.dataset.hourOpenBound = "1";
    page.addEventListener("dblclick", (event) => {
      if (!isScheduleView()) return;
      const slot = event.target?.closest?.(".schedule-hour-slot");
      if (!slot || !page.contains(slot)) return;
      const col = slot.closest(".schedule-day-column");
      const day = String(col?.dataset?.day || "").toLowerCase();
      const hour = Number(slot.dataset.hour);
      if (!DAYS.includes(day) || !Number.isFinite(hour)) return;
      event.preventDefault();
      event.stopPropagation();
      openHourSlotReplay(day, hour);
    });
  }

  function init() {
    demoHitsStore = loadDemoHitsStore();
    loadHeaderSummaryPrefs();
    initPlacementLayers();
    initDayHeaderControls();
    bindUtcRowHover();
    bindHighlightedSummaryClear();
    bindWeekSummaryReset();
    bindHeaderSummaryRange();
    bindGlobalPointer();
    bindHourSlotOpenReplay();
    initReplayLatencyInput();
    window.SchedulePlay?.init?.();
    window.ScheduleHourSlots?.init?.();
    syncNowHighlights();
    syncHeaderSummaryControls();
    syncReplayRunButton();
    void fetchHeaderSummaryTotals();
    window.setInterval(syncNowHighlights, 15_000);
  }

  window.SchedulePlacements = {
    init,
    loadPlacements,
    setPlacements,
    onSetupsRendered,
    onViewChange,
    onWorkspaceModeChanged,
    clearWorkspaceBoard,
    runReplay,
    stopReplay,
    interruptReplayIfRunning,
    toggleReplay,
    isReplayRunning: () => replayRunning,
    onHeatmapUpdated,
    applyLivePlacementStats,
    applyLiveSessionTotals,
    applyDemoLastWindow,
    syncHeaderSummaryControls,
    updateDayHeaderPnls,
    setHeaderSummaryRange,
    syncReplayInputsFromLive,
    onSelectedSeriesChanged,
    closeMenus,
    getPlacementCountsBySetup,
    getPlacementsForSetup,
    getLockedCountForSetup,
    getLockedCountForDay,
    isPlacementLocked,
    removePlacementsForSetup,
    refreshPlacementStats: scheduleStatsRefresh,
    refreshAllPlacementStats: (options = {}) =>
      scheduleStatsRefresh({ all: true, force: options.force === true }),
    refreshSetupPlacementStats: (setupId, options = {}) =>
      scheduleStatsRefresh({ setupId, force: options.force === true }),
  };
})();
