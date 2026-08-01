/**
 * Schedule Live workspace: mirror Market Triggers that are Trade + Active.
 * Stats use all-time Trade counters (same as Market Trade mode).
 * Definitions stay on Market; this list is read-only (Edit opens Market editor).
 */
(function () {
  function formatPnl(pnlUsd) {
    const n = Number(pnlUsd);
    if (!Number.isFinite(n)) return "$0.00";
    const sign = n > 0 ? "+" : "";
    return `${sign}$${n.toFixed(2)}`;
  }

  function listTradeActive() {
    const list =
      typeof window.listMarketTriggersForSchedule === "function"
        ? window.listMarketTriggersForSchedule()
        : [];
    if (!Array.isArray(list)) return [];
    return list.filter((t) => t && t.runMode === "trade" && t.paused === false);
  }

  function closeMenus() {
    document.querySelectorAll(".schedule-live-trigger-menu").forEach((el) => el.remove());
  }

  function render() {
    const listEl = document.getElementById("schedule-live-triggers-list");
    if (!listEl) return;
    const triggers = listTradeActive();
    listEl.replaceChildren();
    if (!triggers.length) {
      const empty = document.createElement("div");
      empty.className = "schedule-live-triggers-note";
      empty.textContent =
        "No Trade + Active Market Triggers. Arm a trigger on Market (Trade + Active) to show it here.";
      listEl.appendChild(empty);
      return;
    }

    for (const trigger of triggers) {
      const id = String(trigger.id);
      const card = document.createElement("div");
      card.className = "schedule-replay-trigger-card schedule-live-trigger-card";
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
        menu.className = "schedule-setup-menu schedule-live-trigger-menu";
        menu.setAttribute("role", "menu");
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "schedule-setup-menu-item";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          closeMenus();
          window.openTriggerEditModalForHost?.("market", trigger);
        });
        menu.appendChild(editBtn);
        document.body.appendChild(menu);
        const rect = menuBtn.getBoundingClientRect();
        menu.style.position = "fixed";
        menu.style.top = `${Math.round(rect.bottom + 4)}px`;
        menu.style.left = `${Math.round(rect.right - 140)}px`;
        menu.style.zIndex = "10000";
      });
      menuWrap.appendChild(menuBtn);
      header.append(title, menuWrap);

      const badge = document.createElement("div");
      badge.className = "trigger-card-controls";
      const mode = document.createElement("div");
      mode.className = "trigger-run-mode trigger-pause-mode";
      mode.setAttribute("role", "group");
      mode.setAttribute("aria-label", "Trade Active");
      const tradeBtn = document.createElement("button");
      tradeBtn.type = "button";
      tradeBtn.className = "trigger-run-mode-btn is-active";
      tradeBtn.textContent = "Trade";
      tradeBtn.disabled = true;
      tradeBtn.title = "Trade mode (edit on Market to change)";
      const activeBtn = document.createElement("button");
      activeBtn.type = "button";
      activeBtn.className = "trigger-run-mode-btn is-active";
      activeBtn.textContent = "Active";
      activeBtn.disabled = true;
      activeBtn.title = "Active (edit on Market to pause)";
      mode.append(tradeBtn, activeBtn);
      badge.appendChild(mode);

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

      card.append(header, badge, statsRow);
      listEl.appendChild(card);

      if (typeof window.fillTriggerCardStatsRow === "function") {
        window.fillTriggerCardStatsRow(statsRow, trigger);
      }
      if (typeof window.fetchTriggerLiveStats === "function") {
        void window.fetchTriggerLiveStats(id).then(() => {
          if (typeof window.fillTriggerCardStatsRow === "function") {
            window.fillTriggerCardStatsRow(statsRow, trigger);
          }
        });
      }
    }
  }

  function updateStats(triggerId) {
    const id = String(triggerId || "");
    if (!id) return;
    const card = document.querySelector(
      `.schedule-live-trigger-card[data-trigger-id="${CSS.escape(id)}"]`,
    );
    const statsRow = card?.querySelector(".trigger-card-stats");
    if (!statsRow) return;
    const trigger =
      typeof window.findUserTrigger === "function"
        ? window.findUserTrigger(id)
        : listTradeActive().find((t) => String(t.id) === id);
    if (!trigger || typeof window.fillTriggerCardStatsRow !== "function") return;
    window.fillTriggerCardStatsRow(statsRow, trigger);
  }

  function init() {
    render();
    document.addEventListener("click", (e) => {
      if (e.target?.closest?.(".schedule-live-trigger-menu")) return;
      if (e.target?.closest?.(".schedule-setup-menu-btn")) return;
      closeMenus();
    });
  }

  window.ScheduleLiveTriggers = {
    init,
    render,
    updateStats,
    listTradeActive,
  };
})();
