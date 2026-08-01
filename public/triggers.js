/**
 * Triggers feature — self-contained client module.
 * Expects globals from app.js when available: $, userScopedStorageKey, appendLogEntry,
 * windowState, isPredictionTriggerHost, postTradingOrder, closeSetupMenus, positionSetupMenu,
 * manipulationWindowDurationSec, fmtManipAreaTime.
 */
(function initTriggersFeature(global) {
"use strict";

const $ =
  typeof global.$ === "function"
    ? global.$
    : (id) => document.getElementById(id);

function userScopedStorageKey(base) {
  if (typeof global.userScopedStorageKey === "function") {
    return global.userScopedStorageKey(base);
  }
  return base;
}

function appendLogEntry(entry) {
  if (typeof global.appendLogEntry === "function") {
    global.appendLogEntry(entry);
    return;
  }
  console.log(entry);
}

async function postTradingOrder(side, leg, { source } = {}) {
  if (typeof global.postTradingOrder === "function") {
    return global.postTradingOrder(side, leg, { source });
  }
  const res = await fetch("/api/trading/order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      side,
      leg,
      ...(source === "prediction" || source === "trigger" ? { source } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function isPredictionTriggerHost() {
  if (typeof global.isPredictionTriggerHost === "function") {
    return global.isPredictionTriggerHost();
  }
  const host = String(global.location?.hostname || "").toLowerCase();
  return host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]";
}

function closeSetupMenus() {
  if (typeof global.closeSetupMenus === "function") global.closeSetupMenus();
}

function positionSetupMenu(menu, anchor) {
  if (typeof global.positionSetupMenu === "function") {
    global.positionSetupMenu(menu, anchor);
    return;
  }
  const rect = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${Math.round(rect.bottom + 4)}px`;
  menu.style.left = `${Math.round(rect.right - 160)}px`;
}

function manipulationWindowDurationSec() {
  if (typeof global.manipulationWindowDurationSec === "function") {
    return global.manipulationWindowDurationSec();
  }
  const state = global.windowState;
  const ws = Number(state?.windowStart);
  const we = Number(state?.windowEnd);
  if (Number.isFinite(ws) && Number.isFinite(we) && we > ws) return we - ws;
  return 300;
}

function fmtManipAreaTime(frac, durationSec) {
  if (typeof global.fmtManipAreaTime === "function") {
    return global.fmtManipAreaTime(frac, durationSec);
  }
  const sec = Math.max(0, Math.round((Number(frac) || 0) * (Number(durationSec) || 0)));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function isInManipulationArea(state, areaStart, areaEnd) {
  if (typeof global.isInManipulationArea === "function") {
    return global.isInManipulationArea(state, areaStart, areaEnd);
  }
  const ws = state?.windowStart;
  const we = state?.windowEnd;
  if (ws == null || we == null || !Number.isFinite(ws) || !Number.isFinite(we) || we <= ws) {
    return false;
  }
  const nowSec = Date.now() / 1000;
  const t =
    Number.isFinite(state.lastTickMs) && state.lastTickMs > 0
      ? state.lastTickMs / 1000
      : nowSec;
  if (t < ws || t >= we) return false;
  const frac = (t - ws) / (we - ws);
  return frac >= areaStart && frac <= areaEnd;
}



const USER_TRIGGERS_STORAGE_KEY = "detector-triggers-v1";
const TRIGGER_DURATION_UNIT_MS = { ms: 1, s: 1000, min: 60_000 };
const TRIGGER_PRICE_MIN_CENTS = 0;
const TRIGGER_PRICE_MAX_CENTS = 100;
const TRIGGER_PRICE_MIN_GAP = 1;
const TRIGGER_WINDOW_AREA_MIN_SPAN = 0.02;
const TRIGGER_WINDOW_THUMB_PX = 12;
const TRIGGER_DEMO_SHARES = 1;

let triggerCreateDurationMs = 5000;
let triggerCreateName = "";
let triggerCreateColor = "#58a6ff";
let triggerCreatePriceSide = "buy";
let triggerCreateEndMode = "range";
let triggerCreateEndChangeSideCents = 20;
let triggerCreateEndChangeCents = 20;
let triggerCreatePriceRanges = {
  start: { lowCents: 40, highCents: 70 },
  end: { lowCents: 40, highCents: 70 },
};
let triggerCreatePtbGap = { start: null, end: null };
let triggerCreateGapSize = {
  start: { bound: "min", value: 0 },
  end: { bound: "min", value: 0 },
};
let triggerCreateTakeProfitCents = 80;
let triggerCreateStopLossCents = 20;
let triggerCreateActiveTab = "buy";
let triggerCreateWindowArea = { start: 0, end: 1 };
let triggerWindowAreaDrag = null;
let triggerPriceDrag = null;

let userTriggers = [];
const triggerLiveStatsCache = Object.create(null);
let triggerCreateEditingId = null;
let openTriggerMenuId = null;
const triggerRuntimeById = new Map();


function userTriggersStorageKey() {
  return userScopedStorageKey(USER_TRIGGERS_STORAGE_KEY);
}

function normalizeTriggerDemoStats(raw) {
  const success = Math.max(0, Math.round(Number(raw?.success) || 0));
  const fail = Math.max(0, Math.round(Number(raw?.fail) || 0));
  const takeProfit = Math.max(0, Math.round(Number(raw?.takeProfit) || 0));
  const stopLoss = Math.max(0, Math.round(Number(raw?.stopLoss) || 0));
  const pnlUsd = Number.isFinite(Number(raw?.pnlUsd)) ? Number(raw.pnlUsd) : 0;
  return { success, fail, takeProfit, stopLoss, pnlUsd };
}

function normalizeTriggerRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id != null ? String(raw.id) : "";
  if (!id) return null;
  return {
    ...raw,
    id,
    runMode: raw.runMode === "trade" ? "trade" : "demo",
    paused: raw.paused !== false,
    demoStats: normalizeTriggerDemoStats(raw.demoStats),
  };
}

function loadUserTriggers() {
  try {
    const raw = localStorage.getItem(userTriggersStorageKey());
    if (!raw) {
      userTriggers = [];
      return userTriggers;
    }
    const parsed = JSON.parse(raw);
    userTriggers = Array.isArray(parsed)
      ? parsed.map(normalizeTriggerRecord).filter(Boolean)
      : [];
  } catch {
    userTriggers = [];
  }
  return userTriggers;
}

function saveUserTriggers() {
  try {
    localStorage.setItem(userTriggersStorageKey(), JSON.stringify(userTriggers));
  } catch {
    /* ignore quota / private mode */
  }
}

function findUserTrigger(id) {
  const key = String(id || "");
  return userTriggers.find((t) => String(t?.id) === key) || null;
}

function patchUserTrigger(id, patch) {
  const key = String(id || "");
  const idx = userTriggers.findIndex((t) => String(t?.id) === key);
  if (idx < 0) return null;
  userTriggers[idx] = normalizeTriggerRecord({ ...userTriggers[idx], ...patch });
  saveUserTriggers();
  return userTriggers[idx];
}

function setTriggerRunMode(triggerId, mode) {
  const next = mode === "trade" ? "trade" : "demo";
  const trigger = patchUserTrigger(triggerId, { runMode: next });
  if (!trigger) return;
  renderTriggersList();
  if (next === "trade") {
    void fetchTriggerLiveStats(triggerId).then(() => updateTriggerCardStats(triggerId));
  }
  if (triggerCreateEditingId && String(triggerCreateEditingId) === String(triggerId)) {
    syncTriggerStatsPanel();
  }
}

function setTriggerPaused(triggerId, paused) {
  const patch = { paused: Boolean(paused) };
  const current = findUserTrigger(triggerId);
  if (paused && current?.runMode === "trade") patch.runMode = "demo";
  const trigger = patchUserTrigger(triggerId, patch);
  if (!trigger) return;
  if (paused) clearTriggerRuntime(triggerId);
  renderTriggersList();
  if (triggerCreateEditingId && String(triggerCreateEditingId) === String(triggerId)) {
    syncTriggerStatsPanel();
  }
}

function closeTriggerMenus() {
  if (typeof closeSetupMenus === "function") closeSetupMenus();
  document.querySelectorAll(".schedule-setup-menu-floating").forEach((el) => el.remove());
  openTriggerMenuId = null;
}

function deleteUserTrigger(trigger) {
  closeTriggerMenus();
  const id = trigger?.id != null ? String(trigger.id) : "";
  if (!id) return;
  const label = String(trigger.name || "Untitled trigger");
  if (!window.confirm(`Delete "${label}"?\n\nThis cannot be undone.`)) return;
  userTriggers = userTriggers.filter((t) => String(t?.id) !== id);
  saveUserTriggers();
  clearTriggerRuntime(id);
  void fetch(`/api/triggers/${encodeURIComponent(id)}/stats`, { method: "DELETE" }).catch(
    () => {},
  );
  renderTriggersList();
  if (triggerCreateEditingId && String(triggerCreateEditingId) === id) {
    closeTriggerCreateModal();
  }
}

function renderTriggersList() {
  const empty = $("triggers-empty");
  const cards = $("triggers-cards");
  const body = $("triggers-list");
  if (!cards) return;
  closeTriggerMenus();
  cards.replaceChildren();
  const list = Array.isArray(userTriggers) ? userTriggers : [];
  if (empty) empty.hidden = list.length > 0;
  for (const trigger of list) {
    const triggerId = String(trigger.id || "");
    const paused = trigger.paused !== false;
    const runMode = trigger.runMode === "trade" ? "trade" : "demo";
    const card = document.createElement("article");
    card.className = "trigger-card";
    if (paused) card.classList.add("is-paused");
    card.dataset.triggerId = triggerId;
    const color = typeof trigger.color === "string" ? trigger.color : "#58a6ff";
    card.style.borderLeftColor = color;

    const header = document.createElement("div");
    header.className = "trigger-card-header";

    const title = document.createElement("div");
    title.className = "trigger-card-title";
    title.textContent = String(trigger.name || "Untitled trigger");

    const menuWrap = document.createElement("div");
    menuWrap.className = "schedule-setup-menu-wrap";
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "schedule-setup-menu-btn";
    menuBtn.setAttribute("aria-label", "Trigger options");
    menuBtn.setAttribute("aria-haspopup", "menu");
    menuBtn.innerHTML = "&#8942;";
    menuBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    menuBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (openTriggerMenuId === triggerId) {
        closeTriggerMenus();
        return;
      }
      closeTriggerMenus();
      openTriggerMenuId = triggerId;
      const menu = document.createElement("div");
      menu.className = "schedule-setup-menu schedule-setup-menu-floating";
      menu.setAttribute("role", "menu");

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "schedule-setup-menu-item";
      editBtn.setAttribute("role", "menuitem");
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeTriggerMenus();
        openTriggerEditModal(trigger);
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "schedule-setup-menu-item schedule-setup-menu-item-danger";
      deleteBtn.setAttribute("role", "menuitem");
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        deleteUserTrigger(trigger);
      });

      menu.append(editBtn, deleteBtn);
      document.body.appendChild(menu);
      positionSetupMenu(menu, menuBtn);
    });
    menuWrap.appendChild(menuBtn);
    header.append(title, menuWrap);

    const controls = document.createElement("div");
    controls.className = "trigger-card-controls";

    const modeWrap = document.createElement("div");
    modeWrap.className = "trigger-run-mode";
    modeWrap.setAttribute("role", "group");
    modeWrap.setAttribute("aria-label", "Demo or Trade");
    for (const mode of ["demo", "trade"]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "trigger-run-mode-btn";
      btn.dataset.mode = mode;
      btn.textContent = mode === "demo" ? "Demo" : "Trade";
      if (runMode === mode) btn.classList.add("is-active");
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setTriggerRunMode(triggerId, mode);
      });
      modeWrap.appendChild(btn);
    }

    const pauseWrap = document.createElement("div");
    pauseWrap.className = "trigger-run-mode trigger-pause-mode";
    pauseWrap.setAttribute("role", "group");
    pauseWrap.setAttribute("aria-label", "Pause or Active");
    for (const state of ["pause", "active"]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "trigger-run-mode-btn";
      btn.dataset.pauseState = state;
      btn.textContent = state === "pause" ? "Pause" : "Active";
      const isSelected = state === "pause" ? paused : !paused;
      if (isSelected) btn.classList.add("is-active");
      btn.title =
        state === "pause"
          ? "Pause trigger (forces Demo if Trade was on)"
          : "Run trigger evaluation";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setTriggerPaused(triggerId, state === "pause");
      });
      pauseWrap.appendChild(btn);
    }

    controls.append(modeWrap, pauseWrap);

    const statsRow = document.createElement("div");
    statsRow.className = "trigger-card-stats";
    statsRow.setAttribute("aria-label", runMode === "trade" ? "Trade stats" : "Demo stats");
    statsRow.innerHTML =
      '<div class="trigger-card-stats-exits">' +
      '<span class="trigger-card-stats-item"><span class="trigger-card-stats-label">Take Profit</span><span class="trigger-card-stats-value" data-stat="takeProfit">0</span></span>' +
      '<span class="trigger-card-stats-item"><span class="trigger-card-stats-label">Stop Loss</span><span class="trigger-card-stats-value" data-stat="stopLoss">0</span></span>' +
      "</div>" +
      '<div class="trigger-card-stats-main">' +
      '<span class="trigger-card-stats-item is-count" title="Success"><span class="trigger-card-stats-dot is-success" aria-hidden="true"></span><span class="trigger-card-stats-value" data-stat="success">0</span></span>' +
      '<span class="trigger-card-stats-item is-count" title="Fail"><span class="trigger-card-stats-dot is-fail" aria-hidden="true"></span><span class="trigger-card-stats-value" data-stat="fail">0</span></span>' +
      '<span class="trigger-card-stats-item"><span class="trigger-card-stats-label">P/L</span><span class="trigger-card-stats-value" data-stat="pnl">$0.00</span></span>' +
      "</div>";

    card.append(header, controls, statsRow);
    cards.appendChild(card);
    fillTriggerCardStatsRow(statsRow, trigger);
    if (runMode === "trade" && !triggerLiveStatsCache[triggerId]) {
      void fetchTriggerLiveStats(triggerId).then(() => updateTriggerCardStats(triggerId));
    }
  }
  if (body) {
    const h = Number.parseFloat(
      getComputedStyle(body.closest(".left-column") || document.documentElement)
        .getPropertyValue("--triggers-content-height"),
    );
    const open = Number.isFinite(h) ? h > 0 : true;
    body.classList.toggle("is-scrollable", open && list.length > 0);
  }
}

function resolveTriggerCardStats(trigger) {
  if (!trigger) {
    return { success: 0, fail: 0, takeProfit: 0, stopLoss: 0, pnlUsd: 0, pending: false };
  }
  if (trigger.runMode === "trade") {
    const cached = triggerLiveStatsCache[String(trigger.id)];
    if (!cached) {
      return { success: 0, fail: 0, takeProfit: 0, stopLoss: 0, pnlUsd: 0, pending: true };
    }
    return { ...normalizeTriggerDemoStats(cached), pending: false };
  }
  return { ...normalizeTriggerDemoStats(trigger.demoStats), pending: false };
}

function fillTriggerCardStatsRow(statsRow, trigger) {
  if (!statsRow) return;
  const stats = resolveTriggerCardStats(trigger);
  const successEl = statsRow.querySelector('[data-stat="success"]');
  const failEl = statsRow.querySelector('[data-stat="fail"]');
  const tpEl = statsRow.querySelector('[data-stat="takeProfit"]');
  const slEl = statsRow.querySelector('[data-stat="stopLoss"]');
  const pnlEl = statsRow.querySelector('[data-stat="pnl"]');
  if (successEl) successEl.textContent = stats.pending ? "…" : String(stats.success);
  if (failEl) failEl.textContent = stats.pending ? "…" : String(stats.fail);
  if (tpEl) tpEl.textContent = stats.pending ? "…" : String(stats.takeProfit);
  if (slEl) slEl.textContent = stats.pending ? "…" : String(stats.stopLoss);
  if (pnlEl) {
    pnlEl.textContent = stats.pending ? "…" : formatTriggerStatsPnl(stats.pnlUsd);
    pnlEl.classList.toggle("is-pos", !stats.pending && stats.pnlUsd > 0);
    pnlEl.classList.toggle("is-neg", !stats.pending && stats.pnlUsd < 0);
  }
  statsRow.setAttribute(
    "aria-label",
    trigger?.runMode === "trade" ? "Trade stats" : "Demo stats",
  );
}

function updateTriggerCardStats(triggerId) {
  const id = String(triggerId || "");
  const trigger = findUserTrigger(id);
  const card = document.querySelector(`.trigger-card[data-trigger-id="${CSS.escape(id)}"]`);
  const statsRow = card?.querySelector(".trigger-card-stats");
  if (!trigger || !statsRow) return;
  fillTriggerCardStatsRow(statsRow, trigger);
}

function formatTriggerStatsPnl(pnlUsd) {
  const n = Number(pnlUsd);
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}

async function fetchTriggerLiveStats(triggerId) {
  const id = String(triggerId || "");
  if (!id) return null;
  try {
    const res = await fetch(`/api/triggers/${encodeURIComponent(id)}/stats`);
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== "object") return null;
    const stats = normalizeTriggerDemoStats(body);
    triggerLiveStatsCache[id] = stats;
    return stats;
  } catch {
    return null;
  }
}

function syncTriggerStatsPanel() {
  const setText = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };
  const note = $("trigger-stats-note");
  if (!triggerCreateEditingId) {
    setText("trigger-stats-live-success", "—");
    setText("trigger-stats-live-fail", "—");
    setText("trigger-stats-live-take-profit", "—");
    setText("trigger-stats-live-stop-loss", "—");
    setText("trigger-stats-live-pnl", "—");
    if (note) {
      note.textContent = "Save the trigger first to collect Trade stats on the server.";
    }
    return;
  }
  if (note) {
    note.textContent =
      "All-time Trade stats for this trigger across every live session (stored on the server).";
  }
  const cached = triggerLiveStatsCache[String(triggerCreateEditingId)];
  if (cached) {
    setText("trigger-stats-live-success", String(cached.success));
    setText("trigger-stats-live-fail", String(cached.fail));
    setText("trigger-stats-live-take-profit", String(cached.takeProfit));
    setText("trigger-stats-live-stop-loss", String(cached.stopLoss));
    setText("trigger-stats-live-pnl", formatTriggerStatsPnl(cached.pnlUsd));
  } else {
    setText("trigger-stats-live-success", "…");
    setText("trigger-stats-live-fail", "…");
    setText("trigger-stats-live-take-profit", "…");
    setText("trigger-stats-live-stop-loss", "…");
    setText("trigger-stats-live-pnl", "…");
  }
}

function setTriggerCreateActiveTab(tabId) {
  const id = tabId === "sell" ? "sell" : tabId === "stats" ? "stats" : "buy";
  triggerCreateActiveTab = id;
  const modal = $("trigger-create-modal");
  if (!modal) return;
  const tabs = [...modal.querySelectorAll("[data-trigger-tab]")];
  const panels = [...modal.querySelectorAll("[data-trigger-tab-panel]")];
  for (const tab of tabs) {
    const active = tab.getAttribute("data-trigger-tab") === id;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of panels) {
    const active = panel.getAttribute("data-trigger-tab-panel") === id;
    panel.hidden = !active;
  }
  if (id === "buy") {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        renderAllTriggerPriceRanges();
        syncTriggerWindowAreaUi();
      });
    });
  }
  if (id === "stats") {
    syncTriggerStatsPanel();
    if (triggerCreateEditingId) {
      void fetchTriggerLiveStats(triggerCreateEditingId).then(() => syncTriggerStatsPanel());
    }
  }
}

function clampTriggerCents(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return TRIGGER_PRICE_MIN_CENTS;
  return Math.max(TRIGGER_PRICE_MIN_CENTS, Math.min(TRIGGER_PRICE_MAX_CENTS, n));
}

function clampTriggerSignedCents(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-TRIGGER_PRICE_MAX_CENTS, Math.min(TRIGGER_PRICE_MAX_CENTS, n));
}

function clampTriggerDurationValue(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 1_000_000_000);
}

function normalizeTriggerPriceRange(range) {
  let low = clampTriggerCents(range?.lowCents);
  let high = clampTriggerCents(range?.highCents);
  if (high < low + TRIGGER_PRICE_MIN_GAP) {
    high = Math.min(TRIGGER_PRICE_MAX_CENTS, low + TRIGGER_PRICE_MIN_GAP);
    if (high < low + TRIGGER_PRICE_MIN_GAP) {
      low = Math.max(TRIGGER_PRICE_MIN_CENTS, high - TRIGGER_PRICE_MIN_GAP);
    }
  }
  return { lowCents: low, highCents: high };
}

function normalizeTriggerEndMode(raw) {
  if (raw === "change" || raw === "change-side") return raw;
  return "range";
}

function normalizeTriggerGapSize(raw) {
  const bound = raw?.bound === "max" ? "max" : "min";
  let value = Number(raw?.value);
  if (!Number.isFinite(value) || value < 0) value = 0;
  value = Math.min(100000, Math.round(value * 100) / 100);
  return { bound, value };
}

function normalizeTriggerWindowArea(startRaw, endRaw) {
  let start = Number(startRaw);
  let end = Number(endRaw);
  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(end)) end = 1;
  start = Math.max(0, Math.min(1, start));
  end = Math.max(0, Math.min(1, end));
  if (end - start < TRIGGER_WINDOW_AREA_MIN_SPAN) {
    if (start > 1 - TRIGGER_WINDOW_AREA_MIN_SPAN) {
      start = 1 - TRIGGER_WINDOW_AREA_MIN_SPAN;
      end = 1;
    } else {
      end = Math.min(1, start + TRIGGER_WINDOW_AREA_MIN_SPAN);
    }
  }
  return { start, end };
}

function readTriggerDurationMsFromInputs() {
  const valueEl = $("trigger-duration-value");
  const unitEl = $("trigger-duration-unit");
  const value = clampTriggerDurationValue(valueEl?.value);
  const unit = unitEl?.value in TRIGGER_DURATION_UNIT_MS ? unitEl.value : "s";
  if (valueEl && String(value) !== String(valueEl.value)) valueEl.value = String(value);
  return value * TRIGGER_DURATION_UNIT_MS[unit];
}

function applyTriggerDurationToInputs(ms) {
  const valueEl = $("trigger-duration-value");
  const unitEl = $("trigger-duration-unit");
  if (!valueEl || !unitEl) return;
  const n = Number(ms);
  if (Number.isFinite(n) && n >= 60_000 && n % 60_000 === 0) {
    valueEl.value = String(n / 60_000);
    unitEl.value = "min";
  } else if (Number.isFinite(n) && n >= 1000 && n % 1000 === 0) {
    valueEl.value = String(n / 1000);
    unitEl.value = "s";
  } else {
    valueEl.value = String(Math.max(1, Math.round(Number.isFinite(n) ? n : 5000)));
    unitEl.value = "ms";
  }
  syncTriggerDurationDraft();
}

function applyTriggerSellToInputs(takeProfitCents, stopLossCents) {
  triggerCreateTakeProfitCents = clampTriggerCents(takeProfitCents ?? 80);
  triggerCreateStopLossCents = clampTriggerCents(stopLossCents ?? 20);
  const tpEl = $("trigger-take-profit");
  const slEl = $("trigger-stop-loss");
  if (tpEl) tpEl.value = String(triggerCreateTakeProfitCents);
  if (slEl) slEl.value = String(triggerCreateStopLossCents);
}

function syncTriggerDurationDraft() {
  triggerCreateDurationMs = readTriggerDurationMsFromInputs();
}

function syncTriggerCreateNameDraft() {
  triggerCreateName = $("trigger-create-name")?.value?.trim() ?? "";
  syncTriggerCreateSubmitState();
}

function syncTriggerCreateColorDraft() {
  const colorInput = $("trigger-create-color");
  triggerCreateColor = colorInput?.value || "#58a6ff";
  syncTriggerCreateColorIconContrast();
}

function syncTriggerCreateColorIconContrast() {
  const colorInput = $("trigger-create-color");
  const swatch = colorInput?.closest?.(".setup-edit-color-swatch");
  if (!swatch) return;
  const color = colorInput?.value || triggerCreateColor || "#58a6ff";
  swatch.classList.toggle("is-light-setup", isLightHexColor(color));
}

function syncTriggerCreateSubmitState() {
  const btn = $("trigger-create-submit");
  if (btn) btn.disabled = !triggerCreateName;
}

function syncTriggerCreateModalChrome() {
  const title = $("trigger-create-modal-title");
  const submit = $("trigger-create-submit");
  const editing = Boolean(triggerCreateEditingId);
  if (title) title.textContent = editing ? "Edit Trigger" : "Create Trigger";
  if (submit) submit.textContent = editing ? "Save" : "Create";
}

function syncTriggerCreateSellDraft() {
  triggerCreateTakeProfitCents = clampTriggerCents($("trigger-take-profit")?.value ?? 80);
  triggerCreateStopLossCents = clampTriggerCents($("trigger-stop-loss")?.value ?? 20);
  const tpEl = $("trigger-take-profit");
  const slEl = $("trigger-stop-loss");
  if (tpEl && String(tpEl.value) !== String(triggerCreateTakeProfitCents)) {
    tpEl.value = String(triggerCreateTakeProfitCents);
  }
  if (slEl && String(slEl.value) !== String(triggerCreateStopLossCents)) {
    slEl.value = String(triggerCreateStopLossCents);
  }
}

function syncTriggerCreateSideUi() {
  const side = triggerCreatePriceSide === "sell" ? "sell" : "buy";
  const mode = normalizeTriggerEndMode(triggerCreateEndMode);
  const sideLabel = side === "sell" ? "SELL" : "BUY";
  const startEl = $("trigger-price-side-start");
  const modeEl = $("trigger-end-mode");

  if (startEl) {
    startEl.value = side;
    startEl.classList.toggle("is-buy", side === "buy");
    startEl.classList.toggle("is-sell", side === "sell");
  }

  if (modeEl) {
    const rangeOpt = modeEl.querySelector('option[value="range"]');
    const changeOpt = modeEl.querySelector('option[value="change-side"]');
    if (rangeOpt) rangeOpt.textContent = sideLabel + " Price Range";
    if (changeOpt) changeOpt.textContent = sideLabel + " Price Change";
    if ([...modeEl.options].some((o) => o.value === mode)) modeEl.value = mode;
    else modeEl.value = "range";
    modeEl.classList.toggle("is-buy", side === "buy");
    modeEl.classList.toggle("is-sell", side === "sell");
  }

  document.querySelectorAll(".trigger-price-column").forEach((col) => {
    col.classList.toggle("is-buy", side === "buy");
    col.classList.toggle("is-sell", side === "sell");
  });
}

function syncTriggerCreateSideDraft(fromEl) {
  const side = fromEl?.value === "sell" ? "sell" : "buy";
  triggerCreatePriceSide = side;
  syncTriggerCreateSideUi();
}

function syncTriggerCreateEndModeDraft() {
  triggerCreateEndMode = normalizeTriggerEndMode($("trigger-end-mode")?.value);
  syncTriggerCreateSideUi();
  renderAllTriggerPriceRanges();
}

function syncTriggerGapSizeControl(edge) {
  const control = document.querySelector(`.trigger-gap-size-control[data-edge="${edge}"]`);
  if (!control) return;
  const size = normalizeTriggerGapSize(triggerCreateGapSize[edge]);
  triggerCreateGapSize[edge] = size;
  const boundEl = control.querySelector("[data-gap-bound]");
  const valueEl = control.querySelector("[data-gap-value]");
  if (boundEl) boundEl.value = size.bound;
  if (valueEl && document.activeElement !== valueEl) {
    valueEl.value = String(size.value);
  }
  control.classList.toggle("is-any-size", size.value <= 0);
}

function syncTriggerWindowAreaUi() {
  const area = normalizeTriggerWindowArea(
    triggerCreateWindowArea.start,
    triggerCreateWindowArea.end,
  );
  triggerCreateWindowArea = area;
  const durationSec =
    typeof manipulationWindowDurationSec === "function"
      ? manipulationWindowDurationSec()
      : 300;
  const range = $("trigger-window-area-range");
  const startThumb = $("trigger-window-area-start");
  const endThumb = $("trigger-window-area-end");
  const startLabel = $("trigger-window-area-start-label");
  const endLabel = $("trigger-window-area-end-label");
  const span = Math.max(0, area.end - area.start);
  if (range) {
    range.style.left = triggerWindowThumbCenterCss(area.start);
    range.style.width = `calc(${span} * (100% - ${TRIGGER_WINDOW_THUMB_PX}px))`;
  }
  if (startThumb) startThumb.style.left = triggerWindowThumbLeftCss(area.start);
  if (endThumb) endThumb.style.left = triggerWindowThumbLeftCss(area.end);
  if (startLabel) {
    startLabel.textContent =
      typeof fmtManipAreaTime === "function"
        ? fmtManipAreaTime(area.start, durationSec)
        : "0:00";
    startLabel.style.left = triggerWindowThumbCenterCss(area.start);
  }
  if (endLabel) {
    endLabel.textContent =
      typeof fmtManipAreaTime === "function"
        ? fmtManipAreaTime(area.end, durationSec)
        : "5:00";
    endLabel.style.left = triggerWindowThumbCenterCss(area.end);
  }
}

function triggerWindowThumbLeftCss(frac) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  return `calc(${f} * (100% - ${TRIGGER_WINDOW_THUMB_PX}px))`;
}

function triggerWindowThumbCenterCss(frac) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  return `calc(${f} * (100% - ${TRIGGER_WINDOW_THUMB_PX}px) + ${TRIGGER_WINDOW_THUMB_PX / 2}px)`;
}

function formatTriggerSignedCentsLabel(signed) {
  const n = clampTriggerSignedCents(signed);
  if (n > 0) return `+${n}¢`;
  return `${n}¢`;
}

function formatTriggerDurationLabel(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 1) return "—";
  if (n % 60_000 === 0) return `${n / 60_000} min`;
  if (n % 1000 === 0) return `${n / 1000}s`;
  return `${Math.round(n)}ms`;
}

function getTriggerPriceScale(edge) {
  const track = $(edge === "start" ? "trigger-start-track" : "trigger-end-track");
  return track?.querySelector(".trigger-price-scale") || null;
}

function clientYToTriggerCents(scale, clientY) {
  const rect = scale.getBoundingClientRect();
  if (rect.height <= 0) return 0;
  // Top of scale = 100¢, bottom = 0¢
  const ratio = (rect.bottom - clientY) / rect.height;
  return clampTriggerCents(ratio * TRIGGER_PRICE_MAX_CENTS);
}

function clientYToTriggerSignedCents(scale, clientY) {
  const rect = scale.getBoundingClientRect();
  if (rect.height <= 0) return 0;
  // Top = +100¢, mid = 0, bottom = -100¢
  const ratio = (rect.bottom - clientY) / rect.height;
  return clampTriggerSignedCents(ratio * (TRIGGER_PRICE_MAX_CENTS * 2) - TRIGGER_PRICE_MAX_CENTS);
}

function centsToTrackBottomPct(cents) {
  return (clampTriggerCents(cents) / TRIGGER_PRICE_MAX_CENTS) * 100;
}

function signedCentsToTrackBottomPct(signed) {
  return ((clampTriggerSignedCents(signed) + TRIGGER_PRICE_MAX_CENTS) / (TRIGGER_PRICE_MAX_CENTS * 2)) * 100;
}

function setTriggerPriceThumb(edge, thumb, cents) {
  const endMode = edge === "end" ? normalizeTriggerEndMode(triggerCreateEndMode) : "range";
  if (endMode === "change") {
    triggerCreateEndChangeCents = clampTriggerCents(cents);
    renderTriggerPriceRange("end");
    return;
  }
  if (endMode === "change-side") {
    triggerCreateEndChangeSideCents = clampTriggerSignedCents(cents);
    renderTriggerPriceRange("end");
    return;
  }
  const range = { ...normalizeTriggerPriceRange(triggerCreatePriceRanges[edge]) };
  let next = clampTriggerCents(cents);
  if (thumb === "high") {
    if (next < range.lowCents + TRIGGER_PRICE_MIN_GAP) {
      range.lowCents = Math.max(TRIGGER_PRICE_MIN_CENTS, next - TRIGGER_PRICE_MIN_GAP);
      next = Math.max(next, range.lowCents + TRIGGER_PRICE_MIN_GAP);
    }
    range.highCents = next;
  } else {
    if (next > range.highCents - TRIGGER_PRICE_MIN_GAP) {
      range.highCents = Math.min(TRIGGER_PRICE_MAX_CENTS, next + TRIGGER_PRICE_MIN_GAP);
      next = Math.min(next, range.highCents - TRIGGER_PRICE_MIN_GAP);
    }
    range.lowCents = next;
  }
  triggerCreatePriceRanges[edge] = normalizeTriggerPriceRange(range);
  renderTriggerPriceRange(edge);
}

function renderTriggerPriceRange(edge) {
  const scale = getTriggerPriceScale(edge);
  if (!scale) return;
  const col = scale.closest(".trigger-price-column");
  const fill = scale.querySelector(".trigger-price-range");
  const highThumb = scale.querySelector('[data-thumb="high"]');
  const lowThumb = scale.querySelector('[data-thumb="low"]');
  const highLabel = scale.querySelector(`[data-label="${edge}-high"]`);
  const lowLabel = scale.querySelector(`[data-label="${edge}-low"]`);
  const track = scale.closest(".trigger-price-track");
  const endMode = edge === "end" ? normalizeTriggerEndMode(triggerCreateEndMode) : "range";
  const isChange = endMode === "change";
  const isChangeSide = endMode === "change-side";
  col?.classList.toggle("is-change-mode", isChange);
  col?.classList.toggle("is-change-side-mode", isChangeSide);

  if (isChange) {
    const cents = clampTriggerCents(triggerCreateEndChangeCents);
    triggerCreateEndChangeCents = cents;
    const pct = centsToTrackBottomPct(cents);
    if (fill) {
      fill.style.bottom = "0%";
      fill.style.height = `${pct}%`;
    }
    if (highThumb) {
      highThumb.hidden = false;
      highThumb.style.bottom = `${pct}%`;
      highThumb.setAttribute("aria-label", "End price change in cents (either direction)");
    }
    if (lowThumb) lowThumb.hidden = true;
    if (highLabel) highLabel.textContent = `${cents}¢`;
    if (track) track.setAttribute("aria-label", "End price change in cents, either direction");
    return;
  }

  if (isChangeSide) {
    const signed = clampTriggerSignedCents(triggerCreateEndChangeSideCents);
    triggerCreateEndChangeSideCents = signed;
    const pct = signedCentsToTrackBottomPct(signed);
    const midPct = 50;
    if (fill) {
      if (signed >= 0) {
        fill.style.bottom = `${midPct}%`;
        fill.style.height = `${Math.max(0, pct - midPct)}%`;
      } else {
        fill.style.bottom = `${pct}%`;
        fill.style.height = `${Math.max(0, midPct - pct)}%`;
      }
    }
    if (highThumb) {
      highThumb.hidden = false;
      highThumb.style.bottom = `${pct}%`;
      highThumb.setAttribute("aria-label", "End signed price change in cents");
    }
    if (lowThumb) lowThumb.hidden = true;
    if (highLabel) highLabel.textContent = formatTriggerSignedCentsLabel(signed);
    if (track) {
      track.setAttribute(
        "aria-label",
        "End signed price change: mid 0, top +100¢, bottom -100¢",
      );
    }
    return;
  }

  const range = normalizeTriggerPriceRange(triggerCreatePriceRanges[edge]);
  triggerCreatePriceRanges[edge] = range;
  const lowPct = centsToTrackBottomPct(range.lowCents);
  const highPct = centsToTrackBottomPct(range.highCents);
  if (fill) {
    fill.style.bottom = `${lowPct}%`;
    fill.style.height = `${Math.max(0, highPct - lowPct)}%`;
  }
  if (highThumb) {
    highThumb.hidden = false;
    highThumb.style.bottom = `${highPct}%`;
    highThumb.setAttribute(
      "aria-label",
      edge === "end" ? "End max price" : "Start max price",
    );
  }
  if (lowThumb) {
    lowThumb.hidden = false;
    lowThumb.style.bottom = `${lowPct}%`;
  }
  if (highLabel) highLabel.textContent = `${range.highCents}¢`;
  if (lowLabel) lowLabel.textContent = `${range.lowCents}¢`;
  if (track) {
    track.setAttribute(
      "aria-label",
      edge === "end" ? "End price range in cents" : "Start price range in cents",
    );
  }
}

function renderAllTriggerPriceRanges() {
  renderTriggerPriceRange("start");
  renderTriggerPriceRange("end");
  renderTriggerPtbGapUi();
}

function toggleTriggerPtbGap(edge, kind) {
  if (edge !== "start" && edge !== "end") return;
  if (kind !== "negative" && kind !== "positive") return;
  triggerCreatePtbGap[edge] = triggerCreatePtbGap[edge] === kind ? null : kind;
  renderTriggerPtbGapUi();
}

function renderTriggerPtbGapUi() {
  const stage = document.querySelector(".trigger-duration-stage");
  if (!stage) return;
  const stageRect = stage.getBoundingClientRect();
  if (stageRect.width < 1 || stageRect.height < 1) return;

  const startScale = getTriggerPriceScale("start");
  const endScale = getTriggerPriceScale("end");
  if (!startScale || !endScale) return;

  const built = buildTriggerMarketZigzagPoints(stageRect, startScale, endScale, triggerCreatePtbGap);
  const zigzagPoints = built.points;
  const ptbY = built.ptbY;
  const edgeLayouts = { start: null, end: null };
  const midX = (built.x0 + built.x1) / 2;
  const btnInset = Math.max(36, (built.x1 - built.x0) * 0.12);

  // Mid PTB line always visible in gold across the price path.
  const midLine = $("trigger-ptb-mid-line");
  if (midLine) {
    midLine.hidden = false;
    midLine.style.top = `${Math.round(ptbY)}px`;
    midLine.style.left = `${Math.round(built.x0)}px`;
    midLine.style.width = `${Math.round(built.x1 - built.x0)}px`;
    midLine.style.right = "auto";
    midLine.style.bottom = "auto";
  }

  for (const edge of ["start", "end"]) {
    const selected = triggerCreatePtbGap[edge];
    const scale = getTriggerPriceScale(edge);
    const col = document.querySelector(`.trigger-price-column[data-edge="${edge}"]`);
    if (!scale || !col) continue;
    const scaleRect = scale.getBoundingClientRect();

    // Top = market above mid line (+Gap); bottom = market below (-Gap).
    const yByKind = {
      positive: scaleRect.top - stageRect.top,
      negative: scaleRect.bottom - stageRect.top,
    };

    // Full half-width of the price path for fill + colored line.
    const halfX0 = edge === "start" ? built.x0 : midX;
    const halfX1 = edge === "start" ? midX : built.x1;
    const btnX = edge === "start" ? built.x0 + btnInset : built.x1 - btnInset;

    for (const kind of ["negative", "positive"]) {
      const btn = stage.querySelector(`.trigger-ptb-btn[data-edge="${edge}"][data-ptb="${kind}"]`);
      const active = selected === kind;
      if (btn) {
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", active ? "true" : "false");
        btn.style.left = `${Math.round(btnX)}px`;
        btn.style.top = `${Math.round(yByKind[kind])}px`;
      }
    }

    if (selected === "negative" || selected === "positive") {
      edgeLayouts[edge] = {
        x0: halfX0,
        x1: halfX1,
        ptbY,
        kind: selected,
      };
    }
  }

  renderTriggerMarketOverlay(stage, stageRect, zigzagPoints, edgeLayouts, ptbY, {
    x0: built.x0,
    x1: built.x1,
  });
}

function triggerGapZoneBounds(zigzagPoints, x0, x1, ptbY, kind) {
  const left = Math.min(x0, x1);
  const width = Math.max(0, Math.abs(x1 - x0));
  const zig = zigzagPoints.length
    ? sliceTriggerMarketPolyline(zigzagPoints, x0, x1)
    : [];
  let marketTop = Infinity;
  let marketBottom = -Infinity;
  for (const p of zig) {
    marketTop = Math.min(marketTop, p.y);
    marketBottom = Math.max(marketBottom, p.y);
  }
  if (!Number.isFinite(marketTop) || !Number.isFinite(marketBottom)) {
    const strip = 48;
    if (kind === "negative") {
      return { left, width, top: ptbY, height: strip, midY: ptbY + strip * 0.5 };
    }
    return { left, width, top: ptbY - strip, height: strip, midY: ptbY - strip * 0.5 };
  }
  if (kind === "negative") {
    const top = Math.min(ptbY, marketTop);
    const bottom = Math.max(ptbY, marketBottom);
    return {
      left,
      width,
      top,
      height: Math.max(0, bottom - top),
      midY: (ptbY + (marketTop + marketBottom) * 0.5) * 0.5 + (ptbY + (marketTop + marketBottom) * 0.5) * 0.5 / 2,
    };
  }
  const top = Math.min(ptbY, marketTop);
  const bottom = Math.max(ptbY, marketBottom);
  const marketMid = (marketTop + marketBottom) * 0.5;
  return {
    left,
    width,
    top,
    height: Math.max(0, bottom - top),
    midY: (ptbY + marketMid) * 0.5,
  };
}

function buildTriggerMarketZigzagPoints(stageRect, startScale, endScale, ptbGap) {
  const startRect = startScale.getBoundingClientRect();
  const endRect = endScale.getBoundingClientRect();
  const x0 = startRect.left + startRect.width / 2 - stageRect.left;
  const x1 = endRect.left + endRect.width / 2 - stageRect.left;
  const ptbY =
    (startRect.top + startRect.height / 2 + endRect.top + endRect.height / 2) / 2 -
    stageRect.top;
  const amp = Math.max(12, Math.min(startRect.height, endRect.height) * 0.22);
  const startKind =
    ptbGap?.start === "positive" || ptbGap?.start === "negative" ? ptbGap.start : null;
  const endKind =
    ptbGap?.end === "positive" || ptbGap?.end === "negative" ? ptbGap.end : null;
  const points = [];
  if (!startKind && !endKind) {
    return { points, ptbY, x0, x1 };
  }
  // Placeholder zigzag above PTB for +Gap, below for -Gap; crosses mid only when sides oppose.
  const sideSign = (kind) => (kind === "negative" ? 1 : kind === "positive" ? -1 : 0);
  const startSign = sideSign(startKind) || sideSign(endKind);
  const endSign = sideSign(endKind) || sideSign(startKind);
  const offsets = [0.2, -0.55, 0.7, -0.35, 0.85, -0.45, 0.3, -0.2, 0.15];
  const span = Math.max(1, x1 - x0);
  const midX = (x0 + x1) / 2;
  for (let i = 0; i < offsets.length; i++) {
    const t = i / (offsets.length - 1);
    const x = x0 + span * t;
    const sign = x < midX ? startSign : endSign;
    points.push({
      x,
      y: ptbY + amp * offsets[i] * sign,
    });
  }
  return { points, ptbY, x0, x1 };
}

function sampleTriggerMarketPolylineY(points, x) {
  if (!points.length) return 0;
  if (x <= points[0].x) return points[0].y;
  if (x >= points[points.length - 1].x) return points[points.length - 1].y;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (x >= a.x && x <= b.x) {
      const t = (x - a.x) / Math.max(1e-6, b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
  }
  return points[points.length - 1].y;
}

function sliceTriggerMarketPolyline(points, xLeft, xRight) {
  const eps = 0.5;
  const left = Math.min(xLeft, xRight);
  const right = Math.max(xLeft, xRight);
  const sliced = [];
  sliced.push({ x: left, y: sampleTriggerMarketPolylineY(points, left) });
  for (const p of points) {
    if (p.x > left + eps && p.x < right - eps) sliced.push(p);
  }
  sliced.push({ x: right, y: sampleTriggerMarketPolylineY(points, right) });
  return sliced;
}

function pointsAttrFromTriggerPolyline(points) {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

function buildTriggerGapFillPath(points, xLeft, xRight, ptbY) {
  const left = Math.min(xLeft, xRight);
  const right = Math.max(xLeft, xRight);
  const zig = sliceTriggerMarketPolyline(points, left, right);

  let d = `M ${left.toFixed(1)} ${ptbY.toFixed(1)}`;
  d += ` L ${right.toFixed(1)} ${ptbY.toFixed(1)}`;
  for (let i = zig.length - 1; i >= 0; i--) {
    d += ` L ${zig[i].x.toFixed(1)} ${zig[i].y.toFixed(1)}`;
  }
  d += " Z";
  return d;
}

function renderTriggerMarketOverlay(stage, stageRect, zigzagPoints, edgeLayouts, ptbY, pathSpan) {
  const overlay = $("trigger-market-overlay");
  const marketLine = $("trigger-market-line");
  if (!overlay || !marketLine || !zigzagPoints.length) return;

  overlay.setAttribute(
    "viewBox",
    `0 0 ${Math.max(1, stageRect.width)} ${Math.max(1, stageRect.height)}`,
  );

  const startKind = edgeLayouts.start?.kind || null;
  const endKind = edgeLayouts.end?.kind || null;
  const anyGap = Boolean(startKind || endKind);
  if (!anyGap) {
    marketLine.removeAttribute("hidden");
    marketLine.classList.remove("is-negative", "is-positive");
    marketLine.setAttribute("points", pointsAttrFromTriggerPolyline(zigzagPoints));
  } else {
    marketLine.setAttribute("hidden", "");
    marketLine.removeAttribute("points");
  }

  const midX = pathSpan ? (pathSpan.x0 + pathSpan.x1) / 2 : 0;

  for (const edge of ["start", "end"]) {
    const fill = overlay.querySelector(`.trigger-gap-fill[data-edge="${edge}"]`);
    const sideLine = overlay.querySelector(`.trigger-market-line-side[data-edge="${edge}"]`);
    const sizeControl = stage.querySelector(`.trigger-gap-size-control[data-edge="${edge}"]`);
    if (!fill) continue;
    const layout = edgeLayouts[edge];
    const kind = layout?.kind || null;

    if (!layout) {
      fill.setAttribute("hidden", "");
      fill.removeAttribute("d");
      fill.classList.remove("is-negative", "is-positive");
      if (sizeControl) {
        sizeControl.hidden = true;
        sizeControl.classList.remove("is-negative", "is-positive");
      }
    } else {
      fill.removeAttribute("hidden");
      fill.classList.toggle("is-negative", kind === "negative");
      fill.classList.toggle("is-positive", kind === "positive");
      fill.setAttribute(
        "d",
        buildTriggerGapFillPath(zigzagPoints, layout.x0, layout.x1, ptbY),
      );

      if (sizeControl) {
        const zoneMidX = (layout.x0 + layout.x1) / 2;
        const ptbPad = 8;
        sizeControl.style.left = `${zoneMidX}px`;
        sizeControl.style.top =
          kind === "positive" ? `${ptbY - ptbPad}px` : `${ptbY + ptbPad}px`;
        sizeControl.classList.toggle("is-negative", kind === "negative");
        sizeControl.classList.toggle("is-positive", kind === "positive");
        sizeControl.hidden = false;
        syncTriggerGapSizeControl(edge);
      }
    }

    if (sideLine) {
      if (!anyGap || !pathSpan) {
        sideLine.setAttribute("hidden", "");
        sideLine.removeAttribute("points");
        sideLine.classList.remove("is-negative", "is-positive");
      } else {
        let lineX0 = pathSpan.x0;
        let lineX1 = pathSpan.x1;
        let lineKind = kind;
        if (startKind && endKind) {
          lineX0 = edge === "start" ? pathSpan.x0 : midX;
          lineX1 = edge === "start" ? midX : pathSpan.x1;
          lineKind = kind;
        } else if (startKind && !endKind) {
          if (edge !== "start") {
            sideLine.setAttribute("hidden", "");
            sideLine.removeAttribute("points");
            sideLine.classList.remove("is-negative", "is-positive");
            continue;
          }
          lineKind = startKind;
        } else if (endKind && !startKind) {
          if (edge !== "end") {
            sideLine.setAttribute("hidden", "");
            sideLine.removeAttribute("points");
            sideLine.classList.remove("is-negative", "is-positive");
            continue;
          }
          lineKind = endKind;
        }
        if (!lineKind) {
          sideLine.setAttribute("hidden", "");
          sideLine.removeAttribute("points");
          sideLine.classList.remove("is-negative", "is-positive");
          continue;
        }
        const sidePoints = sliceTriggerMarketPolyline(zigzagPoints, lineX0, lineX1);
        sideLine.setAttribute("points", pointsAttrFromTriggerPolyline(sidePoints));
        sideLine.classList.toggle("is-negative", lineKind === "negative");
        sideLine.classList.toggle("is-positive", lineKind === "positive");
        sideLine.removeAttribute("hidden");
      }
    }
  }
}

function bindTriggerPriceRangeDrag() {
  const modal = $("trigger-create-modal");
  if (!modal || modal.dataset.priceDragBound === "1") return;
  modal.dataset.priceDragBound = "1";

  let drag = null;

  const centsFromEvent = (edge, track, clientY) => {
    const endMode = edge === "end" ? normalizeTriggerEndMode(triggerCreateEndMode) : "range";
    if (endMode === "change-side") return clientYToTriggerSignedCents(track, clientY);
    return clientYToTriggerCents(track, clientY);
  };

  const onPointerMove = (e) => {
    if (!drag) return;
    const cents = centsFromEvent(drag.edge, drag.track, e.clientY);
    setTriggerPriceThumb(drag.edge, drag.thumb, cents);
  };

  const stopDrag = (e) => {
    if (!drag) return;
    const { thumbEl, pointerId } = drag;
    drag = null;
    thumbEl.classList.remove("is-dragging");
    document.body.classList.remove("is-trigger-price-dragging");
    try {
      thumbEl.releasePointerCapture(pointerId);
    } catch {
      /* ignore */
    }
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopDrag);
    window.removeEventListener("pointercancel", stopDrag);
  };

  modal.querySelectorAll(".trigger-price-thumb").forEach((thumbEl) => {
    thumbEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const edge = thumbEl.dataset.edge;
      const thumb = thumbEl.dataset.thumb;
      const track = thumbEl.closest(".trigger-price-track");
      if ((edge !== "start" && edge !== "end") || (thumb !== "high" && thumb !== "low") || !track) {
        return;
      }
      drag = { edge, thumb, track, thumbEl, pointerId: e.pointerId };
      thumbEl.classList.add("is-dragging");
      document.body.classList.add("is-trigger-price-dragging");
      try {
        thumbEl.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stopDrag);
      window.addEventListener("pointercancel", stopDrag);
      setTriggerPriceThumb(edge, thumb, centsFromEvent(edge, track, e.clientY));
      e.preventDefault();
    });
  });
}

function bindTriggerWindowAreaSlider() {
  const modal = $("trigger-create-modal");
  const track = $("trigger-window-area-slider")?.querySelector(".manipulation-area-track");
  if (!modal || !track || modal.dataset.windowAreaBound === "1") return;
  modal.dataset.windowAreaBound = "1";

  const fracFromEvent = (event) => {
    const rect = track.getBoundingClientRect();
    const travel = rect.width - TRIGGER_WINDOW_THUMB_PX;
    if (travel <= 0) return 0;
    return Math.max(
      0,
      Math.min(1, (event.clientX - rect.left - TRIGGER_WINDOW_THUMB_PX / 2) / travel),
    );
  };

  const onMove = (event) => {
    if (!triggerWindowAreaDrag) return;
    const frac = fracFromEvent(event);
    if (triggerWindowAreaDrag === "start") {
      triggerCreateWindowArea = normalizeTriggerWindowArea(
        Math.min(frac, triggerCreateWindowArea.end - TRIGGER_WINDOW_AREA_MIN_SPAN),
        triggerCreateWindowArea.end,
      );
    } else {
      triggerCreateWindowArea = normalizeTriggerWindowArea(
        triggerCreateWindowArea.start,
        Math.max(frac, triggerCreateWindowArea.start + TRIGGER_WINDOW_AREA_MIN_SPAN),
      );
    }
    syncTriggerWindowAreaUi();
  };

  const onUp = () => {
    if (!triggerWindowAreaDrag) return;
    triggerWindowAreaDrag = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };

  for (const thumb of track.querySelectorAll("[data-thumb]")) {
    thumb.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      triggerWindowAreaDrag = thumb.getAttribute("data-thumb") === "end" ? "end" : "start";
      try {
        thumb.setPointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      onMove(event);
    });
  }
}

function resetTriggerCreateForm() {
  const nameEl = $("trigger-create-name");
  const colorEl = $("trigger-create-color");
  const valueEl = $("trigger-duration-value");
  const unitEl = $("trigger-duration-unit");
  if (nameEl) nameEl.value = "";
  if (colorEl) colorEl.value = "#58a6ff";
  if (valueEl) valueEl.value = "5";
  if (unitEl) unitEl.value = "s";
  triggerCreateName = "";
  triggerCreateColor = "#58a6ff";
  triggerCreateDurationMs = 5000;
  triggerCreatePriceSide = "buy";
  triggerCreateEndMode = "range";
  triggerCreateEndChangeSideCents = 20;
  triggerCreatePriceRanges = {
    start: { lowCents: 40, highCents: 70 },
    end: { lowCents: 40, highCents: 70 },
  };
  triggerCreatePtbGap = { start: null, end: null };
  triggerCreateGapSize = {
    start: { bound: "min", value: 0 },
    end: { bound: "min", value: 0 },
  };
  applyTriggerSellToInputs(80, 20);
  triggerCreateWindowArea = { start: 0, end: 1 };
  setTriggerCreateActiveTab("buy");
  syncTriggerCreateColorIconContrast();
  syncTriggerCreateSideUi();
  syncTriggerCreateSubmitState();
  for (const edge of ["start", "end"]) syncTriggerGapSizeControl(edge);
  renderAllTriggerPriceRanges();
  syncTriggerWindowAreaUi();
  syncTriggerStatsPanel();
}

function fillTriggerCreateFormFromTrigger(trigger) {
  const nameEl = $("trigger-create-name");
  const colorEl = $("trigger-create-color");
  if (nameEl) nameEl.value = String(trigger?.name || "");
  if (colorEl) colorEl.value = typeof trigger?.color === "string" ? trigger.color : "#58a6ff";
  triggerCreateName = String(trigger?.name || "").trim();
  triggerCreateColor = typeof trigger?.color === "string" ? trigger.color : "#58a6ff";
  triggerCreatePriceSide = trigger?.priceSide === "sell" ? "sell" : "buy";
  triggerCreateEndMode = normalizeTriggerEndMode(trigger?.endMode);
  triggerCreateEndChangeSideCents = clampTriggerSignedCents(trigger?.endChangeSideCents ?? 20);
  triggerCreatePriceRanges = {
    start: normalizeTriggerPriceRange(trigger?.priceRanges?.start),
    end: normalizeTriggerPriceRange(trigger?.priceRanges?.end),
  };
  triggerCreatePtbGap = {
    start:
      trigger?.ptbGap?.start === "positive" || trigger?.ptbGap?.start === "negative"
        ? trigger.ptbGap.start
        : null,
    end:
      trigger?.ptbGap?.end === "positive" || trigger?.ptbGap?.end === "negative"
        ? trigger.ptbGap.end
        : null,
  };
  triggerCreateGapSize = {
    start: normalizeTriggerGapSize(trigger?.gapSize?.start),
    end: normalizeTriggerGapSize(trigger?.gapSize?.end),
  };
  applyTriggerDurationToInputs(trigger?.durationMs ?? 5000);
  applyTriggerSellToInputs(trigger?.takeProfitCents, trigger?.stopLossCents);
  triggerCreateWindowArea = normalizeTriggerWindowArea(
    trigger?.windowArea?.start,
    trigger?.windowArea?.end,
  );
  setTriggerCreateActiveTab("buy");
  syncTriggerCreateColorIconContrast();
  syncTriggerCreateSideUi();
  syncTriggerCreateSubmitState();
  for (const edge of ["start", "end"]) syncTriggerGapSizeControl(edge);
  renderAllTriggerPriceRanges();
  syncTriggerWindowAreaUi();
  syncTriggerStatsPanel();
  if (trigger?.id) void fetchTriggerLiveStats(trigger.id).then(() => syncTriggerStatsPanel());
}

function buildTriggerFromCreateDraft() {
  syncTriggerCreateNameDraft();
  syncTriggerCreateColorDraft();
  syncTriggerDurationDraft();
  syncTriggerCreateSellDraft();
  const name = triggerCreateName;
  if (!name) return null;
  const endMode = normalizeTriggerEndMode(triggerCreateEndMode);
  const existing =
    triggerCreateEditingId != null
      ? userTriggers.find((t) => String(t?.id) === String(triggerCreateEditingId))
      : null;
  const id =
    existing?.id != null
      ? existing.id
      : typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `trg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  return normalizeTriggerRecord({
    id,
    name,
    color: triggerCreateColor || "#58a6ff",
    durationMs: triggerCreateDurationMs,
    priceSide: triggerCreatePriceSide === "sell" ? "sell" : "buy",
    endMode,
    endChangeSideCents: clampTriggerSignedCents(triggerCreateEndChangeSideCents),
    priceRanges: {
      start: normalizeTriggerPriceRange(triggerCreatePriceRanges.start),
      end: normalizeTriggerPriceRange(triggerCreatePriceRanges.end),
    },
    ptbGap: {
      start: triggerCreatePtbGap.start === "positive" || triggerCreatePtbGap.start === "negative"
        ? triggerCreatePtbGap.start
        : null,
      end: triggerCreatePtbGap.end === "positive" || triggerCreatePtbGap.end === "negative"
        ? triggerCreatePtbGap.end
        : null,
    },
    gapSize: {
      start: normalizeTriggerGapSize(triggerCreateGapSize.start),
      end: normalizeTriggerGapSize(triggerCreateGapSize.end),
    },
    takeProfitCents: clampTriggerCents(triggerCreateTakeProfitCents),
    stopLossCents: clampTriggerCents(triggerCreateStopLossCents),
    windowArea: normalizeTriggerWindowArea(
      triggerCreateWindowArea.start,
      triggerCreateWindowArea.end,
    ),
    runMode: existing?.runMode === "trade" ? "trade" : "demo",
    paused: existing ? existing.paused !== false : true,
    demoStats: normalizeTriggerDemoStats(existing?.demoStats),
    createdAt:
      typeof existing?.createdAt === "string" ? existing.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function submitTriggerCreate() {
  const trigger = buildTriggerFromCreateDraft();
  if (!trigger) {
    syncTriggerCreateSubmitState();
    $("trigger-create-name")?.focus();
    return;
  }
  if (triggerCreateEditingId) {
    const idx = userTriggers.findIndex(
      (t) => String(t?.id) === String(triggerCreateEditingId),
    );
    if (idx >= 0) userTriggers[idx] = trigger;
    else userTriggers = [trigger, ...userTriggers];
  } else {
    userTriggers = [trigger, ...userTriggers];
  }
  saveUserTriggers();
  renderTriggersList();
  closeTriggerCreateModal();
}

function openTriggerCreateModal() {
  const modal = $("trigger-create-modal");
  if (!modal) return;
  triggerCreateEditingId = null;
  resetTriggerCreateForm();
  syncTriggerCreateModalChrome();
  modal.hidden = false;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      renderAllTriggerPriceRanges();
      syncTriggerWindowAreaUi();
      $("trigger-create-name")?.focus();
    });
  });
}

function openTriggerEditModal(trigger) {
  const modal = $("trigger-create-modal");
  if (!modal || !trigger?.id) return;
  closeTriggerMenus();
  triggerCreateEditingId = String(trigger.id);
  fillTriggerCreateFormFromTrigger(trigger);
  syncTriggerCreateModalChrome();
  modal.hidden = false;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      renderAllTriggerPriceRanges();
      syncTriggerWindowAreaUi();
      $("trigger-create-name")?.focus();
    });
  });
}

function closeTriggerCreateModal() {
  const modal = $("trigger-create-modal");
  if (!modal) return;
  modal.hidden = true;
  triggerCreateEditingId = null;
  syncTriggerCreateModalChrome();
}

function bindTriggerCreateModal() {
  loadUserTriggers();
  renderTriggersList();
  $("triggers-create-btn")?.addEventListener("click", () => {
    openTriggerCreateModal();
  });
  $("trigger-create-modal-close")?.addEventListener("click", () => {
    closeTriggerCreateModal();
  });
  $("trigger-create-cancel")?.addEventListener("click", () => {
    closeTriggerCreateModal();
  });
  $("trigger-create-submit")?.addEventListener("click", () => {
    submitTriggerCreate();
  });
  $("trigger-create-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "trigger-create-modal") closeTriggerCreateModal();
  });
  const tablist = $("trigger-create-modal")?.querySelector(".trigger-create-tabs");
  tablist?.addEventListener("click", (e) => {
    const tab = e.target.closest?.("[data-trigger-tab]");
    if (!tab || !tablist.contains(tab)) return;
    setTriggerCreateActiveTab(tab.getAttribute("data-trigger-tab"));
  });
  tablist?.addEventListener("keydown", (e) => {
    const current = e.target.closest?.("[data-trigger-tab]");
    if (!current || !tablist.contains(current)) return;
    const tabs = [...tablist.querySelectorAll("[data-trigger-tab]")];
    const idx = tabs.indexOf(current);
    if (idx < 0) return;
    let nextIdx = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") nextIdx = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      nextIdx = (idx - 1 + tabs.length) % tabs.length;
    } else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = tabs.length - 1;
    if (nextIdx < 0) return;
    e.preventDefault();
    const next = tabs[nextIdx];
    setTriggerCreateActiveTab(next.getAttribute("data-trigger-tab"));
    next.focus();
  });
  $("trigger-create-name")?.addEventListener("input", () => {
    syncTriggerCreateNameDraft();
  });
  $("trigger-create-color")?.addEventListener("input", () => {
    syncTriggerCreateColorDraft();
  });
  $("trigger-take-profit")?.addEventListener("input", () => {
    syncTriggerCreateSellDraft();
  });
  $("trigger-take-profit")?.addEventListener("change", () => {
    syncTriggerCreateSellDraft();
  });
  $("trigger-stop-loss")?.addEventListener("input", () => {
    syncTriggerCreateSellDraft();
  });
  $("trigger-stop-loss")?.addEventListener("change", () => {
    syncTriggerCreateSellDraft();
  });
  $("trigger-price-side-start")?.addEventListener("change", (e) => {
    syncTriggerCreateSideDraft(e.currentTarget);
  });
  $("trigger-end-mode")?.addEventListener("change", () => {
    syncTriggerCreateEndModeDraft();
  });
  document.querySelectorAll(".trigger-gap-size-control").forEach((control) => {
    const edge = control.dataset.edge;
    if (edge !== "start" && edge !== "end") return;
    control.querySelector("[data-gap-bound]")?.addEventListener("change", (e) => {
      const bound = e.currentTarget.value === "max" ? "max" : "min";
      triggerCreateGapSize[edge] = normalizeTriggerGapSize({
        ...triggerCreateGapSize[edge],
        bound,
      });
      syncTriggerGapSizeControl(edge);
    });
    control.querySelector("[data-gap-value]")?.addEventListener("input", (e) => {
      const value = Number(e.currentTarget.value);
      triggerCreateGapSize[edge] = normalizeTriggerGapSize({
        ...triggerCreateGapSize[edge],
        value: Number.isFinite(value) ? value : 0,
      });
      control.classList.toggle("is-any-size", triggerCreateGapSize[edge].value <= 0);
    });
    control.querySelector("[data-gap-value]")?.addEventListener("change", (e) => {
      const value = Number(e.currentTarget.value);
      triggerCreateGapSize[edge] = normalizeTriggerGapSize({
        ...triggerCreateGapSize[edge],
        value: Number.isFinite(value) ? value : 0,
      });
      syncTriggerGapSizeControl(edge);
    });
  });
  document.querySelectorAll(".trigger-ptb-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const edge = btn.getAttribute("data-edge");
      const ptb = btn.getAttribute("data-ptb");
      if ((edge === "start" || edge === "end") && (ptb === "positive" || ptb === "negative")) {
        toggleTriggerPtbGap(edge, ptb);
      }
    });
  });
  $("trigger-duration-value")?.addEventListener("input", () => {
    syncTriggerDurationDraft();
  });
  $("trigger-duration-value")?.addEventListener("change", () => {
    syncTriggerDurationDraft();
  });
  $("trigger-duration-unit")?.addEventListener("change", () => {
    syncTriggerDurationDraft();
  });
  bindTriggerPriceRangeDrag();
  bindTriggerWindowAreaSlider();
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const modal = $("trigger-create-modal");
    if (!modal || modal.hidden) return;
    closeTriggerCreateModal();
  });
}

function bindTriggersFeature() {
  bindTriggerCreateModal();
}

function clearTriggerRuntime(triggerId) {
  const id = String(triggerId || "");
  if (!id) {
    triggerRuntimeById.clear();
    return;
  }
  triggerRuntimeById.delete(id);
}

function getOrCreateTriggerRuntime(triggerId) {
  const id = String(triggerId || "");
  let rt = triggerRuntimeById.get(id);
  if (!rt) {
    rt = {
      phase: "idle",
      side: null,
      watchStartedAtMs: null,
      startPriceCents: null,
      entryPrice: null,
      entryShares: TRIGGER_DEMO_SHARES,
      takeProfitCents: 80,
      stopLossCents: 20,
      runMode: "demo",
      orderInFlight: false,
      windowStart: null,
    };
    triggerRuntimeById.set(id, rt);
  }
  return rt;
}

function isTriggerTradeArmed() {
  return Boolean($("start-trading")?.checked);
}

function triggerQuoteCents(state, marketSide, priceSide) {
  const useBid = priceSide === "sell";
  if (marketSide === "up") {
    const v = useBid ? Number(state.yesBid) : Number(state.yesAsk);
    return Number.isFinite(v) ? v * 100 : NaN;
  }
  const v = useBid ? Number(state.noBid) : Number(state.noAsk);
  return Number.isFinite(v) ? v * 100 : NaN;
}

function triggerBidCents(state, marketSide) {
  const v = marketSide === "up" ? Number(state.yesBid) : Number(state.noBid);
  return Number.isFinite(v) ? v * 100 : NaN;
}

function triggerAskPrice(state, marketSide) {
  const v = marketSide === "up" ? Number(state.yesAsk) : Number(state.noAsk);
  return Number.isFinite(v) ? v : NaN;
}

function triggerGapMatches(state, kind, gapSizeRaw) {
  if (kind !== "positive" && kind !== "negative") return true;
  const gap = Number(state.assetGap);
  if (!Number.isFinite(gap)) return false;
  if (kind === "positive" && !(gap > 0)) return false;
  if (kind === "negative" && !(gap < 0)) return false;
  const size = normalizeTriggerGapSize(gapSizeRaw);
  if (!(size.value > 0)) return true;
  const abs = Math.abs(gap);
  return size.bound === "max" ? abs <= size.value : abs >= size.value;
}

function triggerPriceInRange(cents, range) {
  const band = normalizeTriggerPriceRange(range);
  return Number.isFinite(cents) && cents >= band.lowCents && cents <= band.highCents;
}

function triggerEndConditionMet(trigger, startPriceCents, endPriceCents) {
  const mode = trigger.endMode === "change-side" ? "change-side" : "range";
  if (mode === "change-side") {
    if (!Number.isFinite(startPriceCents) || !Number.isFinite(endPriceCents)) return false;
    const need = clampTriggerSignedCents(trigger.endChangeSideCents);
    const delta = Math.round(endPriceCents) - Math.round(startPriceCents);
    if (need === 0) return delta === 0;
    if (need > 0) return delta >= need;
    return delta <= need;
  }
  return triggerPriceInRange(endPriceCents, trigger.priceRanges?.end);
}

async function placeTriggerTradeOrder(side, leg) {
  if (!isTriggerTradeArmed()) return { ok: false, skipped: true };
  if (side !== "up" && side !== "down") return { ok: false, error: "bad side" };
  if (leg !== "buy" && leg !== "sell") return { ok: false, error: "bad leg" };
  const result = await postTradingOrder(side, leg, { source: "trigger" });
  if (!result.ok) {
    appendLogEntry({
      level: "warn",
      source: "client",
      message: `Trigger Trade ${leg.toUpperCase()} ${side.toUpperCase()} failed: ${
        result.body?.error || result.status || "order failed"
      }`,
    });
  } else {
    appendLogEntry({
      level: "info",
      source: "client",
      message: `Trigger Trade ${leg.toUpperCase()} ${side.toUpperCase()} placed`,
    });
  }
  return result;
}

async function postTriggerLiveStatsEvent(triggerId, result, pnlUsd, exitReason) {
  const id = String(triggerId || "");
  if (!id) return;
  try {
    const res = await fetch(`/api/triggers/${encodeURIComponent(id)}/stats/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result, pnlUsd, exitReason }),
    });
    if (!res.ok) return;
    const body = await res.json().catch(() => null);
    if (body && typeof body === "object") {
      triggerLiveStatsCache[id] = normalizeTriggerDemoStats(body);
      updateTriggerCardStats(id);
      if (triggerCreateEditingId && String(triggerCreateEditingId) === id) {
        syncTriggerStatsPanel();
      }
    }
  } catch {
    /* ignore */
  }
}

function recordTriggerDemoStats(triggerId, result, pnlUsd, exitReason) {
  const trigger = findUserTrigger(triggerId);
  if (!trigger || trigger.paused !== false || trigger.runMode === "trade") return;
  const demo = normalizeTriggerDemoStats(trigger.demoStats);
  if (result === "success") demo.success += 1;
  else demo.fail += 1;
  if (exitReason === "tp") demo.takeProfit += 1;
  else if (exitReason === "sl") demo.stopLoss += 1;
  demo.pnlUsd += Number.isFinite(pnlUsd) ? pnlUsd : 0;
  patchUserTrigger(triggerId, { demoStats: demo });
  updateTriggerCardStats(triggerId);
}

function settleTriggerOpenPosition(trigger, rt, exitPrice, reason) {
  const entry = Number(rt.entryPrice);
  const shares = Number(rt.entryShares) || TRIGGER_DEMO_SHARES;
  const exit = Number(exitPrice);
  const pnlUsd =
    Number.isFinite(entry) && Number.isFinite(exit) ? (exit - entry) * shares : 0;
  const tp = clampTriggerCents(rt.takeProfitCents);
  const sl = clampTriggerCents(rt.stopLossCents);
  const exitCents = Number.isFinite(exit) ? exit * 100 : NaN;
  let result = "fail";
  if (reason === "tp" || (Number.isFinite(exitCents) && exitCents >= tp && tp >= sl)) {
    result = "success";
  } else if (reason === "sl") {
    result = "fail";
  } else if (Number.isFinite(exitCents) && exitCents >= tp) {
    result = "success";
  } else if (Number.isFinite(exitCents) && exitCents <= sl) {
    result = "fail";
  } else {
    result = pnlUsd >= 0 ? "success" : "fail";
  }
  if (reason === "tp") result = "success";
  if (reason === "sl" || reason === "window-end") {
    if (reason === "sl") result = "fail";
    if (reason === "window-end" && !(Number.isFinite(exitCents) && exitCents >= tp)) {
      result = "fail";
    }
  }

  const label = String(trigger.name || "Untitled trigger");
  appendLogEntry({
    level: "info",
    source: "client",
    message: `Trigger "${label}" ${rt.runMode} ${result} (${reason}) P/L ${formatTriggerStatsPnl(pnlUsd)}`,
  });

  if (rt.runMode === "trade") {
    void postTriggerLiveStatsEvent(trigger.id, result, pnlUsd, reason);
  } else {
    recordTriggerDemoStats(trigger.id, result, pnlUsd, reason);
  }

  rt.phase = "idle";
  rt.side = null;
  rt.watchStartedAtMs = null;
  rt.startPriceCents = null;
  rt.entryPrice = null;
  rt.orderInFlight = false;
}

async function openTriggerPosition(trigger, rt, state, side) {
  if (rt.orderInFlight || rt.phase === "open") return;
  const runMode = trigger.runMode === "trade" ? "trade" : "demo";
  rt.runMode = runMode;
  rt.takeProfitCents = clampTriggerCents(trigger.takeProfitCents ?? 80);
  rt.stopLossCents = clampTriggerCents(trigger.stopLossCents ?? 20);

  if (runMode === "trade") {
    if (!isTriggerTradeArmed()) {
      appendLogEntry({
        level: "warn",
        source: "client",
        message: `Trigger "${trigger.name || "Untitled"}" Trade idle — Allow trade is off`,
      });
      rt.phase = "idle";
      rt.side = null;
      rt.watchStartedAtMs = null;
      return;
    }
    rt.orderInFlight = true;
    const result = await placeTriggerTradeOrder(side, "buy");
    rt.orderInFlight = false;
    if (!result.ok) {
      rt.phase = "idle";
      rt.side = null;
      rt.watchStartedAtMs = null;
      return;
    }
    const fillPrice = Number(result.body?.fillPrice);
    const fillShares = Number(result.body?.fillShares);
    rt.entryPrice = Number.isFinite(fillPrice) ? fillPrice : triggerAskPrice(state, side);
    rt.entryShares = Number.isFinite(fillShares) && fillShares > 0 ? fillShares : TRIGGER_DEMO_SHARES;
  } else {
    const ask = triggerAskPrice(state, side);
    if (!Number.isFinite(ask)) {
      rt.phase = "idle";
      return;
    }
    rt.entryPrice = ask;
    rt.entryShares = TRIGGER_DEMO_SHARES;
    appendLogEntry({
      level: "info",
      source: "client",
      message: `Trigger "${trigger.name || "Untitled"}" Demo buy ${side.toUpperCase()} @ ${(ask * 100).toFixed(1)}¢`,
    });
  }

  rt.phase = "open";
  rt.side = side;
  rt.watchStartedAtMs = null;
  rt.startPriceCents = null;
}

async function maybeExitTriggerPosition(trigger, rt, state) {
  if (rt.phase !== "open" || !rt.side || rt.orderInFlight) return;
  const bidCents = triggerBidCents(state, rt.side);
  if (!Number.isFinite(bidCents)) return;
  const tp = clampTriggerCents(rt.takeProfitCents);
  const sl = clampTriggerCents(rt.stopLossCents);
  const hitTp = bidCents >= tp;
  const hitSl = bidCents <= sl;
  if (!hitTp && !hitSl) return;

  const reason = hitTp ? "tp" : "sl";
  const exitPrice = bidCents / 100;

  if (rt.runMode === "trade") {
    if (!isTriggerTradeArmed()) return;
    rt.orderInFlight = true;
    const result = await placeTriggerTradeOrder(rt.side, "sell");
    rt.orderInFlight = false;
    if (!result.ok && !result.skipped) return;
    const fillPrice = Number(result.body?.fillPrice);
    settleTriggerOpenPosition(
      trigger,
      rt,
      Number.isFinite(fillPrice) ? fillPrice : exitPrice,
      reason,
    );
    return;
  }

  settleTriggerOpenPosition(trigger, rt, exitPrice, reason);
}

function tickUserTriggers(state) {
  if (!state || !isPredictionTriggerHost()) return;
  if (!Array.isArray(userTriggers) || userTriggers.length === 0) return;

  const nowMs = Date.now();
  const windowEnded =
    state.windowEnd != null &&
    Number.isFinite(state.windowEnd) &&
    nowMs >= state.windowEnd * 1000;

  for (const trigger of userTriggers) {
    const id = String(trigger?.id || "");
    if (!id) continue;
    const rt = getOrCreateTriggerRuntime(id);

    if (rt.windowStart != null && state.windowStart !== rt.windowStart) {
      if (rt.phase === "open") {
        const bid = triggerBidCents(state, rt.side) / 100;
        settleTriggerOpenPosition(
          trigger,
          rt,
          Number.isFinite(bid) ? bid : rt.entryPrice,
          "window-end",
        );
      }
      rt.phase = "idle";
      rt.side = null;
      rt.watchStartedAtMs = null;
      rt.startPriceCents = null;
    }
    rt.windowStart = state.windowStart ?? null;

    if (trigger.paused !== false) {
      if (rt.phase !== "idle") {
        rt.phase = "idle";
        rt.side = null;
        rt.watchStartedAtMs = null;
        rt.startPriceCents = null;
      }
      continue;
    }

    if (rt.phase === "open") {
      if (windowEnded) {
        const bid = triggerBidCents(state, rt.side) / 100;
        if (rt.runMode === "trade" && isTriggerTradeArmed() && !rt.orderInFlight) {
          rt.orderInFlight = true;
          void placeTriggerTradeOrder(rt.side, "sell").then((result) => {
            rt.orderInFlight = false;
            const fillPrice = Number(result.body?.fillPrice);
            settleTriggerOpenPosition(
              trigger,
              rt,
              Number.isFinite(fillPrice) ? fillPrice : Number.isFinite(bid) ? bid : rt.entryPrice,
              "window-end",
            );
          });
        } else {
          settleTriggerOpenPosition(
            trigger,
            rt,
            Number.isFinite(bid) ? bid : rt.entryPrice,
            "window-end",
          );
        }
        continue;
      }
      void maybeExitTriggerPosition(trigger, rt, state);
      continue;
    }

    if (windowEnded) {
      rt.phase = "idle";
      rt.watchStartedAtMs = null;
      continue;
    }

    const area = normalizeTriggerWindowArea(
      trigger.windowArea?.start,
      trigger.windowArea?.end,
    );
    if (!isInManipulationArea(state, area.start, area.end)) {
      if (rt.phase === "watching") {
        rt.phase = "idle";
        rt.side = null;
        rt.watchStartedAtMs = null;
        rt.startPriceCents = null;
      }
      continue;
    }

    if (trigger.runMode === "trade" && !isTriggerTradeArmed()) {
      continue;
    }

    const priceSide = trigger.priceSide === "sell" ? "sell" : "buy";
    const durationMs = Math.max(1, Number(trigger.durationMs) || 5000);
    const startGapOk = triggerGapMatches(state, trigger.ptbGap?.start, trigger.gapSize?.start);
    const endGapOk = triggerGapMatches(state, trigger.ptbGap?.end, trigger.gapSize?.end);

    if (rt.phase === "watching" && rt.side && Number.isFinite(rt.watchStartedAtMs)) {
      if (nowMs - rt.watchStartedAtMs < durationMs) continue;
      const endCents = triggerQuoteCents(state, rt.side, priceSide);
      if (
        endGapOk &&
        triggerEndConditionMet(trigger, rt.startPriceCents, endCents)
      ) {
        void openTriggerPosition(trigger, rt, state, rt.side);
      } else {
        rt.phase = "idle";
        rt.side = null;
        rt.watchStartedAtMs = null;
        rt.startPriceCents = null;
      }
      continue;
    }

    if (!startGapOk) continue;

    for (const side of ["up", "down"]) {
      const startCents = triggerQuoteCents(state, side, priceSide);
      if (!triggerPriceInRange(startCents, trigger.priceRanges?.start)) continue;
      rt.phase = "watching";
      rt.side = side;
      rt.watchStartedAtMs = nowMs;
      rt.startPriceCents = startCents;
      break;
    }
  }
}


function installTriggerTickHook() {
  global.tickUserTriggers = tickUserTriggers;
  const existing = global.tickManipulationDetector;
  if (typeof existing === "function") {
    global.tickManipulationDetector = function wrappedTickManipulationDetector(state) {
      try {
        tickUserTriggers(state);
      } catch (err) {
        console.warn("tickUserTriggers failed", err);
      }
      return existing(state);
    };
    return;
  }
  // app.js calls a local tickManipulationDetector (not on window) — poll windowState.
  if (!global.__triggersPollInstalled) {
    global.__triggersPollInstalled = true;
    setInterval(() => {
      if (!isPredictionTriggerHost()) return;
      const state = global.windowState;
      if (!state) return;
      try {
        tickUserTriggers(state);
      } catch {
        /* ignore */
      }
    }, 250);
  }
}

global.bindTriggersFeature = bindTriggersFeature;
installTriggerTickHook();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => bindTriggersFeature());
} else {
  bindTriggersFeature();
}

})(typeof window !== "undefined" ? window : globalThis);
