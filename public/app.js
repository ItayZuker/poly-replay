const $ = (id) => document.getElementById(id);

let markets = [];
let selectedSeries = "btc-5m";
let windowState = null;
let countdownTimer = null;
let chartCanvas = null;
let chartCtx = null;
let chartWindowStart = null;
let chainlinkChartFrame = null;
let pendingChainlinkTicks = [];

const MAX_POSITION_CARDS = 50;
const LOG_CLEARED_SESSION_KEY = "poly-real:log-cleared";
const SCHEDULE_WORKSPACE_STORAGE_KEY = "poly-real:schedule-workspace-mode";

/** @type {"live" | "replay"} */
let scheduleWorkspaceMode = "live";

function normalizeScheduleWorkspaceMode(raw) {
  return String(raw ?? "").trim().toLowerCase() === "replay" ? "replay" : "live";
}

function getScheduleWorkspaceMode() {
  return scheduleWorkspaceMode;
}

function isReplayWorkspace() {
  return scheduleWorkspaceMode === "replay";
}

function withScheduleWorkspaceMode(url) {
  const mode = getScheduleWorkspaceMode();
  const sep = String(url).includes("?") ? "&" : "?";
  return `${url}${sep}mode=${encodeURIComponent(mode)}`;
}

function syncScheduleWorkspaceUi() {
  const page = $("page-schedule-heatmap");
  const replayOpen = isReplayWorkspace();
  page?.classList.toggle("is-replay-workspace", replayOpen);
  const switcher = $("schedule-workspace-switcher");
  switcher?.classList.toggle("is-replay", replayOpen);
  if (switcher) {
    switcher.setAttribute("aria-checked", replayOpen ? "true" : "false");
  }
  document.querySelectorAll("[data-schedule-workspace]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.scheduleWorkspace === scheduleWorkspaceMode);
  });
  const replayPanel = $("schedule-replay-panel");
  if (replayPanel) {
    replayPanel.setAttribute("aria-hidden", replayOpen ? "false" : "true");
  }
  const liveTriggers = $("schedule-live-triggers");
  if (liveTriggers) {
    liveTriggers.setAttribute("aria-hidden", replayOpen ? "true" : "false");
  }
  const replayBtn = $("schedule-replay-run-btn");
  if (replayBtn) {
    replayBtn.tabIndex = replayOpen ? 0 : -1;
  }
  const latencyInput = $("schedule-replay-latency-input");
  const fillInput = $("schedule-replay-fill-success-input");
  if (latencyInput) latencyInput.tabIndex = replayOpen ? 0 : -1;
  if (fillInput) fillInput.tabIndex = replayOpen ? 0 : -1;
  if (replayOpen) {
    window.SchedulePlacements?.syncReplayInputsFromLive?.();
  } else {
    window.ScheduleLiveTriggers?.render?.();
  }
}

async function setScheduleWorkspaceMode(nextMode, options = {}) {
  const mode = normalizeScheduleWorkspaceMode(nextMode);
  if (mode === scheduleWorkspaceMode && !options.force) {
    syncScheduleWorkspaceUi();
    return;
  }
  scheduleWorkspaceMode = mode;
  try {
    localStorage.setItem(SCHEDULE_WORKSPACE_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
  syncScheduleWorkspaceUi();
  // Swap hour-cell boards immediately (separate Live/Replay buffers) before any await.
  window.SchedulePlacements?.prepareWorkspaceHourSlots?.(mode);
  if (options.reload === false) return;

  // Clear both panes immediately so Live cards never linger while Replay loads.
  scheduleSetupsCache = [];
  renderScheduleSetupsList([]);
  if (window.SchedulePlacements?.clearWorkspaceBoard) {
    window.SchedulePlacements.clearWorkspaceBoard();
  }

  await loadScheduleSetups({ expectedMode: mode });
  if (window.SchedulePlacements?.onWorkspaceModeChanged) {
    await window.SchedulePlacements.onWorkspaceModeChanged(mode);
  } else if (window.SchedulePlacements?.loadPlacements) {
    await window.SchedulePlacements.loadPlacements({
      reloadStats: mode !== "replay",
      expectedMode: mode,
    });
  }
}

function initScheduleWorkspaceMode() {
  try {
    scheduleWorkspaceMode = normalizeScheduleWorkspaceMode(
      localStorage.getItem(SCHEDULE_WORKSPACE_STORAGE_KEY),
    );
  } catch {
    scheduleWorkspaceMode = "live";
  }
  syncScheduleWorkspaceUi();
  document.querySelectorAll("[data-schedule-workspace]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void setScheduleWorkspaceMode(btn.dataset.scheduleWorkspace);
    });
  });
  $("schedule-replay-run-btn")?.addEventListener("click", () => {
    window.SchedulePlacements?.toggleReplay?.();
  });
}

window.getScheduleWorkspaceMode = getScheduleWorkspaceMode;
window.isReplayWorkspace = isReplayWorkspace;
window.withScheduleWorkspaceMode = withScheduleWorkspaceMode;
window.setScheduleWorkspaceMode = setScheduleWorkspaceMode;

let scheduleSetupsCache = [];

let logCurrentWindowStart = null;
let logPreviousWindowStart = null;

function shortAddress(addr) {
  if (!addr || addr.length < 10) return addr || "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatUsdcBalance(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return "—";
  return `$${(value / 1_000_000).toFixed(2)}`;
}

function setSettingsWalletError(message) {
  const el = $("settings-wallet-error");
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function setSettingsUserStatus(message, isError = false) {
  const el = $("settings-user-status");
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("settings-inline-status--error");
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle("settings-inline-status--error", Boolean(isError));
}

function setSettingsSessionStatus(message, isError = false) {
  const el = $("settings-session-status");
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("settings-inline-status--error");
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle("settings-inline-status--error", Boolean(isError));
}

function setAuthError(message) {
  const el = $("auth-error");
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function setSignupError(message) {
  const el = $("auth-signup-error");
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

let authTopTab = "main";
let authDocsManifest = null;
let authDocsLoaded = Object.create(null);
let authDocsActiveId = null;
let authDocsSearchQuery = "";
let authDocsSearchTimer = null;
let authDocsSearchBound = false;
let authVersionsLoaded = false;
let authUrlSyncBound = false;

function isLoggedIn() {
  return Boolean(currentUserId);
}

const SIGNED_IN_HINT_KEY = "poly-real:signed-in";

function setSignedInHint(on) {
  try {
    if (on) localStorage.setItem(SIGNED_IN_HINT_KEY, "1");
    else localStorage.removeItem(SIGNED_IN_HINT_KEY);
  } catch {
    // ignore
  }
}

function hasSignedInHint() {
  try {
    return localStorage.getItem(SIGNED_IN_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

/** True when session is known or a prior signed-in visit was recorded (avoids Main/App flash). */
function likelySignedIn() {
  return isLoggedIn() || hasSignedInHint();
}

function pathToAuthTab(pathname) {
  const p = String(pathname || "/").replace(/\/+$/, "") || "/";
  if (p === "/docs") return "docs";
  if (p === "/version") return "versions";
  return "main";
}

function authTabToPath(tab) {
  if (tab === "docs") return "/docs";
  if (tab === "versions") return "/version";
  return "/";
}

function syncAuthUrl(tab, { replace = false } = {}) {
  const nextPath = authTabToPath(tab);
  if (location.pathname === nextPath) return;
  const state = { authTab: tab };
  if (replace) history.replaceState(state, "", nextPath);
  else history.pushState(state, "", nextPath);
}

function bindAuthUrlRouting() {
  if (authUrlSyncBound) return;
  authUrlSyncBound = true;
  window.addEventListener("popstate", () => {
    applyAuthRoute(pathToAuthTab(location.pathname), { syncUrl: false });
  });
}

function showAuthOverlay() {
  const auth = $("auth-screen");
  const app = $("app-shell");
  if (auth) auth.hidden = false;
  if (app) app.hidden = true;
  document.body.style.overflow = "hidden";
}

function renderAuthTopPanels(tab) {
  const panels = {
    main: $("auth-tab-main"),
    docs: $("auth-tab-docs"),
    versions: $("auth-tab-versions"),
  };
  for (const [key, el] of Object.entries(panels)) {
    if (el) el.hidden = key !== tab;
  }
  document.querySelectorAll(".auth-tab[data-auth-tab]").forEach((btn) => {
    const active = btn.getAttribute("data-auth-tab") === tab;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function showAuthViewPanels(view) {
  const home = $("auth-home");
  const login = $("auth-login-panel");
  const signup = $("auth-signup-panel");
  if (home) home.hidden = view !== "home";
  if (login) login.hidden = view !== "login";
  if (signup) signup.hidden = view !== "signup";
  setAuthError("");
  setSignupError("");
  if (view === "login") $("auth-email")?.focus();
  else if (view === "signup") $("auth-signup-email")?.focus();
}

function syncAuthMainTabButton() {
  const mainBtn = $("auth-tab-btn-main");
  if (!mainBtn) return;
  const loggedIn = likelySignedIn();
  const showApp = loggedIn && (authTopTab === "docs" || authTopTab === "versions");
  mainBtn.classList.toggle("is-back-mode", showApp);
  const mainLabel = mainBtn.querySelector(".auth-tab-label--main");
  const appLabel = mainBtn.querySelector(".auth-tab-label--app");
  if (mainLabel && appLabel) {
    mainLabel.hidden = showApp;
    appLabel.hidden = !showApp;
  } else {
    mainBtn.innerHTML = showApp
      ? '<span class="auth-tab-label auth-tab-label--app">App</span>'
      : '<span class="auth-tab-label auth-tab-label--main">Main</span>';
  }
  mainBtn.setAttribute("aria-label", showApp ? "Open Market" : "Main");
  const settingsBtn = $("auth-settings-btn");
  if (settingsBtn) settingsBtn.hidden = !loggedIn;
}

function openSettingsFromAuthChrome() {
  showAppShell();
  authTopTab = "main";
  syncAuthMainTabButton();
  syncAuthUrl("main", { replace: false });
  if (typeof showAppPage === "function") showAppPage("settings");
}

function applyAuthRoute(tab, { syncUrl = true, replace = false } = {}) {
  const next = tab === "docs" || tab === "versions" ? tab : "main";
  if (next === "main") {
    if (isLoggedIn()) {
      showAppShell();
      authTopTab = "main";
      syncAuthMainTabButton();
      if (typeof showAppPage === "function") showAppPage("simulator");
      if (syncUrl) syncAuthUrl("main", { replace });
      return;
    }
    showAuthOverlay();
    authTopTab = "main";
    renderAuthTopPanels("main");
    showAuthViewPanels("home");
    syncAuthMainTabButton();
    if (syncUrl) syncAuthUrl("main", { replace });
    return;
  }
  showAuthOverlay();
  authTopTab = next;
  renderAuthTopPanels(next);
  syncAuthMainTabButton();
  if (syncUrl) syncAuthUrl(next, { replace });
  if (authTopTab === "docs") void ensureAuthDocsReady();
  if (authTopTab === "versions") void ensureAuthVersionsReady();
}

function setAuthTopTab(tab) {
  applyAuthRoute(tab, { syncUrl: true });
}

function openAuthPublicTab(tab) {
  applyAuthRoute(tab === "versions" ? "versions" : "docs", { syncUrl: true });
}

function showAuthView(view) {
  if (view === "home" || view === "login" || view === "signup") {
    applyAuthRoute("main", { syncUrl: true });
    if (isLoggedIn()) return;
  }
  showAuthViewPanels(view);
}

function bindAuthDocsSearch() {
  const input = $("auth-docs-search");
  if (!input || authDocsSearchBound) return;
  authDocsSearchBound = true;
  input.addEventListener("input", () => {
    clearTimeout(authDocsSearchTimer);
    authDocsSearchTimer = setTimeout(() => {
      void runAuthDocsSearch(input.value);
    }, 140);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      input.value = "";
      void runAuthDocsSearch("");
      input.blur();
    }
  });
}

async function preloadAuthDocsPages() {
  const pages = Array.isArray(authDocsManifest?.pages) ? authDocsManifest.pages : [];
  await Promise.all(
    pages.map(async (page) => {
      if (authDocsLoaded[page.id]) return;
      try {
        const res = await fetch(`/docs/${page.file}`, { cache: "no-cache" });
        if (!res.ok) return;
        authDocsLoaded[page.id] = await res.text();
      } catch {
        /* ignore single-page fetch errors for search */
      }
    }),
  );
}

function plainTextFromDocMd(md) {
  return String(md || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\(doc:[^)]+\)/gi, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/[|*_`>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightDocSnippet(text, query) {
  const safe = String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  if (!query) return safe;
  const re = new RegExp(`(${escapeRegExp(query)})`, "ig");
  return safe.replace(re, "<mark>$1</mark>");
}

function buildAuthDocSearchResults(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const pages = Array.isArray(authDocsManifest?.pages) ? authDocsManifest.pages : [];
  const results = [];

  for (const page of pages) {
    const title = page.title || page.id;
    const md = authDocsLoaded[page.id] || "";
    const plain = plainTextFromDocMd(md);
    const titleHit = title.toLowerCase().includes(q);
    const bodyHit = plain.toLowerCase().includes(q);
    if (!titleHit && !bodyHit) continue;

    let section = "";
    const headingRe = /^(#{2,3})\s+(.+)$/gm;
    let match;
    while ((match = headingRe.exec(md)) !== null) {
      if (match[2].toLowerCase().includes(q)) {
        section = match[2].trim();
        break;
      }
    }
    if (!section) {
      const lines = md.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^#{2,3}\s+/.test(line)) {
          section = line.replace(/^#{2,3}\s+/, "").trim();
        }
        const plainLine = plainTextFromDocMd(line);
        if (plainLine.toLowerCase().includes(q) && !/^#{1,3}\s+/.test(line)) {
          break;
        }
      }
    }

    let snippet = "";
    const idx = plain.toLowerCase().indexOf(q);
    if (idx >= 0) {
      const start = Math.max(0, idx - 48);
      const end = Math.min(plain.length, idx + q.length + 72);
      snippet = `${start > 0 ? "…" : ""}${plain.slice(start, end).trim()}${end < plain.length ? "…" : ""}`;
    } else if (titleHit) {
      snippet = plain.slice(0, 120).trim() + (plain.length > 120 ? "…" : "");
    }

    results.push({
      id: page.id,
      title,
      section: section && section.toLowerCase() !== title.toLowerCase() ? section : "",
      snippet: snippet || title,
      score: (titleHit ? 20 : 0) + (section ? 8 : 0) + (bodyHit ? 1 : 0),
    });
  }

  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return results;
}

function updateAuthDocsNavSearchState(hitIds) {
  const searching = hitIds != null;
  document.querySelectorAll(".auth-docs-nav-group").forEach((group) => {
    const id = group.dataset.docId;
    const hit = searching && hitIds.has(id);
    group.classList.toggle("is-search-hit", searching && hit);
    group.classList.toggle("is-search-miss", searching && !hit);
  });
  document.querySelectorAll(".auth-docs-nav-btn").forEach((btn) => {
    btn.classList.remove("is-search-hit", "is-search-miss");
    if (!searching) return;
    const id = btn.dataset.docId;
    if (hitIds.has(id)) btn.classList.add("is-search-hit");
    else btn.classList.add("is-search-miss");
  });
}

function slugifyAuthDocHeading(text) {
  // Do not name this slugifyDocHeading — that would overwrite window.slugifyDocHeading
  // from markdown.js and recurse forever.
  if (typeof window.slugifyDocHeading === "function") {
    return window.slugifyDocHeading(text);
  }
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

function extractDocSections(md) {
  const sections = [];
  const used = Object.create(null);
  const re = /^##\s+(.+)$/gm;
  let match;
  while ((match = re.exec(String(md || ""))) !== null) {
    const title = match[1].trim();
    let id = slugifyAuthDocHeading(title);
    if (used[id]) {
      used[id] += 1;
      id = `${id}-${used[id]}`;
    } else {
      used[id] = 1;
    }
    sections.push({ title, id });
  }
  return sections;
}

function clearAuthDocsSearchUi() {
  const input = $("auth-docs-search");
  if (input && input.value) input.value = "";
  authDocsSearchQuery = "";
  updateAuthDocsNavSearchState(null);
}

function setAuthDocsNavActive(pageId, sectionId) {
  document.querySelectorAll(".auth-docs-nav-group").forEach((group) => {
    const active = group.dataset.docId === pageId;
    group.classList.toggle("is-active", active);
  });
  document.querySelectorAll(".auth-docs-nav-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.docId === pageId);
  });
  document.querySelectorAll(".auth-docs-nav-sub-btn").forEach((btn) => {
    const matchPage = btn.dataset.docId === pageId;
    const matchSection = sectionId
      ? btn.dataset.sectionId === sectionId
      : false;
    btn.classList.toggle("is-active", matchPage && matchSection);
  });
}

function clearAuthDocsContentNavHover() {
  const content = $("auth-docs-content");
  if (!content) return;
  content.querySelectorAll(".is-nav-hover").forEach((el) => el.classList.remove("is-nav-hover"));
}

/** Highlight the matching content heading while hovering a docs nav label. */
function setAuthDocsContentNavHover(opts = {}) {
  const content = $("auth-docs-content");
  if (!content) return;
  clearAuthDocsContentNavHover();
  if (opts.sectionId) {
    content.querySelector(`#${CSS.escape(opts.sectionId)}`)?.classList.add("is-nav-hover");
    return;
  }
  if (opts.pageTitle) {
    content.querySelector("h1")?.classList.add("is-nav-hover");
  }
}

async function buildAuthDocsNav() {
  const nav = $("auth-docs-nav");
  if (!nav || !authDocsManifest) return;
  await preloadAuthDocsPages();
  nav.innerHTML = "";
  const pages = Array.isArray(authDocsManifest?.pages) ? authDocsManifest.pages : [];
  for (const page of pages) {
    const group = document.createElement("div");
    group.className = "auth-docs-nav-group";
    group.dataset.docId = page.id;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "auth-docs-nav-btn";
    btn.textContent = page.title || page.id;
    btn.dataset.docId = page.id;
    btn.addEventListener("click", () => {
      clearAuthDocsSearchUi();
      void loadAuthDocPage(page.id);
    });
    btn.addEventListener("mouseenter", () => {
      if (page.id === authDocsActiveId) setAuthDocsContentNavHover({ pageTitle: true });
    });
    btn.addEventListener("mouseleave", () => clearAuthDocsContentNavHover());
    group.appendChild(btn);

    const sections = extractDocSections(authDocsLoaded[page.id] || "");
    if (sections.length) {
      const sub = document.createElement("div");
      sub.className = "auth-docs-nav-sub";
      const inner = document.createElement("div");
      inner.className = "auth-docs-nav-sub-inner";
      for (const section of sections) {
        const subBtn = document.createElement("button");
        subBtn.type = "button";
        subBtn.className = "auth-docs-nav-sub-btn";
        subBtn.textContent = section.title;
        subBtn.dataset.docId = page.id;
        subBtn.dataset.sectionId = section.id;
        subBtn.addEventListener("click", () => {
          clearAuthDocsSearchUi();
          void loadAuthDocPage(page.id, { sectionId: section.id });
        });
        subBtn.addEventListener("mouseenter", () => {
          if (page.id === authDocsActiveId) {
            setAuthDocsContentNavHover({ sectionId: section.id });
          }
        });
        subBtn.addEventListener("mouseleave", () => clearAuthDocsContentNavHover());
        inner.appendChild(subBtn);
      }
      sub.appendChild(inner);
      group.appendChild(sub);
    }

    nav.appendChild(group);
  }
}

async function ensureAuthDocsReady() {
  const nav = $("auth-docs-nav");
  const content = $("auth-docs-content");
  if (!nav || !content) return;
  bindAuthDocsSearch();
  try {
    if (!authDocsManifest) {
      const res = await fetch("/docs/manifest.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      authDocsManifest = await res.json();
      await buildAuthDocsNav();
      const pages = Array.isArray(authDocsManifest?.pages) ? authDocsManifest.pages : [];
      if (pages.length) await loadAuthDocPage(pages[0].id);
      else content.innerHTML = "<p>No documentation pages yet.</p>";
    } else if (authDocsSearchQuery) {
      await runAuthDocsSearch(authDocsSearchQuery);
    } else if (!authDocsActiveId && Array.isArray(authDocsManifest?.pages) && authDocsManifest.pages[0]) {
      await loadAuthDocPage(authDocsManifest.pages[0].id);
    }
  } catch (err) {
    content.textContent = `Failed to load docs: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function loadAuthDocPage(pageId, options = {}) {
  const content = $("auth-docs-content");
  if (!content || !authDocsManifest) return;
  const page = (authDocsManifest.pages || []).find((p) => p.id === pageId);
  if (!page) return;
  authDocsActiveId = pageId;
  const sectionId = options.sectionId || "";
  setAuthDocsNavActive(pageId, sectionId);
  try {
    if (!authDocsLoaded[pageId]) {
      const res = await fetch(`/docs/${page.file}`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      authDocsLoaded[pageId] = await res.text();
    }
    const md = authDocsLoaded[pageId];
    content.innerHTML = typeof window.markdownToHtml === "function"
      ? window.markdownToHtml(md)
      : `<pre>${md}</pre>`;
    bindAuthDocContentLinks(content);
    if (sectionId) {
      const target = content.querySelector(`#${CSS.escape(sectionId)}`);
      if (target) {
        target.scrollIntoView({ block: "start", behavior: "smooth" });
      } else {
        content.scrollTop = 0;
      }
    } else {
      content.scrollTop = 0;
    }
  } catch (err) {
    content.textContent = `Failed to load ${page.file}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function renderAuthDocsSearchResults(query, results) {
  const content = $("auth-docs-content");
  if (!content) return;
  const q = query.trim();
  if (!results.length) {
    content.innerHTML =
      `<div class="auth-docs-search-view">` +
      `<h1 class="auth-docs-search-view-title">Search</h1>` +
      `<p class="auth-docs-search-view-meta">No matches for “${q.replace(/</g, "&lt;")}”.</p>` +
      `</div>`;
    return;
  }

  const items = results
    .map((hit) => {
      const section = hit.section
        ? `<span class="auth-docs-search-hit-section">${highlightDocSnippet(hit.section, q)}</span>`
        : "";
      return (
        `<button type="button" class="auth-docs-search-hit" data-doc-id="${hit.id}">` +
        `<span class="auth-docs-search-hit-title">${highlightDocSnippet(hit.title, q)}</span>` +
        section +
        `<span class="auth-docs-search-hit-snippet">${highlightDocSnippet(hit.snippet, q)}</span>` +
        `</button>`
      );
    })
    .join("");

  content.innerHTML =
    `<div class="auth-docs-search-view">` +
    `<h1 class="auth-docs-search-view-title">Search</h1>` +
    `<p class="auth-docs-search-view-meta">${results.length} result${results.length === 1 ? "" : "s"} for “${q.replace(/</g, "&lt;")}”</p>` +
    items +
    `</div>`;

  content.querySelectorAll(".auth-docs-search-hit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-doc-id");
      const input = $("auth-docs-search");
      if (input) input.value = "";
      authDocsSearchQuery = "";
      updateAuthDocsNavSearchState(null);
      if (id) void loadAuthDocPage(id);
    });
  });
}

async function runAuthDocsSearch(rawQuery) {
  const query = String(rawQuery || "");
  authDocsSearchQuery = query.trim();
  if (!authDocsSearchQuery) {
    updateAuthDocsNavSearchState(null);
    if (authDocsActiveId) await loadAuthDocPage(authDocsActiveId);
    else if (authDocsManifest?.pages?.[0]) await loadAuthDocPage(authDocsManifest.pages[0].id);
    return;
  }
  await preloadAuthDocsPages();
  const results = buildAuthDocSearchResults(authDocsSearchQuery);
  updateAuthDocsNavSearchState(new Set(results.map((r) => r.id)));
  renderAuthDocsSearchResults(authDocsSearchQuery, results);
}

function bindAuthDocContentLinks(root) {
  if (!root) return;
  root.querySelectorAll("a[data-doc-link]").forEach((link) => {
    if (link.dataset.bound === "1") return;
    link.dataset.bound = "1";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const id = link.getAttribute("data-doc-link");
      if (id) void loadAuthDocPage(id);
    });
  });
}

function formatVersionTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

async function ensureAuthVersionsReady() {
  const list = $("auth-versions-list");
  const currentEl = $("auth-versions-current");
  if (!list) return;
  try {
    const res = await fetch("/versions.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const releases = Array.isArray(data?.releases) ? data.releases : [];
    if (currentEl) {
      currentEl.textContent = data?.current ? `Current: v${data.current}` : "";
    }
    list.innerHTML = "";
    if (!releases.length) {
      list.innerHTML = "<p class=\"auth-sub\">No releases recorded yet.</p>";
    } else {
      for (const release of releases) {
        const card = document.createElement("article");
        card.className = "auth-version-card";
        const meta = document.createElement("div");
        meta.className = "auth-version-meta";
        const id = document.createElement("span");
        id.className = "auth-version-id";
        id.textContent = `v${release.version || "?"}`;
        const time = document.createElement("span");
        time.className = "auth-version-time";
        time.textContent = formatVersionTime(release.releasedAt);
        meta.appendChild(id);
        meta.appendChild(time);
        const notes = document.createElement("p");
        notes.className = "auth-version-notes";
        notes.textContent = release.notes || "";
        card.appendChild(meta);
        card.appendChild(notes);
        list.appendChild(card);
      }
    }
    authVersionsLoaded = true;
  } catch (err) {
    list.textContent = `Failed to load versions: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function showAuthScreen() {
  applyAuthRoute("main", { syncUrl: true, replace: true });
  if (!isLoggedIn()) showAuthViewPanels("home");
  syncAuthMainTabButton();
}

function showAppShell() {
  const auth = $("auth-screen");
  const app = $("app-shell");
  if (auth) auth.hidden = true;
  if (app) app.hidden = false;
  document.body.style.overflow = "";
  authTopTab = "main";
  syncAuthMainTabButton();
}

async function fetchAuthMe() {
  const res = await fetch("/api/auth/me", { credentials: "same-origin" });
  if (!res.ok) return null;
  const payload = await res.json().catch(() => ({}));
  return payload?.user ?? null;
}

async function loginWithCredentials(email, password) {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
  return payload.user;
}

async function registerWithCredentials({ email, password, name }) {
  const res = await fetch("/api/auth/register", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
  return payload.user;
}

async function logoutSession() {
  const res = await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
}

async function deleteAccount() {
  const res = await fetch("/api/auth/account", {
    method: "DELETE",
    credentials: "same-origin",
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
}

let currentUserId = null;

function setCurrentUser(user) {
  currentUserId = user?.id ? String(user.id) : null;
  setSignedInHint(Boolean(currentUserId));
}

function userScopedStorageKey(base) {
  return currentUserId ? `${base}:u:${currentUserId}` : base;
}

window.userScopedStorageKey = userScopedStorageKey;

function bindAuthForm(onLoggedIn) {
  const form = $("auth-login-form");
  if (form && form.dataset.bound !== "1") {
    form.dataset.bound = "1";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      setAuthError("");
      const email = $("auth-email")?.value?.trim() ?? "";
      const password = $("auth-password")?.value ?? "";
      const btn = $("auth-login-btn");
      if (btn) btn.disabled = true;
      try {
        const user = await loginWithCredentials(email, password);
        if ($("auth-password")) $("auth-password").value = "";
        await onLoggedIn(user);
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : String(err));
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  const signupForm = $("auth-signup-form");
  if (signupForm && signupForm.dataset.bound !== "1") {
    signupForm.dataset.bound = "1";
    signupForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setSignupError("");
      const email = $("auth-signup-email")?.value?.trim() ?? "";
      const password = $("auth-signup-password")?.value ?? "";
      const name = $("auth-signup-name")?.value?.trim() ?? "";
      const btn = $("auth-signup-btn");
      if (btn) btn.disabled = true;
      try {
        const user = await registerWithCredentials({ email, password, name });
        if ($("auth-signup-password")) $("auth-signup-password").value = "";
        await onLoggedIn(user);
      } catch (err) {
        setSignupError(err instanceof Error ? err.message : String(err));
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  const bindNav = (id, view) => {
    const el = $(id);
    if (!el || el.dataset.bound === "1") return;
    el.dataset.bound = "1";
    el.addEventListener("click", () => showAuthView(view));
  };
  bindNav("auth-goto-login", "login");
  bindNav("auth-goto-signup", "signup");
  bindNav("auth-login-to-signup", "signup");
  bindNav("auth-login-to-home", "home");
  bindNav("auth-signup-to-login", "login");
  bindNav("auth-signup-to-home", "home");

  document.querySelectorAll(".auth-tab[data-auth-tab]").forEach((btn) => {
    if (btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-auth-tab");
      applyAuthRoute(tab, { syncUrl: true });
      if (tab === "main" && !isLoggedIn()) showAuthViewPanels("home");
    });
  });

  const authSettingsBtn = $("auth-settings-btn");
  if (authSettingsBtn && authSettingsBtn.dataset.bound !== "1") {
    authSettingsBtn.dataset.bound = "1";
    authSettingsBtn.addEventListener("click", () => openSettingsFromAuthChrome());
  }
}

function renderWalletAccount(data) {
  const statusEl = $("wallet-status");
  const balanceEl = $("wallet-balance");
  if (!statusEl || !balanceEl) return;

  if (!data?.connected) {
    statusEl.textContent = "No Connection";
    statusEl.className = "wallet-header-status wallet-header-status--error";
    statusEl.title = data?.error || "No Connection";
    balanceEl.textContent = "—";
  } else {
    statusEl.textContent = "Connected";
    statusEl.className = "wallet-header-status wallet-header-status--ok";
    statusEl.title = "";
    balanceEl.textContent = formatUsdcBalance(data.collateralBalance);
  }
  syncMobileWalletBalanceDisplay();

  renderSettingsWalletAccount(data);
}

function renderSettingsWalletAccount(data) {
  const funderInput = $("settings-funder-input");
  const signerEl = $("settings-signer");
  const statusEl = $("settings-wallet-status");

  if (funderInput && document.activeElement !== funderInput) {
    funderInput.value = data?.funderAddress || "";
    // Avoid leaking the address via hover tooltip while masked.
    funderInput.title = funderInput.type === "text" ? data?.funderAddress || "" : "";
  }

  if (signerEl) {
    signerEl.textContent = data?.signerAddress ? shortAddress(data.signerAddress) : "—";
    signerEl.title = data?.signerAddress || "";
    signerEl.className = "settings-label-signer settings-field-mono";
  }

  if (statusEl) {
    if (!data?.connected) {
      statusEl.textContent = "Not connected";
      statusEl.className = "settings-label-status settings-conn--error";
      statusEl.title = data?.error || "Not connected";
    } else {
      statusEl.textContent = "Connected";
      statusEl.className = "settings-label-status settings-conn--ok";
      statusEl.title = "";
    }
  }
}

function userNameInitial(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "?";
  const letter = trimmed[0];
  return letter.toLocaleUpperCase();
}

function renderHeaderUserInitial(name) {
  const initial = userNameInitial(name);
  const label = String(name || "").trim() || "Settings";
  const targets = [
    { el: $("settings-page-initial"), btn: $("settings-page-btn") },
    { el: $("auth-settings-initial"), btn: $("auth-settings-btn") },
  ];
  for (const { el, btn } of targets) {
    if (el) el.textContent = initial;
    if (btn) {
      btn.title = label;
      btn.setAttribute("aria-label", `Settings — ${label}`);
    }
  }
}

function renderSettingsUser(user) {
  const nameEl = $("settings-user-name");
  const emailEl = $("settings-user-email");
  if (nameEl && document.activeElement !== nameEl) nameEl.value = user?.name || "";
  if (emailEl && document.activeElement !== emailEl) emailEl.value = user?.email || "";
  renderHeaderUserInitial(user?.name);
}

async function loadWalletAccount() {
  try {
    const res = await fetch("/api/account", { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderWalletAccount(data);
    applyWalletGate(isWalletReadyFromAccount(data));
  } catch {
    renderWalletAccount({ connected: false, error: "Failed to load" });
  }
}

async function loadSettingsUser() {
  try {
    const res = await fetch("/api/user", { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const user = await res.json();
    renderSettingsUser(user);
    applyWalletGate(isWalletReadyFromUser(user));
  } catch (err) {
    setSettingsUserStatus(err instanceof Error ? err.message : String(err), true);
  }
}

async function saveWalletField(body) {
  setSettingsWalletError("");
  const res = await fetch("/api/account/wallet", {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (payload?.account) renderWalletAccount(payload.account);
    throw new Error(payload?.error || `HTTP ${res.status}`);
  }
  if (payload?.account) {
    renderWalletAccount(payload.account);
    applyWalletGate(isWalletReadyFromAccount(payload.account));
  } else {
    await loadWalletAccount();
  }
  if (payload?.user) {
    renderSettingsUser(payload.user);
    applyWalletGate(isWalletReadyFromUser(payload.user));
  } else {
    void loadSettingsUser();
  }
  return payload;
}

let walletReady = false;
let showAppPage = null;
/** @type {(view: string, options?: { persist?: boolean }) => void} */
let showScheduleView = () => {};
/** @type {(page?: string) => void} */
let syncPageToggleActive = () => {};

function isWalletReadyFromUser(user) {
  if (!user) return false;
  if (typeof user.walletReady === "boolean") return user.walletReady;
  return Boolean(user.wallet?.hasPrivateKey && user.wallet?.funderAddress);
}

function isWalletReadyFromAccount(account) {
  if (!account) return false;
  return Boolean(account.hasPrivateKey && account.funderAddress);
}

function applyWalletGate(ready) {
  walletReady = Boolean(ready);
  const buttons = document.querySelectorAll(".page-toggle-btn");
  for (const btn of buttons) {
    const page = btn.dataset.page;
    const locked =
      !walletReady && (page === "simulator" || page === "schedule" || page === "heatmap");
    btn.disabled = locked;
    btn.classList.toggle("is-wallet-locked", locked);
    btn.title = locked
      ? "Add funder address and private key in Settings first"
      : "";
  }
  if (!walletReady && typeof showAppPage === "function") {
    showAppPage("settings", { persist: false });
  }
}

function setSettingsInfoPanelOpen(panel, open) {
  if (!panel) return;
  panel.classList.toggle("is-open", open);
  panel.setAttribute("aria-hidden", open ? "false" : "true");
}

function closeSettingsInfoPanels(exceptKey = null) {
  document.querySelectorAll(".settings-info-panel").forEach((panel) => {
    const key = panel.getAttribute("data-settings-info-panel");
    if (exceptKey != null && key === exceptKey) return;
    setSettingsInfoPanelOpen(panel, false);
  });
  document.querySelectorAll(".settings-info-toggle[data-settings-info]").forEach((btn) => {
    const key = btn.getAttribute("data-settings-info");
    if (exceptKey != null && key === exceptKey) return;
    btn.setAttribute("aria-expanded", "false");
  });
}

function bindSettingsInfoTips() {
  const page = $("page-settings");
  if (!page || page.dataset.infoBound === "1") return;
  page.dataset.infoBound = "1";

  page.addEventListener("click", (event) => {
    const btn = event.target.closest?.(".settings-info-toggle");
    if (btn && page.contains(btn)) {
      event.preventDefault();
      event.stopPropagation();
      const key = btn.getAttribute("data-settings-info");
      const panel = page.querySelector(`[data-settings-info-panel="${key}"]`);
      if (!panel) return;
      const willOpen = !panel.classList.contains("is-open");
      closeSettingsInfoPanels(willOpen ? key : null);
      setSettingsInfoPanelOpen(panel, willOpen);
      btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
      return;
    }

    if (!event.target.closest?.(".settings-info-panel")) {
      closeSettingsInfoPanels();
    }
  });

  document.addEventListener("keydown", (event) => {
    // Modal Esc is handled by bindModalKeyboardShortcuts (closes settings tips when idle).
    if (event.key === "Escape" && document.querySelector(".modal-overlay:not([hidden])")) {
      return;
    }
    if (event.key === "Escape") closeSettingsInfoPanels();
  });
}

function bindSettingsFunderReveal() {
  const funderInput = $("settings-funder-input");
  const toggle = $("settings-funder-toggle");
  if (!funderInput || !toggle || toggle.dataset.bound === "1") return;
  toggle.dataset.bound = "1";
  toggle.addEventListener("click", () => {
    const showing = funderInput.type === "text";
    funderInput.type = showing ? "password" : "text";
    toggle.textContent = showing ? "Show" : "Hide";
    toggle.setAttribute("aria-pressed", showing ? "false" : "true");
    funderInput.title = funderInput.type === "text" ? funderInput.value : "";
  });
}

function isVisibleModalAction(btn) {
  if (!btn || btn.disabled || btn.hidden) return false;
  if (btn.getAttribute("aria-hidden") === "true") return false;
  return btn.getClientRects().length > 0;
}

/**
 * Enter → primary Save/Add. Esc → Cancel/abort topmost popup (or floating menu).
 */
function bindModalKeyboardShortcuts() {
  if (document.documentElement.dataset.modalKeysBound === "1") return;
  document.documentElement.dataset.modalKeysBound = "1";

  document.addEventListener("keydown", (e) => {
    if (e.isComposing || e.defaultPrevented) return;

    if (e.key === "Escape") {
      const openMenus = document.querySelector(
        ".schedule-setup-menu-floating, .schedule-placement-menu-floating, .schedule-setup-menu, .schedule-placement-menu",
      );
      if (openMenus) {
        e.preventDefault();
        closeSetupMenus();
        window.SchedulePlacements?.closeMenus?.();
        return;
      }

      const openOverlays = [...document.querySelectorAll(".modal-overlay")].filter(
        (el) => !el.hidden,
      );
      if (openOverlays.length) {
        e.preventDefault();
        const top =
          openOverlays.find((el) => el.classList.contains("modal-overlay-stacked")) ||
          openOverlays[openOverlays.length - 1];
        if (top.id === "phase-modal") {
          window.Simulator?.discardPhaseModal?.();
          return;
        }
        if (top.id === "setup-edit-modal") {
          // Cancel discards unsaved setup edits (same as Cancel button).
          $("setup-edit-cancel")?.click();
          return;
        }
        if (top.id === "setup-save-modal") {
          closeSetupSaveModal();
          return;
        }
        const cancelBtn = top.querySelector(".modal-btn-secondary");
        const closeBtn = top.querySelector(".modal-close");
        (cancelBtn || closeBtn)?.click();
        return;
      }

      closeSettingsInfoPanels();
      return;
    }

    if (e.key !== "Enter") return;
    if (e.target?.closest?.("textarea")) return;

    const overlay = e.target?.closest?.(".modal-overlay");
    if (!overlay || overlay.hidden) return;

    const primary = overlay.querySelector(".modal-btn-primary");
    if (isVisibleModalAction(primary)) {
      e.preventDefault();
      primary.click();
      return;
    }

    // Phase modal from setup editor: Save is hidden; Close applies edits.
    const closeBtn = overlay.querySelector(".modal-close, .modal-btn-secondary");
    if (overlay.id === "phase-modal" && closeBtn) {
      e.preventDefault();
      closeBtn.click();
    }
  });
}

function bindSettingsEnterToSave() {
  const bindings = [
    { fields: ["settings-user-name", "settings-user-email"], buttonId: "settings-user-save" },
    { fields: ["settings-funder-input"], buttonId: "settings-funder-save" },
    { fields: ["settings-key-input"], buttonId: "settings-key-save" },
  ];
  for (const { fields, buttonId } of bindings) {
    for (const fieldId of fields) {
      const input = $(fieldId);
      if (!input || input.dataset.enterSaveBound === "1") continue;
      input.dataset.enterSaveBound = "1";
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.isComposing) return;
        e.preventDefault();
        const btn = $(buttonId);
        if (btn && !btn.disabled) btn.click();
      });
    }
  }
}

function bindSettingsTabs() {
  const card = document.querySelector(".settings-card--account");
  if (!card || card.dataset.tabsBound === "1") return;
  card.dataset.tabsBound = "1";

  const tabs = [...card.querySelectorAll("[data-settings-tab]")];
  const panels = [...card.querySelectorAll("[data-settings-tab-panel]")];
  if (tabs.length === 0) return;

  const activate = (nextId) => {
    const id = String(nextId || "user");
    for (const tab of tabs) {
      const active = tab.getAttribute("data-settings-tab") === id;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
    }
    for (const panel of panels) {
      const active = panel.getAttribute("data-settings-tab-panel") === id;
      panel.hidden = !active;
    }
  };

  card.querySelector(".settings-tabs")?.addEventListener("click", (event) => {
    const tab = event.target.closest?.("[data-settings-tab]");
    if (!tab || !card.contains(tab)) return;
    activate(tab.getAttribute("data-settings-tab"));
  });

  card.querySelector(".settings-tabs")?.addEventListener("keydown", (event) => {
    const current = event.target.closest?.("[data-settings-tab]");
    if (!current || !card.contains(current)) return;
    const idx = tabs.indexOf(current);
    if (idx < 0) return;
    let nextIdx = idx;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIdx = (idx + 1) % tabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIdx = (idx - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIdx = 0;
    } else if (event.key === "End") {
      nextIdx = tabs.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const next = tabs[nextIdx];
    activate(next.getAttribute("data-settings-tab"));
    next.focus();
  });
}

function bindSettingsEditors() {
  bindSettingsTabs();
  bindSettingsInfoTips();
  bindSettingsFunderReveal();
  bindSettingsEnterToSave();

  const userSave = $("settings-user-save");
  const funderInput = $("settings-funder-input");
  const funderSave = $("settings-funder-save");
  const keyInput = $("settings-key-input");
  const keySave = $("settings-key-save");

  if (userSave && userSave.dataset.bound !== "1") {
    userSave.dataset.bound = "1";
    userSave.addEventListener("click", async () => {
      setSettingsUserStatus("");
      userSave.disabled = true;
      try {
        const res = await fetch("/api/user", {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: $("settings-user-name")?.value ?? "",
            email: $("settings-user-email")?.value ?? "",
          }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
        renderSettingsUser(payload);
        setSettingsUserStatus("Saved");
      } catch (err) {
        setSettingsUserStatus(err instanceof Error ? err.message : String(err), true);
      } finally {
        userSave.disabled = false;
      }
    });
  }

  const logoutBtn = $("settings-logout-btn");
  if (logoutBtn && logoutBtn.dataset.bound !== "1") {
    logoutBtn.dataset.bound = "1";
    logoutBtn.addEventListener("click", async () => {
      setSettingsSessionStatus("");
      logoutBtn.disabled = true;
      try {
        await logoutSession();
        setSignedInHint(false);
        // Live trading keeps running server-side; only the UI session ends.
        window.location.reload();
      } catch (err) {
        setSettingsSessionStatus(err instanceof Error ? err.message : String(err), true);
        logoutBtn.disabled = false;
      }
    });
  }

  const openDocsBtn = $("settings-open-docs");
  if (openDocsBtn && openDocsBtn.dataset.bound !== "1") {
    openDocsBtn.dataset.bound = "1";
    openDocsBtn.addEventListener("click", () => {
      openAuthPublicTab("docs");
    });
  }

  const deleteBtn = $("settings-delete-account-btn");
  if (deleteBtn && deleteBtn.dataset.bound !== "1") {
    deleteBtn.dataset.bound = "1";
    deleteBtn.addEventListener("click", async () => {
      const ok = window.confirm(
        "Delete this account permanently? This cannot be undone.",
      );
      if (!ok) return;
      setSettingsSessionStatus("");
      deleteBtn.disabled = true;
      try {
        await deleteAccount();
        setSignedInHint(false);
        window.location.reload();
      } catch (err) {
        setSettingsSessionStatus(err instanceof Error ? err.message : String(err), true);
        deleteBtn.disabled = false;
      }
    });
  }

  if (funderSave && funderInput && funderSave.dataset.bound !== "1") {
    funderSave.dataset.bound = "1";
    funderSave.addEventListener("click", async () => {
      const funderAddress = funderInput.value.trim();
      if (!funderAddress) {
        setSettingsWalletError("Enter a funder address");
        return;
      }
      funderSave.disabled = true;
      try {
        await saveWalletField({ funderAddress });
      } catch (err) {
        setSettingsWalletError(err instanceof Error ? err.message : String(err));
      } finally {
        funderSave.disabled = false;
      }
    });
  }

  if (keySave && keyInput && keySave.dataset.bound !== "1") {
    keySave.dataset.bound = "1";
    keySave.addEventListener("click", async () => {
      const privateKey = keyInput.value.trim();
      if (!privateKey) {
        setSettingsWalletError("Paste a private key to save");
        return;
      }
      keySave.disabled = true;
      try {
        await saveWalletField({ privateKey });
        keyInput.value = "";
      } catch (err) {
        setSettingsWalletError(err instanceof Error ? err.message : String(err));
      } finally {
        keySave.disabled = false;
      }
    });
  }
}

let walletBalanceRefreshing = false;

async function refreshWalletBalance() {
  if (walletBalanceRefreshing) return;
  const btn = $("wallet-balance-refresh");
  const balanceEl = $("wallet-balance");
  const appHeader = document.querySelector(".app-header");
  const mobileHeader = Boolean(appHeader?.classList.contains("is-mobile-wallet"));

  walletBalanceRefreshing = true;
  if (btn) {
    btn.disabled = true;
    btn.classList.add("is-loading");
  }
  if (mobileHeader) {
    appHeader.classList.add("is-wallet-refreshing");
    balanceEl?.setAttribute("aria-busy", "true");
  }
  try {
    await loadWalletAccount();
  } finally {
    walletBalanceRefreshing = false;
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("is-loading");
    }
    appHeader?.classList.remove("is-wallet-refreshing");
    balanceEl?.removeAttribute("aria-busy");
  }
}

/** Mobile header: balance slot shows balance or "No Connection"; no Connected label. */
function syncMobileWalletBalanceDisplay() {
  const statusEl = $("wallet-status");
  const balanceEl = $("wallet-balance");
  const appHeader = document.querySelector(".app-header");
  if (!statusEl || !balanceEl) return;

  const mobileHeader = Boolean(appHeader?.classList.contains("is-mobile-wallet"));
  if (mobileHeader) {
    if (statusEl.classList.contains("wallet-header-status--error")) {
      balanceEl.textContent = "No Connection";
      balanceEl.classList.add("is-no-connection");
      balanceEl.title = statusEl.title || "No Connection";
    } else {
      balanceEl.classList.remove("is-no-connection");
      if (balanceEl.textContent === "No Connection") {
        balanceEl.textContent = "—";
      }
    }
  } else if (balanceEl.classList.contains("is-no-connection")) {
    balanceEl.textContent = "—";
    balanceEl.classList.remove("is-no-connection");
    balanceEl.title = "";
  }

  syncMobileWalletBalanceRefreshAffordance();
}

function syncMobileWalletBalanceRefreshAffordance() {
  const statusEl = $("wallet-status");
  const balanceEl = $("wallet-balance");
  const appHeader = document.querySelector(".app-header");
  if (!balanceEl) return;

  const mobileHeader = Boolean(appHeader?.classList.contains("is-mobile-wallet"));
  const canRefresh =
    mobileHeader &&
    Boolean(statusEl?.classList.contains("wallet-header-status--ok")) &&
    !balanceEl.classList.contains("is-no-connection");

  balanceEl.classList.toggle("is-refresh-control", canRefresh);
  if (canRefresh) {
    balanceEl.setAttribute("role", "button");
    balanceEl.setAttribute("tabindex", "0");
    balanceEl.title = "Refresh balance";
    balanceEl.setAttribute("aria-label", "Refresh wallet balance");
  } else {
    balanceEl.removeAttribute("role");
    balanceEl.removeAttribute("tabindex");
    balanceEl.removeAttribute("aria-label");
    if (!balanceEl.classList.contains("is-no-connection")) {
      balanceEl.title = "";
    }
  }
}

function bindWalletBalanceRefresh() {
  const btn = $("wallet-balance-refresh");
  const balanceEl = $("wallet-balance");
  if (btn && btn.dataset.bound !== "1") {
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      void refreshWalletBalance();
    });
  }
  if (balanceEl && balanceEl.dataset.refreshBound !== "1") {
    balanceEl.dataset.refreshBound = "1";
    balanceEl.addEventListener("click", () => {
      if (!balanceEl.classList.contains("is-refresh-control")) return;
      void refreshWalletBalance();
    });
    balanceEl.addEventListener("keydown", (e) => {
      if (!balanceEl.classList.contains("is-refresh-control")) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      void refreshWalletBalance();
    });
  }
}

const HEATMAP_METRIC_DEFS = [
  {
    key: "crossings",
    label: "Crossings",
    tip: "Average times price crossed the price-to-beat in that hour.",
    rgb: "88, 166, 255",
  },
  {
    key: "range",
    label: "Range",
    tip: "Average max up plus max down distance from price-to-beat.",
    rgb: "63, 185, 80",
  },
  {
    key: "wallets",
    label: "Wallets",
    tip: "Average unique traders across windows in that hour.",
    rgb: "201, 209, 217",
  },
  {
    key: "newWallets",
    label: "New wallets",
    tip: "Average wallets new to the registry in that hour.",
    rgb: "188, 140, 255",
  },
];

const HEATMAP_METRIC_ORDER_KEY = "poly-real:heatmap-metric-order";
const HEATMAP_METRIC_BY_KEY = Object.fromEntries(HEATMAP_METRIC_DEFS.map((m) => [m.key, m]));

function loadHeatmapMetricOrder() {
  const defaults = HEATMAP_METRIC_DEFS.map((m) => m.key);
  try {
    const raw = localStorage.getItem(HEATMAP_METRIC_ORDER_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaults;
    const seen = new Set();
    const ordered = [];
    for (const key of parsed) {
      if (typeof key !== "string" || !HEATMAP_METRIC_BY_KEY[key] || seen.has(key)) continue;
      seen.add(key);
      ordered.push(key);
    }
    for (const key of defaults) {
      if (!seen.has(key)) ordered.push(key);
    }
    return ordered;
  } catch {
    return defaults;
  }
}

let heatmapMetricOrder = loadHeatmapMetricOrder();

function getHeatmapMetrics() {
  return heatmapMetricOrder
    .map((key) => HEATMAP_METRIC_BY_KEY[key])
    .filter(Boolean);
}

function persistHeatmapMetricOrder(order) {
  heatmapMetricOrder = [...order];
  try {
    localStorage.setItem(HEATMAP_METRIC_ORDER_KEY, JSON.stringify(heatmapMetricOrder));
  } catch {
    // ignore
  }
}

let heatmapCellEls = new Map();
let lastHeatmapState = null;
let walletsListOpen = false;
let walletsListLoadToken = 0;
/** @type {any[]} */
let walletsListCache = [];
let walletsListSeries = "";
/** @type {{ key: "sightings" | "iWin" | "iLost" | "pnl", dir: "desc" | "asc" }} */
let walletsListSort = { key: "sightings", dir: "desc" };
/** @type {"sightings" | "iWin" | "iLost" | "pnl" | null} */
let walletsListSortLoadingKey = null;
const WALLETS_LIST_LIMIT = 100;
let heatmapLegendDrag = null;

function formatLogTime(date = new Date()) {
  return date.toLocaleTimeString("en-GB", { hour12: false });
}

function isLogAtBottom(output, threshold = 12) {
  return output.scrollHeight - output.scrollTop - output.clientHeight <= threshold;
}

function isLogWindowKept(windowStart) {
  if (windowStart == null || !Number.isFinite(windowStart)) {
    return logCurrentWindowStart == null;
  }
  if (logCurrentWindowStart == null) return true;
  return windowStart === logCurrentWindowStart || windowStart === logPreviousWindowStart;
}

function onLogWindowChanged(windowStart) {
  if (windowStart == null || !Number.isFinite(windowStart)) return;
  if (logCurrentWindowStart === windowStart) return;
  logPreviousWindowStart = logCurrentWindowStart;
  logCurrentWindowStart = windowStart;
  pruneLogDomToTwoWindows();
}

function pruneLogDomToTwoWindows() {
  const output = $("log-output");
  if (!output) return;
  for (const line of [...output.children]) {
    const raw = line.dataset?.windowStart;
    const ws = raw != null && raw !== "" ? Number(raw) : null;
    if (!isLogWindowKept(Number.isFinite(ws) ? ws : null)) {
      line.remove();
    }
  }
}

function appendLogEntry(entry) {
  const output = $("log-output");
  if (!output) return;

  const { message, level = "info", source, tMs } = entry ?? {};
  if (!message) return;

  const windowStart =
    entry?.windowStart != null && Number.isFinite(Number(entry.windowStart))
      ? Number(entry.windowStart)
      : windowState?.windowStart ?? null;
  if (!isLogWindowKept(windowStart)) return;

  const stickToBottom = isLogAtBottom(output);

  const line = document.createElement("div");
  line.className = `log-line log-line-${level}`;
  if (windowStart != null && Number.isFinite(windowStart)) {
    line.dataset.windowStart = String(windowStart);
  }

  const time = document.createElement("span");
  time.className = "log-line-time";
  time.textContent = formatLogTime(tMs ? new Date(tMs) : new Date());

  const sourceEl = document.createElement("span");
  sourceEl.className = "log-line-source";
  if (source) sourceEl.textContent = `[${source}] `;

  const text = document.createElement("span");
  text.textContent = String(message);

  line.append(time, sourceEl, text);
  output.appendChild(line);

  pruneLogDomToTwoWindows();

  if (stickToBottom) {
    output.scrollTop = output.scrollHeight;
  }
}

window.appendLogEntry = appendLogEntry;

function appendLog(message) {
  appendLogEntry({ message, level: "info" });
}

function clearLogDom() {
  const output = $("log-output");
  if (output) output.replaceChildren();
}

function clearLog() {
  try {
    sessionStorage.setItem(LOG_CLEARED_SESSION_KEY, "1");
  } catch {
    // ignore
  }
  logCurrentWindowStart = windowState?.windowStart ?? null;
  logPreviousWindowStart = null;
  clearLogDom();
}

function isLogClearedThisSession() {
  try {
    return sessionStorage.getItem(LOG_CLEARED_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function scrollLogToBottom() {
  const output = $("log-output");
  if (!output) return;
  output.scrollTop = output.scrollHeight;
}

function fmtPrice(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1000) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${v.toFixed(2)}`;
}

function fmtGap(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value >= 0 ? "+" : "-";
  return sign + fmtPrice(Math.abs(value));
}

function fmtQuote(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v * 100).toFixed(1) + "¢";
}

const QUOTE_BOXES = [
  {
    boxId: "quote-up-buy-box",
    lockedId: "up-buy-locked",
    liveId: "up-buy",
    lockKey: "upBuy",
    side: "up",
    leg: "buy",
    livePrice: (state) => state.yesAsk,
    tone: "up",
  },
  {
    boxId: "quote-up-sell-box",
    lockedId: "up-sell-locked",
    liveId: "up-sell",
    lockKey: "upSell",
    side: "up",
    leg: "sell",
    livePrice: (state) => state.yesBid,
    tone: "up",
  },
  {
    boxId: "quote-down-buy-box",
    lockedId: "down-buy-locked",
    liveId: "down-buy",
    lockKey: "downBuy",
    side: "down",
    leg: "buy",
    livePrice: (state) => state.noAsk,
    tone: "down",
  },
  {
    boxId: "quote-down-sell-box",
    lockedId: "down-sell-locked",
    liveId: "down-sell",
    lockKey: "downSell",
    side: "down",
    leg: "sell",
    livePrice: (state) => state.noBid,
    tone: "down",
  },
];

function tradingState(state) {
  return state?.trading ?? null;
}

function canQuoteAction(trading, side, leg) {
  if (trading && trading.quotesEnabled === false) return false;
  if (!trading) return true;
  const pos = trading.positions?.[side];
  if (leg === "buy") {
    return !trading.positions?.up && !trading.positions?.down;
  }
  return Boolean(pos);
}

function formatBookPriceCents(price) {
  const n = Number(price);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}¢`;
}

function formatBookSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1000) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function normalizeBookLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((l) => ({
      price: Number(l?.price),
      size: Number(l?.size),
    }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0);
}

function bookLevelRowHtml(level, kind, isBest = false) {
  const bestClass = isBest ? " book-row-best" : "";
  return (
    `<div class="book-row book-row-${kind}${bestClass}">` +
    `<span class="book-size">${formatBookSize(level.size)}</span>` +
    `<span class="book-price">${formatBookPriceCents(level.price)}</span>` +
    `</div>`
  );
}

function renderBookLadder(el, asks, bids) {
  if (!el) return;
  const askLevels = normalizeBookLevels(asks);
  const bidLevels = normalizeBookLevels(bids);
  // Worst ask at the top of the upper half; best ask against the mid line.
  const askRows = [...askLevels].reverse();
  let asksHtml = "";
  for (let i = 0; i < askRows.length; i++) {
    asksHtml += bookLevelRowHtml(askRows[i], "ask", i === askRows.length - 1);
  }
  if (!asksHtml && askLevels.length === 0 && bidLevels.length === 0) {
    asksHtml = '<div class="book-empty">—</div>';
  }
  let bidsHtml = "";
  for (let i = 0; i < bidLevels.length; i++) {
    bidsHtml += bookLevelRowHtml(bidLevels[i], "bid", i === 0);
  }
  if (!bidsHtml && askLevels.length === 0 && bidLevels.length === 0) {
    bidsHtml = '<div class="book-empty">—</div>';
  }
  el.innerHTML =
    `<div class="book-asks">${asksHtml}</div>` +
    `<div class="book-mid-gap" aria-hidden="true"></div>` +
    `<div class="book-bids">${bidsHtml}</div>`;
}

/** Live CLOB depth (same feed as UP/DOWN quote boxes); up to 10 levels per side. */
function updateBookPanel(state) {
  const upEl = $("book-ladder-up");
  const downEl = $("book-ladder-down");
  if (!upEl && !downEl) return;
  renderBookLadder(upEl, state?.yesAsks, state?.yesBids);
  renderBookLadder(downEl, state?.noAsks, state?.noBids);
}

function updateQuoteBoxes(state) {
  const trading = tradingState(state);
  const locks = trading?.quoteLocks ?? state?.sim?.quoteLocks ?? {};
  for (const cfg of QUOTE_BOXES) {
    const box = $(cfg.boxId);
    const locked = $(cfg.lockedId);
    const live = $(cfg.liveId);
    const values = locked?.parentElement;
    if (!box || !locked || !live || !values) continue;

    live.textContent = fmtQuote(cfg.livePrice(state));

    // Graph quote row is display-only (Trigger fills latch visually; never clickable).
    box.classList.add("quote-box-display", "quote-box-disabled");
    box.classList.remove("quote-box-pressing", "quote-box-pending");
    box.setAttribute("aria-disabled", "true");

    const lockedPrice = locks[cfg.lockKey];
    if (lockedPrice != null && Number.isFinite(lockedPrice)) {
      locked.hidden = false;
      locked.textContent = fmtQuote(lockedPrice);
      values.classList.add("quote-has-locked");
      box.classList.add(cfg.tone === "up" ? "quote-triggered-up" : "quote-triggered-down");
      box.classList.add("quote-box-latched");
    } else {
      locked.hidden = true;
      locked.textContent = "";
      values.classList.remove("quote-has-locked");
      box.classList.remove("quote-triggered-up", "quote-triggered-down", "quote-box-latched");
    }
  }
  syncPredictionActionBoxes(state);
}

let quoteOrderInFlight = false;

async function postTradingOrder(
  side,
  leg,
  {
    source,
    shares,
    orderType,
    sellOrderType,
    takeProfitCents,
    maxPrice,
    minPrice,
    triggerId,
    triggerName,
    triggerExitReason,
  } = {},
) {
  const res = await fetch("/api/trading/order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      side,
      leg,
      ...(source === "prediction" || source === "trigger" ? { source } : {}),
      ...(Number.isFinite(Number(shares)) && Number(shares) > 0
        ? { shares: Math.floor(Number(shares)) }
        : {}),
      ...(orderType === "FAK" || orderType === "FOK" ? { orderType } : {}),
      ...(sellOrderType === "FAK" || sellOrderType === "FOK" || sellOrderType === "GTD"
        ? { sellOrderType }
        : {}),
      ...(Number.isFinite(Number(takeProfitCents))
        ? { takeProfitCents: Math.round(Number(takeProfitCents)) }
        : {}),
      ...(source === "trigger" && typeof triggerId === "string" && triggerId.trim()
        ? { triggerId: triggerId.trim() }
        : {}),
      ...(source === "trigger" && typeof triggerName === "string" && triggerName.trim()
        ? { triggerName: triggerName.trim().slice(0, 120) }
        : {}),
      ...(source === "trigger" &&
      (triggerExitReason === "tp" || triggerExitReason === "sl")
        ? { triggerExitReason }
        : {}),
      ...(Number.isFinite(Number(maxPrice)) && Number(maxPrice) > 0 && Number(maxPrice) < 1
        ? { maxPrice: Number(maxPrice) }
        : {}),
      ...(Number.isFinite(Number(minPrice)) && Number(minPrice) > 0 && Number(minPrice) < 1
        ? { minPrice: Number(minPrice) }
        : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function postTriggerGtdSync(desires) {
  const res = await fetch("/api/trading/trigger-gtd-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ desires: Array.isArray(desires) ? desires : [] }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/** Prediction never places live orders — Trigger cards only. */
function isPredictionTradeArmed() {
  return false;
}

async function placePredictionTradeOrder(_side, _leg) {
  return { ok: false, skipped: true };
}

function predictionActionBoxForLeg(leg) {
  return leg === "buy" ? $("prediction-buy-box") : leg === "sell" ? $("prediction-sell-box") : null;
}

function predictionActionBoxMatchesSide(box, side) {
  if (!box || (side !== "up" && side !== "down")) return false;
  return box.classList.contains(side === "up" ? "quote-box-up" : "quote-box-down");
}

function quoteActionLabel(side, leg) {
  return `${String(leg || "?").toUpperCase()} ${String(side || "?").toUpperCase()}`;
}

function quoteBuyBlockedReason(trading) {
  if (!trading) return "unknown";
  if (trading.quotesEnabled === false) return "Allow trade off (or executor disabled)";
  if (trading.positions?.up || trading.positions?.down) return "already holding a position";
  return "not allowed";
}

/** @deprecated Manual quote clicks removed — Trigger cards place orders. */
async function clickQuoteBox(_side, _leg) {
  appendLogEntry({
    level: "warn",
    source: "trading",
    message: "Manual quote orders removed — use Trigger cards (Trade + Active)",
  });
}

function bindQuoteBoxes() {
  for (const cfg of QUOTE_BOXES) {
    const box = $(cfg.boxId);
    if (!box || box.dataset.bound === "1") continue;
    box.dataset.bound = "1";
    box.classList.add("quote-box-display", "quote-box-disabled");
    box.setAttribute("aria-disabled", "true");
  }
}

function fmtTickDelta(delta) {
  if (delta == null || !Number.isFinite(delta)) return "—";
  const sign = delta >= 0 ? "+" : "-";
  const abs = Math.abs(delta);
  if (abs >= 1000) {
    return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${abs.toFixed(4)}`;
}

function setSignedValue(el, text, sign) {
  el.textContent = text;
  el.className = "sim-value";
  if (sign > 0) el.classList.add("gap-positive");
  else if (sign < 0) el.classList.add("gap-negative");
}

function windowPricePoints(state) {
  const history = state?.priceHistory || [];
  const windowStart = state?.windowStart;
  const windowEnd = state?.windowEnd;
  if (!windowStart || !windowEnd) return [];

  // Include t === windowEnd so Open Replay's official close anchor is drawn
  // (Settlement-aligned tip). Live in-progress windows never emit that stamp early.
  const points = history.filter((p) => p.t >= windowStart && p.t <= windowEnd);
  if (
    state.assetPrice != null &&
    Number.isFinite(state.assetPrice) &&
    !points.some((p) => p.price === state.assetPrice)
  ) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= windowStart && nowSec < windowEnd) {
      points.push({ t: nowSec, price: state.assetPrice });
    }
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

function initSimulatorBoxScrollbars() {
  const MIN_THUMB_PX = 32;
  document.querySelectorAll(".simulator-box-scroll").forEach((scrollEl) => {
    if (scrollEl.dataset.customScrollbar) return;
    scrollEl.dataset.customScrollbar = "1";

    const wrap = document.createElement("div");
    wrap.className = "simulator-box-scroll-wrap";
    scrollEl.parentNode.insertBefore(wrap, scrollEl);
    wrap.appendChild(scrollEl);

    const track = document.createElement("div");
    track.className = "simulator-box-scrollbar-track";
    track.setAttribute("aria-hidden", "true");
    const thumb = document.createElement("div");
    thumb.className = "simulator-box-scrollbar-thumb";
    track.appendChild(thumb);
    wrap.appendChild(track);

    const update = () => {
      const { scrollWidth, clientWidth, scrollLeft } = scrollEl;
      const overflow = scrollWidth - clientWidth;
      if (overflow <= 1) {
        track.hidden = true;
        return;
      }
      track.hidden = false;
      const thumbWidth = Math.max(MIN_THUMB_PX, (clientWidth / scrollWidth) * clientWidth);
      const travel = Math.max(0, clientWidth - thumbWidth);
      const ratio = scrollLeft / overflow;
      thumb.style.width = `${thumbWidth}px`;
      thumb.style.transform = `translateX(${ratio * travel}px)`;
    };

    scrollEl.addEventListener("scroll", update, { passive: true });
    if (window.ResizeObserver) {
      new ResizeObserver(update).observe(scrollEl);
      new ResizeObserver(update).observe(wrap);
    }
    window.addEventListener("resize", update);
    update();
  });
}

function initChart() {
  chartCanvas = $("price-chart");
  if (!chartCanvas) return;
  chartCtx = chartCanvas.getContext("2d");
  const wrap = chartCanvas.parentElement;
  if (window.ResizeObserver) {
    new ResizeObserver(() => drawPriceChart(windowState)).observe(wrap);
  }
  window.addEventListener("resize", () => drawPriceChart(windowState));
  if (window.Simulator) window.Simulator.init(chartCanvas);
  resizeChartCanvas();
}

window.drawPriceChart = drawPriceChart;

const MIN_COLUMN_PCT = 0;
const MAX_COLUMN_PCT = 100;
const LEFT_COVERED_PCT = 0.5;
const RIGHT_COVERED_PCT = 99.5;
const MARKET_MOBILE_MQ = "(max-width: 720px)";
const MARKET_MOBILE_SECTION_PX = 280;

/** Row-split helpers filled by initLeftRowSplitter. */
let leftColumnLayout = null;

function isMarketMobileStack() {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(MARKET_MOBILE_MQ).matches
    : window.innerWidth <= 720;
}

function setColumnSplit(pct) {
  const page = $("page-simulator");
  const splitter = $("column-splitter");
  if (!page) return;
  const clamped = Math.max(MIN_COLUMN_PCT, Math.min(MAX_COLUMN_PCT, pct));
  page.style.setProperty("--split-left-pct", String(clamped));
  if (splitter) splitter.setAttribute("aria-valuenow", String(Math.round(clamped)));
  syncLeftColumnRail();
  syncMarketColumnRail();
}

function parseSplitPct(raw) {
  const text = String(raw ?? "").trim();
  // Number("") === 0 — treat blank as missing, not 0% covered.
  if (!text) return null;
  const pct = Number(text);
  return Number.isFinite(pct) ? pct : null;
}

function getColumnSplitPct() {
  const page = $("page-simulator");
  if (!page) return 50;
  const inline = parseSplitPct(page.style.getPropertyValue("--split-left-pct"));
  if (inline != null) return inline;
  const fromCss = parseSplitPct(getComputedStyle(page).getPropertyValue("--split-left-pct"));
  return fromCss != null ? fromCss : 50;
}

function syncLeftColumnRail() {
  const page = $("page-simulator");
  const rail = $("left-column-rail");
  if (!page || !rail) return;
  // Mobile stack shows all sections under the graph — no cover rail.
  if (page.classList.contains("is-mobile-stack") || isMarketMobileStack()) {
    rail.hidden = true;
    rail.classList.remove("is-visible");
    page.classList.remove("is-left-covered");
    return;
  }
  // Use split % only — measuring width during first paint can be ~0 and falsely show the rail.
  const covered = getColumnSplitPct() <= LEFT_COVERED_PCT;
  rail.hidden = !covered;
  rail.classList.toggle("is-visible", covered);
  page.classList.toggle("is-left-covered", covered);
  if (covered) clampLeftColumnRailTop();
}

function syncMarketColumnRail() {
  const page = $("page-simulator");
  const rail = $("market-column-rail");
  if (!page || !rail) return;
  if (page.classList.contains("is-mobile-stack") || isMarketMobileStack()) {
    rail.hidden = true;
    rail.classList.remove("is-visible");
    page.classList.remove("is-market-covered");
    syncMarketRailLivePulse();
    return;
  }
  const covered = getColumnSplitPct() >= RIGHT_COVERED_PCT;
  rail.hidden = !covered;
  rail.classList.toggle("is-visible", covered);
  page.classList.toggle("is-market-covered", covered);
  syncMarketRailLivePulse();
  if (covered) clampMarketColumnRailTop();
}

function syncMarketRailLivePulse() {
  const rail = $("market-column-rail");
  if (!rail) return;
  const live = Boolean($("start-trading")?.checked);
  rail.classList.toggle("is-live-trading", live);
}

const LEFT_RAIL_TOP_KEY = "poly-real:left-rail-top";

function loadLeftColumnRailTop() {
  try {
    const raw = localStorage.getItem(LEFT_RAIL_TOP_KEY);
    const n = raw != null ? Number(raw) : Number.NaN;
    return Number.isFinite(n) ? n : 72;
  } catch {
    return 72;
  }
}

function saveLeftColumnRailTop(top) {
  try {
    localStorage.setItem(LEFT_RAIL_TOP_KEY, String(Math.round(top)));
  } catch {
    // ignore
  }
}

function clampLeftColumnRailTop(preferredTop) {
  const page = $("page-simulator");
  const rail = $("left-column-rail");
  if (!page || !rail || rail.hidden) return;
  const pageRect = page.getBoundingClientRect();
  const railH = rail.offsetHeight || 0;
  const pad = 8;
  const maxTop = Math.max(pad, pageRect.height - railH - pad);
  const base =
    preferredTop != null && Number.isFinite(preferredTop)
      ? preferredTop
      : rail.offsetTop || loadLeftColumnRailTop();
  const next = Math.max(pad, Math.min(maxTop, base));
  page.style.setProperty("--left-rail-top", `${Math.round(next)}px`);
  rail.style.top = `${Math.round(next)}px`;
  return next;
}

function openLeftSection(section) {
  if (isMarketMobileStack()) {
    leftColumnLayout?.openMobileSection?.(section);
    return;
  }
  setColumnSplit(50);
  // Two frames so --split-left-pct layout is settled before measuring.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      leftColumnLayout?.maximizeSection?.(section);
      syncLeftColumnRail();
    });
  });
}

function bindLeftColumnRail() {
  const rail = $("left-column-rail");
  const page = $("page-simulator");
  if (!rail || !page || rail.dataset.bound === "1") return;
  rail.dataset.bound = "1";

  clampLeftColumnRailTop(loadLeftColumnRailTop());

  rail.querySelectorAll("[data-left-section]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openLeftSection(btn.dataset.leftSection);
    });
  });

  let dragging = false;
  let startY = 0;
  let startTop = 0;
  const handle = rail.querySelector(".left-column-rail-handle");

  const onPointerMove = (e) => {
    if (!dragging) return;
    clampLeftColumnRailTop(startTop + (e.clientY - startY));
  };

  const onPointerUp = (e) => {
    if (!dragging) return;
    dragging = false;
    rail.classList.remove("is-dragging");
    try {
      (handle || rail).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    const top = clampLeftColumnRailTop(rail.offsetTop);
    if (top != null) saveLeftColumnRailTop(top);
  };

  const onHandleDown = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startTop = rail.offsetTop;
    rail.classList.add("is-dragging");
    try {
      (handle || rail).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    e.preventDefault();
  };

  if (handle) handle.addEventListener("pointerdown", onHandleDown);

  window.addEventListener("resize", () => {
    clampLeftColumnRailTop();
  });
}

const MARKET_RAIL_TOP_KEY = "poly-real:market-rail-top";

function loadMarketColumnRailTop() {
  try {
    const raw = localStorage.getItem(MARKET_RAIL_TOP_KEY);
    const n = raw != null ? Number(raw) : Number.NaN;
    return Number.isFinite(n) ? n : 72;
  } catch {
    return 72;
  }
}

function saveMarketColumnRailTop(top) {
  try {
    localStorage.setItem(MARKET_RAIL_TOP_KEY, String(Math.round(top)));
  } catch {
    // ignore
  }
}

function clampMarketColumnRailTop(preferredTop) {
  const page = $("page-simulator");
  const rail = $("market-column-rail");
  if (!page || !rail || rail.hidden) return;
  const pageRect = page.getBoundingClientRect();
  const railH = rail.offsetHeight || 0;
  const pad = 8;
  const maxTop = Math.max(pad, pageRect.height - railH - pad);
  const base =
    preferredTop != null && Number.isFinite(preferredTop)
      ? preferredTop
      : rail.offsetTop || loadMarketColumnRailTop();
  const next = Math.max(pad, Math.min(maxTop, base));
  page.style.setProperty("--market-rail-top", `${Math.round(next)}px`);
  rail.style.top = `${Math.round(next)}px`;
  return next;
}

function openMarketColumn() {
  setColumnSplit(50);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      syncMarketColumnRail();
      syncLeftColumnRail();
    });
  });
}

function bindMarketColumnRail() {
  const rail = $("market-column-rail");
  const page = $("page-simulator");
  if (!rail || !page || rail.dataset.bound === "1") return;
  rail.dataset.bound = "1";

  clampMarketColumnRailTop(loadMarketColumnRailTop());

  const openBtn = $("market-rail-open");
  if (openBtn) {
    openBtn.addEventListener("click", () => {
      openMarketColumn();
    });
  }

  let dragging = false;
  let startY = 0;
  let startTop = 0;
  const handle = rail.querySelector(".left-column-rail-handle");

  const onPointerMove = (e) => {
    if (!dragging) return;
    clampMarketColumnRailTop(startTop + (e.clientY - startY));
  };

  const onPointerUp = (e) => {
    if (!dragging) return;
    dragging = false;
    rail.classList.remove("is-dragging");
    try {
      (handle || rail).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    const top = clampMarketColumnRailTop(rail.offsetTop);
    if (top != null) saveMarketColumnRailTop(top);
  };

  const onHandleDown = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startTop = rail.offsetTop;
    rail.classList.add("is-dragging");
    try {
      (handle || rail).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    e.preventDefault();
  };

  if (handle) handle.addEventListener("pointerdown", onHandleDown);

  window.addEventListener("resize", () => {
    clampMarketColumnRailTop();
  });
}

function initLeftRowSplitter() {
  const leftColumn = document.querySelector(".left-column");
  const walletHeader = document.querySelector(".wallet-panel-header") || document.querySelector(".settings-panel-header");
  const tradeHeader = document.querySelector(".trade-panel-header");
  const tradeBody = document.querySelector(".trade-panel-body");
  const prevHeader = document.querySelector(".positions-panel-header");
  const triggersHeader = document.querySelector(".triggers-panel-header");
  const bookHeader = document.querySelector(".book-panel-header");
  const logHeader = document.querySelector(".log-panel-header");
  const prevBody = document.querySelector(".positions-body");
  const triggersBody = document.querySelector(".triggers-body");
  const bookBody = document.querySelector(".book-body");
  const logBody = document.querySelector(".log-output");
  const prevDragHandle = document.querySelector('[data-drag-edge="prev"]');
  const triggersDragHandle = document.querySelector('[data-drag-edge="triggers"]');
  const bookDragHandle = document.querySelector('[data-drag-edge="book"]');
  const logDragHandle = document.querySelector('[data-drag-edge="log"]');
  if (
    !leftColumn ||
    !walletHeader ||
    !tradeHeader ||
    !tradeBody ||
    !prevHeader ||
    !triggersHeader ||
    !bookHeader ||
    !logHeader ||
    !prevDragHandle ||
    !triggersDragHandle ||
    !bookDragHandle ||
    !logDragHandle ||
    !prevBody ||
    !triggersBody ||
    !bookBody ||
    !logBody
  ) {
    return;
  }

  let dragging = false;
  let dragKind = null;
  let anchorTriggersHeaderTop = 0;
  let anchorTriggersContent = 0;
  let anchorBookHeaderTop = 0;
  let anchorBookContent = 0;
  let anchorLogHeaderTop = 0;
  let anchorLogContent = 0;
  let anchorTradeContent = 0;
  let anchorPrevContent = 0;
  let activeHandle = null;

  const parseHeight = (name, fallback) => {
    const raw = getComputedStyle(leftColumn).getPropertyValue(name);
    const value = raw ? parseFloat(raw) : Number.NaN;
    return Number.isFinite(value) ? value : fallback;
  };

  const getMetrics = () => {
    const colRect = leftColumn.getBoundingClientRect();
    // Wallet header may be relocated into the app header on mobile.
    const walletHeaderH = leftColumn.contains(walletHeader) ? walletHeader.offsetHeight : 0;
    const tradeHeaderH = tradeHeader.offsetHeight;
    const prevHeaderH = prevHeader.offsetHeight;
    const triggersHeaderH = triggersHeader.offsetHeight;
    const bookHeaderH = bookHeader.offsetHeight;
    const logHeaderH = logHeader.offsetHeight;
    const chrome =
      walletHeaderH + tradeHeaderH + prevHeaderH + triggersHeaderH + bookHeaderH + logHeaderH;
    const maxContent = Math.max(0, colRect.height - chrome);
    return {
      colRect,
      walletHeaderH,
      tradeHeaderH,
      prevHeaderH,
      triggersHeaderH,
      bookHeaderH,
      logHeaderH,
      chrome,
      maxContent,
    };
  };

  const readHeights = () => ({
    trade: parseHeight("--trade-content-height", 140),
    prev: parseHeight("--prev-content-height", 0),
    triggers: parseHeight("--triggers-content-height", 0),
    book: parseHeight("--book-content-height", 0),
    log: parseHeight("--log-content-height", 0),
  });

  const applyHeights = (trade, prev, triggers, book, log) => {
    const { colRect, chrome, maxContent } = getMetrics();
    // Trade UI is hidden (Allow trade is on Settings → User), but keep this
    // height as the spacer above Positions so dragging the Positions header
    // can park space above itself instead of collapsing the stack / moving Log.
    let t = Math.max(0, trade);
    let p = Math.max(0, prev);
    let tr = Math.max(0, triggers);
    let b = Math.max(0, book);
    let l = Math.max(0, log);

    // While the market page is hidden (display:none), geometry is 0 — do not
    // recompute margin / redistribute or an open log will collapse on return.
    const layoutReady = colRect.height > chrome;

    if (layoutReady) {
      const total = t + p + tr + b + l;
      if (total > maxContent && total > 0) {
        const scale = maxContent / total;
        t *= scale;
        p *= scale;
        tr *= scale;
        b *= scale;
        l *= scale;
      } else if (total < maxContent && !dragging) {
        // Fill leftover column space into an open content body (not as a gap
        // below Positions that looks like an empty section). Skip while
        // dragging so pointer-driven sizes are not redistributed (jump).
        const slack = maxContent - total;
        if (l > 0) {
          l += slack;
        } else if (b > 0) {
          b += slack;
        } else if (tr > 0) {
          tr += slack;
        } else if (p > 0) {
          p += slack;
        } else if (t > 0) {
          t += slack;
        }
      }
    }

    leftColumn.style.setProperty("--trade-content-height", `${t}px`);
    leftColumn.style.setProperty("--prev-content-height", `${p}px`);
    leftColumn.style.setProperty("--triggers-content-height", `${tr}px`);
    leftColumn.style.setProperty("--book-content-height", `${b}px`);
    leftColumn.style.setProperty("--log-content-height", `${l}px`);

    if (layoutReady) {
      const stackHeight = chrome + t + p + tr + b + l;
      // Only pin Log with margin when every content body is collapsed.
      const margin =
        t <= 0 && p <= 0 && tr <= 0 && b <= 0 && l <= 0
          ? Math.max(0, colRect.height - stackHeight)
          : 0;
      leftColumn.style.setProperty("--log-margin-top", `${margin}px`);
    }

    tradeBody.classList.toggle("is-collapsed", t <= 0);
    prevBody.classList.toggle("is-collapsed", p <= 0);
    triggersBody.classList.toggle("is-collapsed", tr <= 0);
    bookBody.classList.toggle("is-collapsed", b <= 0);
    logBody.classList.toggle("is-collapsed", l <= 0);
    const hasPositionCards = Boolean(prevBody.querySelector(".position-card"));
    const hasTriggerCards = Boolean(triggersBody.querySelector(".trigger-card"));
    prevBody.classList.toggle("is-scrollable", p > 0 && hasPositionCards);
    triggersBody.classList.toggle("is-scrollable", tr > 0 && hasTriggerCards);
    bookBody.classList.toggle("is-scrollable", b > 0);
    logBody.classList.toggle("is-scrollable", l > 0);
    if (document.getElementById("page-simulator")?.classList.contains("is-mobile-stack")) {
      prevHeader.setAttribute("aria-expanded", p > 0 ? "true" : "false");
      triggersHeader.setAttribute("aria-expanded", tr > 0 ? "true" : "false");
      bookHeader.setAttribute("aria-expanded", b > 0 ? "true" : "false");
      logHeader.setAttribute("aria-expanded", l > 0 ? "true" : "false");
    }
  };

  const reflowHeights = () => {
    const heights = readHeights();
    applyHeights(heights.trade, heights.prev, heights.triggers, heights.book, heights.log);
  };

  const maximizeSection = (section) => {
    const { maxContent } = getMetrics();
    if (section === "positions") {
      applyHeights(0, maxContent, 0, 0, 0);
      return;
    }
    if (section === "triggers") {
      applyHeights(0, 0, maxContent, 0, 0);
      return;
    }
    if (section === "book") {
      applyHeights(0, 0, 0, maxContent, 0);
      return;
    }
    if (section === "log") {
      applyHeights(0, 0, 0, 0, maxContent);
      return;
    }
    // trade / wallet / default — Trade panel is gone; open Positions
    applyHeights(0, maxContent, 0, 0, 0);
  };

  const syncMobileAccordionAria = () => {
    const heights = readHeights();
    const setExpanded = (header, open) => {
      header.setAttribute("aria-expanded", open ? "true" : "false");
    };
    setExpanded(prevHeader, heights.prev > 0);
    setExpanded(triggersHeader, heights.triggers > 0);
    setExpanded(bookHeader, heights.book > 0);
    setExpanded(logHeader, heights.log > 0);
  };

  const openMobileSection = (section) => {
    const openPx = MARKET_MOBILE_SECTION_PX;
    if (section === "positions") {
      applyHeights(0, openPx, 0, 0, 0);
    } else if (section === "triggers") {
      applyHeights(0, 0, openPx, 0, 0);
    } else if (section === "book") {
      applyHeights(0, 0, 0, openPx, 0);
    } else if (section === "log") {
      applyHeights(0, 0, 0, 0, openPx);
    } else {
      applyHeights(0, openPx, 0, 0, 0);
    }
    syncMobileAccordionAria();
  };

  const toggleMobileSection = (section) => {
    const heights = readHeights();
    const openPx = MARKET_MOBILE_SECTION_PX;
    const key =
      section === "positions"
        ? "prev"
        : section === "triggers"
          ? "triggers"
          : section === "book"
            ? "book"
            : section === "log"
              ? "log"
              : null;
    if (!key) return;
    const next = {
      trade: 0,
      prev: heights.prev,
      triggers: heights.triggers,
      book: heights.book,
      log: heights.log,
    };
    next[key] = heights[key] > 0 ? 0 : openPx;
    applyHeights(next.trade, next.prev, next.triggers, next.book, next.log);
    syncMobileAccordionAria();
  };

  leftColumnLayout = {
    applyHeights,
    maximizeSection,
    openMobileSection,
    toggleMobileSection,
    readHeights,
    getMetrics,
    reflowHeights,
  };

  const initDefaultHeights = () => {
    const { maxContent } = getMetrics();
    if (maxContent < 1) return;
    applyHeights(0, maxContent, 0, 0, 0);
  };

  const clampPrevDrag = (clientY) => {
    const {
      colRect,
      walletHeaderH,
      tradeHeaderH,
      prevHeaderH,
      triggersHeaderH,
      bookHeaderH,
      logHeaderH,
    } = getMetrics();
    const tradeHeaderBottom = colRect.top + walletHeaderH + tradeHeaderH;
    const minPrevTop = tradeHeaderBottom;
    const maxPrevTop =
      colRect.bottom - prevHeaderH - triggersHeaderH - bookHeaderH - logHeaderH;
    const prevTop = Math.max(minPrevTop, Math.min(clientY, maxPrevTop));
    const trade = prevTop - tradeHeaderBottom;
    const prevBottom = prevTop + prevHeaderH;
    if (prevBottom > anchorTriggersHeaderTop) {
      anchorTriggersHeaderTop = prevBottom;
      const below = Math.max(
        0,
        colRect.bottom - prevBottom - triggersHeaderH - bookHeaderH - logHeaderH,
      );
      const log = Math.min(anchorLogContent, below);
      const book = Math.min(anchorBookContent, Math.max(0, below - log));
      const triggers = Math.max(0, below - log - book);
      anchorTriggersContent = triggers;
      anchorBookContent = book;
      anchorLogContent = log;
      applyHeights(trade, 0, triggers, book, log);
      return;
    }
    const prev = Math.max(0, anchorTriggersHeaderTop - prevBottom);
    applyHeights(trade, prev, anchorTriggersContent, anchorBookContent, anchorLogContent);
  };

  const clampTriggersDrag = (clientY) => {
    const {
      colRect,
      walletHeaderH,
      tradeHeaderH,
      prevHeaderH,
      triggersHeaderH,
      bookHeaderH,
      logHeaderH,
    } = getMetrics();
    const tradeHeaderBottom = colRect.top + walletHeaderH + tradeHeaderH;
    const prevBottom = tradeHeaderBottom + anchorTradeContent + prevHeaderH;
    const minTriggersTop = tradeHeaderBottom + prevHeaderH;
    const maxTriggersTop = colRect.bottom - triggersHeaderH - bookHeaderH - logHeaderH;
    const triggersTop = Math.max(minTriggersTop, Math.min(clientY, maxTriggersTop));
    const triggersBottom = triggersTop + triggersHeaderH;

    if (triggersTop < prevBottom) {
      const trade = Math.max(0, triggersTop - prevHeaderH - tradeHeaderBottom);
      anchorTradeContent = trade;
      anchorPrevContent = 0;
      const below = Math.max(
        0,
        colRect.bottom - triggersBottom - bookHeaderH - logHeaderH,
      );
      const log = Math.min(anchorLogContent, below);
      const book = Math.min(anchorBookContent, Math.max(0, below - log));
      const triggers = Math.max(0, below - log - book);
      anchorBookContent = book;
      anchorLogContent = log;
      applyHeights(trade, 0, triggers, book, log);
      return;
    }

    const prev = Math.max(0, triggersTop - prevBottom);
    anchorPrevContent = prev;

    if (triggersBottom > anchorBookHeaderTop) {
      anchorBookHeaderTop = triggersBottom;
      const below = Math.max(0, colRect.bottom - triggersBottom - bookHeaderH - logHeaderH);
      const log = Math.min(anchorLogContent, below);
      const book = Math.max(0, below - log);
      anchorBookContent = book;
      anchorLogContent = log;
      applyHeights(anchorTradeContent, prev, 0, book, log);
      return;
    }

    const triggers = Math.max(0, anchorBookHeaderTop - triggersBottom);
    applyHeights(anchorTradeContent, prev, triggers, anchorBookContent, anchorLogContent);
  };

  const clampBookDrag = (clientY) => {
    const {
      colRect,
      walletHeaderH,
      tradeHeaderH,
      prevHeaderH,
      triggersHeaderH,
      bookHeaderH,
      logHeaderH,
    } = getMetrics();
    const tradeHeaderBottom = colRect.top + walletHeaderH + tradeHeaderH;
    // Bottom of Triggers header (top of Triggers content) — same pattern as
    // clampTriggersDrag's prevBottom. Do NOT include Triggers content height
    // here; that made any upward Book drag look like a "push" and shove Log.
    const triggersHeaderBottom =
      tradeHeaderBottom +
      anchorTradeContent +
      prevHeaderH +
      anchorPrevContent +
      triggersHeaderH;
    const minBookTop = tradeHeaderBottom + prevHeaderH + triggersHeaderH;
    const maxBookTop = colRect.bottom - bookHeaderH - logHeaderH;
    const bookTop = Math.max(minBookTop, Math.min(clientY, maxBookTop));
    const bookBottom = bookTop + bookHeaderH;

    if (bookTop < triggersHeaderBottom) {
      // Collapse Triggers content; may push Positions / Trade.
      anchorTriggersContent = 0;
      const triggersHeaderTop = bookTop - triggersHeaderH;
      const prevHeaderBottom = tradeHeaderBottom + anchorTradeContent + prevHeaderH;
      const below = Math.max(0, colRect.bottom - bookBottom - logHeaderH);
      const log = Math.min(anchorLogContent, below);
      const book = Math.max(0, below - log);
      anchorBookContent = book;
      anchorLogContent = log;
      if (triggersHeaderTop < prevHeaderBottom) {
        const trade = Math.max(0, triggersHeaderTop - prevHeaderH - tradeHeaderBottom);
        anchorTradeContent = trade;
        anchorPrevContent = 0;
        applyHeights(trade, 0, 0, book, log);
        return;
      }
      const prev = Math.max(0, triggersHeaderTop - prevHeaderBottom);
      anchorPrevContent = prev;
      applyHeights(anchorTradeContent, prev, 0, book, log);
      return;
    }

    const triggers = Math.max(0, bookTop - triggersHeaderBottom);
    anchorTriggersContent = triggers;

    if (bookBottom > anchorLogHeaderTop) {
      // Contact Log header — push it down and shrink Log content.
      anchorLogHeaderTop = bookBottom;
      const log = Math.max(0, colRect.bottom - bookBottom - logHeaderH);
      anchorLogContent = log;
      applyHeights(anchorTradeContent, anchorPrevContent, triggers, 0, log);
      return;
    }

    // Trade space between Triggers and Book; keep Log header pinned.
    const book = Math.max(0, anchorLogHeaderTop - bookBottom);
    applyHeights(anchorTradeContent, anchorPrevContent, triggers, book, anchorLogContent);
  };

  const clampLogDrag = (clientY) => {
    const {
      colRect,
      walletHeaderH,
      tradeHeaderH,
      prevHeaderH,
      triggersHeaderH,
      bookHeaderH,
      logHeaderH,
    } = getMetrics();
    const tradeHeaderBottom = colRect.top + walletHeaderH + tradeHeaderH;
    const minLogTop = tradeHeaderBottom + prevHeaderH + triggersHeaderH + bookHeaderH;
    const maxLogTop = colRect.bottom - logHeaderH;
    const logTop = Math.max(minLogTop, Math.min(clientY, maxLogTop));
    const log = Math.max(0, colRect.bottom - logTop - logHeaderH);
    const bookHeaderBottom =
      tradeHeaderBottom +
      anchorTradeContent +
      prevHeaderH +
      anchorPrevContent +
      triggersHeaderH +
      anchorTriggersContent +
      bookHeaderH;

    if (logTop < bookHeaderBottom) {
      // Book content collapses; Book header sits directly above Log.
      anchorBookContent = 0;
      const bookHeaderTop = logTop - bookHeaderH;
      const triggersHeaderBottom =
        tradeHeaderBottom +
        anchorTradeContent +
        prevHeaderH +
        anchorPrevContent +
        triggersHeaderH;
      if (bookHeaderTop < triggersHeaderBottom) {
        anchorTriggersContent = 0;
        const triggersHeaderTop = bookHeaderTop - triggersHeaderH;
        const prevHeaderBottom = tradeHeaderBottom + anchorTradeContent + prevHeaderH;
        if (triggersHeaderTop < prevHeaderBottom) {
          const trade = Math.max(0, triggersHeaderTop - prevHeaderH - tradeHeaderBottom);
          anchorTradeContent = trade;
          anchorPrevContent = 0;
          applyHeights(trade, 0, 0, 0, log);
          return;
        }
        const prev = Math.max(0, triggersHeaderTop - prevHeaderBottom);
        anchorPrevContent = prev;
        applyHeights(anchorTradeContent, prev, 0, 0, log);
        return;
      }
      const triggers = Math.max(0, bookHeaderTop - triggersHeaderBottom);
      anchorTriggersContent = triggers;
      applyHeights(anchorTradeContent, anchorPrevContent, triggers, 0, log);
      return;
    }

    const book = Math.max(0, logTop - bookHeaderBottom);
    anchorBookContent = book;
    applyHeights(anchorTradeContent, anchorPrevContent, anchorTriggersContent, book, log);
  };

  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    dragKind = null;
    activeHandle?.classList.remove("is-dragging");
    activeHandle = null;
    document.body.classList.remove("is-row-resizing");
  };

  const startPrevDrag = (e) => {
    if (e.button !== 0 || isMarketMobileStack()) return;
    dragging = true;
    dragKind = "prev";
    activeHandle = prevDragHandle;
    const heights = readHeights();
    anchorTriggersHeaderTop = triggersHeader.getBoundingClientRect().top;
    anchorTriggersContent = heights.triggers;
    anchorBookContent = heights.book;
    anchorLogContent = heights.log;
    activeHandle.classList.add("is-dragging");
    document.body.classList.add("is-row-resizing");
    try {
      prevDragHandle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    clampPrevDrag(e.clientY);
    e.preventDefault();
  };

  const startTriggersDrag = (e) => {
    if (e.button !== 0 || isMarketMobileStack()) return;
    dragging = true;
    dragKind = "triggers";
    activeHandle = triggersDragHandle;
    const heights = readHeights();
    anchorTradeContent = heights.trade;
    anchorPrevContent = heights.prev;
    anchorBookHeaderTop = bookHeader.getBoundingClientRect().top;
    anchorBookContent = heights.book;
    anchorLogContent = heights.log;
    activeHandle.classList.add("is-dragging");
    document.body.classList.add("is-row-resizing");
    try {
      triggersDragHandle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    clampTriggersDrag(e.clientY);
    e.preventDefault();
  };

  const startBookDrag = (e) => {
    if (e.button !== 0 || isMarketMobileStack()) return;
    dragging = true;
    dragKind = "book";
    activeHandle = bookDragHandle;
    const heights = readHeights();
    anchorTradeContent = heights.trade;
    anchorPrevContent = heights.prev;
    anchorTriggersContent = heights.triggers;
    anchorLogHeaderTop = logHeader.getBoundingClientRect().top;
    anchorLogContent = heights.log;
    activeHandle.classList.add("is-dragging");
    document.body.classList.add("is-row-resizing");
    try {
      bookDragHandle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    clampBookDrag(e.clientY);
    e.preventDefault();
  };

  const startLogDrag = (e) => {
    if (e.button !== 0 || isMarketMobileStack()) return;
    dragging = true;
    dragKind = "log";
    activeHandle = logDragHandle;
    const heights = readHeights();
    anchorTradeContent = heights.trade;
    anchorPrevContent = heights.prev;
    anchorTriggersContent = heights.triggers;
    anchorBookContent = heights.book;
    activeHandle.classList.add("is-dragging");
    document.body.classList.add("is-row-resizing");
    try {
      logDragHandle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    clampLogDrag(e.clientY);
    e.preventDefault();
  };

  initDefaultHeights();
  window.addEventListener("resize", () => {
    reflowHeights();
    syncLeftColumnRail();
    syncMarketColumnRail();
  });

  const onPointerMove = (e) => {
    if (!dragging) return;
    if (dragKind === "prev") clampPrevDrag(e.clientY);
    else if (dragKind === "triggers") clampTriggersDrag(e.clientY);
    else if (dragKind === "book") clampBookDrag(e.clientY);
    else if (dragKind === "log") clampLogDrag(e.clientY);
  };

  const bindHandle = (handle, onDown) => {
    handle.addEventListener("pointerdown", onDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", stopDragging);
    handle.addEventListener("pointercancel", stopDragging);
    handle.addEventListener("lostpointercapture", stopDragging);
  };

  bindHandle(prevDragHandle, startPrevDrag);
  bindHandle(triggersDragHandle, startTriggersDrag);
  bindHandle(bookDragHandle, startBookDrag);
  bindHandle(logDragHandle, startLogDrag);
  window.addEventListener("blur", stopDragging);

  const isAccordionClickTarget = (target) => {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest(
        "button, a, input, select, textarea, label, .panel-header-drag-handle"
      )
    );
  };

  const bindMobileAccordion = (header, section) => {
    header.addEventListener("click", (e) => {
      if (!isMarketMobileStack()) return;
      if (isAccordionClickTarget(e.target)) return;
      toggleMobileSection(section);
    });
    header.addEventListener("keydown", (e) => {
      if (!isMarketMobileStack()) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      if (isAccordionClickTarget(e.target)) return;
      e.preventDefault();
      toggleMobileSection(section);
    });
  };

  bindMobileAccordion(prevHeader, "positions");
  bindMobileAccordion(triggersHeader, "triggers");
  bindMobileAccordion(bookHeader, "book");
  bindMobileAccordion(logHeader, "log");
}

function initColumnSplitter() {
  const page = $("page-simulator");
  const splitter = $("column-splitter");
  if (!page || !splitter) return;

  let dragging = false;

  const updateFromClientX = (clientX) => {
    const rect = page.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setColumnSplit(pct);
  };

  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("is-dragging");
    document.body.classList.remove("is-column-resizing");
  };

  splitter.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || isMarketMobileStack()) return;
    dragging = true;
    splitter.classList.add("is-dragging");
    document.body.classList.add("is-column-resizing");
    updateFromClientX(e.clientX);
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    updateFromClientX(e.clientX);
  });

  window.addEventListener("mouseup", stopDragging);
  window.addEventListener("blur", stopDragging);

  splitter.addEventListener("keydown", (e) => {
    if (isMarketMobileStack()) return;
    const current = Number(page.style.getPropertyValue("--split-left-pct")) || 50;
    if (e.key === "ArrowLeft") {
      setColumnSplit(current - 2);
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      setColumnSplit(current + 2);
      e.preventDefault();
    }
  });
}

function syncMarketMobileStack() {
  const page = $("page-simulator");
  if (!page) return;
  const mobile = isMarketMobileStack();
  const wasMobile = page.classList.contains("is-mobile-stack");
  page.classList.toggle("is-mobile-stack", mobile);
  document.querySelector(".app")?.classList.toggle("is-mobile-header", mobile);
  document.querySelector(".app-header")?.classList.toggle("is-mobile-header", mobile);

  const accordionHeaders = page.querySelectorAll(
    ".positions-panel-header, .triggers-panel-header, .book-panel-header, .log-panel-header"
  );
  accordionHeaders.forEach((header) => {
    if (!mobile) header.removeAttribute("aria-expanded");
  });

  syncMobileCountdownPlacement();
  syncMobileWalletPlacement();
  syncScheduleMobileSide();
  // Re-run header layout so mobile always stacks Market/Schedule as bottom tabs.
  if (typeof updateAppHeaderLayout === "function") {
    updateAppHeaderLayout();
  }

  if (mobile && !wasMobile) {
    leftColumnLayout?.openMobileSection?.("positions");
  } else if (!mobile && wasMobile) {
    leftColumnLayout?.reflowHeights?.();
  }

  syncLeftColumnRail();
  syncMarketColumnRail();
  requestAnimationFrame(() => {
    resizeChartCanvas();
    if (windowState) drawPriceChart(windowState);
  });
}

function initMarketMobileStack() {
  syncMarketMobileStack();
  if (typeof window.matchMedia !== "function") {
    window.addEventListener("resize", syncMarketMobileStack);
    return;
  }
  const mq = window.matchMedia(MARKET_MOBILE_MQ);
  const onChange = () => syncMarketMobileStack();
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", onChange);
  } else if (typeof mq.addListener === "function") {
    mq.addListener(onChange);
  }
}

/** Keep Live/Replay switcher in the left column (desktop) or bottom bar (mobile). */
function syncScheduleWorkspaceSwitcherHost() {
  const bar = document.querySelector(".schedule-workspace-switcher-bar");
  const mobileHost = document.querySelector(".schedule-page-subheader");
  const desktopHost = $("schedule-workspace-footer");
  if (!bar || !mobileHost || !desktopHost) return;
  const host = isMarketMobileStack() ? mobileHost : desktopHost;
  if (bar.parentElement !== host) host.appendChild(bar);
}

/** Sync Schedule left-panel collapse chrome for mobile (subheader toggle + aria). */
function syncScheduleMobileSide() {
  const page = $("page-schedule-heatmap");
  const toggleBtn = $("schedule-side-toggle");
  if (!page) return;

  syncScheduleWorkspaceSwitcherHost();

  const mobile = isMarketMobileStack();
  if (!mobile) {
    page.classList.remove("is-schedule-side-collapsed");
    if (toggleBtn) {
      toggleBtn.setAttribute("aria-expanded", "true");
      toggleBtn.setAttribute("aria-label", "Hide side panel");
      toggleBtn.title = "Hide side panel";
    }
    return;
  }

  const collapsed = page.classList.contains("is-schedule-side-collapsed");
  if (toggleBtn) {
    toggleBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    const label = collapsed ? "Show side panel" : "Hide side panel";
    toggleBtn.setAttribute("aria-label", label);
    toggleBtn.title = label;
  }
}

function setScheduleSideCollapsed(collapsed) {
  const page = $("page-schedule-heatmap");
  if (!page) return;
  page.classList.toggle("is-schedule-side-collapsed", Boolean(collapsed));
  syncScheduleMobileSide();
}

function initScheduleMobileSide() {
  const toggleBtn = $("schedule-side-toggle");
  toggleBtn?.addEventListener("click", () => {
    if (!isMarketMobileStack()) return;
    const page = $("page-schedule-heatmap");
    const collapsed = page?.classList.contains("is-schedule-side-collapsed");
    setScheduleSideCollapsed(!collapsed);
  });
  syncScheduleMobileSide();
  if (typeof window.matchMedia !== "function") {
    window.addEventListener("resize", syncScheduleMobileSide);
    return;
  }
  const mq = window.matchMedia(MARKET_MOBILE_MQ);
  const onChange = () => syncScheduleMobileSide();
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", onChange);
  } else if (typeof mq.addListener === "function") {
    mq.addListener(onChange);
  }
}

function resizeChartCanvasFor(canvas) {
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = wrap?.clientWidth ?? canvas.clientWidth;
  const height = wrap?.clientHeight ?? canvas.clientHeight;
  const nextW = Math.max(1, Math.floor(width * dpr));
  const nextH = Math.max(1, Math.floor(height * dpr));
  // Only mutate when size changes — avoids ResizeObserver ↔ canvas.style loops.
  if (canvas.width !== nextW) canvas.width = nextW;
  if (canvas.height !== nextH) canvas.height = nextH;
  const styleW = `${width}px`;
  const styleH = `${height}px`;
  if (canvas.style.width !== styleW) canvas.style.width = styleW;
  if (canvas.style.height !== styleH) canvas.style.height = styleH;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function resizeChartCanvas() {
  if (!chartCanvas) return;
  const { ctx } = resizeChartCanvasFor(chartCanvas);
  if (ctx) chartCtx = ctx;
}

function chartXToFrac(x, layout) {
  return Math.min(1, Math.max(0, (x - layout.padding.left) / layout.plotW));
}

function buildChartLayout(state, width, height) {
  const padding = { top: 10, right: 10, bottom: 22, left: 10 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const windowStart = state?.windowStart;
  const windowEnd = state?.windowEnd;
  const duration =
    windowStart && windowEnd ? windowEnd - windowStart : 300;

  let minP = 0;
  let maxP = 1;
  const points = windowPricePoints(state);
  const ptb = state?.prevCloseAsset;

  if (points.length > 0) {
    const prices = points.map((p) => p.price);
    if (ptb != null && Number.isFinite(ptb)) prices.push(ptb);
    minP = Math.min(...prices);
    maxP = Math.max(...prices);
    const spread = maxP - minP || Math.max(minP * 0.001, 1);
    const margin = spread * 0.1;
    minP -= margin;
    maxP += margin;
  } else if (ptb != null && Number.isFinite(ptb)) {
    minP = ptb * 0.999;
    maxP = ptb * 1.001;
  } else if (state?.assetPrice != null) {
    minP = state.assetPrice * 0.999;
    maxP = state.assetPrice * 1.001;
  }

  const xAt = (t) =>
    windowStart
      ? padding.left + ((t - windowStart) / duration) * plotW
      : padding.left;
  const yAt = (price) =>
    padding.top + plotH - ((price - minP) / (maxP - minP)) * plotH;

  return {
    padding,
    plotW,
    plotH,
    width,
    height,
    windowStart,
    windowEnd,
    duration,
    minP,
    maxP,
    points,
    ptb,
    xAt,
    yAt,
  };
}

function drawPriceChart(state, options = {}) {
  const canvas = options.canvas ?? chartCanvas;
  if (!canvas) return null;

  let ctx;
  let width;
  let height;
  if (options.canvas) {
    const resized = resizeChartCanvasFor(canvas);
    ctx = resized.ctx;
    width = resized.width;
    height = resized.height;
  } else {
    if (!chartCtx) return null;
    resizeChartCanvas();
    ctx = chartCtx;
    width = chartCanvas.clientWidth;
    height = chartCanvas.clientHeight;
  }

  ctx.clearRect(0, 0, width, height);

  const layout = buildChartLayout(state, width, height);
  const { padding, plotW, plotH, points, ptb, xAt, yAt } = layout;

  if (plotW <= 0 || plotH <= 0) return layout;

  if (!options.canvas && window.Simulator) {
    window.Simulator.setChartLayout(layout);
  }

  const overlayOpts = {};
  if (options.setupOverride) overlayOpts.setupOverride = options.setupOverride;
  if (options.markers === false) overlayOpts.markers = false;
  if (Array.isArray(options.markersOverride)) overlayOpts.markersOverride = options.markersOverride;
  if (options.revealUntil != null && Number.isFinite(options.revealUntil)) {
    overlayOpts.revealUntil = Number(options.revealUntil);
  }
  if (options.hoverLine !== undefined) overlayOpts.hoverLine = options.hoverLine;
  if (options.dragLine !== undefined) overlayOpts.dragLine = options.dragLine;
  const trading = state?.trading;
  // Market / Open Replay: phase bands removed (Trigger-only). Setup editor only.
  const setupEditorPhases = Boolean(options.setupOverride && options.canvas);
  overlayOpts.phasesVisible = setupEditorPhases;
  overlayOpts.phasesEditable = setupEditorPhases && Boolean(trading?.phasesEditable);
  if (trading && !Array.isArray(options.markersOverride) && Array.isArray(trading.markers)) {
    overlayOpts.markersOverride = trading.markers;
  }

  const revealUntil =
    options.revealUntil != null && Number.isFinite(options.revealUntil)
      ? Number(options.revealUntil)
      : null;
  const drawPoints =
    revealUntil == null ? points : points.filter((p) => p.t <= revealUntil);

  ctx.strokeStyle = "#21262d";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  // Open Replay: full-height Duration band(s) ending at each Prediction trigger.
  const predBands = Array.isArray(options.predictionBands)
    ? options.predictionBands
    : options.predictionBand
      ? [options.predictionBand]
      : [];
  if (layout.windowStart != null && layout.windowEnd != null) {
    for (const predBand of predBands) {
      if (
        !predBand ||
        !Number.isFinite(predBand.startSec) ||
        !Number.isFinite(predBand.endSec) ||
        !(predBand.endSec > predBand.startSec)
      ) {
        continue;
      }
      const bandStart = Math.max(layout.windowStart, Number(predBand.startSec));
      const bandEnd = Math.min(layout.windowEnd, Number(predBand.endSec));
      if (!(bandEnd > bandStart)) continue;
      const x0 = xAt(bandStart);
      const x1 = xAt(bandEnd);
      ctx.fillStyle =
        predBand.side === "up"
          ? "rgba(63, 185, 80, 0.16)"
          : predBand.side === "down"
            ? "rgba(248, 81, 73, 0.16)"
            : "rgba(88, 166, 255, 0.14)";
      ctx.fillRect(x0, padding.top, Math.max(1, x1 - x0), plotH);
    }
  }

  if (layout.windowStart && layout.windowEnd) {
    ctx.fillStyle = "#6e7681";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("0:00", padding.left, height - padding.bottom + 4);
    ctx.fillText(
      `${Math.floor(layout.duration / 60)}:${String(layout.duration % 60).padStart(2, "0")}`,
      width - padding.right,
      height - padding.bottom + 4,
    );
  }

  if (!layout.windowStart || !layout.windowEnd) {
    ctx.fillStyle = "#8b949e";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Waiting for window…", width / 2, height / 2);
    if (window.Simulator) window.Simulator.drawOverlay(ctx, layout, state, overlayOpts);
    return layout;
  }

  if (points.length === 0) {
    ctx.fillStyle = "#8b949e";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Waiting for price data…", width / 2, height / 2);
    if (window.Simulator) window.Simulator.drawOverlay(ctx, layout, state, overlayOpts);
    return layout;
  }

  if (ptb != null && Number.isFinite(ptb)) {
    const ptbY = yAt(ptb);
    ctx.strokeStyle = "#d29922";
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(padding.left, ptbY);
    ctx.lineTo(width - padding.right, ptbY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#d29922";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    const ptbLabel = "PTB";
    ctx.fillText(ptbLabel, padding.left + 4, ptbY - 2);
  }

  if (drawPoints.length === 0) {
    if (window.Simulator) window.Simulator.drawOverlay(ctx, layout, state, overlayOpts);
    return layout;
  }

  const last = drawPoints[drawPoints.length - 1];
  const marketOutcome =
    options.marketOutcome === "up" || options.marketOutcome === "down"
      ? options.marketOutcome
      : null;
  const atWindowEnd =
    revealUntil == null ||
    (layout.windowEnd != null &&
      Number.isFinite(layout.windowEnd) &&
      revealUntil >= layout.windowEnd - 0.05);
  // Open Replay: once the official close is visible, color from market outcome.
  // Mid-scrub still follows last visible tick vs PTB.
  const lineColor =
    atWindowEnd && marketOutcome
      ? marketOutcome === "up"
        ? "#2ea043"
        : "#f85149"
      : ptb != null && last.price >= ptb
        ? "#2ea043"
        : "#f85149";
  const playheadT =
    revealUntil == null
      ? last.t
      : Math.min(layout.windowEnd, Math.max(layout.windowStart, revealUntil));

  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  drawPoints.forEach((point, index) => {
    const x = xAt(point.t);
    const y = yAt(point.price);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  // Hold last price out to the scrubber so the line meets the vertical bar.
  if (revealUntil != null && playheadT > last.t) {
    ctx.lineTo(xAt(playheadT), yAt(last.price));
  }
  ctx.stroke();

  const endX = xAt(revealUntil != null ? playheadT : last.t);
  const endY = yAt(last.price);
  ctx.fillStyle = lineColor;
  ctx.beginPath();
  ctx.arc(endX, endY, 3.5, 0, Math.PI * 2);
  ctx.fill();

  if (
    options.showPlayhead !== false &&
    revealUntil != null &&
    layout.windowStart &&
    layout.windowEnd
  ) {
    const playX = xAt(playheadT);
    ctx.strokeStyle = "rgba(201, 209, 217, 0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(playX, padding.top);
    ctx.lineTo(playX, padding.top + plotH);
    ctx.stroke();
  }

  // Duration bands behind phase/trade markers (full height, fill only).
  if (options.triggerHits !== false) {
    drawTriggerChartHits(ctx, layout, state, "bands");
  }

  if (window.Simulator) {
    window.Simulator.drawOverlay(ctx, layout, state, overlayOpts);
  }

  // Demo-only trigger buy dots when no trading/phase marker already covers the hit.
  if (options.triggerHits !== false) {
    drawTriggerChartHits(ctx, layout, state, "dots");
  }

  return layout;
}

function updateGraphPanel(state) {
  $("graph-ptb").textContent = fmtPrice(state.prevCloseAsset);
  $("graph-current").textContent = fmtPrice(state.assetPrice);

  const gapEl = $("graph-gap");
  if (state.assetGap != null && Number.isFinite(state.assetGap)) {
    setSignedValue(gapEl, fmtGap(state.assetGap), state.assetGap);
  } else {
    gapEl.textContent = "—";
    gapEl.className = "sim-value";
  }

  const history = state.priceHistory || [];
  let tickDelta = null;
  if (history.length >= 2) {
    tickDelta = history[history.length - 1].price - history[history.length - 2].price;
  }
  const tickEl = $("graph-tick");
  if (tickDelta != null && Number.isFinite(tickDelta)) {
    setSignedValue(tickEl, fmtTickDelta(tickDelta), tickDelta);
  } else {
    tickEl.textContent = "—";
    tickEl.className = "sim-value";
  }

  if (chartWindowStart !== state.windowStart) {
    chartWindowStart = state.windowStart;
  }

  if (!window.Simulator?.isDraggingPhaseLine?.()) {
    drawPriceChart(state);
    if (window.SetupEditor?.refreshChart) window.SetupEditor.refreshChart();
  }
}

function fmtUsdSigned(amount) {
  if (amount == null || !Number.isFinite(amount)) return "—";
  const sign = amount >= 0 ? "+" : "-";
  return sign + fmtUsdAmount(Math.abs(amount));
}

function fmtUsdAmount(amount) {
  if (amount == null || !Number.isFinite(amount)) return "—";
  return `$${amount.toFixed(2)}`;
}

function fmtPriceCents(price) {
  if (price == null || !Number.isFinite(price)) return "—";
  const cents = price * 100;
  return Number.isInteger(cents) ? `${cents}¢` : `${cents.toFixed(1)}¢`;
}

/**
 * Profit-prediction sell target: buy basis + Profit prediction (¢).
 * Basis is the actual fill when Prediction Trade bought; otherwise the trigger Ask (sim / Trade Off).
 */
function predictionTargetPrice(basisBuy, riseCents) {
  if (basisBuy == null || !Number.isFinite(Number(basisBuy))) return null;
  return Number(basisBuy) + normalizePredictionRiseCents(riseCents) / 100;
}

function fmtTradeLeg(side, shares, price) {
  if (!side || shares == null || price == null) return "—";
  const label = side === "up" ? "UP" : "DOWN";
  return `${label} ${shares} @ ${fmtPriceCents(price)}`;
}

const PREDICTION_ICON_CHECK =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>';
const PREDICTION_ICON_CROSS =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 4 12 12M12 4 4 12"/></svg>';

function positionStatusLabel(status) {
  if (status === "open") return "Open";
  if (status === "sold") return "Sold";
  if (status === "win") return "Win";
  if (status === "loss") return "Loss";
  if (status === "right") return "Right";
  if (status === "wrong") return "Wrong";
  return status || "—";
}

function formatPositionBuyTime(buyAt) {
  if (buyAt == null || !Number.isFinite(Number(buyAt))) return "";
  const sec = Number(buyAt);
  // Markers sometimes store ms; live cards use unix seconds.
  const date = new Date(sec > 1e12 ? sec : sec * 1000);
  if (Number.isNaN(date.getTime())) return "";
  // UTC — position card times align with the UTC schedule board.
  return date.toLocaleTimeString("en-GB", { hour12: false, timeZone: "UTC" });
}

/** Unix start sec from `series:windowStart` or `btc-updown-5m-{start}` slug. */
function positionWindowStartSec(card) {
  const rawKey = card?.windowKey != null ? String(card.windowKey).trim() : "";
  if (rawKey) {
    const colon = rawKey.lastIndexOf(":");
    const tail = colon >= 0 ? rawKey.slice(colon + 1) : rawKey;
    const n = Number(tail);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n / 1000 : n;
  }
  const slug = typeof card?.slug === "string" ? card.slug.trim().toLowerCase() : "";
  const m = slug.match(/-updown-(?:5m|15m)-(\d+)$/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return NaN;
}

function positionWindowDurationSec(card) {
  const hay = `${card?.series || ""} ${card?.windowKey || ""} ${card?.slug || ""}`.toLowerCase();
  if (hay.includes("15m")) return 900;
  if (hay.includes("5m")) return 300;
  return 300;
}

/** Prefer card.slug; else `{asset}-updown-{5m|15m}-{windowStart}` from series / windowKey. */
function resolveDemoOpenCardSlug(card) {
  const fromCard = typeof card?.slug === "string" ? card.slug.trim() : "";
  if (fromCard) return fromCard;
  const windowStart = positionWindowStartSec(card);
  if (!Number.isFinite(windowStart) || windowStart <= 0) return "";
  const hay = `${card?.series || ""} ${card?.windowKey || ""}`.trim().toLowerCase();
  const m = hay.match(/\b([a-z]+)-(5m|15m)\b/);
  if (!m) return "";
  return `${m[1]}-updown-${m[2]}-${Math.floor(windowStart)}`;
}

function isDemoPositionCard(card) {
  if (!card) return false;
  if (card.demo === true) return true;
  return String(card.id || "").startsWith("demo:");
}

/** Past-window Demo card still Open in localStorage (held settle never finished). */
function isPastWindowOpenDemoPositionCard(card) {
  if (!isDemoPositionCard(card)) return false;
  const status = String(card.status || "open").toLowerCase();
  if (status !== "open") return false;
  const start = positionWindowStartSec(card);
  const dur = positionWindowDurationSec(card);
  if (!Number.isFinite(start) || start <= 0) return false;
  return start + dur < Math.floor(Date.now() / 1000);
}

function formatUtcHm(unixSec) {
  if (!Number.isFinite(unixSec)) return "";
  return new Date(unixSec * 1000).toLocaleTimeString("en-GB", {
    hour12: false,
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Market window range in UTC, e.g. `17:05–17:10`. */
function formatPositionWindowRange(card) {
  const start = positionWindowStartSec(card);
  if (!Number.isFinite(start)) return "";
  const end = start + positionWindowDurationSec(card);
  const a = formatUtcHm(start);
  const b = formatUtcHm(end);
  if (!a || !b) return "";
  return `${a}–${b}`;
}

function isPredictionPositionCard(card) {
  return card?.kind === "prediction" || String(card?.id || "").startsWith("prediction:");
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Trigger title on a Positions card (stored name, else live Market Triggers list). */
function resolvePositionTriggerName(card) {
  const stored = typeof card?.triggerName === "string" ? card.triggerName.trim() : "";
  if (stored) return stored;
  const tid = typeof card?.triggerId === "string" ? card.triggerId.trim() : "";
  if (!tid) return "";
  const t = typeof findUserTrigger === "function" ? findUserTrigger(tid) : null;
  const name = typeof t?.name === "string" ? t.name.trim() : "";
  return name || "";
}

function renderPositionCard(card) {
  const sideClass = card.side === "up" ? "is-up" : "is-down";
  const status = card.status || "open";
  const isPrediction = isPredictionPositionCard(card);
  const isDemo = !isPrediction && (card.demo === true || String(card.id || "").startsWith("demo:"));
  const settled =
    status === "sold" ||
    status === "win" ||
    status === "loss" ||
    status === "right" ||
    status === "wrong";
  const plPending = !isPrediction && settled && !isDemo && card.confirmed !== true;
  // Empty Settlement/P/L skeleton while open or waiting for confirmation (trades only).
  const valuesPending =
    !isPrediction && !isDemo && (status === "open" || plPending);
  // Gray pulsing status badge is for Waiting only — Open uses accent text (is-open).
  const statusWaiting = plPending && (status === "win" || status === "loss");

  const buyTime = formatPositionBuyTime(card.buyAt);
  // Buy fill is known at trigger time — show it immediately, even while the
  // card is still open / waiting for confirmation.
  const hasBuyFill =
    !isPrediction &&
    card.shares != null && Number.isFinite(Number(card.shares)) &&
    card.buyPrice != null && Number.isFinite(Number(card.buyPrice));
  const buyValue = hasBuyFill ? `${card.shares} @ ${fmtPriceCents(card.buyPrice)}` : "";
  let detailHtml = "";
  const triggerName = !isPrediction ? resolvePositionTriggerName(card) : "";

  if (isPrediction) {
    const predBuyPrice =
      card.buyPrice != null && Number.isFinite(Number(card.buyPrice))
        ? Number(card.buyPrice)
        : card.triggerBuy != null && Number.isFinite(Number(card.triggerBuy))
          ? Number(card.triggerBuy)
          : null;
    const predBuyShares =
      card.shares != null && Number.isFinite(Number(card.shares)) ? Number(card.shares) : null;
    const predBuyValue =
      predBuyPrice != null
        ? predBuyShares != null
          ? `${predBuyShares} @ ${fmtPriceCents(predBuyPrice)}`
          : fmtPriceCents(predBuyPrice)
        : "—";
    const targetPrice =
      card.targetPrice != null && Number.isFinite(Number(card.targetPrice))
        ? Number(card.targetPrice)
        : predictionTargetPrice(
            card.buyPrice != null && Number.isFinite(Number(card.buyPrice))
              ? Number(card.buyPrice)
              : card.triggerBuy,
            card.riseCents,
          );
    const predTimeLabel = buyTime
      ? `Trigger <span class="position-card-buy-time">${buyTime}</span>`
      : "Trigger";
    detailHtml += `<div class="position-card-row"><span>${predTimeLabel}</span><strong></strong></div>`;
    detailHtml += `<div class="position-card-row"><span>Buy</span><strong>${predBuyValue}</strong></div>`;
    detailHtml += `<div class="position-card-row"><span>Target</span><strong>${fmtPriceCents(targetPrice)}</strong></div>`;
  } else if (status === "sold") {
    detailHtml += `<div class="position-card-row"><span>Sell</span><strong>${valuesPending ? "" : `${card.shares} @ ${fmtPriceCents(card.sellPrice)}`}</strong></div>`;
  } else {
    const outcome = card.outcome === "up" || card.outcome === "down" ? card.outcome : "";
    const outcomeClass = outcome === "up" ? "is-up" : outcome === "down" ? "is-down" : "";
    detailHtml += `<div class="position-card-row"><span>Settlement</span><strong class="position-card-outcome ${outcomeClass}">${valuesPending ? "" : (outcome || "—").toUpperCase()}</strong></div>`;
  }

  if (!isPrediction) {
    if (valuesPending) {
      detailHtml += `<div class="position-card-row"><span>P/L</span><strong class="position-card-pl"></strong></div>`;
    } else {
      const hasPl = card.pl != null && Number.isFinite(card.pl);
      const plClass = hasPl ? (card.pl > 0 ? "is-positive" : card.pl < 0 ? "is-negative" : "") : "";
      detailHtml += `<div class="position-card-row"><span>P/L</span><strong class="position-card-pl ${plClass}">${hasPl ? fmtUsdSigned(card.pl) : ""}</strong></div>`;
    }
  }

  // Provisional win/loss (legacy Chainlink path) keep Waiting until Polymarket confirms.
  const statusLabel = statusWaiting ? "Waiting" : positionStatusLabel(status);
  const sideLabel = isPrediction
    ? `Prediction ${(card.side || "").toUpperCase()}`
    : `Bet ${(card.side || "").toUpperCase()}`;
  const windowRange = formatPositionWindowRange(card);
  const windowBracket = windowRange
    ? `<span class="position-card-window" title="Market window (UTC)">(${escapeHtml(windowRange)})</span>`
    : "";
  const demoPrefix =
    isDemo && !isPrediction
      ? `<span class="position-card-demo-label" title="Trigger Demo">Demo</span>`
      : "";
  const triggerMissLabel =
    !isPrediction && card.triggerMiss === true
      ? `<span class="position-card-trigger-miss-label" title="Buy fill outside the trigger Ask band (or oversized vs Start Shares). Sell / hold still follow the trigger setup.">Trigger Miss</span>`
      : "";
  let statusHtml;
  if (isPrediction && status === "right") {
    statusHtml = `<span class="position-card-status is-icon" title="Right" aria-label="Prediction was right">${PREDICTION_ICON_CHECK}</span>`;
  } else if (isPrediction && status === "wrong") {
    statusHtml = `<span class="position-card-status is-icon" title="Wrong" aria-label="Prediction was wrong">${PREDICTION_ICON_CROSS}</span>`;
  } else {
    statusHtml = `<span class="position-card-status">${statusLabel}</span>`;
  }
  const simLabel =
    isPrediction && card.sim === true && (status === "right" || status === "wrong")
      ? `<span class="position-card-sim-label" title="Simulated (Trade off)">Sim</span>`
      : "";
  const statusBlock =
    simLabel || (isPrediction && (status === "right" || status === "wrong"))
      ? `<span class="position-card-status-wrap">${simLabel}${statusHtml}</span>`
      : statusHtml;
  const triggerTitleInner =
    triggerName || windowBracket
      ? `${triggerName ? escapeHtml(triggerName) : ""}${
          triggerName && windowBracket ? " " : ""
        }${windowBracket}`
      : "";
  const triggerTitleAttr = escapeHtml(
    [triggerName, windowRange ? `UTC ${windowRange}` : ""].filter(Boolean).join(" · "),
  );
  const buyTimeHtml = buyTime
    ? `<span class="position-card-window" title="Buy time (UTC)">(${escapeHtml(buyTime)})</span>`
    : "";
  const buyFillHtml = buyValue
    ? `<strong class="position-card-fill">${escapeHtml(buyValue)}</strong>`
    : "";
  const titleLeftHtml = `<span class="position-card-trigger-name" title="${triggerTitleAttr}">${triggerTitleInner}</span>`;
  const statusRightHtml = `<span class="position-card-status-right">${demoPrefix}${statusBlock}</span>`;
  const betRowHtml = isPrediction
    ? `<div class="position-card-side-wrap">${triggerMissLabel}<span class="position-card-side ${sideClass}">${sideLabel}</span></div>`
    : `<div class="position-card-bet-row">
      <span class="position-card-side-wrap">${triggerMissLabel}<span class="position-card-side ${sideClass}">${sideLabel}</span>${buyTimeHtml}</span>
      ${buyFillHtml}
    </div>`;
  // is-loading → gray pulsing badge (Waiting only). Open keeps accent via .is-open.
  return `<article class="position-card is-${status}${isDemo ? " is-demo" : ""}${isPrediction ? " is-prediction" : ""}${card.triggerMiss === true ? " is-trigger-miss" : ""}${statusWaiting ? " is-loading" : ""}${valuesPending ? " is-values-pending" : ""}" data-position-id="${card.id}">
    <div class="position-card-top">
      ${titleLeftHtml}
      ${statusRightHtml}
    </div>
    ${betRowHtml}
    ${detailHtml}
  </article>`;
}

const DEMO_POSITION_CARDS_KEY = "poly-real:demo-position-cards";
const PREDICTION_POSITION_CARDS_KEY = "poly-prediction-position-cards";
const POSITIONS_HIDDEN_IDS_KEY = "poly-real:positions-hidden-ids";
const POSITIONS_FILTER_KEY = "poly-real:positions-filter";
const APP_PAGE_KEY = "poly-real:app-page";
const SCHEDULE_VIEW_KEY = "poly-real:schedule-view";

/** @type {"demo" | "trade" | "all"} */
let positionsFilter = "all";

let demoPositionCards = [];
/** @type {Array<Record<string, unknown>>} */
let predictionPositionCards = [];
/** Card ids hidden by Positions → Clear (session). New fills get new ids and still show. */
let positionsHiddenIds = new Set();
let lastPositionsFingerprint = "";
let lastDemoLastWindowKey = null;

function loadPositionsHiddenIds() {
  try {
    const raw = sessionStorage.getItem(POSITIONS_HIDDEN_IDS_KEY);
    if (!raw) {
      positionsHiddenIds = new Set();
      return;
    }
    const parsed = JSON.parse(raw);
    positionsHiddenIds = new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    positionsHiddenIds = new Set();
  }
}

function persistPositionsHiddenIds() {
  try {
    sessionStorage.setItem(
      POSITIONS_HIDDEN_IDS_KEY,
      JSON.stringify([...positionsHiddenIds].slice(-500)),
    );
  } catch {
    // ignore
  }
}

function isPositionCardHidden(card) {
  const id = card?.id != null ? String(card.id) : "";
  return Boolean(id && positionsHiddenIds.has(id));
}

function predictionPositionCardsStorageKey(series = selectedSeries) {
  return userScopedStorageKey(
    `${PREDICTION_POSITION_CARDS_KEY}:${series || "btc-5m"}`,
  );
}

function predictionCardId(series, windowStart, triggerId = null) {
  const key = triggerId || windowStart;
  return `prediction:${series || "btc-5m"}:${key}`;
}

function persistPredictionPositionCards() {
  try {
    localStorage.setItem(
      predictionPositionCardsStorageKey(),
      JSON.stringify(predictionPositionCards.slice(0, MAX_POSITION_CARDS)),
    );
  } catch {
    // ignore quota / private mode
  }
}

function loadPredictionPositionCards(series = selectedSeries) {
  try {
    const raw = localStorage.getItem(predictionPositionCardsStorageKey(series));
    if (!raw) {
      predictionPositionCards = [];
      return;
    }
    const parsed = JSON.parse(raw);
    predictionPositionCards = Array.isArray(parsed)
      ? parsed
          .filter((c) => c && typeof c === "object" && c.id && (c.side === "up" || c.side === "down"))
          .map((c) => ({
            ...c,
            kind: "prediction",
            series: c.series || series,
            status:
              c.status === "right" || c.status === "wrong" || c.status === "open"
                ? c.status
                : "open",
            confirmed: c.status === "right" || c.status === "wrong",
          }))
          .slice(0, MAX_POSITION_CARDS)
      : [];
  } catch {
    predictionPositionCards = [];
  }
}

function refreshPositionsForPrediction() {
  lastPositionsFingerprint = "";
  updatePositionsPanel(windowState);
}

function upsertPredictionPositionCard(card, { refresh = true } = {}) {
  if (!card?.id) return;
  const next = {
    ...card,
    kind: "prediction",
    series: card.series || selectedSeries,
  };
  const idx = predictionPositionCards.findIndex((c) => c.id === next.id);
  if (idx >= 0) {
    predictionPositionCards[idx] = { ...predictionPositionCards[idx], ...next };
  } else {
    predictionPositionCards.unshift(next);
  }
  if (predictionPositionCards.length > MAX_POSITION_CARDS) {
    predictionPositionCards.length = MAX_POSITION_CARDS;
  }
  persistPredictionPositionCards();
  if (refresh) refreshPositionsForPrediction();
}

function ensurePredictionPositionCard(
  {
    side,
    windowStart,
    windowEnd,
    slug,
    buyAt,
    triggerId,
    sim,
    triggerBuy,
    riseCents,
    buyPrice,
    shares,
  },
  { refresh = true } = {},
) {
  if (side !== "up" && side !== "down") return null;
  if (windowStart == null || !Number.isFinite(windowStart)) return null;
  const series = selectedSeries || "btc-5m";
  const id = predictionCardId(series, windowStart, triggerId);
  const existing = predictionPositionCards.find((c) => c.id === id);
  if (existing && (existing.status === "right" || existing.status === "wrong")) {
    return existing;
  }
  const simMode =
    typeof sim === "boolean"
      ? sim
      : existing && typeof existing.sim === "boolean"
        ? Boolean(existing.sim)
        : !isPredictionTradeArmed();
  const nextTriggerBuy =
    triggerBuy != null && Number.isFinite(Number(triggerBuy))
      ? Number(triggerBuy)
      : existing?.triggerBuy != null && Number.isFinite(Number(existing.triggerBuy))
        ? Number(existing.triggerBuy)
        : null;
  const nextRiseCents = normalizePredictionRiseCents(
    riseCents ?? existing?.riseCents ?? manipDetectorRuntime?.predictionRiseCents,
  );
  const nextBuyPrice =
    buyPrice != null && Number.isFinite(Number(buyPrice))
      ? Number(buyPrice)
      : existing?.buyPrice != null && Number.isFinite(Number(existing.buyPrice))
        ? Number(existing.buyPrice)
        : null;
  const nextTarget = predictionTargetPrice(nextBuyPrice ?? nextTriggerBuy, nextRiseCents);
  const nextShares =
    shares != null && Number.isFinite(Number(shares))
      ? Number(shares)
      : existing?.shares != null && Number.isFinite(Number(existing.shares))
        ? Number(existing.shares)
        : null;
  upsertPredictionPositionCard(
    {
      id,
      windowKey: `${series}:${windowStart}`,
      series,
      side,
      triggerId: triggerId || existing?.triggerId || null,
      buyAt:
        buyAt != null && Number.isFinite(buyAt)
          ? buyAt
          : existing?.buyAt != null && Number.isFinite(existing.buyAt)
            ? existing.buyAt
            : Date.now() / 1000,
      status: "open",
      confirmed: false,
      sim: simMode,
      slug: typeof slug === "string" && slug.trim() ? slug.trim() : existing?.slug || null,
      windowEnd:
        windowEnd != null && Number.isFinite(windowEnd)
          ? windowEnd
          : existing?.windowEnd ?? null,
      triggerBuy: nextTriggerBuy,
      riseCents: nextRiseCents,
      targetPrice: nextTarget,
      buyPrice: nextBuyPrice,
      shares: nextShares,
    },
    { refresh },
  );
  return predictionPositionCards.find((c) => c.id === id) || null;
}

function settlePredictionPositionCard(side, windowStart, right, triggerId = null) {
  if (windowStart == null || !Number.isFinite(windowStart)) return false;
  if (typeof right !== "boolean") return false;
  const series = selectedSeries || "btc-5m";
  const id = predictionCardId(series, windowStart, triggerId);
  let card = predictionPositionCards.find((c) => c.id === id);
  if (!card && triggerId) {
    // Prefer the open card for this window when trigger id is missing on older cards.
    card = predictionPositionCards.find(
      (c) =>
        c.windowKey === `${series}:${windowStart}` &&
        c.status === "open" &&
        (c.side === side || side == null),
    );
  }
  if (!card) {
    ensurePredictionPositionCard({ side, windowStart, triggerId }, { refresh: false });
    card = predictionPositionCards.find((c) => c.id === id);
  }
  if (!card) return false;
  if (card.status === "right" || card.status === "wrong") return false;
  upsertPredictionPositionCard({
    ...card,
    side: side === "up" || side === "down" ? side : card.side,
    status: right ? "right" : "wrong",
    confirmed: true,
  });
  return true;
}

function syncPredictionCardsFromRuntime() {
  const side = manipDetectorRuntime.predictionSide;
  const windowStart = manipDetectorRuntime.predictionWindowStart;
  if (
    (side === "up" || side === "down") &&
    windowStart != null &&
    Number.isFinite(windowStart) &&
    (manipDetectorRuntime.uiPhase === "active" || manipDetectorRuntime.uiPhase === "pending")
  ) {
    ensurePredictionPositionCard(
      {
        side,
        windowStart,
        windowEnd: manipDetectorRuntime.predictionWindowEnd,
        slug: manipDetectorRuntime.predictionSlug,
        triggerId: manipDetectorRuntime.predictionTriggerId,
        triggerBuy: manipDetectorRuntime.predictionTriggerBuy,
        riseCents: manipDetectorRuntime.predictionRiseCents,
      },
      { refresh: false },
    );
  }
  for (const job of manipDetectorRuntime.backgroundResolutions) {
    if (!job || (job.side !== "up" && job.side !== "down")) continue;
    if (job.windowStart == null || !Number.isFinite(job.windowStart)) continue;
    const basis = Number.isFinite(job.profitBasis) ? job.profitBasis : job.triggerSideBuy;
    ensurePredictionPositionCard(
      {
        side: job.side,
        windowStart: job.windowStart,
        slug: job.slug,
        triggerId: job.triggerId,
        triggerBuy: job.triggerSideBuy,
        riseCents: job.riseCents,
        ...(job.traded && Number.isFinite(basis) ? { buyPrice: basis } : {}),
        ...(typeof job.traded === "boolean" ? { sim: !job.traded } : {}),
      },
      { refresh: false },
    );
  }
  refreshPositionsForPrediction();
}

function loadAppPagePref() {
  try {
    const saved = localStorage.getItem(APP_PAGE_KEY);
    if (saved === "simulator" || saved === "schedule" || saved === "settings") return saved;
  } catch {
    // ignore
  }
  return "simulator";
}

function saveAppPagePref(page) {
  try {
    if (page === "simulator" || page === "schedule" || page === "settings") {
      localStorage.setItem(APP_PAGE_KEY, page);
    }
  } catch {
    // ignore
  }
}

function loadScheduleViewPref() {
  try {
    const saved = localStorage.getItem(SCHEDULE_VIEW_KEY);
    if (saved === "schedule" || saved === "heatmap") return saved;
  } catch {
    // ignore
  }
  return "schedule";
}

function saveScheduleViewPref(view) {
  try {
    if (view === "schedule" || view === "heatmap") {
      localStorage.setItem(SCHEDULE_VIEW_KEY, view);
    }
  } catch {
    // ignore
  }
}

function loadDemoPositionCards() {
  try {
    const raw =
      localStorage.getItem(userScopedStorageKey(DEMO_POSITION_CARDS_KEY)) ||
      localStorage.getItem(DEMO_POSITION_CARDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistDemoPositionCards() {
  try {
    localStorage.setItem(
      userScopedStorageKey(DEMO_POSITION_CARDS_KEY),
      JSON.stringify(demoPositionCards.slice(0, MAX_POSITION_CARDS)),
    );
  } catch {
    // ignore
  }
}

function clearDemoPositionCards() {
  demoPositionCards = [];
  lastDemoLastWindowKey = null;
  try {
    localStorage.removeItem(userScopedStorageKey(DEMO_POSITION_CARDS_KEY));
    localStorage.removeItem(DEMO_POSITION_CARDS_KEY);
  } catch {
    // ignore
  }
  lastPositionsFingerprint = "";
  updatePositionsPanel(windowState);
}

window.clearDemoPositionCards = clearDemoPositionCards;

/** Clear all Positions cards (live + demo). Prediction cards are not shown. */
function clearAllPositionCards() {
  const live = Array.isArray(windowState?.trading?.positionCards)
    ? windowState.trading.positionCards
    : [];
  for (const card of live) {
    if (card?.id != null) positionsHiddenIds.add(String(card.id));
  }
  for (const card of demoPositionCards) {
    if (card?.id != null) positionsHiddenIds.add(String(card.id));
  }
  persistPositionsHiddenIds();
  clearDemoPositionCards();
  // Also wipe Prediction card store (no longer shown in Positions).
  predictionPositionCards = [];
  try {
    localStorage.removeItem(predictionPositionCardsStorageKey());
  } catch {
    // ignore
  }
  lastPositionsFingerprint = "";
  updatePositionsPanel(windowState);
}

function demoCardId(windowKey, side) {
  return `demo:${windowKey}:${side}`;
}

function triggerDemoPositionCardId(triggerId, windowStart, side) {
  return `demo:trigger:${triggerId}:${windowStart}:${side}`;
}

/** Open Demo Positions card for this trigger + side (status open only). */
function findOpenTriggerDemoPositionCard(triggerId, side) {
  const tid = String(triggerId || "");
  if (!tid || (side !== "up" && side !== "down")) return null;
  return (
    demoPositionCards.find(
      (c) =>
        c &&
        (c.demo === true || String(c.id || "").startsWith("demo:")) &&
        c.source === "trigger" &&
        String(c.triggerId || "") === tid &&
        c.side === side &&
        (c.status || "open") === "open",
    ) || null
  );
}

/**
 * Entry-window start for Demo settle — never the live rolled window.
 * Prefer opts / runtime / open card; only then fall back to current state.
 */
function resolveTriggerDemoSettleWindowStart(triggerId, rt, side, opts = {}) {
  const fromOpts = Number(opts.windowStart);
  if (Number.isFinite(fromOpts) && fromOpts > 0) return fromOpts;
  const fromRt = Number(rt?.windowStart);
  if (Number.isFinite(fromRt) && fromRt > 0) return fromRt;
  const open = findOpenTriggerDemoPositionCard(triggerId, side);
  if (open) {
    const fromCard = positionWindowStartSec(open);
    if (Number.isFinite(fromCard) && fromCard > 0) return fromCard;
  }
  const fromState = Number(windowState?.windowStart);
  if (Number.isFinite(fromState) && fromState > 0) return fromState;
  return NaN;
}

/** Mirror a Trigger Demo open into Positions (same card shape as live, Demo label). */
function upsertTriggerDemoPositionOpen(trigger, rt, state, side) {
  if (!trigger?.id || rt?.runMode === "trade") return;
  const windowStart = Number(rt?.windowStart ?? state?.windowStart);
  if (!Number.isFinite(windowStart) || windowStart <= 0) return;
  const shares = Number(rt.entryShares) || normalizeTriggerBuyShares(trigger.buyShares);
  const buyPrice = Number(rt.entryPrice);
  if (!Number.isFinite(buyPrice)) return;
  const series = state?.series || selectedSeries;
  const id = triggerDemoPositionCardId(trigger.id, windowStart, side);
  // Cleared cards stay hidden; new id each window/side so later hits still show.
  positionsHiddenIds.delete(id);
  const slug =
    (typeof rt.entrySlug === "string" && rt.entrySlug.trim()) ||
    (typeof state?.slug === "string" && state.slug.trim()) ||
    "";
  // Explicitly clear settle fields so a prior wrong-id merge cannot leave Market/P/L on Open.
  upsertDemoPositionCard({
    id,
    windowKey: `${series}:${windowStart}`,
    series,
    slug: slug || undefined,
    side,
    shares,
    buyPrice,
    buyCost: shares * buyPrice,
    buyFees: 0,
    buyAt: Math.floor(Date.now() / 1000),
    status: "open",
    sellPrice: undefined,
    sellProceeds: undefined,
    sellFees: undefined,
    soldAt: undefined,
    outcome: undefined,
    pl: undefined,
    confirmed: true,
    demo: true,
    source: "trigger",
    triggerId: String(trigger.id),
    triggerName: String(trigger.name || "").trim() || "Untitled",
    triggerMiss: rt.triggerMiss === true,
  });
  lastPositionsFingerprint = "";
  updatePositionsPanel(windowState || state);
}

function upsertTriggerDemoPositionSettle(trigger, rt, exitPrice, reason, opts = {}) {
  if (!trigger?.id || rt?.runMode === "trade") return;
  const side = rt.side === "down" ? "down" : rt.side === "up" ? "up" : null;
  if (!side) return;
  const windowStart = resolveTriggerDemoSettleWindowStart(trigger.id, rt, side, opts);
  if (!Number.isFinite(windowStart) || windowStart <= 0) return;
  const shares = Number(rt.entryShares) || normalizeTriggerBuyShares(trigger.buyShares);
  const buyPrice = Number(rt.entryPrice);
  const exit = Number(exitPrice);
  if (!Number.isFinite(buyPrice) || !Number.isFinite(exit)) return;
  const series =
    (typeof opts.series === "string" && opts.series.trim()) ||
    windowState?.series ||
    selectedSeries;
  let settleWindowStart = windowStart;
  let id = triggerDemoPositionCardId(trigger.id, settleWindowStart, side);
  let existing = demoPositionCards.find((c) => c.id === id) || null;
  // Prefer the live open Demo card if ids drifted (entry window vs rolled window).
  const openExisting = findOpenTriggerDemoPositionCard(trigger.id, side);
  if (openExisting && (!existing || existing.id !== openExisting.id)) {
    existing = openExisting;
    id = String(openExisting.id);
    const fromOpen = positionWindowStartSec(openExisting);
    if (Number.isFinite(fromOpen) && fromOpen > 0) settleWindowStart = fromOpen;
  }
  const buyAt =
    existing?.buyAt != null && Number.isFinite(Number(existing.buyAt))
      ? Number(existing.buyAt)
      : Math.floor(Date.now() / 1000);
  const pnlUsd = (exit - buyPrice) * shares;
  let status = "sold";
  let outcome;
  if (reason === "window-end") {
    status = opts.heldWon === true ? "win" : "loss";
    // Official Gamma Up/Down (same /api/window-resolution as live Trade cards).
    if (opts.officialOutcome === "up" || opts.officialOutcome === "down") {
      outcome = opts.officialOutcome;
    } else {
      outcome = opts.heldWon === true ? side : side === "up" ? "down" : "up";
    }
  }
  const slug =
    (typeof opts.slug === "string" && opts.slug.trim()) ||
    (typeof rt.entrySlug === "string" && rt.entrySlug.trim()) ||
    (typeof existing?.slug === "string" && existing.slug.trim()) ||
    "";
  upsertDemoPositionCard({
    id,
    windowKey: `${series}:${settleWindowStart}`,
    series,
    slug: slug || undefined,
    side,
    shares,
    buyPrice,
    buyCost: shares * buyPrice,
    buyFees: 0,
    buyAt,
    status,
    sellPrice: exit,
    sellProceeds: shares * exit,
    sellFees: 0,
    soldAt: Math.floor(Date.now() / 1000),
    outcome,
    pl: pnlUsd,
    confirmed: true,
    demo: true,
    source: "trigger",
    triggerId: String(trigger.id),
    triggerName:
      (typeof opts.triggerName === "string" && opts.triggerName.trim()) ||
      (typeof existing?.triggerName === "string" && existing.triggerName.trim()) ||
      String(trigger.name || "").trim() ||
      "Untitled",
    triggerMiss:
      existing?.triggerMiss === true || rt.triggerMiss === true || opts.triggerMiss === true,
  });
  lastPositionsFingerprint = "";
  updatePositionsPanel(windowState);
}

function shouldUpdateDemoPositionCards(trading) {
  const cfg = trading?.config;
  return Boolean(cfg?.autoTrade && !cfg.startTrading);
}

function upsertDemoPositionCard(card) {
  if (!card?.id) return;
  const idx = demoPositionCards.findIndex((c) => c.id === card.id);
  // Open cards replace fully so stale Market/P/L from a bad merge cannot linger.
  const next =
    card.status === "open"
      ? { ...card, demo: true }
      : idx >= 0
        ? { ...demoPositionCards[idx], ...card, demo: true }
        : { ...card, demo: true };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  if (idx >= 0) demoPositionCards[idx] = next;
  else demoPositionCards.unshift(next);
  if (demoPositionCards.length > MAX_POSITION_CARDS) demoPositionCards.length = MAX_POSITION_CARDS;
  persistDemoPositionCards();
}

function syncDemoCardsFromMarkers(trading, state) {
  if (!shouldUpdateDemoPositionCards(trading)) return;
  const markers = Array.isArray(trading?.markers) ? trading.markers : [];
  const buys = markers.filter((m) => m.type === "buy");
  if (buys.length === 0) return;

  for (const buy of buys) {
    const windowKey = buy.windowKey || `${state?.series || ""}:${state?.windowStart || ""}`;
    if (!windowKey || !buy.side) continue;
    const id = demoCardId(windowKey, buy.side);
    const existing = demoPositionCards.find((c) => c.id === id);
    if (existing && existing.status !== "open") continue;

    const sell = markers.find((m) => m.type === "sell" && m.side === buy.side);
    if (sell) {
      upsertDemoPositionCard({
        id,
        windowKey,
        series: state?.series,
        side: buy.side,
        shares: sell.shares ?? buy.shares,
        buyPrice: buy.price,
        buyCost: buy.cost ?? (buy.shares || 0) * (buy.price || 0),
        buyFees: buy.fees ?? 0,
        buyAt: buy.t,
        status: "sold",
        sellPrice: sell.price,
        sellProceeds: sell.proceeds ?? (sell.shares || 0) * (sell.price || 0),
        sellFees: sell.fees ?? 0,
        soldAt: sell.t,
        pl: sell.profit ?? null,
        confirmed: true,
        demo: true,
      });
    } else {
      upsertDemoPositionCard({
        id,
        windowKey,
        series: state?.series,
        side: buy.side,
        shares: buy.shares,
        buyPrice: buy.price,
        buyCost: buy.cost ?? (buy.shares || 0) * (buy.price || 0),
        buyFees: buy.fees ?? 0,
        buyAt: buy.t,
        status: "open",
        confirmed: true,
        demo: true,
      });
    }
  }
}

function syncDemoCardsFromLastWindow(lastWindow) {
  if (!lastWindow?.windowKey || lastWindow.plLabel === "No trade") return;
  if (!lastWindow.side) return;
  if (lastDemoLastWindowKey === lastWindow.windowKey) {
    // Still refresh fields if card exists (P/L corrections)
  }
  lastDemoLastWindowKey = lastWindow.windowKey;

  const id = demoCardId(lastWindow.windowKey, lastWindow.side);
  let status = "sold";
  if (!lastWindow.sold) {
    status = lastWindow.positionWon === true ? "win" : "loss";
  }

  upsertDemoPositionCard({
    id,
    windowKey: lastWindow.windowKey,
    series: String(lastWindow.windowKey).split(":")[0],
    side: lastWindow.side,
    shares: lastWindow.shares,
    buyPrice: lastWindow.buyPrice,
    buyCost: lastWindow.buyCost,
    buyFees: lastWindow.buyFees ?? 0,
    buyAt: lastWindow.windowStart,
    status,
    sellPrice: lastWindow.sellPrice,
    sellProceeds: lastWindow.sellProceeds,
    soldAt: lastWindow.sold ? lastWindow.windowEnd : undefined,
    outcome: lastWindow.outcome,
    pl: lastWindow.pl,
    confirmed: true,
    demo: true,
  });
}

function ingestDemoPositionCards(_state) {
  // Demo Positions come from the server trading engine (SSE). No local ingest.
}

function positionsFingerprint(cards) {
  const mode = normalizePositionsFilter(positionsFilter);
  if (!Array.isArray(cards) || cards.length === 0) return `positions:${mode}:`;
  return (
    `positions:${mode}:` +
    cards
      .map(
        (c) =>
          `${c.id}:${c.status}:${c.shares ?? ""}:${c.buyPrice ?? ""}:${c.buyCost ?? ""}:${c.sellPrice ?? ""}:${c.pl ?? ""}:${c.outcome ?? ""}:${c.confirmed ? 1 : 0}:${c.demo ? 1 : 0}:${c.triggerMiss ? 1 : 0}:${c.triggerName ?? ""}:${c.triggerId ?? ""}`,
      )
      .join("|")
  );
}

function normalizePositionsFilter(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "demo" || v === "trade") return v;
  return "all";
}

function loadPositionsFilter() {
  try {
    positionsFilter = normalizePositionsFilter(localStorage.getItem(POSITIONS_FILTER_KEY));
  } catch {
    positionsFilter = "all";
  }
  return positionsFilter;
}

function persistPositionsFilter() {
  try {
    localStorage.setItem(POSITIONS_FILTER_KEY, positionsFilter);
  } catch {
    // ignore
  }
}

function isDemoPositionCard(card) {
  return Boolean(card && (card.demo === true || String(card.id || "").startsWith("demo:")));
}

/** Apply header Demo / Trade / All filter. */
function filterPositionsCards(cards) {
  const list = Array.isArray(cards) ? cards : [];
  const mode = normalizePositionsFilter(positionsFilter);
  if (mode === "demo") return list.filter(isDemoPositionCard);
  if (mode === "trade") return list.filter((c) => !isDemoPositionCard(c));
  return list;
}

/** Merge server Positions cards (Trade + Demo). Newest buyAt first. */
function mergePositionsCards(liveCards, series) {
  // Server is source of truth for Demo and Trade; browser does not own Demo cards.
  const live = (Array.isArray(liveCards) ? liveCards : [])
    .filter((c) => c && (!c.series || c.series === series) && !isPositionCardHidden(c))
    .map((c) => ({
      ...c,
      demo: c.demo === true || String(c.id || "").startsWith("demo:"),
    }));
  return filterPositionsCards(
    [...live].sort((a, b) => {
      const ta = Number(a?.buyAt);
      const tb = Number(b?.buyAt);
      const aOk = Number.isFinite(ta);
      const bOk = Number.isFinite(tb);
      if (aOk && bOk && tb !== ta) return tb - ta;
      if (aOk !== bOk) return aOk ? -1 : 1;
      return 0;
    }),
  ).slice(0, MAX_POSITION_CARDS);
}

function syncPositionsScrollable() {
  const body = $("positions-list") || document.querySelector(".positions-body");
  if (!body) return;
  const height = parseFloat(getComputedStyle(body).flexBasis) || body.clientHeight;
  const hasCards = Boolean(body.querySelector(".position-card"));
  body.classList.toggle("is-scrollable", height > 0 && hasCards);
}

/** Reflect server Demo open cards on Trigger BUY cells; clear when not open. */
function syncTriggerDemoLiveUiFromServer(state) {
  if (!Array.isArray(userTriggers)) return;
  const cards = state?.trading?.positionCards;
  const openByTrigger = new Map();
  if (Array.isArray(cards)) {
    for (const c of cards) {
      if (!isDemoPositionCard(c)) continue;
      if (String(c.status || "open").toLowerCase() !== "open") continue;
      const tid = c.triggerId != null ? String(c.triggerId) : "";
      if (!tid) continue;
      openByTrigger.set(tid, c);
    }
  }
  for (const t of userTriggers) {
    if (t?.runMode === "trade") continue;
    const id = String(t?.id || "");
    if (!id) continue;
    const open = openByTrigger.get(id);
    if (open) {
      setTriggerCardLiveUi(id, {
        side: open.side === "down" ? "down" : "up",
        leg: "buy",
        price: open.buyPrice,
        shares: open.shares,
      });
    } else {
      const rt = triggerRuntimeById.get(id);
      if (rt?.liveUi) setTriggerCardLiveUi(id, null);
    }
  }
}

function refreshTradeTriggerStatsFromPositions(state) {
  const cards = state?.trading?.positionCards;
  if (!Array.isArray(cards) || !Array.isArray(userTriggers)) return;
  const ids = new Set();
  for (const card of cards) {
    if (!card || card.source !== "trigger" || card.status === "open") continue;
    const tid = typeof card.triggerId === "string" ? card.triggerId.trim() : "";
    if (tid) ids.add(tid);
  }
  for (const id of ids) {
    void fetchTriggerLiveStats(id).then(() => {
      updateTriggerCardStats(id);
      window.ScheduleLiveTriggers?.updateStats?.(id);
    });
  }
}

function setPositionsLoading(isLoading) {
  const loading = $("positions-loading");
  const list = $("positions-cards");
  const empty = $("positions-empty");
  if (loading) loading.hidden = !isLoading;
  if (isLoading) {
    if (list) list.innerHTML = "";
    if (empty) empty.hidden = true;
  }
}

function updatePositionsPanel(state) {
  const list = $("positions-cards");
  const empty = $("positions-empty");
  if (!list || !empty) return;

  const trading = state?.trading;
  // Wait for Mongo-hydrated live cards so the list does not jump (demo-only → full).
  // Explicit false = still hydrating; missing flag (older payloads) does not block.
  if (state == null || (trading != null && trading.positionCardsReady === false)) {
    lastPositionsFingerprint = "";
    setPositionsLoading(true);
    syncPositionsScrollable();
    return;
  }

  setPositionsLoading(false);

  // Signed-out / no trading engine: show empty (not a spinner).
  if (trading == null) {
    const fingerprint = "positions:none";
    if (fingerprint === lastPositionsFingerprint) return;
    lastPositionsFingerprint = fingerprint;
    list.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "No positions yet";
    syncPositionsScrollable();
    return;
  }

  ingestDemoPositionCards(state);

  const series = selectedSeries;
  const cards = mergePositionsCards(trading.positionCards, series);

  const fingerprint = positionsFingerprint(cards);
  if (fingerprint === lastPositionsFingerprint) {
    syncTriggerDemoLiveUiFromServer(state);
    return;
  }
  lastPositionsFingerprint = fingerprint;
  refreshTradeTriggerStatsFromPositions(state);
  syncTriggerDemoLiveUiFromServer(state);
  // Demo stats are credited on the server — refresh Trigger card totals when Demo cards change.
  if (cards.some(isDemoPositionCard)) {
    void loadUserTriggers().then(() => {
      for (const t of userTriggers || []) updateTriggerCardStats(String(t?.id || ""));
    });
  }

  if (cards.length === 0) {
    list.innerHTML = "";
    empty.hidden = false;
    const mode = normalizePositionsFilter(positionsFilter);
    empty.textContent =
      mode === "demo"
        ? "No demo positions"
        : mode === "trade"
          ? "No trade positions"
          : "No positions yet";
    syncPositionsScrollable();
    return;
  }

  empty.hidden = true;
  list.innerHTML = cards.map(renderPositionCard).join("");
  syncPositionsScrollable();
}

function bindPositionsFilter() {
  const sel = $("positions-filter");
  if (!sel || sel.dataset.bound === "1") return;
  sel.dataset.bound = "1";
  loadPositionsFilter();
  sel.value = positionsFilter;
  sel.addEventListener("change", () => {
    positionsFilter = normalizePositionsFilter(sel.value);
    persistPositionsFilter();
    lastPositionsFingerprint = "";
    updatePositionsPanel(windowState);
  });
}

function syncGraphSaveBtn(state = windowState) {
  const btn = $("graph-save-btn");
  if (!btn) return;
  const visible = Boolean(state?.trading?.phasesEditable);
  btn.hidden = !visible;
  btn.setAttribute("aria-hidden", visible ? "false" : "true");
}

function updateWindowUI(state) {
  const prevWindowStart = windowState?.windowStart;
  windowState = state;
  window.windowState = state;

  if (
    state?.windowStart != null &&
    Number.isFinite(state.windowStart) &&
    state.windowStart !== prevWindowStart
  ) {
    onLogWindowChanged(state.windowStart);
    // Past-window open Demo cards: keep trying Gamma settle across rolls / sessions.
    scanAndResumeStuckDemoOpenCards();
  }

  if (pendingChainlinkTicks.length > 0) {
    const queued = pendingChainlinkTicks;
    pendingChainlinkTicks = [];
    for (const tick of queued) appendChainlinkTick(tick, false);
  }

  if (window.Simulator) window.Simulator.syncFromState(state);

  syncLatencyDisplay(state);
  syncFillSuccessDisplay(state?.trading);
  syncGraphSaveBtn(state);
  updatePositionsPanel(state);
  updateQuoteBoxes(state);
  updateBookPanel(state);
  updateCountdown(state);
  updateGraphPanel(state);
  syncManipulationAreaUi();
  tickManipulationDetector(state);
  // Buy GTD: arm rests at Apply/window start by wall clock (do not wait for next tick).
  scheduleTriggerGtdArming(state);

  if (state?.trading && !isReplayWorkspace() && window.SchedulePlacements?.applyLivePlacementStats) {
    window.SchedulePlacements.applyLivePlacementStats(
      state.trading.placementStats,
      state.trading.sessionTotals,
      state.trading.demoLastWindow,
      state.trading,
    );
  }
}

function selectedAsset() {
  return String(selectedSeries || "").split("-")[0].toLowerCase();
}

function appendChainlinkTick(tick, redraw = true) {
  if (!tick || tick.asset !== selectedAsset()) return;

  const price = Number(tick.price);
  const timestampMs = Number(tick.timestampMs);
  if (!Number.isFinite(price) || !Number.isFinite(timestampMs)) return;

  if (!windowState?.windowStart || !windowState?.windowEnd) {
    pendingChainlinkTicks.push(tick);
    pendingChainlinkTicks = pendingChainlinkTicks.slice(-100);
    return;
  }

  const t = timestampMs / 1000;
  if (t < windowState.windowStart || t >= windowState.windowEnd) {
    // Keep boundary ticks briefly until the next full snapshot switches the UI
    // to the new market window.
    if (t >= windowState.windowEnd) {
      pendingChainlinkTicks.push(tick);
      pendingChainlinkTicks = pendingChainlinkTicks.slice(-100);
    }
    return;
  }

  const history = Array.isArray(windowState.priceHistory)
    ? windowState.priceHistory
    : (windowState.priceHistory = []);
  const last = history[history.length - 1];
  if (!last || last.t !== t || last.price !== price) {
    history.push({ t, price });
    if (history.length > 2000) history.splice(0, history.length - 2000);
  }

  windowState.assetPrice = price;
  windowState.lastTickMs = timestampMs;
  if (Number.isFinite(windowState.prevCloseAsset)) {
    windowState.assetGap = price - windowState.prevCloseAsset;
  }
  window.windowState = windowState;

  tickManipulationDetector(windowState);

  if (!redraw || chainlinkChartFrame != null) return;
  chainlinkChartFrame = requestAnimationFrame(() => {
    chainlinkChartFrame = null;
    if (windowState) updateGraphPanel(windowState);
  });
}

/** Tick-live quote fields for clickable up/down buttons — merge without redrawing the full chart. */
function applyQuotesUpdate(quotes) {
  if (!quotes) return;
  if (quotes.series && selectedSeries && quotes.series !== selectedSeries) return;

  if (!windowState) {
    windowState = { priceHistory: [], ...(quotes || {}) };
  } else {
    Object.assign(windowState, quotes);
  }
  window.windowState = windowState;

  updateQuoteBoxes(windowState);
  updateBookPanel(windowState);
  syncLatencyDisplay(windowState);
  if (quotes.windowEnd != null) updateCountdown(windowState);
  tickManipulationDetector(windowState);
}

function syncLatencyDisplay(state) {
  const ms = state?.feedLatencyMs;
  const settingsEl = $("feed-latency-ms");
  if (settingsEl) {
    settingsEl.textContent = Number.isFinite(ms) ? String(Math.round(ms)) : "—";
  }
}

function formatFillSuccessPct(rate) {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return "—";
  return `${rate % 1 === 0 ? String(rate) : rate.toFixed(1)}%`;
}

function formatFillSuccessKind(kind) {
  if (!kind || !(kind.attempts > 0)) return "—";
  const pct = formatFillSuccessPct(kind.ratePct);
  return `${kind.successes}/${kind.attempts} · ${pct}`;
}

function syncFillSuccessDisplay(trading) {
  const el = $("trade-fill-success");
  if (!el) return;
  const fs = trading?.fillSuccess;
  const rate = fs?.ratePct;
  const attempts = fs?.attempts;
  const byKind = fs?.byKind;
  if (typeof rate === "number" && Number.isFinite(rate)) {
    el.textContent = formatFillSuccessPct(rate);
    el.title =
      attempts > 0
        ? `${fs.successes}/${attempts} countable orders matched any size (last 7 days). GTD: only when limit was touched while live.`
        : "Share of countable buy/sell orders that matched any size in the last 7 days";
  } else {
    el.textContent = "—";
    el.title =
      "No countable fill attempts in the last 7 days (GTD needs a touched limit; FAK/FOK count on fire)";
  }

  const breakdown = $("trade-fill-success-breakdown");
  const fakEl = $("trade-fill-success-fak");
  const fokEl = $("trade-fill-success-fok");
  const gtdEl = $("trade-fill-success-gtd");
  if (fakEl) fakEl.textContent = formatFillSuccessKind(byKind?.FAK);
  if (fokEl) fokEl.textContent = formatFillSuccessKind(byKind?.FOK);
  if (gtdEl) gtdEl.textContent = formatFillSuccessKind(byKind?.GTD);
  if (breakdown) {
    const hasAny =
      (byKind?.FAK?.attempts ?? 0) +
        (byKind?.FOK?.attempts ?? 0) +
        (byKind?.GTD?.attempts ?? 0) >
      0;
    breakdown.hidden = !hasAny;
  }

  window.__liveFillSuccessPct =
    typeof rate === "number" && Number.isFinite(rate) ? rate : null;
  window.SchedulePlacements?.syncReplayInputsFromLive?.();
}

function updateCountdown(state) {
  if (!state?.windowEnd) return;
  const remaining = Math.max(0, state.windowEnd - Math.floor(Date.now() / 1000));
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  $("countdown").textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatMarketSelectLabel(label) {
  // Dropdown: "5 minutes" → "5 Min".
  return String(label ?? "").replace(/\bminutes?\b/gi, "Min");
}

function populateMarketSelect() {
  const sel = $("market-select");
  sel.innerHTML = "";
  if (!Array.isArray(markets) || markets.length === 0) {
    selectedSeries = "";
    return;
  }
  if (!markets.some((m) => m._id === selectedSeries)) {
    selectedSeries = markets[0]._id;
  }
  for (const m of markets) {
    const opt = document.createElement("option");
    opt.value = m._id;
    opt.textContent = formatMarketSelectLabel(m.label);
    if (m._id === selectedSeries) opt.selected = true;
    sel.appendChild(opt);
  }
}

/** On mobile, move Wallet status/balance into the app header (right of Poly Replay). */
function syncMobileWalletPlacement() {
  const walletHeader = document.querySelector(".wallet-panel-header");
  const walletPanel = document.querySelector(".wallet-panel");
  const appHeader = document.querySelector(".app-header");
  const title = appHeader?.querySelector(".app-title");
  if (!walletHeader || !walletPanel || !appHeader || !title) return;

  const showInHeader = isMarketMobileStack();
  const wasInHeader = walletHeader.parentElement === appHeader;
  appHeader.classList.toggle("is-mobile-wallet", showInHeader);

  if (showInHeader) {
    if (!wasInHeader) {
      title.after(walletHeader);
      walletPanel.classList.add("is-header-relocated");
      leftColumnLayout?.reflowHeights?.();
    }
    syncMobileWalletBalanceDisplay();
    return;
  }

  if (wasInHeader) {
    walletPanel.insertBefore(walletHeader, walletPanel.firstChild);
    walletPanel.classList.remove("is-header-relocated");
    appHeader.classList.remove("is-wallet-refreshing");
    leftColumnLayout?.reflowHeights?.();
  }
  syncMobileWalletBalanceDisplay();
}

/**
 * On mobile, park the window countdown on the market dropdown row (right-aligned).
 */
function syncMobileCountdownPlacement() {
  const countdown = $("countdown");
  const marketRow = document.querySelector(".header-market-row");
  const headerEnd = document.querySelector(".header-end");
  const settingsBtn = $("settings-page-btn");
  if (!countdown || !marketRow || !headerEnd) return;

  const mobile = isMarketMobileStack();
  if (!mobile) {
    if (countdown.parentElement !== headerEnd) {
      if (settingsBtn && settingsBtn.parentElement === headerEnd) {
        headerEnd.insertBefore(countdown, settingsBtn);
      } else {
        headerEnd.insertBefore(countdown, headerEnd.firstChild);
      }
    }
    return;
  }

  // Order: select → countdown (right).
  if (countdown.parentElement !== marketRow) {
    marketRow.appendChild(countdown);
  }
}

async function loadMarkets() {
  const res = await fetch("/api/markets");
  markets = await res.json();
  populateMarketSelect();
}

function connectSSE() {
  const es = new EventSource("/api/stream");

  es.addEventListener("markets", (e) => {
    markets = JSON.parse(e.data);
    populateMarketSelect();
  });

  es.addEventListener("window", (e) => {
    const state = JSON.parse(e.data);
    if (state.series === selectedSeries || !state.series) {
      updateWindowUI(state);
    } else if (
      state.trading &&
      !isReplayWorkspace() &&
      window.SchedulePlacements?.applyLivePlacementStats
    ) {
      // Keep header/placement stats current even when viewing another series.
      window.SchedulePlacements.applyLivePlacementStats(
        state.trading.placementStats,
        state.trading.sessionTotals,
        state.trading.demoLastWindow,
        state.trading,
      );
    }
  });

  es.addEventListener("quotes", (e) => {
    applyQuotesUpdate(JSON.parse(e.data));
  });

  es.addEventListener("chainlink-tick", (e) => {
    appendChainlinkTick(JSON.parse(e.data));
  });

  es.addEventListener("account", (e) => {
    renderWalletAccount(JSON.parse(e.data));
  });

  es.addEventListener("log-history", (e) => {
    clearLogDom();
    if (isLogClearedThisSession()) return;
    const entries = JSON.parse(e.data);
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (isLogWindowKept(entry?.windowStart ?? windowState?.windowStart ?? null)) {
          appendLogEntry(entry);
        }
      }
      scrollLogToBottom();
    }
  });

  es.addEventListener("log", (e) => {
    appendLogEntry(JSON.parse(e.data));
  });

  es.addEventListener("heatmap", () => {
    // Always re-fetch for the selected market (broadcast may be multi-series aggregate).
    void loadHeatmap();
  });

  es.addEventListener("schedule-placements", (e) => {
    if (!window.SchedulePlacements) return;
    const data = JSON.parse(e.data);
    const mode = data && !Array.isArray(data) ? data.mode || "live" : "live";
    if (mode !== getScheduleWorkspaceMode()) return;
    const placements = Array.isArray(data) ? data : data?.placements;
    if (!Array.isArray(placements)) return;
    // Ignore boards for other markets (broadcasts are per-series).
    if (placements.length > 0 && placements[0]?.series && placements[0].series !== selectedSeries) {
      return;
    }
    window.SchedulePlacements.setPlacements(placements);
  });

  es.onerror = () => {
    appendLogEntry({ level: "warn", source: "client", message: "Stream disconnected, reconnecting…" });
    es.close();
    setTimeout(connectSSE, 2000);
  };
}

async function onMarketSeriesChanged(nextSeries) {
  selectedSeries = nextSeries;
  lastPositionsFingerprint = "";
  // Market Triggers are per series — reload list for the new market.
  void loadUserTriggers().then(() => renderTriggersList());
  const res = await fetch(`/api/window?series=${encodeURIComponent(selectedSeries)}`);
  if (res.ok) updateWindowUI(await res.json());
  const config = await loadTradingConfig();
  applyTradingConfigToUi(config ?? readLocalTradingConfig() ?? {
    autoTrade: false,
    useSchedule: false,
    startTrading: false,
    manualOrderUnit: "shares",
    manualShares: 10,
    manualBuyOrderType: "FOK",
    manualSellOrderType: "FOK",
    manipulationDetector: false,
    manipulationSensitivitySec: 5,
    predictionMaxQuoteCents: 90,
    predictionMinQuoteCents: 70,
    predictionShiftCents: 5,
    predictionRiseCents: 5,
    manipulationAreaStart: 0,
    manipulationAreaEnd: 1,
    predictionRightCount: 0,
    predictionWrongCount: 0,
  });
  resetManipulationDetector();
  loadPredictionPositionCards(selectedSeries);
  if (isPredictionTriggerHost()) restorePredictionRuntime();
  else syncPredictionCardsFromRuntime();
  void loadHeatmap();
  if (walletsListOpen) void loadTraderWalletsList();
  if (window.SchedulePlacements?.loadPlacements) {
    await window.SchedulePlacements.loadPlacements({ reloadStats: true });
  } else if (window.SchedulePlacements?.refreshAllPlacementStats) {
    void window.SchedulePlacements.refreshAllPlacementStats({ force: true });
  }
  window.SchedulePlacements?.onSelectedSeriesChanged?.();
  updatePositionsPanel(windowState);
}

$("market-select").addEventListener("change", async (e) => {
  await onMarketSeriesChanged(e.target.value);
});

$("log-clear").addEventListener("click", () => {
  clearLog();
});

$("log-scroll-bottom").addEventListener("click", () => {
  scrollLogToBottom();
});

/** Draft fields for the Create Trigger dialog. */
let triggerCreateDurationMs = 5000;
let triggerCreateName = "";
let triggerCreateColor = "#58a6ff";
/** Quotes always use Buy (Ask); Sell-side quote mode removed from the editor. */
let triggerCreatePriceSide = "buy";
/** Start bar mode: "range" | "price" (single Ask ¢ on 0–100 scale). */
let triggerCreateStartMode = "range";
/** Start single price in ¢ when start mode is "price" (0–100; bottom=0, top=100). */
let triggerCreateStartPriceCents = 50;
/** End bar mode: "range" | "change-side" (signed ±100¢). */
let triggerCreateEndMode = "range";
/** End signed change in ¢ when mode is "change-side" (-100…+100). */
let triggerCreateEndChangeSideCents = 20;
let triggerCreatePriceRanges = {
  start: { lowCents: 40, highCents: 70 },
  end: { lowCents: 40, highCents: 70 },
};
/** Per-edge PTB vs market gap: null | "negative" (below PTB) | "positive" (above PTB). */
let triggerCreatePtbGap = {
  start: null,
  end: null,
};
/**
 * fixed: +/− = market above/below PTB.
 * relative: + = With BUY (UP→+, DOWN→−); − = Against BUY.
 */
let triggerCreateGapMode = "fixed";
/** Per-edge gap size constraint. value 0 = any size (bound ignored). */
let triggerCreateGapSize = {
  start: { bound: "min", value: 0 },
  end: { bound: "min", value: 0 },
};
/**
 * Signed market-price trend over Duration ($). Active only when both gap halves
 * are the same side. dollars 0 = any trend (bound ignored).
 */
let triggerCreatePriceTrend = { dollars: 0, bound: "min" };
let triggerPriceTrendSpin = null;
/** SELL tab: take-profit / stop-loss offsets in ¢ from the buy fill (1–100). */
let triggerCreateTakeProfitCents = 10;
let triggerCreateStopLossCents = 10;
/** Buy size for trigger entries. */
let triggerCreateBuyShares = 10;
/** Sell order type when the trigger exits: FAK | FOK | GTD. */
let triggerCreateSellOrderType = "FAK";
/** Buy placement: FOK default; GTD only when Duration 0 + left Price. */
let triggerCreateBuyOrderType = "FOK";
/** Fraction of market window [0–1] when the trigger may apply. */
let triggerCreateWindowArea = { start: 0, end: 1 };
/** Active side tab in the create/edit dialog: "buy" | "sell". */
let triggerCreateActiveTab = "buy";
/** Stats sub-tab: "demo" | "live" */
let triggerCreateStatsSubTab = "live";
let triggerWindowAreaDrag = null;

const USER_TRIGGERS_STORAGE_KEY = "detector-triggers-v1";
const USER_TRIGGERS_MIGRATED_KEY = "detector-triggers-migrated-v1";
/** @type {Array<Record<string, unknown>>} */
let userTriggers = [];
/** @type {null | {
 *   card: HTMLElement,
 *   cardsEl: HTMLElement,
 *   placeholder: HTMLElement | null,
 *   offsetY: number,
 *   height: number,
 *   pointerId: number,
 *   moved: boolean,
 * }} */
let triggerReorderState = null;
/** Cached Mongo Trade stats by trigger id. */
const triggerLiveStatsCache = Object.create(null);
/** In-flight persist tokens so stale responses do not overwrite newer edits. */
const triggerPersistGenById = Object.create(null);
/** When set, the create modal updates this trigger id instead of inserting. */
let triggerCreateEditingId = null;
/** "market" | "replay" — where Create/Edit Trigger saves. */
let triggerCreateHost = "market";
/** Open ⋮ menu trigger id (reuses schedule-setup-menu floating UI). */
let openTriggerMenuId = null;

const TRIGGER_DURATION_UNIT_MS = {
  ms: 1,
  s: 1000,
  min: 60_000,
};

const TRIGGER_PRICE_MIN_CENTS = 0;
const TRIGGER_PRICE_MAX_CENTS = 100;
/** Absolute Price/Range bars snap to 0.1¢. */
const TRIGGER_PRICE_MIN_GAP = 0.1;

/** Round Ask ¢ to one decimal (0.1¢ steps). */
function roundTriggerPriceTenths(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 10) / 10;
}

function clampTriggerDurationValue(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 1_000_000_000);
}

/** Stored/runtime duration; 0 = fire immediately on start (no end wait). */
function normalizeTriggerDurationMs(raw, fallback = 5000) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0) {
    const fb = Math.floor(Number(fallback));
    return Number.isFinite(fb) && fb >= 0 ? fb : 5000;
  }
  return n;
}

function isTriggerZeroDuration(ms = triggerCreateDurationMs) {
  const n = Math.floor(Number(ms));
  return Number.isFinite(n) && n === 0;
}

function readTriggerDurationMsFromInputs() {
  const valueEl = $("trigger-duration-value");
  const unitEl = $("trigger-duration-unit");
  const value = clampTriggerDurationValue(valueEl?.value);
  const unit = unitEl?.value in TRIGGER_DURATION_UNIT_MS ? unitEl.value : "s";
  if (valueEl && String(value) !== String(valueEl.value)) valueEl.value = String(value);
  return value * TRIGGER_DURATION_UNIT_MS[unit];
}

function syncTriggerZeroDurationUi() {
  const diagram = document.querySelector(".trigger-duration-diagram");
  const zero = isTriggerZeroDuration(triggerCreateDurationMs);
  diagram?.classList.toggle("is-zero-duration", zero);
  const endMode = $("trigger-end-mode");
  if (endMode) endMode.disabled = zero;
  document.querySelectorAll('.trigger-ptb-btn[data-edge="end"]').forEach((btn) => {
    btn.disabled = zero;
    btn.setAttribute("aria-disabled", zero ? "true" : "false");
  });
  document
    .querySelectorAll('.trigger-gap-size-control[data-edge="end"] select, .trigger-gap-size-control[data-edge="end"] input')
    .forEach((el) => {
      el.disabled = zero;
    });
}

function syncTriggerDurationDraft() {
  triggerCreateDurationMs = readTriggerDurationMsFromInputs();
  syncTriggerZeroDurationUi();
  if (!triggerCreateHasActivePtbGap()) triggerCreateGapMode = "fixed";
  syncTriggerCreateBuyOrderTypeUi();
  renderTriggerPtbGapUi();
}

function clampTriggerCents(raw) {
  const n = roundTriggerPriceTenths(raw);
  if (!Number.isFinite(n)) return TRIGGER_PRICE_MIN_CENTS;
  return Math.max(TRIGGER_PRICE_MIN_CENTS, Math.min(TRIGGER_PRICE_MAX_CENTS, n));
}

/** Absolute Price/Range label: always one digit after the decimal (e.g. 50.1¢). */
function formatTriggerPriceCentsLabel(cents) {
  return `${clampTriggerCents(cents).toFixed(1)}¢`;
}

const TRIGGER_OFFSET_MIN_CENTS = 1;
const TRIGGER_OFFSET_MAX_CENTS = 100;

/** Take Profit / Stop Loss: ¢ move from buy fill (not absolute quote). */
function clampTriggerOffsetCents(raw, fallback = 10) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(TRIGGER_OFFSET_MIN_CENTS, Math.min(TRIGGER_OFFSET_MAX_CENTS, n));
}

/** Absolute Bid targets from fill price (dollars) + TP/SL offsets (¢). */
function triggerExitTargetsFromFill(entryPriceDollars, takeProfitOffsetCents, stopLossOffsetCents) {
  const entryCents = Math.round(Number(entryPriceDollars) * 100);
  if (!Number.isFinite(entryCents)) return null;
  const tpOff = clampTriggerOffsetCents(takeProfitOffsetCents, 10);
  const slOff = clampTriggerOffsetCents(stopLossOffsetCents, 10);
  return {
    tpCents: Math.min(TRIGGER_PRICE_MAX_CENTS, entryCents + tpOff),
    slCents: Math.max(TRIGGER_PRICE_MIN_CENTS, entryCents - slOff),
  };
}

function clampTriggerSignedCents(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-TRIGGER_PRICE_MAX_CENTS, Math.min(TRIGGER_PRICE_MAX_CENTS, n));
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

function centsToTrackBottomPct(cents) {
  return (clampTriggerCents(cents) / TRIGGER_PRICE_MAX_CENTS) * 100;
}

function formatTriggerSignedCentsLabel(signed) {
  const n = clampTriggerSignedCents(signed);
  if (n > 0) return `+${n}¢`;
  return `${n}¢`;
}

function getTriggerPriceScale(edge) {
  const track = $(edge === "start" ? "trigger-start-track" : "trigger-end-track");
  return track?.querySelector(".trigger-price-scale") || null;
}

/** PTB / zero line Y within a scale (px from scale top), matching the diagram PTB. */
function getTriggerScaleZeroYFromTop(scale) {
  const rect = scale.getBoundingClientRect();
  if (rect.height <= 0) return 0;
  const startScale = getTriggerPriceScale("start");
  if (!startScale) return rect.height * 0.5;
  const startRect = startScale.getBoundingClientRect();
  const ptbClientY = startRect.top + startRect.height * 0.5;
  return Math.max(0, Math.min(rect.height, ptbClientY - rect.top));
}

/** Map signed ¢ (-100…+100) to track bottom%, with 0 locked to the PTB line. */
function signedCentsToTrackBottomPct(scale, signed) {
  const rect = scale.getBoundingClientRect();
  const h = Math.max(1, rect.height);
  const zeroFromTop = getTriggerScaleZeroYFromTop(scale);
  const zeroFromBottom = h - zeroFromTop;
  const s = clampTriggerSignedCents(signed);
  let fromBottom;
  if (s >= 0) {
    fromBottom = zeroFromBottom + (s / TRIGGER_PRICE_MAX_CENTS) * zeroFromTop;
  } else {
    fromBottom = zeroFromBottom + (s / TRIGGER_PRICE_MAX_CENTS) * zeroFromBottom;
  }
  return (Math.max(0, Math.min(h, fromBottom)) / h) * 100;
}

function clientYToTriggerCents(scale, clientY) {
  const rect = scale.getBoundingClientRect();
  if (rect.height <= 0) return 0;
  // Top of scale = 100.0¢, bottom = 0.0¢ (0.1¢ steps)
  const ratio = (rect.bottom - clientY) / rect.height;
  return clampTriggerCents(ratio * TRIGGER_PRICE_MAX_CENTS);
}

function clientYToTriggerSignedCents(scale, clientY) {
  const rect = scale.getBoundingClientRect();
  if (rect.height <= 0) return 0;
  const h = rect.height;
  const zeroFromTop = getTriggerScaleZeroYFromTop(scale);
  const yFromTop = clientY - rect.top;
  if (yFromTop <= zeroFromTop) {
    // Above PTB: 0 → +100 at top
    if (zeroFromTop <= 0) return TRIGGER_PRICE_MAX_CENTS;
    const t = (zeroFromTop - yFromTop) / zeroFromTop;
    return clampTriggerSignedCents(t * TRIGGER_PRICE_MAX_CENTS);
  }
  // Below PTB: 0 → -100 at bottom
  const below = h - zeroFromTop;
  if (below <= 0) return -TRIGGER_PRICE_MAX_CENTS;
  const t = (yFromTop - zeroFromTop) / below;
  return clampTriggerSignedCents(-t * TRIGGER_PRICE_MAX_CENTS);
}

function normalizeTriggerEndMode(raw) {
  return raw === "change-side" ? "change-side" : "range";
}

/** Start bar: range (band) or price (single 0.0–100.0¢). Legacy "change-side" → price. */
function normalizeTriggerStartMode(raw) {
  if (raw === "price" || raw === "change-side") return "price";
  return "range";
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
  const isStartPrice =
    edge === "start" && normalizeTriggerStartMode(triggerCreateStartMode) === "price";
  const isEndChange =
    edge === "end" && normalizeTriggerEndMode(triggerCreateEndMode) === "change-side";
  // Signed ± scale is end Price Change only; start Price stays on absolute 0.0–100.0¢.
  col?.classList.toggle("is-change-side-mode", isEndChange);
  col?.classList.toggle("is-start-price-mode", isStartPrice);

  if (isStartPrice) {
    const price = clampTriggerCents(triggerCreateStartPriceCents);
    triggerCreateStartPriceCents = price;
    const pct = centsToTrackBottomPct(price);
    const zeroEl = scale.querySelector(".trigger-price-zero");
    if (zeroEl) zeroEl.style.top = "";
    if (fill) {
      fill.style.bottom = "0%";
      fill.style.height = `${pct}%`;
    }
    if (highThumb) {
      highThumb.hidden = false;
      highThumb.style.bottom = `${pct}%`;
      highThumb.setAttribute("aria-label", "Start buy price in cents");
    }
    if (lowThumb) lowThumb.hidden = true;
    if (highLabel) {
      highLabel.textContent = formatTriggerPriceCentsLabel(price);
      highLabel.classList.remove("is-positive", "is-negative");
    }
    if (lowLabel) lowLabel.textContent = "";
    if (track) {
      track.setAttribute("aria-label", "Start buy price: bottom 0.0¢, top 100.0¢");
    }
    return;
  }

  if (isEndChange) {
    const signed = clampTriggerSignedCents(triggerCreateEndChangeSideCents);
    triggerCreateEndChangeSideCents = signed;
    const scaleH = Math.max(1, scale.getBoundingClientRect().height);
    const zeroFromTop = getTriggerScaleZeroYFromTop(scale);
    const pct = signedCentsToTrackBottomPct(scale, signed);
    const midPct = ((scaleH - zeroFromTop) / scaleH) * 100;
    const zeroEl = scale.querySelector(".trigger-price-zero");
    if (zeroEl) zeroEl.style.top = `${zeroFromTop}px`;
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
    if (highLabel) {
      highLabel.textContent = formatTriggerSignedCentsLabel(signed);
      highLabel.classList.toggle("is-positive", signed > 0);
      highLabel.classList.toggle("is-negative", signed < 0);
    }
    if (track) {
      track.setAttribute(
        "aria-label",
        "End signed price change: PTB line 0, top +100¢, bottom -100¢",
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
  if (highLabel) {
    highLabel.textContent = formatTriggerPriceCentsLabel(range.highCents);
    highLabel.classList.remove("is-positive", "is-negative");
  }
  if (lowLabel) {
    lowLabel.textContent = formatTriggerPriceCentsLabel(range.lowCents);
    lowLabel.classList.remove("is-positive", "is-negative");
  }
  if (track) {
    track.setAttribute(
      "aria-label",
      edge === "end" ? "End price range in cents" : "Start price range in cents",
    );
  }
}

function triggerMarketNoise(seed) {
  // Small deterministic PRNG so the placeholder path stays stable across renders.
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function triggerGapBiasOffset(kind, gapOffset) {
  // Screen y grows downward: positive gap = market above PTB, negative = below.
  if (kind === "positive") return -gapOffset;
  if (kind === "negative") return gapOffset;
  return 0;
}

function buildTriggerMarketZigzagPoints(stageRect, startScale, endScale, gaps = {}, trendRaw = null) {
  const startCol = startScale.closest(".trigger-price-column");
  const endCol = endScale.closest(".trigger-price-column");
  const startRect = (startCol || startScale).getBoundingClientRect();
  const endRect = (endCol || endScale).getBoundingClientRect();
  const scaleRect = startScale.getBoundingClientRect();
  // Span fully across both BUY/SELL price columns.
  const x0 = startRect.left - stageRect.left;
  const x1 = endRect.right - stageRect.left;
  const ptbY = scaleRect.top + scaleRect.height / 2 - stageRect.top;
  const gapOffset = Math.max(40, scaleRect.height * 0.36);
  const amp = Math.max(14, scaleRect.height * 0.14);
  const span = Math.max(1, x1 - x0);
  const steps = Math.max(28, Math.round(span / 14));
  const rand = triggerMarketNoise(0x70c7a1e);
  const startKind = gaps.start === "positive" || gaps.start === "negative" ? gaps.start : null;
  const endKind = gaps.end === "positive" || gaps.end === "negative" ? gaps.end : null;
  // One side only: hold that bias across the full path so enabling the same
  // direction on the other half keeps the first half's position unchanged.
  // Opposite directions: blend across mid so the line crosses PTB.
  let startBias = 0;
  let endBias = 0;
  if (startKind && endKind) {
    startBias = triggerGapBiasOffset(startKind, gapOffset);
    endBias = triggerGapBiasOffset(endKind, gapOffset);
  } else if (startKind) {
    startBias = endBias = triggerGapBiasOffset(startKind, gapOffset);
  } else if (endKind) {
    startBias = endBias = triggerGapBiasOffset(endKind, gapOffset);
  }
  const crossesPtb = Boolean(startKind && endKind && startKind !== endKind);
  const clear = 5;
  const scaleTop = scaleRect.top - stageRect.top;
  const scaleBottom = scaleRect.bottom - stageRect.top;
  // Same-side gaps: slope the placeholder line by signed $ trend (visual only).
  // Cap slope so start/end stay inside the gap highlight band (PTB ↔ outer edge).
  let trendSlopePx = 0;
  if (triggerSameSideGaps(gaps)) {
    const trend = normalizeTriggerPriceTrend(trendRaw);
    const visual = Math.max(-100, Math.min(100, trend.dollars));
    const maxTrend = Math.max(10, gapOffset * 0.55);
    // Positive $ → price rises L→R → end higher on chart → lower screen y.
    trendSlopePx = (visual / 100) * maxTrend;
  }
  const points = [];
  let noise = 0;
  let velocity = (rand() - 0.5) * amp * 0.35;

  const clampYToGapBand = (y, kind) => {
    if (kind === "positive") {
      const outer = Math.max(scaleTop + 2, ptbY - gapOffset - amp * 0.35);
      const inner = ptbY - clear;
      return Math.max(outer, Math.min(inner, y));
    }
    if (kind === "negative") {
      const inner = ptbY + clear;
      const outer = Math.min(scaleBottom - 2, ptbY + gapOffset + amp * 0.35);
      return Math.max(inner, Math.min(outer, y));
    }
    return y;
  };

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const blend = crossesPtb ? t * t * (3 - 2 * t) : 0;
    // trendSlopePx>0: start lower price (higher y), end higher price (lower y).
    const trendBias = trendSlopePx * (0.5 - t);
    const centerY = ptbY + startBias * (1 - blend) + endBias * blend + trendBias;

    velocity += (rand() - 0.5) * amp * 0.55;
    velocity *= 0.72;
    if (rand() < 0.18) velocity += (rand() - 0.5) * amp * 0.9;
    noise += velocity;
    noise += (0 - noise) * 0.08;
    // Soften noise when trending so the line stays inside the highlight.
    const noiseCap = trendSlopePx !== 0 ? amp * 0.45 : amp;
    if (noise < -noiseCap) {
      noise = -noiseCap + (-noiseCap - noise) * 0.35;
      velocity = Math.abs(velocity) * 0.4;
    } else if (noise > noiseCap) {
      noise = noiseCap - (noise - noiseCap) * 0.35;
      velocity = -Math.abs(velocity) * 0.4;
    }

    let y = centerY + noise;
    // Keep the path on the required side(s) of mid PTB, inside the highlight band.
    if (crossesPtb) {
      if (blend < 0.35) y = clampYToGapBand(y, startKind);
      else if (blend > 0.65) y = clampYToGapBand(y, endKind);
      else {
        // Mid blend: stay on whichever side the blended center is on.
        y = y < ptbY ? clampYToGapBand(y, "positive") : clampYToGapBand(y, "negative");
      }
    } else {
      y = clampYToGapBand(y, startKind || endKind);
    }

    const jitter = i === 0 || i === steps ? 0 : (rand() - 0.5) * (span / steps) * 0.45;
    const x = Math.max(x0, Math.min(x1, x0 + span * t + jitter));
    points.push({ x, y });
  }

  if (points.length) {
    points[0].x = x0;
    points[points.length - 1].x = x1;
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

function pointsAttrFromTriggerPolyline(points) {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

function normalizeTriggerGapSize(raw) {
  const bound = raw?.bound === "max" ? "max" : "min";
  let value = Number(raw?.value);
  if (!Number.isFinite(value) || value < 0) value = 0;
  value = Math.min(100000, Math.round(value * 100) / 100);
  return { bound, value };
}

function normalizeTriggerPriceTrend(raw) {
  const bound = raw?.bound === "max" ? "max" : "min";
  let dollars = Number(raw?.dollars);
  if (!Number.isFinite(dollars)) dollars = 0;
  dollars = Math.max(-100000, Math.min(100000, Math.round(dollars * 100) / 100));
  return { dollars, bound };
}

/** Both start and end gap halves on the same side (+/+ or -/-). */
function triggerSameSideGaps(gaps) {
  const start = gaps?.start;
  const end = gaps?.end;
  return (start === "positive" || start === "negative") && start === end;
}

function normalizeTriggerGapMode(raw) {
  return raw === "relative" ? "relative" : "fixed";
}

/**
 * Resolve stored gap kind to absolute market-vs-PTB sign for a BUY side.
 * Relative: With (positive) UP→+, DOWN→−; Against (negative) UP→−, DOWN→+.
 */
function triggerAbsoluteGapKindForSide(side, kind, gapMode) {
  if (kind !== "positive" && kind !== "negative") return null;
  if (normalizeTriggerGapMode(gapMode) !== "relative") return kind;
  if (side !== "up" && side !== "down") return null;
  if (kind === "positive") return side === "up" ? "positive" : "negative";
  return side === "up" ? "negative" : "positive";
}

/** Visual tilt range for ±$100 (display only). */
const TRIGGER_TREND_VISUAL_MAX_DEG = 55;
/**
 * Spin gearing: degrees of pointer travel per $1.
 * Higher = less sensitive (need more spin for the same $ change).
 */
const TRIGGER_TREND_DEG_PER_DOLLAR = 3.5;

function triggerPriceTrendDollarsToAngle(dollars) {
  const n = Number(dollars);
  if (!Number.isFinite(n) || n === 0) return 0;
  const visual = Math.max(-100, Math.min(100, n));
  // Positive $ (price up L→R) tilts the bar up-right → negative CSS rotate.
  return -(visual / 100) * TRIGGER_TREND_VISUAL_MAX_DEG;
}

function triggerPriceTrendNormalizeAngleDelta(deg) {
  let d = Number(deg);
  if (!Number.isFinite(d)) return 0;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function syncTriggerPriceTrendControls() {
  const wrap = $("trigger-price-trend");
  if (!wrap) return;
  const trend = normalizeTriggerPriceTrend(triggerCreatePriceTrend);
  triggerCreatePriceTrend = trend;
  const valueEl = $("trigger-price-trend-value");
  const boundEl = $("trigger-price-trend-bound");
  const rotor = $("trigger-price-trend-rotor");
  if (valueEl && document.activeElement !== valueEl) {
    valueEl.value = String(trend.dollars);
  }
  if (boundEl) boundEl.value = trend.bound;
  if (rotor) {
    rotor.style.transform = `rotate(${triggerPriceTrendDollarsToAngle(trend.dollars)}deg)`;
  }
  wrap.classList.toggle("is-up", trend.dollars > 0);
  wrap.classList.toggle("is-down", trend.dollars < 0);
  wrap.classList.toggle("is-flat", trend.dollars === 0);
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

function renderTriggerMarketOverlay(
  stage,
  stageRect,
  zigzagPoints,
  edgeLayouts,
  ptbY,
  pathSpan,
  options = {},
) {
  const overlay = $("trigger-market-overlay");
  const marketLine = $("trigger-market-line");
  if (!overlay || !marketLine || !zigzagPoints.length) return;
  const relative = options.relative === true;

  overlay.setAttribute(
    "viewBox",
    `0 0 ${Math.max(1, stageRect.width)} ${Math.max(1, stageRect.height)}`,
  );

  // No gap → no base gray line; Fixed active sides draw colored halves.
  // Relative: no green/red graph (With/Against are not absolute +/− colors).
  marketLine.setAttribute("hidden", "");
  marketLine.removeAttribute("points");
  marketLine.classList.remove("is-negative", "is-positive");

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
        sizeControl.classList.remove("is-negative", "is-positive", "is-relative");
      }
    } else if (relative) {
      fill.setAttribute("hidden", "");
      fill.removeAttribute("d");
      fill.classList.remove("is-negative", "is-positive");
      if (sideLine) {
        sideLine.setAttribute("hidden", "");
        sideLine.removeAttribute("points");
        sideLine.classList.remove("is-negative", "is-positive");
      }
      if (sizeControl) {
        const zoneMidX = (layout.x0 + layout.x1) / 2;
        const ptbPad = 8;
        sizeControl.style.left = `${zoneMidX}px`;
        // Relative: Min/Max always above the PTB line (With or Against).
        sizeControl.style.top = `${ptbY - ptbPad}px`;
        sizeControl.classList.remove("is-positive");
        sizeControl.classList.add("is-negative", "is-relative");
        sizeControl.hidden = false;
        syncTriggerGapSizeControl(edge);
      }
      continue;
    } else {
      // SVG elements don't reliably honor the HTMLElement `hidden` IDL property.
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
        // Keep Min/Max outside the active gap fill — opposite side of PTB.
        // +Gap fill is above PTB → controls below; -Gap fill is below → controls above.
        sizeControl.style.top =
          kind === "positive" ? `${ptbY + ptbPad}px` : `${ptbY - ptbPad}px`;
        sizeControl.classList.toggle("is-negative", kind === "negative");
        sizeControl.classList.toggle("is-positive", kind === "positive");
        sizeControl.classList.remove("is-relative");
        sizeControl.hidden = false;
        syncTriggerGapSizeControl(edge);
      }
    }

    if (sideLine) {
      if (!kind || !pathSpan) {
        sideLine.setAttribute("hidden", "");
        sideLine.removeAttribute("points");
        sideLine.classList.remove("is-negative", "is-positive");
      } else {
        // Each active side colors its full half; both sides → full path width.
        const lineX0 = edge === "start" ? pathSpan.x0 : midX;
        const lineX1 = edge === "start" ? midX : pathSpan.x1;
        const sidePoints = sliceTriggerMarketPolyline(zigzagPoints, lineX0, lineX1);
        sideLine.setAttribute("points", pointsAttrFromTriggerPolyline(sidePoints));
        sideLine.classList.toggle("is-negative", kind === "negative");
        sideLine.classList.toggle("is-positive", kind === "positive");
        sideLine.removeAttribute("hidden");
      }
    }
  }
}

function renderTriggerPtbGapUi() {
  const stage = document.querySelector(".trigger-duration-stage");
  if (!stage) return;
  const stageRect = stage.getBoundingClientRect();
  if (stageRect.width < 1 || stageRect.height < 1) return;

  const startScale = getTriggerPriceScale("start");
  const endScale = getTriggerPriceScale("end");
  if (!startScale || !endScale) return;

  const built = buildTriggerMarketZigzagPoints(
    stageRect,
    startScale,
    endScale,
    triggerCreatePtbGap,
    triggerCreatePriceTrend,
  );
  const zigzagPoints = built.points;
  const ptbY = built.ptbY;
  const edgeLayouts = { start: null, end: null };
  const midX = (built.x0 + built.x1) / 2;

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

  const zeroDuration = isTriggerZeroDuration(triggerCreateDurationMs);
  const gapMode = normalizeTriggerGapMode(triggerCreateGapMode);
  const relative = gapMode === "relative";

  // Trend wheel: only when both gap areas are on the same side (needs Duration > 0).
  const trendWrap = $("trigger-price-trend");
  if (trendWrap) {
    const sameSide = !zeroDuration && triggerSameSideGaps(triggerCreatePtbGap);
    trendWrap.hidden = !sameSide;
    if (sameSide) {
      const side = triggerCreatePtbGap.start; // same as end when sameSide
      trendWrap.classList.toggle("is-gap-positive", side === "positive");
      trendWrap.classList.toggle("is-gap-negative", side === "negative");
      trendWrap.style.left = `${Math.round(midX)}px`;
      trendWrap.style.top = `${Math.round(ptbY)}px`;
      syncTriggerPriceTrendControls();
    } else {
      trendWrap.classList.remove("is-gap-positive", "is-gap-negative");
    }
  }

  let topBtnY = null;
  for (const edge of ["start", "end"]) {
    const endDisabled = zeroDuration && edge === "end";
    const selected = endDisabled ? null : triggerCreatePtbGap[edge];
    const scale = getTriggerPriceScale(edge);
    const col = document.querySelector(`.trigger-price-column[data-edge="${edge}"]`);
    if (!scale || !col) continue;
    const scaleRect = scale.getBoundingClientRect();

    // Top = + Gap / With BUY; bottom = − Gap / Against BUY.
    const yByKind = {
      positive: scaleRect.top - stageRect.top,
      negative: scaleRect.bottom - stageRect.top,
    };
    if (topBtnY == null) topBtnY = yByKind.positive;

    // Full half-width of the price path for fill + colored line.
    const halfX0 = edge === "start" ? built.x0 : midX;
    const halfX1 = edge === "start" ? midX : built.x1;
    const btnX = (halfX0 + halfX1) / 2;

    for (const kind of ["negative", "positive"]) {
      const btn = stage.querySelector(`.trigger-ptb-btn[data-edge="${edge}"][data-ptb="${kind}"]`);
      const active = selected === kind;
      if (btn) {
        const edgeLabel = edge === "start" ? "Start" : "End";
        if (relative) {
          if (kind === "positive") {
            btn.textContent = "Gap With BUY";
            btn.title =
              "Gap With BUY: UP needs market above PTB; DOWN needs market below PTB";
            btn.setAttribute("aria-label", `${edgeLabel}: Gap With BUY`);
          } else {
            btn.textContent = "Gap Against BUY";
            btn.title =
              "Gap Against BUY: UP needs market below PTB; DOWN needs market above PTB";
            btn.setAttribute("aria-label", `${edgeLabel}: Gap Against BUY`);
          }
        } else if (kind === "positive") {
          btn.textContent = "+ Gap";
          btn.title = "Require market above PTB (positive gap)";
          btn.setAttribute("aria-label", `${edgeLabel}: + Gap`);
        } else {
          btn.textContent = "- Gap";
          btn.title = "Require market below PTB (negative gap)";
          btn.setAttribute("aria-label", `${edgeLabel}: - Gap`);
        }
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", active ? "true" : "false");
        btn.style.left = `${Math.round(btnX)}px`;
        btn.style.top = `${Math.round(yByKind[kind])}px`;
        if (edge === "end") {
          btn.disabled = zeroDuration;
          btn.setAttribute("aria-disabled", zeroDuration ? "true" : "false");
        }
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

  // Fixed / Relative: only enabled when at least one Gap button is active.
  const modeEl = $("trigger-gap-mode");
  if (modeEl && topBtnY != null) {
    const hasGap =
      triggerCreatePtbGap.start === "positive" ||
      triggerCreatePtbGap.start === "negative" ||
      (!zeroDuration &&
        (triggerCreatePtbGap.end === "positive" ||
          triggerCreatePtbGap.end === "negative"));
    modeEl.hidden = false;
    modeEl.classList.toggle("is-disabled", !hasGap);
    modeEl.setAttribute("aria-disabled", hasGap ? "false" : "true");
    modeEl.style.left = `${Math.round(midX)}px`;
    modeEl.style.top = `${Math.round(topBtnY)}px`;
    modeEl.querySelectorAll("[data-gap-mode]").forEach((opt) => {
      const mode = opt.getAttribute("data-gap-mode");
      const active = hasGap && mode === gapMode;
      opt.disabled = !hasGap;
      opt.classList.toggle("is-active", active);
      opt.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  renderTriggerMarketOverlay(
    stage,
    stageRect,
    zigzagPoints,
    edgeLayouts,
    ptbY,
    {
      x0: built.x0,
      x1: built.x1,
    },
    { relative },
  );
}

function renderAllTriggerPriceRanges() {
  renderTriggerPriceRange("start");
  renderTriggerPriceRange("end");
  renderTriggerPtbGapUi();
}

function triggerCreateHasActivePtbGap() {
  const zeroDuration = isTriggerZeroDuration(triggerCreateDurationMs);
  return (
    triggerCreatePtbGap.start === "positive" ||
    triggerCreatePtbGap.start === "negative" ||
    (!zeroDuration &&
      (triggerCreatePtbGap.end === "positive" ||
        triggerCreatePtbGap.end === "negative"))
  );
}

function toggleTriggerPtbGap(edge, kind) {
  if (edge !== "start" && edge !== "end") return;
  if (kind !== "negative" && kind !== "positive") return;
  if (edge === "end" && isTriggerZeroDuration(triggerCreateDurationMs)) return;
  triggerCreatePtbGap[edge] = triggerCreatePtbGap[edge] === kind ? null : kind;
  // No active gap → Fixed/Relative is disabled; fall back to Fixed labels.
  if (!triggerCreateHasActivePtbGap()) triggerCreateGapMode = "fixed";
  renderTriggerPtbGapUi();
  // Gap disables Buy GTD — coerce order type while the dialog is open.
  syncTriggerCreateBuyOrderTypeUi();
}

function setTriggerCreateGapMode(mode) {
  if (!triggerCreateHasActivePtbGap()) return;
  triggerCreateGapMode = normalizeTriggerGapMode(mode);
  renderTriggerPtbGapUi();
  syncTriggerCreateBuyOrderTypeUi();
}

function setTriggerCreatePriceTrendDollars(dollars) {
  triggerCreatePriceTrend = normalizeTriggerPriceTrend({
    ...triggerCreatePriceTrend,
    dollars,
  });
  syncTriggerPriceTrendControls();
  renderTriggerPtbGapUi();
}

function bindTriggerPriceTrendControls() {
  const wrap = $("trigger-price-trend");
  if (!wrap || wrap.dataset.trendBound === "1") return;
  wrap.dataset.trendBound = "1";

  const valueEl = $("trigger-price-trend-value");
  const boundEl = $("trigger-price-trend-bound");
  valueEl?.addEventListener("input", (e) => {
    const dollars = Number(e.currentTarget.value);
    triggerCreatePriceTrend = normalizeTriggerPriceTrend({
      ...triggerCreatePriceTrend,
      dollars: Number.isFinite(dollars) ? dollars : 0,
    });
    const rotor = $("trigger-price-trend-rotor");
    if (rotor) {
      rotor.style.transform = `rotate(${triggerPriceTrendDollarsToAngle(
        triggerCreatePriceTrend.dollars,
      )}deg)`;
    }
    wrap.classList.toggle("is-up", triggerCreatePriceTrend.dollars > 0);
    wrap.classList.toggle("is-down", triggerCreatePriceTrend.dollars < 0);
    wrap.classList.toggle("is-flat", triggerCreatePriceTrend.dollars === 0);
    renderTriggerPtbGapUi();
  });
  valueEl?.addEventListener("change", (e) => {
    const dollars = Number(e.currentTarget.value);
    setTriggerCreatePriceTrendDollars(Number.isFinite(dollars) ? dollars : 0);
  });
  boundEl?.addEventListener("change", (e) => {
    triggerCreatePriceTrend = normalizeTriggerPriceTrend({
      ...triggerCreatePriceTrend,
      bound: e.currentTarget.value === "max" ? "max" : "min",
    });
    syncTriggerPriceTrendControls();
  });

  const onPointerMove = (e) => {
    if (!triggerPriceTrendSpin) return;
    const { cx, cy, lastAngleDeg, startDollars, traveledDeg } = triggerPriceTrendSpin;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    if (dx * dx + dy * dy < 16) return;
    // atan2(dy, dx): 0 = right, positive = clockwise (screen down).
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const step = triggerPriceTrendNormalizeAngleDelta(angleDeg - lastAngleDeg);
    triggerPriceTrendSpin.lastAngleDeg = angleDeg;
    // Counter-clockwise (negative css step when dragging up on the right) → +$.
    triggerPriceTrendSpin.traveledDeg = traveledDeg - step;
    const dollars = startDollars + triggerPriceTrendSpin.traveledDeg / TRIGGER_TREND_DEG_PER_DOLLAR;
    setTriggerCreatePriceTrendDollars(Math.round(dollars * 10) / 10);
  };

  const stopSpin = () => {
    if (!triggerPriceTrendSpin) return;
    const { pointerId, target } = triggerPriceTrendSpin;
    triggerPriceTrendSpin = null;
    wrap.classList.remove("is-spinning");
    document.body.classList.remove("is-trigger-price-dragging");
    try {
      target.releasePointerCapture(pointerId);
    } catch {
      /* ignore */
    }
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopSpin);
    window.removeEventListener("pointercancel", stopSpin);
  };

  wrap.addEventListener("pointerdown", (e) => {
    if (wrap.hidden) return;
    if (e.target?.closest?.("#trigger-price-trend-value, #trigger-price-trend-bound")) return;
    const arm = e.target?.closest?.("[data-trend-arm], .trigger-price-trend-wheel");
    if (!arm) return;
    e.preventDefault();
    const wheel = $("trigger-price-trend-wheel");
    const rect = wheel?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    triggerPriceTrendSpin = {
      cx,
      cy,
      pointerId: e.pointerId,
      target: arm,
      lastAngleDeg: angleDeg,
      startDollars: Number(triggerCreatePriceTrend.dollars) || 0,
      traveledDeg: 0,
    };
    wrap.classList.add("is-spinning");
    document.body.classList.add("is-trigger-price-dragging");
    try {
      arm.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopSpin);
    window.addEventListener("pointercancel", stopSpin);
  });
}

function setTriggerPriceThumb(edge, thumb, cents) {
  if (edge === "start" && normalizeTriggerStartMode(triggerCreateStartMode) === "price") {
    triggerCreateStartPriceCents = clampTriggerCents(cents);
    renderTriggerPriceRange("start");
    return;
  }
  if (edge === "end" && normalizeTriggerEndMode(triggerCreateEndMode) === "change-side") {
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

/** Current ¢ value for a bar thumb (absolute or signed end Price Change). */
function getTriggerPriceThumbCents(edge, thumb) {
  if (edge === "start" && normalizeTriggerStartMode(triggerCreateStartMode) === "price") {
    return clampTriggerCents(triggerCreateStartPriceCents);
  }
  if (edge === "end" && normalizeTriggerEndMode(triggerCreateEndMode) === "change-side") {
    return clampTriggerSignedCents(triggerCreateEndChangeSideCents);
  }
  const range = normalizeTriggerPriceRange(triggerCreatePriceRanges[edge]);
  return thumb === "low" ? range.lowCents : range.highCents;
}

function nudgeTriggerPriceThumb(edge, thumb, direction) {
  if (edge === "end" && isTriggerZeroDuration(triggerCreateDurationMs)) return;
  const startPriceMode =
    edge === "start" && normalizeTriggerStartMode(triggerCreateStartMode) === "price";
  const endChangeMode =
    edge === "end" && normalizeTriggerEndMode(triggerCreateEndMode) === "change-side";
  if ((startPriceMode || endChangeMode) && thumb === "low") return;
  const step = endChangeMode ? 1 : TRIGGER_PRICE_MIN_GAP;
  const current = getTriggerPriceThumbCents(edge, thumb);
  setTriggerPriceThumb(edge, thumb, current + direction * step);
}

function bindTriggerPriceRangeDrag() {
  const modal = $("trigger-create-modal");
  if (!modal || modal.dataset.priceDragBound === "1") return;
  modal.dataset.priceDragBound = "1";

  let drag = null;

  const onPointerMove = (e) => {
    if (!drag) return;
    const cents =
      drag.endMode === "change-side"
        ? clientYToTriggerSignedCents(drag.scale, e.clientY)
        : clientYToTriggerCents(drag.scale, e.clientY);
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
      const scale = thumbEl.closest(".trigger-price-scale");
      if ((edge !== "start" && edge !== "end") || (thumb !== "high" && thumb !== "low") || !scale) {
        return;
      }
      if (edge === "end" && isTriggerZeroDuration(triggerCreateDurationMs)) return;
      const startPriceMode =
        edge === "start" && normalizeTriggerStartMode(triggerCreateStartMode) === "price";
      const endChangeMode =
        edge === "end" && normalizeTriggerEndMode(triggerCreateEndMode) === "change-side";
      if ((startPriceMode || endChangeMode) && thumb === "low") return;
      const dragMode = endChangeMode ? "change-side" : startPriceMode ? "price" : "range";
      drag = { edge, thumb, scale, thumbEl, pointerId: e.pointerId, endMode: dragMode };
      thumbEl.classList.add("is-dragging");
      document.body.classList.add("is-trigger-price-dragging");
      try {
        thumbEl.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      // Keep focus so ArrowUp/ArrowDown work after click/drag.
      if (typeof thumbEl.focus === "function") {
        try {
          thumbEl.focus({ preventScroll: true });
        } catch {
          thumbEl.focus();
        }
      }
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stopDrag);
      window.addEventListener("pointercancel", stopDrag);
      const nextCents =
        dragMode === "change-side"
          ? clientYToTriggerSignedCents(scale, e.clientY)
          : clientYToTriggerCents(scale, e.clientY);
      setTriggerPriceThumb(edge, thumb, nextCents);
      e.preventDefault();
    });

    thumbEl.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const edge = thumbEl.dataset.edge;
      const thumb = thumbEl.dataset.thumb;
      if ((edge !== "start" && edge !== "end") || (thumb !== "high" && thumb !== "low")) return;
      e.preventDefault();
      nudgeTriggerPriceThumb(edge, thumb, e.key === "ArrowUp" ? 1 : -1);
    });
  });

  modal.querySelectorAll(".trigger-ptb-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggleTriggerPtbGap(btn.dataset.edge, btn.dataset.ptb);
    });
  });

  modal.querySelectorAll("#trigger-gap-mode [data-gap-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setTriggerCreateGapMode(btn.getAttribute("data-gap-mode"));
    });
  });

  window.addEventListener("resize", () => {
    if (!modal.hidden) renderTriggerPtbGapUi();
  });
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

function syncTriggerCreateColorIconContrast() {
  const colorInput = $("trigger-create-color");
  const swatch = colorInput?.closest?.(".setup-edit-color-swatch");
  if (!swatch) return;
  const color = colorInput?.value || triggerCreateColor || "#58a6ff";
  swatch.classList.toggle("is-light-setup", isLightHexColor(color));
}

function syncTriggerCreateNameDraft() {
  triggerCreateName = $("trigger-create-name")?.value?.trim() ?? "";
  syncTriggerCreateSubmitState();
}

function syncTriggerCreateSubmitState() {
  const btn = $("trigger-create-submit");
  if (btn) btn.disabled = !triggerCreateName;
}

function userTriggersStorageKey() {
  return userScopedStorageKey(USER_TRIGGERS_STORAGE_KEY);
}

function userTriggersMigratedKey() {
  return userScopedStorageKey(USER_TRIGGERS_MIGRATED_KEY);
}

function readLocalUserTriggers() {
  try {
    const raw = localStorage.getItem(userTriggersStorageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map(normalizeTriggerRecord).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function clearLocalUserTriggers() {
  try {
    localStorage.removeItem(userTriggersStorageKey());
    localStorage.setItem(userTriggersMigratedKey(), "1");
  } catch {
    /* ignore */
  }
}

function normalizeTriggerDemoStats(raw) {
  const success = Math.max(0, Math.round(Number(raw?.success) || 0));
  const fail = Math.max(0, Math.round(Number(raw?.fail) || 0));
  const blue = Math.max(0, Math.round(Number(raw?.blue) || 0));
  const takeProfit = Math.max(0, Math.round(Number(raw?.takeProfit) || 0));
  const stopLoss = Math.max(0, Math.round(Number(raw?.stopLoss) || 0));
  const pnlUsd = Number.isFinite(Number(raw?.pnlUsd)) ? Number(raw.pnlUsd) : 0;
  const activeMsRaw = Number(raw?.activeMs);
  const activeMs =
    Number.isFinite(activeMsRaw) && activeMsRaw >= 0 ? Math.floor(activeMsRaw) : null;
  const demoActiveMsRaw = Number(raw?.demoActiveMs);
  const demoActiveMs =
    Number.isFinite(demoActiveMsRaw) && demoActiveMsRaw >= 0
      ? Math.floor(demoActiveMsRaw)
      : null;
  return { success, fail, blue, takeProfit, stopLoss, pnlUsd, activeMs, demoActiveMs };
}

/** Offset 100 = that exit path is disabled. */
function isTriggerExitDisabled(offsetCents) {
  return clampTriggerOffsetCents(offsetCents, 10) >= 100;
}

function normalizeTriggerBuyShares(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 10;
  return Math.min(100_000, n);
}

function normalizeTriggerSellOrderType(raw) {
  if (raw === "FOK" || raw === "GTD") return raw;
  return "FAK";
}

/** True when any +/− Gap is set (start or end) — GTD is not allowed. */
function triggerHasPtbGap(ptbGap) {
  const start = ptbGap?.start;
  const end = ptbGap?.end;
  return (
    start === "positive" ||
    start === "negative" ||
    end === "positive" ||
    end === "negative"
  );
}

function triggerBuyGtdAllowed(durationMs, startMode, ptbGap) {
  return (
    isTriggerZeroDuration(durationMs) &&
    normalizeTriggerStartMode(startMode) === "price" &&
    !triggerHasPtbGap(ptbGap)
  );
}

function normalizeTriggerBuyOrderType(raw, durationMs, startMode, ptbGap) {
  if (raw === "FAK") return "FAK";
  if (raw === "GTD") {
    return triggerBuyGtdAllowed(durationMs, startMode, ptbGap) ? "GTD" : "FOK";
  }
  return "FOK";
}

function syncTriggerCreateBuyOrderTypeUi() {
  const el = $("trigger-buy-order-type");
  if (!el) return;
  const gtdOk = triggerBuyGtdAllowed(
    triggerCreateDurationMs,
    triggerCreateStartMode,
    triggerCreatePtbGap,
  );
  const gtdOpt = el.querySelector('option[value="GTD"]');
  if (gtdOpt) gtdOpt.disabled = !gtdOk;
  triggerCreateBuyOrderType = normalizeTriggerBuyOrderType(
    el.value || triggerCreateBuyOrderType,
    triggerCreateDurationMs,
    triggerCreateStartMode,
    triggerCreatePtbGap,
  );
  if (el.value !== triggerCreateBuyOrderType) el.value = triggerCreateBuyOrderType;
  const note = $("trigger-buy-order-note");
  if (note) {
    note.classList.toggle("is-gtd-locked", !gtdOk);
  }
}

function syncTriggerCreateBuyOrderTypeDraft() {
  const el = $("trigger-buy-order-type");
  triggerCreateBuyOrderType = normalizeTriggerBuyOrderType(
    el?.value ?? triggerCreateBuyOrderType,
    triggerCreateDurationMs,
    triggerCreateStartMode,
    triggerCreatePtbGap,
  );
  syncTriggerCreateBuyOrderTypeUi();
}

function applyTriggerBuyOrderTypeToInput(orderType) {
  triggerCreateBuyOrderType = normalizeTriggerBuyOrderType(
    orderType ?? "FOK",
    triggerCreateDurationMs,
    triggerCreateStartMode,
    triggerCreatePtbGap,
  );
  const el = $("trigger-buy-order-type");
  if (el) el.value = triggerCreateBuyOrderType;
  syncTriggerCreateBuyOrderTypeUi();
}

function normalizeTriggerExitOffsets(raw) {
  const tp = Math.round(Number(raw?.takeProfitCents));
  const sl = Math.round(Number(raw?.stopLossCents));
  // Legacy absolute quote defaults (pre offset-from-fill) → new offset defaults.
  if (tp === 80 && (sl === 20 || !Number.isFinite(sl))) {
    return { takeProfitCents: 10, stopLossCents: 10 };
  }
  return {
    takeProfitCents: clampTriggerOffsetCents(tp, 10),
    stopLossCents: clampTriggerOffsetCents(sl, 10),
  };
}

function normalizeTriggerRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id != null ? String(raw.id) : "";
  if (!id) return null;
  const exits = normalizeTriggerExitOffsets(raw);
  return {
    ...raw,
    id,
    durationMs: normalizeTriggerDurationMs(raw.durationMs, 5000),
    buyShares: normalizeTriggerBuyShares(raw.buyShares),
    buyOrderType: normalizeTriggerBuyOrderType(
      raw.buyOrderType,
      raw.durationMs,
      raw.startMode,
      raw.ptbGap,
    ),
    sellOrderType: normalizeTriggerSellOrderType(raw.sellOrderType),
    takeProfitCents: exits.takeProfitCents,
    stopLossCents: exits.stopLossCents,
    priceTrend: normalizeTriggerPriceTrend(raw.priceTrend),
    gapMode: normalizeTriggerGapMode(raw.gapMode),
    priceSide: "buy",
    startMode: normalizeTriggerStartMode(raw.startMode),
    startPriceCents: clampTriggerCents(
      raw.startPriceCents ??
        (raw.startMode === "change-side" || raw.startMode === "price"
          ? Math.abs(Number(raw.startChangeSideCents)) || 50
          : 50),
    ),
    endMode: normalizeTriggerEndMode(raw.endMode),
    endChangeSideCents: clampTriggerSignedCents(raw.endChangeSideCents ?? 20),
    runMode: raw.runMode === "trade" ? "trade" : "demo",
    paused: raw.paused !== false,
    demoStats: normalizeTriggerDemoStats(raw.demoStats),
    series:
      typeof raw.series === "string" && raw.series.trim()
        ? raw.series.trim().toLowerCase()
        : selectedSeries || "",
    sortOrder: Number.isFinite(Number(raw.sortOrder))
      ? Math.floor(Number(raw.sortOrder))
      : raw.sortOrder,
  };
}

function sortUserTriggersInPlace() {
  if (!Array.isArray(userTriggers)) return;
  userTriggers.sort((a, b) => {
    const ao = Number.isFinite(Number(a?.sortOrder)) ? Number(a.sortOrder) : null;
    const bo = Number.isFinite(Number(b?.sortOrder)) ? Number(b.sortOrder) : null;
    if (ao != null && bo != null && ao !== bo) return ao - bo;
    if (ao != null && bo == null) return -1;
    if (ao == null && bo != null) return 1;
    const at = Date.parse(String(a?.updatedAt || ""));
    const bt = Date.parse(String(b?.updatedAt || ""));
    if (Number.isFinite(at) && Number.isFinite(bt) && bt !== at) return bt - at;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}

async function persistTriggerOrder(orderedIds) {
  const ids = Array.isArray(orderedIds)
    ? orderedIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  if (ids.length === 0) return;
  const byId = new Map(
    (Array.isArray(userTriggers) ? userTriggers : []).map((t) => [String(t?.id), t]),
  );
  const next = [];
  const seen = new Set();
  ids.forEach((id, i) => {
    const t = byId.get(id);
    if (!t || seen.has(id)) return;
    seen.add(id);
    next.push({ ...t, sortOrder: i });
  });
  for (const t of userTriggers) {
    const id = String(t?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push({ ...t, sortOrder: next.length });
  }
  userTriggers = next;
  try {
    const res = await fetch("/api/triggers/reorder", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, series: selectedSeries }),
    });
    if (!res.ok) return;
    const body = await res.json().catch(() => ({}));
    if (Array.isArray(body?.triggers)) {
      userTriggers = body.triggers.map(normalizeTriggerRecord).filter(Boolean);
    }
  } catch {
    /* keep local order */
  }
  window.ScheduleLiveTriggers?.render?.();
}

function endTriggerCardReorder(commit) {
  const state = triggerReorderState;
  triggerReorderState = null;
  if (!state) return;
  const { card, cardsEl, placeholder, moved } = state;
  card.classList.remove("is-reordering");
  card.style.position = "";
  card.style.left = "";
  card.style.top = "";
  card.style.width = "";
  card.style.zIndex = "";
  card.style.pointerEvents = "";
  document.body.classList.remove("is-trigger-reordering");
  if (placeholder?.parentNode) {
    placeholder.parentNode.insertBefore(card, placeholder);
    placeholder.remove();
  } else if (card.parentNode !== cardsEl) {
    cardsEl.appendChild(card);
  }
  if (!commit || !moved) return;
  const orderedIds = [...cardsEl.querySelectorAll(".trigger-card")]
    .map((el) => el.dataset.triggerId)
    .filter(Boolean);
  void persistTriggerOrder(orderedIds);
}

/** Grid-aware insert target: DOM order is row-major; use X within a row, Y across rows. */
function findTriggerReorderInsertBefore(cardsEl, card, clientX, clientY) {
  const siblings = [...cardsEl.querySelectorAll(".trigger-card")].filter((el) => el !== card);
  for (const other of siblings) {
    const rect = other.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const midX = rect.left + rect.width / 2;
    if (clientY < midY - 1) return other;
    if (clientY <= midY + 1 && clientX < midX) return other;
  }
  return null;
}

function updateTriggerCardReorder(clientX, clientY) {
  const state = triggerReorderState;
  if (!state) return;
  const { card, cardsEl, placeholder, offsetX, offsetY } = state;
  if (!placeholder) return;
  state.moved = true;
  card.style.left = `${clientX - (Number.isFinite(offsetX) ? offsetX : 0)}px`;
  card.style.top = `${clientY - offsetY}px`;

  const insertBefore = findTriggerReorderInsertBefore(cardsEl, card, clientX, clientY);
  if (insertBefore) {
    if (placeholder.nextElementSibling !== insertBefore) {
      cardsEl.insertBefore(placeholder, insertBefore);
    }
  } else if (placeholder.parentNode === cardsEl) {
    cardsEl.appendChild(placeholder);
  }
}

function startTriggerCardReorder(e, card, cardsEl) {
  if (e.button !== 0 || triggerReorderState) return;
  e.preventDefault();
  e.stopPropagation();
  closeTriggerMenus();
  const rect = card.getBoundingClientRect();
  const placeholder = document.createElement("div");
  placeholder.className = "trigger-card-reorder-placeholder";
  placeholder.style.height = `${Math.max(40, rect.height)}px`;
  cardsEl.insertBefore(placeholder, card);

  card.classList.add("is-reordering");
  card.style.position = "fixed";
  card.style.left = `${rect.left}px`;
  card.style.top = `${rect.top}px`;
  card.style.width = `${rect.width}px`;
  card.style.zIndex = "1300";
  card.style.pointerEvents = "none";
  document.body.appendChild(card);
  document.body.classList.add("is-trigger-reordering");

  triggerReorderState = {
    card,
    cardsEl,
    placeholder,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    height: rect.height,
    pointerId: e.pointerId,
    moved: false,
  };

  const handle = card.querySelector(".trigger-card-drag-handle");
  try {
    handle?.setPointerCapture?.(e.pointerId);
  } catch {
    /* ignore */
  }

  const onMove = (ev) => {
    if (!triggerReorderState || triggerReorderState.card !== card) return;
    updateTriggerCardReorder(ev.clientX, ev.clientY);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    endTriggerCardReorder(true);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  updateTriggerCardReorder(e.clientX, e.clientY);
}

/**
 * Load Market Triggers from Mongo (per user × selected series).
 * One-time migrate from browser localStorage when the server list is empty.
 * Replay Triggers stay in localStorage via ScheduleReplayTriggers.
 */
async function loadUserTriggers() {
  const series = String(selectedSeries || "").trim().toLowerCase();
  const qs = series ? `?series=${encodeURIComponent(series)}` : "";
  try {
    const res = await fetch(`/api/triggers${qs}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`triggers ${res.status}`);
    const body = await res.json().catch(() => ({}));
    let list = Array.isArray(body?.triggers)
      ? body.triggers.map(normalizeTriggerRecord).filter(Boolean)
      : [];
    const local = readLocalUserTriggers();
    const migrated = localStorage.getItem(userTriggersMigratedKey()) === "1";
    if (list.length === 0 && local.length > 0 && !migrated) {
      const mig = await fetch("/api/triggers/migrate", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggers: local, series }),
      });
      if (mig.ok) {
        const migBody = await mig.json().catch(() => ({}));
        list = Array.isArray(migBody?.triggers)
          ? migBody.triggers.map(normalizeTriggerRecord).filter(Boolean)
          : local;
        clearLocalUserTriggers();
        try {
          localStorage.setItem(userTriggersMigratedKey(), "1");
        } catch {
          /* ignore */
        }
      } else {
        list = local;
      }
    } else if (list.length > 0 && local.length > 0) {
      clearLocalUserTriggers();
    }
    userTriggers = list;
    sortUserTriggersInPlace();
  } catch {
    const local = readLocalUserTriggers();
    if (local.length > 0) userTriggers = local;
    sortUserTriggersInPlace();
  }
  return userTriggers;
}

async function persistUserTrigger(trigger) {
  const record = normalizeTriggerRecord(trigger);
  if (!record) return null;
  if (!record.series) record.series = String(selectedSeries || "").trim().toLowerCase();
  const id = String(record.id);
  const gen = (triggerPersistGenById[id] = (triggerPersistGenById[id] || 0) + 1);
  try {
    const res = await fetch(`/api/triggers/${encodeURIComponent(id)}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    if (!res.ok) return null;
    const saved = normalizeTriggerRecord(await res.json().catch(() => null));
    if (!saved || gen !== triggerPersistGenById[id]) return saved;
    const idx = userTriggers.findIndex((t) => String(t?.id) === id);
    if (idx >= 0) userTriggers[idx] = saved;
    else userTriggers = [saved, ...userTriggers];
    sortUserTriggersInPlace();
    return saved;
  } catch {
    return null;
  }
}

async function persistUserTriggerPatch(id, patch) {
  const key = String(id || "");
  if (!key) return null;
  const gen = (triggerPersistGenById[key] = (triggerPersistGenById[key] || 0) + 1);
  try {
    const res = await fetch(`/api/triggers/${encodeURIComponent(key)}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.status === 404) {
      const local = findUserTrigger(key);
      return local ? persistUserTrigger(local) : null;
    }
    if (!res.ok) return null;
    const saved = normalizeTriggerRecord(await res.json().catch(() => null));
    if (!saved || gen !== triggerPersistGenById[key]) return saved;
    const idx = userTriggers.findIndex((t) => String(t?.id) === key);
    if (idx >= 0) userTriggers[idx] = saved;
    return saved;
  } catch {
    return null;
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
  void persistUserTriggerPatch(key, patch);
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
  invalidateTriggerGtdArmKeys(triggerId);
  scheduleTriggerGtdArming(windowState);
}

/** When Allow trade turns Off, every Trade card falls back to Demo. */
function forceTradeTriggersToDemo(reason = "Allow trade off") {
  if (!Array.isArray(userTriggers) || userTriggers.length === 0) return 0;
  const ids = [];
  userTriggers = userTriggers.map((trigger) => {
    if (trigger?.runMode !== "trade") return trigger;
    const id = String(trigger.id || "");
    ids.push(id);
    const rt = typeof triggerRuntimeById !== "undefined" ? triggerRuntimeById.get(id) : null;
    if (rt && rt.runMode === "trade" && rt.phase !== "open" && rt.phase !== "opening") {
      rt.runMode = "demo";
    }
    return normalizeTriggerRecord({ ...trigger, runMode: "demo" });
  });
  if (!ids.length) return 0;
  for (const id of ids) void persistUserTriggerPatch(id, { runMode: "demo" });
  renderTriggersList();
  appendLogEntry({
    level: "info",
    source: "client",
    message: `${ids.length} trigger card${ids.length === 1 ? "" : "s"} moved Trade → Demo (${reason})`,
  });
  scheduleTriggerGtdArming(windowState);
  return ids.length;
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
  invalidateTriggerGtdArmKeys(triggerId);
  scheduleTriggerGtdArming(windowState);
}

function emptyTriggerDemoStats() {
  return { success: 0, fail: 0, blue: 0, takeProfit: 0, stopLoss: 0, pnlUsd: 0 };
}

/** Reset Demo stats only — Trade live totals are never cleared from the card. */
function resetTriggerDemoStats(triggerId) {
  const trigger = findUserTrigger(triggerId);
  if (!trigger) return;
  if (trigger.runMode === "trade") return;
  const label = String(trigger.name || "Untitled trigger");
  if (!window.confirm(`Reset Demo stats for "${label}"?`)) return;
  patchUserTrigger(triggerId, { demoStats: emptyTriggerDemoStats() });
  updateTriggerCardStats(triggerId);
  if (triggerCreateEditingId && String(triggerCreateEditingId) === String(triggerId)) {
    syncTriggerStatsPanel();
  }
}

function closeTriggerMenus() {
  closeSetupMenus();
}

function deleteUserTrigger(trigger) {
  closeTriggerMenus();
  const id = trigger?.id != null ? String(trigger.id) : "";
  if (!id) return;
  const label = String(trigger.name || "Untitled trigger");
  if (!window.confirm(`Delete "${label}"?\n\nThis cannot be undone.`)) return;
  userTriggers = userTriggers.filter((t) => String(t?.id) !== id);
  clearTriggerRuntime(id);
  void fetch(`/api/triggers/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "same-origin",
  }).catch(() => {});
  renderTriggersList();
  if (triggerCreateEditingId && String(triggerCreateEditingId) === id) {
    closeTriggerCreateModal();
  }
}

function newUserTriggerId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `trg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Deep-copy a Market Trigger; always starts Paused / Demo with empty Demo stats. */
function duplicateUserTrigger(trigger) {
  closeTriggerMenus();
  const srcId = trigger?.id != null ? String(trigger.id) : "";
  const src = findUserTrigger(srcId) || trigger;
  if (!src?.id) return null;
  let clone;
  try {
    clone = JSON.parse(JSON.stringify(src));
  } catch {
    return null;
  }
  const now = new Date().toISOString();
  const next = normalizeTriggerRecord({
    ...clone,
    id: newUserTriggerId(),
    runMode: "demo",
    paused: true,
    demoStats: emptyTriggerDemoStats(),
    createdAt: now,
    updatedAt: now,
  });
  if (!next) return null;
  const srcIdx = userTriggers.findIndex((t) => String(t?.id) === String(src.id));
  if (srcIdx >= 0) userTriggers.splice(srcIdx + 1, 0, next);
  else userTriggers = [next, ...userTriggers];
  userTriggers.forEach((t, i) => {
    t.sortOrder = i;
  });
  renderTriggersList();
  void (async () => {
    await persistUserTrigger(next);
    await persistTriggerOrder(userTriggers.map((t) => String(t?.id || "")).filter(Boolean));
  })();
  return next;
}

function renderTriggersList() {
  const empty = $("triggers-empty");
  const cards = $("triggers-cards");
  const body = $("triggers-list");
  if (!cards) return;
  if (triggerReorderState) endTriggerCardReorder(false);
  closeTriggerMenus();
  cards.replaceChildren();
  sortUserTriggersInPlace();
  const list = Array.isArray(userTriggers) ? userTriggers : [];
  if (empty) empty.hidden = list.length > 0;
  window.ScheduleLiveTriggers?.render?.();
  for (const trigger of list) {
    const triggerId = String(trigger.id || "");
    const paused = trigger.paused !== false;
    const runMode = trigger.runMode === "trade" ? "trade" : "demo";
    const card = document.createElement("article");
    card.className = "trigger-card";
    if (paused) card.classList.add("is-paused");
    card.dataset.triggerId = triggerId;
    const color = typeof trigger.color === "string" ? trigger.color : "#58a6ff";
    card.style.setProperty("--trigger-card-color", color);

    const dragHandle = document.createElement("div");
    dragHandle.className = "trigger-card-drag-handle";
    if (isLightHexColor(color)) dragHandle.classList.add("is-light-handle");
    dragHandle.title = "Drag to reorder";
    dragHandle.setAttribute("aria-label", "Drag to reorder trigger");
    dragHandle.innerHTML =
      '<svg viewBox="0 0 8 14" aria-hidden="true">' +
      '<circle cx="2" cy="2" r="1.2" fill="currentColor"/>' +
      '<circle cx="6" cy="2" r="1.2" fill="currentColor"/>' +
      '<circle cx="2" cy="7" r="1.2" fill="currentColor"/>' +
      '<circle cx="6" cy="7" r="1.2" fill="currentColor"/>' +
      '<circle cx="2" cy="12" r="1.2" fill="currentColor"/>' +
      '<circle cx="6" cy="12" r="1.2" fill="currentColor"/>' +
      "</svg>";
    dragHandle.addEventListener("pointerdown", (e) => {
      startTriggerCardReorder(e, card, cards);
    });

    const main = document.createElement("div");
    main.className = "trigger-card-main";

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

      const duplicateBtn = document.createElement("button");
      duplicateBtn.type = "button";
      duplicateBtn.className = "schedule-setup-menu-item";
      duplicateBtn.setAttribute("role", "menuitem");
      duplicateBtn.textContent = "Duplicate";
      duplicateBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        duplicateUserTrigger(trigger);
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

      menu.append(editBtn, duplicateBtn, deleteBtn);
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

    const liveRow = document.createElement("div");
    liveRow.className = "trigger-card-live";
    liveRow.setAttribute("aria-label", "Live trigger buy and sell status");
    liveRow.setAttribute("aria-live", "polite");
    for (const leg of ["buy", "sell"]) {
      const cell = document.createElement("div");
      cell.className = `trigger-card-live-side trigger-card-live-${leg}`;
      cell.dataset.leg = leg;
      cell.innerHTML =
        `<span class="trigger-card-live-label">${leg === "buy" ? "BUY" : "SELL"}</span>` +
        `<span class="trigger-card-live-detail">—</span>`;
      liveRow.appendChild(cell);
    }

    const statsRow = document.createElement("div");
    statsRow.className = "trigger-card-stats";
    statsRow.setAttribute("aria-label", runMode === "trade" ? "Trade stats" : "Demo stats");

    const statsBody = document.createElement("div");
    statsBody.className = "trigger-card-stats-body";
    // Stats dots: Sell (green) / Win (blue) / Loss (red); then Stop Loss + P/L.
    statsBody.innerHTML =
      '<div class="trigger-card-stats-main">' +
      '<span class="trigger-card-stats-counts">' +
      '<span class="trigger-card-stats-item is-count" title="Sell (profitable early exit)"><span class="trigger-card-stats-dot is-success" aria-hidden="true"></span><span class="trigger-card-stats-value" data-stat="takeProfit">0</span></span>' +
      '<span class="trigger-card-stats-item is-count" title="Win (held)"><span class="trigger-card-stats-dot is-held" aria-hidden="true"></span><span class="trigger-card-stats-value" data-stat="blue">0</span></span>' +
      '<span class="trigger-card-stats-item is-count" title="Loss (held)"><span class="trigger-card-stats-dot is-fail" aria-hidden="true"></span><span class="trigger-card-stats-value" data-stat="fail">0</span></span>' +
      "</span>" +
      "</div>" +
      '<div class="trigger-card-stats-exits">' +
      '<span class="trigger-card-stats-item"><span class="trigger-card-stats-label">Stop Loss</span><span class="trigger-card-stats-value" data-stat="stopLoss">0</span></span>' +
      '<span class="trigger-card-stats-pnl" data-stat="pnl" title="P/L">$0.00</span>' +
      "</div>";

    if (runMode === "demo") {
      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "trigger-card-stats-reset";
      resetBtn.title = "Reset Demo stats";
      resetBtn.setAttribute("aria-label", "Reset Demo stats");
      resetBtn.innerHTML =
        '<svg class="schedule-summary-reset-icon" viewBox="0 0 16 16" aria-hidden="true">' +
        '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M2.5 3.5v3h3M13.5 12.5v-3h-3" />' +
        '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M3.2 9.2A5 5 0 0 0 12.5 11M12.8 6.8A5 5 0 0 0 3.5 5" />' +
        "</svg>";
      resetBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        resetTriggerDemoStats(triggerId);
      });
      statsBody.querySelector(".trigger-card-stats-main")?.appendChild(resetBtn);
    }

    statsRow.appendChild(statsBody);

    main.append(header, controls, liveRow, statsRow);
    card.append(dragHandle, main);
    cards.appendChild(card);
    fillTriggerCardStatsRow(statsRow, trigger);
    syncTriggerCardLiveUi(triggerId);
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
    return { success: 0, fail: 0, blue: 0, takeProfit: 0, stopLoss: 0, pnlUsd: 0, pending: false };
  }
  if (trigger.runMode === "trade") {
    const cached = triggerLiveStatsCache[String(trigger.id)];
    if (!cached) {
      return { success: 0, fail: 0, blue: 0, takeProfit: 0, stopLoss: 0, pnlUsd: 0, pending: true };
    }
    return { ...normalizeTriggerDemoStats(cached), pending: false };
  }
  return { ...normalizeTriggerDemoStats(trigger.demoStats), pending: false };
}

function fillTriggerCardStatsRow(statsRow, trigger) {
  if (!statsRow) return;
  const stats = resolveTriggerCardStats(trigger);
  const sellEl = statsRow.querySelector('[data-stat="takeProfit"]');
  const blueEl = statsRow.querySelector('[data-stat="blue"]');
  const failEl = statsRow.querySelector('[data-stat="fail"]');
  const slEl = statsRow.querySelector('[data-stat="stopLoss"]');
  const pnlEl = statsRow.querySelector('[data-stat="pnl"]');
  if (sellEl) sellEl.textContent = stats.pending ? "…" : String(stats.takeProfit ?? 0);
  if (blueEl) blueEl.textContent = stats.pending ? "…" : String(stats.blue ?? 0);
  if (failEl) failEl.textContent = stats.pending ? "…" : String(stats.fail);
  if (slEl) slEl.textContent = stats.pending ? "…" : String(stats.stopLoss);
  if (pnlEl) {
    pnlEl.textContent = stats.pending ? "…" : formatTriggerStatsPnl(stats.pnlUsd);
    const pos = !stats.pending && stats.pnlUsd > 0;
    const neg = !stats.pending && stats.pnlUsd < 0;
    pnlEl.classList.toggle("is-pos", pos);
    pnlEl.classList.toggle("is-neg", neg);
    pnlEl.classList.toggle("is-positive", pos);
    pnlEl.classList.toggle("is-negative", neg);
    pnlEl.classList.toggle("is-neutral", !stats.pending && !pos && !neg);
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
  if (trigger && statsRow) fillTriggerCardStatsRow(statsRow, trigger);
  // Keep Schedule Live Trade+Active list in sync (membership + counters).
  window.ScheduleLiveTriggers?.updateStats?.(id);
  const tradeActive = trigger?.runMode === "trade" && trigger?.paused === false;
  const liveCard = document.querySelector(
    `.schedule-live-trigger-card[data-trigger-id="${CSS.escape(id)}"]`,
  );
  if (Boolean(liveCard) !== Boolean(tradeActive)) {
    window.ScheduleLiveTriggers?.render?.();
  }
}

function formatTriggerLivePriceCents(priceDollars) {
  const n = Number(priceDollars);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}¢`;
}

function clearTriggerCardLiveUiTimer(triggerId) {
  const id = String(triggerId || "");
  const rt = triggerRuntimeById.get(id);
  if (!rt?.liveUiTimer) return;
  clearTimeout(rt.liveUiTimer);
  rt.liveUiTimer = null;
}

/** Visual-only BUY (left) / SELL (right) status on the card (not clickable). */
function syncTriggerCardLiveUi(triggerId) {
  const id = String(triggerId || "");
  const card = document.querySelector(`.trigger-card[data-trigger-id="${CSS.escape(id)}"]`);
  const row = card?.querySelector(".trigger-card-live");
  if (!row) return;
  const rt = triggerRuntimeById.get(id);
  const live = rt?.liveUi && typeof rt.liveUi === "object" ? rt.liveUi : null;
  const side = live?.side === "down" ? "down" : live?.side === "up" ? "up" : null;
  const buy = live?.buy && typeof live.buy === "object" ? live.buy : null;
  const sell = live?.sell && typeof live.sell === "object" ? live.sell : null;

  const buyCell = row.querySelector('.trigger-card-live-side[data-leg="buy"]');
  const sellCell = row.querySelector('.trigger-card-live-side[data-leg="sell"]');
  if (buyCell) {
    const detail = buyCell.querySelector(".trigger-card-live-detail");
    const active = Boolean(buy && side);
    buyCell.classList.toggle("is-live", active);
    buyCell.classList.toggle("is-up", active && side === "up");
    buyCell.classList.toggle("is-down", active && side === "down");
    if (detail) {
      if (!active) {
        detail.textContent = "—";
      } else {
        const px = formatTriggerLivePriceCents(buy.price);
        const sh = Math.max(0, Math.round(Number(buy.shares) || 0));
        detail.textContent = `${side === "down" ? "DOWN" : "UP"} ${px} · ${sh} sh`;
      }
    }
  }
  if (sellCell) {
    const detail = sellCell.querySelector(".trigger-card-live-detail");
    const active = Boolean(sell && side);
    sellCell.classList.toggle("is-live", active);
    sellCell.classList.toggle("is-up", active && side === "up");
    sellCell.classList.toggle("is-down", active && side === "down");
    if (detail) {
      if (!active) {
        detail.textContent = "—";
      } else {
        const px = formatTriggerLivePriceCents(sell.price);
        const sh = Math.max(0, Math.round(Number(sell.shares) || 0));
        detail.textContent = `${px} · ${sh} sh`;
      }
    }
  }
}

function setTriggerCardLiveUi(triggerId, next) {
  const id = String(triggerId || "");
  const rt = getOrCreateTriggerRuntime(id);
  clearTriggerCardLiveUiTimer(id);
  if (!next || (next.side !== "up" && next.side !== "down")) {
    rt.liveUi = null;
    syncTriggerCardLiveUi(id);
    return;
  }
  const side = next.side === "down" ? "down" : "up";
  const fill = {
    price: Number(next.price),
    shares: Math.max(0, Math.round(Number(next.shares) || 0)),
  };
  if (next.leg === "sell") {
    const prevBuy = rt.liveUi?.buy && typeof rt.liveUi.buy === "object" ? rt.liveUi.buy : null;
    rt.liveUi = { side, buy: prevBuy, sell: fill };
  } else {
    rt.liveUi = { side, buy: fill, sell: null };
  }
  syncTriggerCardLiveUi(id);
}

/** After a sell, briefly show the exit on the right then clear so the card re-arms. */
function flashTriggerCardLiveSell(triggerId, side, price, shares) {
  const id = String(triggerId || "");
  const rt = getOrCreateTriggerRuntime(id);
  const prevBuy = rt.liveUi?.buy && typeof rt.liveUi.buy === "object" ? rt.liveUi.buy : null;
  clearTriggerCardLiveUiTimer(id);
  rt.liveUi = {
    side: side === "down" ? "down" : "up",
    buy: prevBuy,
    sell: {
      price: Number(price),
      shares: Math.max(0, Math.round(Number(shares) || 0)),
    },
  };
  syncTriggerCardLiveUi(id);
  rt.liveUiTimer = setTimeout(() => {
    rt.liveUiTimer = null;
    if (rt.liveUi?.sell) {
      rt.liveUi = null;
      syncTriggerCardLiveUi(id);
    }
  }, 1600);
}

function applyTriggerDurationToInputs(ms) {
  const valueEl = $("trigger-duration-value");
  const unitEl = $("trigger-duration-unit");
  if (!valueEl || !unitEl) return;
  const n = normalizeTriggerDurationMs(ms, 5000);
  if (n === 0) {
    valueEl.value = "0";
    if (!(unitEl.value in TRIGGER_DURATION_UNIT_MS)) unitEl.value = "s";
  } else if (n >= 60_000 && n % 60_000 === 0) {
    valueEl.value = String(n / 60_000);
    unitEl.value = "min";
  } else if (n >= 1000 && n % 1000 === 0) {
    valueEl.value = String(n / 1000);
    unitEl.value = "s";
  } else {
    valueEl.value = String(n);
    unitEl.value = "ms";
  }
  syncTriggerDurationDraft();
}

const TRIGGER_WINDOW_AREA_MIN_SPAN = 0.02;
const TRIGGER_WINDOW_THUMB_PX = 12;

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

function triggerWindowThumbLeftCss(frac) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  return `calc(${f} * (100% - ${TRIGGER_WINDOW_THUMB_PX}px))`;
}

function triggerWindowThumbCenterCss(frac) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  return `calc(${f} * (100% - ${TRIGGER_WINDOW_THUMB_PX}px) + ${TRIGGER_WINDOW_THUMB_PX / 2}px)`;
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

function syncTriggerCreateModalChrome() {
  const title = $("trigger-create-modal-title");
  const submit = $("trigger-create-submit");
  const editing = Boolean(triggerCreateEditingId);
  if (title) title.textContent = editing ? "Edit Trigger" : "Create Trigger";
  if (submit) submit.textContent = editing ? "Save" : "Create";
}

function syncTriggerCreateBuySharesDraft() {
  triggerCreateBuyShares = normalizeTriggerBuyShares($("trigger-buy-shares")?.value ?? 10);
  const el = $("trigger-buy-shares");
  if (el && String(el.value) !== String(triggerCreateBuyShares)) {
    el.value = String(triggerCreateBuyShares);
  }
}

function applyTriggerBuySharesToInput(shares) {
  triggerCreateBuyShares = normalizeTriggerBuyShares(shares ?? 10);
  const el = $("trigger-buy-shares");
  if (el) el.value = String(triggerCreateBuyShares);
}

/** Offset 100 = exit path disabled — show Disabled badge + muted label. */
function syncTriggerExitDisabledUi() {
  const syncOne = (fieldId, badgeId, cents) => {
    const field = $(fieldId);
    const badge = $(badgeId);
    const disabled = isTriggerExitDisabled(cents);
    if (field) field.classList.toggle("is-exit-disabled", disabled);
    if (badge) badge.hidden = !disabled;
  };
  syncOne("trigger-take-profit-field", "trigger-take-profit-disabled", triggerCreateTakeProfitCents);
  syncOne("trigger-stop-loss-field", "trigger-stop-loss-disabled", triggerCreateStopLossCents);
}

function syncTriggerCreateSellDraft() {
  triggerCreateTakeProfitCents = clampTriggerOffsetCents($("trigger-take-profit")?.value ?? 10, 10);
  triggerCreateStopLossCents = clampTriggerOffsetCents($("trigger-stop-loss")?.value ?? 10, 10);
  triggerCreateSellOrderType = normalizeTriggerSellOrderType(
    $("trigger-sell-order-type")?.value ?? triggerCreateSellOrderType,
  );
  const tpEl = $("trigger-take-profit");
  const slEl = $("trigger-stop-loss");
  const typeEl = $("trigger-sell-order-type");
  if (tpEl && String(tpEl.value) !== String(triggerCreateTakeProfitCents)) {
    tpEl.value = String(triggerCreateTakeProfitCents);
  }
  if (slEl && String(slEl.value) !== String(triggerCreateStopLossCents)) {
    slEl.value = String(triggerCreateStopLossCents);
  }
  if (typeEl) typeEl.value = triggerCreateSellOrderType;
  syncTriggerExitDisabledUi();
}

function applyTriggerSellToInputs(takeProfitCents, stopLossCents, sellOrderType) {
  triggerCreateTakeProfitCents = clampTriggerOffsetCents(takeProfitCents ?? 10, 10);
  triggerCreateStopLossCents = clampTriggerOffsetCents(stopLossCents ?? 10, 10);
  triggerCreateSellOrderType = normalizeTriggerSellOrderType(sellOrderType ?? "FAK");
  const tpEl = $("trigger-take-profit");
  const slEl = $("trigger-stop-loss");
  const typeEl = $("trigger-sell-order-type");
  if (tpEl) tpEl.value = String(triggerCreateTakeProfitCents);
  if (slEl) slEl.value = String(triggerCreateStopLossCents);
  if (typeEl) typeEl.value = triggerCreateSellOrderType;
  syncTriggerExitDisabledUi();
}

function formatTriggerStatsPnl(pnlUsd) {
  const n = Number(pnlUsd);
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}

/** Share of Win+Loss+Sell+Stop Loss; empty total → 0.0%. One decimal, no integer round. */
function formatTriggerStatsSharePct(count, total) {
  const n = Math.max(0, Math.round(Number(count) || 0));
  const t = Math.max(0, Math.round(Number(total) || 0));
  if (t <= 0) return "0.0%";
  return `${((n / t) * 100).toFixed(1)}%`;
}

function setTriggerStatsPnlChip(elOrId, pnlUsd, clear) {
  const el = typeof elOrId === "string" ? $(elOrId) : elOrId;
  if (!el) return;
  el.classList.remove("is-positive", "is-negative", "is-neutral");
  if (clear) {
    el.textContent = "—";
    return;
  }
  const n = Number(pnlUsd);
  el.textContent = formatTriggerStatsPnl(n);
  if (!Number.isFinite(n)) return;
  if (n > 0) el.classList.add("is-positive");
  else if (n < 0) el.classList.add("is-negative");
  else el.classList.add("is-neutral");
}

const MS_PER_HOUR = 3600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;

function syncTriggerStatsActiveHeading(subTab) {
  const isDemo = subTab === "demo";
  const outcomes = $("trigger-stats-outcomes-table");
  if (outcomes) {
    outcomes.setAttribute(
      "aria-label",
      isDemo ? "Demo Total outcome stats" : "Live Total outcome stats",
    );
  }
  const active = $("trigger-stats-active-table");
  if (active) {
    active.setAttribute(
      "aria-label",
      isDemo ? "Demo Average active time and P/L" : "Live Average active time and P/L",
    );
  }
}

function fillTriggerStatsActiveRows(stats, pending) {
  const setText = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };
  const clearAvg = () => {
    setTriggerStatsPnlChip("trigger-stats-avg-pnl-week", 0, true);
    setTriggerStatsPnlChip("trigger-stats-avg-pnl-day", 0, true);
    setTriggerStatsPnlChip("trigger-stats-avg-pnl-hour", 0, true);
  };
  if (pending) {
    setText("trigger-stats-active-weeks", "…");
    setText("trigger-stats-active-days", "…");
    setText("trigger-stats-active-hours", "…");
    for (const id of [
      "trigger-stats-avg-pnl-week",
      "trigger-stats-avg-pnl-day",
      "trigger-stats-avg-pnl-hour",
    ]) {
      const el = $(id);
      if (el) {
        el.textContent = "…";
        el.classList.remove("is-positive", "is-negative", "is-neutral");
      }
    }
    return;
  }
  const activeMs = stats?.activeMs;
  if (activeMs == null || !Number.isFinite(activeMs) || activeMs < 0) {
    setText("trigger-stats-active-weeks", "—");
    setText("trigger-stats-active-days", "—");
    setText("trigger-stats-active-hours", "—");
    clearAvg();
    return;
  }
  const weeks = activeMs / MS_PER_WEEK;
  const days = activeMs / MS_PER_DAY;
  const hours = activeMs / MS_PER_HOUR;
  setText("trigger-stats-active-weeks", weeks.toFixed(1));
  setText("trigger-stats-active-days", days.toFixed(1));
  setText("trigger-stats-active-hours", hours.toFixed(1));
  const pnl = Number(stats?.pnlUsd);
  const avgOrClear = (id, denom) => {
    if (!Number.isFinite(pnl) || !(denom > 0)) {
      setTriggerStatsPnlChip(id, 0, true);
      return;
    }
    setTriggerStatsPnlChip(id, pnl / denom, false);
  };
  avgOrClear("trigger-stats-avg-pnl-week", weeks);
  avgOrClear("trigger-stats-avg-pnl-day", days);
  avgOrClear("trigger-stats-avg-pnl-hour", hours);
}

function fillTriggerStatsCountRows(stats, pending) {
  const setText = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };
  if (pending) {
    for (const id of [
      "trigger-stats-live-blue",
      "trigger-stats-live-blue-pct",
      "trigger-stats-live-fail",
      "trigger-stats-live-fail-pct",
      "trigger-stats-live-take-profit",
      "trigger-stats-live-take-profit-pct",
      "trigger-stats-live-stop-loss",
      "trigger-stats-live-stop-loss-pct",
      "trigger-stats-live-pnl",
    ]) {
      setText(id, "…");
    }
    const pnlEl = $("trigger-stats-live-pnl");
    if (pnlEl) pnlEl.classList.remove("is-positive", "is-negative", "is-neutral");
    fillTriggerStatsActiveRows(null, true);
    return;
  }
  if (!stats) {
    for (const id of [
      "trigger-stats-live-blue",
      "trigger-stats-live-blue-pct",
      "trigger-stats-live-fail",
      "trigger-stats-live-fail-pct",
      "trigger-stats-live-take-profit",
      "trigger-stats-live-take-profit-pct",
      "trigger-stats-live-stop-loss",
      "trigger-stats-live-stop-loss-pct",
    ]) {
      setText(id, "—");
    }
    setTriggerStatsPnlChip("trigger-stats-live-pnl", 0, true);
    fillTriggerStatsActiveRows(null, false);
    return;
  }
  const win = Math.max(0, Math.round(Number(stats.blue) || 0));
  const loss = Math.max(0, Math.round(Number(stats.fail) || 0));
  const sell = Math.max(0, Math.round(Number(stats.takeProfit) || 0));
  const stopLoss = Math.max(0, Math.round(Number(stats.stopLoss) || 0));
  const total = win + loss + sell + stopLoss;
  setText("trigger-stats-live-blue", String(win));
  setText("trigger-stats-live-blue-pct", formatTriggerStatsSharePct(win, total));
  setText("trigger-stats-live-fail", String(loss));
  setText("trigger-stats-live-fail-pct", formatTriggerStatsSharePct(loss, total));
  setText("trigger-stats-live-take-profit", String(sell));
  setText("trigger-stats-live-take-profit-pct", formatTriggerStatsSharePct(sell, total));
  setText("trigger-stats-live-stop-loss", String(stopLoss));
  setText("trigger-stats-live-stop-loss-pct", formatTriggerStatsSharePct(stopLoss, total));
  setTriggerStatsPnlChip("trigger-stats-live-pnl", stats.pnlUsd, false);
  fillTriggerStatsActiveRows(stats, false);
}

function resolveTriggerStatsDefaultSubTab(trigger) {
  // Pause → Live; Active Demo → Demo; Active Trade → Live.
  if (!trigger) return "live";
  const paused = trigger.paused !== false;
  if (paused) return "live";
  return trigger.runMode === "trade" ? "live" : "demo";
}

function currentTriggerForStatsPanel() {
  if (!triggerCreateEditingId) return null;
  if (triggerCreateHost === "replay") {
    return window.ScheduleReplayTriggers?.find?.(triggerCreateEditingId) || null;
  }
  return userTriggers.find((t) => String(t?.id) === String(triggerCreateEditingId)) || null;
}

function setTriggerCreateStatsSubTab(subTab, { sync = true } = {}) {
  const id = subTab === "demo" ? "demo" : "live";
  triggerCreateStatsSubTab = id;
  const panel = $("trigger-tab-panel-stats");
  if (panel) {
    for (const tab of panel.querySelectorAll("[data-trigger-stats-sub]")) {
      const active = tab.getAttribute("data-trigger-stats-sub") === id;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
    }
  }
  syncTriggerStatsActiveHeading(id);
  if (sync) syncTriggerStatsPanel();
}

function applyDefaultTriggerStatsSubTab() {
  setTriggerCreateStatsSubTab(resolveTriggerStatsDefaultSubTab(currentTriggerForStatsPanel()), {
    sync: false,
  });
}

function syncTriggerStatsPanel() {
  syncTriggerStatsActiveHeading(triggerCreateStatsSubTab);
  const isDemo = triggerCreateStatsSubTab === "demo";

  if (triggerCreateHost === "replay") {
    if (isDemo) {
      const replay = triggerCreateEditingId
        ? window.ScheduleReplayTriggers?.find?.(triggerCreateEditingId)
        : null;
      const stats = normalizeTriggerDemoStats(
        replay?.replayStats || {
          success: 0,
          fail: 0,
          blue: 0,
          takeProfit: 0,
          stopLoss: 0,
          pnlUsd: 0,
        },
      );
      // Replay has no mode timeline; Active stays empty.
      fillTriggerStatsCountRows({ ...stats, activeMs: null }, false);
    } else {
      fillTriggerStatsCountRows(
        { success: 0, fail: 0, blue: 0, takeProfit: 0, stopLoss: 0, pnlUsd: 0, activeMs: 0 },
        false,
      );
    }
    return;
  }

  if (!triggerCreateEditingId) {
    fillTriggerStatsCountRows(
      { success: 0, fail: 0, blue: 0, takeProfit: 0, stopLoss: 0, pnlUsd: 0, activeMs: 0 },
      false,
    );
    return;
  }

  const cached = triggerLiveStatsCache[String(triggerCreateEditingId)];
  if (isDemo) {
    const trigger = currentTriggerForStatsPanel();
    const demo = normalizeTriggerDemoStats(trigger?.demoStats);
    if (!cached) {
      // Outcomes are on the card; Active duration comes from the stats API.
      fillTriggerStatsCountRows({ ...demo, activeMs: null }, false);
      fillTriggerStatsActiveRows(null, true);
      return;
    }
    const demoActiveMs = Number(cached.demoActiveMs);
    fillTriggerStatsCountRows(
      {
        ...demo,
        activeMs: Number.isFinite(demoActiveMs) && demoActiveMs >= 0 ? demoActiveMs : 0,
      },
      false,
    );
    return;
  }

  if (cached) fillTriggerStatsCountRows(cached, false);
  else fillTriggerStatsCountRows(null, true);
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
    applyDefaultTriggerStatsSubTab();
    syncTriggerStatsPanel();
    if (triggerCreateHost !== "replay" && triggerCreateEditingId) {
      void fetchTriggerLiveStats(triggerCreateEditingId).then(() => syncTriggerStatsPanel());
    }
  }
}

function fillTriggerCreateFormFromTrigger(trigger) {
  const nameEl = $("trigger-create-name");
  const colorEl = $("trigger-create-color");
  if (nameEl) nameEl.value = String(trigger?.name || "");
  if (colorEl) colorEl.value = typeof trigger?.color === "string" ? trigger.color : "#58a6ff";
  triggerCreateName = String(trigger?.name || "").trim();
  triggerCreateColor = typeof trigger?.color === "string" ? trigger.color : "#58a6ff";
  triggerCreatePriceSide = "buy";
  triggerCreateStartMode = normalizeTriggerStartMode(trigger?.startMode);
  triggerCreateStartPriceCents = clampTriggerCents(
    trigger?.startPriceCents ??
      (trigger?.startMode === "change-side" ? Math.abs(Number(trigger?.startChangeSideCents)) : 50),
  );
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
  triggerCreateGapMode = normalizeTriggerGapMode(trigger?.gapMode);
  triggerCreateGapSize = {
    start: normalizeTriggerGapSize(trigger?.gapSize?.start),
    end: normalizeTriggerGapSize(trigger?.gapSize?.end),
  };
  triggerCreatePriceTrend = normalizeTriggerPriceTrend(trigger?.priceTrend);
  applyTriggerDurationToInputs(trigger?.durationMs ?? 5000);
  applyTriggerBuySharesToInput(trigger?.buyShares);
  applyTriggerBuyOrderTypeToInput(trigger?.buyOrderType ?? "FOK");
  applyTriggerSellToInputs(
    trigger?.takeProfitCents,
    trigger?.stopLossCents,
    trigger?.sellOrderType,
  );
  triggerCreateWindowArea = normalizeTriggerWindowArea(
    trigger?.windowArea?.start ?? trigger?.windowAreaStart,
    trigger?.windowArea?.end ?? trigger?.windowAreaEnd,
  );
  setTriggerCreateActiveTab("buy");
  applyDefaultTriggerStatsSubTab();
  syncTriggerCreateColorIconContrast();
  syncTriggerCreateSideUi();
  syncTriggerCreateBuyOrderTypeUi();
  syncTriggerCreateSubmitState();
  for (const edge of ["start", "end"]) syncTriggerGapSizeControl(edge);
  syncTriggerPriceTrendControls();
  renderAllTriggerPriceRanges();
  syncTriggerWindowAreaUi();
  syncTriggerStatsPanel();
  // Replay host has no Mongo Trade stats — skip fetch.
  if (triggerCreateHost !== "replay" && trigger?.id) {
    void fetchTriggerLiveStats(trigger.id).then(() => syncTriggerStatsPanel());
  }
}

function buildTriggerFromCreateDraft() {
  syncTriggerCreateNameDraft();
  syncTriggerCreateColorDraft();
  syncTriggerDurationDraft();
  syncTriggerCreateBuySharesDraft();
  syncTriggerCreateBuyOrderTypeDraft();
  syncTriggerCreateSellDraft();
  const name = triggerCreateName;
  if (!name) return null;
  const startMode = normalizeTriggerStartMode(triggerCreateStartMode);
  const endMode = normalizeTriggerEndMode(triggerCreateEndMode);
  const existing =
    triggerCreateEditingId != null
      ? triggerCreateHost === "replay"
        ? window.ScheduleReplayTriggers?.find?.(triggerCreateEditingId)
        : userTriggers.find((t) => String(t?.id) === String(triggerCreateEditingId))
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
    buyShares: normalizeTriggerBuyShares(triggerCreateBuyShares),
    priceSide: "buy",
    startMode,
    startPriceCents: clampTriggerCents(triggerCreateStartPriceCents),
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
    gapMode: normalizeTriggerGapMode(triggerCreateGapMode),
    gapSize: {
      start: normalizeTriggerGapSize(triggerCreateGapSize.start),
      end: normalizeTriggerGapSize(triggerCreateGapSize.end),
    },
    priceTrend: normalizeTriggerPriceTrend(triggerCreatePriceTrend),
    takeProfitCents: clampTriggerOffsetCents(triggerCreateTakeProfitCents, 10),
    stopLossCents: clampTriggerOffsetCents(triggerCreateStopLossCents, 10),
    buyOrderType: normalizeTriggerBuyOrderType(
      triggerCreateBuyOrderType,
      triggerCreateDurationMs,
      startMode,
      triggerCreatePtbGap,
    ),
    sellOrderType: normalizeTriggerSellOrderType(triggerCreateSellOrderType),
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
  // Replay Triggers stay browser-local (ScheduleReplayTriggers / localStorage).
  if (triggerCreateHost === "replay") {
    window.ScheduleReplayTriggers?.upsert?.(trigger);
    closeTriggerCreateModal();
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
  renderTriggersList();
  closeTriggerCreateModal();
  void persistUserTrigger(trigger);
  invalidateTriggerGtdArmKeys(trigger.id);
  scheduleTriggerGtdArming(windowState);
}

function syncTriggerCreateColorDraft() {
  const colorInput = $("trigger-create-color");
  triggerCreateColor = colorInput?.value || "#58a6ff";
  syncTriggerCreateColorIconContrast();
}

function syncTriggerCreateSideUi() {
  // Editor is BUY-only (Ask quotes). Left: UP/DOWN Range / Price; right: UP/DOWN Range / Change.
  triggerCreatePriceSide = "buy";
  const startMode = normalizeTriggerStartMode(triggerCreateStartMode);
  const endMode = normalizeTriggerEndMode(triggerCreateEndMode);
  const startEl = $("trigger-start-mode");
  const endEl = $("trigger-end-mode");

  if (startEl) {
    startEl.value = startMode;
    startEl.classList.add("is-buy");
    startEl.classList.remove("is-sell");
  }
  if (endEl) {
    endEl.value = endMode;
    endEl.classList.add("is-buy");
    endEl.classList.remove("is-sell");
  }

  document.querySelectorAll(".trigger-price-column").forEach((col) => {
    col.classList.add("is-buy");
    col.classList.remove("is-sell");
  });
  renderTriggerPriceRange("start");
  renderTriggerPriceRange("end");
}

function syncTriggerCreateStartModeDraft() {
  const el = $("trigger-start-mode");
  triggerCreateStartMode = normalizeTriggerStartMode(el?.value);
  syncTriggerCreateSideUi();
  syncTriggerCreateBuyOrderTypeUi();
  renderTriggerPtbGapUi();
}

function syncTriggerCreateEndModeDraft() {
  triggerCreateEndMode = normalizeTriggerEndMode($("trigger-end-mode")?.value);
  syncTriggerCreateSideUi();
  renderAllTriggerPriceRanges();
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
  triggerCreateStartMode = "range";
  triggerCreateStartPriceCents = 50;
  triggerCreateEndMode = "range";
  triggerCreateEndChangeSideCents = 20;
  triggerCreatePriceRanges = {
    start: { lowCents: 40, highCents: 70 },
    end: { lowCents: 40, highCents: 70 },
  };
  triggerCreatePtbGap = { start: null, end: null };
  triggerCreateGapMode = "fixed";
  triggerCreateGapSize = {
    start: { bound: "min", value: 0 },
    end: { bound: "min", value: 0 },
  };
  triggerCreatePriceTrend = { dollars: 0, bound: "min" };
  applyTriggerBuySharesToInput(10);
  applyTriggerBuyOrderTypeToInput("FOK");
  applyTriggerSellToInputs(10, 10, "FAK");
  triggerCreateWindowArea = { start: 0, end: 1 };
  setTriggerCreateActiveTab("buy");
  applyDefaultTriggerStatsSubTab();
  syncTriggerCreateColorIconContrast();
  syncTriggerCreateSideUi();
  syncTriggerZeroDurationUi();
  syncTriggerCreateBuyOrderTypeUi();
  syncTriggerCreateSubmitState();
  for (const edge of ["start", "end"]) syncTriggerGapSizeControl(edge);
  syncTriggerPriceTrendControls();
  renderAllTriggerPriceRanges();
  syncTriggerWindowAreaUi();
  syncTriggerStatsPanel();
}

function openTriggerCreateModal() {
  openTriggerCreateModalForHost("market");
}

function openTriggerCreateModalForHost(host) {
  const modal = $("trigger-create-modal");
  if (!modal) return;
  triggerCreateHost = host === "replay" ? "replay" : "market";
  triggerCreateEditingId = null;
  resetTriggerCreateForm();
  closeTriggerOrderTypeInfoPanels();
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
  openTriggerEditModalForHost("market", trigger);
}

function openTriggerEditModalForHost(host, trigger) {
  const modal = $("trigger-create-modal");
  if (!modal || !trigger?.id) return;
  closeTriggerMenus();
  triggerCreateHost = host === "replay" ? "replay" : "market";
  triggerCreateEditingId = String(trigger.id);
  fillTriggerCreateFormFromTrigger(trigger);
  closeTriggerOrderTypeInfoPanels();
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

function setTriggerOrderTypeInfoOpen(side, open) {
  const btn = $(side === "sell" ? "trigger-sell-order-info-btn" : "trigger-buy-order-info-btn");
  const panel = $(side === "sell" ? "trigger-sell-order-note" : "trigger-buy-order-note");
  if (panel) {
    panel.classList.toggle("is-open", open);
    panel.setAttribute("aria-hidden", open ? "false" : "true");
  }
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
}

function closeTriggerOrderTypeInfoPanels() {
  setTriggerOrderTypeInfoOpen("buy", false);
  setTriggerOrderTypeInfoOpen("sell", false);
}

function toggleTriggerOrderTypeInfo(side) {
  const panel = $(side === "sell" ? "trigger-sell-order-note" : "trigger-buy-order-note");
  if (!panel) return;
  const willOpen = !panel.classList.contains("is-open");
  setTriggerOrderTypeInfoOpen(side === "sell" ? "buy" : "sell", false);
  setTriggerOrderTypeInfoOpen(side, willOpen);
}

function closeTriggerCreateModal() {
  const modal = $("trigger-create-modal");
  if (!modal) return;
  closeTriggerOrderTypeInfoPanels();
  modal.hidden = true;
  triggerCreateEditingId = null;
  triggerCreateHost = "market";
  syncTriggerCreateModalChrome();
}

window.openTriggerCreateModalForHost = openTriggerCreateModalForHost;
window.openTriggerEditModalForHost = openTriggerEditModalForHost;
window.findUserTrigger = findUserTrigger;
window.listMarketTriggersForSchedule = () =>
  Array.isArray(userTriggers) ? userTriggers.slice() : [];
window.fillTriggerCardStatsRow = fillTriggerCardStatsRow;
window.fetchTriggerLiveStats = fetchTriggerLiveStats;

function bindTriggerCreateModal() {
  void loadUserTriggers().then(() => {
    renderTriggersList();
    scheduleTriggerGtdArming(windowState);
  });
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
  const statsSubTabs = $("trigger-tab-panel-stats")?.querySelector(".trigger-stats-subtabs");
  statsSubTabs?.addEventListener("click", (e) => {
    const tab = e.target.closest?.("[data-trigger-stats-sub]");
    if (!tab || !statsSubTabs.contains(tab)) return;
    setTriggerCreateStatsSubTab(tab.getAttribute("data-trigger-stats-sub"));
  });
  statsSubTabs?.addEventListener("keydown", (e) => {
    const current = e.target.closest?.("[data-trigger-stats-sub]");
    if (!current || !statsSubTabs.contains(current)) return;
    const tabs = [...statsSubTabs.querySelectorAll("[data-trigger-stats-sub]")];
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
    setTriggerCreateStatsSubTab(next.getAttribute("data-trigger-stats-sub"));
    next.focus();
  });
  $("trigger-create-name")?.addEventListener("input", () => {
    syncTriggerCreateNameDraft();
  });
  $("trigger-create-color")?.addEventListener("input", () => {
    syncTriggerCreateColorDraft();
  });
  $("trigger-buy-shares")?.addEventListener("input", () => {
    syncTriggerCreateBuySharesDraft();
  });
  $("trigger-buy-shares")?.addEventListener("change", () => {
    syncTriggerCreateBuySharesDraft();
  });
  $("trigger-buy-order-type")?.addEventListener("change", () => {
    syncTriggerCreateBuyOrderTypeDraft();
  });
  $("trigger-buy-order-info-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    toggleTriggerOrderTypeInfo("buy");
  });
  $("trigger-sell-order-type")?.addEventListener("change", () => {
    syncTriggerCreateSellDraft();
  });
  $("trigger-sell-order-info-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    toggleTriggerOrderTypeInfo("sell");
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
  $("trigger-start-mode")?.addEventListener("change", () => {
    syncTriggerCreateStartModeDraft();
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
  bindTriggerPriceTrendControls();
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

function syncSetupSaveSubmitState() {
  const title = $("setup-save-title")?.value?.trim() ?? "";
  const btn = $("setup-save-submit");
  if (btn) btn.disabled = !title;
}

function openSetupSaveModal() {
  if (window.SetupEditor?.openCreate) {
    window.SetupEditor.openCreate();
    return;
  }
  const modal = $("setup-save-modal");
  const titleInput = $("setup-save-title");
  const descInput = $("setup-save-description");
  if (!modal || !titleInput) return;
  titleInput.value = "";
  if (descInput) descInput.value = "";
  syncSetupSaveSubmitState();
  modal.hidden = false;
  titleInput.focus();
}

function closeSetupSaveModal() {
  const modal = $("setup-save-modal");
  if (modal) modal.hidden = true;
}

async function saveTradingSetup() {
  const titleInput = $("setup-save-title");
  const descInput = $("setup-save-description");
  if (!titleInput) return;

  const title = titleInput.value.trim();
  if (!title) return;

  const description = descInput?.value?.trim() ?? "";
  closeSetupSaveModal();

  try {
    if (window.Simulator?.pushSetupToServer) {
      await window.Simulator.pushSetupToServer();
    }

    const res = await fetch(withScheduleWorkspaceMode("/api/trading-setups"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description: description || undefined,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Save failed (${res.status})`);
    }

    appendLogEntry({
      level: "success",
      source: "sim",
      message: `Trading setup saved: "${title}"`,
    });
    if (!$("page-schedule-heatmap")?.hidden) {
      void loadScheduleSetups();
    }
  } catch (err) {
    appendLogEntry({
      level: "error",
      source: "sim",
      message: `Failed to save trading setup: ${err.message || err}`,
    });
  }
}

let openSetupMenuId = null;

function formatSetupListTitle(title, count) {
  return `(${count}) ${title}`;
}

function getSetupPlacementCounts() {
  return window.SchedulePlacements?.getPlacementCountsBySetup?.() ?? {};
}

function updateSetupListPlacementCounts() {
  const counts = getSetupPlacementCounts();
  document.querySelectorAll(".schedule-setup-item").forEach((item) => {
    const setupId = item.dataset.setupId;
    const setup = scheduleSetupsCache.find((s) => s._id === setupId);
    if (!setup) return;
    const titleEl = item.querySelector(".schedule-setup-item-title");
    if (titleEl) {
      titleEl.textContent = formatSetupListTitle(setup.title, counts[setupId] ?? 0);
    }
  });
}

window.updateSetupListPlacementCounts = updateSetupListPlacementCounts;

function applySetupColorStyle(el, color) {
  if (!el || !color) return;
  el.style.setProperty("--setup-color", color);
}

function getSetupColorById(setupId) {
  const setup = scheduleSetupsCache.find((s) => s._id === setupId);
  return setup?.color || "#58a6ff";
}

function applySetupColorUpdate(setupId, color) {
  if (!setupId || !color) return;
  const idx = scheduleSetupsCache.findIndex((s) => s._id === setupId);
  if (idx >= 0) {
    scheduleSetupsCache[idx] = { ...scheduleSetupsCache[idx], color };
  }
  const listItem = document.querySelector(`.schedule-setup-item[data-setup-id="${setupId}"]`);
  applySetupColorStyle(listItem, color);
  document.querySelectorAll(`.schedule-placement-card[data-setup-id="${setupId}"]`).forEach((card) => {
    applySetupColorStyle(card, color);
  });
}

window.applySetupColorUpdate = applySetupColorUpdate;
window.getSetupColorById = getSetupColorById;
window.getSelectedSeries = () => selectedSeries;
window.getScheduleSetupById = (setupId) => scheduleSetupsCache.find((s) => s._id === setupId) ?? null;
window.getSimLatencyMs = () => {
  const ms = window.windowState?.feedLatencyMs;
  if (Number.isFinite(ms)) return Math.max(0, Math.round(ms));
  const setupMs = window.windowState?.sim?.setup?.latencyMs;
  return Number.isFinite(setupMs) ? setupMs : 150;
};

window.getLiveFillSuccessPct = () => {
  const rate = window.windowState?.trading?.fillSuccess?.ratePct;
  if (typeof rate === "number" && Number.isFinite(rate)) {
    return Math.max(0, Math.min(100, rate));
  }
  if (typeof window.__liveFillSuccessPct === "number" && Number.isFinite(window.__liveFillSuccessPct)) {
    return Math.max(0, Math.min(100, window.__liveFillSuccessPct));
  }
  return null;
};

function closeSetupMenus() {
  openSetupMenuId = null;
  openTriggerMenuId = null;
  document.querySelectorAll(".schedule-setup-menu").forEach((m) => m.remove());
}

function positionSetupMenu(menu, anchor) {
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
}

async function afterTradingSetupChange(updatedSetup) {
  if (updatedSetup?._id) {
    const idx = scheduleSetupsCache.findIndex((s) => s._id === updatedSetup._id);
    if (idx >= 0) {
      scheduleSetupsCache[idx] = updatedSetup;
    } else {
      scheduleSetupsCache.unshift(updatedSetup);
    }
    renderScheduleSetupsList(scheduleSetupsCache);
    if (updatedSetup.color && window.applySetupColorUpdate) {
      window.applySetupColorUpdate(updatedSetup._id, updatedSetup.color);
    }
  } else {
    await loadScheduleSetups();
  }
  if (window.SchedulePlacements) {
    await window.SchedulePlacements.loadPlacements({ reloadStats: false });
  }
  if (updatedSetup?._id && window.SchedulePlacements?.refreshSetupPlacementStats) {
    void window.SchedulePlacements.refreshSetupPlacementStats(updatedSetup._id, { force: true });
  } else if (!updatedSetup?._id && window.SchedulePlacements?.refreshAllPlacementStats) {
    void window.SchedulePlacements.refreshAllPlacementStats();
  }
}

window.onTradingSetupUpdated = afterTradingSetupChange;
window.refreshScheduleSetupsList = () => loadScheduleSetups();
window.applyScheduleSetupsOrder = (setups) => {
  if (!Array.isArray(setups)) return;
  scheduleSetupsCache = setups;
};

async function removeSetupListItem(setupId) {
  if (!setupId) return;
  scheduleSetupsCache = scheduleSetupsCache.filter((s) => s._id !== setupId);
  const list = $("schedule-setups-list");
  if (!list) return;

  const item = list.querySelector(
    `.schedule-setup-item[data-setup-id="${CSS.escape(String(setupId))}"]`,
  );
  if (!item) {
    if (!list.querySelector(".schedule-setup-item")) {
      list.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "schedule-setups-empty";
      empty.textContent = "No saved setups";
      list.appendChild(empty);
    }
    window.updateSetupListPlacementCounts?.();
    return;
  }

  const gapRaw = getComputedStyle(list).getPropertyValue("--setup-list-gap").trim();
  const gapPx = Number.parseFloat(gapRaw) || 6;
  const height = item.getBoundingClientRect().height;

  item.classList.add("is-removing");
  item.style.boxSizing = "border-box";
  item.style.height = `${Math.max(0, height)}px`;
  item.style.marginBottom = "0px";
  void item.offsetHeight;

  item.style.height = "0px";
  item.style.opacity = "0";
  item.style.marginBottom = `-${gapPx}px`;
  item.style.borderColor = "transparent";

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      item.removeEventListener("transitionend", onEnd);
      window.clearTimeout(fallback);
      item.remove();
      resolve();
    };
    const onEnd = (e) => {
      if (e.target !== item) return;
      if (e.propertyName !== "height") return;
      finish();
    };
    item.addEventListener("transitionend", onEnd);
    const fallback = window.setTimeout(finish, 280);
  });

  if (!list.querySelector(".schedule-setup-item")) {
    list.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "schedule-setups-empty";
    empty.textContent = "No saved setups";
    list.appendChild(empty);
  }
  window.updateSetupListPlacementCounts?.();
}

const SETUP_DELETE_CAN_SVG =
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

function setSetupListItemDeleting(setupId, deleting) {
  const item = document.querySelector(
    `.schedule-setup-item[data-setup-id="${CSS.escape(String(setupId))}"]`,
  );
  if (!item) return null;
  item.classList.toggle("is-deleting", deleting);
  item.classList.toggle("is-light-setup", false);
  item.querySelector(".schedule-setup-loading--delete")?.remove();
  if (!deleting) return item;
  const color =
    getComputedStyle(item).getPropertyValue("--setup-color").trim() ||
    getSetupColorById(setupId) ||
    "#58a6ff";
  item.classList.toggle("is-light-setup", isLightHexColor(color));
  const overlay = document.createElement("div");
  overlay.className = "schedule-setup-loading--delete";
  overlay.setAttribute("aria-hidden", "true");
  const can = document.createElement("span");
  can.className = "schedule-delete-can";
  can.innerHTML = SETUP_DELETE_CAN_SVG;
  overlay.appendChild(can);
  item.appendChild(overlay);
  void item.offsetWidth;
  return item;
}

async function deleteTradingSetup(setup) {
  closeSetupMenus();
  if (!setup?._id) return;

  const setupId = String(setup._id);
  const item = document.querySelector(
    `.schedule-setup-item[data-setup-id="${CSS.escape(setupId)}"]`,
  );
  if (item?.classList.contains("is-deleting")) return;

  // Count from in-memory placements and from DOM cards (belt-and-suspenders —
  // list titles / active cards can disagree with one source alone).
  const memoryPlacements =
    window.SchedulePlacements?.getPlacementsForSetup?.(setupId) ?? [];
  const domCardCount = document.querySelectorAll(
    `.schedule-placement-card[data-setup-id="${CSS.escape(setupId)}"]`,
  ).length;
  const placementCount = Math.max(memoryPlacements.length, domCardCount);
  const lockedCount =
    window.SchedulePlacements?.getLockedCountForSetup?.(setupId) ??
    [...document.querySelectorAll(
      `.schedule-placement-card[data-setup-id="${CSS.escape(setupId)}"].is-locked`,
    )].length;
  const onSchedule =
    placementCount > 0 ||
    lockedCount > 0 ||
    setup.liveScheduleInUse === true ||
    item?.classList.contains("is-in-use") === true;

  let message = `Delete "${setup.title}"?\n\nThis cannot be undone.`;
  if (onSchedule) {
    const count = Math.max(placementCount, lockedCount, 1);
    const lockedNote =
      lockedCount > 0
        ? `\n${lockedCount} of those card${lockedCount === 1 ? " is" : "s are"} locked (already traded).`
        : "";
    message = `Delete "${setup.title}"?\n\nIt is placed on the schedule (${count} card${count === 1 ? "" : "s"}). Those will be removed and this cannot be undone.${lockedNote}`;
  }
  if (!window.confirm(message)) return;

  setSetupListItemDeleting(setup._id, true);
  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });

  try {
    const res = await fetch(withScheduleWorkspaceMode(`/api/trading-setups/${encodeURIComponent(setup._id)}`), {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 204) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Delete failed (${res.status})`);
    }
    // Surgical: animate list row closed, then drop schedule cards. No full rebuild.
    await removeSetupListItem(setup._id);
    window.SchedulePlacements?.removePlacementsForSetup?.(setup._id);
  } catch (err) {
    setSetupListItemDeleting(setup._id, false);
    appendLogEntry({
      level: "error",
      source: "sim",
      message: `Failed to delete trading setup: ${err.message || err}`,
    });
  }
}

function openSetupEditor(setup) {
  closeSetupMenus();
  if (window.SetupEditor) window.SetupEditor.open(setup);
}

function switchToPage(page) {
  if (page === "settings") {
    const settingsBtn = $("settings-page-btn");
    if (settingsBtn && !settingsBtn.classList.contains("is-active")) settingsBtn.click();
    return;
  }
  const btn = document.querySelector(`.page-toggle-btn[data-page="${page}"]`);
  if (btn && !btn.classList.contains("is-active")) btn.click();
}

async function duplicateTradingSetup(setup) {
  closeSetupMenus();
  if (!setup?.setup) return;
  try {
    const res = await fetch(withScheduleWorkspaceMode("/api/trading-setups"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `${setup.title} (Duplicated)`,
        description: setup.description || undefined,
        setup: JSON.parse(JSON.stringify(setup.setup)),
      }),
    });
    const saved = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(saved.error || `Duplicate failed (${res.status})`);
    }
    await afterTradingSetupChange(saved);
    appendLogEntry({
      level: "success",
      source: "sim",
      message: `Duplicated setup: "${saved.title}"`,
    });
  } catch (err) {
    appendLogEntry({
      level: "error",
      source: "sim",
      message: `Failed to duplicate setup: ${err.message || err}`,
    });
  }
}

async function applySetupToSimulator(setup) {
  closeSetupMenus();
  if (!setup?.setup) return;
  try {
    const useScheduleInput = $("use-schedule");
    if (useScheduleInput?.checked) {
      useScheduleInput.checked = false;
      const config = await pushTradingConfig(buildTradingConfigPatch());
      if (config) syncWalletControls(config);
    }
    const currentRes = await fetch("/api/sim/setup");
    const current = currentRes.ok ? await currentRes.json() : {};
    const latencyMs = window.getSimLatencyMs?.() ?? current.latencyMs ?? 150;
    const res = await fetch("/api/sim/setup", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phaseSplit: setup.setup.phaseSplit,
        phases: setup.setup.phases,
        latencyMs,
        feeParams: current.feeParams,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || `Apply failed (${res.status})`);
    }
    if (windowState?.sim) {
      windowState.sim.setup = body;
      if (window.Simulator?.forceSyncSetupFromState) {
        window.Simulator.forceSyncSetupFromState(windowState);
      } else if (window.Simulator) {
        window.Simulator.syncFromState(windowState);
      }
    }
    syncLatencyDisplay(windowState);
    switchToPage("simulator");
    if (windowState) {
      resizeChartCanvas();
      drawPriceChart(windowState);
    }
    appendLogEntry({
      level: "success",
      source: "sim",
      message: `Applied "${setup.title}" to simulator`,
    });
  } catch (err) {
    appendLogEntry({
      level: "error",
      source: "sim",
      message: `Failed to apply setup to simulator: ${err.message || err}`,
    });
  }
}

function bindSetupListMenus() {
  document.addEventListener("click", (e) => {
    if (
      !e.target.closest(".schedule-setup-menu-btn") &&
      !e.target.closest(".schedule-setup-menu")
    ) {
      closeSetupMenus();
    }
  });
}

function bindSetupSaveModal() {
  $("graph-save-btn")?.addEventListener("click", () => {
    if ($("graph-save-btn")?.hidden) return;
    openSetupSaveModal();
  });
  $("schedule-add-setup-btn")?.addEventListener("click", () => {
    openSetupSaveModal();
  });
  $("setup-save-modal-close")?.addEventListener("click", closeSetupSaveModal);
  $("setup-save-cancel")?.addEventListener("click", closeSetupSaveModal);
  $("setup-save-submit")?.addEventListener("click", () => void saveTradingSetup());
  $("setup-save-title")?.addEventListener("input", syncSetupSaveSubmitState);
  $("setup-save-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "setup-save-modal") closeSetupSaveModal();
  });
}

function renderScheduleSetupsList(setups, _errorMessage) {
  // Phase setups UI removed — left column is Triggers only.
  const list = $("schedule-setups-list");
  if (list) {
    list.innerHTML = "";
    list.hidden = true;
    list.setAttribute("aria-hidden", "true");
  }
  if (window.SchedulePlacements) {
    window.SchedulePlacements.onSetupsRendered(Array.isArray(setups) ? setups : []);
  }
}

async function loadScheduleSetups(options = {}) {
  const expectedMode = options.expectedMode || getScheduleWorkspaceMode();
  try {
    const res = await fetch(withScheduleWorkspaceMode("/api/trading-setups"));
    if (getScheduleWorkspaceMode() !== expectedMode) return;
    if (!res.ok) {
      scheduleSetupsCache = [];
      renderScheduleSetupsList([]);
      return;
    }
    const setups = await res.json();
    if (getScheduleWorkspaceMode() !== expectedMode) return;
    scheduleSetupsCache = Array.isArray(setups) ? setups : [];
    renderScheduleSetupsList(scheduleSetupsCache);
  } catch {
    if (getScheduleWorkspaceMode() !== expectedMode) return;
    scheduleSetupsCache = [];
    renderScheduleSetupsList([]);
  }
}

function initScheduleUtcColumn() {
  const body = document.querySelector(".schedule-utc-body");
  if (!body || body.children.length > 0) return;
  for (let hour = 0; hour < 24; hour++) {
    const slot = document.createElement("div");
    slot.className = "schedule-utc-hour";
    slot.dataset.hour = String(hour);
    slot.textContent = `${String(hour).padStart(2, "0")}:00`;
    body.appendChild(slot);
  }
}

function ensureHeatmapNoRecordingsLabel(slot) {
  if (!slot || slot.querySelector(".schedule-heatmap-no-recordings")) return;
  const label = document.createElement("div");
  label.className = "schedule-heatmap-no-recordings";
  label.textContent = "No Recordings";
  slot.appendChild(label);
}

function initScheduleDaySlots() {
  const bodies = document.querySelectorAll(".schedule-day-body");
  for (const body of bodies) {
    const firstSlot = body.querySelector(".schedule-hour-slot");
    if (firstSlot && !firstSlot.querySelector(".schedule-heatmap-row")) {
      body.replaceChildren();
    }
    if (body.children.length > 0) {
      body.querySelectorAll(".schedule-hour-slot").forEach(ensureHeatmapNoRecordingsLabel);
      continue;
    }
    for (let hour = 0; hour < 24; hour++) {
      const slot = document.createElement("div");
      slot.className = "schedule-hour-slot";
      slot.dataset.hour = String(hour);

      const row = document.createElement("div");
      row.className = "schedule-heatmap-row";
      for (const metric of getHeatmapMetrics()) {
        const cell = document.createElement("div");
        cell.className = "schedule-heatmap-cell";
        cell.dataset.metric = metric.key;
        const valueEl = document.createElement("span");
        valueEl.className = "schedule-heatmap-value";
        cell.appendChild(valueEl);
        row.appendChild(cell);
      }
      slot.appendChild(row);
      ensureHeatmapNoRecordingsLabel(slot);
      body.appendChild(slot);
    }
  }
  initHeatmapCellIndex();
}

function isHeatmapViewActive() {
  return $("page-schedule-heatmap")?.classList.contains("is-heatmap-view") ?? false;
}

function formatHeatmapValue(value, hasData) {
  if (!hasData || !Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (Math.abs(value - Math.round(value)) < 0.05) return String(Math.round(value));
  return value.toFixed(1);
}

function clearHeatmapDisplay() {
  for (const cell of heatmapCellEls.values()) {
    cell.style.backgroundColor = "transparent";
    const valueEl = cell.querySelector(".schedule-heatmap-value");
    if (valueEl) {
      valueEl.textContent = "";
      valueEl.classList.remove("is-empty");
    }
  }
  document.querySelectorAll(".schedule-hour-slot.is-heatmap-empty").forEach((slot) => {
    slot.classList.remove("is-heatmap-empty");
  });
}

function initHeatmapCellIndex() {
  heatmapCellEls = new Map();
  document.querySelectorAll(".schedule-day-column").forEach((col) => {
    const day = col.dataset.day;
    if (!day) return;
    col.querySelectorAll(".schedule-hour-slot").forEach((slot) => {
      const hour = slot.dataset.hour;
      if (hour == null) return;
      slot.querySelectorAll(".schedule-heatmap-cell").forEach((cell) => {
        const metric = cell.dataset.metric;
        if (!metric) return;
        heatmapCellEls.set(`${day}:${hour}:${metric}`, cell);
      });
    });
  });
}

function heatmapOpacity(value, max) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, value / max);
}

function renderHeatmap(state) {
  if (!state?.cells || !state?.max) return;
  lastHeatmapState = state;

  document.querySelectorAll(".schedule-day-column").forEach((col) => {
    const day = col.dataset.day;
    if (!day) return;
    for (let hour = 0; hour < 24; hour++) {
      const slot = col.querySelector(`.schedule-hour-slot[data-hour="${hour}"]`);
      if (!slot) continue;
      ensureHeatmapNoRecordingsLabel(slot);
      const hasData = Boolean(state.cells[`${day}:${hour}`]);
      slot.classList.toggle("is-heatmap-empty", !hasData);
    }
  });

  for (const metric of getHeatmapMetrics()) {
    const max = state.max[metric.key] ?? 0;
    const rgb = metric.rgb;

    document.querySelectorAll(".schedule-day-column").forEach((col) => {
      const day = col.dataset.day;
      if (!day) return;
      for (let hour = 0; hour < 24; hour++) {
        const cell = heatmapCellEls.get(`${day}:${hour}:${metric.key}`);
        if (!cell) continue;
        const bucket = state.cells[`${day}:${hour}`];
        const hasData = Boolean(bucket);
        const value = bucket?.[metric.key] ?? 0;
        const alpha = hasData ? heatmapOpacity(value, max) : 0;
        cell.style.backgroundColor = alpha > 0 ? `rgba(${rgb}, ${alpha})` : "transparent";
        const valueEl = cell.querySelector(".schedule-heatmap-value");
        if (valueEl) {
          valueEl.textContent = hasData ? formatHeatmapValue(value, true) : "";
          valueEl.classList.toggle("is-empty", !hasData);
        }
      }
    });
  }
}

async function loadHeatmap() {
  try {
    const res = await fetch(`/api/heatmap?series=${encodeURIComponent(selectedSeries)}`);
    if (!res.ok) return;
    const state = await res.json();
    renderHeatmap(state);
    window.SchedulePlacements?.onHeatmapUpdated?.(state);
  } catch {
    // ignore
  }
}

function syncHeatmapColumnOrder() {
  const metrics = getHeatmapMetrics();
  document.querySelectorAll(".schedule-heatmap-row").forEach((row) => {
    for (const metric of metrics) {
      const cell = row.querySelector(
        `.schedule-heatmap-cell[data-metric="${CSS.escape(metric.key)}"]`,
      );
      if (cell) row.appendChild(cell);
    }
  });
}

function applyHeatmapMetricOrderFromLegend(legend) {
  if (!legend) return;
  const next = [...legend.querySelectorAll(".heatmap-legend-item")]
    .map((el) => el.dataset.metric)
    .filter((key) => Boolean(HEATMAP_METRIC_BY_KEY[key]));
  if (next.length === 0) return;
  persistHeatmapMetricOrder(next);
  syncHeatmapColumnOrder();
  if (lastHeatmapState) renderHeatmap(lastHeatmapState);
}

function endHeatmapLegendDrag(commit) {
  if (!heatmapLegendDrag) return;
  const { item, legend, placeholder, originOrder } = heatmapLegendDrag;
  heatmapLegendDrag = null;
  document.body.classList.remove("is-heatmap-legend-reordering");
  window.removeEventListener("pointermove", onHeatmapLegendPointerMove);
  window.removeEventListener("pointerup", onHeatmapLegendPointerUp);
  window.removeEventListener("pointercancel", onHeatmapLegendPointerUp);

  item.classList.remove("is-legend-reordering");
  item.style.width = "";
  item.style.left = "";
  item.style.top = "";
  item.style.zIndex = "";

  if (placeholder?.parentNode) {
    placeholder.parentNode.insertBefore(item, placeholder);
    placeholder.remove();
  } else if (item.parentNode !== legend) {
    legend.appendChild(item);
  }

  if (commit) {
    applyHeatmapMetricOrderFromLegend(legend);
  } else {
    // Restore original DOM order.
    const byKey = new Map(
      [...legend.querySelectorAll(".heatmap-legend-item")].map((el) => [el.dataset.metric, el]),
    );
    for (const key of originOrder) {
      const el = byKey.get(key);
      if (el) legend.appendChild(el);
    }
  }
}

function onHeatmapLegendPointerMove(e) {
  if (!heatmapLegendDrag) return;
  const { item, legend, placeholder, offsetX, offsetY } = heatmapLegendDrag;
  item.style.left = `${e.clientX - offsetX}px`;
  item.style.top = `${e.clientY - offsetY}px`;

  const siblings = [...legend.querySelectorAll(".heatmap-legend-item")].filter((el) => el !== item);
  let inserted = false;
  for (const sibling of siblings) {
    const rect = sibling.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (e.clientY < mid) {
      if (placeholder.nextElementSibling !== sibling) {
        legend.insertBefore(placeholder, sibling);
      }
      inserted = true;
      break;
    }
  }
  if (!inserted && placeholder.parentNode === legend) {
    legend.appendChild(placeholder);
  }
}

function onHeatmapLegendPointerUp() {
  endHeatmapLegendDrag(true);
}

function startHeatmapLegendDrag(e, item, legend) {
  if (e.button != null && e.button !== 0) return;
  if (
    walletsListOpen ||
    item.classList.contains("is-disabled") ||
    item.getAttribute("aria-disabled") === "true"
  ) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (heatmapLegendDrag) endHeatmapLegendDrag(false);

  const rect = item.getBoundingClientRect();
  const placeholder = document.createElement("div");
  placeholder.className = "heatmap-legend-reorder-placeholder";
  placeholder.style.height = `${rect.height}px`;
  legend.insertBefore(placeholder, item);

  heatmapLegendDrag = {
    item,
    legend,
    placeholder,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    originOrder: [...legend.querySelectorAll(".heatmap-legend-item")]
      .map((el) => el.dataset.metric)
      .filter(Boolean),
  };

  item.classList.add("is-legend-reordering");
  item.style.width = `${rect.width}px`;
  item.style.left = `${rect.left}px`;
  item.style.top = `${rect.top}px`;
  item.style.zIndex = "40";
  document.body.appendChild(item);
  document.body.classList.add("is-heatmap-legend-reordering");

  window.addEventListener("pointermove", onHeatmapLegendPointerMove);
  window.addEventListener("pointerup", onHeatmapLegendPointerUp);
  window.addEventListener("pointercancel", onHeatmapLegendPointerUp);
}

function walletSightingsForSeries(wallet, series) {
  const fromMarket = Number(wallet?.markets?.[series]);
  if (Number.isFinite(fromMarket) && fromMarket > 0) return fromMarket;
  const total = Number(wallet?.totalSightings);
  return Number.isFinite(total) ? total : null;
}

function setWalletsListSort(key) {
  if (walletsListSortLoadingKey) return;
  if (walletsListSort.key === key) {
    walletsListSort = {
      key,
      dir: walletsListSort.dir === "desc" ? "asc" : "desc",
    };
  } else {
    walletsListSort = { key, dir: "desc" };
  }
  walletsListSortLoadingKey = key;
  refreshWalletsSortHeaders();
  void loadTraderWalletsList();
}

function createWalletsSortHeader(options) {
  const { key, label, className = "", title } = options;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `schedule-wallets-sort-btn ${className}`.trim();
  btn.dataset.sortKey = key;
  const active = walletsListSort.key === key;
  const loading = walletsListSortLoadingKey === key;
  const dir = active ? walletsListSort.dir : null;
  btn.setAttribute("aria-pressed", active ? "true" : "false");
  btn.setAttribute("aria-busy", loading ? "true" : "false");
  btn.disabled = Boolean(walletsListSortLoadingKey);
  btn.classList.toggle("is-sorting", loading);
  btn.title =
    title ||
    (loading
      ? "Sorting…"
      : active
        ? dir === "desc"
          ? "Sorted high to low — click for low to high"
          : "Sorted low to high — click for high to low"
        : "Sort high to low");

  const spinner = document.createElement("span");
  spinner.className = "schedule-wallets-sort-spinner";
  spinner.setAttribute("aria-hidden", "true");
  if (!loading) spinner.classList.add("is-idle");

  const labelEl = document.createElement("span");
  labelEl.className = "schedule-wallets-sort-label";
  labelEl.textContent = label;

  const arrow = document.createElement("span");
  arrow.className = "schedule-wallets-sort-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = dir === "asc" ? "▲" : "▼";
  if (!active) arrow.classList.add("is-idle");

  btn.append(spinner, labelEl, arrow);
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setWalletsListSort(key);
  });
  return btn;
}

function refreshWalletsSortHeaders() {
  const headTable = document.querySelector(".schedule-wallets-table thead");
  if (!headTable) return;
  const pnlTh = headTable.querySelector("th:nth-child(2)");
  const sightingsTh = headTable.querySelector("th:nth-child(3)");
  const winTh = headTable.querySelector("th:nth-child(4)");
  const lostTh = headTable.querySelector("th:nth-child(5)");
  if (pnlTh) {
    pnlTh.replaceChildren(
      createWalletsSortHeader({
        key: "pnl",
        label: "P/L",
        className: "is-pnl",
      }),
    );
  }
  if (sightingsTh) {
    sightingsTh.replaceChildren(
      createWalletsSortHeader({ key: "sightings", label: "Sightings", className: "is-sightings" }),
    );
  }
  if (winTh) {
    winTh.replaceChildren(
      createWalletsSortHeader({
        key: "iWin",
        label: "I WON",
        className: "is-win",
      }),
    );
  }
  if (lostTh) {
    lostTh.replaceChildren(
      createWalletsSortHeader({
        key: "iLost",
        label: "I LOST",
        className: "is-lost",
      }),
    );
  }
}

function buildWalletsColgroup() {
  const colgroup = document.createElement("colgroup");
  for (const width of ["36%", "16%", "16%", "16%", "16%"]) {
    const col = document.createElement("col");
    col.style.width = width;
    colgroup.appendChild(col);
  }
  return colgroup;
}

function buildWalletsThead() {
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const addressTh = document.createElement("th");
  addressTh.textContent = "Address";
  const pnlTh = document.createElement("th");
  pnlTh.appendChild(
    createWalletsSortHeader({
      key: "pnl",
      label: "P/L",
      className: "is-pnl",
    }),
  );
  const sightingsTh = document.createElement("th");
  sightingsTh.appendChild(
    createWalletsSortHeader({ key: "sightings", label: "Sightings", className: "is-sightings" }),
  );
  const winTh = document.createElement("th");
  winTh.appendChild(
    createWalletsSortHeader({
      key: "iWin",
      label: "I WON",
      className: "is-win",
    }),
  );
  const lostTh = document.createElement("th");
  lostTh.appendChild(
    createWalletsSortHeader({
      key: "iLost",
      label: "I LOST",
      className: "is-lost",
    }),
  );
  headRow.append(addressTh, pnlTh, sightingsTh, winTh, lostTh);
  thead.appendChild(headRow);
  return thead;
}

function formatWalletPnl(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return { text: "$0.00", sign: 0 };
  const abs = Math.abs(n);
  const text =
    abs >= 1000
      ? `${n >= 0 ? "+" : "-"}$${abs.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
      : `${n >= 0 ? "+" : "-"}$${abs.toFixed(2)}`;
  const sign = n > 1e-9 ? 1 : n < -1e-9 ? -1 : 0;
  return { text, sign };
}

const WALLETS_OPEN_ICON_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3H3v10h10v-3"/><path d="M9 3h4v4"/><path d="M7 9l6-6"/></svg>';
const WALLETS_CLOSE_ICON_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M12 4L4 12"/></svg>';

function syncWalletsListOpenUi() {
  const page = $("page-schedule-heatmap");
  const week = document.querySelector(".schedule-week-layout");
  const panel = $("schedule-wallets-panel");
  const legend = document.querySelector(".heatmap-legend");
  const open = walletsListOpen && isHeatmapViewActive();
  walletsListOpen = open;
  page?.classList.toggle("is-wallets-list-view", open);
  legend?.classList.toggle("is-wallets-list-open", open);
  if (week) week.hidden = open;
  if (panel) panel.hidden = !open;

  document.querySelectorAll(".heatmap-legend-item").forEach((item) => {
    const isWallets = item.dataset.metric === "wallets";
    item.classList.toggle("is-wallets-open", open && isWallets);
    item.classList.toggle("is-disabled", open && !isWallets);
    item.setAttribute("aria-disabled", open && !isWallets ? "true" : "false");
  });

  document.querySelectorAll(".heatmap-legend-open-btn").forEach((btn) => {
    btn.setAttribute("aria-pressed", open ? "true" : "false");
    btn.setAttribute("aria-label", open ? "Close wallet list" : "Open wallet list");
    btn.title = open ? "Close wallet list" : "Open wallet list";
    btn.innerHTML = open ? WALLETS_CLOSE_ICON_SVG : WALLETS_OPEN_ICON_SVG;
  });
}

function polymarketProfileUrl(address) {
  const raw = String(address || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(raw)) return null;
  return `https://polymarket.com/profile/${raw}`;
}

function renderTraderWalletsList(wallets, errorMessage, series = selectedSeries, meta = {}) {
  const body = $("schedule-wallets-body");
  const cols = $("schedule-wallets-cols");
  const countEl = $("schedule-wallets-count");
  if (!body) return;
  if (cols) {
    cols.hidden = true;
    cols.replaceChildren();
  }

  if (errorMessage) {
    walletsListCache = [];
    body.innerHTML = "";
    const err = document.createElement("div");
    err.className = "schedule-wallets-error";
    err.textContent = errorMessage;
    body.appendChild(err);
    if (countEl) countEl.textContent = "";
    return;
  }

  const list = Array.isArray(wallets) ? wallets : [];
  walletsListCache = list;
  walletsListSeries = series;
  const total = Number(meta.total);
  if (countEl) {
    if (Number.isFinite(total) && total > list.length) {
      countEl.textContent = `Top ${list.length} of ${total}`;
    } else {
      countEl.textContent = list.length === 1 ? "1 wallet" : `${list.length} wallets`;
    }
  }

  if (list.length === 0) {
    body.innerHTML =
      '<div class="schedule-wallets-empty">No wallets recorded for this market yet.</div>';
    return;
  }

  const table = document.createElement("table");
  table.className = "schedule-wallets-table";
  table.appendChild(buildWalletsColgroup());
  table.appendChild(buildWalletsThead());

  const tbody = document.createElement("tbody");
  for (const wallet of list) {
    const tr = document.createElement("tr");
    const address = document.createElement("td");
    address.className = "schedule-wallets-address";
    const addr = String(wallet.address || "").trim();
    const profileUrl = polymarketProfileUrl(addr);
    if (profileUrl) {
      const link = document.createElement("a");
      link.className = "schedule-wallets-address-link";
      link.href = profileUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = "Open Polymarket profile";
      const addrText = document.createElement("span");
      addrText.className = "schedule-wallets-address-text";
      addrText.textContent = addr;
      const linkIcon = document.createElement("span");
      linkIcon.className = "schedule-wallets-address-link-icon";
      linkIcon.setAttribute("aria-hidden", "true");
      linkIcon.innerHTML = WALLETS_OPEN_ICON_SVG;
      link.append(addrText, linkIcon);
      address.appendChild(link);
    } else {
      address.textContent = addr || "—";
    }
    const sightings = document.createElement("td");
    const count = walletSightingsForSeries(wallet, series);
    sightings.textContent = count == null ? "—" : String(count);
    const pnlTd = document.createElement("td");
    const pnlBadge = document.createElement("span");
    const { text: pnlText, sign: pnlSign } = formatWalletPnl(wallet.pnl);
    pnlBadge.className = "schedule-wallets-stat-value is-pnl";
    if (pnlSign > 0) pnlBadge.classList.add("is-positive");
    else if (pnlSign < 0) pnlBadge.classList.add("is-negative");
    else pnlBadge.classList.add("is-neutral");
    pnlBadge.textContent = pnlText;
    pnlTd.appendChild(pnlBadge);
    const iWin = document.createElement("td");
    const iWinBadge = document.createElement("span");
    iWinBadge.className = "schedule-wallets-stat-value is-win";
    iWinBadge.textContent = Number.isFinite(Number(wallet.iWin)) ? String(wallet.iWin) : "0";
    iWin.appendChild(iWinBadge);
    const iLost = document.createElement("td");
    const iLostBadge = document.createElement("span");
    iLostBadge.className = "schedule-wallets-stat-value is-lost";
    iLostBadge.textContent = Number.isFinite(Number(wallet.iLost)) ? String(wallet.iLost) : "0";
    iLost.appendChild(iLostBadge);
    tr.append(address, pnlTd, sightings, iWin, iLost);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  body.replaceChildren(table);
}

async function loadTraderWalletsList() {
  const body = $("schedule-wallets-body");
  const countEl = $("schedule-wallets-count");
  if (!body) return;
  const token = ++walletsListLoadToken;
  const series = selectedSeries;
  const sort = walletsListSort.key || "sightings";
  const dir = walletsListSort.dir || "desc";
  const sorting = Boolean(walletsListSortLoadingKey);
  if (!sorting) {
    body.innerHTML = '<div class="schedule-wallets-empty">Loading…</div>';
    if (countEl) countEl.textContent = "";
  }
  try {
    const params = new URLSearchParams({
      series,
      sort,
      dir,
      limit: String(WALLETS_LIST_LIMIT),
    });
    const res = await fetch(`/api/trader-wallets?${params.toString()}`);
    if (token !== walletsListLoadToken) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed to load wallets (${res.status})`);
    }
    const data = await res.json();
    if (token !== walletsListLoadToken) return;
    if (
      data?.sort === "sightings" ||
      data?.sort === "iWin" ||
      data?.sort === "iLost" ||
      data?.sort === "pnl"
    ) {
      walletsListSort = {
        key: data.sort,
        dir: data.dir === "asc" ? "asc" : "desc",
      };
    }
    walletsListSortLoadingKey = null;
    renderTraderWalletsList(data?.wallets, null, data?.series || series, {
      total: data?.total,
      limit: data?.limit,
    });
  } catch (err) {
    if (token !== walletsListLoadToken) return;
    walletsListSortLoadingKey = null;
    renderTraderWalletsList([], err.message || "Failed to load wallets", series);
  }
}

function setWalletsListOpen(open) {
  walletsListOpen = Boolean(open) && isHeatmapViewActive();
  syncWalletsListOpenUi();
  if (walletsListOpen) {
    walletsListSort = { key: "sightings", dir: "desc" };
    walletsListSortLoadingKey = null;
    void loadTraderWalletsList();
  }
}

function initHeatmapLegend() {
  const panel = $("schedule-heatmap-panel");
  if (!panel) return;
  panel.replaceChildren();

  const legend = document.createElement("div");
  legend.className = "heatmap-legend";
  legend.setAttribute("aria-label", "Heatmap color index");

  for (const metric of getHeatmapMetrics()) {
    const item = document.createElement("div");
    item.className = "heatmap-legend-item";
    item.dataset.metric = metric.key;

    const handle = document.createElement("div");
    handle.className = "heatmap-legend-drag-handle";
    handle.setAttribute("aria-label", `Drag to reorder ${metric.label}`);
    handle.title = "Drag to reorder color columns";
    handle.innerHTML =
      '<svg viewBox="0 0 8 14" aria-hidden="true"><circle cx="2" cy="2" r="1.2" fill="currentColor"/><circle cx="6" cy="2" r="1.2" fill="currentColor"/><circle cx="2" cy="7" r="1.2" fill="currentColor"/><circle cx="6" cy="7" r="1.2" fill="currentColor"/><circle cx="2" cy="12" r="1.2" fill="currentColor"/><circle cx="6" cy="12" r="1.2" fill="currentColor"/></svg>';
    handle.addEventListener("pointerdown", (e) => startHeatmapLegendDrag(e, item, legend));

    const body = document.createElement("div");
    body.className = "heatmap-legend-item-body";

    const head = document.createElement("div");
    head.className = "heatmap-legend-head";

    const swatch = document.createElement("span");
    swatch.className = "heatmap-legend-swatch";
    swatch.style.backgroundColor = `rgba(${metric.rgb}, 0.85)`;
    swatch.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "heatmap-legend-label";
    label.textContent = metric.label;

    head.append(swatch, label);

    if (metric.key === "wallets") {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "heatmap-legend-open-btn";
      openBtn.setAttribute("aria-label", "Open wallet list");
      openBtn.setAttribute("aria-pressed", "false");
      openBtn.title = "Open wallet list";
      openBtn.innerHTML = WALLETS_OPEN_ICON_SVG;
      openBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setWalletsListOpen(!walletsListOpen);
      });
      head.appendChild(openBtn);
    }

    const desc = document.createElement("p");
    desc.className = "heatmap-legend-desc";
    desc.textContent = metric.tip;

    body.append(head, desc);
    item.append(handle, body);
    legend.appendChild(item);
  }

  panel.appendChild(legend);
  syncHeatmapColumnOrder();
  syncWalletsListOpenUi();
}

function bindScheduleViewToggle() {
  const list = $("schedule-setups-list");
  const heatmapPanel = $("schedule-heatmap-panel");
  if (!heatmapPanel) return;

  const showView = (view, options = {}) => {
    const next = view === "heatmap" ? "heatmap" : "schedule";
    const isSchedule = next === "schedule";
    const page = $("page-schedule-heatmap");
    page?.classList.toggle("is-heatmap-view", !isSchedule);
    // Setups list is retired — keep it hidden in both views.
    if (list) {
      list.hidden = true;
      list.setAttribute("aria-hidden", "true");
    }
    heatmapPanel.hidden = isSchedule;
    if (options.persist !== false) saveScheduleViewPref(next);
    if (isSchedule) setWalletsListOpen(false);
    // Keep both UIs mounted. Only load heatmap the first time if not yet available.
    if (!isSchedule && !lastHeatmapState) {
      void loadHeatmap();
    }
    if (window.SchedulePlacements) window.SchedulePlacements.onViewChange();
    else window.ScheduleHourSlots?.syncView?.();
    syncPageToggleActive();
  };

  showScheduleView = showView;
  showView(loadScheduleViewPref(), { persist: false });
}

function syncTradeToggleLabel(labelId, name, on) {
  const el = $(labelId);
  if (el) el.textContent = `${name} · ${on ? "On" : "Off"}`;
}

function syncAllowTradeSegment(on) {
  const offBtn = $("start-trading-off");
  const onBtn = $("start-trading-on");
  offBtn?.classList.toggle("is-active", !on);
  onBtn?.classList.toggle("is-active", Boolean(on));
  offBtn?.setAttribute("aria-pressed", String(!on));
  onBtn?.setAttribute("aria-pressed", String(Boolean(on)));
}

function syncWalletControls(config) {
  const autoTradeOn = Boolean(config?.autoTrade);
  const useScheduleOn = Boolean(config?.useSchedule);
  const sharesField = $("wallet-shares-field");
  const useScheduleField = $("wallet-use-schedule-field");
  const startTradingField = $("wallet-start-trading-field");
  const sharesInput = $("manual-shares");
  const unitSelect = $("manual-order-unit");

  if (sharesField) sharesField.hidden = autoTradeOn;
  if (useScheduleField) useScheduleField.hidden = !autoTradeOn;
  // Allow trade lives under Settings → User (always visible there).
  if (startTradingField) startTradingField.hidden = false;
  syncAllowTradeSegment(Boolean(config?.startTrading));
  syncTradeToggleLabel("auto-trade-label", "Auto Trade", autoTradeOn);
  syncTradeToggleLabel("use-schedule-label", "Use Schedule", useScheduleOn);
  if (unitSelect) {
    unitSelect.value = config?.manualOrderUnit === "usdc" ? "usdc" : "shares";
    syncManualAmountInputAttrs(unitSelect.value);
  }
  if (sharesInput && Number.isFinite(config?.manualShares)) {
    sharesInput.value = String(config.manualShares);
  }
  window.SchedulePlacements?.syncHeaderSummaryControls?.();
  syncMarketRailLivePulse();
}

function syncManualAmountInputAttrs(unit) {
  const sharesInput = $("manual-shares");
  if (!sharesInput) return;
  if (unit === "usdc") {
    sharesInput.min = "0.01";
    sharesInput.step = "0.01";
  } else {
    sharesInput.min = "1";
    sharesInput.step = "1";
  }
}

function normalizeManualAmount(value, unit) {
  const n = Number(value);
  if (unit === "usdc") {
    return Math.max(0.01, Math.min(100000, Math.round((Number.isFinite(n) ? n : 10) * 100) / 100));
  }
  return Math.max(1, Math.min(100000, Math.floor(Number.isFinite(n) ? n : 10) || 10));
}

const TRADING_CONFIG_STORAGE_KEY = "poly-trading-config";

function tradingConfigStorageKey(series = selectedSeries) {
  const base = `${TRADING_CONFIG_STORAGE_KEY}:${series || "btc-5m"}`;
  return userScopedStorageKey(base);
}

function normalizeManualOrderType(value) {
  return value === "FAK" ? "FAK" : "FOK";
}

function normalizePredictionSellOrderType(value) {
  if (value === "FAK" || value === "FOK" || value === "GTD") return value;
  return "FOK";
}

function isPredictionSellGtd() {
  return normalizePredictionSellOrderType($("prediction-sell-order-type")?.value) === "GTD";
}

function normalizeManipulationSensitivity(value) {
  const n = Number(value);
  return Math.max(1, Math.min(120, Math.round(Number.isFinite(n) ? n : 5)));
}

function normalizePredictionMaxQuoteCents(value) {
  const n = Math.round(Number(value));
  return Math.max(1, Math.min(99, Number.isFinite(n) ? n : 90));
}

function normalizePredictionMinQuoteCents(value) {
  const n = Math.round(Number(value));
  return Math.max(1, Math.min(99, Number.isFinite(n) ? n : 70));
}

function normalizePredictionQuoteBand(minRaw, maxRaw) {
  const maxQuoteCents = normalizePredictionMaxQuoteCents(maxRaw);
  let minQuoteCents = normalizePredictionMinQuoteCents(minRaw);
  if (minQuoteCents > maxQuoteCents) minQuoteCents = maxQuoteCents;
  return { minQuoteCents, maxQuoteCents };
}

function normalizePredictionShiftCents(value) {
  const n = Math.round(Number(value));
  return Math.max(1, Math.min(50, Number.isFinite(n) ? n : 5));
}

function normalizePredictionRiseCents(value) {
  const n = Math.round(Number(value));
  return Math.max(1, Math.min(50, Number.isFinite(n) ? n : 5));
}

function predictedSideSell(side, upBid, downBid) {
  return side === "up" ? upBid : downBid;
}

/**
 * Right when predicted-side Sell (Bid) reaches buy basis + Profit prediction.
 * `basisBuy` is the fill price after a real Prediction buy, else the trigger Ask.
 */
function sellMeetsPredictionRise(side, upBid, downBid, basisBuy, riseCents) {
  if (side !== "up" && side !== "down") return false;
  if (!Number.isFinite(basisBuy) || !Number.isFinite(upBid) || !Number.isFinite(downBid)) {
    return false;
  }
  const target = basisBuy + normalizePredictionRiseCents(riseCents) / 100;
  return predictedSideSell(side, upBid, downBid) >= target - 1e-12;
}

function predictionProfitBasisPrice() {
  if (Number.isFinite(manipDetectorRuntime.predictionProfitBasis)) {
    return manipDetectorRuntime.predictionProfitBasis;
  }
  return Number.isFinite(manipDetectorRuntime.predictionTriggerBuy)
    ? manipDetectorRuntime.predictionTriggerBuy
    : null;
}

/** Cheapening Buy within [Min, Max] Quote at Duration start, and drops by ≥ Shift over Duration. */
function meetsPredictionMaxQuoteAndShift(
  predictionSide,
  baseline,
  now,
  maxQuoteCents,
  shiftCents,
  minQuoteCents = 70,
) {
  const band = normalizePredictionQuoteBand(minQuoteCents, maxQuoteCents);
  const minP = band.minQuoteCents / 100;
  const maxP = band.maxQuoteCents / 100;
  const shiftP = shiftCents / 100;
  if (predictionSide === "down") {
    if (!(baseline.upBuy >= minP - 1e-12 && baseline.upBuy <= maxP + 1e-12)) return false;
    return now.upBuy <= baseline.upBuy - shiftP + 1e-12;
  }
  if (predictionSide === "up") {
    if (!(baseline.downBuy >= minP - 1e-12 && baseline.downBuy <= maxP + 1e-12)) return false;
    return now.downBuy <= baseline.downBuy - shiftP + 1e-12;
  }
  return false;
}

function normalizeManipulationArea(startRaw, endRaw) {
  let start = Number(startRaw);
  let end = Number(endRaw);
  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(end)) end = 1;
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
  return { manipulationAreaStart: start, manipulationAreaEnd: end };
}

let manipAreaStart = 0;
let manipAreaEnd = 1;
let manipAreaDrag = null;

function readLocalTradingConfig() {
  try {
    const legacySeries = `${TRADING_CONFIG_STORAGE_KEY}:${selectedSeries || "btc-5m"}`;
    const raw =
      localStorage.getItem(tradingConfigStorageKey()) ||
      localStorage.getItem(legacySeries) ||
      (selectedSeries === "btc-5m" ? localStorage.getItem(TRADING_CONFIG_STORAGE_KEY) : null);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const autoTrade = Boolean(parsed.autoTrade);
    const manualOrderUnit = parsed.manualOrderUnit === "usdc" ? "usdc" : "shares";
    const area = normalizeManipulationArea(parsed.manipulationAreaStart, parsed.manipulationAreaEnd);
    return {
      autoTrade,
      useSchedule: Boolean(parsed.useSchedule),
      startTrading: Boolean(parsed.startTrading),
      manualOrderUnit,
      manualShares: normalizeManualAmount(parsed.manualShares, manualOrderUnit),
      manualBuyOrderType: normalizeManualOrderType(parsed.manualBuyOrderType),
      manualSellOrderType: normalizeManualOrderType(parsed.manualSellOrderType),
      manipulationDetector: Boolean(parsed.manipulationDetector),
      predictionTrade:
        Boolean(parsed.predictionTrade) &&
        Boolean(parsed.startTrading) &&
        Boolean(parsed.manipulationDetector),
      predictionShares: normalizePredictionShares(parsed.predictionShares),
      predictionBuyOrderType: normalizeManualOrderType(parsed.predictionBuyOrderType),
      predictionSellOrderType: normalizePredictionSellOrderType(parsed.predictionSellOrderType),
      manipulationSensitivitySec: normalizeManipulationSensitivity(parsed.manipulationSensitivitySec),
      ...(() => {
        const quotes = normalizePredictionQuoteBand(
          parsed.predictionMinQuoteCents,
          parsed.predictionMaxQuoteCents,
        );
        return {
          predictionMaxQuoteCents: quotes.maxQuoteCents,
          predictionMinQuoteCents: quotes.minQuoteCents,
        };
      })(),
      predictionShiftCents: normalizePredictionShiftCents(parsed.predictionShiftCents),
      predictionRiseCents: normalizePredictionRiseCents(parsed.predictionRiseCents),
      ...area,
      predictionRightCount: normalizePredictionCount(parsed.predictionRightCount),
      predictionWrongCount: normalizePredictionCount(parsed.predictionWrongCount),
    };
  } catch {
    return null;
  }
}

function writeLocalTradingConfig(config) {
  if (!config) return;
  try {
    const manualOrderUnit = config.manualOrderUnit === "usdc" ? "usdc" : "shares";
    const area = normalizeManipulationArea(config.manipulationAreaStart, config.manipulationAreaEnd);
    const quotes = normalizePredictionQuoteBand(
      config.predictionMinQuoteCents,
      config.predictionMaxQuoteCents,
    );
    localStorage.setItem(
      tradingConfigStorageKey(),
      JSON.stringify({
        autoTrade: Boolean(config.autoTrade),
        useSchedule: Boolean(config.useSchedule),
        startTrading: Boolean(config.startTrading),
        manualOrderUnit,
        manualShares: normalizeManualAmount(config.manualShares, manualOrderUnit),
        manualBuyOrderType: normalizeManualOrderType(config.manualBuyOrderType),
        manualSellOrderType: normalizeManualOrderType(config.manualSellOrderType),
        manipulationDetector: Boolean(config.manipulationDetector),
        predictionTrade: false,
        predictionShares: normalizePredictionShares(config.predictionShares),
        predictionBuyOrderType: normalizeManualOrderType(config.predictionBuyOrderType),
        predictionSellOrderType: normalizePredictionSellOrderType(config.predictionSellOrderType),
        manipulationSensitivitySec: normalizeManipulationSensitivity(config.manipulationSensitivitySec),
        predictionMaxQuoteCents: quotes.maxQuoteCents,
        predictionMinQuoteCents: quotes.minQuoteCents,
        predictionShiftCents: normalizePredictionShiftCents(config.predictionShiftCents),
        predictionRiseCents: normalizePredictionRiseCents(config.predictionRiseCents),
        ...area,
        predictionRightCount: normalizePredictionCount(config.predictionRightCount),
        predictionWrongCount: normalizePredictionCount(config.predictionWrongCount),
      }),
    );
  } catch {
    // ignore quota / private mode
  }
}

async function pushTradingConfig(patch) {
  try {
    const res = await fetch(`/api/trading/config?series=${encodeURIComponent(selectedSeries)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...patch, series: selectedSeries }),
    });
    if (!res.ok) return null;
    const config = await res.json();
    writeLocalTradingConfig(config);
    return config;
  } catch {
    return null;
  }
}

async function loadTradingConfig() {
  try {
    const res = await fetch(`/api/trading/config?series=${encodeURIComponent(selectedSeries)}`);
    if (!res.ok) return null;
    const config = await res.json();
    writeLocalTradingConfig(config);
    return config;
  } catch {
    return null;
  }
}

function normalizePredictionShares(value) {
  const n = Math.floor(Number(value));
  return Math.max(1, Math.min(100000, Number.isFinite(n) && n > 0 ? n : 10));
}

function syncPredictionTradeEnabled() {
  const tradeInput = $("prediction-trade");
  const tradeLabel = $("prediction-trade-label");
  if (tradeInput) {
    tradeInput.checked = false;
    tradeInput.disabled = true;
  }
  if (tradeLabel) tradeLabel.textContent = "Trade · Off";
}

function buildTradingConfigPatch(overrides = {}) {
  const autoTradeInput = $("auto-trade");
  const useScheduleInput = $("use-schedule");
  const startTradingInput = $("start-trading");
  const sharesInput = $("manual-shares");
  const unitSelect = $("manual-order-unit");
  const buyTypeSelect = $("manual-buy-order-type");
  const sellTypeSelect = $("manual-sell-order-type");
  const manipInput = $("manipulation-detector");
  const predictionSharesInput = $("prediction-shares");
  const predictionBuyTypeSelect = $("prediction-buy-order-type");
  const predictionSellTypeSelect = $("prediction-sell-order-type");
  const sensInput = $("manipulation-sensitivity");
  const maxQuoteInput = $("prediction-max-quote");
  const minQuoteInput = $("prediction-min-quote");
  const shiftInput = $("prediction-shift");
  const riseInput = $("prediction-rise");
  const manualOrderUnit = unitSelect?.value === "usdc" ? "usdc" : "shares";
  const area = normalizeManipulationArea(manipAreaStart, manipAreaEnd);
  const quotes = normalizePredictionQuoteBand(minQuoteInput?.value, maxQuoteInput?.value);
  const startTrading = Boolean(startTradingInput?.checked);
  const manipulationDetector = Boolean(manipInput?.checked);
  return {
    // Phase Auto Trade / Use Schedule removed — Triggers only.
    autoTrade: false,
    useSchedule: false,
    startTrading,
    manualOrderUnit,
    manualShares: normalizeManualAmount(sharesInput?.value, manualOrderUnit),
    manualBuyOrderType: normalizeManualOrderType(buyTypeSelect?.value),
    manualSellOrderType: normalizeManualOrderType(sellTypeSelect?.value),
    manipulationDetector,
    // Prediction scores in sim only — Trigger cards are the sole live order path.
    predictionTrade: false,
    predictionShares: normalizePredictionShares(predictionSharesInput?.value),
    predictionBuyOrderType: normalizeManualOrderType(predictionBuyTypeSelect?.value),
    predictionSellOrderType: normalizePredictionSellOrderType(predictionSellTypeSelect?.value),
    manipulationSensitivitySec: normalizeManipulationSensitivity(sensInput?.value),
    predictionMaxQuoteCents: quotes.maxQuoteCents,
    predictionMinQuoteCents: quotes.minQuoteCents,
    predictionShiftCents: normalizePredictionShiftCents(shiftInput?.value),
    predictionRiseCents: normalizePredictionRiseCents(riseInput?.value),
    ...area,
    predictionRightCount: normalizePredictionCount(manipDetectorRuntime.rightCount),
    predictionWrongCount: normalizePredictionCount(manipDetectorRuntime.wrongCount),
    ...overrides,
  };
}

function coalesceTradingConfig(serverConfig, localPatch) {
  if (!serverConfig) return localPatch ?? null;
  const patch = localPatch ?? {};
  return {
    ...patch,
    ...serverConfig,
  };
}

const MANIP_SAMPLE_MAX = 600;
const PREDICTION_RESOLVE_INTERVAL_MS = 2000;
const PREDICTION_RUNTIME_STORAGE_KEY = "poly-prediction-runtime";

/**
 * Predictions only trigger/score on the deployed host (e.g. Heroku).
 * Localhost may still edit Prediction settings; those sync via trading config.
 */
function isPredictionTriggerHost() {
  const host = String(window.location?.hostname || "").toLowerCase();
  return host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]";
}
const manipDetectorRuntime = {
  samples: [],
  windowStart: null,
  flashTimer: null,
  flashUntilMs: 0,
  cooldownUntilMs: 0,
  /** @type {"up"|"down"|null} */
  predictionSide: null,
  predictionWindowStart: null,
  predictionWindowEnd: null,
  predictionSlug: null,
  /** Predicted-side Buy (0–1) at trigger (quote lock). */
  predictionTriggerBuy: null,
  /**
   * Buy price used for Profit / Right (0–1): fill after a real Prediction buy,
   * else trigger Ask (Trade Off / buy failed / sim).
   */
  predictionProfitBasis: null,
  /** True while a Prediction Trade buy order is in flight (pause Right until fill or fail). */
  predictionBuyPending: false,
  /** Sell (Bid) lock when Profit prediction hits (latched Sell look). */
  predictionSellLock: null,
  /** True when this foreground trigger placed a real Prediction Trade buy. */
  predictionTraded: false,
  /** Unique id for the active trigger (allows re-trigger after Right). */
  predictionTriggerId: null,
  /** Profit prediction (¢) required above buy basis for Right. */
  predictionRiseCents: 5,
  /** @type {"none"|"active"|"pending"|"right"|"wrong"} */
  uiPhase: "none",
  /** @type {number[]} windows locked after Wrong (end of window). */
  scoredWindowStarts: [],
  /** @type {string[]} scored trigger ids (prevents double-count). */
  scoredTriggerIds: [],
  lastPrice: null,
  lastPtb: null,
  resolveTimer: null,
  resolveStartedAt: 0,
  resultClearTimer: null,
  /**
   * Active predictions parked when a newer one takes the UI.
   * Scored by predicted-side Sell reaching buy-basis+Profit (or Wrong at window end).
   * @type {Array<{
   *   side: "up"|"down",
   *   windowStart: number,
   *   windowEnd: number|null,
   *   triggerSideBuy: number|null,
   *   profitBasis: number|null,
   *   riseCents: number,
   *   triggerId: string|null,
   *   traded: boolean,
   *   buyPending: boolean,
   *   slug: string|null,
   *   lastPrice: number|null,
   *   lastPtb: number|null,
   *   resolveStartedAt: number,
   *   timer: ReturnType<typeof setTimeout>|null,
   * }>}
   */
  backgroundResolutions: [],
  rightCount: 0,
  wrongCount: 0,
  statsPersistChain: Promise.resolve(),
};

const PREDICTION_RESULT_SHOW_MS = 5000;
const PREDICTION_SCORED_WINDOW_MAX = 50;
const PREDICTION_SCORED_TRIGGER_MAX = 100;

function predictionRuntimeStorageKey(series = selectedSeries) {
  return userScopedStorageKey(`${PREDICTION_RUNTIME_STORAGE_KEY}:${series || "btc-5m"}`);
}

function isPredictionWindowScored(windowStart) {
  return (
    windowStart != null &&
    Number.isFinite(windowStart) &&
    manipDetectorRuntime.scoredWindowStarts.includes(windowStart)
  );
}

function markPredictionWindowScored(windowStart) {
  if (windowStart == null || !Number.isFinite(windowStart)) return;
  if (isPredictionWindowScored(windowStart)) return;
  manipDetectorRuntime.scoredWindowStarts.push(windowStart);
  if (manipDetectorRuntime.scoredWindowStarts.length > PREDICTION_SCORED_WINDOW_MAX) {
    manipDetectorRuntime.scoredWindowStarts.splice(
      0,
      manipDetectorRuntime.scoredWindowStarts.length - PREDICTION_SCORED_WINDOW_MAX,
    );
  }
}

function isPredictionTriggerScored(triggerId) {
  return (
    typeof triggerId === "string" &&
    triggerId.length > 0 &&
    manipDetectorRuntime.scoredTriggerIds.includes(triggerId)
  );
}

function markPredictionTriggerScored(triggerId) {
  if (typeof triggerId !== "string" || !triggerId) return;
  if (isPredictionTriggerScored(triggerId)) return;
  manipDetectorRuntime.scoredTriggerIds.push(triggerId);
  if (manipDetectorRuntime.scoredTriggerIds.length > PREDICTION_SCORED_TRIGGER_MAX) {
    manipDetectorRuntime.scoredTriggerIds.splice(
      0,
      manipDetectorRuntime.scoredTriggerIds.length - PREDICTION_SCORED_TRIGGER_MAX,
    );
  }
}

function normalizeScoredTriggerIds(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of list) {
    if (typeof item !== "string" || !item || out.includes(item)) continue;
    out.push(item);
  }
  return out.slice(-PREDICTION_SCORED_TRIGGER_MAX);
}

function normalizeScoredWindowStarts(value) {
  const list = Array.isArray(value)
    ? value
    : Number.isFinite(value)
      ? [value]
      : [];
  const out = [];
  for (const item of list) {
    const n = Number(item);
    if (!Number.isFinite(n) || out.includes(n)) continue;
    out.push(n);
  }
  return out.slice(-PREDICTION_SCORED_WINDOW_MAX);
}

function stopBackgroundResolutionTimers() {
  for (const job of manipDetectorRuntime.backgroundResolutions) {
    if (job.timer != null) {
      clearTimeout(job.timer);
      job.timer = null;
    }
  }
}

function serializeBackgroundResolutions() {
  return manipDetectorRuntime.backgroundResolutions.map((job) => ({
    side: job.side,
    windowStart: job.windowStart,
    windowEnd: Number.isFinite(job.windowEnd) ? job.windowEnd : null,
    triggerSideBuy: Number.isFinite(job.triggerSideBuy) ? job.triggerSideBuy : null,
    profitBasis: Number.isFinite(job.profitBasis)
      ? job.profitBasis
      : Number.isFinite(job.triggerSideBuy)
        ? job.triggerSideBuy
        : null,
    riseCents: normalizePredictionRiseCents(job.riseCents),
    triggerId: typeof job.triggerId === "string" ? job.triggerId : null,
    traded: Boolean(job.traded),
    buyPending: Boolean(job.buyPending),
    slug: job.slug,
    lastPrice: Number.isFinite(job.lastPrice) ? job.lastPrice : null,
    lastPtb: Number.isFinite(job.lastPtb) ? job.lastPtb : null,
    resolveStartedAt: job.resolveStartedAt || 0,
  }));
}

/** Persist foreground + background pending predictions so refresh does not lose them. */
function persistPredictionRuntime() {
  try {
    const key = predictionRuntimeStorageKey();
    const side = manipDetectorRuntime.predictionSide;
    const phase = manipDetectorRuntime.uiPhase;
    const scored = manipDetectorRuntime.scoredWindowStarts;
    const scoredTriggers = manipDetectorRuntime.scoredTriggerIds;
    const background = serializeBackgroundResolutions();
    const active =
      (side === "up" || side === "down") &&
      (phase === "active" || phase === "pending") &&
      manipDetectorRuntime.predictionWindowStart != null &&
      Number.isFinite(manipDetectorRuntime.predictionWindowStart);

    if (
      !active &&
      background.length === 0 &&
      scored.length === 0 &&
      scoredTriggers.length === 0
    ) {
      localStorage.removeItem(key);
      return;
    }

    localStorage.setItem(
      key,
      JSON.stringify({
        predictionSide: active ? side : null,
        predictionWindowStart: active ? manipDetectorRuntime.predictionWindowStart : null,
        predictionWindowEnd: active ? manipDetectorRuntime.predictionWindowEnd : null,
        predictionSlug: active ? manipDetectorRuntime.predictionSlug : null,
        predictionTriggerBuy: active && Number.isFinite(manipDetectorRuntime.predictionTriggerBuy)
          ? manipDetectorRuntime.predictionTriggerBuy
          : null,
        predictionProfitBasis:
          active && Number.isFinite(manipDetectorRuntime.predictionProfitBasis)
            ? manipDetectorRuntime.predictionProfitBasis
            : null,
        predictionBuyPending: active ? Boolean(manipDetectorRuntime.predictionBuyPending) : false,
        predictionTraded: active ? Boolean(manipDetectorRuntime.predictionTraded) : false,
        predictionTriggerId: active ? manipDetectorRuntime.predictionTriggerId : null,
        predictionRiseCents: active
          ? normalizePredictionRiseCents(manipDetectorRuntime.predictionRiseCents)
          : null,
        uiPhase: active ? phase : "none",
        scoredWindowStarts: scored,
        scoredTriggerIds: scoredTriggers,
        // legacy single field for older clients
        scoredWindowStart: scored.length > 0 ? scored[scored.length - 1] : null,
        backgroundResolutions: background,
        lastPrice: Number.isFinite(manipDetectorRuntime.lastPrice)
          ? manipDetectorRuntime.lastPrice
          : null,
        lastPtb: Number.isFinite(manipDetectorRuntime.lastPtb)
          ? manipDetectorRuntime.lastPtb
          : null,
        resolveStartedAt: manipDetectorRuntime.resolveStartedAt || 0,
      }),
    );
  } catch {
    // ignore quota / private mode
  }
}

function restorePredictionGraphBorder(side, windowEndSec) {
  const wrap = $("price-graph-wrap");
  if (!wrap || (side !== "up" && side !== "down")) return;

  wrap.classList.remove(
    "price-graph-wrap--manipulation",
    "price-graph-wrap--prediction-up",
    "price-graph-wrap--prediction-down",
  );

  const now = Date.now();
  const windowEndMs =
    windowEndSec != null && Number.isFinite(windowEndSec) ? windowEndSec * 1000 : null;
  const duration = windowEndMs != null ? Math.max(0, windowEndMs - now) : null;
  if (duration != null && duration <= 0) return;

  wrap.classList.add(
    side === "up" ? "price-graph-wrap--prediction-up" : "price-graph-wrap--prediction-down",
  );
  if (manipDetectorRuntime.flashTimer != null) clearTimeout(manipDetectorRuntime.flashTimer);
  manipDetectorRuntime.flashUntilMs =
    duration != null ? now + duration : Number.POSITIVE_INFINITY;
  manipDetectorRuntime.cooldownUntilMs = manipDetectorRuntime.flashUntilMs;
  if (duration != null) {
    manipDetectorRuntime.flashTimer = setTimeout(() => {
      manipDetectorRuntime.flashTimer = null;
      manipDetectorRuntime.flashUntilMs = 0;
      wrap.classList.remove(
        "price-graph-wrap--prediction-up",
        "price-graph-wrap--prediction-down",
      );
    }, duration);
  }
}

function restoreBackgroundResolutions(rawList) {
  stopBackgroundResolutionTimers();
  manipDetectorRuntime.backgroundResolutions = [];
  if (!Array.isArray(rawList)) return;
  const nowMs = Date.now();
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const side = item.side === "up" || item.side === "down" ? item.side : null;
    const windowStart = Number.isFinite(item.windowStart) ? item.windowStart : null;
    if (!side || windowStart == null || isPredictionWindowScored(windowStart)) continue;
    if (manipDetectorRuntime.backgroundResolutions.some((j) => j.windowStart === windowStart)) {
      continue;
    }
    const windowEnd = Number.isFinite(item.windowEnd) ? item.windowEnd : null;
    const triggerId =
      typeof item.triggerId === "string" && item.triggerId
        ? item.triggerId
        : `${windowStart}:bg:${item.resolveStartedAt || 0}`;
    if (isPredictionTriggerScored(triggerId)) continue;
    const triggerSideBuy = Number.isFinite(item.triggerSideBuy) ? item.triggerSideBuy : null;
    const profitBasis = Number.isFinite(item.profitBasis)
      ? item.profitBasis
      : triggerSideBuy;
    const job = {
      side,
      windowStart,
      windowEnd,
      triggerSideBuy,
      profitBasis,
      riseCents: normalizePredictionRiseCents(item.riseCents),
      triggerId,
      traded: Boolean(item.traded),
      buyPending: Boolean(item.buyPending),
      slug:
        typeof item.slug === "string" && item.slug.trim() ? item.slug.trim() : null,
      lastPrice: Number.isFinite(item.lastPrice) ? item.lastPrice : null,
      lastPtb: Number.isFinite(item.lastPtb) ? item.lastPtb : null,
      resolveStartedAt:
        Number.isFinite(item.resolveStartedAt) && item.resolveStartedAt > 0
          ? item.resolveStartedAt
          : Date.now(),
      timer: null,
    };
    // Window already over while offline — cannot verify Profit prediction; count Wrong.
    if (windowEnd != null && nowMs >= windowEnd * 1000) {
      recordPredictionScore(side, windowStart, false, {
        showResultUi: false,
        source: "window-end",
        triggerId,
      });
      continue;
    }
    manipDetectorRuntime.backgroundResolutions.push(job);
  }
}

function restorePredictionRuntime() {
  try {
    const raw = localStorage.getItem(predictionRuntimeStorageKey());
    if (!raw) {
      syncPredictionCardsFromRuntime();
      return;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      syncPredictionCardsFromRuntime();
      return;
    }

    manipDetectorRuntime.scoredWindowStarts = normalizeScoredWindowStarts(
      parsed.scoredWindowStarts ?? parsed.scoredWindowStart,
    );
    manipDetectorRuntime.scoredTriggerIds = normalizeScoredTriggerIds(parsed.scoredTriggerIds);
    restoreBackgroundResolutions(parsed.backgroundResolutions);

    const side =
      parsed.predictionSide === "up" || parsed.predictionSide === "down"
        ? parsed.predictionSide
        : null;
    const phase =
      parsed.uiPhase === "active" || parsed.uiPhase === "pending" ? parsed.uiPhase : "none";
    const windowStart = Number.isFinite(parsed.predictionWindowStart)
      ? parsed.predictionWindowStart
      : null;
    const windowEnd = Number.isFinite(parsed.predictionWindowEnd)
      ? parsed.predictionWindowEnd
      : null;
    const triggerId =
      typeof parsed.predictionTriggerId === "string" && parsed.predictionTriggerId
        ? parsed.predictionTriggerId
        : windowStart != null
          ? `${windowStart}:restored`
          : null;

    if (!side || windowStart == null || phase === "none") {
      syncPredictionStatusUi();
      persistPredictionRuntime();
      syncPredictionCardsFromRuntime();
      return;
    }

    // Wrong-locked window, or this trigger already scored — drop stale UI.
    if (isPredictionWindowScored(windowStart) || isPredictionTriggerScored(triggerId)) {
      persistPredictionRuntime();
      syncPredictionStatusUi();
      syncPredictionCardsFromRuntime();
      return;
    }

    manipDetectorRuntime.predictionSide = side;
    manipDetectorRuntime.predictionWindowStart = windowStart;
    manipDetectorRuntime.predictionWindowEnd = windowEnd;
    manipDetectorRuntime.predictionSlug =
      typeof parsed.predictionSlug === "string" && parsed.predictionSlug.trim()
        ? parsed.predictionSlug.trim()
        : null;
    manipDetectorRuntime.predictionTriggerBuy = Number.isFinite(parsed.predictionTriggerBuy)
      ? parsed.predictionTriggerBuy
      : null;
    manipDetectorRuntime.predictionProfitBasis = Number.isFinite(parsed.predictionProfitBasis)
      ? parsed.predictionProfitBasis
      : manipDetectorRuntime.predictionTriggerBuy;
    manipDetectorRuntime.predictionBuyPending = Boolean(parsed.predictionBuyPending);
    manipDetectorRuntime.predictionTraded = Boolean(parsed.predictionTraded);
    manipDetectorRuntime.predictionTriggerId = triggerId;
    manipDetectorRuntime.predictionRiseCents = normalizePredictionRiseCents(
      parsed.predictionRiseCents ?? $("prediction-rise")?.value,
    );
    manipDetectorRuntime.lastPrice = Number.isFinite(parsed.lastPrice) ? parsed.lastPrice : null;
    manipDetectorRuntime.lastPtb = Number.isFinite(parsed.lastPtb) ? parsed.lastPtb : null;
    // Align detector window so the first tick does not wipe the restored prediction.
    manipDetectorRuntime.windowStart = windowStart;
    manipDetectorRuntime.uiPhase = phase === "pending" ? "active" : phase;

    const nowMs = Date.now();
    const windowEndMs = windowEnd != null ? windowEnd * 1000 : null;

    if (windowEndMs != null && nowMs >= windowEndMs) {
      finalizePredictionAtWindowEnd({ showResultUi: true, source: "window-end" });
      syncPredictionCardsFromRuntime();
      return;
    }

    syncPredictionStatusUi();
    if (manipDetectorRuntime.uiPhase === "active") {
      restorePredictionGraphBorder(side, windowEnd);
    }
    syncPredictionCardsFromRuntime();
  } catch {
    // ignore corrupt storage
  }
}

function normalizePredictionCount(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(1_000_000, n) : 0;
}

function stopPredictionResolveLoop() {
  if (manipDetectorRuntime.resolveTimer != null) {
    clearTimeout(manipDetectorRuntime.resolveTimer);
    manipDetectorRuntime.resolveTimer = null;
  }
  manipDetectorRuntime.resolveStartedAt = 0;
}

function stopPredictionResultClearTimer() {
  if (manipDetectorRuntime.resultClearTimer != null) {
    clearTimeout(manipDetectorRuntime.resultClearTimer);
    manipDetectorRuntime.resultClearTimer = null;
  }
}

function clearPredictionQuoteBoxClasses(box) {
  if (!box) return;
  box.classList.remove(
    "quote-box",
    "quote-box-up",
    "quote-box-down",
    "quote-box-disabled",
    "quote-box-pressing",
    "quote-box-pending",
    "quote-box-latched",
    "quote-triggered-up",
    "quote-triggered-down",
    "is-buyable",
    "is-buy-disabled",
    "is-up",
    "is-down",
    "is-none",
    "is-pending",
    "is-right",
    "is-wrong",
    "is-result-only",
    "is-sell-disabled",
    "prediction-status-box",
  );
  box.removeAttribute("role");
  box.removeAttribute("tabindex");
  box.removeAttribute("aria-disabled");
}

function setPredictionBuyWaitingUi() {
  const box = $("prediction-buy-box");
  const label = $("prediction-status-label");
  const icon = $("prediction-status-icon");
  const quote = $("prediction-buy-quote");
  if (!box) return;
  clearPredictionQuoteBoxClasses(box);
  box.className = "quote-box quote-box-disabled";
  box.setAttribute("aria-label", "Buy disabled");
  box.setAttribute("aria-disabled", "true");
  if (label) {
    label.hidden = true;
    label.textContent = "";
  }
  if (icon) {
    icon.hidden = true;
    icon.innerHTML = "";
  }
  if (quote) quote.hidden = false;
  const locked = $("prediction-buy-locked");
  const live = $("prediction-buy-live");
  if (locked) {
    locked.hidden = true;
    locked.textContent = "";
  }
  if (live) live.textContent = "—";
  locked?.parentElement?.classList.remove("quote-has-locked");
}

function setPredictionSellResultIcon(kind) {
  const icon = $("prediction-sell-result-icon");
  if (!icon) return;
  if (kind !== "right" && kind !== "wrong") {
    icon.hidden = true;
    icon.innerHTML = "";
    icon.classList.remove("is-right", "is-wrong");
    return;
  }
  icon.hidden = false;
  icon.classList.toggle("is-right", kind === "right");
  icon.classList.toggle("is-wrong", kind === "wrong");
  icon.innerHTML = kind === "right" ? PREDICTION_ICON_CHECK : PREDICTION_ICON_CROSS;
}

function setPredictionSellDisabledUi() {
  const box = $("prediction-sell-box");
  const quote = $("prediction-sell-quote");
  if (!box) return;
  clearPredictionQuoteBoxClasses(box);
  box.className = "quote-box quote-box-disabled";
  box.setAttribute("aria-label", "Sell disabled");
  box.setAttribute("aria-disabled", "true");
  if (quote) quote.hidden = false;
  const locked = $("prediction-sell-locked");
  const live = $("prediction-sell-live");
  if (locked) {
    locked.hidden = true;
    locked.textContent = "";
  }
  if (live) live.textContent = "—";
  locked?.parentElement?.classList.remove("quote-has-locked");
  setPredictionSellResultIcon(null);
}

/** Simulated Buy fill: locked trigger price + live Ask; always disabled. */
function setPredictionBuySimulatedUi(side, state = windowState) {
  const box = $("prediction-buy-box");
  const label = $("prediction-status-label");
  const icon = $("prediction-status-icon");
  const quote = $("prediction-buy-quote");
  if (!box || (side !== "up" && side !== "down")) return;
  clearPredictionQuoteBoxClasses(box);
  box.className = `quote-box ${side === "up" ? "quote-box-up" : "quote-box-down"} quote-box-disabled quote-box-latched ${
    side === "up" ? "quote-triggered-up" : "quote-triggered-down"
  }`;
  box.setAttribute("aria-label", `Buy Prediction ${side.toUpperCase()} (simulated fill)`);
  box.setAttribute("aria-disabled", "true");
  box.removeAttribute("role");
  box.removeAttribute("tabindex");
  if (label) {
    label.hidden = true;
    label.textContent = "";
  }
  if (icon) {
    icon.hidden = true;
    icon.innerHTML = "";
  }
  if (quote) quote.hidden = false;
  const lockedEl = $("prediction-buy-locked");
  const liveEl = $("prediction-buy-live");
  const values = lockedEl?.parentElement;
  const triggerBuy = manipDetectorRuntime.predictionTriggerBuy;
  const liveAsk = side === "up" ? state?.yesAsk : state?.noAsk;
  if (lockedEl && Number.isFinite(triggerBuy)) {
    lockedEl.hidden = false;
    lockedEl.textContent = fmtQuote(triggerBuy);
    values?.classList.add("quote-has-locked");
  } else if (lockedEl) {
    lockedEl.hidden = true;
    lockedEl.textContent = "";
    values?.classList.remove("quote-has-locked");
  }
  if (liveEl) liveEl.textContent = fmtQuote(liveAsk);
}

/**
 * Active Sell while prediction open; latches + ✓ when Right; ✕ when Wrong.
 * Clickable for a real sell when a position exists; always looks live/active otherwise.
 */
function setPredictionSellActiveUi(side, state = windowState) {
  const box = $("prediction-sell-box");
  const quote = $("prediction-sell-quote");
  if (!box || (side !== "up" && side !== "down")) return;
  const phase = manipDetectorRuntime.uiPhase;
  const latched =
    phase === "right" && Number.isFinite(manipDetectorRuntime.predictionSellLock);
  const isWrong = phase === "wrong";
  const trading = tradingState(state);
  const detectorOn = Boolean($("manipulation-detector")?.checked);
  // Visually active while prediction is open (not hold-gated). Click still needs a real position.
  const clickable = detectorOn && !latched && !isWrong && canQuoteAction(trading, side, "sell");
  clearPredictionQuoteBoxClasses(box);
  box.className = `quote-box ${side === "up" ? "quote-box-up" : "quote-box-down"}`;
  if (latched || isWrong) {
    box.classList.add("quote-box-disabled");
    if (latched) {
      box.classList.add(
        "quote-box-latched",
        side === "up" ? "quote-triggered-up" : "quote-triggered-down",
      );
    }
    box.setAttribute("aria-disabled", "true");
    box.removeAttribute("role");
    box.removeAttribute("tabindex");
    box.setAttribute(
      "aria-label",
      isWrong
        ? `Sell Prediction ${side.toUpperCase()} wrong`
        : `Sell Prediction ${side.toUpperCase()} right`,
    );
  } else {
    box.classList.remove("quote-box-disabled");
    box.setAttribute("aria-disabled", clickable ? "false" : "true");
    box.setAttribute("role", "button");
    box.tabIndex = 0;
    box.setAttribute("aria-label", `Sell Prediction ${side.toUpperCase()}`);
  }
  if (quote) quote.hidden = false;
  const lockedEl = $("prediction-sell-locked");
  const liveEl = $("prediction-sell-live");
  const values = lockedEl?.parentElement;
  const liveBid = side === "up" ? state?.yesBid : state?.noBid;
  if (liveEl) liveEl.textContent = fmtQuote(liveBid);
  if (latched) {
    if (lockedEl) {
      lockedEl.hidden = false;
      lockedEl.textContent = fmtQuote(manipDetectorRuntime.predictionSellLock);
    }
    values?.classList.add("quote-has-locked");
    setPredictionSellResultIcon("right");
  } else if (isWrong) {
    if (lockedEl) {
      lockedEl.hidden = true;
      lockedEl.textContent = "";
    }
    values?.classList.remove("quote-has-locked");
    setPredictionSellResultIcon("wrong");
  } else {
    if (lockedEl) {
      lockedEl.hidden = true;
      lockedEl.textContent = "";
    }
    values?.classList.remove("quote-has-locked");
    setPredictionSellResultIcon(null);
  }
}

/** Keep Prediction Buy/Sell prices + latch in sync while a prediction is open. */
function syncPredictionActionBoxes(state = windowState) {
  const side = manipDetectorRuntime.predictionSide;
  const phase = manipDetectorRuntime.uiPhase;
  if (
    (phase !== "active" && phase !== "right" && phase !== "wrong") ||
    (side !== "up" && side !== "down")
  ) {
    return;
  }
  setPredictionBuySimulatedUi(side, state);
  setPredictionSellActiveUi(side, state);
}

function syncPredictionStatusUi() {
  const buyBox = $("prediction-buy-box");
  const sellBox = $("prediction-sell-box");
  if (!buyBox || !sellBox) return;

  const side = manipDetectorRuntime.predictionSide;
  const phase = manipDetectorRuntime.uiPhase;

  // Right / Wrong: keep simulated Buy + Sell result briefly (✓ / ✕ on Sell).
  if (
    (phase === "right" || phase === "wrong") &&
    (side === "up" || side === "down")
  ) {
    setPredictionBuySimulatedUi(side, windowState);
    setPredictionSellActiveUi(side, windowState);
    return;
  }

  if (phase === "active" && (side === "up" || side === "down")) {
    setPredictionBuySimulatedUi(side, windowState);
    setPredictionSellActiveUi(side, windowState);
    return;
  }

  // Idle / cleared — disabled Buy + disabled Sell until next trigger.
  setPredictionBuyWaitingUi();
  setPredictionSellDisabledUi();
}

function bindPredictionActionBox(box, _leg) {
  if (!box || box.dataset.predBound === "1") return;
  box.dataset.predBound = "1";
  // Visual latch / status only — never places orders.
  box.classList.add("quote-box-display");
  box.setAttribute("aria-disabled", "true");
}

function bindPredictionStatusBuyButton() {
  bindPredictionActionBox($("prediction-buy-box"), "buy");
  bindPredictionActionBox($("prediction-sell-box"), "sell");
}

function syncPredictionStatsUi() {
  const rightEl = $("prediction-stats-right");
  const wrongEl = $("prediction-stats-wrong");
  if (rightEl) rightEl.textContent = String(manipDetectorRuntime.rightCount);
  if (wrongEl) wrongEl.textContent = String(manipDetectorRuntime.wrongCount);
}

function persistPredictionStats() {
  const patch = buildTradingConfigPatch({
    predictionRightCount: manipDetectorRuntime.rightCount,
    predictionWrongCount: manipDetectorRuntime.wrongCount,
  });
  writeLocalTradingConfig(patch);
  manipDetectorRuntime.statsPersistChain = manipDetectorRuntime.statsPersistChain
    .then(() => pushTradingConfig(patch))
    .catch(() => null);
  return manipDetectorRuntime.statsPersistChain;
}

function recordPredictionScore(side, windowStart, right, { showResultUi, source, triggerId } = {}) {
  if (side !== "up" && side !== "down") return false;
  if (windowStart == null || !Number.isFinite(windowStart)) return false;
  if (typeof right !== "boolean") return false;
  if (isPredictionWindowScored(windowStart)) return false;

  const resolvedTriggerId =
    (typeof triggerId === "string" && triggerId) ||
    manipDetectorRuntime.predictionTriggerId ||
    `${windowStart}:${right ? "right" : "wrong"}:${Date.now()}`;
  if (isPredictionTriggerScored(resolvedTriggerId)) return false;

  markPredictionTriggerScored(resolvedTriggerId);
  // Wrong locks the window (typically window end). Right does not — re-trigger allowed.
  if (!right) markPredictionWindowScored(windowStart);
  else {
    // Let detection arm again while Trigger Area remains open (fresh Duration samples).
    manipDetectorRuntime.cooldownUntilMs = 0;
    manipDetectorRuntime.samples = [];
    clearManipulationFlash();
  }

  if (right) manipDetectorRuntime.rightCount += 1;
  else manipDetectorRuntime.wrongCount += 1;
  syncPredictionStatsUi();
  void persistPredictionStats();
  settlePredictionPositionCard(side, windowStart, right, resolvedTriggerId);
  appendLogEntry({
    level: "info",
    source: "client",
    message: `Prediction ${side.toUpperCase()} → ${right ? "right" : "wrong"} (profit prediction${
      source ? `, ${source}` : ""
    })`,
  });

  if (showResultUi) {
    stopPredictionResolveLoop();
    stopPredictionResultClearTimer();
    clearManipulationFlash();
    manipDetectorRuntime.cooldownUntilMs = 0;
    // Right: latched Sell + ✓. Wrong: ✕ on Sell. Then reset after the brief show.
    manipDetectorRuntime.uiPhase = right ? "right" : "wrong";
    syncPredictionStatusUi();
    manipDetectorRuntime.resultClearTimer = setTimeout(() => {
      manipDetectorRuntime.resultClearTimer = null;
      if (manipDetectorRuntime.uiPhase !== "right" && manipDetectorRuntime.uiPhase !== "wrong") {
        return;
      }
      if (manipDetectorRuntime.predictionWindowStart !== windowStart) return;
      manipDetectorRuntime.predictionSide = null;
      manipDetectorRuntime.predictionWindowStart = null;
      manipDetectorRuntime.predictionWindowEnd = null;
      manipDetectorRuntime.predictionSlug = null;
      manipDetectorRuntime.predictionTriggerBuy = null;
      manipDetectorRuntime.predictionProfitBasis = null;
      manipDetectorRuntime.predictionBuyPending = false;
      manipDetectorRuntime.predictionSellLock = null;
      manipDetectorRuntime.predictionTriggerId = null;
      manipDetectorRuntime.predictionTraded = false;
      manipDetectorRuntime.uiPhase = "none";
      syncPredictionStatusUi();
      persistPredictionRuntime();
    }, PREDICTION_RESULT_SHOW_MS);
  } else if (
    manipDetectorRuntime.predictionWindowStart === windowStart &&
    manipDetectorRuntime.predictionTriggerId === resolvedTriggerId &&
    (manipDetectorRuntime.uiPhase === "active" || manipDetectorRuntime.uiPhase === "pending")
  ) {
    manipDetectorRuntime.predictionSide = null;
    manipDetectorRuntime.predictionWindowStart = null;
    manipDetectorRuntime.predictionWindowEnd = null;
    manipDetectorRuntime.predictionSlug = null;
    manipDetectorRuntime.predictionTriggerBuy = null;
    manipDetectorRuntime.predictionProfitBasis = null;
    manipDetectorRuntime.predictionBuyPending = false;
    manipDetectorRuntime.predictionSellLock = null;
    manipDetectorRuntime.predictionTriggerId = null;
    manipDetectorRuntime.predictionTraded = false;
    manipDetectorRuntime.uiPhase = "none";
    clearManipulationFlash();
    manipDetectorRuntime.cooldownUntilMs = 0;
    syncPredictionStatusUi();
  }

  persistPredictionRuntime();
  return true;
}

/** Score Wrong when the window ends without a Profit prediction hit (foreground). */
function finalizePredictionAtWindowEnd({ showResultUi = true, source = "window-end" } = {}) {
  const side = manipDetectorRuntime.predictionSide;
  const windowStart = manipDetectorRuntime.predictionWindowStart;
  if (side !== "up" && side !== "down") return false;
  if (windowStart == null || !Number.isFinite(windowStart)) return false;
  if (isPredictionWindowScored(windowStart)) return false;
  stopPredictionResolveLoop();
  return recordPredictionScore(side, windowStart, false, {
    showResultUi,
    source,
    triggerId: manipDetectorRuntime.predictionTriggerId,
  });
}

function removeBackgroundResolution(windowStart) {
  const idx = manipDetectorRuntime.backgroundResolutions.findIndex(
    (job) => job.windowStart === windowStart,
  );
  if (idx < 0) return null;
  const [job] = manipDetectorRuntime.backgroundResolutions.splice(idx, 1);
  if (job.timer != null) {
    clearTimeout(job.timer);
    job.timer = null;
  }
  return job;
}

function enqueueBackgroundResolution({
  side,
  windowStart,
  windowEnd,
  triggerSideBuy,
  profitBasis,
  riseCents,
  triggerId,
  traded,
  buyPending,
  slug,
  lastPrice,
  lastPtb,
  resolveStartedAt,
}) {
  if (side !== "up" && side !== "down") return false;
  if (windowStart == null || !Number.isFinite(windowStart)) return false;
  if (isPredictionWindowScored(windowStart)) return false;
  const resolvedTriggerId =
    (typeof triggerId === "string" && triggerId) ||
    `${windowStart}:bg:${Date.now()}`;
  if (isPredictionTriggerScored(resolvedTriggerId)) return false;
  if (
    manipDetectorRuntime.backgroundResolutions.some(
      (j) => j.triggerId === resolvedTriggerId || j.windowStart === windowStart,
    )
  ) {
    return false;
  }
  const nowMs = Date.now();
  const endSec = Number.isFinite(windowEnd) ? windowEnd : null;
  if (endSec != null && nowMs >= endSec * 1000) {
    recordPredictionScore(side, windowStart, false, {
      showResultUi: false,
      source: "window-end",
      triggerId: resolvedTriggerId,
    });
    return true;
  }
  const triggerBuy = Number.isFinite(triggerSideBuy) ? triggerSideBuy : null;
  const job = {
    side,
    windowStart,
    windowEnd: endSec,
    triggerSideBuy: triggerBuy,
    profitBasis: Number.isFinite(profitBasis) ? profitBasis : triggerBuy,
    riseCents: normalizePredictionRiseCents(riseCents),
    triggerId: resolvedTriggerId,
    traded: Boolean(traded),
    buyPending: Boolean(buyPending),
    slug: typeof slug === "string" && slug.trim() ? slug.trim() : null,
    lastPrice: Number.isFinite(lastPrice) ? lastPrice : null,
    lastPtb: Number.isFinite(lastPtb) ? lastPtb : null,
    resolveStartedAt:
      Number.isFinite(resolveStartedAt) && resolveStartedAt > 0 ? resolveStartedAt : Date.now(),
    timer: null,
  };
  manipDetectorRuntime.backgroundResolutions.push(job);
  persistPredictionRuntime();
  return true;
}

/** Move foreground prediction into background so a newer trigger can take the status box. */
function parkForegroundPredictionToBackground() {
  const phase = manipDetectorRuntime.uiPhase;
  if (phase !== "pending" && phase !== "active") return false;
  const side = manipDetectorRuntime.predictionSide;
  const windowStart = manipDetectorRuntime.predictionWindowStart;
  if (side !== "up" && side !== "down") return false;
  if (windowStart == null || !Number.isFinite(windowStart)) return false;
  if (isPredictionWindowScored(windowStart)) return false;

  if (manipDetectorRuntime.resolveTimer != null) {
    clearTimeout(manipDetectorRuntime.resolveTimer);
    manipDetectorRuntime.resolveTimer = null;
  }

  enqueueBackgroundResolution({
    side,
    windowStart,
    windowEnd: manipDetectorRuntime.predictionWindowEnd,
    triggerSideBuy: manipDetectorRuntime.predictionTriggerBuy,
    profitBasis: predictionProfitBasisPrice(),
    riseCents: manipDetectorRuntime.predictionRiseCents,
    triggerId: manipDetectorRuntime.predictionTriggerId,
    traded: manipDetectorRuntime.predictionTraded,
    buyPending: manipDetectorRuntime.predictionBuyPending,
    slug: manipDetectorRuntime.predictionSlug,
    lastPrice: manipDetectorRuntime.lastPrice,
    lastPtb: manipDetectorRuntime.lastPtb,
    resolveStartedAt: manipDetectorRuntime.resolveStartedAt || Date.now(),
  });

  manipDetectorRuntime.predictionSide = null;
  manipDetectorRuntime.predictionWindowStart = null;
  manipDetectorRuntime.predictionWindowEnd = null;
  manipDetectorRuntime.predictionSlug = null;
  manipDetectorRuntime.predictionTriggerBuy = null;
  manipDetectorRuntime.predictionProfitBasis = null;
  manipDetectorRuntime.predictionBuyPending = false;
  manipDetectorRuntime.predictionSellLock = null;
  manipDetectorRuntime.predictionTriggerId = null;
  manipDetectorRuntime.predictionTraded = false;
  manipDetectorRuntime.uiPhase = "none";
  manipDetectorRuntime.resolveStartedAt = 0;
  return true;
}

function clearForegroundPredictionUi() {
  stopPredictionResolveLoop();
  stopPredictionResultClearTimer();
  manipDetectorRuntime.predictionSide = null;
  manipDetectorRuntime.predictionWindowStart = null;
  manipDetectorRuntime.predictionWindowEnd = null;
  manipDetectorRuntime.predictionSlug = null;
  manipDetectorRuntime.predictionTriggerBuy = null;
  manipDetectorRuntime.predictionProfitBasis = null;
  manipDetectorRuntime.predictionBuyPending = false;
  manipDetectorRuntime.predictionSellLock = null;
  manipDetectorRuntime.predictionTraded = false;
  manipDetectorRuntime.predictionTriggerId = null;
  manipDetectorRuntime.uiPhase = "none";
}

/** Watch predicted-side Sell (Bid) for Profit prediction hits (foreground + parked background). */
function watchPredictionRiseOnQuotes(upBid, downBid, state) {
  if (!Number.isFinite(upBid) || !Number.isFinite(downBid)) return;

  if (
    manipDetectorRuntime.uiPhase === "active" &&
    (manipDetectorRuntime.predictionSide === "up" ||
      manipDetectorRuntime.predictionSide === "down") &&
    manipDetectorRuntime.predictionWindowStart != null &&
    !manipDetectorRuntime.predictionBuyPending &&
    !isPredictionWindowScored(manipDetectorRuntime.predictionWindowStart) &&
    sellMeetsPredictionRise(
      manipDetectorRuntime.predictionSide,
      upBid,
      downBid,
      predictionProfitBasisPrice(),
      manipDetectorRuntime.predictionRiseCents,
    )
  ) {
    manipDetectorRuntime.predictionSellLock = predictedSideSell(
      manipDetectorRuntime.predictionSide,
      upBid,
      downBid,
    );
    const rightSide = manipDetectorRuntime.predictionSide;
    if (manipDetectorRuntime.predictionTraded && !isPredictionSellGtd()) {
      void placePredictionTradeOrder(rightSide, "sell");
    }
    recordPredictionScore(rightSide, manipDetectorRuntime.predictionWindowStart, true, {
      showResultUi: true,
      source: "rise",
      triggerId: manipDetectorRuntime.predictionTriggerId,
    });
  }

  const nowMs = Date.now();
  for (const job of [...manipDetectorRuntime.backgroundResolutions]) {
    if (isPredictionWindowScored(job.windowStart)) {
      removeBackgroundResolution(job.windowStart);
      persistPredictionRuntime();
      continue;
    }
    if (job.windowEnd != null && Number.isFinite(job.windowEnd) && nowMs >= job.windowEnd * 1000) {
      removeBackgroundResolution(job.windowStart);
      recordPredictionScore(job.side, job.windowStart, false, {
        showResultUi: false,
        source: "window-end",
        triggerId: job.triggerId,
      });
      continue;
    }
    const jobBasis = Number.isFinite(job.profitBasis) ? job.profitBasis : job.triggerSideBuy;
    if (
      state?.windowStart === job.windowStart &&
      !job.buyPending &&
      sellMeetsPredictionRise(job.side, upBid, downBid, jobBasis, job.riseCents)
    ) {
      removeBackgroundResolution(job.windowStart);
      if (job.traded && !isPredictionSellGtd()) {
        void placePredictionTradeOrder(job.side, "sell");
      }
      recordPredictionScore(job.side, job.windowStart, true, {
        showResultUi: false,
        source: "rise",
        triggerId: job.triggerId,
      });
    }
  }
}

function clearPredictionForNewWindow() {
  // Keep Sell ✓ / ✕ visible for their timed window.
  if (manipDetectorRuntime.uiPhase === "right" || manipDetectorRuntime.uiPhase === "wrong") return;
  if (manipDetectorRuntime.uiPhase === "active" || manipDetectorRuntime.uiPhase === "pending") {
    // Score Wrong if the previous window's prediction never hit Profit prediction.
    finalizePredictionAtWindowEnd({ showResultUi: false, source: "window-end" });
    return;
  }
  stopPredictionResolveLoop();
  manipDetectorRuntime.predictionSide = null;
  manipDetectorRuntime.predictionWindowStart = null;
  manipDetectorRuntime.predictionWindowEnd = null;
  manipDetectorRuntime.predictionSlug = null;
  manipDetectorRuntime.predictionTriggerBuy = null;
  manipDetectorRuntime.predictionProfitBasis = null;
  manipDetectorRuntime.predictionBuyPending = false;
  manipDetectorRuntime.predictionSellLock = null;
  manipDetectorRuntime.predictionTriggerId = null;
  manipDetectorRuntime.uiPhase = "none";
  syncPredictionStatusUi();
  persistPredictionRuntime();
}

function predictionHoldsWindow(windowStart) {
  if (windowStart == null || !Number.isFinite(windowStart)) return false;
  // Wrong at window end locks the window. Right does not — re-trigger is allowed.
  if (isPredictionWindowScored(windowStart)) return true;
  if (
    manipDetectorRuntime.predictionWindowStart === windowStart &&
    (manipDetectorRuntime.uiPhase === "active" || manipDetectorRuntime.uiPhase === "pending")
  ) {
    return true;
  }
  return manipDetectorRuntime.backgroundResolutions.some((job) => job.windowStart === windowStart);
}

function setActivePrediction(side, state, { triggerSideBuy, riseCents } = {}) {
  if (side !== "up" && side !== "down") return false;
  const windowStart = state?.windowStart;
  if (windowStart == null || !Number.isFinite(windowStart)) return false;
  if (predictionHoldsWindow(windowStart)) return false;
  if (!Number.isFinite(triggerSideBuy)) return false;

  const phase = manipDetectorRuntime.uiPhase;
  if (phase === "pending" || phase === "active") {
    if (manipDetectorRuntime.predictionWindowStart !== windowStart) {
      parkForegroundPredictionToBackground();
    } else if (manipDetectorRuntime.predictionSide != null) {
      return false;
    }
  } else if (phase === "right" || phase === "wrong") {
    clearForegroundPredictionUi();
  } else if (manipDetectorRuntime.predictionSide != null) {
    return false;
  }

  const triggerId = `${windowStart}:${Date.now()}`;
  manipDetectorRuntime.predictionSide = side;
  manipDetectorRuntime.predictionWindowStart = windowStart;
  manipDetectorRuntime.predictionWindowEnd =
    state?.windowEnd != null && Number.isFinite(state.windowEnd) ? state.windowEnd : null;
  manipDetectorRuntime.predictionSlug =
    typeof state?.slug === "string" && state.slug.trim() ? state.slug.trim() : null;
  manipDetectorRuntime.predictionTriggerBuy = triggerSideBuy;
  manipDetectorRuntime.predictionProfitBasis = triggerSideBuy;
  manipDetectorRuntime.predictionBuyPending = false;
  manipDetectorRuntime.predictionSellLock = null;
  manipDetectorRuntime.predictionTriggerId = triggerId;
  manipDetectorRuntime.predictionRiseCents = normalizePredictionRiseCents(riseCents);
  manipDetectorRuntime.uiPhase = "active";
  // Only mark traded after a successful buy — phase (or other) open position blocks Prediction.
  manipDetectorRuntime.predictionTraded = false;
  syncPredictionStatusUi();
  persistPredictionRuntime();
  ensurePredictionPositionCard({
    side,
    windowStart,
    windowEnd: manipDetectorRuntime.predictionWindowEnd,
    slug: manipDetectorRuntime.predictionSlug,
    buyAt: Date.now() / 1000,
    triggerId,
    sim: !isPredictionTradeArmed(),
    triggerBuy: triggerSideBuy,
    riseCents: manipDetectorRuntime.predictionRiseCents,
  });
  if (isPredictionTradeArmed()) {
    manipDetectorRuntime.predictionBuyPending = true;
    persistPredictionRuntime();
    void placePredictionTradeOrder(side, "buy").then((result) => {
      const ok = Boolean(result?.ok);
      const fillPrice = Number(result?.body?.fillPrice);
      const fillShares = Number(result?.body?.fillShares);
      const basis =
        ok && Number.isFinite(fillPrice) ? fillPrice : triggerSideBuy;

      if (manipDetectorRuntime.predictionTriggerId === triggerId) {
        manipDetectorRuntime.predictionBuyPending = false;
        manipDetectorRuntime.predictionTraded = ok;
        manipDetectorRuntime.predictionProfitBasis = basis;
      } else {
        const job = manipDetectorRuntime.backgroundResolutions.find(
          (j) => j.triggerId === triggerId,
        );
        if (job) {
          job.buyPending = false;
          job.traded = ok;
          job.profitBasis = basis;
        }
      }

      const id = predictionCardId(selectedSeries || "btc-5m", windowStart, triggerId);
      const card = predictionPositionCards.find((c) => c.id === id);
      if (!ok) {
        // Keep scoring/UI on trigger Ask; no real Prediction position — phase may still race.
        if (card && card.status === "open") {
          upsertPredictionPositionCard(
            {
              ...card,
              sim: true,
              targetPrice: predictionTargetPrice(triggerSideBuy, card.riseCents),
            },
            { refresh: true },
          );
        }
      } else if (card && card.status === "open") {
        upsertPredictionPositionCard(
          {
            ...card,
            sim: false,
            buyPrice: Number.isFinite(fillPrice) ? fillPrice : card.buyPrice ?? card.triggerBuy,
            shares: Number.isFinite(fillShares) ? fillShares : card.shares,
            targetPrice: predictionTargetPrice(basis, card.riseCents),
          },
          { refresh: true },
        );
      }
      persistPredictionRuntime();
      syncPredictionStatusUi();
    });
  }
  return true;
}

function manipulationWindowDurationSec(state = windowState) {
  const ws = state?.windowStart;
  const we = state?.windowEnd;
  if (ws != null && we != null && Number.isFinite(ws) && Number.isFinite(we) && we > ws) {
    return we - ws;
  }
  return 300;
}

/** Format a fraction of the market window as m:ss (or h:mm:ss if needed). */
function fmtManipAreaTime(frac, durationSec = manipulationWindowDurationSec()) {
  const total = Math.max(0, Math.round(Number(frac) * Number(durationSec)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Thumb diameter (px) — keep in sync with --manip-thumb-size in CSS. */
const MANIP_THUMB_PX = 12;

/** CSS left for thumb left-edge travel across (trackWidth - thumb). */
function manipThumbLeftCss(frac) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  return `calc(${f} * (100% - ${MANIP_THUMB_PX}px))`;
}

/** CSS left for label centered under the thumb. */
function manipThumbCenterCss(frac) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  return `calc(${f} * (100% - ${MANIP_THUMB_PX}px) + ${MANIP_THUMB_PX / 2}px)`;
}

function syncManipulationAreaUi() {
  const area = normalizeManipulationArea(manipAreaStart, manipAreaEnd);
  manipAreaStart = area.manipulationAreaStart;
  manipAreaEnd = area.manipulationAreaEnd;
  const durationSec = manipulationWindowDurationSec();
  const range = $("manipulation-area-range");
  const startThumb = $("manipulation-area-start");
  const endThumb = $("manipulation-area-end");
  const startLabel = $("manipulation-area-start-label");
  const endLabel = $("manipulation-area-end-label");
  const span = Math.max(0, manipAreaEnd - manipAreaStart);
  if (range) {
    // Blue segment between thumb centers.
    range.style.left = manipThumbCenterCss(manipAreaStart);
    range.style.width = `calc(${span} * (100% - ${MANIP_THUMB_PX}px))`;
  }
  if (startThumb) startThumb.style.left = manipThumbLeftCss(manipAreaStart);
  if (endThumb) endThumb.style.left = manipThumbLeftCss(manipAreaEnd);
  if (startLabel) {
    startLabel.textContent = fmtManipAreaTime(manipAreaStart, durationSec);
    startLabel.style.left = manipThumbCenterCss(manipAreaStart);
  }
  if (endLabel) {
    endLabel.textContent = fmtManipAreaTime(manipAreaEnd, durationSec);
    endLabel.style.left = manipThumbCenterCss(manipAreaEnd);
  }
}

function syncManipulationSettingsEnabled(enabled) {
  const card = $("manipulation-detector-card");
  const label = $("manipulation-detector-label");
  const settings = $("manipulation-detector-settings");
  const tradeField = $("prediction-trade-field");
  const maxQuoteInput = $("prediction-max-quote");
  const minQuoteInput = $("prediction-min-quote");
  const shiftInput = $("prediction-shift");
  const riseInput = $("prediction-rise");
  const sensInput = $("manipulation-sensitivity");
  const sharesInput = $("prediction-shares");
  const buyTypeSelect = $("prediction-buy-order-type");
  const sellTypeSelect = $("prediction-sell-order-type");
  const startThumb = $("manipulation-area-start");
  const endThumb = $("manipulation-area-end");
  const on = Boolean(enabled);
  if (card) card.classList.toggle("is-disabled", !on);
  if (label) label.textContent = on ? "Prediction · On" : "Prediction · Off";
  if (settings) settings.setAttribute("aria-hidden", on ? "false" : "true");
  if (tradeField) tradeField.setAttribute("aria-hidden", on ? "false" : "true");
  if (maxQuoteInput) maxQuoteInput.disabled = !on;
  if (minQuoteInput) minQuoteInput.disabled = !on;
  if (shiftInput) shiftInput.disabled = !on;
  if (riseInput) riseInput.disabled = !on;
  if (sensInput) sensInput.disabled = !on;
  if (sharesInput) sharesInput.disabled = !on;
  if (buyTypeSelect) buyTypeSelect.disabled = !on;
  if (sellTypeSelect) sellTypeSelect.disabled = !on;
  if (startThumb) startThumb.disabled = !on;
  if (endThumb) endThumb.disabled = !on;
  syncPredictionTradeEnabled();
}

function clearManipulationFlash() {
  if (manipDetectorRuntime.flashTimer != null) {
    clearTimeout(manipDetectorRuntime.flashTimer);
    manipDetectorRuntime.flashTimer = null;
  }
  manipDetectorRuntime.flashUntilMs = 0;
  $("price-graph-wrap")?.classList.remove(
    "price-graph-wrap--manipulation",
    "price-graph-wrap--prediction-up",
    "price-graph-wrap--prediction-down",
  );
}

function resetManipulationDetector() {
  manipDetectorRuntime.samples = [];
  manipDetectorRuntime.windowStart = null;
  manipDetectorRuntime.cooldownUntilMs = 0;
  stopPredictionResolveLoop();
  stopPredictionResultClearTimer();
  stopBackgroundResolutionTimers();
  manipDetectorRuntime.backgroundResolutions = [];
  manipDetectorRuntime.predictionSide = null;
  manipDetectorRuntime.predictionWindowStart = null;
  manipDetectorRuntime.predictionWindowEnd = null;
  manipDetectorRuntime.predictionSlug = null;
  manipDetectorRuntime.predictionTriggerBuy = null;
  manipDetectorRuntime.predictionProfitBasis = null;
  manipDetectorRuntime.predictionBuyPending = false;
  manipDetectorRuntime.predictionSellLock = null;
  manipDetectorRuntime.predictionTriggerId = null;
  manipDetectorRuntime.predictionTraded = false;
  manipDetectorRuntime.uiPhase = "none";
  manipDetectorRuntime.scoredWindowStarts = [];
  manipDetectorRuntime.scoredTriggerIds = [];
  manipDetectorRuntime.lastPrice = null;
  manipDetectorRuntime.lastPtb = null;
  clearManipulationFlash();
  syncPredictionStatusUi();
}

function triggerManipulationFlash(state, predictionSide, triggerSideBuy) {
  if (predictionSide !== "up" && predictionSide !== "down") return;
  if (!Number.isFinite(triggerSideBuy)) return;

  const now = Date.now();
  const windowEndMs =
    state?.windowEnd != null && Number.isFinite(state.windowEnd)
      ? state.windowEnd * 1000
      : null;
  const duration = windowEndMs != null ? Math.max(0, windowEndMs - now) : null;
  if (duration != null && duration <= 0) return;

  if (
    !setActivePrediction(predictionSide, state, {
      triggerSideBuy,
      riseCents: normalizePredictionRiseCents($("prediction-rise")?.value),
    })
  ) {
    return;
  }
  manipDetectorRuntime.samples = [];
  restorePredictionGraphBorder(predictionSide, state?.windowEnd);
}

function isInManipulationArea(state, areaStart, areaEnd) {
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

/** Apply-window bounds in unix seconds for a trigger (wall-clock arming). */
function triggerApplyBoundsSec(state, areaStart, areaEnd) {
  const ws = state?.windowStart;
  const we = state?.windowEnd;
  if (ws == null || we == null || !Number.isFinite(ws) || !Number.isFinite(we) || we <= ws) {
    return null;
  }
  const area = normalizeTriggerWindowArea(areaStart, areaEnd);
  const dur = we - ws;
  return {
    windowStart: ws,
    windowEnd: we,
    startSec: ws + area.start * dur,
    endSec: ws + area.end * dur,
  };
}

/**
 * True when wall clock is inside the trigger Apply window.
 * Used for Buy GTD so rests arm at Apply/window start without waiting for a quote/tick.
 */
function isInTriggerApplyAreaNow(state, areaStart, areaEnd) {
  const bounds = triggerApplyBoundsSec(state, areaStart, areaEnd);
  if (!bounds) return false;
  const nowSec = Date.now() / 1000;
  if (nowSec < bounds.windowStart || nowSec >= bounds.windowEnd) return false;
  return nowSec >= bounds.startSec && nowSec <= bounds.endSec;
}

/** Per-trigger runtime: watching start→end pattern, or open TP/SL position. */
const triggerRuntimeById = new Map();
/**
 * Held-to-window settlements waiting on official UP/DOWN (`/api/window-resolution`).
 * Live window SSE state has no `outcome`, so we must poll after the window ends.
 * @type {Map<string, {
 *   triggerId: string,
 *   side: "up" | "down",
 *   entryPrice: number,
 *   entryShares: number,
 *   runMode: "demo" | "trade",
 *   windowStart: number | null,
 *   slug: string,
 *   attempts: number,
 *   timer: ReturnType<typeof setTimeout> | null,
 * }>}
 */
const triggerPendingHeldById = new Map();
/**
 * Resume Gamma settlement for past-window open Demo Positions cards (localStorage).
 * Keyed by card id so refresh/abandon can retry across sessions.
 * @type {Map<string, {
 *   cardId: string,
 *   slug: string,
 *   attempts: number,
 *   timer: ReturnType<typeof setTimeout> | null,
 * }>}
 */
const triggerPendingResumeDemoByCardId = new Map();
/**
 * Chart overlays for fired trigger buys in the current market window.
 * Each hit: duration band (watch→buy) + buy dot.
 * @type {Array<{
 *   triggerId: string,
 *   windowStart: number,
 *   side: "up" | "down",
 *   watchStartSec: number,
 *   buySec: number,
 *   y: number | null,
 * }>}
 */
let triggerChartHits = [];

function clearTriggerPendingHeld(triggerId) {
  const id = String(triggerId || "");
  if (!id) {
    for (const pending of triggerPendingHeldById.values()) {
      if (pending?.timer != null) clearTimeout(pending.timer);
    }
    triggerPendingHeldById.clear();
    return;
  }
  const pending = triggerPendingHeldById.get(id);
  if (pending?.timer != null) clearTimeout(pending.timer);
  triggerPendingHeldById.delete(id);
}

function clearTriggerPendingResumeDemo(cardId) {
  const id = String(cardId || "");
  if (!id) {
    for (const pending of triggerPendingResumeDemoByCardId.values()) {
      if (pending?.timer != null) clearTimeout(pending.timer);
    }
    triggerPendingResumeDemoByCardId.clear();
    return;
  }
  const pending = triggerPendingResumeDemoByCardId.get(id);
  if (pending?.timer != null) clearTimeout(pending.timer);
  triggerPendingResumeDemoByCardId.delete(id);
}

/** True when in-memory held settle already covers this open Demo card. */
function isDemoOpenCardCoveredByHeldPending(card) {
  const tid = card?.triggerId != null ? String(card.triggerId) : "";
  if (!tid) return false;
  const pending = triggerPendingHeldById.get(tid);
  if (!pending || pending.runMode === "trade") return false;
  const cardSide = card.side === "down" ? "down" : card.side === "up" ? "up" : null;
  if (!cardSide || pending.side !== cardSide) return false;
  const cardStart = positionWindowStartSec(card);
  if (pending.windowStart != null && Number.isFinite(cardStart) && cardStart > 0) {
    return Number(pending.windowStart) === cardStart;
  }
  const cardSlug = resolveDemoOpenCardSlug(card);
  return Boolean(cardSlug && pending.slug && cardSlug === pending.slug);
}

function clearTriggerRuntime(triggerId) {
  const id = String(triggerId || "");
  if (!id) {
    for (const rt of triggerRuntimeById.values()) {
      if (rt?.liveUiTimer) clearTimeout(rt.liveUiTimer);
    }
    triggerRuntimeById.clear();
    clearTriggerPendingHeld();
    return;
  }
  clearTriggerCardLiveUiTimer(id);
  triggerRuntimeById.delete(id);
  clearTriggerPendingHeld(id);
  syncTriggerCardLiveUi(id);
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
      startAssetPrice: null,
      entryPrice: null,
      entryShares: 10,
      takeProfitCents: 10,
      stopLossCents: 10,
      sellOrderType: "FAK",
      runMode: "demo",
      orderInFlight: false,
      windowStart: null,
      entrySlug: null,
      /** True after we observed a live book position while this trigger was open (Trade). */
      sawHolding: false,
      /** @type {{ side: "up"|"down", leg: "buy"|"sell", price: number, shares: number } | null} */
      liveUi: null,
      liveUiTimer: null,
    };
    triggerRuntimeById.set(id, rt);
  }
  return rt;
}

function triggerStillHolding(state, side) {
  if (!side) return false;
  const pos = tradingState(state)?.positions?.[side];
  return Boolean(pos && Number(pos.shares) > 0);
}

/** Exit price after the Trade position went flat (manual sell, GTD fill, etc.). */
function resolveTriggerFlatExitPrice(state, rt) {
  const side = rt?.side === "down" ? "down" : rt?.side === "up" ? "up" : null;
  const cards = tradingState(state)?.positionCards;
  if (side && Array.isArray(cards)) {
    const entry = Number(rt.entryPrice);
    const sold = cards.find((c) => {
      if (!c || c.status !== "sold" || c.side !== side) return false;
      if (!Number.isFinite(Number(c.sellPrice))) return false;
      // Prefer a card whose buy matches this trigger fill when possible.
      if (Number.isFinite(entry) && Number.isFinite(Number(c.buyPrice))) {
        return Math.abs(Number(c.buyPrice) - entry) < 0.02;
      }
      return true;
    });
    if (sold && Number.isFinite(Number(sold.sellPrice))) return Number(sold.sellPrice);
  }
  const bidCents = side ? triggerBidCents(state, side) : NaN;
  if (Number.isFinite(bidCents)) return bidCents / 100;
  const entry = Number(rt?.entryPrice);
  return Number.isFinite(entry) ? entry : NaN;
}

/** Trade open → flat (e.g. manual sell): record real sell P/L, not a held $1/$0 settle. */
function settleTriggerTradeIfFlat(trigger, rt, state, reason = "sell") {
  if (rt?.runMode !== "trade" || rt.phase !== "open" || !rt.side) return false;
  if (triggerStillHolding(state, rt.side)) {
    rt.sawHolding = true;
    return false;
  }
  if (!rt.sawHolding) return false;
  const exitPrice = resolveTriggerFlatExitPrice(state, rt);
  settleTriggerOpenPosition(trigger, rt, exitPrice, reason);
  return true;
}

function clearTriggerChartHits() {
  triggerChartHits = [];
}

function syncTriggerChartHitsWindow(windowStart) {
  if (windowStart == null || !Number.isFinite(windowStart)) {
    if (triggerChartHits.length) clearTriggerChartHits();
    return;
  }
  if (triggerChartHits.some((h) => h.windowStart !== windowStart)) {
    triggerChartHits = triggerChartHits.filter((h) => h.windowStart === windowStart);
  }
}

function recordTriggerChartHit(trigger, rt, state, side) {
  // Demo still collects stats, but while Allow trade is On keep the chart clean
  // (no duration bands / buy dots for demo hits).
  if (rt?.runMode !== "trade" && isTriggerTradeArmed()) return;
  const windowStart = Number(state?.windowStart);
  if (!Number.isFinite(windowStart)) return;
  syncTriggerChartHitsWindow(windowStart);
  const buySec = Date.now() / 1000;
  const durationMs = normalizeTriggerDurationMs(trigger.durationMs, 5000);
  const durationSec = Math.max(0.001, durationMs / 1000);
  const watchFromRt =
    Number.isFinite(rt.watchStartedAtMs) && rt.watchStartedAtMs > 0
      ? rt.watchStartedAtMs / 1000
      : durationMs === 0
        ? buySec
        : buySec - durationSec;
  const watchStartSec = Math.max(windowStart, Math.min(buySec, watchFromRt));
  const y = Number(state?.assetPrice);
  triggerChartHits.push({
    triggerId: String(trigger.id || ""),
    windowStart,
    side: side === "down" ? "down" : "up",
    watchStartSec,
    buySec,
    y: Number.isFinite(y) ? y : null,
  });
}

function chartBuySellMarkers(state) {
  const trading = tradingState(state)?.markers;
  if (Array.isArray(trading) && trading.length) return trading;
  const sim = state?.sim?.markers;
  return Array.isArray(sim) ? sim : [];
}

/** True when phase/trade overlay already draws this trigger buy (avoid a second dot). */
function tradeMarkerCoversTriggerHit(state, hit) {
  const markers = chartBuySellMarkers(state);
  if (!markers.length) return false;
  const buySec = Number(hit.buySec);
  const side = hit.side === "down" ? "down" : "up";
  if (!Number.isFinite(buySec)) return false;
  return markers.some((m) => {
    if (!m || m.type !== "buy") return false;
    if ((m.side === "down" ? "down" : "up") !== side) return false;
    return Math.abs(Number(m.t) - buySec) <= 2.5;
  });
}

/**
 * Duration bands (full plot height, fill only) and Demo-only buy dots.
 * Trade/phase fills use Simulator markers so each buy/sell is a single dot.
 */
function drawTriggerChartHits(ctx, layout, state, mode = "all") {
  if (!ctx || !layout?.windowStart || !layout.windowEnd || !layout.xAt) return;
  syncTriggerChartHitsWindow(layout.windowStart);
  if (!triggerChartHits.length) return;
  const { padding, plotH, xAt, yAt } = layout;
  const drawBands = mode === "all" || mode === "bands";
  const drawDots = mode === "all" || mode === "dots";
  for (const hit of triggerChartHits) {
    if (hit.windowStart !== layout.windowStart) continue;
    const isUp = hit.side === "up";
    if (drawBands) {
      const bandStart = Math.max(layout.windowStart, Number(hit.watchStartSec));
      const bandEnd = Math.min(layout.windowEnd, Number(hit.buySec));
      if (bandEnd > bandStart) {
        const x0 = xAt(bandStart);
        const x1 = xAt(bandEnd);
        const w = Math.max(2, x1 - x0);
        ctx.fillStyle = isUp ? "rgba(46, 160, 67, 0.18)" : "rgba(248, 81, 73, 0.18)";
        ctx.fillRect(x0, padding.top, w, plotH);
      }
    }
    if (!drawDots) continue;
    // Skip when trading/phase markers already show this buy.
    if (tradeMarkerCoversTriggerHit(state, hit)) continue;
    const buyX = xAt(Math.min(layout.windowEnd, Math.max(layout.windowStart, Number(hit.buySec))));
    let buyY = padding.top + plotH / 2;
    if (hit.y != null && Number.isFinite(hit.y) && typeof yAt === "function") {
      buyY = yAt(hit.y);
    }
    ctx.beginPath();
    ctx.arc(buyX, buyY, 5, 0, Math.PI * 2);
    ctx.fillStyle = isUp ? "#2ea043" : "#f85149";
    ctx.fill();
  }
}

function isTriggerTradeArmed() {
  // Real Trigger Trade only when Allow trade is on and this host is the trading executor
  // (quotesEnabled is false on local/non-executor processes even if Allow trade is checked).
  return Boolean(
    $("start-trading")?.checked && windowState?.trading?.quotesEnabled === true,
  );
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

function triggerGapMatches(state, kind, gapSizeRaw, gapMode, side) {
  if (kind !== "positive" && kind !== "negative") return true;
  const mode = normalizeTriggerGapMode(gapMode);
  if (mode === "relative" && side !== "up" && side !== "down") return false;
  const absKind = triggerAbsoluteGapKindForSide(side, kind, mode) || kind;
  const gap = Number(state.assetGap);
  if (!Number.isFinite(gap)) return false;
  if (absKind === "positive" && !(gap > 0)) return false;
  if (absKind === "negative" && !(gap < 0)) return false;
  const size = normalizeTriggerGapSize(gapSizeRaw);
  if (!(size.value > 0)) return true;
  const abs = Math.abs(gap);
  return size.bound === "max" ? abs <= size.value : abs >= size.value;
}

/**
 * Market asset price change over Duration (on top of gap size).
 * Only enforced when both gap halves share a side and |dollars| > 0.
 * +20 Min → rose ≥ $20; -40 Max → fell by at most $40 (and still fell).
 */
function triggerPriceTrendMatches(trigger, startAsset, endAsset) {
  if (!triggerSameSideGaps(trigger?.ptbGap)) return true;
  const trend = normalizeTriggerPriceTrend(trigger?.priceTrend);
  if (!(Math.abs(trend.dollars) > 0)) return true;
  const start = Number(startAsset);
  const end = Number(endAsset);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const delta = end - start;
  const need = trend.dollars;
  if (need > 0) {
    if (!(delta > 0)) return false;
    return trend.bound === "max" ? delta <= need : delta >= need;
  }
  if (!(delta < 0)) return false;
  return trend.bound === "max" ? delta >= need : delta <= need;
}

function triggerPriceInRange(cents, range) {
  const band = normalizeTriggerPriceRange(range);
  if (!Number.isFinite(cents)) return false;
  const c = roundTriggerPriceTenths(cents);
  return c >= band.lowCents && c <= band.highCents;
}

/** Signed ¢ change: 0 = unchanged; +N = rose ≥ N¢; −N = fell ≥ |N|¢. */
function triggerSignedChangeMet(needRaw, fromCents, toCents) {
  if (!Number.isFinite(fromCents) || !Number.isFinite(toCents)) return false;
  const need = clampTriggerSignedCents(needRaw);
  const delta = Math.round(toCents) - Math.round(fromCents);
  if (need === 0) return delta === 0;
  if (need > 0) return delta >= need;
  return delta <= need;
}

function triggerStartConditionMet(trigger, currentCents) {
  if (normalizeTriggerStartMode(trigger?.startMode) === "price") {
    const need = clampTriggerCents(trigger.startPriceCents ?? 50);
    return (
      Number.isFinite(currentCents) && roundTriggerPriceTenths(currentCents) === need
    );
  }
  return triggerPriceInRange(currentCents, trigger.priceRanges?.start);
}

function triggerEndConditionMet(trigger, startPriceCents, endPriceCents) {
  const mode = trigger.endMode === "change-side" ? "change-side" : "range";
  if (mode === "change-side") {
    return triggerSignedChangeMet(trigger.endChangeSideCents, startPriceCents, endPriceCents);
  }
  return triggerPriceInRange(endPriceCents, trigger.priceRanges?.end);
}

/**
 * Buy Ask band (¢) for open + order cap: same diagram band as the fire end/start condition.
 * Duration 0 / end Change → start Price or start Range; else end Range.
 */
function triggerBuyAskBandCents(trigger) {
  const useStart =
    isTriggerZeroDuration(trigger?.durationMs) || trigger?.endMode === "change-side";
  if (useStart) {
    if (normalizeTriggerStartMode(trigger?.startMode) === "price") {
      const p = clampTriggerCents(trigger.startPriceCents ?? 50);
      return { lowCents: p, highCents: p };
    }
    const start = normalizeTriggerPriceRange(trigger?.priceRanges?.start);
    return { lowCents: start.lowCents, highCents: start.highCents };
  }
  const end = normalizeTriggerPriceRange(trigger?.priceRanges?.end);
  return { lowCents: end.lowCents, highCents: end.highCents };
}

/** Max Ask (¢) for the FAK/FOK buy — must not walk the book above the diagram band high. */
function triggerBuyMaxAskCents(trigger) {
  return triggerBuyAskBandCents(trigger).highCents;
}

async function placeTriggerTradeOrder(side, leg, extras = {}) {
  if (!isTriggerTradeArmed()) return { ok: false, skipped: true };
  if (side !== "up" && side !== "down") return { ok: false, error: "bad side" };
  if (leg !== "buy" && leg !== "sell") return { ok: false, error: "bad leg" };
  const result = await postTradingOrder(side, leg, { source: "trigger", ...extras });
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
  const pnl = Number.isFinite(pnlUsd) ? pnlUsd : 0;
  const heldWin = result === "blue";
  const heldLoss = result === "fail" && exitReason === "window-end";
  const earlySell =
    !heldWin &&
    !heldLoss &&
    (exitReason === "tp" ||
      exitReason === "sl" ||
      result === "success" ||
      (result === "fail" && exitReason !== "window-end"));
  // success is legacy (removed from Stats); Win/Loss/Sell/Stop Loss below.
  if (heldWin) demo.blue += 1;
  else if (heldLoss) demo.fail += 1;
  if (earlySell && pnl > 0) demo.takeProfit += 1;
  else if (earlySell && pnl <= 0) demo.stopLoss += 1;
  demo.pnlUsd += pnl;
  patchUserTrigger(triggerId, { demoStats: demo });
  updateTriggerCardStats(triggerId);
}

function settleTriggerOpenPosition(trigger, rt, exitPrice, reason, opts = {}) {
  const entry = Number(rt.entryPrice);
  const shares = Number(rt.entryShares) || normalizeTriggerBuyShares(trigger.buyShares);
  const exit = Number(exitPrice);
  // Number(null) === 0 — reject that so held losses don't become fail + $0.
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit)) {
    appendLogEntry({
      level: "warn",
      source: "client",
      message: `Trigger "${String(trigger.name || "Untitled trigger")}" settle skipped — bad entry/exit (${entry}/${exit})`,
    });
    const skipId = trigger?.id;
    rt.phase = "idle";
    rt.side = null;
    rt.watchStartedAtMs = null;
    rt.startPriceCents = null;
    rt.entryPrice = null;
    rt.entryShares = normalizeTriggerBuyShares(trigger.buyShares);
    rt.entrySlug = null;
    rt.windowStart = null;
    rt.orderInFlight = false;
    if (skipId != null) setTriggerCardLiveUi(skipId, null);
    return;
  }
  const pnlUsd = (exit - entry) * shares;
  let result;
  if (reason === "window-end" && opts.heldWon === true) result = "blue";
  else if (reason === "window-end" && opts.heldWon === false) result = "fail";
  else if (reason === "window-end" && opts.heldWon == null) {
    // Never invent a fail/$0 when the market outcome is still unknown.
    appendLogEntry({
      level: "warn",
      source: "client",
      message: `Trigger "${String(trigger.name || "Untitled trigger")}" held settle skipped — outcome unknown`,
    });
    return;
  } else {
    result = pnlUsd > 0 ? "success" : "fail";
  }

  const label = String(trigger.name || "Untitled trigger");
  appendLogEntry({
    level: "info",
    source: "client",
    message: `Trigger "${label}" ${rt.runMode} ${result} (${reason}) P/L ${formatTriggerStatsPnl(pnlUsd)}`,
  });

  if (rt.runMode === "trade") {
    // Trade stats come from server position-card settlement (same as phases) — do not
    // post guessed P/L from client flat/held heuristics.
    void fetchTriggerLiveStats(trigger.id).then(() => updateTriggerCardStats(trigger.id));
  } else {
    recordTriggerDemoStats(trigger.id, result, pnlUsd, reason);
    upsertTriggerDemoPositionSettle(trigger, rt, exit, reason, opts);
  }

  const liveSide = rt.side === "down" ? "down" : rt.side === "up" ? "up" : null;
  const liveShares = shares;

  // Flat → idle so the same card can fire again when conditions rematch.
  rt.phase = "idle";
  rt.side = null;
  rt.watchStartedAtMs = null;
  rt.startPriceCents = null;
  rt.entryPrice = null;
  rt.entryShares = normalizeTriggerBuyShares(trigger.buyShares);
  rt.entrySlug = null;
  rt.windowStart = null;
  rt.orderInFlight = false;
  rt.sawHolding = false;

  // Visual: flash SELL on the right, then clear so the card looks re-armed.
  if (liveSide && reason !== "window-end") {
    flashTriggerCardLiveSell(trigger.id, liveSide, exit, liveShares);
  } else {
    setTriggerCardLiveUi(trigger.id, null);
  }
}

async function fetchOfficialTriggerWindowOutcome(slug) {
  const key = typeof slug === "string" ? slug.trim() : "";
  if (!key) return null;
  try {
    const res = await fetch(`/api/window-resolution?slug=${encodeURIComponent(key)}`, {
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (body?.resolved && (body.outcome === "up" || body.outcome === "down")) {
      return body.outcome;
    }
  } catch {
    /* keep polling */
  }
  return null;
}

function scheduleTriggerHeldResolve(triggerId, delayMs) {
  const id = String(triggerId || "");
  const pending = triggerPendingHeldById.get(id);
  if (!pending) return;
  if (pending.timer != null) clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    pending.timer = null;
    void resolveTriggerHeldSettlement(id);
  }, delayMs);
}

async function resolveTriggerHeldSettlement(triggerId) {
  const id = String(triggerId || "");
  const pending = triggerPendingHeldById.get(id);
  if (!pending) return;
  const outcome = await fetchOfficialTriggerWindowOutcome(pending.slug);
  if (!outcome) {
    pending.attempts += 1;
    // ~5 min of 5s polls, then stop (do not count fake fails).
    if (pending.attempts >= 60) {
      appendLogEntry({
        level: "warn",
        source: "client",
        message: `Trigger held settle abandoned — no official outcome for ${pending.slug || "window"}`,
      });
      clearTriggerPendingHeld(id);
      return;
    }
    scheduleTriggerHeldResolve(id, 5000);
    return;
  }
  clearTriggerPendingHeld(id);
  const trigger = findUserTrigger(id) || {
    id,
    name: "Untitled trigger",
    buyShares: pending.entryShares,
  };
  const won = outcome === pending.side;
  const rt = {
    runMode: pending.runMode === "trade" ? "trade" : "demo",
    entryPrice: pending.entryPrice,
    entryShares: pending.entryShares,
    side: pending.side,
    phase: "open",
    watchStartedAtMs: null,
    startPriceCents: null,
    orderInFlight: false,
    windowStart: pending.windowStart ?? null,
    entrySlug: pending.slug || null,
    triggerMiss: pending.triggerMiss === true,
  };
  // Same official Gamma outcome as live Trade cards (/api/window-resolution).
  settleTriggerOpenPosition(trigger, rt, won ? 1 : 0, "window-end", {
    heldWon: won,
    officialOutcome: outcome,
    windowStart: pending.windowStart ?? null,
    series: pending.series || null,
    slug: pending.slug || null,
    triggerMiss: pending.triggerMiss === true,
  });
}

function scheduleResumeDemoOpenResolve(cardId, delayMs) {
  const id = String(cardId || "");
  const pending = triggerPendingResumeDemoByCardId.get(id);
  if (!pending) return;
  if (pending.timer != null) clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    pending.timer = null;
    void resolveResumeDemoOpenSettlement(id);
  }, delayMs);
}

/**
 * Settle a stuck open Demo Positions card from official Gamma using the card's
 * entry-window fields (not live windowState). Synthetic rt — does not touch live runtime.
 */
function settleResumedDemoOpenCard(card, outcome) {
  const cardId = String(card?.id || "");
  if (!cardId || (outcome !== "up" && outcome !== "down")) return;
  const live = demoPositionCards.find((c) => String(c?.id || "") === cardId) || null;
  if (!live || String(live.status || "open").toLowerCase() !== "open") return;
  const side = live.side === "down" ? "down" : live.side === "up" ? "up" : null;
  if (!side) return;
  const buyPrice = Number(live.buyPrice);
  const shares = Number(live.shares);
  if (!Number.isFinite(buyPrice) || buyPrice <= 0 || !Number.isFinite(shares) || shares <= 0) {
    return;
  }
  const windowStart = positionWindowStartSec(live);
  const slug = resolveDemoOpenCardSlug(live);
  const series =
    (typeof live.series === "string" && live.series.trim()) ||
    (typeof live.windowKey === "string" && live.windowKey.includes(":")
      ? live.windowKey.slice(0, live.windowKey.lastIndexOf(":"))
      : "") ||
    null;
  const triggerId = live.triggerId != null ? String(live.triggerId) : "";
  const trigger = (triggerId && findUserTrigger(triggerId)) || {
    id: triggerId || cardId,
    name: String(live.triggerName || "").trim() || "Untitled trigger",
    buyShares: shares,
  };
  const won = outcome === side;
  // Synthetic runtime — never mutate the live triggerRuntimeById entry.
  const rt = {
    runMode: "demo",
    entryPrice: buyPrice,
    entryShares: shares,
    side,
    phase: "open",
    watchStartedAtMs: null,
    startPriceCents: null,
    orderInFlight: false,
    windowStart: Number.isFinite(windowStart) && windowStart > 0 ? windowStart : null,
    entrySlug: slug || null,
    triggerMiss: live.triggerMiss === true,
  };
  settleTriggerOpenPosition(trigger, rt, won ? 1 : 0, "window-end", {
    heldWon: won,
    officialOutcome: outcome,
    windowStart: Number.isFinite(windowStart) && windowStart > 0 ? windowStart : null,
    series,
    slug: slug || null,
    triggerName: String(live.triggerName || "").trim() || null,
    triggerMiss: live.triggerMiss === true,
  });
}

async function resolveResumeDemoOpenSettlement(cardId) {
  const id = String(cardId || "");
  const pending = triggerPendingResumeDemoByCardId.get(id);
  if (!pending) return;
  const live = demoPositionCards.find((c) => String(c?.id || "") === id) || null;
  if (!live || String(live.status || "open").toLowerCase() !== "open") {
    clearTriggerPendingResumeDemo(id);
    return;
  }
  if (isDemoOpenCardCoveredByHeldPending(live)) {
    clearTriggerPendingResumeDemo(id);
    return;
  }
  const slug = pending.slug || resolveDemoOpenCardSlug(live);
  if (!slug) {
    clearTriggerPendingResumeDemo(id);
    return;
  }
  pending.slug = slug;
  const outcome = await fetchOfficialTriggerWindowOutcome(slug);
  if (!outcome) {
    pending.attempts += 1;
    // Pause this session after ~5 min; next load / window roll re-enqueues.
    if (pending.attempts >= 60) {
      appendLogEntry({
        level: "warn",
        source: "client",
        message: `Demo open resume settle paused — no official outcome yet for ${slug}`,
      });
      clearTriggerPendingResumeDemo(id);
      return;
    }
    scheduleResumeDemoOpenResolve(id, 5000);
    return;
  }
  clearTriggerPendingResumeDemo(id);
  settleResumedDemoOpenCard(live, outcome);
  appendLogEntry({
    level: "info",
    source: "client",
    message: `Demo open resume settled ${slug} → ${outcome}`,
  });
}

function enqueueResumeDemoOpenSettlement(card) {
  const cardId = String(card?.id || "");
  if (!cardId || !isPastWindowOpenDemoPositionCard(card)) return;
  if (triggerPendingResumeDemoByCardId.has(cardId)) return;
  if (isDemoOpenCardCoveredByHeldPending(card)) return;
  const slug = resolveDemoOpenCardSlug(card);
  if (!slug) {
    appendLogEntry({
      level: "warn",
      source: "client",
      message: `Demo open resume settle skipped — missing slug for ${cardId}`,
    });
    return;
  }
  triggerPendingResumeDemoByCardId.set(cardId, {
    cardId,
    slug,
    attempts: 0,
    timer: null,
  });
  void resolveResumeDemoOpenSettlement(cardId);
}

/** After load / window roll: re-queue past-window open Demo cards for Gamma settle. */
function scanAndResumeStuckDemoOpenCards() {
  if (!Array.isArray(demoPositionCards) || demoPositionCards.length === 0) return;
  for (const card of demoPositionCards) {
    if (!isPastWindowOpenDemoPositionCard(card)) continue;
    enqueueResumeDemoOpenSettlement(card);
  }
}

/**
 * Park an open Trigger position until official UP/DOWN is known, then score blue/red + P/L.
 * (Live SSE state never carries `outcome`.)
 */
function enqueueTriggerHeldSettlement(trigger, rt, state) {
  const id = String(trigger?.id || "");
  if (!id) return;
  // BUY highlight must clear at window end even if settle cannot park (Positions stay Open).
  const clearLiveBuyUi = () => setTriggerCardLiveUi(id, null);
  if (!rt?.side || (rt.side !== "up" && rt.side !== "down")) {
    clearLiveBuyUi();
    return;
  }
  const clearOpenRt = () => {
    rt.phase = "idle";
    rt.side = null;
    rt.watchStartedAtMs = null;
    rt.startPriceCents = null;
    rt.entryPrice = null;
    rt.entryShares = normalizeTriggerBuyShares(trigger.buyShares);
    rt.entrySlug = null;
    rt.windowStart = null;
    rt.orderInFlight = false;
  };
  if (triggerPendingHeldById.has(id)) {
    // Already waiting — clear the live open phase so the next window can arm.
    clearOpenRt();
    clearLiveBuyUi();
    return;
  }
  const slug =
    (typeof rt.entrySlug === "string" && rt.entrySlug.trim()) ||
    (typeof state?.slug === "string" && state.slug.trim()) ||
    "";
  const entryPrice = Number(rt.entryPrice);
  if (!slug) {
    appendLogEntry({
      level: "warn",
      source: "client",
      message: `Trigger "${String(trigger.name || "Untitled trigger")}" held settle skipped — missing window slug`,
    });
    clearOpenRt();
    clearLiveBuyUi();
    return;
  }
  // Number(null) === 0; only park settles with a real buy fill price.
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    appendLogEntry({
      level: "warn",
      source: "client",
      message: `Trigger "${String(trigger.name || "Untitled trigger")}" held settle skipped — missing entry price`,
    });
    clearOpenRt();
    clearLiveBuyUi();
    return;
  }
  const entryWindowStart = Number(rt.windowStart ?? state?.windowStart);
  const pending = {
    triggerId: id,
    side: rt.side,
    entryPrice,
    entryShares: Number(rt.entryShares) || normalizeTriggerBuyShares(trigger.buyShares),
    runMode: rt.runMode === "trade" ? "trade" : "demo",
    windowStart: Number.isFinite(entryWindowStart) && entryWindowStart > 0 ? entryWindowStart : null,
    series: state?.series || selectedSeries || null,
    slug,
    triggerMiss: rt.triggerMiss === true,
    attempts: 0,
    timer: null,
  };
  triggerPendingHeldById.set(id, pending);
  clearOpenRt();
  // Window rolled / ended while open — clear the live buy latch (re-arm visually).
  // Positions card stays Open until Gamma resolve.
  clearLiveBuyUi();
  appendLogEntry({
    level: "info",
    source: "client",
    message: `Trigger "${String(trigger.name || "Untitled trigger")}" held — waiting for official Gamma outcome`,
  });
  void resolveTriggerHeldSettlement(id);
}

function settleTriggerHeldToWindowEnd(trigger, rt, state) {
  enqueueTriggerHeldSettlement(trigger, rt, state);
}

async function openTriggerPosition(trigger, rt, state, side) {
  if (rt.orderInFlight || rt.phase === "open" || rt.phase === "opening") return;
  const runMode = trigger.runMode === "trade" ? "trade" : "demo";
  // Demo buys/stats/Positions are scored on the trading host (feed latency) — not here.
  if (runMode !== "trade") {
    rt.phase = "idle";
    rt.side = null;
    rt.watchStartedAtMs = null;
    rt.startPriceCents = null;
    return;
  }
  const buyShares = normalizeTriggerBuyShares(trigger.buyShares);
  const sellOrderType = normalizeTriggerSellOrderType(trigger.sellOrderType);
  const watchStartedAtMs = Number(rt.watchStartedAtMs);
  rt.runMode = runMode;
  rt.phase = "opening";
  rt.side = side;
  rt.takeProfitCents = clampTriggerOffsetCents(trigger.takeProfitCents ?? 10, 10);
  rt.stopLossCents = clampTriggerOffsetCents(trigger.stopLossCents ?? 10, 10);
  rt.sellOrderType = sellOrderType;

  // Ask must still sit inside the diagram buy band (Demo + Trade) — not only ≤ high.
  const ask = triggerAskPrice(state, side);
  const askBand = triggerBuyAskBandCents(trigger);
  const askCents = Number.isFinite(ask) ? ask * 100 : NaN;
  if (
    !Number.isFinite(askCents) ||
    askCents < askBand.lowCents - 1e-6 ||
    askCents > askBand.highCents + 1e-6
  ) {
    rt.phase = "idle";
    rt.side = null;
    rt.watchStartedAtMs = null;
    return;
  }
  const maxAskCents = askBand.highCents;
  const minAskCents = askBand.lowCents;

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
    const buyOrderType = normalizeTriggerBuyOrderType(
      trigger.buyOrderType,
      trigger.durationMs,
      trigger.startMode,
      trigger.ptbGap,
    );
    const result = await placeTriggerTradeOrder(side, "buy", {
      shares: buyShares,
      orderType: buyOrderType === "FAK" ? "FAK" : "FOK",
      maxPrice: maxAskCents / 100,
      minPrice: minAskCents / 100,
      triggerId: String(trigger.id || ""),
      triggerName: String(trigger.name || "").trim() || "Untitled",
      // TP offset 100 = disabled — do not rest a GTD take-profit sell.
      sellOrderType:
        isTriggerExitDisabled(rt.takeProfitCents) && sellOrderType === "GTD"
          ? "FAK"
          : sellOrderType,
      takeProfitCents: rt.takeProfitCents,
    });
    rt.orderInFlight = false;
    if (!result.ok) {
      rt.phase = "idle";
      rt.side = null;
      rt.watchStartedAtMs = null;
      return;
    }
    const fillPrice = Number(result.body?.fillPrice);
    const fillShares = Number(result.body?.fillShares);
    rt.entryPrice = Number.isFinite(fillPrice) ? fillPrice : ask;
    rt.entryShares = Number.isFinite(fillShares) && fillShares > 0 ? fillShares : buyShares;
    const fillCents = Number.isFinite(rt.entryPrice) ? rt.entryPrice * 100 : NaN;
    rt.triggerMiss =
      result.body?.triggerMiss === true ||
      (Number.isFinite(fillCents) &&
        (fillCents < askBand.lowCents - 1e-6 || fillCents > askBand.highCents + 1e-6)) ||
      (Number.isFinite(rt.entryShares) && rt.entryShares > buyShares + 1e-3);
  } else {
    rt.entryPrice = ask;
    rt.entryShares = buyShares;
    rt.triggerMiss = false;
    appendLogEntry({
      level: "info",
      source: "client",
      message: `Trigger "${trigger.name || "Untitled"}" Demo buy ${side.toUpperCase()} ${buyShares} sh @ ${(ask * 100).toFixed(1)}¢ (${sellOrderType} sell)`,
    });
  }

  rt.entrySlug =
    typeof state?.slug === "string" && state.slug.trim() ? state.slug.trim() : null;
  const openWindowStart = Number(state?.windowStart);
  rt.windowStart =
    Number.isFinite(openWindowStart) && openWindowStart > 0 ? openWindowStart : null;

  // Preserve watch start for the chart duration band, then clear watch state.
  rt.watchStartedAtMs = Number.isFinite(watchStartedAtMs) ? watchStartedAtMs : rt.watchStartedAtMs;
  recordTriggerChartHit(trigger, rt, state, side);
  rt.phase = "open";
  rt.side = side;
  rt.watchStartedAtMs = null;
  rt.startPriceCents = null;
  rt.sawHolding = runMode === "trade" && triggerStillHolding(state, side);
  setTriggerCardLiveUi(trigger.id, {
    side,
    leg: "buy",
    price: rt.entryPrice,
    shares: rt.entryShares,
  });
  if (runMode !== "trade") {
    upsertTriggerDemoPositionOpen(trigger, rt, state, side);
  }
  if (windowState) drawPriceChart(windowState);
}

async function forceTriggerMarketSell(trigger, rt, state, reason) {
  if (!rt.side || rt.orderInFlight) return;
  const bidCents = triggerBidCents(state, rt.side);
  const exitPrice = Number.isFinite(bidCents) ? bidCents / 100 : Number(rt.entryPrice);
  // Aggressive exits (TP/SL/window) are FAK by default; FOK only when Sell type is FOK.
  // GTD SL / window-end also use FAK after cancelling the resting TP.
  const sellType = rt.sellOrderType === "FOK" ? "FOK" : "FAK";

  if (rt.runMode === "trade") {
    if (!isTriggerTradeArmed()) return;
    rt.orderInFlight = true;
    const result = await placeTriggerTradeOrder(rt.side, "sell", {
      orderType: sellType,
      triggerId: String(trigger.id || ""),
      triggerName: String(trigger.name || "").trim() || "Untitled",
      triggerExitReason: reason === "tp" || reason === "sl" ? reason : undefined,
    });
    rt.orderInFlight = false;
    if (result.skipped) return;
    if (!result.ok) {
      // Keep retrying on later ticks until flat.
      return;
    }
    const remaining = Number(result.body?.remainingShares);
    if (Number.isFinite(remaining) && remaining > 0) {
      // Partial FAK — stay open and retry next tick.
      return;
    }
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

async function maybeExitTriggerPosition(trigger, rt, state) {
  if (rt.phase !== "open" || !rt.side || rt.orderInFlight) return;
  const sellOrderType = normalizeTriggerSellOrderType(rt.sellOrderType || trigger.sellOrderType);
  rt.sellOrderType = sellOrderType;

  const tpEnabled = !isTriggerExitDisabled(rt.takeProfitCents);
  const slEnabled = !isTriggerExitDisabled(rt.stopLossCents);

  // GTD: resting TP was placed on buy fill — settle when flat (filled) or SL market-sell.
  if (sellOrderType === "GTD" && rt.runMode === "trade") {
    if (triggerStillHolding(state, rt.side)) rt.sawHolding = true;
    if (tpEnabled && rt.sawHolding && !triggerStillHolding(state, rt.side)) {
      const exitPrice = resolveTriggerFlatExitPrice(state, rt);
      settleTriggerOpenPosition(trigger, rt, exitPrice, "tp");
      return;
    }
    // TP off (or not yet flat): still catch manual / external sells so we don't held-$1 later.
    if (settleTriggerTradeIfFlat(trigger, rt, state, "sell")) return;
    if (!slEnabled) return;
    const bidCents = triggerBidCents(state, rt.side);
    if (!Number.isFinite(bidCents)) return;
    const targets = triggerExitTargetsFromFill(
      rt.entryPrice,
      rt.takeProfitCents,
      rt.stopLossCents,
    );
    if (targets && bidCents <= targets.slCents) {
      await forceTriggerMarketSell(trigger, rt, state, "sl");
    }
    return;
  }

  // FAK/FOK (and TP/SL both off): if the book position is gone, record the real sell.
  if (settleTriggerTradeIfFlat(trigger, rt, state, "sell")) return;

  if (!tpEnabled && !slEnabled) return;
  const bidCents = triggerBidCents(state, rt.side);
  if (!Number.isFinite(bidCents)) return;
  const targets = triggerExitTargetsFromFill(
    rt.entryPrice,
    rt.takeProfitCents,
    rt.stopLossCents,
  );
  if (!targets) return;
  const hitTp = tpEnabled && bidCents >= targets.tpCents;
  const hitSl = slEnabled && bidCents <= targets.slCents;
  if (!hitTp && !hitSl) return;

  const reason = hitTp ? "tp" : "sl";
  await forceTriggerMarketSell(trigger, rt, state, reason);
}

/**
 * No-gap Buy GTD: rest both UP and DOWN at Price; first fill cancels the sibling.
 * Gap set → GTD not allowed (normalize coerces to FOK); empty sides.
 */
function triggerGtdDesiredSides(trigger, _state) {
  if (triggerHasPtbGap(trigger?.ptbGap)) return [];
  return ["up", "down"];
}

function triggerUsesBuyGtd(trigger) {
  return (
    normalizeTriggerBuyOrderType(
      trigger?.buyOrderType,
      trigger?.durationMs,
      trigger?.startMode,
      trigger?.ptbGap,
    ) === "GTD"
  );
}

let triggerGtdSyncInFlight = false;
/** @type {{ state: any, desires: any[] } | null} */
let triggerGtdSyncPending = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let triggerGtdArmTimer = null;
/** Window start this arming schedule is keyed to. */
let triggerGtdArmWindowStart = null;
/** Apply-start keys already flushed this window: `${triggerId}:${applyStartSec}`. */
const triggerGtdArmedApplyKeys = new Set();

function clearTriggerGtdArmTimer() {
  if (triggerGtdArmTimer != null) {
    clearTimeout(triggerGtdArmTimer);
    triggerGtdArmTimer = null;
  }
}

/** Allow a trigger to re-arm GTD after Trade/Active changes in the same window. */
function invalidateTriggerGtdArmKeys(triggerId) {
  if (!triggerId) {
    triggerGtdArmedApplyKeys.clear();
    return;
  }
  const id = String(triggerId);
  const prefix = `${id}:`;
  for (const key of [...triggerGtdArmedApplyKeys]) {
    if (key.startsWith(prefix)) triggerGtdArmedApplyKeys.delete(key);
  }
}

/** Build Trade GTD desires for triggers currently inside Apply (wall clock). */
function collectTradeGtdDesires(state) {
  const desires = [];
  if (!state || !Array.isArray(userTriggers)) return desires;
  for (const trigger of userTriggers) {
    const id = String(trigger?.id || "");
    if (!id) continue;
    if (trigger.paused !== false) continue;
    if (trigger.runMode !== "trade") continue;
    if (!triggerUsesBuyGtd(trigger)) continue;
    const rt = getOrCreateTriggerRuntime(id);
    // Already filled — do not re-desire rests until sell / window end.
    if (rt.phase === "open" || rt.phase === "opening") continue;
    if (
      !isInTriggerApplyAreaNow(state, trigger.windowArea?.start, trigger.windowArea?.end)
    ) {
      continue;
    }
    const sides = triggerGtdDesiredSides(trigger, state);
    if (!sides.length) continue;
    desires.push({
      triggerId: id,
      triggerName: String(trigger.name || "").trim() || "Untitled",
      sides,
      priceCents: clampTriggerCents(trigger.startPriceCents ?? 50),
      shares: normalizeTriggerBuyShares(trigger.buyShares),
      sellOrderType: normalizeTriggerSellOrderType(trigger.sellOrderType),
      takeProfitCents: clampTriggerOffsetCents(trigger.takeProfitCents ?? 10, 10),
    });
  }
  return desires;
}

/**
 * Arm Buy GTD rests on Apply/window start by wall clock (no tick wait).
 * Schedules a timer when Apply starts later in the window.
 * Flushes once per trigger Apply-start per market window (ticks still reconcile).
 */
function scheduleTriggerGtdArming(state = windowState) {
  clearTriggerGtdArmTimer();
  if (!state || !isPredictionTriggerHost()) return;
  if (!Array.isArray(userTriggers) || userTriggers.length === 0) return;

  const ws = state.windowStart;
  if (ws !== triggerGtdArmWindowStart) {
    triggerGtdArmWindowStart = ws ?? null;
    triggerGtdArmedApplyKeys.clear();
  }

  const nowMs = Date.now();
  let earliestFutureMs = Infinity;
  let anyTradeGtd = false;
  const pendingArmKeys = [];

  for (const trigger of userTriggers) {
    if (trigger.paused !== false) continue;
    if (trigger.runMode !== "trade") continue;
    if (!triggerUsesBuyGtd(trigger)) continue;
    anyTradeGtd = true;
    const id = String(trigger.id || "");
    const bounds = triggerApplyBoundsSec(
      state,
      trigger.windowArea?.start,
      trigger.windowArea?.end,
    );
    if (!bounds || !id) continue;
    const startMs = bounds.startSec * 1000;
    const endMs = Math.min(bounds.endSec, bounds.windowEnd) * 1000;
    const armKey = `${id}:${bounds.startSec}`;
    if (nowMs >= startMs && nowMs <= endMs) {
      if (!triggerGtdArmedApplyKeys.has(armKey)) pendingArmKeys.push(armKey);
    } else if (nowMs < startMs) {
      earliestFutureMs = Math.min(earliestFutureMs, startMs);
    }
  }

  if (!anyTradeGtd) return;

  if (!isTriggerTradeArmed()) {
    void flushTriggerGtdSync(state, []);
    return;
  }

  // Mark armed only after Allow trade is on, so turning it on mid-window still places.
  if (pendingArmKeys.length > 0) {
    for (const key of pendingArmKeys) triggerGtdArmedApplyKeys.add(key);
    void flushTriggerGtdSync(state, collectTradeGtdDesires(state));
  }

  if (earliestFutureMs < Infinity) {
    const delay = Math.max(0, earliestFutureMs - Date.now());
    triggerGtdArmTimer = setTimeout(() => {
      triggerGtdArmTimer = null;
      scheduleTriggerGtdArming(windowState);
    }, delay);
  }
}

async function openTriggerPositionFromFill(trigger, rt, state, side, fillPrice, fillShares) {
  if (rt.orderInFlight || rt.phase === "open" || rt.phase === "opening") return;
  const buyShares = normalizeTriggerBuyShares(trigger.buyShares);
  const sellOrderType = normalizeTriggerSellOrderType(trigger.sellOrderType);
  rt.runMode = "trade";
  rt.phase = "opening";
  rt.side = side;
  rt.takeProfitCents = clampTriggerOffsetCents(trigger.takeProfitCents ?? 10, 10);
  rt.stopLossCents = clampTriggerOffsetCents(trigger.stopLossCents ?? 10, 10);
  rt.sellOrderType = sellOrderType;
  rt.entryPrice = Number.isFinite(fillPrice) ? fillPrice : clampTriggerCents(trigger.startPriceCents) / 100;
  rt.entryShares =
    Number.isFinite(fillShares) && fillShares > 0 ? fillShares : buyShares;
  rt.entrySlug =
    typeof state?.slug === "string" && state.slug.trim() ? state.slug.trim() : null;
  const gtdWindowStart = Number(state?.windowStart);
  rt.windowStart =
    Number.isFinite(gtdWindowStart) && gtdWindowStart > 0 ? gtdWindowStart : null;
  rt.watchStartedAtMs = Date.now();
  recordTriggerChartHit(trigger, rt, state, side);
  rt.phase = "open";
  rt.watchStartedAtMs = null;
  rt.startPriceCents = null;
  rt.sawHolding = triggerStillHolding(state, side);
  setTriggerCardLiveUi(trigger.id, {
    side,
    leg: "buy",
    price: rt.entryPrice,
    shares: rt.entryShares,
  });
  appendLogEntry({
    level: "info",
    source: "client",
    message: `Trigger "${trigger.name || "Untitled"}" GTD buy ${side.toUpperCase()} ${rt.entryShares} sh @ ${(rt.entryPrice * 100).toFixed(1)}¢`,
  });
  if (windowState) drawPriceChart(windowState);
}

async function flushTriggerGtdSync(state, desires) {
  if (triggerGtdSyncInFlight) {
    triggerGtdSyncPending = { state, desires };
    return;
  }
  triggerGtdSyncInFlight = true;
  try {
    const result = await postTriggerGtdSync(desires);
    const fills = Array.isArray(result.body?.fills) ? result.body.fills : [];
    for (const fill of fills) {
      const triggerId = String(fill?.triggerId || "");
      const side = fill?.side === "down" ? "down" : fill?.side === "up" ? "up" : null;
      if (!triggerId || !side) continue;
      const trigger = userTriggers.find((t) => String(t?.id) === triggerId);
      if (!trigger) continue;
      const rt = getOrCreateTriggerRuntime(triggerId);
      await openTriggerPositionFromFill(
        trigger,
        rt,
        state,
        side,
        Number(fill.fillPrice),
        Number(fill.fillShares),
      );
    }
  } finally {
    triggerGtdSyncInFlight = false;
    if (triggerGtdSyncPending) {
      const pending = triggerGtdSyncPending;
      triggerGtdSyncPending = null;
      void flushTriggerGtdSync(pending.state, pending.desires);
    }
  }
}

function tickUserTriggers(state) {
  if (!state || !isPredictionTriggerHost()) return;
  if (!Array.isArray(userTriggers) || userTriggers.length === 0) return;

  const nowMs = Date.now();
  const windowEnded =
    state.windowEnd != null &&
    Number.isFinite(state.windowEnd) &&
    nowMs >= state.windowEnd * 1000;
  const gtdDesires = [];
  let hasTradeGtd = false;

  for (const trigger of userTriggers) {
    const id = String(trigger?.id || "");
    if (!id) continue;
    const rt = getOrCreateTriggerRuntime(id);
    const buyGtd = triggerUsesBuyGtd(trigger);

    // Demo evaluation is server-side (executor + feedLatencyMs). Keep UI re-armed.
    if (trigger.runMode !== "trade") {
      if (rt.phase !== "idle" || rt.liveUi) {
        rt.phase = "idle";
        rt.side = null;
        rt.watchStartedAtMs = null;
        rt.startPriceCents = null;
        rt.entryPrice = null;
        setTriggerCardLiveUi(id, null);
      }
      continue;
    }

    if (rt.windowStart != null && state.windowStart !== rt.windowStart) {
      if (rt.phase === "open") {
        settleTriggerHeldToWindowEnd(trigger, rt, state);
      } else if (rt.liveUi) {
        // Stale BUY highlight after a prior settle abort — always re-arm on roll.
        setTriggerCardLiveUi(id, null);
      }
      rt.phase = "idle";
      rt.side = null;
      rt.watchStartedAtMs = null;
      rt.startPriceCents = null;
      clearTriggerChartHits();
    }
    rt.windowStart = state.windowStart ?? null;
    syncTriggerChartHitsWindow(state.windowStart);

    if (trigger.paused !== false) {
      if (rt.phase !== "idle") {
        rt.phase = "idle";
        rt.side = null;
        rt.watchStartedAtMs = null;
        rt.startPriceCents = null;
      }
      if (rt.liveUi) setTriggerCardLiveUi(id, null);
      continue;
    }

    if (rt.phase === "open") {
      // Manual (or other) sell already flattened — never score as held $1/$0.
      if (settleTriggerTradeIfFlat(trigger, rt, state, "sell")) continue;
      if (windowEnded) {
        settleTriggerHeldToWindowEnd(trigger, rt, state);
        continue;
      }
      void maybeExitTriggerPosition(trigger, rt, state);
      continue;
    }

    if (rt.phase === "opening") continue;

    if (windowEnded) {
      rt.phase = "idle";
      rt.watchStartedAtMs = null;
      if (rt.liveUi) setTriggerCardLiveUi(id, null);
      continue;
    }

    const area = normalizeTriggerWindowArea(
      trigger.windowArea?.start,
      trigger.windowArea?.end,
    );
    // Buy GTD uses wall clock so Apply/window start does not wait on lastTickMs.
    const inArea = buyGtd
      ? isInTriggerApplyAreaNow(state, area.start, area.end)
      : isInManipulationArea(state, area.start, area.end);
    if (!inArea) {
      if (rt.phase === "watching") {
        rt.phase = "idle";
        rt.side = null;
        rt.watchStartedAtMs = null;
        rt.startPriceCents = null;
      }
      // Trade GTD outside Apply window → sync with empty desire (cancel rests).
      if (buyGtd && trigger.runMode === "trade") hasTradeGtd = true;
      continue;
    }

    if (trigger.runMode === "trade" && !isTriggerTradeArmed()) {
      if (buyGtd) hasTradeGtd = true;
      continue;
    }

    // Buy GTD: rest UP + DOWN at Price from Apply-window start (first fill cancels sibling).
    if (buyGtd) {
      const priceCents = clampTriggerCents(trigger.startPriceCents ?? 50);
      const sides = triggerGtdDesiredSides(trigger, state);
      if (trigger.runMode === "trade") {
        hasTradeGtd = true;
        // Empty desire while open → server cancels sibling rests; no re-place.
        if (
          sides.length &&
          isTriggerTradeArmed() &&
          rt.phase !== "open" &&
          rt.phase !== "opening"
        ) {
          gtdDesires.push({
            triggerId: id,
            triggerName: String(trigger.name || "").trim() || "Untitled",
            sides,
            priceCents,
            shares: normalizeTriggerBuyShares(trigger.buyShares),
            sellOrderType: normalizeTriggerSellOrderType(trigger.sellOrderType),
            takeProfitCents: clampTriggerOffsetCents(trigger.takeProfitCents ?? 10, 10),
          });
        }
      } else {
        // Demo: fill when Ask is at/below the resting Price on an allowed side.
        for (const side of sides) {
          const ask = triggerAskPrice(state, side);
          if (!Number.isFinite(ask) || ask * 100 > priceCents + 1e-6) continue;
          rt.side = side;
          rt.watchStartedAtMs = nowMs;
          rt.startPriceCents = priceCents;
          void openTriggerPosition(trigger, rt, state, side);
          break;
        }
      }
      continue;
    }

    const priceSide = "buy";
    const durationMs = normalizeTriggerDurationMs(trigger.durationMs, 5000);
    const gapMode = normalizeTriggerGapMode(trigger.gapMode);

    if (durationMs > 0 && rt.phase === "watching" && rt.side && Number.isFinite(rt.watchStartedAtMs)) {
      if (nowMs - rt.watchStartedAtMs < durationMs) continue;
      const endCents = triggerQuoteCents(state, rt.side, priceSide);
      const endGapOk = triggerGapMatches(
        state,
        trigger.ptbGap?.end,
        trigger.gapSize?.end,
        gapMode,
        rt.side,
      );
      const trendOk = triggerPriceTrendMatches(
        trigger,
        rt.startAssetPrice,
        state.assetPrice,
      );
      if (
        endGapOk &&
        trendOk &&
        triggerEndConditionMet(trigger, rt.startPriceCents, endCents)
      ) {
        void openTriggerPosition(trigger, rt, state, rt.side);
      } else {
        rt.phase = "idle";
        rt.side = null;
        rt.watchStartedAtMs = null;
        rt.startPriceCents = null;
        rt.startAssetPrice = null;
      }
      continue;
    }

    // Ask/price first, then gap (Relative needs the candidate BUY side).
    for (const side of ["up", "down"]) {
      const startCents = triggerQuoteCents(state, side, priceSide);
      if (!triggerStartConditionMet(trigger, startCents)) continue;
      if (
        !triggerGapMatches(
          state,
          trigger.ptbGap?.start,
          trigger.gapSize?.start,
          gapMode,
          side,
        )
      ) {
        continue;
      }
      rt.side = side;
      rt.watchStartedAtMs = nowMs;
      rt.startPriceCents = startCents;
      rt.startAssetPrice = Number.isFinite(Number(state.assetPrice))
        ? Number(state.assetPrice)
        : null;
      if (durationMs === 0) {
        // No wait / no end condition — fire on start Range or Price (+ start gap).
        void openTriggerPosition(trigger, rt, state, side);
      } else {
        rt.phase = "watching";
      }
      break;
    }
  }

  if (hasTradeGtd && isTriggerTradeArmed()) {
    void flushTriggerGtdSync(state, gtdDesires);
  } else if (hasTradeGtd) {
    // Allow trade off — cancel any resting trigger GTDs.
    void flushTriggerGtdSync(state, []);
  }
}

function tickManipulationDetector(state) {
  if (!state) return;
  // Settings sync everywhere; detection/scoring only on the deployed host.
  if (!isPredictionTriggerHost()) return;
  tickUserTriggers(state);

  // Capture Chainlink close/PTB only for the Prediction's own window while Active.
  // Once Pending, freeze those values — never overwrite with the next window's ticks
  // (that used to make the 45s fallback score the wrong market).
  if (
    manipDetectorRuntime.uiPhase === "active" &&
    manipDetectorRuntime.predictionWindowStart != null &&
    state.windowStart === manipDetectorRuntime.predictionWindowStart &&
    Number.isFinite(state.assetPrice) &&
    Number.isFinite(state.prevCloseAsset)
  ) {
    manipDetectorRuntime.lastPrice = state.assetPrice;
    manipDetectorRuntime.lastPtb = state.prevCloseAsset;
  }

  if (state.windowStart !== manipDetectorRuntime.windowStart) {
    const prevStart = manipDetectorRuntime.windowStart;
    if (
      prevStart != null &&
      manipDetectorRuntime.predictionWindowStart === prevStart &&
      (manipDetectorRuntime.uiPhase === "active" || manipDetectorRuntime.uiPhase === "pending")
    ) {
      finalizePredictionAtWindowEnd({ showResultUi: true, source: "window-end" });
    } else {
      clearPredictionForNewWindow();
    }
    manipDetectorRuntime.windowStart = state.windowStart ?? null;
    manipDetectorRuntime.samples = [];
    clearManipulationFlash();
  }

  const nowMs = Date.now();
  const liveUpBuy = Number(state.yesAsk);
  const liveDownBuy = Number(state.noAsk);
  const liveUpBid = Number(state.yesBid);
  const liveDownBid = Number(state.noBid);
  if (Number.isFinite(liveUpBid) && Number.isFinite(liveDownBid)) {
    watchPredictionRiseOnQuotes(liveUpBid, liveDownBid, state);
  }

  if (state.windowEnd != null && Number.isFinite(state.windowEnd) && nowMs >= state.windowEnd * 1000) {
    if (
      manipDetectorRuntime.predictionWindowStart === state.windowStart &&
      (manipDetectorRuntime.uiPhase === "active" || manipDetectorRuntime.uiPhase === "pending")
    ) {
      if (Number.isFinite(state.assetPrice)) manipDetectorRuntime.lastPrice = state.assetPrice;
      if (Number.isFinite(state.prevCloseAsset)) manipDetectorRuntime.lastPtb = state.prevCloseAsset;
      finalizePredictionAtWindowEnd({ showResultUi: true, source: "window-end" });
    }
    if (manipDetectorRuntime.flashUntilMs > 0) clearManipulationFlash();
    manipDetectorRuntime.samples = [];
    return;
  }

  if (
    !manipDetectorRuntime.predictionSlug &&
    typeof state.slug === "string" &&
    state.slug.trim() &&
    (manipDetectorRuntime.uiPhase === "active" || manipDetectorRuntime.uiPhase === "pending") &&
    manipDetectorRuntime.predictionWindowStart === state.windowStart
  ) {
    manipDetectorRuntime.predictionSlug = state.slug.trim();
    persistPredictionRuntime();
  }

  if (!Boolean($("manipulation-detector")?.checked)) {
    manipDetectorRuntime.samples = [];
    return;
  }

  if (nowMs < manipDetectorRuntime.cooldownUntilMs) return;

  const area = normalizeManipulationArea(manipAreaStart, manipAreaEnd);
  if (!isInManipulationArea(state, area.manipulationAreaStart, area.manipulationAreaEnd)) {
    manipDetectorRuntime.samples = [];
    return;
  }

  const gap = Number(state.assetGap);
  const upBuy = liveUpBuy;
  const downBuy = liveDownBuy;
  if (!Number.isFinite(gap) || gap === 0 || !Number.isFinite(upBuy) || !Number.isFinite(downBuy)) {
    return;
  }

  const quoteBand = normalizePredictionQuoteBand(
    $("prediction-min-quote")?.value,
    $("prediction-max-quote")?.value,
  );
  const maxQuoteCents = quoteBand.maxQuoteCents;
  const minQuoteCents = quoteBand.minQuoteCents;
  const shiftCents = normalizePredictionShiftCents($("prediction-shift")?.value);
  const sensitivitySec = normalizeManipulationSensitivity($("manipulation-sensitivity")?.value);
  manipDetectorRuntime.samples.push({ tMs: nowMs, gap, upBuy, downBuy });
  const cutoff = nowMs - (sensitivitySec + 2) * 1000;
  while (
    manipDetectorRuntime.samples.length > 0 &&
    manipDetectorRuntime.samples[0].tMs < cutoff
  ) {
    manipDetectorRuntime.samples.shift();
  }
  if (manipDetectorRuntime.samples.length > MANIP_SAMPLE_MAX) {
    manipDetectorRuntime.samples.splice(
      0,
      manipDetectorRuntime.samples.length - MANIP_SAMPLE_MAX,
    );
  }

  const targetT = nowMs - sensitivitySec * 1000;
  let baseline = null;
  for (const sample of manipDetectorRuntime.samples) {
    if (sample.tMs <= targetT) baseline = sample;
    else break;
  }
  if (!baseline || nowMs - baseline.tMs < sensitivitySec * 1000) return;

  const nowBuys = { upBuy, downBuy };
  if (baseline.gap > 0) {
    if (
      gap >= baseline.gap &&
      upBuy < baseline.upBuy &&
      downBuy > baseline.downBuy &&
      meetsPredictionMaxQuoteAndShift(
        "down",
        baseline,
        nowBuys,
        maxQuoteCents,
        shiftCents,
        minQuoteCents,
      )
    ) {
      triggerManipulationFlash(state, "down", downBuy);
    }
  } else if (baseline.gap < 0) {
    if (
      gap <= baseline.gap &&
      upBuy > baseline.upBuy &&
      downBuy < baseline.downBuy &&
      meetsPredictionMaxQuoteAndShift(
        "up",
        baseline,
        nowBuys,
        maxQuoteCents,
        shiftCents,
        minQuoteCents,
      )
    ) {
      triggerManipulationFlash(state, "up", upBuy);
    }
  }
}

async function persistManipulationConfigPatch() {
  const patch = buildTradingConfigPatch();
  writeLocalTradingConfig(patch);
  const config = await pushTradingConfig(patch);
  applyTradingConfigToUi(coalesceTradingConfig(config, patch) ?? patch);
}

function bindManipulationAreaSlider() {
  const track = $("manipulation-area-slider")?.querySelector(".manipulation-area-track");
  if (!track) return;

  const fracFromEvent = (event) => {
    const rect = track.getBoundingClientRect();
    const travel = rect.width - MANIP_THUMB_PX;
    if (travel <= 0) return 0;
    // Map pointer to thumb-center travel so edges flush at 0% / 100%.
    return Math.max(0, Math.min(1, (event.clientX - rect.left - MANIP_THUMB_PX / 2) / travel));
  };

  const onMove = (event) => {
    if (!manipAreaDrag) return;
    const frac = fracFromEvent(event);
    if (manipAreaDrag === "start") {
      manipAreaStart = Math.min(frac, manipAreaEnd - 0.02);
    } else {
      manipAreaEnd = Math.max(frac, manipAreaStart + 0.02);
    }
    syncManipulationAreaUi();
  };

  const onUp = async () => {
    if (!manipAreaDrag) return;
    manipAreaDrag = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    await persistManipulationConfigPatch();
  };

  for (const thumb of track.querySelectorAll("[data-thumb]")) {
    thumb.addEventListener("pointerdown", (event) => {
      if (thumb.disabled || !$("manipulation-detector")?.checked) return;
      event.preventDefault();
      manipAreaDrag = thumb.getAttribute("data-thumb") === "end" ? "end" : "start";
      thumb.setPointerCapture?.(event.pointerId);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }
}

function applyTradingConfigToUi(config) {
  if (!config) return;
  const autoTradeInput = $("auto-trade");
  const useScheduleInput = $("use-schedule");
  const startTradingInput = $("start-trading");
  const buyTypeSelect = $("manual-buy-order-type");
  const sellTypeSelect = $("manual-sell-order-type");
  const manipInput = $("manipulation-detector");
  const predictionTradeInput = $("prediction-trade");
  const predictionSharesInput = $("prediction-shares");
  const predictionBuyTypeSelect = $("prediction-buy-order-type");
  const predictionSellTypeSelect = $("prediction-sell-order-type");
  const maxQuoteInput = $("prediction-max-quote");
  const minQuoteInput = $("prediction-min-quote");
  const shiftInput = $("prediction-shift");
  const riseInput = $("prediction-rise");
  const sensInput = $("manipulation-sensitivity");
  // Phase Auto Trade / Use Schedule removed from the product.
  if (autoTradeInput) autoTradeInput.checked = false;
  if (useScheduleInput) useScheduleInput.checked = false;
  if (startTradingInput) startTradingInput.checked = Boolean(config.startTrading);
  if (!config.startTrading) {
    forceTradeTriggersToDemo("Allow trade off");
  }
  if (buyTypeSelect) buyTypeSelect.value = normalizeManualOrderType(config.manualBuyOrderType);
  if (sellTypeSelect) sellTypeSelect.value = normalizeManualOrderType(config.manualSellOrderType);
  if (manipInput) manipInput.checked = Boolean(config.manipulationDetector);
  if (predictionTradeInput) {
    predictionTradeInput.checked = false;
    predictionTradeInput.disabled = true;
  }
  if (predictionSharesInput) {
    predictionSharesInput.value = String(normalizePredictionShares(config.predictionShares));
  }
  if (predictionBuyTypeSelect) {
    predictionBuyTypeSelect.value = normalizeManualOrderType(config.predictionBuyOrderType);
  }
  if (predictionSellTypeSelect) {
    predictionSellTypeSelect.value = normalizePredictionSellOrderType(
      config.predictionSellOrderType,
    );
  }
  const quotes = normalizePredictionQuoteBand(
    config.predictionMinQuoteCents,
    config.predictionMaxQuoteCents,
  );
  if (maxQuoteInput) maxQuoteInput.value = String(quotes.maxQuoteCents);
  if (minQuoteInput) minQuoteInput.value = String(quotes.minQuoteCents);
  if (shiftInput) {
    shiftInput.value = String(normalizePredictionShiftCents(config.predictionShiftCents));
  }
  if (riseInput) {
    riseInput.value = String(normalizePredictionRiseCents(config.predictionRiseCents));
  }
  if (sensInput) {
    sensInput.value = String(
      normalizeManipulationSensitivity(config.manipulationSensitivitySec),
    );
  }
  const area = normalizeManipulationArea(
    config.manipulationAreaStart,
    config.manipulationAreaEnd,
  );
  manipAreaStart = area.manipulationAreaStart;
  manipAreaEnd = area.manipulationAreaEnd;
  syncManipulationAreaUi();
  syncManipulationSettingsEnabled(Boolean(config.manipulationDetector));
  manipDetectorRuntime.rightCount = normalizePredictionCount(config.predictionRightCount);
  manipDetectorRuntime.wrongCount = normalizePredictionCount(config.predictionWrongCount);
  syncPredictionStatsUi();
  syncPredictionStatusUi();
  syncWalletControls(config);
}

function setPredictionInfoPanelOpen(open) {
  const btn = $("prediction-info-btn");
  const panel = $("prediction-info-panel");
  if (!btn || !panel) return;
  const on = Boolean(open);
  panel.classList.toggle("is-open", on);
  panel.setAttribute("aria-hidden", on ? "false" : "true");
  btn.setAttribute("aria-expanded", on ? "true" : "false");
}

function bindPredictionInfoTip() {
  const btn = $("prediction-info-btn");
  const panel = $("prediction-info-panel");
  if (!btn || !panel || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";

  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setPredictionInfoPanelOpen(!panel.classList.contains("is-open"));
  });

  document.addEventListener("click", (event) => {
    if (!panel.classList.contains("is-open")) return;
    const target = event.target;
    if (btn.contains(target) || panel.contains(target)) return;
    setPredictionInfoPanelOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setPredictionInfoPanelOpen(false);
  });
}

function bindTradeToggles() {
  const autoTradeInput = $("auto-trade");
  const useScheduleInput = $("use-schedule");
  const startTradingInput = $("start-trading");
  const sharesInput = $("manual-shares");
  const unitSelect = $("manual-order-unit");
  const buyTypeSelect = $("manual-buy-order-type");
  const sellTypeSelect = $("manual-sell-order-type");
  const manipInput = $("manipulation-detector");
  const maxQuoteInput = $("prediction-max-quote");
  const minQuoteInput = $("prediction-min-quote");
  const shiftInput = $("prediction-shift");
  const riseInput = $("prediction-rise");
  const sensInput = $("manipulation-sensitivity");
  if (!autoTradeInput || !useScheduleInput || !startTradingInput) return;

  // Restore immediately from localStorage, then sync from server
  applyTradingConfigToUi(readLocalTradingConfig());
  loadPredictionPositionCards();
  if (isPredictionTriggerHost()) restorePredictionRuntime();
  else syncPredictionCardsFromRuntime();
  refreshPositionsForPrediction();
  void loadTradingConfig().then((config) => {
    applyTradingConfigToUi(coalesceTradingConfig(config, readLocalTradingConfig()) ?? config);
    syncGraphSaveBtn(windowState);
    if (windowState) drawPriceChart(windowState);
    refreshPositionsForPrediction();
  });

  bindManipulationAreaSlider();
  bindPredictionInfoTip();

  autoTradeInput.addEventListener("change", async () => {
    // Use Schedule only makes sense with Auto Trade; do not touch Allow trade.
    if (!autoTradeInput.checked) {
      useScheduleInput.checked = false;
    }
    const patch = buildTradingConfigPatch();
    writeLocalTradingConfig(patch);
    const config = await pushTradingConfig(patch);
    applyTradingConfigToUi(coalesceTradingConfig(config, patch) ?? patch);
    syncGraphSaveBtn(windowState);
    if (windowState) drawPriceChart(windowState);
    appendLogEntry({
      level: "info",
      source: "client",
      message: autoTradeInput.checked ? "Auto Trade enabled" : "Auto Trade disabled",
    });
  });

  useScheduleInput.addEventListener("change", async () => {
    const patch = buildTradingConfigPatch();
    writeLocalTradingConfig(patch);
    const turningOff = !useScheduleInput.checked;
    // Snapshot schedule bars before config flips — otherwise SSE reloads the old sim setup.
    if (turningOff && windowState && window.Simulator?.keepDisplayedSetupAsEditable) {
      window.Simulator.keepDisplayedSetupAsEditable(windowState);
    }
    const config = await pushTradingConfig(patch);
    applyTradingConfigToUi(coalesceTradingConfig(config, patch) ?? patch);
    if (useScheduleInput.checked && windowState && window.Simulator?.forceSyncSetupFromState) {
      window.Simulator.forceSyncSetupFromState(windowState);
    } else if (turningOff && window.Simulator?.pushSetupToServer) {
      await window.Simulator.pushSetupToServer();
    }
    syncGraphSaveBtn(windowState);
    if (windowState) drawPriceChart(windowState);
    appendLogEntry({
      level: "info",
      source: "client",
      message: useScheduleInput.checked ? "Use Schedule enabled" : "Use Schedule disabled",
    });
  });

  const setAllowTradeFromSegment = (on) => {
    if (startTradingInput.checked === on) {
      syncAllowTradeSegment(on);
      return;
    }
    startTradingInput.checked = on;
    startTradingInput.dispatchEvent(new Event("change", { bubbles: true }));
  };
  $("start-trading-off")?.addEventListener("click", (e) => {
    e.preventDefault();
    setAllowTradeFromSegment(false);
  });
  $("start-trading-on")?.addEventListener("click", (e) => {
    e.preventDefault();
    setAllowTradeFromSegment(true);
  });

  startTradingInput.addEventListener("change", async () => {
    // Allow trade only switches real vs demo — leave Auto Trade / Use Schedule alone.
    // Turning Allow trade off forces Prediction Trade off and Trigger cards off Trade.
    syncAllowTradeSegment(startTradingInput.checked);
    syncPredictionTradeEnabled();
    if (!startTradingInput.checked) {
      forceTradeTriggersToDemo("Allow trade off");
    }
    const patch = buildTradingConfigPatch();
    writeLocalTradingConfig(patch);
    const config = await pushTradingConfig(patch);
    applyTradingConfigToUi(coalesceTradingConfig(config, patch) ?? patch);
    if (windowState) drawPriceChart(windowState);
    if (startTradingInput.checked) invalidateTriggerGtdArmKeys();
    scheduleTriggerGtdArming(windowState);
    appendLogEntry({
      level: "info",
      source: "client",
      message: startTradingInput.checked
        ? "Allow trade enabled (real hits)"
        : "Allow trade disabled (demo hits)",
    });
  });

  manipInput?.addEventListener("change", async () => {
    syncManipulationSettingsEnabled(Boolean(manipInput.checked));
    if (!manipInput.checked) {
      manipDetectorRuntime.samples = [];
      clearManipulationFlash();
    }
    syncPredictionStatusUi();
    refreshPositionsForPrediction();
    await persistManipulationConfigPatch();
    appendLogEntry({
      level: "info",
      source: "client",
      message: manipInput.checked ? "Prediction enabled" : "Prediction disabled",
    });
  });

  const predictionTradeInput = $("prediction-trade");
  const predictionSharesInput = $("prediction-shares");
  const predictionBuyTypeSelect = $("prediction-buy-order-type");
  const predictionSellTypeSelect = $("prediction-sell-order-type");

  // Prediction Trade removed — Trigger cards are the only live order path.
  if (predictionTradeInput) {
    predictionTradeInput.checked = false;
    predictionTradeInput.disabled = true;
  }

  predictionSharesInput?.addEventListener("change", async () => {
    if (predictionSharesInput.disabled) return;
    predictionSharesInput.value = String(
      normalizePredictionShares(predictionSharesInput.value),
    );
    await persistManipulationConfigPatch();
  });

  predictionBuyTypeSelect?.addEventListener("change", async () => {
    if (predictionBuyTypeSelect.disabled) return;
    predictionBuyTypeSelect.value = normalizeManualOrderType(predictionBuyTypeSelect.value);
    await persistManipulationConfigPatch();
  });

  predictionSellTypeSelect?.addEventListener("change", async () => {
    if (predictionSellTypeSelect.disabled) return;
    predictionSellTypeSelect.value = normalizePredictionSellOrderType(
      predictionSellTypeSelect.value,
    );
    await persistManipulationConfigPatch();
  });

  const commitPredictionQuotes = async () => {
    if (maxQuoteInput?.disabled || minQuoteInput?.disabled) return;
    const band = normalizePredictionQuoteBand(minQuoteInput?.value, maxQuoteInput?.value);
    if (maxQuoteInput) maxQuoteInput.value = String(band.maxQuoteCents);
    if (minQuoteInput) minQuoteInput.value = String(band.minQuoteCents);
    manipDetectorRuntime.samples = [];
    await persistManipulationConfigPatch();
  };

  maxQuoteInput?.addEventListener("change", () => {
    void commitPredictionQuotes();
  });

  minQuoteInput?.addEventListener("change", () => {
    void commitPredictionQuotes();
  });

  shiftInput?.addEventListener("change", async () => {
    if (shiftInput.disabled) return;
    const next = normalizePredictionShiftCents(shiftInput.value);
    shiftInput.value = String(next);
    manipDetectorRuntime.samples = [];
    await persistManipulationConfigPatch();
  });

  riseInput?.addEventListener("change", async () => {
    if (riseInput.disabled) return;
    const next = normalizePredictionRiseCents(riseInput.value);
    riseInput.value = String(next);
    await persistManipulationConfigPatch();
  });

  sensInput?.addEventListener("change", async () => {
    if (sensInput.disabled) return;
    const next = normalizeManipulationSensitivity(sensInput.value);
    sensInput.value = String(next);
    manipDetectorRuntime.samples = [];
    await persistManipulationConfigPatch();
  });

  unitSelect?.addEventListener("change", async () => {
    if (autoTradeInput.checked) return;
    const manualOrderUnit = unitSelect.value === "usdc" ? "usdc" : "shares";
    syncManualAmountInputAttrs(manualOrderUnit);
    const manualShares = normalizeManualAmount(sharesInput?.value, manualOrderUnit);
    if (sharesInput) sharesInput.value = String(manualShares);
    const patch = buildTradingConfigPatch({ manualOrderUnit, manualShares });
    writeLocalTradingConfig(patch);
    await pushTradingConfig(patch);
  });

  sharesInput?.addEventListener("change", async () => {
    if (autoTradeInput.checked) return;
    const manualOrderUnit = unitSelect?.value === "usdc" ? "usdc" : "shares";
    const manualShares = normalizeManualAmount(sharesInput.value, manualOrderUnit);
    sharesInput.value = String(manualShares);
    const patch = buildTradingConfigPatch({ manualShares, manualOrderUnit });
    writeLocalTradingConfig(patch);
    await pushTradingConfig(patch);
  });

  const persistManualOrderTypes = async () => {
    const patch = buildTradingConfigPatch({
      manualBuyOrderType: normalizeManualOrderType(buyTypeSelect?.value),
      manualSellOrderType: normalizeManualOrderType(sellTypeSelect?.value),
    });
    writeLocalTradingConfig(patch);
    const config = await pushTradingConfig(patch);
    applyTradingConfigToUi(coalesceTradingConfig(config, patch) ?? patch);
  };
  buyTypeSelect?.addEventListener("change", () => {
    void persistManualOrderTypes();
  });
  sellTypeSelect?.addEventListener("change", () => {
    void persistManualOrderTypes();
  });

  $("prediction-stats-reset")?.addEventListener("click", () => {
    manipDetectorRuntime.rightCount = 0;
    manipDetectorRuntime.wrongCount = 0;
    syncPredictionStatsUi();
    void persistPredictionStats();
    appendLogEntry({
      level: "info",
      source: "client",
      message: "Prediction stats reset",
    });
  });

}

window.getAutoTrade = () => Boolean($("auto-trade")?.checked);
window.getStartTrading = () => {
  if (!window.getAutoTrade()) return false;
  return Boolean($("start-trading")?.checked);
};
window.getUseSchedule = () => {
  if (!window.getAutoTrade()) return false;
  return Boolean($("use-schedule")?.checked);
};
window.getTradingUiState = () => windowState?.trading ?? null;

function bindPageToggle() {
  const simulatorPage = $("page-simulator");
  const schedulePage = $("page-schedule-heatmap");
  const settingsPage = $("page-settings");
  const buttons = document.querySelectorAll(".page-toggle-btn");
  const settingsBtn = $("settings-page-btn");
  if (!simulatorPage || !schedulePage || !settingsPage || !buttons.length) return;

  const currentAppPage = () => {
    if (!settingsPage.hidden) return "settings";
    if (!schedulePage.hidden) return "schedule";
    return "simulator";
  };

  const syncActive = (page = currentAppPage()) => {
    const isSimulator = page === "simulator";
    const isSchedule = page === "schedule";
    const isSettings = page === "settings";
    const scheduleView = schedulePage.classList.contains("is-heatmap-view")
      ? "heatmap"
      : "schedule";
    for (const btn of buttons) {
      const btnPage = btn.dataset.page;
      const scheduleTab = btn.dataset.scheduleTab;
      let active = false;
      if (btnPage === "simulator") active = isSimulator;
      else if (btnPage === "heatmap" || scheduleTab === "heatmap") {
        active = isSchedule && scheduleView === "heatmap";
      } else if (btnPage === "schedule" || scheduleTab === "schedule") {
        active = isSchedule && scheduleView === "schedule";
      }
      btn.classList.toggle("is-active", active);
    }
    if (settingsBtn) settingsBtn.classList.toggle("is-active", isSettings);
  };
  syncPageToggleActive = syncActive;

  const showPage = (page, options = {}) => {
    let next = page === "heatmap" ? "schedule" : page;
    if (!walletReady && (next === "simulator" || next === "schedule")) {
      next = "settings";
    } else if (options.persist !== false) {
      saveAppPagePref(next);
    }
    const isSimulator = next === "simulator";
    const isSchedule = next === "schedule";
    const isSettings = next === "settings";
    simulatorPage.hidden = !isSimulator;
    schedulePage.hidden = !isSchedule;
    settingsPage.hidden = !isSettings;
    syncActive(next);

    if (isSimulator) {
      if (windowState) {
        resizeChartCanvas();
        drawPriceChart(windowState);
      }
      // Left column was display:none on Schedule — reflow after layout so an open
      // log fills the section again (pixel heights go stale while hidden).
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!leftColumnLayout) return;
          if (!leftColumnLayout.getMetrics().maxContent) return;
          const col = document.querySelector(".left-column");
          const inlineTrade = col?.style.getPropertyValue("--trade-content-height") ?? "";
          const needsInit = !inlineTrade;
          if (needsInit) {
            const { maxContent } = leftColumnLayout.getMetrics();
            leftColumnLayout.applyHeights(0, maxContent, 0, 0, 0);
          } else {
            leftColumnLayout.reflowHeights();
          }
          syncLeftColumnRail();
          syncMarketColumnRail();
        });
      });
    } else if (isSchedule) {
      // Setups + placement cards stay mounted across page toggles; they load once
      // at boot and refresh only on create/edit/delete (see afterTradingSetupChange).
      if (lastHeatmapState) renderHeatmap(lastHeatmapState);
      else void loadHeatmap();
    } else if (isSettings) {
      void loadSettingsUser();
      void loadWalletAccount();
    }

    if (window.SchedulePlacements) {
      window.SchedulePlacements.onViewChange();
      // Header stats range is a user choice (saved in localStorage) — do not
      // force it per page, or manual selections never stick (see docs/schedule.md).
    }
  };
  showAppPage = showPage;

  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      if (btn.disabled || btn.classList.contains("is-active")) return;
      const page = btn.dataset.page;
      const scheduleTab = btn.dataset.scheduleTab;
      if (page === "heatmap" || scheduleTab === "heatmap") {
        showPage("schedule");
        showScheduleView("heatmap");
        return;
      }
      if (scheduleTab === "schedule") {
        showPage("schedule");
        showScheduleView("schedule");
        return;
      }
      if (!page) return;
      showPage(page);
    });
  }

  if (settingsBtn && settingsBtn.dataset.bound !== "1") {
    settingsBtn.dataset.bound = "1";
    settingsBtn.addEventListener("click", () => {
      if (settingsBtn.classList.contains("is-active")) return;
      showPage("settings");
    });
  }

  applyWalletGate(walletReady);
  showPage(loadAppPagePref(), { persist: false });
  delete document.documentElement.dataset.initialPage;
  delete document.documentElement.dataset.initialScheduleView;
}

function sumHeaderWidths(widths, gap) {
  const parts = widths.filter((w) => w > 0);
  if (!parts.length) return 0;
  return parts.reduce((a, b) => a + b, 0) + Math.max(0, parts.length - 1) * gap;
}

function updateAppHeaderLayout() {
  const header = document.querySelector(".app-header");
  if (!header) return;

  const headerCs = getComputedStyle(header);
  const padX =
    (parseFloat(headerCs.paddingLeft) || 0) + (parseFloat(headerCs.paddingRight) || 0);
  const available = Math.max(0, header.clientWidth - padX);
  const gap = parseFloat(headerCs.gap) || 10;

  const probe = header.cloneNode(true);
  probe.classList.remove("is-compact", "is-stats-row", "is-nav-stack");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = [
    "position:fixed",
    "left:-10000px",
    "top:0",
    `width:${header.clientWidth}px`,
    "height:45px",
    "display:flex",
    "flex-wrap:nowrap",
    "align-items:center",
    `gap:${gap}px`,
    "visibility:hidden",
    "pointer-events:none",
    "z-index:-1",
  ].join(";");
  probe.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  document.body.appendChild(probe);

  const pieceWidth = (sel) => {
    const el = probe.querySelector(`:scope > ${sel}`);
    if (!el || el.hasAttribute("hidden") || el.hidden) return 0;
    if (getComputedStyle(el).display === "none") return 0;
    el.style.flexShrink = "0";
    el.style.marginLeft = "0";
    return el.getBoundingClientRect().width;
  };

  const titleW = pieceWidth(".app-title");
  const navW = pieceWidth(".header-nav");
  const highlightedW = pieceWidth(".schedule-highlighted-summary");
  const statsW = pieceWidth(".schedule-week-summary");
  const endW = pieceWidth(".header-end");

  const navProbe = probe.querySelector(":scope > .header-nav");
  const navGap = navProbe ? parseFloat(getComputedStyle(navProbe).gap) || gap : gap;
  const navChildWidth = (sel) => {
    if (!navProbe) return 0;
    const el = navProbe.querySelector(sel);
    if (!el || el.hasAttribute("hidden") || el.hidden) return 0;
    if (getComputedStyle(el).display === "none") return 0;
    el.style.flexShrink = "0";
    el.style.width = "max-content";
    el.style.maxWidth = "none";
    return el.getBoundingClientRect().width;
  };
  const marketRowW =
    navChildWidth(".header-market-row") || navChildWidth("#market-select, select");
  const pageToggleW = navChildWidth(".page-toggle");
  // Countdown may sit as a direct nav sibling (right-aligned); don't double-count
  // when it is already inside .header-market-row.
  const countdownNavW = navProbe?.querySelector(":scope > .countdown")
    ? navChildWidth(":scope > .countdown")
    : 0;
  probe.remove();

  const singleNeeded = sumHeaderWidths(
    [titleW, navW, highlightedW, statsW, endW],
    gap
  );
  // First row after nav has wrapped: title + optional custom summary + stats + end.
  const row1Needed = sumHeaderWidths([titleW, highlightedW, statsW, endW], gap);
  const navRowNeeded = sumHeaderWidths([marketRowW, pageToggleW, countdownNavW], navGap);

  const wasCompact = header.classList.contains("is-compact");
  const wasStatsRow = header.classList.contains("is-stats-row");
  const wasNavStack = header.classList.contains("is-nav-stack");
  const mobileHeader = isMarketMobileStack();
  // Enter on overflow; leave only once there is spare room (avoids boundary flicker).
  // On mobile, always use the multi-row header so Market/Schedule can be bottom tabs.
  const compact = mobileHeader
    ? true
    : wasCompact || wasStatsRow || wasNavStack
      ? singleNeeded > available - 16
      : singleNeeded > available + 0.5;
  // On mobile, always put stats on its own row so Wallet can sit on row 1 with the title.
  const statsRow = mobileHeader
    ? true
    : !compact
      ? false
      : wasStatsRow
        ? row1Needed > available - 16
        : row1Needed > available + 0.5;
  // When nav is on its own row and market + page toggle no longer fit side by side,
  // stack them so each takes a full-width row (switcher drops below the dropdown).
  // On mobile, always stack so Market/Schedule sit as bottom-edge tabs.
  const navStack = !compact ? false : mobileHeader ? true : wasNavStack
    ? navRowNeeded > available - 16
    : navRowNeeded > available + 0.5;

  if (wasCompact === compact && wasStatsRow === statsRow && wasNavStack === navStack) {
    syncMobileCountdownPlacement();
    syncMobileWalletPlacement();
    return;
  }
  header.classList.toggle("is-compact", compact);
  header.classList.toggle("is-stats-row", statsRow);
  header.classList.toggle("is-nav-stack", navStack);
  syncMobileCountdownPlacement();
  syncMobileWalletPlacement();
}

function initAppHeaderLayout() {
  const header = document.querySelector(".app-header");
  if (!header) return;

  let raf = 0;
  let lastWidth = header.clientWidth;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      updateAppHeaderLayout();
    });
  };

  schedule();
  window.addEventListener("resize", schedule);

  if (typeof ResizeObserver === "function") {
    // Only react to width changes on the header itself — height changes from
    // toggling layout classes must not re-trigger the layout decision.
    const headerRo = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? header.clientWidth;
      if (Math.abs(w - lastWidth) < 0.5) return;
      lastWidth = w;
      schedule();
    });
    headerRo.observe(header);

    const contentRo = new ResizeObserver(schedule);
    header
      .querySelectorAll(
        ".app-title, .header-nav, .header-end, .header-market-row, #market-select, .page-toggle, #schedule-week-summary, #schedule-highlighted-summary"
      )
      .forEach((el) => contentRo.observe(el));
  }

  if (typeof MutationObserver === "function") {
    const highlighted = header.querySelector("#schedule-highlighted-summary");
    if (highlighted) {
      new MutationObserver(schedule).observe(highlighted, {
        attributes: true,
        attributeFilter: ["hidden", "class"],
      });
    }
  }
}

async function init() {
  loadPositionsHiddenIds();
  demoPositionCards = loadDemoPositionCards();
  scanAndResumeStuckDemoOpenCards();
  bindPositionsFilter();
  initSimulatorBoxScrollbars();
  initChart();
  initColumnSplitter();
  initLeftRowSplitter();
  initMarketMobileStack();
  initScheduleMobileSide();
  bindLeftColumnRail();
  bindMarketColumnRail();
  bindTriggerCreateModal();
  // Keep collapsed rails hidden until layout + split % are known (avoids flash on refresh).
  syncLeftColumnRail();
  syncMarketColumnRail();
  requestAnimationFrame(() => {
    syncLeftColumnRail();
    syncMarketColumnRail();
  });
  void loadWalletAccount();
  void loadSettingsUser();
  bindWalletBalanceRefresh();
  bindSettingsEditors();
  initScheduleDaySlots();
  initScheduleUtcColumn();
  initHeatmapLegend();
  initScheduleWorkspaceMode();
  if (window.SchedulePlacements) window.SchedulePlacements.init();
  if (window.SetupEditor) window.SetupEditor.init();
  bindPageToggle();
  bindTradeToggles();
  bindQuoteBoxes();
  bindPredictionStatusBuyButton();
  bindScheduleViewToggle();
  bindSetupSaveModal();
  bindModalKeyboardShortcuts();
  bindSetupListMenus();
  initAppHeaderLayout();
  void loadHeatmap();
  await loadScheduleSetups();
  if (window.SchedulePlacements) void window.SchedulePlacements.loadPlacements();
  await loadMarkets();
  updateAppHeaderLayout();
  const res = await fetch(`/api/window?series=${encodeURIComponent(selectedSeries)}`, {
    credentials: "same-origin",
  });
  if (res.ok) updateWindowUI(await res.json());
  connectSSE();

  countdownTimer = setInterval(() => {
    if (windowState) {
      updateCountdown(windowState);
      drawPriceChart(windowState);
    }
  }, 1000);
}

let appInitialized = false;

async function enterApp(user, options = {}) {
  setCurrentUser(user);
  const keepPublicRoute = Boolean(options.keepPublicRoute);
  if (!keepPublicRoute) {
    showAppShell();
    syncAuthUrl("main", { replace: true });
  }
  if (user) {
    renderSettingsUser(user);
    applyWalletGate(isWalletReadyFromUser(user));
  }
  if (appInitialized) {
    demoPositionCards = loadDemoPositionCards();
    scanAndResumeStuckDemoOpenCards();
    void loadUserTriggers().then(() => renderTriggersList());
    void loadWalletAccount();
    void loadSettingsUser();
    return;
  }
  appInitialized = true;
  await init();
  if (!keepPublicRoute && !walletReady && typeof showAppPage === "function") {
    showAppPage("settings", { persist: false });
  }
}

async function boot() {
  bindAuthUrlRouting();
  bindAuthForm(enterApp);
  const routeTab = pathToAuthTab(location.pathname);
  // Paint Docs/Versions immediately so a logged-in refresh never flashes Market.
  if (routeTab === "docs" || routeTab === "versions") {
    showAuthOverlay();
    authTopTab = routeTab;
    renderAuthTopPanels(routeTab);
    syncAuthMainTabButton();
    if (routeTab === "docs") void ensureAuthDocsReady();
    if (routeTab === "versions") void ensureAuthVersionsReady();
  }
  try {
    const user = await fetchAuthMe();
    if (user) {
      if (routeTab === "docs" || routeTab === "versions") {
        await enterApp(user, { keepPublicRoute: true });
        syncAuthMainTabButton();
        delete document.documentElement.dataset.initialAuthTab;
        delete document.documentElement.dataset.signedInHint;
        return;
      }
      await enterApp(user);
      delete document.documentElement.dataset.initialAuthTab;
      delete document.documentElement.dataset.signedInHint;
      return;
    }
  } catch {
    // fall through to public auth pages
  }
  setSignedInHint(false);
  delete document.documentElement.dataset.signedInHint;
  if (routeTab === "docs" || routeTab === "versions") {
    syncAuthMainTabButton();
    delete document.documentElement.dataset.initialAuthTab;
    return;
  }
  showAuthScreen();
  delete document.documentElement.dataset.initialAuthTab;
}

boot();
