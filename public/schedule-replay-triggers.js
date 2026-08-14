/**
 * Schedule Replay Triggers list (footer). Uses Market trigger create/edit modal via app.js.
 */
(function () {
  const STORAGE_BASE = "schedule-replay-triggers-v1";

  /** @type {Array<Record<string, unknown>>} */
  let replayTriggers = [];
  /** Aggregated stats from the active/last Run, keyed by triggerId. */
  let runStatsById = Object.create(null);
  /** True while a Schedule Replay Run is in progress (freeze edits / pause toggles). */
  let listLocked = false;

  function storageKey() {
    return typeof window.userScopedStorageKey === "function"
      ? window.userScopedStorageKey(STORAGE_BASE)
      : `poly-real:${STORAGE_BASE}`;
  }

  function emptyStats() {
    return { success: 0, fail: 0, blue: 0, takeProfit: 0, stopLoss: 0, pnlUsd: 0 };
  }

  function normalizeStats(raw) {
    return {
      success: Math.max(0, Math.round(Number(raw?.success) || 0)),
      fail: Math.max(0, Math.round(Number(raw?.fail) || 0)),
      blue: Math.max(0, Math.round(Number(raw?.blue) || 0)),
      takeProfit: Math.max(0, Math.round(Number(raw?.takeProfit) || 0)),
      stopLoss: Math.max(0, Math.round(Number(raw?.stopLoss) || 0)),
      pnlUsd: Number.isFinite(Number(raw?.pnlUsd)) ? Number(raw.pnlUsd) : 0,
    };
  }

  function normalizeExitOffsets(raw) {
    const tp = Math.round(Number(raw?.takeProfitCents));
    const sl = Math.round(Number(raw?.stopLossCents));
    const clamp = (n, fb) => {
      if (!Number.isFinite(n)) return fb;
      return Math.max(1, Math.min(100, n));
    };
    // Legacy absolute quote defaults (pre offset-from-fill) → new offset defaults.
    if (tp === 80 && (sl === 20 || !Number.isFinite(sl))) {
      return { takeProfitCents: 10, stopLossCents: 10 };
    }
    return {
      takeProfitCents: clamp(tp, 10),
      stopLossCents: clamp(sl, 10),
    };
  }

  function normalizeTrigger(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = raw.id != null ? String(raw.id) : "";
    if (!id) return null;
    const exits = normalizeExitOffsets(raw);
    return {
      ...raw,
      id,
      name: typeof raw.name === "string" ? raw.name : "Untitled trigger",
      takeProfitCents: exits.takeProfitCents,
      stopLossCents: exits.stopLossCents,
      // Explicit true only — older cards without the field stay Test on Run.
      paused: raw.paused === true,
      priceSide: "buy",
      gapMode: raw.gapMode === "relative" ? "relative" : "fixed",
      startMode: raw.startMode === "price" || raw.startMode === "change-side" ? "price" : "range",
      startPriceCents: (() => {
        const n = Math.round(
          Number(
            raw.startPriceCents ??
              (raw.startMode === "change-side" || raw.startMode === "price"
                ? Math.abs(Number(raw.startChangeSideCents))
                : 50),
          ) * 10,
        ) / 10;
        if (!Number.isFinite(n)) return 50;
        return Math.max(0, Math.min(100, n));
      })(),
      buyOrderType: (() => {
        const durationMs = (() => {
          const n = Math.floor(Number(raw.durationMs));
          return Number.isFinite(n) && n >= 0 ? n : 5000;
        })();
        const startMode =
          raw.startMode === "price" || raw.startMode === "change-side" ? "price" : "range";
        const gaps =
          raw.ptbGap && typeof raw.ptbGap === "object" ? raw.ptbGap : {};
        const hasPtbGap =
          gaps.start === "positive" ||
          gaps.start === "negative" ||
          gaps.end === "positive" ||
          gaps.end === "negative";
        const rawType =
          raw.buyOrderType === "FAK" || raw.buyOrderType === "FOK" || raw.buyOrderType === "GTD"
            ? raw.buyOrderType
            : "FOK";
        if (rawType === "GTD" && !(durationMs === 0 && startMode === "price" && !hasPtbGap)) {
          return "FOK";
        }
        return rawType;
      })(),
      buySidesMode: (() => {
        const durationMs = (() => {
          const n = Math.floor(Number(raw.durationMs));
          return Number.isFinite(n) && n >= 0 ? n : 5000;
        })();
        const startMode =
          raw.startMode === "price" || raw.startMode === "change-side" ? "price" : "range";
        if (!(durationMs === 0 && startMode === "price")) return "first";
        return raw.buySidesMode === "both" ? "both" : "first";
      })(),
      replayStats: normalizeStats(raw.replayStats),
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(storageKey());
      if (!raw) {
        replayTriggers = [];
        return;
      }
      const parsed = JSON.parse(raw);
      replayTriggers = Array.isArray(parsed)
        ? parsed.map(normalizeTrigger).filter(Boolean)
        : [];
    } catch {
      replayTriggers = [];
    }
  }

  function save() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(replayTriggers));
    } catch {
      /* ignore */
    }
  }

  function formatPnl(pnlUsd) {
    const n = Number(pnlUsd);
    if (!Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : n < 0 ? "-" : "";
    const abs = Math.abs(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${sign}$${abs}`;
  }

  function listForRun() {
    return replayTriggers
      .filter((t) => t?.paused !== true)
      .map((t) => {
        const { replayStats, runMode, paused, demoStats, ...def } = t;
        return def;
      });
  }

  function setPaused(triggerId, paused) {
    if (listLocked) return;
    const id = String(triggerId || "");
    const idx = replayTriggers.findIndex((t) => String(t?.id) === id);
    if (idx < 0) return;
    const nextPaused = Boolean(paused);
    // Pausing: lock in any current Run-buffer totals so a later Run cannot wipe them.
    let replayStats = normalizeStats(replayTriggers[idx].replayStats);
    if (nextPaused && Object.prototype.hasOwnProperty.call(runStatsById, id)) {
      replayStats = normalizeStats(runStatsById[id]);
    }
    replayTriggers[idx] = normalizeTrigger({
      ...replayTriggers[idx],
      paused: nextPaused,
      replayStats,
    });
    if (nextPaused && Object.prototype.hasOwnProperty.call(runStatsById, id)) {
      delete runStatsById[id];
    }
    save();
    render();
    stopReplayForTriggerChange();
  }

  function stopReplayForTriggerChange() {
    window.SchedulePlacements?.interruptReplayIfRunning?.("triggers changed");
  }

  function upsert(trigger) {
    const next = normalizeTrigger(trigger);
    if (!next) return null;
    const idx = replayTriggers.findIndex((t) => String(t.id) === String(next.id));
    if (idx >= 0) {
      next.replayStats = normalizeStats(replayTriggers[idx].replayStats);
      replayTriggers[idx] = next;
    } else {
      replayTriggers = [next, ...replayTriggers];
    }
    save();
    render();
    // Definition changes invalidate the frozen Run snapshot.
    stopReplayForTriggerChange();
    return next;
  }

  function remove(triggerId) {
    const id = String(triggerId || "");
    replayTriggers = replayTriggers.filter((t) => String(t.id) !== id);
    save();
    render();
    stopReplayForTriggerChange();
  }

  function newTriggerId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `trg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /** Deep-copy a Replay Trigger; always starts Paused with empty Run stats. */
  function duplicate(triggerId) {
    if (listLocked) return null;
    const src = find(triggerId);
    if (!src) return null;
    let clone;
    try {
      clone = JSON.parse(JSON.stringify(src));
    } catch {
      return null;
    }
    const now = new Date().toISOString();
    const color =
      typeof window.randomTriggerColorHex === "function"
        ? window.randomTriggerColorHex()
        : `#${Math.floor(Math.random() * 0xffffff)
            .toString(16)
            .padStart(6, "0")}`;
    const next = normalizeTrigger({
      ...clone,
      id: newTriggerId(),
      color,
      paused: true,
      replayStats: emptyStats(),
      createdAt: now,
      updatedAt: now,
    });
    if (!next) return null;
    const srcIdx = replayTriggers.findIndex((t) => String(t.id) === String(src.id));
    // Insert right after the source card.
    if (srcIdx >= 0) {
      replayTriggers.splice(srcIdx + 1, 0, next);
    } else {
      replayTriggers = [next, ...replayTriggers];
    }
    save();
    render();
    stopReplayForTriggerChange();
    return next;
  }

  function find(triggerId) {
    const id = String(triggerId || "");
    return replayTriggers.find((t) => String(t.id) === id) || null;
  }

  /**
   * Zero in-run counters for Test triggers only.
   * Paused cards keep their stats: flush any leftover Run-buffer totals onto the card
   * first (e.g. after an early Stop), then leave them out of the new Run buffer.
   */
  function resetRunStats() {
    let pausedFlushed = false;
    for (const t of replayTriggers) {
      if (t?.paused !== true) continue;
      const id = String(t.id);
      if (!Object.prototype.hasOwnProperty.call(runStatsById, id)) continue;
      t.replayStats = normalizeStats(runStatsById[id]);
      pausedFlushed = true;
    }
    if (pausedFlushed) save();

    runStatsById = Object.create(null);
    for (const t of replayTriggers) {
      if (t?.paused === true) continue;
      runStatsById[String(t.id)] = emptyStats();
    }
    render();
  }

  function accumulatePlacementTriggerStats(triggerStats) {
    if (!Array.isArray(triggerStats)) return;
    for (const s of triggerStats) {
      const id = String(s?.triggerId || "");
      if (!id) continue;
      // Skip paused cards (not in this Run).
      const card = replayTriggers.find((t) => String(t?.id) === id);
      if (card?.paused === true) continue;
      const cur = runStatsById[id] || emptyStats();
      cur.success += Math.max(0, Math.round(Number(s.success) || 0));
      cur.fail += Math.max(0, Math.round(Number(s.fail) || 0));
      cur.blue += Math.max(0, Math.round(Number(s.blue) || 0));
      cur.takeProfit += Math.max(0, Math.round(Number(s.takeProfit) || 0));
      cur.stopLoss += Math.max(0, Math.round(Number(s.stopLoss) || 0));
      cur.pnlUsd += Number.isFinite(Number(s.pnlUsd)) ? Number(s.pnlUsd) : 0;
      runStatsById[id] = cur;
    }
    render();
  }

  function commitRunStatsToCards() {
    for (const t of replayTriggers) {
      const id = String(t.id);
      // Paused cards were not in this Run — keep their previous card stats.
      if (t.paused === true) continue;
      if (!Object.prototype.hasOwnProperty.call(runStatsById, id)) continue;
      t.replayStats = normalizeStats(runStatsById[id]);
    }
    save();
    render();
  }

  function closeMenus() {
    document.querySelectorAll(".schedule-replay-trigger-menu").forEach((el) => el.remove());
  }

  function render() {
    const list = document.getElementById("schedule-replay-triggers-list");
    if (!list) return;
    list.replaceChildren();
    if (!replayTriggers.length) {
      const empty = document.createElement("div");
      empty.className = "schedule-replay-triggers-note";
      empty.textContent = "No triggers yet — + New to apply on each simulated window.";
      list.appendChild(empty);
      return;
    }
    for (const trigger of replayTriggers) {
      const id = String(trigger.id);
      const paused = trigger.paused === true;
      // Paused cards always show committed card stats (never the active Run buffer).
      const stats = normalizeStats(
        paused ? trigger.replayStats : (runStatsById[id] ?? trigger.replayStats),
      );
      const card = document.createElement("div");
      card.className = "schedule-replay-trigger-card";
      if (paused) card.classList.add("is-paused");
      card.dataset.triggerId = id;

      const header = document.createElement("div");
      header.className = "schedule-replay-trigger-card-header";
      const title = document.createElement("span");
      title.className = "schedule-replay-trigger-card-title";
      title.textContent = String(trigger.name || "Untitled trigger");
      if (typeof trigger.color === "string") {
        title.style.borderLeft = `3px solid ${trigger.color}`;
        title.style.paddingLeft = "6px";
      }

      const menuWrap = document.createElement("div");
      menuWrap.className = "schedule-setup-menu-wrap";
      const menuBtn = document.createElement("button");
      menuBtn.type = "button";
      menuBtn.className = "schedule-setup-menu-btn";
      menuBtn.setAttribute("aria-label", "Trigger menu");
      menuBtn.textContent = "⋮";
      menuBtn.disabled = listLocked;
      menuBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (listLocked) return;
        closeMenus();
        const menu = document.createElement("div");
        menu.className = "schedule-setup-menu schedule-replay-trigger-menu";
        menu.setAttribute("role", "menu");
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "schedule-setup-menu-item";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          closeMenus();
          window.openTriggerEditModalForHost?.("replay", find(id));
        });
        const duplicateBtn = document.createElement("button");
        duplicateBtn.type = "button";
        duplicateBtn.className = "schedule-setup-menu-item";
        duplicateBtn.textContent = "Duplicate";
        duplicateBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          closeMenus();
          duplicate(id);
        });
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "schedule-setup-menu-item schedule-setup-menu-item-danger";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          closeMenus();
          const label = String(trigger.name || "Untitled trigger");
          if (!window.confirm(`Delete "${label}"?\n\nThis cannot be undone.`)) return;
          remove(id);
        });
        menu.append(editBtn, duplicateBtn, deleteBtn);
        document.body.appendChild(menu);
        const rect = menuBtn.getBoundingClientRect();
        menu.style.position = "fixed";
        menu.style.top = `${Math.round(rect.bottom + 4)}px`;
        menu.style.left = `${Math.round(rect.right - 140)}px`;
        menu.style.zIndex = "10000";
      });
      menuWrap.appendChild(menuBtn);
      header.append(title, menuWrap);

      const stack = document.createElement("div");
      stack.className = "schedule-trigger-card-stack trigger-card-stats";
      stack.setAttribute("aria-label", "Replay trigger stats");

      const controls = document.createElement("div");
      controls.className = "trigger-card-controls";
      const pauseWrap = document.createElement("div");
      pauseWrap.className = "trigger-run-mode trigger-pause-mode";
      pauseWrap.setAttribute("role", "group");
      pauseWrap.setAttribute("aria-label", "Pause or Test");
      for (const state of ["pause", "test"]) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "trigger-run-mode-btn";
        btn.dataset.pauseState = state;
        btn.textContent = state === "pause" ? "Pause" : "Test";
        const isSelected = state === "pause" ? paused : !paused;
        if (isSelected) btn.classList.add("is-active");
        btn.disabled = listLocked;
        btn.title =
          state === "pause"
            ? "Skip this trigger on Replay Run; keep last stats"
            : "Include this trigger on Replay Run; stats start from zero";
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          setPaused(id, state === "pause");
        });
        pauseWrap.appendChild(btn);
      }
      controls.appendChild(pauseWrap);

      // Same row order as Live Schedule: dots → right-aligned P/L.
      const main = document.createElement("div");
      main.className = "trigger-card-stats-main";
      main.innerHTML =
        '<span class="trigger-card-stats-counts">' +
        '<span class="trigger-card-stats-item is-count" title="Sell (profitable early exit)"><span class="trigger-card-stats-dot is-success" aria-hidden="true"></span><span class="trigger-card-stats-value" data-stat="takeProfit">0</span></span>' +
        '<span class="trigger-card-stats-item is-count" title="Win (held)"><span class="trigger-card-stats-dot is-held" aria-hidden="true"></span><span class="trigger-card-stats-value" data-stat="blue">0</span></span>' +
        '<span class="trigger-card-stats-item is-count" title="Loss (held or stop loss)"><span class="trigger-card-stats-dot is-fail" aria-hidden="true"></span><span class="trigger-card-stats-value" data-stat="fail">0</span></span>' +
        "</span>";

      const pnlRow = document.createElement("div");
      pnlRow.className = "trigger-card-stats-pnl-row";
      pnlRow.innerHTML =
        '<span class="trigger-card-stats-pnl" data-stat="pnl" title="P/L">$0.00</span>';

      stack.append(controls, main, pnlRow);

      const applyStats = (next) => {
        const s = normalizeStats(next);
        const sellEl = stack.querySelector('[data-stat="takeProfit"]');
        const blueEl = stack.querySelector('[data-stat="blue"]');
        const failEl = stack.querySelector('[data-stat="fail"]');
        const pnlEl = stack.querySelector('[data-stat="pnl"]');
        if (sellEl) sellEl.textContent = String(s.takeProfit ?? 0);
        if (blueEl) blueEl.textContent = String(s.blue ?? 0);
        if (failEl) failEl.textContent = String((s.fail ?? 0) + (s.stopLoss ?? 0));
        if (pnlEl) {
          pnlEl.textContent = formatPnl(s.pnlUsd);
          pnlEl.classList.toggle("is-positive", s.pnlUsd > 0);
          pnlEl.classList.toggle("is-negative", s.pnlUsd < 0);
          pnlEl.classList.toggle("is-neutral", !(s.pnlUsd > 0) && !(s.pnlUsd < 0));
        }
      };
      applyStats(stats);

      card.append(header, stack);
      list.appendChild(card);
    }
  }

  function setLocked(locked) {
    listLocked = Boolean(locked);
    const addBtn = document.getElementById("schedule-replay-triggers-add");
    if (addBtn) {
      addBtn.disabled = listLocked;
      addBtn.setAttribute("aria-disabled", listLocked ? "true" : "false");
    }
    render();
  }

  function init() {
    load();
    render();
    const addBtn = document.getElementById("schedule-replay-triggers-add");
    addBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      if (addBtn.disabled) return;
      window.openTriggerCreateModalForHost?.("replay");
    });
    document.addEventListener("click", (e) => {
      if (e.target?.closest?.(".schedule-replay-trigger-menu")) return;
      if (e.target?.closest?.(".schedule-setup-menu-btn")) return;
      closeMenus();
    });
  }

  window.ScheduleReplayTriggers = {
    init,
    load,
    render,
    listForRun,
    upsert,
    remove,
    duplicate,
    find,
    setPaused,
    resetRunStats,
    accumulatePlacementTriggerStats,
    commitRunStatsToCards,
    setLocked,
  };
})();
