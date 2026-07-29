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
    const locked = !walletReady && (page === "simulator" || page === "schedule");
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
  document.querySelectorAll(".settings-info-toggle").forEach((btn) => {
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

function bindWalletBalanceRefresh() {
  const btn = $("wallet-balance-refresh");
  if (!btn || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add("is-loading");
    try {
      await loadWalletAccount();
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-loading");
    }
  });
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

    const allowed = canQuoteAction(trading, cfg.side, cfg.leg);
    box.classList.toggle("quote-box-disabled", !allowed);

    const lockedPrice = locks[cfg.lockKey];
    if (lockedPrice != null && Number.isFinite(lockedPrice)) {
      locked.hidden = false;
      locked.textContent = fmtQuote(lockedPrice);
      values.classList.add("quote-has-locked");
      box.classList.add(cfg.tone === "up" ? "quote-triggered-up" : "quote-triggered-down");
      box.classList.add("quote-box-latched");
      box.classList.remove("quote-box-pressing");
    } else {
      locked.hidden = true;
      locked.textContent = "";
      values.classList.remove("quote-has-locked");
      box.classList.remove("quote-triggered-up", "quote-triggered-down", "quote-box-latched");
    }
  }
}

let quoteOrderInFlight = false;

async function postTradingOrder(side, leg) {
  const res = await fetch("/api/trading/order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ side, leg }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function clickQuoteBox(side, leg) {
  if (quoteOrderInFlight) return;
  const trading = tradingState(windowState);
  if (trading && !canQuoteAction(trading, side, leg)) return;

  quoteOrderInFlight = true;
  const boxId = QUOTE_BOXES.find((b) => b.side === side && b.leg === leg)?.boxId;
  const box = boxId ? $(boxId) : null;
  if (box) box.classList.add("quote-box-pending");

  try {
    const { ok, status, body } = await postTradingOrder(side, leg);
    if (!ok) {
      appendLogEntry({
        level: "error",
        source: "trading",
        message: body.error || `Order failed (${status})`,
      });
      return;
    }
    const winRes = await fetch(`/api/window?series=${encodeURIComponent(selectedSeries)}`);
    if (winRes.ok) updateWindowUI(await winRes.json());
    void loadWalletAccount();
  } catch (err) {
    appendLogEntry({
      level: "error",
      source: "trading",
      message: `Order error: ${err.message || err}`,
    });
  } finally {
    quoteOrderInFlight = false;
    if (box) box.classList.remove("quote-box-pending");
  }
}

function bindQuoteBoxes() {
  for (const cfg of QUOTE_BOXES) {
    const box = $(cfg.boxId);
    if (!box || box.dataset.bound === "1") continue;
    box.dataset.bound = "1";

    box.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || box.classList.contains("quote-box-disabled")) return;
      box.classList.add("quote-box-pressing");
    });

    const releasePress = () => {
      if (!box.classList.contains("quote-box-latched")) {
        box.classList.remove("quote-box-pressing");
      }
    };

    box.addEventListener("mouseup", releasePress);
    box.addEventListener("mouseleave", releasePress);

    box.addEventListener("click", () => {
      void clickQuoteBox(cfg.side, cfg.leg);
    });
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

/** Row-split helpers filled by initLeftRowSplitter. */
let leftColumnLayout = null;

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
  const logHeader = document.querySelector(".log-panel-header");
  const prevBody = document.querySelector(".positions-body");
  const logBody = document.querySelector(".log-output");
  const prevDragHandle = document.querySelector('[data-drag-edge="prev"]');
  const logDragHandle = document.querySelector('[data-drag-edge="log"]');
  if (
    !leftColumn ||
    !walletHeader ||
    !tradeHeader ||
    !tradeBody ||
    !prevHeader ||
    !logHeader ||
    !prevDragHandle ||
    !logDragHandle ||
    !prevBody ||
    !logBody
  ) {
    return;
  }

  let dragging = false;
  let dragKind = null;
  let anchorLogHeaderTop = 0;
  let anchorLogContent = 0;
  let anchorTradeContent = 0;
  let activeHandle = null;

  const parseHeight = (name, fallback) => {
    const raw = getComputedStyle(leftColumn).getPropertyValue(name);
    const value = raw ? parseFloat(raw) : Number.NaN;
    return Number.isFinite(value) ? value : fallback;
  };

  const getMetrics = () => {
    const colRect = leftColumn.getBoundingClientRect();
    const walletHeaderH = walletHeader.offsetHeight;
    const tradeHeaderH = tradeHeader.offsetHeight;
    const prevHeaderH = prevHeader.offsetHeight;
    const logHeaderH = logHeader.offsetHeight;
    const chrome = walletHeaderH + tradeHeaderH + prevHeaderH + logHeaderH;
    const maxContent = Math.max(0, colRect.height - chrome);
    return {
      colRect,
      walletHeaderH,
      tradeHeaderH,
      prevHeaderH,
      logHeaderH,
      chrome,
      maxContent,
    };
  };

  const readHeights = () => ({
    trade: parseHeight("--trade-content-height", 140),
    prev: parseHeight("--prev-content-height", 0),
    log: parseHeight("--log-content-height", 0),
  });

  const applyHeights = (trade, prev, log) => {
    const { colRect, chrome, maxContent } = getMetrics();
    let t = Math.max(0, trade);
    let p = Math.max(0, prev);
    let l = Math.max(0, log);

    // While the market page is hidden (display:none), geometry is 0 — do not
    // recompute margin / redistribute or an open log will collapse on return.
    const layoutReady = colRect.height > chrome;

    if (layoutReady) {
      const total = t + p + l;
      if (total > maxContent && total > 0) {
        const scale = maxContent / total;
        t *= scale;
        p *= scale;
        l *= scale;
      } else if (total < maxContent) {
        // Fill leftover column space into an open content body (not as a gap
        // below Positions that looks like an empty section).
        const slack = maxContent - total;
        if (l > 0) {
          l += slack;
        } else if (p > 0) {
          p += slack;
        } else if (t > 0) {
          t += slack;
        }
      }
    }

    leftColumn.style.setProperty("--trade-content-height", `${t}px`);
    leftColumn.style.setProperty("--prev-content-height", `${p}px`);
    leftColumn.style.setProperty("--log-content-height", `${l}px`);

    if (layoutReady) {
      const stackHeight = chrome + t + p + l;
      // Only pin Log with margin when every content body is collapsed.
      const margin =
        t <= 0 && p <= 0 && l <= 0 ? Math.max(0, colRect.height - stackHeight) : 0;
      leftColumn.style.setProperty("--log-margin-top", `${margin}px`);
    }

    tradeBody.classList.toggle("is-collapsed", t <= 0);
    prevBody.classList.toggle("is-collapsed", p <= 0);
    logBody.classList.toggle("is-collapsed", l <= 0);
    const hasPositionCards = Boolean(prevBody.querySelector(".position-card"));
    prevBody.classList.toggle("is-scrollable", p > 0 && hasPositionCards);
    logBody.classList.toggle("is-scrollable", l > 0);
  };

  const reflowHeights = () => {
    const heights = readHeights();
    applyHeights(heights.trade, heights.prev, heights.log);
  };

  const maximizeSection = (section) => {
    const { maxContent } = getMetrics();
    if (section === "positions") {
      applyHeights(0, maxContent, 0);
      return;
    }
    if (section === "log") {
      applyHeights(0, 0, maxContent);
      return;
    }
    // trade / wallet / default — expand Trade content
    applyHeights(maxContent, 0, 0);
  };

  leftColumnLayout = { applyHeights, maximizeSection, readHeights, getMetrics, reflowHeights };

  const initDefaultHeights = () => {
    const { maxContent } = getMetrics();
    if (maxContent < 1) return;
    applyHeights(0, maxContent, 0);
  };

  const clampPrevDrag = (clientY) => {
    const { colRect, walletHeaderH, tradeHeaderH, prevHeaderH, logHeaderH } = getMetrics();
    // Positions can cover Trade content, but not Wallet or Trade headers.
    const tradeHeaderBottom = colRect.top + walletHeaderH + tradeHeaderH;
    const minPrevTop = tradeHeaderBottom;
    // Dragging down past the Log header pushes it down, to the column bottom.
    const maxPrevTop = colRect.bottom - prevHeaderH - logHeaderH;
    const prevTop = Math.max(minPrevTop, Math.min(clientY, maxPrevTop));
    const trade = prevTop - tradeHeaderBottom;
    const prevBottom = prevTop + prevHeaderH;
    if (prevBottom > anchorLogHeaderTop) {
      // Touching the Log header — push it down and shrink the log content.
      anchorLogHeaderTop = prevBottom;
      anchorLogContent = Math.max(0, colRect.bottom - prevBottom - logHeaderH);
      applyHeights(trade, 0, anchorLogContent);
      return;
    }
    const prev = anchorLogHeaderTop - prevTop - prevHeaderH;
    applyHeights(trade, prev, anchorLogContent);
  };

  const clampLogDrag = (clientY) => {
    const { colRect, walletHeaderH, tradeHeaderH, prevHeaderH, logHeaderH } = getMetrics();
    const tradeHeaderBottom = colRect.top + walletHeaderH + tradeHeaderH;
    const prevBottom = prevHeader.getBoundingClientRect().bottom;
    // Dragging up past the Positions header pushes it up, down to the Trade header.
    const minLogTop = tradeHeaderBottom + prevHeaderH;
    const maxLogTop = colRect.bottom - logHeaderH;
    let logTop = Math.max(minLogTop, Math.min(clientY, maxLogTop));
    if (logTop < prevBottom) {
      // Touching the Positions header — push it up and shrink the Trade content.
      anchorTradeContent = Math.max(0, logTop - prevHeaderH - tradeHeaderBottom);
      const log = Math.max(0, colRect.bottom - logTop - logHeaderH);
      applyHeights(anchorTradeContent, 0, log);
      return;
    }
    let prev = logTop - prevBottom;
    if (prev < 1) {
      prev = 0;
      logTop = prevBottom;
    }
    const log = Math.max(0, colRect.bottom - logTop - logHeaderH);
    applyHeights(anchorTradeContent, prev, log);
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
    if (e.button !== 0) return;
    dragging = true;
    dragKind = "prev";
    activeHandle = prevDragHandle;
    anchorLogHeaderTop = logHeader.getBoundingClientRect().top;
    anchorLogContent = readHeights().log;
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

  const startLogDrag = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    dragKind = "log";
    activeHandle = logDragHandle;
    anchorTradeContent = readHeights().trade;
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
    else if (dragKind === "log") clampLogDrag(e.clientY);
  };

  prevDragHandle.addEventListener("pointerdown", startPrevDrag);
  logDragHandle.addEventListener("pointerdown", startLogDrag);
  prevDragHandle.addEventListener("pointermove", onPointerMove);
  logDragHandle.addEventListener("pointermove", onPointerMove);
  prevDragHandle.addEventListener("pointerup", stopDragging);
  logDragHandle.addEventListener("pointerup", stopDragging);
  prevDragHandle.addEventListener("pointercancel", stopDragging);
  logDragHandle.addEventListener("pointercancel", stopDragging);
  prevDragHandle.addEventListener("lostpointercapture", stopDragging);
  logDragHandle.addEventListener("lostpointercapture", stopDragging);
  window.addEventListener("blur", stopDragging);
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
    if (e.button !== 0) return;
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
  if (trading) {
    const cfg = trading.config;
    let phasesOn = Boolean(trading.phasesVisible);
    if (!phasesOn && cfg?.autoTrade && !cfg.useSchedule) phasesOn = true;
    if (!phasesOn && cfg?.autoTrade && trading.phaseSetup) phasesOn = true;
    // Setup editor passes its own override + canvas; force phases on there.
    if (options.setupOverride && options.canvas) phasesOn = true;
    overlayOpts.phasesVisible = phasesOn;
    overlayOpts.phasesEditable = trading.phasesEditable;
    if (!options.setupOverride) {
      // Prefer the editable local draft while phases can be dragged; otherwise the
      // same trading.phaseSetup used for schedule/active setup overlay.
      const editable = trading.phasesEditable !== false;
      const localDraft =
        editable && window.Simulator?.getLocalSetup ? window.Simulator.getLocalSetup() : null;
      const setup =
        localDraft ||
        trading.phaseSetup ||
        (cfg?.autoTrade && !cfg.useSchedule ? state.sim?.setup : null);
      if (setup) overlayOpts.setupOverride = setup;
    }
    if (!Array.isArray(options.markersOverride) && Array.isArray(trading.markers)) {
      overlayOpts.markersOverride = trading.markers;
    }
  } else if (options.setupOverride && options.canvas) {
    // Open Replay / custom canvas: show phase bands with the setup override.
    overlayOpts.phasesVisible = true;
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

  if (window.Simulator) {
    window.Simulator.drawOverlay(ctx, layout, state, overlayOpts);
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

function fmtTradeLeg(side, shares, price) {
  if (!side || shares == null || price == null) return "—";
  const label = side === "up" ? "UP" : "DOWN";
  return `${label} ${shares} @ ${fmtPriceCents(price)}`;
}

function positionStatusLabel(status) {
  if (status === "open") return "Open";
  if (status === "sold") return "Sold";
  if (status === "win") return "Win";
  if (status === "loss") return "Loss";
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

function renderPositionCard(card) {
  const sideClass = card.side === "up" ? "is-up" : "is-down";
  const status = card.status || "open";
  const isDemo = card.demo === true || String(card.id || "").startsWith("demo:");
  const settled = status === "sold" || status === "win" || status === "loss";
  const plPending = settled && !isDemo && card.confirmed !== true;
  // Open and waiting-for-settlement cards render the same skeleton:
  // all labels present, all values empty, so the card height never changes.
  const isLoading = !isDemo && (status === "open" || plPending);

  const buyTime = formatPositionBuyTime(card.buyAt);
  const buyLabel = buyTime
    ? `Buy <span class="position-card-buy-time">${buyTime}</span>`
    : "Buy";
  // Buy fill is known at trigger time — show it immediately, even while the
  // card is still open / waiting for confirmation.
  const hasBuyFill =
    card.shares != null && Number.isFinite(Number(card.shares)) &&
    card.buyPrice != null && Number.isFinite(Number(card.buyPrice));
  const buyValue = hasBuyFill ? `${card.shares} @ ${fmtPriceCents(card.buyPrice)}` : "";
  let detailHtml = `<div class="position-card-row"><span>${buyLabel}</span><strong>${buyValue}</strong></div>`;

  if (status === "sold") {
    detailHtml += `<div class="position-card-row"><span>Sell</span><strong>${isLoading ? "" : `${card.shares} @ ${fmtPriceCents(card.sellPrice)}`}</strong></div>`;
  } else {
    const outcome = card.outcome === "up" || card.outcome === "down" ? card.outcome : "";
    const outcomeClass = outcome === "up" ? "is-up" : outcome === "down" ? "is-down" : "";
    detailHtml += `<div class="position-card-row"><span>Market</span><strong class="position-card-outcome ${outcomeClass}">${isLoading ? "" : (outcome || "—").toUpperCase()}</strong></div>`;
  }

  if (isLoading) {
    detailHtml += `<div class="position-card-row"><span>P/L</span><strong class="position-card-pl"></strong></div>`;
  } else {
    const hasPl = card.pl != null && Number.isFinite(card.pl);
    const plClass = hasPl ? (card.pl > 0 ? "is-positive" : card.pl < 0 ? "is-negative" : "") : "";
    detailHtml += `<div class="position-card-row"><span>P/L</span><strong class="position-card-pl ${plClass}">${hasPl ? fmtUsdSigned(card.pl) : ""}</strong></div>`;
  }

  // Provisional win/loss (legacy Chainlink path) keep Waiting until Polymarket confirms.
  const statusLabel = plPending && (status === "win" || status === "loss")
    ? "Waiting"
    : positionStatusLabel(status);
  const sourceNote = isDemo ? "Demo" : isLoading ? "Pending…" : "Confirmed";
  return `<article class="position-card is-${status}${isDemo ? " is-demo" : ""}${isLoading ? " is-loading" : ""}" data-position-id="${card.id}">
    <div class="position-card-top">
      <span class="position-card-side ${sideClass}">Bet ${(card.side || "").toUpperCase()}</span>
      <span class="position-card-status">${statusLabel}</span>
    </div>
    ${detailHtml}
    <div class="position-card-row"><span>Source</span><strong>${sourceNote}</strong></div>
  </article>`;
}

const DEMO_POSITION_CARDS_KEY = "poly-real:demo-position-cards";
const POSITIONS_VIEW_KEY = "poly-real:positions-view";
const APP_PAGE_KEY = "poly-real:app-page";
const SCHEDULE_VIEW_KEY = "poly-real:schedule-view";

let positionsView = "live";
let demoPositionCards = [];
let lastPositionsFingerprint = "";
let lastDemoLastWindowKey = null;

function loadPositionsViewPref() {
  try {
    const saved = localStorage.getItem(POSITIONS_VIEW_KEY);
    if (saved === "live" || saved === "demo") positionsView = saved;
  } catch {
    // ignore
  }
}

function savePositionsViewPref() {
  try {
    localStorage.setItem(POSITIONS_VIEW_KEY, positionsView);
  } catch {
    // ignore
  }
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
  if (positionsView === "demo") updatePositionsPanel(windowState);
}

window.clearDemoPositionCards = clearDemoPositionCards;

function demoCardId(windowKey, side) {
  return `demo:${windowKey}:${side}`;
}

function shouldUpdateDemoPositionCards(trading) {
  const cfg = trading?.config;
  return Boolean(cfg?.autoTrade && !cfg.startTrading);
}

function upsertDemoPositionCard(card) {
  if (!card?.id) return;
  const idx = demoPositionCards.findIndex((c) => c.id === card.id);
  if (idx >= 0) {
    demoPositionCards[idx] = { ...demoPositionCards[idx], ...card, demo: true };
  } else {
    demoPositionCards.unshift({ ...card, demo: true });
  }
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

function ingestDemoPositionCards(state) {
  const trading = state?.trading;
  if (!trading) return;
  syncDemoCardsFromMarkers(trading, state);
  if (shouldUpdateDemoPositionCards(trading) && trading.demoLastWindow) {
    syncDemoCardsFromLastWindow(trading.demoLastWindow);
  }
}

function positionsFingerprint(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return `${positionsView}:`;
  return (
    `${positionsView}:` +
    cards
      .map(
        (c) =>
          `${c.id}:${c.status}:${c.shares}:${c.buyPrice}:${c.buyCost}:${c.sellPrice ?? ""}:${c.pl ?? ""}:${c.confirmed ? 1 : 0}`,
      )
      .join("|")
  );
}

function syncPositionsScrollable() {
  const body = $("positions-list") || document.querySelector(".positions-body");
  if (!body) return;
  const height = parseFloat(getComputedStyle(body).flexBasis) || body.clientHeight;
  const hasCards = Boolean(body.querySelector(".position-card"));
  body.classList.toggle("is-scrollable", height > 0 && hasCards);
}

function updatePositionsPanel(state) {
  const list = $("positions-cards");
  const empty = $("positions-empty");
  if (!list || !empty) return;

  ingestDemoPositionCards(state);

  const series = selectedSeries;
  const rawCards =
    positionsView === "demo"
      ? demoPositionCards
      : state?.trading?.positionCards;
  const cards = (Array.isArray(rawCards)
    ? rawCards.filter((c) => !c?.series || c.series === series)
    : []
  ).slice(0, MAX_POSITION_CARDS);

  const fingerprint = positionsFingerprint(cards);
  if (fingerprint === lastPositionsFingerprint) return;
  lastPositionsFingerprint = fingerprint;

  if (cards.length === 0) {
    list.innerHTML = "";
    empty.hidden = false;
    empty.textContent = positionsView === "demo" ? "No demo positions yet" : "No positions yet";
    syncPositionsScrollable();
    return;
  }

  empty.hidden = true;
  list.innerHTML = cards.map(renderPositionCard).join("");
  syncPositionsScrollable();
}

function syncPositionsViewControls() {
  document.querySelectorAll(".positions-view-toggle-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.positionsView === positionsView);
  });
}

function bindPositionsViewSelect() {
  const buttons = document.querySelectorAll(".positions-view-toggle-btn");
  if (buttons.length === 0) return;
  if (buttons[0].dataset.bound === "1") return;
  buttons.forEach((btn) => {
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      const next = btn.dataset.positionsView === "demo" ? "demo" : "live";
      if (next === positionsView) return;
      positionsView = next;
      savePositionsViewPref();
      syncPositionsViewControls();
      lastPositionsFingerprint = "";
      updatePositionsPanel(windowState);
    });
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
  updateCountdown(state);
  updateGraphPanel(state);
  syncManipulationAreaUi();
  tickManipulationDetector(state);

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
    opt.textContent = m.label;
    if (m._id === selectedSeries) opt.selected = true;
    sel.appendChild(opt);
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
    manipulationAreaStart: 0,
    manipulationAreaEnd: 1,
    predictionRightCount: 0,
    predictionWrongCount: 0,
  });
  resetManipulationDetector();
  if (isPredictionTriggerHost()) restorePredictionRuntime();
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

function renderScheduleSetupsList(setups, errorMessage) {
  const list = $("schedule-setups-list");
  if (!list) return;
  list.innerHTML = "";

  if (errorMessage) {
    const err = document.createElement("div");
    err.className = "schedule-setups-error";
    err.textContent = errorMessage;
    list.appendChild(err);
    return;
  }

  if (!setups?.length) {
    const empty = document.createElement("div");
    empty.className = "schedule-setups-empty";
    empty.textContent = isReplayWorkspace() ? "No replay setups yet" : "No saved setups";
    list.appendChild(empty);
    return;
  }

  for (const setup of setups) {
    const item = document.createElement("div");
    item.className = "schedule-setup-item";
    item.dataset.setupId = setup._id;
    applySetupColorStyle(item, setup.color);

    const handle = document.createElement("div");
    handle.className = "schedule-setup-drag-handle";
    handle.setAttribute("aria-label", "Drag to reorder or place on schedule");
    handle.title = "Drag to reorder or place on schedule";
    handle.innerHTML =
      '<svg viewBox="0 0 8 14" aria-hidden="true"><circle cx="2" cy="2" r="1.2" fill="currentColor"/><circle cx="6" cy="2" r="1.2" fill="currentColor"/><circle cx="2" cy="7" r="1.2" fill="currentColor"/><circle cx="6" cy="7" r="1.2" fill="currentColor"/><circle cx="2" cy="12" r="1.2" fill="currentColor"/><circle cx="6" cy="12" r="1.2" fill="currentColor"/></svg>';

    const body = document.createElement("div");
    body.className = "schedule-setup-item-body";

    const header = document.createElement("div");
    header.className = "schedule-setup-item-header";

    const main = document.createElement("div");
    main.className = "schedule-setup-item-main";

    const title = document.createElement("div");
    title.className = "schedule-setup-item-title";
    const placementCounts = getSetupPlacementCounts();
    title.textContent = formatSetupListTitle(setup.title, placementCounts[setup._id] ?? 0);
    main.appendChild(title);

    if (setup.description) {
      const desc = document.createElement("div");
      desc.className = "schedule-setup-item-desc";
      desc.textContent = setup.description;
      main.appendChild(desc);
    }

    const menuWrap = document.createElement("div");
    menuWrap.className = "schedule-setup-menu-wrap";
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "schedule-setup-menu-btn";
    menuBtn.setAttribute("aria-label", "Setup options");
    menuBtn.setAttribute("aria-haspopup", "menu");
    menuBtn.innerHTML = "&#8942;";
    menuBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    menuBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (openSetupMenuId === setup._id) {
        closeSetupMenus();
        return;
      }
      closeSetupMenus();
      openSetupMenuId = setup._id;
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
        openSetupEditor(setup);
      });

      const duplicateBtn = document.createElement("button");
      duplicateBtn.type = "button";
      duplicateBtn.className = "schedule-setup-menu-item";
      duplicateBtn.setAttribute("role", "menuitem");
      duplicateBtn.textContent = "Duplicate";
      duplicateBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void duplicateTradingSetup(setup);
      });

      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className = "schedule-setup-menu-item";
      applyBtn.setAttribute("role", "menuitem");
      applyBtn.textContent = "Apply to Simulator";
      applyBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void applySetupToSimulator(setup);
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "schedule-setup-menu-item schedule-setup-menu-item-danger";
      deleteBtn.setAttribute("role", "menuitem");
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void deleteTradingSetup(setup);
      });

      menu.append(editBtn, duplicateBtn, applyBtn, deleteBtn);
      document.body.appendChild(menu);
      positionSetupMenu(menu, menuBtn);
    });
    menuWrap.appendChild(menuBtn);

    header.append(main, menuWrap);
    body.appendChild(header);
    item.append(handle, body);
    list.appendChild(item);
  }

  if (window.SchedulePlacements) {
    window.SchedulePlacements.onSetupsRendered(setups);
  }
}

async function loadScheduleSetups(options = {}) {
  const list = $("schedule-setups-list");
  if (!list) return;
  const expectedMode = options.expectedMode || getScheduleWorkspaceMode();

  list.innerHTML = '<div class="schedule-setups-empty">Loading…</div>';

  try {
    const res = await fetch(withScheduleWorkspaceMode("/api/trading-setups"));
    // Ignore stale responses if the user switched mode mid-flight.
    if (getScheduleWorkspaceMode() !== expectedMode) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed to load setups (${res.status})`);
    }
    const setups = await res.json();
    if (getScheduleWorkspaceMode() !== expectedMode) return;
    scheduleSetupsCache = Array.isArray(setups) ? setups : [];
    renderScheduleSetupsList(scheduleSetupsCache);
  } catch (err) {
    if (getScheduleWorkspaceMode() !== expectedMode) return;
    scheduleSetupsCache = [];
    renderScheduleSetupsList([], err.message || "Failed to load setups");
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

function initScheduleDaySlots() {
  const bodies = document.querySelectorAll(".schedule-day-body");
  for (const body of bodies) {
    const firstSlot = body.querySelector(".schedule-hour-slot");
    if (firstSlot && !firstSlot.querySelector(".schedule-heatmap-row")) {
      body.replaceChildren();
    }
    if (body.children.length > 0) continue;
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
          valueEl.textContent = formatHeatmapValue(value, hasData);
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
  const buttons = document.querySelectorAll(".schedule-view-toggle-btn");
  if (!list || !heatmapPanel || !buttons.length) return;

  const showView = (view, options = {}) => {
    const next = view === "heatmap" ? "heatmap" : "schedule";
    const isSchedule = next === "schedule";
    const page = $("page-schedule-heatmap");
    page?.classList.toggle("is-heatmap-view", !isSchedule);
    list.hidden = !isSchedule;
    heatmapPanel.hidden = isSchedule;
    for (const btn of buttons) {
      btn.classList.toggle("is-active", btn.dataset.scheduleView === next);
    }
    if (options.persist !== false) saveScheduleViewPref(next);
    if (isSchedule) setWalletsListOpen(false);
    // Keep both UIs mounted. Only load heatmap the first time if not yet available.
    if (!isSchedule && !lastHeatmapState) {
      void loadHeatmap();
    }
    if (window.SchedulePlacements) window.SchedulePlacements.onViewChange();
  };

  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      const view = btn.dataset.scheduleView;
      if (!view || btn.classList.contains("is-active")) return;
      showView(view);
    });
  }

  showView(loadScheduleViewPref(), { persist: false });
}

function syncTradeToggleLabel(labelId, name, on) {
  const el = $(labelId);
  if (el) el.textContent = `${name} · ${on ? "On" : "Off"}`;
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
  // Allow trade stays visible per market (header control), even when Auto Trade is off.
  if (startTradingField) startTradingField.hidden = false;
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

function normalizeManipulationSensitivity(value) {
  const n = Number(value);
  return Math.max(1, Math.min(120, Math.round(Number.isFinite(n) ? n : 5)));
}

function normalizePredictionMaxQuoteCents(value) {
  const n = Math.round(Number(value));
  return Math.max(1, Math.min(99, Number.isFinite(n) ? n : 90));
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
      manipulationSensitivitySec: normalizeManipulationSensitivity(parsed.manipulationSensitivitySec),
      predictionMaxQuoteCents: normalizePredictionMaxQuoteCents(parsed.predictionMaxQuoteCents),
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
        manipulationSensitivitySec: normalizeManipulationSensitivity(config.manipulationSensitivitySec),
        predictionMaxQuoteCents: normalizePredictionMaxQuoteCents(config.predictionMaxQuoteCents),
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

function buildTradingConfigPatch(overrides = {}) {
  const autoTradeInput = $("auto-trade");
  const useScheduleInput = $("use-schedule");
  const startTradingInput = $("start-trading");
  const sharesInput = $("manual-shares");
  const unitSelect = $("manual-order-unit");
  const buyTypeSelect = $("manual-buy-order-type");
  const sellTypeSelect = $("manual-sell-order-type");
  const manipInput = $("manipulation-detector");
  const sensInput = $("manipulation-sensitivity");
  const maxQuoteInput = $("prediction-max-quote");
  const manualOrderUnit = unitSelect?.value === "usdc" ? "usdc" : "shares";
  const area = normalizeManipulationArea(manipAreaStart, manipAreaEnd);
  return {
    autoTrade: Boolean(autoTradeInput?.checked),
    useSchedule: Boolean(useScheduleInput?.checked),
    startTrading: Boolean(startTradingInput?.checked),
    manualOrderUnit,
    manualShares: normalizeManualAmount(sharesInput?.value, manualOrderUnit),
    manualBuyOrderType: normalizeManualOrderType(buyTypeSelect?.value),
    manualSellOrderType: normalizeManualOrderType(sellTypeSelect?.value),
    manipulationDetector: Boolean(manipInput?.checked),
    manipulationSensitivitySec: normalizeManipulationSensitivity(sensInput?.value),
    predictionMaxQuoteCents: normalizePredictionMaxQuoteCents(maxQuoteInput?.value),
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
const PREDICTION_RESOLVE_MAX_MS = 45000;
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
const PREDICTION_ICON_CHECK =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>';
const PREDICTION_ICON_CROSS =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 4 12 12M12 4 4 12"/></svg>';

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
  /** @type {"none"|"active"|"pending"|"right"|"wrong"} */
  uiPhase: "none",
  /** @type {number[]} */
  scoredWindowStarts: [],
  lastPrice: null,
  lastPtb: null,
  resolveTimer: null,
  resolveStartedAt: 0,
  resultClearTimer: null,
  /**
   * Pending predictions parked when a newer one takes the UI.
   * @type {Array<{
   *   side: "up"|"down",
   *   windowStart: number,
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
    const background = serializeBackgroundResolutions();
    const active =
      (side === "up" || side === "down") &&
      (phase === "active" || phase === "pending") &&
      manipDetectorRuntime.predictionWindowStart != null &&
      Number.isFinite(manipDetectorRuntime.predictionWindowStart);

    if (!active && background.length === 0 && scored.length === 0) {
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
        uiPhase: active ? phase : "none",
        scoredWindowStarts: scored,
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
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const side = item.side === "up" || item.side === "down" ? item.side : null;
    const windowStart = Number.isFinite(item.windowStart) ? item.windowStart : null;
    if (!side || windowStart == null || isPredictionWindowScored(windowStart)) continue;
    if (manipDetectorRuntime.backgroundResolutions.some((j) => j.windowStart === windowStart)) {
      continue;
    }
    const job = {
      side,
      windowStart,
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
    manipDetectorRuntime.backgroundResolutions.push(job);
    scheduleBackgroundPredictionPoll(job, 400);
  }
}

function restorePredictionRuntime() {
  try {
    const raw = localStorage.getItem(predictionRuntimeStorageKey());
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    manipDetectorRuntime.scoredWindowStarts = normalizeScoredWindowStarts(
      parsed.scoredWindowStarts ?? parsed.scoredWindowStart,
    );
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

    if (!side || windowStart == null || phase === "none") {
      syncPredictionStatusUi();
      persistPredictionRuntime();
      return;
    }

    // Already scored this window — keep the score lock, drop stale UI.
    if (isPredictionWindowScored(windowStart)) {
      persistPredictionRuntime();
      syncPredictionStatusUi();
      return;
    }

    manipDetectorRuntime.predictionSide = side;
    manipDetectorRuntime.predictionWindowStart = windowStart;
    manipDetectorRuntime.predictionWindowEnd = windowEnd;
    manipDetectorRuntime.predictionSlug =
      typeof parsed.predictionSlug === "string" && parsed.predictionSlug.trim()
        ? parsed.predictionSlug.trim()
        : null;
    manipDetectorRuntime.lastPrice = Number.isFinite(parsed.lastPrice) ? parsed.lastPrice : null;
    manipDetectorRuntime.lastPtb = Number.isFinite(parsed.lastPtb) ? parsed.lastPtb : null;
    // Align detector window so the first tick does not wipe the restored prediction.
    manipDetectorRuntime.windowStart = windowStart;
    manipDetectorRuntime.uiPhase = phase;

    const nowMs = Date.now();
    const windowEndMs = windowEnd != null ? windowEnd * 1000 : null;

    if (phase === "active" && windowEndMs != null && nowMs >= windowEndMs) {
      beginPredictionPending();
      return;
    }

    syncPredictionStatusUi();
    if (phase === "active") {
      restorePredictionGraphBorder(side, windowEnd);
    } else if (phase === "pending") {
      stopPredictionResolveLoop();
      manipDetectorRuntime.resolveStartedAt =
        Number.isFinite(parsed.resolveStartedAt) && parsed.resolveStartedAt > 0
          ? parsed.resolveStartedAt
          : Date.now();
      manipDetectorRuntime.resolveTimer = setTimeout(() => {
        void pollPredictionOfficialOutcome();
      }, 400);
    }
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

function syncPredictionStatusUi() {
  const box = $("prediction-status-box");
  const label = $("prediction-status-label");
  const icon = $("prediction-status-icon");
  if (!box || !label || !icon) return;

  const side = manipDetectorRuntime.predictionSide;
  const phase = manipDetectorRuntime.uiPhase;
  box.classList.remove(
    "is-none",
    "is-up",
    "is-down",
    "is-pending",
    "is-right",
    "is-wrong",
    "is-result-only",
  );

  if (phase === "none" || ((side !== "up" && side !== "down") && phase !== "right" && phase !== "wrong")) {
    box.classList.add("is-none");
    label.hidden = false;
    label.innerHTML =
      'Detecting<span class="prediction-loading-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>';
    icon.hidden = true;
    icon.innerHTML = "";
    return;
  }

  const sideText = side === "up" ? "UP" : "DOWN";
  if (phase === "active") {
    box.classList.add(side === "up" ? "is-up" : "is-down");
    label.hidden = false;
    label.textContent = `Prediction ${sideText}`;
    icon.hidden = true;
    icon.innerHTML = "";
    return;
  }
  if (phase === "pending") {
    box.classList.add("is-pending");
    label.hidden = false;
    label.textContent = `Prediction ${sideText} · Pending`;
    icon.hidden = true;
    icon.innerHTML = "";
    return;
  }
  if (phase === "right" || phase === "wrong") {
    box.classList.add(phase === "right" ? "is-right" : "is-wrong", "is-result-only");
    label.hidden = true;
    label.textContent = "";
    icon.hidden = false;
    icon.innerHTML = phase === "right" ? PREDICTION_ICON_CHECK : PREDICTION_ICON_CROSS;
  }
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

function resolveWindowOutcomeFromPrices(closePrice, ptb) {
  if (!Number.isFinite(closePrice) || !Number.isFinite(ptb)) return null;
  return closePrice >= ptb ? "up" : "down";
}

function recordPredictionScore(side, windowStart, outcome, { showResultUi }) {
  if (side !== "up" && side !== "down") return false;
  if (windowStart == null || !Number.isFinite(windowStart)) return false;
  if (outcome !== "up" && outcome !== "down") return false;
  if (isPredictionWindowScored(windowStart)) return false;

  markPredictionWindowScored(windowStart);
  const right = side === outcome;
  if (right) manipDetectorRuntime.rightCount += 1;
  else manipDetectorRuntime.wrongCount += 1;
  syncPredictionStatsUi();
  void persistPredictionStats();
  appendLogEntry({
    level: "info",
    source: "client",
    message: `Prediction ${side.toUpperCase()} → ${outcome.toUpperCase()} (${right ? "right" : "wrong"})`,
  });

  if (showResultUi) {
    stopPredictionResultClearTimer();
    manipDetectorRuntime.uiPhase = right ? "right" : "wrong";
    syncPredictionStatusUi();
    manipDetectorRuntime.resultClearTimer = setTimeout(() => {
      manipDetectorRuntime.resultClearTimer = null;
      if (manipDetectorRuntime.uiPhase !== "right" && manipDetectorRuntime.uiPhase !== "wrong") {
        return;
      }
      // Only clear if this result is still the foreground window.
      if (manipDetectorRuntime.predictionWindowStart !== windowStart) return;
      manipDetectorRuntime.predictionSide = null;
      manipDetectorRuntime.predictionWindowStart = null;
      manipDetectorRuntime.predictionWindowEnd = null;
      manipDetectorRuntime.predictionSlug = null;
      manipDetectorRuntime.uiPhase = "none";
      syncPredictionStatusUi();
      persistPredictionRuntime();
    }, PREDICTION_RESULT_SHOW_MS);
  }

  persistPredictionRuntime();
  return true;
}

function applyPredictionOutcome(outcome) {
  const side = manipDetectorRuntime.predictionSide;
  const windowStart = manipDetectorRuntime.predictionWindowStart;
  if (manipDetectorRuntime.uiPhase !== "pending") return;
  stopPredictionResolveLoop();
  recordPredictionScore(side, windowStart, outcome, { showResultUi: true });
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

function scheduleBackgroundPredictionPoll(job, delayMs = PREDICTION_RESOLVE_INTERVAL_MS) {
  if (!job) return;
  if (job.timer != null) clearTimeout(job.timer);
  job.timer = setTimeout(() => {
    job.timer = null;
    void pollBackgroundPredictionOutcome(job);
  }, delayMs);
}

async function pollBackgroundPredictionOutcome(job) {
  if (!job) return;
  if (!manipDetectorRuntime.backgroundResolutions.includes(job)) return;
  if (isPredictionWindowScored(job.windowStart)) {
    removeBackgroundResolution(job.windowStart);
    persistPredictionRuntime();
    return;
  }

  const slug = job.slug;
  if (slug) {
    try {
      const res = await fetch(`/api/window-resolution?slug=${encodeURIComponent(slug)}`);
      if (res.ok) {
        const body = await res.json();
        if (body?.resolved && (body.outcome === "up" || body.outcome === "down")) {
          removeBackgroundResolution(job.windowStart);
          recordPredictionScore(job.side, job.windowStart, body.outcome, {
            showResultUi: false,
          });
          return;
        }
      }
    } catch {
      // keep polling / fall back
    }
  }

  const elapsed = Date.now() - (job.resolveStartedAt || Date.now());
  if (elapsed >= PREDICTION_RESOLVE_MAX_MS) {
    const fallback = resolveWindowOutcomeFromPrices(job.lastPrice, job.lastPtb);
    if (fallback) {
      removeBackgroundResolution(job.windowStart);
      recordPredictionScore(job.side, job.windowStart, fallback, { showResultUi: false });
      return;
    }
  }

  scheduleBackgroundPredictionPoll(job, PREDICTION_RESOLVE_INTERVAL_MS);
}

function enqueueBackgroundResolution({
  side,
  windowStart,
  slug,
  lastPrice,
  lastPtb,
  resolveStartedAt,
}) {
  if (side !== "up" && side !== "down") return false;
  if (windowStart == null || !Number.isFinite(windowStart)) return false;
  if (isPredictionWindowScored(windowStart)) return false;
  if (manipDetectorRuntime.backgroundResolutions.some((j) => j.windowStart === windowStart)) {
    return false;
  }
  const job = {
    side,
    windowStart,
    slug: typeof slug === "string" && slug.trim() ? slug.trim() : null,
    lastPrice: Number.isFinite(lastPrice) ? lastPrice : null,
    lastPtb: Number.isFinite(lastPtb) ? lastPtb : null,
    resolveStartedAt:
      Number.isFinite(resolveStartedAt) && resolveStartedAt > 0 ? resolveStartedAt : Date.now(),
    timer: null,
  };
  manipDetectorRuntime.backgroundResolutions.push(job);
  scheduleBackgroundPredictionPoll(job, 400);
  persistPredictionRuntime();
  return true;
}

/** Move UI pending prediction into background so a newer trigger can take the status box. */
function parkForegroundPendingToBackground() {
  if (manipDetectorRuntime.uiPhase !== "pending") return false;
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
    slug: manipDetectorRuntime.predictionSlug,
    lastPrice: manipDetectorRuntime.lastPrice,
    lastPtb: manipDetectorRuntime.lastPtb,
    resolveStartedAt: manipDetectorRuntime.resolveStartedAt || Date.now(),
  });

  manipDetectorRuntime.predictionSide = null;
  manipDetectorRuntime.predictionWindowStart = null;
  manipDetectorRuntime.predictionWindowEnd = null;
  manipDetectorRuntime.predictionSlug = null;
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
  manipDetectorRuntime.uiPhase = "none";
}

async function pollPredictionOfficialOutcome() {
  manipDetectorRuntime.resolveTimer = null;
  if (manipDetectorRuntime.uiPhase !== "pending") return;
  if (manipDetectorRuntime.predictionSide !== "up" && manipDetectorRuntime.predictionSide !== "down") {
    return;
  }

  const slug = manipDetectorRuntime.predictionSlug;
  if (slug) {
    try {
      const res = await fetch(`/api/window-resolution?slug=${encodeURIComponent(slug)}`);
      if (res.ok) {
        const body = await res.json();
        if (body?.resolved && (body.outcome === "up" || body.outcome === "down")) {
          applyPredictionOutcome(body.outcome);
          return;
        }
      }
    } catch {
      // keep polling / fall back
    }
  }

  const elapsed = Date.now() - manipDetectorRuntime.resolveStartedAt;
  if (elapsed >= PREDICTION_RESOLVE_MAX_MS) {
    const fallback = resolveWindowOutcomeFromPrices(
      manipDetectorRuntime.lastPrice,
      manipDetectorRuntime.lastPtb,
    );
    if (fallback) {
      applyPredictionOutcome(fallback);
      return;
    }
  }

  manipDetectorRuntime.resolveTimer = setTimeout(() => {
    void pollPredictionOfficialOutcome();
  }, PREDICTION_RESOLVE_INTERVAL_MS);
}

function beginPredictionPending() {
  if (manipDetectorRuntime.predictionSide !== "up" && manipDetectorRuntime.predictionSide !== "down") {
    return;
  }
  if (manipDetectorRuntime.uiPhase === "pending" || manipDetectorRuntime.uiPhase === "right" || manipDetectorRuntime.uiPhase === "wrong") {
    return;
  }
  if (isPredictionWindowScored(manipDetectorRuntime.predictionWindowStart)) {
    return;
  }
  manipDetectorRuntime.uiPhase = "pending";
  clearManipulationFlash();
  syncPredictionStatusUi();
  stopPredictionResolveLoop();
  manipDetectorRuntime.resolveStartedAt = Date.now();
  persistPredictionRuntime();
  manipDetectorRuntime.resolveTimer = setTimeout(() => {
    void pollPredictionOfficialOutcome();
  }, 400);
}

function clearPredictionForNewWindow() {
  if (manipDetectorRuntime.uiPhase === "pending") return;
  // Keep ✓/✕ visible for their timed window.
  if (manipDetectorRuntime.uiPhase === "right" || manipDetectorRuntime.uiPhase === "wrong") return;
  stopPredictionResolveLoop();
  manipDetectorRuntime.predictionSide = null;
  manipDetectorRuntime.predictionWindowStart = null;
  manipDetectorRuntime.predictionWindowEnd = null;
  manipDetectorRuntime.predictionSlug = null;
  manipDetectorRuntime.uiPhase = "none";
  syncPredictionStatusUi();
  persistPredictionRuntime();
}

function predictionHoldsWindow(windowStart) {
  if (windowStart == null || !Number.isFinite(windowStart)) return false;
  if (isPredictionWindowScored(windowStart)) return true;
  if (
    manipDetectorRuntime.predictionWindowStart === windowStart &&
    (manipDetectorRuntime.uiPhase === "active" || manipDetectorRuntime.uiPhase === "pending")
  ) {
    return true;
  }
  return manipDetectorRuntime.backgroundResolutions.some((job) => job.windowStart === windowStart);
}

function setActivePrediction(side, state) {
  if (side !== "up" && side !== "down") return false;
  const windowStart = state?.windowStart;
  if (windowStart == null || !Number.isFinite(windowStart)) return false;
  if (predictionHoldsWindow(windowStart)) return false;

  const phase = manipDetectorRuntime.uiPhase;
  if (phase === "pending") {
    parkForegroundPendingToBackground();
  } else if (phase === "right" || phase === "wrong") {
    clearForegroundPredictionUi();
  } else if (phase === "active" && manipDetectorRuntime.predictionWindowStart !== windowStart) {
    beginPredictionPending();
    parkForegroundPendingToBackground();
  } else if (manipDetectorRuntime.predictionSide != null) {
    return false;
  }

  manipDetectorRuntime.predictionSide = side;
  manipDetectorRuntime.predictionWindowStart = windowStart;
  manipDetectorRuntime.predictionWindowEnd =
    state?.windowEnd != null && Number.isFinite(state.windowEnd) ? state.windowEnd : null;
  manipDetectorRuntime.predictionSlug =
    typeof state?.slug === "string" && state.slug.trim() ? state.slug.trim() : null;
  manipDetectorRuntime.uiPhase = "active";
  syncPredictionStatusUi();
  persistPredictionRuntime();
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
  const maxQuoteInput = $("prediction-max-quote");
  const sensInput = $("manipulation-sensitivity");
  const startThumb = $("manipulation-area-start");
  const endThumb = $("manipulation-area-end");
  const on = Boolean(enabled);
  if (card) card.classList.toggle("is-disabled", !on);
  if (label) label.textContent = on ? "Prediction · On" : "Prediction · Off";
  if (maxQuoteInput) maxQuoteInput.disabled = !on;
  if (sensInput) sensInput.disabled = !on;
  if (startThumb) startThumb.disabled = !on;
  if (endThumb) endThumb.disabled = !on;
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
  manipDetectorRuntime.uiPhase = "none";
  manipDetectorRuntime.scoredWindowStarts = [];
  manipDetectorRuntime.lastPrice = null;
  manipDetectorRuntime.lastPtb = null;
  clearManipulationFlash();
  syncPredictionStatusUi();
}

function triggerManipulationFlash(state, predictionSide) {
  if (predictionSide !== "up" && predictionSide !== "down") return;

  const now = Date.now();
  const windowEndMs =
    state?.windowEnd != null && Number.isFinite(state.windowEnd)
      ? state.windowEnd * 1000
      : null;
  const duration = windowEndMs != null ? Math.max(0, windowEndMs - now) : null;
  if (duration != null && duration <= 0) return;

  if (!setActivePrediction(predictionSide, state)) return;
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

function tickManipulationDetector(state) {
  if (!state) return;
  // Settings sync everywhere; detection/scoring only on the deployed host.
  if (!isPredictionTriggerHost()) return;

  if (
    Number.isFinite(state.assetPrice) &&
    Number.isFinite(state.prevCloseAsset) &&
    (
      state.windowStart === manipDetectorRuntime.windowStart ||
      state.windowStart === manipDetectorRuntime.predictionWindowStart
    )
  ) {
    manipDetectorRuntime.lastPrice = state.assetPrice;
    manipDetectorRuntime.lastPtb = state.prevCloseAsset;
  }

  if (state.windowStart !== manipDetectorRuntime.windowStart) {
    const prevStart = manipDetectorRuntime.windowStart;
    if (
      prevStart != null &&
      manipDetectorRuntime.predictionWindowStart === prevStart &&
      manipDetectorRuntime.uiPhase === "active"
    ) {
      beginPredictionPending();
    } else if (manipDetectorRuntime.uiPhase !== "pending") {
      // Keep Pending until official outcome; otherwise reset for the new window.
      clearPredictionForNewWindow();
    }
    manipDetectorRuntime.windowStart = state.windowStart ?? null;
    manipDetectorRuntime.samples = [];
    if (
      manipDetectorRuntime.uiPhase !== "pending" &&
      Number.isFinite(state.assetPrice) &&
      Number.isFinite(state.prevCloseAsset)
    ) {
      manipDetectorRuntime.lastPrice = state.assetPrice;
      manipDetectorRuntime.lastPtb = state.prevCloseAsset;
    }
    clearManipulationFlash();
  }

  const nowMs = Date.now();
  if (state.windowEnd != null && Number.isFinite(state.windowEnd) && nowMs >= state.windowEnd * 1000) {
    if (
      manipDetectorRuntime.predictionWindowStart === state.windowStart &&
      manipDetectorRuntime.uiPhase === "active"
    ) {
      if (Number.isFinite(state.assetPrice)) manipDetectorRuntime.lastPrice = state.assetPrice;
      if (Number.isFinite(state.prevCloseAsset)) manipDetectorRuntime.lastPtb = state.prevCloseAsset;
      beginPredictionPending();
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
  const upBuy = Number(state.yesAsk);
  const downBuy = Number(state.noAsk);
  const upSell = Number(state.yesBid);
  const downSell = Number(state.noBid);
  if (!Number.isFinite(gap) || gap === 0 || !Number.isFinite(upBuy) || !Number.isFinite(downBuy)) {
    return;
  }
  // Skip detection when any Buy/Sell quote is at/above the configured Max Quote (¢).
  const maxQuotePrice =
    normalizePredictionMaxQuoteCents($("prediction-max-quote")?.value) / 100;
  if (
    upBuy >= maxQuotePrice ||
    downBuy >= maxQuotePrice ||
    (Number.isFinite(upSell) && upSell >= maxQuotePrice) ||
    (Number.isFinite(downSell) && downSell >= maxQuotePrice)
  ) {
    manipDetectorRuntime.samples = [];
    return;
  }

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

  if (baseline.gap > 0) {
    if (gap >= baseline.gap && upBuy < baseline.upBuy && downBuy > baseline.downBuy) {
      triggerManipulationFlash(state, "down");
    }
  } else if (baseline.gap < 0) {
    if (gap <= baseline.gap && upBuy > baseline.upBuy && downBuy < baseline.downBuy) {
      triggerManipulationFlash(state, "up");
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
  const maxQuoteInput = $("prediction-max-quote");
  const sensInput = $("manipulation-sensitivity");
  if (autoTradeInput) autoTradeInput.checked = Boolean(config.autoTrade);
  if (useScheduleInput) useScheduleInput.checked = Boolean(config.useSchedule);
  if (startTradingInput) startTradingInput.checked = Boolean(config.startTrading);
  if (buyTypeSelect) buyTypeSelect.value = normalizeManualOrderType(config.manualBuyOrderType);
  if (sellTypeSelect) sellTypeSelect.value = normalizeManualOrderType(config.manualSellOrderType);
  if (manipInput) manipInput.checked = Boolean(config.manipulationDetector);
  if (maxQuoteInput) {
    maxQuoteInput.value = String(
      normalizePredictionMaxQuoteCents(config.predictionMaxQuoteCents),
    );
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
  const sensInput = $("manipulation-sensitivity");
  if (!autoTradeInput || !useScheduleInput || !startTradingInput) return;

  // Restore immediately from localStorage, then sync from server
  applyTradingConfigToUi(readLocalTradingConfig());
  if (isPredictionTriggerHost()) restorePredictionRuntime();
  void loadTradingConfig().then((config) => {
    applyTradingConfigToUi(coalesceTradingConfig(config, readLocalTradingConfig()) ?? config);
    syncGraphSaveBtn(windowState);
    if (windowState) drawPriceChart(windowState);
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

  startTradingInput.addEventListener("change", async () => {
    // Allow trade only switches real vs demo — leave Auto Trade / Use Schedule alone.
    const patch = buildTradingConfigPatch();
    writeLocalTradingConfig(patch);
    const config = await pushTradingConfig(patch);
    applyTradingConfigToUi(coalesceTradingConfig(config, patch) ?? patch);
    if (windowState) drawPriceChart(windowState);
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
    await persistManipulationConfigPatch();
    appendLogEntry({
      level: "info",
      source: "client",
      message: manipInput.checked ? "Prediction enabled" : "Prediction disabled",
    });
  });

  maxQuoteInput?.addEventListener("change", async () => {
    if (maxQuoteInput.disabled) return;
    const next = normalizePredictionMaxQuoteCents(maxQuoteInput.value);
    maxQuoteInput.value = String(next);
    manipDetectorRuntime.samples = [];
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

  const showPage = (page, options = {}) => {
    let next = page;
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
    for (const btn of buttons) {
      btn.classList.toggle("is-active", btn.dataset.page === next);
    }
    if (settingsBtn) settingsBtn.classList.toggle("is-active", isSettings);

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
            leftColumnLayout.applyHeights(0, maxContent, 0);
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
      const page = btn.dataset.page;
      if (!page || btn.disabled || btn.classList.contains("is-active")) return;
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

async function init() {
  loadPositionsViewPref();
  demoPositionCards = loadDemoPositionCards();
  bindPositionsViewSelect();
  syncPositionsViewControls();
  initSimulatorBoxScrollbars();
  initChart();
  initColumnSplitter();
  initLeftRowSplitter();
  bindLeftColumnRail();
  bindMarketColumnRail();
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
  bindScheduleViewToggle();
  bindSetupSaveModal();
  bindModalKeyboardShortcuts();
  bindSetupListMenus();
  void loadHeatmap();
  await loadScheduleSetups();
  if (window.SchedulePlacements) void window.SchedulePlacements.loadPlacements();
  await loadMarkets();
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
