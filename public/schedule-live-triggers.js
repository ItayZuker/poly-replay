/**
 * Schedule Live workspace: Trade + Active Market Triggers only.
 * No Demo/Pause badges (membership implies Trade + Active).
 * Eye icon opens the trigger dialog in view-only mode.
 */
(function () {
  const VIEW_ICON_SVG =
    '<svg class="schedule-live-trigger-view-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="M8 3C4.7 3 2.1 5.1 1 8c1.1 2.9 3.7 5 7 5s5.9-2.1 7-5c-1.1-2.9-3.7-5-7-5zm0 8.2A3.2 3.2 0 1 1 8 4.8a3.2 3.2 0 0 1 0 6.4zm0-2.1a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2z"/>' +
    "</svg>";

  function listTradeActive() {
    const list =
      typeof window.listMarketTriggersForSchedule === "function"
        ? window.listMarketTriggersForSchedule()
        : [];
    if (!Array.isArray(list)) return [];
    return list.filter((t) => t && t.runMode === "trade" && t.paused === false);
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

      const viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.className = "schedule-setup-menu-btn schedule-live-trigger-view-btn";
      viewBtn.setAttribute("aria-label", "View trigger");
      viewBtn.title = "View trigger";
      viewBtn.innerHTML = VIEW_ICON_SVG;
      viewBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.openTriggerViewModal?.(trigger);
      });
      header.append(title, viewBtn);

      const statsRow = document.createElement("div");
      statsRow.className = "trigger-card-stats";
      statsRow.setAttribute("aria-label", "Trade stats");

      const statsBody = document.createElement("div");
      statsBody.className = "trigger-card-stats-body";
      // Row order: Sell/Win/Loss dots → P/L (right-aligned), equal gaps.
      statsBody.innerHTML =
        '<div class="trigger-card-stats-main">' +
        '<span class="trigger-card-stats-counts">' +
        '<span class="trigger-card-stats-item is-count" title="Sell (profitable early exit)"><span class="trigger-card-stats-dot is-success" aria-hidden="true"></span><span class="trigger-card-stats-value" data-stat="takeProfit">0</span></span>' +
        '<span class="trigger-card-stats-item is-count" title="Win (held)"><span class="trigger-card-stats-dot is-held" aria-hidden="true"></span><span class="trigger-card-stats-value" data-stat="blue">0</span></span>' +
        '<span class="trigger-card-stats-item is-count" title="Loss (held)"><span class="trigger-card-stats-dot is-fail" aria-hidden="true"></span><span class="trigger-card-stats-value" data-stat="fail">0</span></span>' +
        "</span>" +
        "</div>" +
        '<div class="trigger-card-stats-pnl-row">' +
        '<span class="trigger-card-stats-pnl" data-stat="pnl" title="P/L">$0.00</span>' +
        "</div>";
      statsRow.appendChild(statsBody);

      card.append(header, statsRow);
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
    // Drop from list if no longer Trade + Active.
    if (trigger.runMode !== "trade" || trigger.paused !== false) {
      render();
      return;
    }
    window.fillTriggerCardStatsRow(statsRow, trigger);
  }

  function init() {
    render();
  }

  window.ScheduleLiveTriggers = {
    init,
    render,
    updateStats,
    listTradeActive,
  };
})();
