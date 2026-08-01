/**
 * Schedule Replay Triggers list (footer). Uses Market trigger create/edit modal via app.js.
 */
(function () {
  const STORAGE_BASE = "schedule-replay-triggers-v1";

  /** @type {Array<Record<string, unknown>>} */
  let replayTriggers = [];
  /** Aggregated stats from the active/last Run, keyed by triggerId. */
  let runStatsById = Object.create(null);

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
    const sign = n > 0 ? "+" : "";
    return `${sign}$${n.toFixed(2)}`;
  }

  function listForRun() {
    return replayTriggers.map((t) => {
      const { replayStats, runMode, paused, demoStats, ...def } = t;
      return def;
    });
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

  function find(triggerId) {
    const id = String(triggerId || "");
    return replayTriggers.find((t) => String(t.id) === id) || null;
  }

  function resetRunStats() {
    runStatsById = Object.create(null);
    for (const t of replayTriggers) {
      runStatsById[String(t.id)] = emptyStats();
    }
    render();
  }

  function accumulatePlacementTriggerStats(triggerStats) {
    if (!Array.isArray(triggerStats)) return;
    for (const s of triggerStats) {
      const id = String(s?.triggerId || "");
      if (!id) continue;
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
      t.replayStats = normalizeStats(runStatsById[id] || emptyStats());
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
      empty.textContent = "No triggers yet — Add Trigger to apply on each simulated window.";
      list.appendChild(empty);
      return;
    }
    for (const trigger of replayTriggers) {
      const id = String(trigger.id);
      const stats = normalizeStats(runStatsById[id] || trigger.replayStats);
      const card = document.createElement("div");
      card.className = "schedule-replay-trigger-card";
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
      menuBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
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
        menu.append(editBtn, deleteBtn);
        document.body.appendChild(menu);
        const rect = menuBtn.getBoundingClientRect();
        menu.style.position = "fixed";
        menu.style.top = `${Math.round(rect.bottom + 4)}px`;
        menu.style.left = `${Math.round(rect.right - 140)}px`;
        menu.style.zIndex = "10000";
      });
      menuWrap.appendChild(menuBtn);
      header.append(title, menuWrap);

      const statsRow = document.createElement("div");
      statsRow.className = "trigger-card-stats";
      statsRow.innerHTML =
        '<div class="trigger-card-stats-exits">' +
        '<span class="trigger-card-stats-item"><span class="trigger-card-stats-label">Stop Loss</span><span class="trigger-card-stats-value" data-stat="stopLoss">0</span></span>' +
        "</div>" +
        '<div class="trigger-card-stats-main">' +
        '<span class="trigger-card-stats-item is-count" title="Success (take-profit)"><span class="trigger-card-stats-dot is-success" aria-hidden="true"></span><span class="trigger-card-stats-value" data-stat="success">0</span></span>' +
        '<span class="trigger-card-stats-item is-count" title="Held win"><span class="trigger-card-stats-dot is-held" aria-hidden="true"></span><span class="trigger-card-stats-value" data-stat="blue">0</span></span>' +
        '<span class="trigger-card-stats-item is-count" title="Fail"><span class="trigger-card-stats-dot is-fail" aria-hidden="true"></span><span class="trigger-card-stats-value" data-stat="fail">0</span></span>' +
        '<span class="trigger-card-stats-item"><span class="trigger-card-stats-label">P/L</span><span class="trigger-card-stats-value" data-stat="pnl">$0.00</span></span>' +
        "</div>";
      const successEl = statsRow.querySelector('[data-stat="success"]');
      const blueEl = statsRow.querySelector('[data-stat="blue"]');
      const failEl = statsRow.querySelector('[data-stat="fail"]');
      const slEl = statsRow.querySelector('[data-stat="stopLoss"]');
      const pnlEl = statsRow.querySelector('[data-stat="pnl"]');
      if (successEl) successEl.textContent = String(stats.success);
      if (blueEl) blueEl.textContent = String(stats.blue ?? 0);
      if (failEl) failEl.textContent = String(stats.fail);
      if (slEl) slEl.textContent = String(stats.stopLoss);
      if (pnlEl) {
        pnlEl.textContent = formatPnl(stats.pnlUsd);
        pnlEl.classList.toggle("is-pos", stats.pnlUsd > 0);
        pnlEl.classList.toggle("is-neg", stats.pnlUsd < 0);
      }

      card.append(header, statsRow);
      list.appendChild(card);
    }
  }

  function setLocked(locked) {
    const addBtn = document.getElementById("schedule-replay-triggers-add");
    if (addBtn) {
      addBtn.disabled = Boolean(locked);
      addBtn.setAttribute("aria-disabled", locked ? "true" : "false");
    }
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
    find,
    resetRunStats,
    accumulatePlacementTriggerStats,
    commitRunStatsToCards,
    setLocked,
  };
})();
