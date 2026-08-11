/** Schedule card Open Replay popup — lazy window list + scrubbable price replay + hits scatter. */
(function () {
  const BASE_PLAYBACK_SECONDS = 20;
  const UP_COLOR = "#3fb950";
  const DOWN_COLOR = "#f85149";
  /** Must match `buildChartLayout` padding in app.js */
  const CHART_PAD = { top: 10, right: 10, bottom: 22, left: 10 };
  const MARKER_HIT_PX = 10;
  const tickCache = new Map();
  /** Per-window book top-of-book samples for Open Replay quote boxes. */
  const bookQuoteCache = new Map();

  const PLAY_QUOTE_BOXES = [
    {
      boxId: "play-quote-up-buy-box",
      lockedId: "play-up-buy-locked",
      liveId: "play-up-buy",
      lockKey: "upBuy",
      side: "up",
      leg: "buy",
      tone: "up",
      liveKey: "yesAsk",
    },
    {
      boxId: "play-quote-up-sell-box",
      lockedId: "play-up-sell-locked",
      liveId: "play-up-sell",
      lockKey: "upSell",
      side: "up",
      leg: "sell",
      tone: "up",
      liveKey: "yesBid",
    },
    {
      boxId: "play-quote-down-buy-box",
      lockedId: "play-down-buy-locked",
      liveId: "play-down-buy",
      lockKey: "downBuy",
      side: "down",
      leg: "buy",
      tone: "down",
      liveKey: "noAsk",
    },
    {
      boxId: "play-quote-down-sell-box",
      lockedId: "play-down-sell-locked",
      liveId: "play-down-sell",
      lockKey: "downSell",
      side: "down",
      leg: "sell",
      tone: "down",
      liveKey: "noBid",
    },
  ];

  let modal = null;
  let canvas = null;
  let chartWrap = null;
  let tooltipEl = null;
  let listEl = null;
  let listTrackEl = null;
  let listUpBtn = null;
  let listDownBtn = null;
  let statusEl = null;
  let metaEl = null;
  let scrubber = null;
  let playBtn = null;
  let speedSelect = null;
  let transportEl = null;
  let transportPlayPanel = null;
  let transportHitsPanel = null;
  let outcomeValueEl = null;
  let hitsStatsDotsEl = null;
  let hitsPnlEl = null;
  let hitsMarkersEl = null;
  let viewPlayBtn = null;
  let viewHitsBtn = null;
  let resizeObserver = null;

  let payload = null;
  /** True when this Open session is Live Schedule hour review (trade windows + ledger). */
  let liveMode = false;
  /** Series used for this Open session (markers / ticks). */
  let playSeries = "btc-5m";
  /** Fallback Prediction Duration (sec) from Open request when window payload lacks it. */
  let playPredictionSensitivitySec = null;
  let selectedIndex = -1;
  let priceHistory = [];
  let playheadSec = 0;
  let playing = false;
  /** When true, reaching the end of a window advances to the next and keeps playing. */
  let autoPlayWindows = false;
  let rafId = null;
  let lastFrameMs = 0;
  let loadToken = 0;
  let scrubbing = false;
  /** While scrubbing, follow the pointer within the chart container. */
  let scrubVisualX = null;
  /** Vertical position of the scrubber handle along the playhead bar (0 = top, 1 = bottom). */
  let scrubberHandleFrac = 0.5;
  /** True while the play payload (window list) is fetching. */
  let windowsLoading = false;
  /** True while chainlink ticks for the selected window are fetching. */
  let ticksLoading = false;
  let headerProgressEl = null;
  let headerProgressBarEl = null;
  let headerLoadProgress = 0;
  let headerLoadRaf = null;
  let headerLoadStartedAt = 0;
  let headerLoadCompleteTimer = null;
  let headerLoadFinishing = false;
  /** @type {"play" | "hits"} */
  let viewMode = "play";
  /** Pinned outcome buckets from clicks on hits stats dots. */
  let hitsHighlightPinned = new Set();
  /** Transient hover bucket from hits stats dots (`null` = none). */
  let hitsHighlightHover = null;
  /** Map-dot id currently hovered on the hits scatter (`null` = none). */
  let hoveredMapDotId = null;
  /** @type {Array<{ x: number, y: number, html: string, id?: string, bucket?: string }>} */
  let hoverTargets = [];
  let hoveredTarget = null;
  const LIST_ITEM_H = 52;
  const LIST_ITEM_GAP = 4;
  const LIST_ITEM_STRIDE = LIST_ITEM_H + LIST_ITEM_GAP;
  let listAnimating = false;
  let playChartLayout = null;
  let phaseHoverEl = null;
  /** Slot-machine scroll while windows are loading. */
  let slotSpinning = false;
  let slotSpinRafId = null;
  let slotSpinStartMs = 0;
  let slotSpinLoopH = 0;
  /** offsetTop of the middle copy — spin stays anchored here so the viewport is always filled. */
  let slotSpinAnchorTop = 0;
  const SLOT_SPIN_PX_PER_SEC = 220;
  const SLOT_SPIN_COPIES = 5;
  const PHASE_HOVER_COLOR = "rgba(88, 166, 255, 0.16)";
  const PHASE_LINE_HIT_PX = 6;

  function $(id) {
    return document.getElementById(id);
  }

  function formatClock(totalSec) {
    const s = Math.max(0, Math.floor(totalSec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  function formatUtcTime(windowStart) {
    const d = new Date(windowStart * 1000);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    });
  }

  function formatPnl(pnl) {
    if (pnl == null || !Number.isFinite(pnl)) return "—";
    const sign = pnl > 0 ? "+" : pnl < 0 ? "-" : "";
    const abs = Math.abs(pnl).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${sign}$${abs}`;
  }

  function formatPrice(price) {
    if (price == null || !Number.isFinite(price)) return "—";
    return price >= 1000 ? price.toFixed(2) : price.toFixed(4);
  }

  function fmtUsd(amount) {
    if (amount == null || !Number.isFinite(amount)) return "—";
    const sign = amount < 0 ? "-" : "";
    const abs = Math.abs(amount).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${sign}$${abs}`;
  }

  function fmtPriceCents(price) {
    if (price == null || !Number.isFinite(price)) return "—";
    const cents = price * 100;
    return Number.isInteger(cents) ? `${cents}¢` : `${cents.toFixed(1)}¢`;
  }

  function tooltipRow(label, value) {
    return `<div class="sim-marker-tooltip-row"><span class="sim-marker-tooltip-label">${label}</span><span class="sim-marker-tooltip-value">${value}</span></div>`;
  }

  function markerTotal(marker) {
    if (marker.total != null && Number.isFinite(marker.total)) return marker.total;
    if (marker.type === "buy") return (marker.cost ?? 0) + (marker.fees ?? 0);
    return marker.proceeds ?? 0;
  }

  function renderHitTooltipHtml(marker, extras = {}) {
    const sideLabel = marker.side === "up" ? "UP" : "DOWN";
    const rows = [];
    if (extras.windowLabel) rows.push(tooltipRow("Window", extras.windowLabel));
    if (extras.elapsedLabel) rows.push(tooltipRow("Time", extras.elapsedLabel));
    if (extras.assetLabel) rows.push(tooltipRow("Asset", extras.assetLabel));
    if (extras.resultLabel) rows.push(tooltipRow("Result", extras.resultLabel));

    if (marker.type === "buy") {
      return [
        `<div class="sim-marker-tooltip-title">Buy ${sideLabel}</div>`,
        ...rows,
        tooltipRow("Shares", marker.shares != null ? String(marker.shares) : "—"),
        tooltipRow("Price", fmtPriceCents(marker.price)),
        marker.cost != null ? tooltipRow("Cost", fmtUsd(marker.cost)) : "",
        marker.fees != null ? tooltipRow("Fees", fmtUsd(marker.fees)) : "",
        tooltipRow("Total", fmtUsd(markerTotal(marker))),
      ].join("");
    }
    const exitTitle = marker.heldSettlement ? `Settlement ${sideLabel}` : `Sell ${sideLabel}`;
    return [
      `<div class="sim-marker-tooltip-title">${exitTitle}</div>`,
      ...rows,
      tooltipRow("Shares", marker.shares != null ? String(marker.shares) : "—"),
      tooltipRow("Price", fmtPriceCents(marker.price)),
      marker.proceeds != null ? tooltipRow("Proceeds", fmtUsd(marker.proceeds)) : "",
      marker.fees != null && marker.fees > 0 ? tooltipRow("Fees", fmtUsd(marker.fees)) : "",
      marker.profit != null ? tooltipRow("Profit", fmtUsd(marker.profit)) : "",
    ].join("");
  }

  /** Compact tooltip for hits/target map: buy/sell/settlement + up/down only. */
  function renderHitsMapTooltipHtml(marker) {
    const action =
      marker.type === "sell" ? (marker.heldSettlement ? "Settlement" : "Sell") : "Buy";
    const side = marker.side === "up" ? "UP" : "DOWN";
    return `<div class="sim-marker-tooltip-title">${action} ${side}</div>`;
  }

  function hidePhaseHover() {
    if (phaseHoverEl) phaseHoverEl.hidden = true;
  }

  /** Phase chrome only when the payload still has buy-enabled phases. */
  function playSetup() {
    if (payload?.triggerOnly === true) return null;
    const setup = payload?.setup ?? null;
    if (!setup?.phases?.length) return null;
    const anyBuy = setup.phases.some((p) => p?.buyEnabled !== false);
    return anyBuy ? setup : null;
  }

  function xToFrac(x, layout) {
    if (!layout?.plotW) return 0;
    return Math.min(1, Math.max(0, (x - layout.padding.left) / layout.plotW));
  }

  function fracToX(frac, layout) {
    return layout.padding.left + frac * layout.plotW;
  }

  function phaseIndexForFrac(frac, setup) {
    if (!setup?.phaseSplit) return 0;
    if (frac < setup.phaseSplit[0]) return 0;
    if (frac < setup.phaseSplit[1]) return 1;
    return 2;
  }

  function nearPhaseLine(x, layout, setup) {
    if (!layout || !setup?.phaseSplit) return false;
    for (const split of setup.phaseSplit) {
      if (Math.abs(x - fracToX(split, layout)) <= PHASE_LINE_HIT_PX) return true;
    }
    return false;
  }

  function updatePhaseHover(canvasX) {
    const setup = playSetup();
    const layout = playChartLayout;
    if (!phaseHoverEl || !layout || !setup || (viewMode !== "play" && viewMode !== "hits")) {
      hidePhaseHover();
      return;
    }
    if (canvasX == null || !Number.isFinite(canvasX)) {
      hidePhaseHover();
      return;
    }
    if (nearPhaseLine(canvasX, layout, setup)) {
      hidePhaseHover();
      return;
    }
    const frac = xToFrac(canvasX, layout);
    const phaseIdx = phaseIndexForFrac(frac, setup);
    const bounds = [0, setup.phaseSplit[0], setup.phaseSplit[1], 1];
    const x0 = fracToX(bounds[phaseIdx], layout);
    const x1 = fracToX(bounds[phaseIdx + 1], layout);
    phaseHoverEl.style.left = `${x0}px`;
    phaseHoverEl.style.top = `${layout.padding.top}px`;
    phaseHoverEl.style.width = `${Math.max(0, x1 - x0)}px`;
    phaseHoverEl.style.height = `${layout.plotH}px`;
    phaseHoverEl.style.background = PHASE_HOVER_COLOR;
    phaseHoverEl.hidden = false;
  }

  function openPhaseAtCanvasX(canvasX) {
    const setup = playSetup();
    const layout = playChartLayout;
    if (!setup || !layout || (viewMode !== "play" && viewMode !== "hits")) return;
    if (nearPhaseLine(canvasX, layout, setup)) return;
    const idx = phaseIndexForFrac(xToFrac(canvasX, layout), setup);
    if (!window.Simulator?.beginExternalPhaseEdit || !window.Simulator?.openPhaseModalExternal) {
      return;
    }
    stopPlayback();
    window.Simulator.beginExternalPhaseEdit(setup, null, { readOnly: true });
    window.Simulator.openPhaseModalExternal(idx);
  }

  function hideHitTooltip() {
    const hadMapHover = hoveredMapDotId != null;
    hoveredTarget = null;
    hoveredMapDotId = null;
    if (tooltipEl) tooltipEl.hidden = true;
    if (canvas) canvas.style.cursor = "";
    if (hadMapHover) {
      if (viewMode === "hits") drawHitsView();
      else if (viewMode === "play") drawPlayView();
    }
  }

  function showHitTooltip(target, clientX, clientY) {
    if (!tooltipEl || !chartWrap || !target) return;
    tooltipEl.innerHTML = target.html;
    tooltipEl.hidden = false;
    const wrapRect = chartWrap.getBoundingClientRect();
    const tipRect = tooltipEl.getBoundingClientRect();
    let left = clientX - wrapRect.left + 12;
    let top = clientY - wrapRect.top - tipRect.height - 12;
    if (left + tipRect.width > wrapRect.width - 4) {
      left = clientX - wrapRect.left - tipRect.width - 12;
    }
    if (top < 4) top = clientY - wrapRect.top + 12;
    if (left < 4) left = 4;
    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
    if (canvas) canvas.style.cursor = "pointer";
  }

  function hitTargetAt(canvasX, canvasY) {
    for (let i = hoverTargets.length - 1; i >= 0; i -= 1) {
      const t = hoverTargets[i];
      if (Math.hypot(canvasX - t.x, canvasY - t.y) <= MARKER_HIT_PX) return t;
    }
    return null;
  }

  function updateHitHover(clientX, clientY) {
    if (!canvas || scrubbing) {
      hideHitTooltip();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const target = hitTargetAt(x, y);
    if (!target) {
      hideHitTooltip();
      return;
    }
    const nextId = target.id ?? null;
    const idChanged = hoveredMapDotId !== nextId;
    hoveredMapDotId = nextId;
    hoveredTarget = target;
    if (idChanged) {
      if (viewMode === "hits") drawHitsView();
      else if (viewMode === "play") drawPlayView();
    }
    showHitTooltip(target, clientX, clientY);
  }

  function selectedWindow() {
    if (!payload?.windows?.length || selectedIndex < 0) return null;
    return payload.windows[selectedIndex] ?? null;
  }

  function windowDuration(win) {
    if (!win) return 300;
    return Math.max(1, (win.windowEnd || win.windowStart + 300) - win.windowStart);
  }

  function playbackRate(win) {
    const speed = Number(speedSelect?.value) || 1;
    const duration = windowDuration(win);
    return (duration / BASE_PLAYBACK_SECONDS) * speed;
  }

  function sideColor(side) {
    return side === "up" ? UP_COLOR : DOWN_COLOR;
  }

  function currentSeries() {
    return playSeries || window.getSelectedSeries?.() || "btc-5m";
  }

  function ensureEls() {
    modal = $("schedule-play-modal");
    canvas = $("schedule-play-chart");
    chartWrap = $("schedule-play-chart-wrap");
    tooltipEl = $("schedule-play-hit-tooltip");
    listEl = $("schedule-play-list");
    listTrackEl = $("schedule-play-list-track");
    listUpBtn = $("schedule-play-list-up");
    listDownBtn = $("schedule-play-list-down");
    statusEl = $("schedule-play-status");
    metaEl = $("schedule-play-meta");
    scrubber = $("schedule-play-scrubber");
    playBtn = $("schedule-play-toggle");
    speedSelect = $("schedule-play-speed");
    transportEl = $("schedule-play-transport");
    transportPlayPanel = $("schedule-play-transport-play");
    transportHitsPanel = $("schedule-play-transport-hits");
    outcomeValueEl = $("schedule-play-outcome-value");
    hitsStatsDotsEl = $("schedule-play-hits-stats")?.querySelector(".schedule-play-hits-stats-dots");
    hitsPnlEl = $("schedule-play-hits-pnl");
    hitsMarkersEl = $("schedule-play-hits-markers");
    viewPlayBtn = $("schedule-play-view-play");
    viewHitsBtn = $("schedule-play-view-hits");
    phaseHoverEl = $("schedule-play-phase-hover");
    headerProgressEl = $("schedule-play-header-progress");
    headerProgressBarEl = headerProgressEl?.querySelector(".schedule-play-header-progress-bar") ?? null;
  }

  function fmtPlayPrice(v) {
    if (v == null || !Number.isFinite(v)) return "—";
    if (v >= 1000) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    return `$${v.toFixed(2)}`;
  }

  function fmtPlayGap(value) {
    if (value == null || !Number.isFinite(value)) return "—";
    const sign = value >= 0 ? "+" : "-";
    return sign + fmtPlayPrice(Math.abs(value));
  }

  function setPlaySignedValue(el, text, sign) {
    if (!el) return;
    el.textContent = text;
    el.className = "sim-value";
    if (sign > 0) el.classList.add("gap-positive");
    else if (sign < 0) el.classList.add("gap-negative");
  }

  function clearMetricsPanel() {
    for (const id of ["play-graph-ptb", "play-graph-current", "play-graph-gap"]) {
      const el = $(id);
      if (!el) continue;
      el.textContent = "—";
      el.className = "sim-value";
    }
    clearPlayQuoteBoxes();
  }

  function fmtPlayQuote(v) {
    if (v == null || !Number.isFinite(v)) return "—";
    return (v * 100).toFixed(1) + "¢";
  }

  function bestBookPrice(levels) {
    if (!Array.isArray(levels) || levels.length === 0) return null;
    const p = Number(levels[0]?.price);
    return Number.isFinite(p) ? p : null;
  }

  /** Fill prices at/before playhead per box, oldest → newest. */
  function quoteLockListsAtPlayhead(win) {
    const locks = { upBuy: [], upSell: [], downBuy: [], downSell: [] };
    const markers = Array.isArray(win?.markers) ? win.markers : [];
    const hits = markers
      .filter(
        (m) =>
          m &&
          (m.type === "buy" || m.type === "sell") &&
          (m.side === "up" || m.side === "down") &&
          Number.isFinite(m.t) &&
          m.t <= playheadSec &&
          Number.isFinite(m.price),
      )
      .slice()
      .sort((a, b) => a.t - b.t);
    for (const m of hits) {
      const lockKey =
        m.side === "up"
          ? m.type === "buy"
            ? "upBuy"
            : "upSell"
          : m.type === "buy"
            ? "downBuy"
            : "downSell";
      locks[lockKey].push(m.price);
    }
    return locks;
  }

  /** Pad Buy/Sell lists to same length so scroll slots stay aligned. */
  function alignPlayQuoteLockPair(buyOldestFirst, sellOldestFirst) {
    const buys = Array.isArray(buyOldestFirst) ? buyOldestFirst : [];
    const sells = Array.isArray(sellOldestFirst) ? sellOldestFirst : [];
    const n = Math.max(buys.length, sells.length);
    const buy = [];
    const sell = [];
    for (let i = 0; i < n; i += 1) {
      buy.push(i < buys.length ? buys[i] : null);
      sell.push(i < sells.length ? sells[i] : null);
    }
    return { buy, sell };
  }

  function playQuoteLockSlotsSignature(slotsOldestFirst) {
    return (slotsOldestFirst || [])
      .map((v) => (v == null || !Number.isFinite(Number(v)) ? "_" : String(Number(v))))
      .join("|");
  }

  /** Newest locked ¢ on the left → older (null = spacer). Live market ¢ stays outside. */
  function setPlayLockedPrices(values, lockedAnchor, slotsOldestFirst) {
    if (!values || !lockedAnchor) return;
    const slots = Array.isArray(slotsOldestFirst) ? slotsOldestFirst : [];
    const sig = playQuoteLockSlotsSignature(slots);
    const prevSig = values.dataset.quoteLockSig || "";
    const changed = sig !== prevSig;

    for (const el of [...values.querySelectorAll(".quote-locked")]) {
      if (el !== lockedAnchor) el.remove();
    }
    if (!slots.length) {
      lockedAnchor.hidden = true;
      lockedAnchor.textContent = "";
      lockedAnchor.classList.remove("quote-locked-spacer");
      values.classList.remove("quote-has-locked");
      values.dataset.quoteLockSig = "";
      if (changed) values.scrollLeft = 0;
      return;
    }

    values.classList.add("quote-has-locked");
    values.dataset.quoteLockSig = sig;
    const newestFirst = slots.slice().reverse();
    const applySlot = (el, price) => {
      const isSpacer = price == null || !Number.isFinite(Number(price));
      el.hidden = false;
      el.classList.toggle("quote-locked-spacer", isSpacer);
      el.textContent = isSpacer ? "" : fmtPlayQuote(price);
      if (isSpacer) el.setAttribute("aria-hidden", "true");
      else el.removeAttribute("aria-hidden");
    };
    applySlot(lockedAnchor, newestFirst[0]);
    let prev = lockedAnchor;
    for (let i = 1; i < newestFirst.length; i += 1) {
      const span = document.createElement("span");
      span.className = "quote-locked";
      applySlot(span, newestFirst[i]);
      prev.after(span);
      prev = span;
    }
    if (changed) {
      const snapLeft = () => {
        values.scrollLeft = 0;
      };
      snapLeft();
      requestAnimationFrame(snapLeft);
    }
  }

  const PLAY_QUOTE_LOCK_SCROLL_PAIRS = [
    ["play-up-buy-locked", "play-up-sell-locked"],
    ["play-down-buy-locked", "play-down-sell-locked"],
  ];
  let playQuoteLockScrollSyncing = false;
  let playQuoteLockScrollPairsBound = false;

  function bindPlayQuoteLockScrollPairs() {
    if (playQuoteLockScrollPairsBound) return;
    const pairs = [];
    for (const [aId, bId] of PLAY_QUOTE_LOCK_SCROLL_PAIRS) {
      const aLocked = $(aId);
      const bLocked = $(bId);
      const a = aLocked?.closest(".quote-values") || aLocked?.parentElement;
      const b = bLocked?.closest(".quote-values") || bLocked?.parentElement;
      if (!a || !b) return;
      pairs.push([a, b]);
    }
    playQuoteLockScrollPairsBound = true;
    for (const [a, b] of pairs) {
      const sync = (from, to) => {
        from.addEventListener(
          "scroll",
          () => {
            if (playQuoteLockScrollSyncing) return;
            playQuoteLockScrollSyncing = true;
            to.scrollLeft = from.scrollLeft;
            playQuoteLockScrollSyncing = false;
          },
          { passive: true },
        );
      };
      sync(a, b);
      sync(b, a);
    }
  }

  function bookQuoteAtPlayhead(samples) {
    if (!Array.isArray(samples) || samples.length === 0) return null;
    let best = null;
    for (const sample of samples) {
      if (!sample || !Number.isFinite(sample.t)) continue;
      if (sample.t > playheadSec) break;
      best = sample;
    }
    return best;
  }

  function clearPlayQuoteBoxes() {
    for (const cfg of PLAY_QUOTE_BOXES) {
      const box = $(cfg.boxId);
      const locked = $(cfg.lockedId);
      const live = $(cfg.liveId);
      const values = locked?.closest(".quote-values") || locked?.parentElement;
      if (live) live.textContent = "—";
      if (values && locked) setPlayLockedPrices(values, locked, []);
      else if (locked) {
        locked.hidden = true;
        locked.textContent = "";
      }
      box?.classList.remove(
        "quote-triggered-up",
        "quote-triggered-down",
        "quote-box-latched",
        "quote-box-pressing",
      );
    }
  }

  function updatePlayQuoteBoxes(win) {
    if (viewMode === "hits" || !win) {
      clearPlayQuoteBoxes();
      return;
    }
    const samples = bookQuoteCache.get(win.windowStart) || [];
    const liveSample = bookQuoteAtPlayhead(samples);
    const locks = quoteLockListsAtPlayhead(win);
    const upPair = alignPlayQuoteLockPair(locks.upBuy, locks.upSell);
    const downPair = alignPlayQuoteLockPair(locks.downBuy, locks.downSell);
    const aligned = {
      upBuy: upPair.buy,
      upSell: upPair.sell,
      downBuy: downPair.buy,
      downSell: downPair.sell,
    };
    bindPlayQuoteLockScrollPairs();
    for (const cfg of PLAY_QUOTE_BOXES) {
      const box = $(cfg.boxId);
      const locked = $(cfg.lockedId);
      const live = $(cfg.liveId);
      const values = locked?.closest(".quote-values") || locked?.parentElement;
      if (!box || !locked || !live || !values) continue;

      live.textContent = fmtPlayQuote(liveSample?.[cfg.liveKey]);

      const slots = aligned[cfg.lockKey] || [];
      setPlayLockedPrices(values, locked, slots);
      const hasRealLock = slots.some((p) => p != null && Number.isFinite(Number(p)));
      if (hasRealLock) {
        box.classList.add(cfg.tone === "up" ? "quote-triggered-up" : "quote-triggered-down");
        box.classList.add("quote-box-latched");
        box.classList.remove("quote-box-pressing");
      } else {
        box.classList.remove("quote-triggered-up", "quote-triggered-down", "quote-box-latched");
      }
    }
  }

  function updateMetricsPanel() {
    if (viewMode === "hits") return;
    const win = selectedWindow();
    if (!win || priceHistory.length === 0) {
      clearMetricsPanel();
      // Still show latched hit prices if markers exist while ticks load.
      if (win) updatePlayQuoteBoxes(win);
      return;
    }
    const until = playheadSec;
    const visible = priceHistory.filter((p) => p.t <= until);
    const last = visible[visible.length - 1];
    const ptb = win.prevCloseAsset;
    const current = last?.price;
    const gap =
      current != null && Number.isFinite(current) && ptb != null && Number.isFinite(ptb)
        ? current - ptb
        : null;

    const ptbEl = $("play-graph-ptb");
    const curEl = $("play-graph-current");
    const gapEl = $("play-graph-gap");
    if (ptbEl) ptbEl.textContent = fmtPlayPrice(ptb);
    if (curEl) curEl.textContent = fmtPlayPrice(current);
    if (gap != null && Number.isFinite(gap)) {
      setPlaySignedValue(gapEl, fmtPlayGap(gap), gap);
    } else if (gapEl) {
      gapEl.textContent = "—";
      gapEl.className = "sim-value";
    }
    updatePlayQuoteBoxes(win);
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || "";
  }

  function syncPlayButton() {
    if (!playBtn) return;
    const held = playing || autoPlayWindows;
    playBtn.textContent = held ? "Pause" : "Play";
    playBtn.setAttribute("aria-pressed", held ? "true" : "false");
  }

  function setPlaying(next) {
    playing = Boolean(next);
    syncPlayButton();
    if (!playing) {
      if (rafId != null) cancelAnimationFrame(rafId);
      rafId = null;
      lastFrameMs = 0;
    }
    syncHeaderProgress();
  }

  function stopPlayback(options = {}) {
    if (!options.keepAutoPlay) autoPlayWindows = false;
    setPlaying(false);
  }

  function stopHeaderLoadProgress() {
    if (headerLoadRaf != null) {
      cancelAnimationFrame(headerLoadRaf);
      headerLoadRaf = null;
    }
  }

  function clearHeaderLoadCompleteTimer() {
    if (headerLoadCompleteTimer != null) {
      clearTimeout(headerLoadCompleteTimer);
      headerLoadCompleteTimer = null;
    }
  }

  function hideHeaderProgress() {
    stopHeaderLoadProgress();
    clearHeaderLoadCompleteTimer();
    headerLoadProgress = 0;
    headerLoadFinishing = false;
    if (!headerProgressEl || !headerProgressBarEl) return;
    headerProgressBarEl.style.width = "0%";
    headerProgressEl.hidden = true;
    headerProgressEl.setAttribute("aria-hidden", "true");
    headerProgressEl.classList.remove("is-indeterminate");
  }

  function tickHeaderLoadProgress(now) {
    if (!(windowsLoading || ticksLoading || slotSpinning)) {
      headerLoadRaf = null;
      return;
    }
    const elapsed = now - headerLoadStartedAt;
    // Ease toward ~92% while waiting; finish to 100% when loading ends.
    const eased = 0.92 * (1 - Math.exp(-elapsed / 2200));
    headerLoadProgress = Math.max(headerLoadProgress, eased);
    if (headerProgressBarEl) {
      headerProgressBarEl.style.width = `${headerLoadProgress * 100}%`;
    }
    headerLoadRaf = requestAnimationFrame(tickHeaderLoadProgress);
  }

  function startHeaderLoadProgress() {
    clearHeaderLoadCompleteTimer();
    stopHeaderLoadProgress();
    headerLoadFinishing = false;
    headerLoadProgress = 0;
    headerLoadStartedAt = performance.now();
    if (headerProgressEl && headerProgressBarEl) {
      headerProgressEl.hidden = false;
      headerProgressEl.classList.remove("is-indeterminate");
      headerProgressEl.setAttribute("aria-hidden", "false");
      headerProgressBarEl.style.width = "0%";
    }
    headerLoadRaf = requestAnimationFrame(tickHeaderLoadProgress);
  }

  function finishHeaderLoadProgress() {
    if (headerLoadFinishing) return;
    stopHeaderLoadProgress();
    clearHeaderLoadCompleteTimer();
    headerLoadFinishing = true;
    headerLoadProgress = 0;
    if (!headerProgressEl || !headerProgressBarEl) {
      headerLoadFinishing = false;
      return;
    }
    headerProgressEl.hidden = false;
    headerProgressEl.classList.remove("is-indeterminate");
    headerProgressEl.setAttribute("aria-hidden", "false");
    headerProgressBarEl.style.width = "100%";
    headerLoadCompleteTimer = setTimeout(() => {
      headerLoadCompleteTimer = null;
      hideHeaderProgress();
    }, 180);
  }

  function syncHeaderProgress() {
    if (!headerProgressEl || !headerProgressBarEl) return;
    const loading = windowsLoading || ticksLoading || slotSpinning;
    if (loading) {
      if (headerLoadRaf == null && !headerLoadFinishing) {
        startHeaderLoadProgress();
      }
      headerProgressEl.hidden = false;
      headerProgressEl.classList.remove("is-indeterminate");
      headerProgressEl.setAttribute("aria-hidden", "false");
      if (!headerLoadFinishing) {
        headerProgressBarEl.style.width = `${Math.min(0.92, headerLoadProgress) * 100}%`;
      }
      return;
    }
    if (headerLoadFinishing) return;
    if (headerLoadRaf != null || headerLoadProgress > 0) {
      finishHeaderLoadProgress();
      return;
    }
    hideHeaderProgress();
  }

  function resizeCanvas() {
    if (!canvas) return { ctx: null, width: 0, height: 0 };
    const wrap = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const width = wrap?.clientWidth ?? canvas.clientWidth;
    const height = wrap?.clientHeight ?? canvas.clientHeight;
    const nextW = Math.max(1, Math.floor(width * dpr));
    const nextH = Math.max(1, Math.floor(height * dpr));
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

  function windowTradeDots(win) {
    if (Array.isArray(win?.tradeDots) && win.tradeDots.length > 0) {
      return win.tradeDots
        .map((d) => (typeof d === "string" ? d : d?.bucket))
        .filter((b) => b === "green" || b === "red" || b === "blue");
    }
    if (win?.bucket === "green" || win?.bucket === "red" || win?.bucket === "blue") {
      return [win.bucket];
    }
    return [];
  }

  function tradeBucketForMarker(win, marker) {
    const dots = Array.isArray(win?.tradeDots) ? win.tradeDots : [];
    for (const d of dots) {
      if (!d || typeof d === "string") continue;
      if (marker?.type === "buy" && Number.isFinite(d.buyT) && Math.abs(d.buyT - marker.t) < 1e-6) {
        return d.bucket;
      }
      if (
        marker?.type === "sell" &&
        d.sellT != null &&
        Number.isFinite(d.sellT) &&
        Math.abs(d.sellT - marker.t) < 1e-6
      ) {
        return d.bucket;
      }
    }
    const list = windowTradeDots(win);
    return list[0] || win?.bucket || "none";
  }

  function cardTotalsFromPayload() {
    let green = 0;
    let red = 0;
    let blue = 0;
    let pnl = 0;
    for (const win of payload?.windows || []) {
      for (const bucket of windowTradeDots(win)) {
        if (bucket === "green") green += 1;
        else if (bucket === "red") red += 1;
        else if (bucket === "blue") blue += 1;
      }
      pnl += win.pnl ?? 0;
    }
    return {
      green,
      red,
      blue,
      pnl,
      windows: payload?.windows?.length || 0,
      hasData: (payload?.windows?.length || 0) > 0,
    };
  }

  function bucketColor(bucket) {
    if (bucket === "green") return UP_COLOR;
    if (bucket === "red") return DOWN_COLOR;
    if (bucket === "blue") return "#58a6ff";
    return "#6e7681";
  }

  function hitDotId(d) {
    return `${d.windowIndex}:${d.type}:${d.elapsed}:${d.y}`;
  }

  function markerTradeSource(m) {
    if (m?.source === "prediction" || m?.source === "phase" || m?.source === "trigger") {
      return m.source;
    }
    const key = String(m?.windowKey || "");
    if (key.startsWith("pred:")) return "prediction";
    if (key.startsWith("trigger:")) return "trigger";
    return "phase";
  }

  /**
   * Pair buy→sell within the same window/source/side (chronological).
   * Sets `pairDotId` on both ends when a sell matches an open buy.
   */
  function assignBuySellPairIds(dots, idFn) {
    const groups = new Map();
    for (const d of dots) {
      if (!d || (d.type !== "buy" && d.type !== "sell")) continue;
      if (!(d.side === "up" || d.side === "down")) continue;
      const key = `${d.windowIndex ?? d.windowStart ?? ""}:${markerTradeSource(d)}:${d.side}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => {
        const ta = Number.isFinite(a.elapsed) ? a.elapsed : a.t;
        const tb = Number.isFinite(b.elapsed) ? b.elapsed : b.t;
        return (ta ?? 0) - (tb ?? 0) || (a.type === "buy" ? -1 : 1);
      });
      let openBuy = null;
      for (const d of list) {
        d.pairDotId = null;
        if (d.type === "buy") {
          openBuy = d;
          continue;
        }
        if (d.type === "sell" && openBuy) {
          const buyId = idFn(openBuy);
          const sellId = idFn(d);
          openBuy.pairDotId = sellId;
          d.pairDotId = buyId;
          openBuy = null;
        }
      }
    }
  }

  function mapHoverHighlightIds(dots, idFn) {
    const ids = new Set();
    if (hoveredMapDotId == null) return ids;
    ids.add(hoveredMapDotId);
    const hovered = dots.find((d) => idFn(d) === hoveredMapDotId);
    if (hovered?.pairDotId) ids.add(hovered.pairDotId);
    return ids;
  }

  function activeHitsHighlightBuckets() {
    const set = new Set(hitsHighlightPinned);
    if (hitsHighlightHover) set.add(hitsHighlightHover);
    return set;
  }

  function setHitsHighlightHover(bucket) {
    if (hitsHighlightHover === bucket) return;
    hitsHighlightHover = bucket;
    if (viewMode === "hits") drawHitsView();
  }

  function toggleHitsHighlightPinned(bucket) {
    if (hitsHighlightPinned.has(bucket)) hitsHighlightPinned.delete(bucket);
    else hitsHighlightPinned.add(bucket);
    syncHitsStatsHighlightUi();
    if (viewMode === "hits") drawHitsView();
  }

  function clearHitsHighlight() {
    hitsHighlightPinned = new Set();
    hitsHighlightHover = null;
    hoveredMapDotId = null;
  }

  function syncHitsStatsHighlightUi() {
    if (!hitsStatsDotsEl) return;
    hitsStatsDotsEl.querySelectorAll(".schedule-placement-stat[data-bucket]").forEach((el) => {
      const bucket = el.getAttribute("data-bucket");
      const pinned = Boolean(bucket && hitsHighlightPinned.has(bucket));
      el.classList.toggle("is-hits-highlight-pinned", pinned);
      el.setAttribute("aria-pressed", pinned ? "true" : "false");
    });
  }

  function appendHitsStatDot(parent, color, value, hasData) {
    if (!parent) return;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "schedule-placement-stat schedule-play-hits-stat";
    item.dataset.bucket = color;
    item.setAttribute("aria-pressed", hitsHighlightPinned.has(color) ? "true" : "false");
    item.title = hasData
      ? `Highlight ${color} windows on the map`
      : `No ${color} windows`;
    item.disabled = !hasData || !(value > 0);

    const dot = document.createElement("span");
    dot.className = `schedule-placement-dot schedule-placement-dot-${color}`;
    dot.setAttribute("aria-hidden", "true");
    const count = document.createElement("span");
    count.className = "schedule-placement-stat-count";
    count.textContent = hasData ? String(value ?? 0) : "—";
    item.append(dot, count);

    if (!item.disabled) {
      item.addEventListener("pointerenter", () => setHitsHighlightHover(color));
      item.addEventListener("pointerleave", () => {
        if (hitsHighlightHover === color) setHitsHighlightHover(null);
      });
      item.addEventListener("click", (e) => {
        e.preventDefault();
        toggleHitsHighlightPinned(color);
      });
    }

    if (hitsHighlightPinned.has(color)) item.classList.add("is-hits-highlight-pinned");
    parent.appendChild(item);
  }

  function renderHitsStatsPanel() {
    const totals = cardTotalsFromPayload();
    const { dots } = collectHitDots();
    const buys = dots.filter((d) => d.type === "buy").length;
    const sells = dots.filter((d) => d.type === "sell").length;

    if (hitsStatsDotsEl) {
      hitsStatsDotsEl.replaceChildren();
      appendHitsStatDot(hitsStatsDotsEl, "green", totals.green, totals.hasData);
      appendHitsStatDot(hitsStatsDotsEl, "red", totals.red, totals.hasData);
      appendHitsStatDot(hitsStatsDotsEl, "blue", totals.blue, totals.hasData);
      syncHitsStatsHighlightUi();
    }

    if (hitsPnlEl) {
      hitsPnlEl.textContent = formatPnl(totals.pnl);
      hitsPnlEl.className = "schedule-play-hits-pnl";
      if (totals.hasData && totals.pnl > 0) hitsPnlEl.classList.add("is-positive");
      else if (totals.hasData && totals.pnl < 0) hitsPnlEl.classList.add("is-negative");
    }

    if (hitsMarkersEl) {
      hitsMarkersEl.textContent = totals.hasData
        ? `${totals.windows} window${totals.windows === 1 ? "" : "s"} · ${dots.length} hit${dots.length === 1 ? "" : "s"} (${buys} buy / ${sells} sell) overlaid by time & price`
        : "No windows in this card";
    }
  }

  function collectHitDots() {
    const windows = payload?.windows || [];
    const dots = [];
    let maxDuration = 300;
    let markerCount = 0;
    for (let i = 0; i < windows.length; i += 1) {
      const win = windows[i];
      const duration = windowDuration(win);
      if (duration > maxDuration) maxDuration = duration;
      for (const m of win.markers || []) {
        markerCount += 1;
        if (m?.t == null || !Number.isFinite(m.t)) continue;
        const yMissing = m.y == null || !Number.isFinite(m.y);
        // Live Open: keep ledger hits without Chainlink Y (drawn on mid band).
        // Replay: prefer asset Y only (server should enrich — don't fake with PTB).
        if (yMissing && !liveMode) continue;
        const elapsed = m.t - win.windowStart;
        // Allow tiny end-of-window float overflow from fill timing.
        if (elapsed < -0.5 || elapsed > duration + 1) continue;
        dots.push({
          elapsed: Math.max(0, Math.min(duration, elapsed)),
          y: yMissing ? null : m.y,
          yMissing,
          type: m.type,
          side: m.side,
          source: markerTradeSource(m),
          windowKey: m.windowKey,
          windowIndex: i,
          windowStart: win.windowStart,
          shares: m.shares,
          price: m.price,
          cost: m.cost,
          fees: m.fees,
          proceeds: m.proceeds,
          profit: m.profit,
          total: m.total,
          heldSettlement: m.heldSettlement === true,
          plLabel: win.plLabel,
          pnl: win.pnl,
          bucket: tradeBucketForMarker(win, m),
          pairDotId: null,
        });
      }
    }
    assignBuySellPairIds(dots, hitDotId);
    return { dots, maxDuration, markerCount };
  }

  function drawHitsView() {
    if (!canvas) return;
    const { ctx, width, height } = resizeCanvas();
    if (!ctx || width <= 0 || height <= 0) return;

    ctx.clearRect(0, 0, width, height);
    // Same geometry as the play graph (buildChartLayout) so toggling views doesn't shift the plot.
    const padding = CHART_PAD;
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;
    if (plotW <= 0 || plotH <= 0) {
      hoverTargets = [];
      playChartLayout = null;
      return;
    }
    playChartLayout = { padding, plotW, plotH };

    const { dots, maxDuration, markerCount } = collectHitDots();

    ctx.strokeStyle = "#21262d";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
      const y = padding.top + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
    }

    ctx.fillStyle = "#6e7681";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("0:00", padding.left, height - padding.bottom + 4);
    ctx.fillText(formatClock(maxDuration), width - padding.right, height - padding.bottom + 4);

    if (dots.length === 0) {
      hoverTargets = [];
      hideHitTooltip();
      ctx.fillStyle = "#8b949e";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        markerCount > 0 ? "Hits missing market price data" : "No hits in these windows",
        width / 2,
        height / 2,
      );
      return;
    }

    let minP = Infinity;
    let maxP = -Infinity;
    let pricedCount = 0;
    for (const d of dots) {
      if (d.yMissing || d.y == null || !Number.isFinite(d.y)) continue;
      pricedCount += 1;
      if (d.y < minP) minP = d.y;
      if (d.y > maxP) maxP = d.y;
    }
    if (pricedCount === 0) {
      minP = 0;
      maxP = 1;
    }
    const spread = maxP - minP || Math.max(Math.abs(minP) * 0.001, 1);
    const margin = spread * 0.12;
    minP -= margin;
    maxP += margin;

    const xAt = (elapsed) => padding.left + (elapsed / maxDuration) * plotW;
    const midY = padding.top + plotH / 2;
    const yAt = (price) => {
      if (price == null || !Number.isFinite(price)) return midY;
      return padding.top + plotH - ((price - minP) / (maxP - minP || 1)) * plotH;
    };

    // Market values sit inside the plot on the top/bottom grid lines.
    ctx.fillStyle = "#6e7681";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(formatPrice(maxP), padding.left + 4, padding.top + 2);
    ctx.textBaseline = "bottom";
    ctx.fillText(formatPrice(minP), padding.left + 4, padding.top + plotH - 2);

    const nextTargets = [];
    const highlightBuckets = activeHitsHighlightBuckets();
    const mapHoverIds = mapHoverHighlightIds(dots, hitDotId);
    // All windows overlaid — same opacity so hits align by time & price.
    for (const d of dots) {
      const x = xAt(d.elapsed);
      const y = yAt(d.y);
      const color = sideColor(d.side);
      const id = hitDotId(d);
      const fromStats = highlightBuckets.has(d.bucket);
      const fromMapHover = mapHoverIds.has(id);

      if (fromStats || fromMapHover) {
        ctx.beginPath();
        ctx.arc(x, y, 10, 0, Math.PI * 2);
        ctx.strokeStyle = bucketColor(d.bucket);
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      if (d.type === "buy") {
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.fillStyle = "rgba(13, 17, 23, 0.85)";
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      nextTargets.push({
        id,
        x,
        y,
        bucket: d.bucket,
        html: renderHitsMapTooltipHtml(d),
      });
    }
    hoverTargets = nextTargets;
  }

  function updateTimeUi(win) {
    const duration = windowDuration(win);
    const elapsed = Math.max(0, Math.min(duration, playheadSec - (win?.windowStart || 0)));
    updateScrubberUi(win, elapsed, duration);
  }

  function resolveTriggerDurationSec(raw, win) {
    let durationSec = Number(raw);
    if (!Number.isFinite(durationSec) || !(durationSec > 0)) {
      durationSec = Number(win?.predictionSensitivitySec);
    }
    if (!Number.isFinite(durationSec) || !(durationSec > 0)) {
      durationSec = Number(playPredictionSensitivitySec);
    }
    if (!Number.isFinite(durationSec) || !(durationSec > 0)) durationSec = 5;
    return durationSec;
  }

  /** Trigger/Prediction Duration hits for a window (multi-retrigger) with marker fallback. */
  function predictionTriggersForWindow(win) {
    if (Array.isArray(win?.predictionTriggers) && win.predictionTriggers.length > 0) {
      return win.predictionTriggers.filter(
        (t) =>
          t &&
          (t.side === "up" || t.side === "down") &&
          Number.isFinite(Number(t.triggeredAtMs)),
      );
    }
    const side = win?.predictionSide;
    const triggeredAtMs = Number(win?.predictionTriggeredAtMs);
    if ((side === "up" || side === "down") && Number.isFinite(triggeredAtMs)) {
      return [
        {
          side,
          triggeredAtMs,
          sensitivitySec: resolveTriggerDurationSec(null, win),
          score:
            win?.predictionScore === "right" || win?.predictionScore === "wrong"
              ? win.predictionScore
              : "wrong",
        },
      ];
    }
    // Fallback: build Duration bands from Trigger buy dots when band payload was stripped.
    const buys = (win?.markers || []).filter(
      (m) => m?.type === "buy" && markerTradeSource(m) === "trigger" && (m.side === "up" || m.side === "down"),
    );
    if (!buys.length) return [];
    const durationSec = resolveTriggerDurationSec(null, win);
    return buys.map((m) => ({
      side: m.side,
      triggeredAtMs: Number(m.t) * 1000,
      sensitivitySec: durationSec,
      score: "wrong",
    }));
  }

  /**
   * Full-height Duration bands ending at each Trigger/Prediction buy.
   * Each appears as soon as the playhead enters that Duration span and grows until its buy.
   */
  function buildPredictionDurationBands(win, untilSec) {
    const triggers = predictionTriggersForWindow(win);
    if (!triggers.length) return [];
    const bands = [];
    for (const trig of triggers) {
      const side = trig.side;
      const triggeredAtMs = Number(trig.triggeredAtMs);
      if ((side !== "up" && side !== "down") || !Number.isFinite(triggeredAtMs)) continue;
      const triggerSec = triggeredAtMs / 1000;
      const durationSec = resolveTriggerDurationSec(trig.sensitivitySec, win);

      const startSec = Math.max(Number(win.windowStart) || 0, triggerSec - durationSec);
      const fullEndSec = Math.min(Number(win.windowEnd) || triggerSec, triggerSec);
      if (!(fullEndSec > startSec)) continue;
      if (!(untilSec >= startSec)) continue;
      const endSec = Math.min(fullEndSec, untilSec);
      if (!(endSec > startSec)) continue;
      bands.push({ startSec, endSec, side });
    }
    return bands;
  }

  function scrubberWidthPx() {
    return scrubber?.offsetWidth || 12;
  }

  /** Scrubber center X range that keeps the full bar inside the chart wrap. */
  function scrubberCenterBounds(wrapWidth, barW = scrubberWidthPx()) {
    const half = barW / 2;
    const minX = half;
    const maxX = Math.max(minX, wrapWidth - half);
    const plotStart = CHART_PAD.left;
    const plotEnd = Math.max(
      plotStart,
      wrapWidth - CHART_PAD.right,
    );
    // At end-of-window, allow travel into the right pad (still inside the wrap)
    // so the bar can clear the final price dot.
    const endX = Math.min(maxX, plotEnd + barW);
    return { minX, maxX, plotStart, plotEnd, endX, barW };
  }

  function updateScrubberUi(win, elapsed, duration) {
    if (!scrubber) return;
    const ready = isGraphReady() && win;
    scrubber.hidden = !ready;
    if (!ready) return;

    const wrap = chartWrap || canvas?.parentElement;
    const width = wrap?.clientWidth ?? 0;
    const height = wrap?.clientHeight ?? 0;
    const plotW = Math.max(1, width - CHART_PAD.left - CHART_PAD.right);
    const plotH = Math.max(1, height - CHART_PAD.top - CHART_PAD.bottom);
    const frac = duration > 0 ? elapsed / duration : 0;
    const { minX, endX } = scrubberCenterBounds(width);
    let x = CHART_PAD.left + frac * plotW;
    if (frac >= 1) x = endX;
    x = Math.min(endX, Math.max(minX, x));
    if (scrubbing && scrubVisualX != null) x = scrubVisualX;

    scrubber.style.left = `${x}px`;
    scrubber.style.top = `${CHART_PAD.top}px`;
    scrubber.style.height = `${plotH}px`;
    scrubber.setAttribute("aria-valuemin", "0");
    scrubber.setAttribute("aria-valuemax", String(duration));
    scrubber.setAttribute("aria-valuenow", String(elapsed));
    scrubber.setAttribute("aria-valuetext", `${formatClock(elapsed)} of ${formatClock(duration)}`);

    const timeEl = $("schedule-play-scrubber-time");
    if (timeEl) {
      timeEl.textContent = formatClock(elapsed);
      // Flip label to the left near the right edge so it stays inside the chart.
      timeEl.classList.toggle("is-flip-left", x > width - 48);
    }
    syncScrubberHandlePosition();
  }

  function syncScrubberHandlePosition() {
    const handle = scrubber?.querySelector(".schedule-play-scrubber-handle");
    if (!handle) return;
    const frac = Math.min(1, Math.max(0, scrubberHandleFrac));
    handle.style.top = `${frac * 100}%`;
  }

  function scrubFromPointer(clientX, clientY) {
    const win = selectedWindow();
    if (!win || !isGraphReady()) return;
    const wrap = chartWrap || canvas?.parentElement;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const plotW = Math.max(1, rect.width - CHART_PAD.left - CHART_PAD.right);
    const { minX, endX, plotStart } = scrubberCenterBounds(rect.width);
    const centerX = Math.min(endX, Math.max(minX, clientX - rect.left));
    // Past the plot’s right edge (inside the wrap pad) still maps to end-of-window.
    const timeFrac = Math.min(1, Math.max(0, (centerX - plotStart) / plotW));
    scrubVisualX = centerX;
    setPlayhead(win.windowStart + timeFrac * windowDuration(win));

    if (clientY != null && scrubber) {
      const barRect = scrubber.getBoundingClientRect();
      const h = Math.max(1, barRect.height);
      scrubberHandleFrac = Math.min(1, Math.max(0, (clientY - barRect.top) / h));
      syncScrubberHandlePosition();
    }
  }

  function scrubFromClientX(clientX) {
    scrubFromPointer(clientX, null);
  }

  function endScrub(pointerId) {
    if (!scrubbing) return;
    scrubbing = false;
    scrubVisualX = null;
    scrubber?.classList.remove("is-dragging");
    document.body.classList.remove("is-schedule-dragging");
    if (scrubber && pointerId != null) {
      try {
        scrubber.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
    }
    const win = selectedWindow();
    if (win) updateTimeUi(win);
  }

  function isGraphReady() {
    return viewMode === "play" && priceHistory.length > 0;
  }

  function updateTransportEnabled() {
    const ready = isGraphReady();
    const stepBack = $("schedule-play-step-back");
    const stepFwd = $("schedule-play-step-fwd");
    const speedWrap = document.querySelector(".schedule-play-speed-wrap");
    for (const el of [playBtn, stepBack, stepFwd, speedSelect]) {
      if (!el) continue;
      el.disabled = !ready;
    }
    if (scrubber) {
      scrubber.hidden = !ready;
      scrubber.setAttribute("aria-disabled", ready ? "false" : "true");
      scrubber.tabIndex = ready ? 0 : -1;
    }
    transportPlayPanel?.classList.toggle("is-disabled", !ready);
    speedWrap?.classList.toggle("is-disabled", !ready);
  }

  function windowsLoaded() {
    return Boolean(payload?.windows?.length);
  }

  function setWindowsLoading(loading, label = "Loading windows…") {
    windowsLoading = Boolean(loading);
    syncChartLoadingOverlay(label);
    syncViewToggleEnabled();
    syncHeaderProgress();
  }

  function setTicksLoading(loading) {
    ticksLoading = Boolean(loading);
    syncChartLoadingOverlay(loading ? "Loading price…" : undefined);
    syncHeaderProgress();
  }

  function syncChartLoadingOverlay(label) {
    const overlay = $("schedule-play-chart-loading");
    if (!overlay) return;
    const show = windowsLoading || ticksLoading;
    const labelEl = overlay.querySelector(".schedule-play-chart-loading-label");
    if (labelEl) {
      if (label) labelEl.textContent = label;
      else if (windowsLoading) labelEl.textContent = "Loading windows…";
      else if (ticksLoading) labelEl.textContent = "Loading price…";
    }
    overlay.hidden = !show;
    overlay.setAttribute("aria-busy", show ? "true" : "false");
  }

  function syncViewToggleEnabled() {
    const enabled = windowsLoaded();
    for (const btn of [viewPlayBtn, viewHitsBtn]) {
      if (!btn) continue;
      btn.disabled = !enabled;
      btn.setAttribute("aria-disabled", enabled ? "false" : "true");
    }
  }

  function updateViewChrome() {
    const isHits = viewMode === "hits";
    viewPlayBtn?.classList.toggle("is-active", !isHits);
    viewHitsBtn?.classList.toggle("is-active", isHits);
    viewPlayBtn?.setAttribute("aria-pressed", isHits ? "false" : "true");
    viewHitsBtn?.setAttribute("aria-pressed", isHits ? "true" : "false");
    if (transportPlayPanel) transportPlayPanel.hidden = isHits;
    if (transportHitsPanel) transportHitsPanel.hidden = !isHits;
    modal?.classList.toggle("is-hits-view", isHits);
    if (isHits) renderHitsStatsPanel();
    syncViewToggleEnabled();
    syncWindowSliderEnabled();
    updateTransportEnabled();
    syncHeaderProgress();
  }

  function syncWindowSliderEnabled() {
    const enabled = viewMode === "play" && !windowsLoading && !slotSpinning && windowsLoaded();
    const sidebar = document.querySelector(".schedule-play-sidebar");
    sidebar?.classList.toggle("is-disabled", !enabled);
    sidebar?.setAttribute("aria-disabled", enabled ? "false" : "true");
    if (listEl) {
      listEl.tabIndex = enabled ? 0 : -1;
      listEl.setAttribute("aria-disabled", enabled ? "false" : "true");
    }
    syncListNavButtons();
  }

  /** Official Polymarket Up/Down from the recording (`windowOutcome`), not inferred. */
  function updateOfficialOutcome() {
    if (!outcomeValueEl) return;
    const win = selectedWindow();
    const outcome =
      win?.windowOutcome === "up" || win?.windowOutcome === "down" ? win.windowOutcome : null;
    outcomeValueEl.classList.remove("is-up", "is-down");
    if (!outcome) {
      outcomeValueEl.textContent = "—";
      return;
    }
    outcomeValueEl.textContent = outcome === "up" ? "UP" : "DOWN";
    outcomeValueEl.classList.add(outcome === "up" ? "is-up" : "is-down");
  }

  function updateMeta() {
    updateOfficialOutcome();
    if (!metaEl) return;
    if (viewMode === "hits") {
      metaEl.textContent = "Hits · all windows overlaid by elapsed time & market price";
      return;
    }
    const win = selectedWindow();
    if (!win) {
      metaEl.textContent = "—";
      return;
    }
    const until = playheadSec;
    const visible = priceHistory.filter((p) => p.t <= until);
    const last = visible[visible.length - 1];
    const elapsed = Math.max(0, playheadSec - win.windowStart);
    metaEl.textContent = `${formatUtcTime(win.windowStart)} UTC · ${win.plLabel} · ${formatPnl(win.pnl)} · t ${formatClock(elapsed)} · ${formatPrice(last?.price)}`;
  }

  function drawPlayView() {
    const win = selectedWindow();
    if (!win || !canvas || !window.drawPriceChart) {
      hoverTargets = [];
      playChartLayout = null;
      hidePhaseHover();
      hideHitTooltip();
      if (canvas) {
        const { ctx, width, height } = resizeCanvas();
        if (ctx) {
          ctx.clearRect(0, 0, width, height);
          // While windows are loading, the DOM spinner covers the chart.
          if (!windowsLoading) {
            ctx.fillStyle = "#8b949e";
            ctx.font = "11px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(win ? "Loading…" : "No window selected", width / 2, height / 2);
          }
        }
      }
      return;
    }

    // While ticks load, keep the canvas clear — the DOM spinner covers the chart.
    if (ticksLoading && priceHistory.length === 0) {
      hoverTargets = [];
      playChartLayout = null;
      hidePhaseHover();
      hideHitTooltip();
      const { ctx, width, height } = resizeCanvas();
      if (ctx) ctx.clearRect(0, 0, width, height);
      updateTimeUi(win);
      return;
    }

    // Missing official settlement or empty tick path — no price line.
    // Live Open still draws ledger markers on a blank timeline.
    if (!ticksLoading && priceHistory.length === 0) {
      hoverTargets = [];
      playChartLayout = null;
      hidePhaseHover();
      hideHitTooltip();
      const { ctx, width, height } = resizeCanvas();
      if (ctx) {
        ctx.clearRect(0, 0, width, height);
        const padding = CHART_PAD;
        const plotW = width - padding.left - padding.right;
        const plotH = height - padding.top - padding.bottom;
        playChartLayout = { padding, plotW, plotH, xAt: null, yAt: null };
        const duration = windowDuration(win);
        const until = playheadSec;
        const markers = (win.markers || []).filter((m) => Number(m.t) <= until);
        if (plotW > 0 && plotH > 0) {
          playChartLayout.xAt = (t) =>
            padding.left + ((Number(t) - win.windowStart) / Math.max(1e-9, duration)) * plotW;
          playChartLayout.yAt = () => padding.top + plotH / 2;
          // Subtle mid band so markers have a rail when ticks are missing.
          ctx.strokeStyle = "#21262d";
          ctx.beginPath();
          ctx.moveTo(padding.left, padding.top + plotH / 2);
          ctx.lineTo(width - padding.right, padding.top + plotH / 2);
          ctx.stroke();
        }
        ctx.fillStyle = "#8b949e";
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const noteY = padding.top + 18;
        if (!hasOfficialSettlement(win) && !windowHasAnyHit(win)) {
          ctx.fillText("No official settlement data for this window", width / 2, height / 2 - 8);
          ctx.font = "11px sans-serif";
          ctx.fillStyle = "#6e7681";
          ctx.fillText(
            "Recording is missing Polymarket outcome / open / close",
            width / 2,
            height / 2 + 12,
          );
        } else {
          ctx.fillText("No Chainlink recording for this window", width / 2, noteY);
          ctx.font = "11px sans-serif";
          ctx.fillStyle = "#6e7681";
          const hitNote = windowHasAnyHit(win)
            ? "Trade from live ledger — markers shown by time"
            : "No price ticks on the recorder for this slot";
          ctx.fillText(hitNote, width / 2, noteY + 16);
        }
        const nextTargets = [];
        const playDots = [];
        if (playChartLayout?.xAt) {
          for (const m of markers) {
            if (m?.t == null || !Number.isFinite(m.t)) continue;
            const x = playChartLayout.xAt(m.t);
            const y = padding.top + plotH / 2;
            const id = `play:${m.t}:${m.type}:${m.side}:noticks`;
            const dot = {
              id,
              x,
              y,
              t: m.t,
              type: m.type,
              side: m.side,
              source: markerTradeSource(m),
              windowKey: m.windowKey,
              windowStart: win.windowStart,
              bucket: tradeBucketForMarker(win, m),
              html: renderHitsMapTooltipHtml(m),
              pairDotId: null,
            };
            playDots.push(dot);
            nextTargets.push(dot);
            ctx.beginPath();
            ctx.arc(x, y, 4.5, 0, Math.PI * 2);
            const color = m.side === "down" ? DOWN_COLOR : UP_COLOR;
            if (m.type === "buy") {
              ctx.fillStyle = color;
              ctx.fill();
            } else {
              ctx.fillStyle = "rgba(13, 17, 23, 0.85)";
              ctx.fill();
              ctx.strokeStyle = color;
              ctx.lineWidth = 2;
              ctx.stroke();
            }
          }
          assignBuySellPairIds(playDots, (d) => d.id);
        }
        hoverTargets = nextTargets;
      }
      updateTimeUi(win);
      return;
    }

    const until = playheadSec;
    const visible = priceHistory.filter((p) => p.t <= until);
    const last = visible[visible.length - 1];
    const state = {
      series: currentSeries(),
      windowStart: win.windowStart,
      windowEnd: win.windowEnd,
      prevCloseAsset: win.prevCloseAsset,
      assetPrice: last?.price,
      // Full history — drawPriceChart clips the line with revealUntil.
      priceHistory,
    };

    // Only reveal markers that have occurred at the current playhead.
    const markers = (win.markers || []).filter((m) => Number(m.t) <= until);

    const predictionBands = buildPredictionDurationBands(win, until);

    const layout = window.drawPriceChart(state, {
      canvas,
      markersOverride: markers,
      revealUntil: until,
      hoverLine: null,
      dragLine: null,
      // DOM scrubber is the playhead; skip the canvas duplicate.
      showPlayhead: false,
      marketOutcome: resolveMarketOutcome(win),
      predictionBands,
      // Legacy single-band key (first band) for older drawPriceChart callers.
      predictionBand: predictionBands[0] || null,
      // Phase bands removed (Trigger-only Schedule / Open Replay).
      phasesVisible: false,
    });
    playChartLayout = layout;
    updateTimeUi(win);

    const nextTargets = [];
    const playDots = [];
    if (layout?.xAt && layout?.yAt) {
      for (const m of markers) {
        if (m?.t == null || !Number.isFinite(m.t)) continue;
        const x = layout.xAt(m.t);
        let y = layout.padding.top + layout.plotH / 2;
        if (m.y != null && Number.isFinite(m.y)) y = layout.yAt(m.y);
        const id = `play:${m.t}:${m.type}:${m.side}:${m.y ?? ""}`;
        const dot = {
          id,
          x,
          y,
          t: m.t,
          type: m.type,
          side: m.side,
          source: markerTradeSource(m),
          windowKey: m.windowKey,
          windowStart: win.windowStart,
          bucket: tradeBucketForMarker(win, m),
          html: renderHitsMapTooltipHtml(m),
          pairDotId: null,
        };
        playDots.push(dot);
        nextTargets.push(dot);
      }
      assignBuySellPairIds(playDots, (d) => d.id);
    }
    hoverTargets = nextTargets;

    if (hoveredMapDotId != null && layout) {
      const mapHoverIds = mapHoverHighlightIds(playDots, (d) => d.id);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        for (const ht of nextTargets) {
          if (!mapHoverIds.has(ht.id)) continue;
          ctx.beginPath();
          ctx.arc(ht.x, ht.y, 10, 0, Math.PI * 2);
          ctx.strokeStyle = bucketColor(ht.bucket);
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }
  }

  function drawFrame() {
    updateViewChrome();
    if (viewMode === "hits") {
      drawHitsView();
    } else {
      drawPlayView();
    }
    updateMeta();
    updateMetricsPanel();
  }

  function setViewMode(mode) {
    if (mode !== "play" && mode !== "hits") return;
    if (!windowsLoaded() && mode === "hits") return;
    if (viewMode === mode) {
      drawFrame();
      return;
    }
    if (mode === "hits") stopPlayback();
    else clearHitsHighlight();
    viewMode = mode;
    hideHitTooltip();
    drawFrame();
  }

  function setPlayhead(absSec, options = {}) {
    const win = selectedWindow();
    if (!win) return;
    const start = win.windowStart;
    const end = win.windowEnd || start + 300;
    playheadSec = Math.min(end, Math.max(start, absSec));
    if (!options.skipDraw) drawFrame();
    if (playheadSec < end - 0.001) return;

    // End of window: keep playing through the list only while autoplay is latched.
    if (autoPlayWindows && viewMode === "play" && selectedIndex + 1 < windowCount()) {
      void selectWindow(selectedIndex + 1, { fromSlide: true, continueAutoPlay: true });
      return;
    }
    stopPlayback();
  }

  function stepFrame(dir) {
    if (viewMode !== "play") return;
    const win = selectedWindow();
    if (!win || priceHistory.length === 0) return;
    stopPlayback();
    const times = priceHistory.map((p) => p.t);
    if (dir > 0) {
      const next = times.find((t) => t > playheadSec + 0.0001);
      setPlayhead(next != null ? next : win.windowEnd);
    } else {
      let prev = times[0];
      for (const t of times) {
        if (t >= playheadSec - 0.0001) break;
        prev = t;
      }
      setPlayhead(prev);
    }
  }

  function tick(nowMs) {
    if (!playing || viewMode !== "play") return;
    const win = selectedWindow();
    if (!win) {
      stopPlayback();
      return;
    }
    if (!lastFrameMs) lastFrameMs = nowMs;
    const dt = Math.min(0.1, (nowMs - lastFrameMs) / 1000);
    lastFrameMs = nowMs;
    setPlayhead(playheadSec + dt * playbackRate(win));
    if (playing) rafId = requestAnimationFrame(tick);
  }

  function startPlayback() {
    if (viewMode !== "play") return;
    const win = selectedWindow();
    if (!win || priceHistory.length === 0) return;
    if (playheadSec >= (win.windowEnd || win.windowStart + 300) - 0.001) {
      playheadSec = win.windowStart;
    }
    autoPlayWindows = true;
    setPlaying(true);
    lastFrameMs = 0;
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }

  function togglePlay() {
    if (viewMode !== "play") return;
    const win = selectedWindow();
    if (!win || priceHistory.length === 0) return;
    if (playing || autoPlayWindows) {
      stopPlayback();
      return;
    }
    startPlayback();
  }

  function ticksToPriceHistory(ticks, ptb) {
    const history = [];
    for (const tick of ticks || []) {
      if (tick?.tMs == null || !Number.isFinite(tick.tMs)) continue;
      let price = null;
      if (tick.assetPrice != null && Number.isFinite(tick.assetPrice)) {
        price = tick.assetPrice;
      } else if (
        ptb != null &&
        Number.isFinite(ptb) &&
        tick.assetGap != null &&
        Number.isFinite(tick.assetGap)
      ) {
        price = ptb + tick.assetGap;
      }
      if (price == null || !Number.isFinite(price)) continue;
      history.push({ t: tick.tMs / 1000, price });
    }
    history.sort((a, b) => a.t - b.t);
    return history;
  }

  /**
   * Market up/down for the graph — same idea as Settlement, with inference when
   * the payload omitted windowOutcome (old cache / thin window JSON).
   */
  function resolveMarketOutcome(win) {
    if (win?.windowOutcome === "up" || win?.windowOutcome === "down") {
      return win.windowOutcome;
    }
    const buy = (win?.markers || []).find((m) => m && m.type === "buy");
    const side = buy?.side === "up" || buy?.side === "down" ? buy.side : null;
    if (!side) return null;
    const label = String(win?.plLabel || "");
    const pnl = Number(win?.pnl);
    if (label === "Settlement" && Number.isFinite(pnl)) {
      if (pnl > 1e-9) return side; // held and won → market matched buy side
      if (pnl < -1e-9) return side === "up" ? "down" : "up";
    }
    if (label === "Trade" && win?.sold && Number.isFinite(pnl) && buy) {
      // Early exit — market direction is not implied; leave null.
      return null;
    }
    return null;
  }

  /** Recording has official outcome + open/close (Gamma payout) — no inference. */
  function hasOfficialSettlement(win) {
    const outcome = win?.windowOutcome;
    if (outcome !== "up" && outcome !== "down") return false;
    const ptb = Number(win?.prevCloseAsset);
    const close = Number(win?.finalPrice ?? win?.assetPrice);
    return Number.isFinite(ptb) && Number.isFinite(close);
  }

  function officialClosePrice(win) {
    const close = Number(win?.finalPrice ?? win?.assetPrice);
    return Number.isFinite(close) ? close : null;
  }

  /** Mid-window Chainlink samples only (excludes the official close tip at windowEnd). */
  function midWindowChainlinkCount(history, win) {
    const endT = Number(win?.windowEnd);
    const pts = Array.isArray(history) ? history : [];
    if (!Number.isFinite(endT)) return pts.length;
    return pts.filter((p) => Number(p.t) < endT - 1e-9).length;
  }

  /**
   * End tip = stored official close at windowEnd (real settlement stamp).
   * Mid-window path stays Chainlink; if official close is missing, extend last tick in time only.
   * Tip-only (no mid-window Chainlink) is not a usable Replay path — callers must skip those windows.
   */
  function withOfficialClose(history, win) {
    const endT = Number(win?.windowEnd);
    if (!Number.isFinite(endT)) return history || [];
    const pts = Array.isArray(history) ? history.filter((p) => Number(p.t) < endT - 1e-9) : [];
    // No Chainlink path — do not invent a one-point tip history (false Open Replay).
    if (pts.length === 0) return [];
    const officialClose = officialClosePrice(win);
    if (officialClose != null) {
      pts.push({ t: endT, price: officialClose });
      return pts;
    }
    const last = pts[pts.length - 1];
    if (!last || !Number.isFinite(last.price)) return pts;
    if (Math.abs(Number(last.t) - endT) > 1e-6) {
      pts.push({ t: endT, price: last.price });
    }
    return pts;
  }

  async function fetchTickStream(windowStart, stream) {
    const series = encodeURIComponent(currentSeries());
    const res = await fetch(
      `/api/ticks?series=${series}&windowStart=${encodeURIComponent(windowStart)}&stream=${encodeURIComponent(stream)}&limit=20000`,
    );
    if (!res.ok) throw new Error(`Failed to load ticks (${res.status})`);
    const body = await res.json();
    return body.ticks || [];
  }

  function bookTicksToQuoteSamples(ticks) {
    const samples = [];
    for (const tick of ticks || []) {
      const tMs = Number(tick?.tMs);
      if (!Number.isFinite(tMs)) continue;
      samples.push({
        t: tMs / 1000,
        yesAsk: bestBookPrice(tick.yesAsks),
        yesBid: bestBookPrice(tick.yesBids),
        noAsk: bestBookPrice(tick.noAsks),
        noBid: bestBookPrice(tick.noBids),
      });
    }
    samples.sort((a, b) => a.t - b.t);
    return samples;
  }

  /** Lazy book tops for quote boxes — Open Replay only, per selected window. */
  async function loadBookQuotes(windowStart) {
    if (bookQuoteCache.has(windowStart)) return bookQuoteCache.get(windowStart);
    const samples = bookTicksToQuoteSamples(await fetchTickStream(windowStart, "book"));
    bookQuoteCache.set(windowStart, samples);
    return samples;
  }

  /**
   * Keep official PTB / close from the play payload when present.
   * Only fill gaps from Chainlink ticks when the recording lacked settlement prices.
   */
  function hydrateWindowSettlementFromTicks(win, ticks) {
    if (!win || !Array.isArray(ticks) || ticks.length === 0) return;
    if (hasOfficialSettlement(win)) return;
    let tickPtb = null;
    let lastPrice = null;
    for (const tick of ticks) {
      const ptb = Number(tick?.prevCloseAsset);
      if (Number.isFinite(ptb)) tickPtb = ptb;
      const price = Number(tick?.assetPrice);
      if (Number.isFinite(price)) lastPrice = price;
    }
    if (tickPtb != null && !Number.isFinite(Number(win.prevCloseAsset))) {
      win.prevCloseAsset = tickPtb;
    }
    if (lastPrice != null && !Number.isFinite(Number(win.finalPrice ?? win.assetPrice))) {
      win.finalPrice = lastPrice;
    }
  }

  function applyCachedSettlement(win, cached) {
    if (!win || !cached) return;
    if (hasOfficialSettlement(win)) return;
    if (cached.ptb != null && Number.isFinite(cached.ptb)) win.prevCloseAsset = cached.ptb;
    if (cached.finalPrice != null && Number.isFinite(cached.finalPrice)) {
      win.finalPrice = cached.finalPrice;
    }
  }

  /** Chainlink path + official close tip at windowEnd (when settlement fields exist). */
  async function loadTicks(windowStart, win) {
    const cacheKey = String(windowStart);
    const officialPtb = Number(win?.prevCloseAsset);
    const officialClose = officialClosePrice(win);
    const officialOutcome =
      win?.windowOutcome === "up" || win?.windowOutcome === "down" ? win.windowOutcome : null;

    if (tickCache.has(cacheKey)) {
      const cached = tickCache.get(cacheKey);
      // Re-apply payload official fields (cache is per windowStart; payload is source of truth).
      if (officialOutcome) win.windowOutcome = officialOutcome;
      if (Number.isFinite(officialPtb)) win.prevCloseAsset = officialPtb;
      if (officialClose != null) win.finalPrice = officialClose;
      applyCachedSettlement(win, cached);
      // Rebuild tip if this session's official close differs from cached history tip.
      if (officialClose != null && hasOfficialSettlement(win)) {
        return withOfficialClose(
          (cached.history || []).filter((p) => Number(p.t) < Number(win.windowEnd) - 1e-9),
          win,
        );
      }
      return cached.history;
    }

    const ticks = await fetchTickStream(windowStart, "chainlink");
    if (Number.isFinite(officialPtb)) win.prevCloseAsset = officialPtb;
    if (officialClose != null) win.finalPrice = officialClose;
    if (officialOutcome) win.windowOutcome = officialOutcome;
    hydrateWindowSettlementFromTicks(win, ticks);

    const history = withOfficialClose(
      ticksToPriceHistory(ticks, win?.prevCloseAsset),
      win || { windowStart },
    );

    tickCache.set(cacheKey, {
      history,
      ptb: Number.isFinite(Number(win?.prevCloseAsset)) ? Number(win.prevCloseAsset) : null,
      finalPrice: Number.isFinite(Number(win?.finalPrice)) ? Number(win.finalPrice) : null,
    });
    return history;
  }

  function windowCount() {
    return payload?.windows?.length || 0;
  }

  function windowHasAnyHit(win) {
    return (win?.markers || []).some((m) => m && (m.type === "buy" || m.type === "sell"));
  }

  function firstHitOrZeroIndex(windows) {
    if (!windows?.length) return 0;
    const hitIdx = windows.findIndex((w) => windowHasAnyHit(w));
    return hitIdx >= 0 ? hitIdx : 0;
  }

  function visibleListSlotCount() {
    if (!listEl) return 7;
    const h = listEl.clientHeight || 360;
    return Math.max(5, Math.ceil(h / LIST_ITEM_STRIDE) + 2);
  }

  function placeholderCount(hint) {
    const fromHint = Number.isFinite(hint) && hint > 0 ? Math.floor(hint) : 0;
    return Math.max(visibleListSlotCount(), fromHint, 8);
  }

  function listCenterOffset() {
    if (!listEl) return 0;
    return Math.max(0, (listEl.clientHeight - LIST_ITEM_H) / 2);
  }

  function createSlotSkeletonItem() {
    const el = document.createElement("div");
    el.className = "schedule-play-item is-slot-item";
    el.setAttribute("aria-hidden", "true");
    const body = document.createElement("span");
    body.className = "schedule-play-item-body";
    const title = document.createElement("span");
    title.className = "schedule-play-item-title schedule-play-item-slot-label";
    title.textContent = "········";
    const sub = document.createElement("span");
    sub.className = "schedule-play-item-sub schedule-play-item-slot-label";
    sub.textContent = "············";
    body.append(title, sub);
    el.appendChild(body);
    return el;
  }

  function updateSlotSpinVisuals(translateY) {
    if (!listEl || !listTrackEl) return;
    const centerY = listEl.clientHeight / 2;
    let best = null;
    let bestDist = Infinity;
    for (const item of listTrackEl.children) {
      if (!(item instanceof HTMLElement)) continue;
      const itemCenter = item.offsetTop + LIST_ITEM_H / 2 + translateY;
      const dist = Math.abs(itemCenter - centerY);
      const t = Math.min(1, dist / (LIST_ITEM_STRIDE * 3.5));
      // Set opacity without CSS transition (disabled while spinning) for continuous feel.
      item.style.opacity = String(Math.max(0.2, 1 - t * t * (1 - 0.2)));
      if (dist < bestDist) {
        bestDist = dist;
        best = item;
      }
    }
    for (const item of listTrackEl.children) {
      if (!(item instanceof HTMLElement)) continue;
      item.classList.toggle("is-active", item === best);
    }
  }

  function stopSlotSpin() {
    slotSpinning = false;
    if (slotSpinRafId != null) {
      cancelAnimationFrame(slotSpinRafId);
      slotSpinRafId = null;
    }
    slotSpinStartMs = 0;
    listTrackEl?.classList.remove("is-slot-spinning");
    syncHeaderProgress();
  }

  function slotSpinOffsetAt(nowMs) {
    const centerOffset = listCenterOffset();
    if (!(slotSpinLoopH > 0)) return centerOffset - slotSpinAnchorTop;
    if (!slotSpinStartMs) slotSpinStartMs = nowMs;
    const scrolled = ((nowMs - slotSpinStartMs) / 1000) * SLOT_SPIN_PX_PER_SEC;
    // Modulo within one copy; anchor is the middle copy so above/below stay filled.
    const loopPos = ((scrolled % slotSpinLoopH) + slotSpinLoopH) % slotSpinLoopH;
    return centerOffset - slotSpinAnchorTop - loopPos;
  }

  function tickSlotSpin(nowMs) {
    if (!slotSpinning || !listTrackEl || !listEl) return;
    const offset = slotSpinOffsetAt(nowMs);
    listTrackEl.style.transform = `translate3d(0, ${offset}px, 0)`;
    updateSlotSpinVisuals(offset);
    slotSpinRafId = requestAnimationFrame(tickSlotSpin);
  }

  function measureSlotLoopHeight(itemsPerCopy) {
    if (!listTrackEl || itemsPerCopy <= 0) return itemsPerCopy * LIST_ITEM_STRIDE;
    const first = listTrackEl.children[0];
    const next = listTrackEl.children[itemsPerCopy];
    if (!(first instanceof HTMLElement) || !(next instanceof HTMLElement)) {
      return itemsPerCopy * LIST_ITEM_STRIDE;
    }
    const measured = next.offsetTop - first.offsetTop;
    return measured > 0 ? measured : itemsPerCopy * LIST_ITEM_STRIDE;
  }

  function startSlotSpin(count) {
    if (!listTrackEl || !listEl) return;
    stopSlotSpin();
    // One copy must fill the viewport; extras keep edges occupied across the wrap.
    const n = Math.max(visibleListSlotCount() + 2, Math.max(1, count));
    const midCopy = Math.floor(SLOT_SPIN_COPIES / 2);
    listTrackEl.replaceChildren();
    for (let copy = 0; copy < SLOT_SPIN_COPIES; copy += 1) {
      for (let i = 0; i < n; i += 1) {
        listTrackEl.appendChild(createSlotSkeletonItem());
      }
    }
    // Force layout before measuring copy height / middle-copy anchor.
    void listTrackEl.offsetHeight;
    slotSpinLoopH = measureSlotLoopHeight(n);
    const anchorEl = listTrackEl.children[midCopy * n];
    slotSpinAnchorTop =
      anchorEl instanceof HTMLElement ? anchorEl.offsetTop : midCopy * slotSpinLoopH;
    selectedIndex = 0;
    listTrackEl.classList.add("is-slot-spinning");
    listTrackEl.style.transition = "none";
    const startOffset = listCenterOffset() - slotSpinAnchorTop;
    listTrackEl.style.transform = `translate3d(0, ${startOffset}px, 0)`;
    updateSlotSpinVisuals(startOffset);
    syncListNavButtons();
    slotSpinning = true;
    slotSpinStartMs = 0;
    slotSpinRafId = requestAnimationFrame(tickSlotSpin);
    syncHeaderProgress();
  }

  function renderLoadingPlaceholders(count) {
    startSlotSpin(count);
  }

  function syncListNavButtons() {
    const count = windowCount();
    const locked = viewMode !== "play" || windowsLoading || slotSpinning;
    if (listUpBtn) listUpBtn.disabled = locked || selectedIndex <= 0 || count === 0;
    if (listDownBtn) listDownBtn.disabled = locked || selectedIndex < 0 || selectedIndex >= count - 1;
  }

  function updateListFade() {
    if (!listTrackEl) return;
    for (const item of listTrackEl.children) {
      if (!(item instanceof HTMLElement)) continue;
      const idx = Number(item.dataset.index);
      if (!Number.isFinite(idx)) continue;
      const dist = Math.abs(idx - selectedIndex);
      // Soften toward the ends, but keep the outermost cards partially visible
      // so the column mask gradient can show through them.
      const t = Math.min(1, dist / 3.5);
      const opacity = Math.max(0.22, 1 - t * t * (1 - 0.22));
      item.style.opacity = String(opacity);
    }
  }

  function syncListSelectionClasses() {
    if (!listTrackEl) return;
    for (const item of listTrackEl.children) {
      if (!(item instanceof HTMLElement)) continue;
      const idx = Number(item.dataset.index);
      const active = idx === selectedIndex;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", active ? "true" : "false");
    }
    updateListFade();
    syncListNavButtons();
  }

  function slideToIndex(index, options = {}) {
    if (!listEl || !listTrackEl || index < 0 || slotSpinning) return;
    const centerOffset = listCenterOffset();
    const y = centerOffset - index * LIST_ITEM_STRIDE;
    if (options.instant) {
      listTrackEl.style.transition = "none";
      listTrackEl.style.transform = `translateY(${y}px)`;
      // Force reflow so later smooth transitions work.
      void listTrackEl.offsetHeight;
      listTrackEl.style.transition = "";
      listAnimating = false;
      updateListFade();
      return;
    }
    listAnimating = true;
    listTrackEl.style.transition = "";
    listTrackEl.style.transform = `translateY(${y}px)`;
    window.setTimeout(() => {
      listAnimating = false;
      updateListFade();
    }, 300);
  }

  function stepWindow(dir) {
    if (viewMode !== "play" || windowsLoading || slotSpinning) return;
    const count = windowCount();
    if (!count) return;
    const next = Math.max(0, Math.min(count - 1, selectedIndex + dir));
    if (next === selectedIndex) return;
    void selectWindow(next, { fromSlide: true });
  }

  function renderList(options = {}) {
    if (!listEl || !listTrackEl || !payload) return;
    listTrackEl.replaceChildren();
    payload.windows.forEach((win, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "schedule-play-item";
      if (index === selectedIndex) btn.classList.add("is-active");
      btn.dataset.index = String(index);
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", index === selectedIndex ? "true" : "false");

      const dotsWrap = document.createElement("span");
      dotsWrap.className = "schedule-play-dots";
      dotsWrap.setAttribute("aria-hidden", "true");
      const tradeBuckets = windowTradeDots(win);
      if (tradeBuckets.length === 0) {
        const dot = document.createElement("span");
        dot.className = "schedule-play-dot is-none";
        dotsWrap.appendChild(dot);
      } else {
        for (const bucket of tradeBuckets) {
          const dot = document.createElement("span");
          dot.className = `schedule-play-dot is-${bucket}`;
          dotsWrap.appendChild(dot);
        }
      }

      const body = document.createElement("span");
      body.className = "schedule-play-item-body";

      const title = document.createElement("span");
      title.className = "schedule-play-item-title";
      title.textContent = formatUtcTime(win.windowStart);

      const sub = document.createElement("span");
      sub.className = "schedule-play-item-sub";
      const hitCount = (win.markers || []).filter(
        (m) => m && (m.type === "buy" || m.type === "sell"),
      ).length;
      sub.textContent = `${win.plLabel || "—"} · ${formatPnl(win.pnl)}${hitCount ? ` · ${hitCount} hits` : ""}`;

      body.append(title, sub);
      btn.append(dotsWrap, body);

      btn.addEventListener("click", () => {
        if (viewMode !== "play" || windowsLoading || slotSpinning) return;
        void selectWindow(index, { fromSlide: true });
      });
      listTrackEl.appendChild(btn);
    });
    slideToIndex(Math.max(0, selectedIndex), { instant: options.instant !== false });
    syncListSelectionClasses();
  }

  async function selectWindow(index, options = {}) {
    if (!payload?.windows?.[index]) return;
    const same = index === selectedIndex;
    const continueAutoPlay = options.continueAutoPlay === true && autoPlayWindows;
    stopPlayback({ keepAutoPlay: continueAutoPlay });

    // Keep scrubber position across windows (same elapsed fraction), unless
    // autoplay just finished this window and is advancing to the next.
    let elapsedFrac = 0;
    const prev = selectedIndex >= 0 ? payload.windows[selectedIndex] : null;
    if (prev && !continueAutoPlay) {
      const prevDur = windowDuration(prev);
      if (prevDur > 0) {
        elapsedFrac = Math.min(
          1,
          Math.max(0, (playheadSec - prev.windowStart) / prevDur),
        );
      }
    }

    selectedIndex = index;

    if (!listTrackEl?.children.length) {
      renderList({ instant: options.instant !== false });
    } else {
      syncListSelectionClasses();
      slideToIndex(index, { instant: Boolean(options.instant) });
    }

    if (same && priceHistory.length > 0 && !options.force) {
      drawFrame();
      if (continueAutoPlay) startPlayback();
      return;
    }

    const win = payload.windows[index];
    playheadSec = continueAutoPlay
      ? win.windowStart
      : win.windowStart + elapsedFrac * windowDuration(win);
    priceHistory = [];
    updateTransportEnabled();
    clearMetricsPanel();

    if (viewMode === "hits") {
      drawFrame();
      setStatus(`${payload.windows.length} windows`);
      return;
    }

    // Live Open: always try ticks (ledger rows may lack official open/close).
    // Replay: require official settlement before loading a price path.
    if (!liveMode && !hasOfficialSettlement(win)) {
      setTicksLoading(false);
      setStatus("No official settlement data for this window");
      drawFrame();
      if (continueAutoPlay) {
        if (index + 1 < windowCount()) {
          void selectWindow(index + 1, { fromSlide: true, continueAutoPlay: true });
        } else {
          stopPlayback();
        }
      }
      return;
    }

    setStatus("Loading price…");
    setTicksLoading(true);
    drawFrame();
    const token = ++loadToken;
    try {
      const [history] = await Promise.all([
        loadTicks(win.windowStart, win),
        loadBookQuotes(win.windowStart).catch(() => []),
      ]);
      if (token !== loadToken) return;
      // No mid-window Chainlink.
      // Live Open: keep the trade window (markers on blank timeline).
      // Replay: drop empty-path windows (false review without a price path).
      if (midWindowChainlinkCount(history, win) === 0) {
        priceHistory = [];
        setTicksLoading(false);
        updateTransportEnabled();
        if (liveMode || windowHasAnyHit(win)) {
          setStatus(
            windowHasAnyHit(win)
              ? "No Chainlink ticks — showing ledger trade markers"
              : "No Chainlink recording for this window",
          );
          drawFrame();
          if (continueAutoPlay) stopPlayback();
          return;
        }
        const removed = removeWindowAtIndex(index);
        if (!removed || windowCount() === 0) {
          setStatus("No Chainlink recording for this window");
          drawFrame();
          if (continueAutoPlay) stopPlayback();
          return;
        }
        setStatus("Skipped window with no Chainlink ticks");
        const nextIndex = Math.min(index, windowCount() - 1);
        void selectWindow(nextIndex, {
          fromSlide: true,
          continueAutoPlay,
          force: true,
        });
        return;
      }
      priceHistory = history;
      setTicksLoading(false);
      updateTransportEnabled();
      setStatus(`${history.length} price ticks`);
      drawFrame();
      if (continueAutoPlay) startPlayback();
      const next = payload.windows[index + 1];
      if (next && hasOfficialSettlement(next)) {
        if (!tickCache.has(String(next.windowStart))) {
          void loadTicks(next.windowStart, next).catch(() => {});
        }
        if (!bookQuoteCache.has(next.windowStart)) {
          void loadBookQuotes(next.windowStart).catch(() => {});
        }
      }
    } catch (err) {
      if (token !== loadToken) return;
      priceHistory = [];
      setTicksLoading(false);
      updateTransportEnabled();
      setStatus(err?.message || "Failed to load ticks");
      drawFrame();
      if (continueAutoPlay) stopPlayback();
    }
  }

  /** Remove an unusable window from the open session list. Returns true if removed. */
  function removeWindowAtIndex(index) {
    if (!payload?.windows || index < 0 || index >= payload.windows.length) return false;
    payload.windows.splice(index, 1);
    if (selectedIndex > index) selectedIndex -= 1;
    else if (selectedIndex >= payload.windows.length) {
      selectedIndex = Math.max(0, payload.windows.length - 1);
    }
    renderList({ instant: true });
    syncHeaderProgress();
    return true;
  }

  function bindControls() {
    $("schedule-play-close")?.addEventListener("click", close);
    modal?.addEventListener("click", (e) => {
      if (e.target === modal) close();
    });
    playBtn?.addEventListener("click", () => togglePlay());
    $("schedule-play-step-back")?.addEventListener("click", () => stepFrame(-1));
    $("schedule-play-step-fwd")?.addEventListener("click", () => stepFrame(1));
    viewPlayBtn?.addEventListener("click", () => {
      setViewMode("play");
      const win = selectedWindow();
      if (win && priceHistory.length === 0) void selectWindow(selectedIndex);
    });
    viewHitsBtn?.addEventListener("click", () => setViewMode("hits"));
    listUpBtn?.addEventListener("click", () => stepWindow(-1));
    listDownBtn?.addEventListener("click", () => stepWindow(1));
    listEl?.addEventListener(
      "wheel",
      (e) => {
        if (viewMode !== "play" || !windowCount()) return;
        e.preventDefault();
        if (listAnimating) return;
        const dir = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
        if (dir) stepWindow(dir);
      },
      { passive: false },
    );
    listEl?.addEventListener("keydown", (e) => {
      if (viewMode !== "play" || !windowCount()) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        stepWindow(e.key === "ArrowDown" ? 1 : -1);
      }
    });
    chartWrap?.addEventListener("mousemove", (e) => {
      if (e.target === scrubber || scrubber?.contains(e.target)) {
        hideHitTooltip();
        hidePhaseHover();
        return;
      }
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      updateHitHover(e.clientX, e.clientY);
      const onMarker = Boolean(hitTargetAt(x, y));
      if (onMarker) hidePhaseHover();
      else updatePhaseHover(x);
      if (!onMarker && playChartLayout && playSetup()) {
        canvas.style.cursor = "pointer";
      }
    });
    chartWrap?.addEventListener("mouseleave", () => {
      hideHitTooltip();
      hidePhaseHover();
    });
    chartWrap?.addEventListener("click", (e) => {
      if (scrubbing) return;
      if (viewMode !== "play" && viewMode !== "hits") return;
      if (e.target === scrubber || scrubber?.contains(e.target)) return;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (hitTargetAt(x, y)) return;
      openPhaseAtCanvasX(x);
    });
    scrubber?.addEventListener("pointerdown", (e) => {
      if (viewMode !== "play" || !isGraphReady()) return;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      stopPlayback();
      scrubbing = true;
      scrubber.classList.add("is-dragging");
      document.body.classList.add("is-schedule-dragging");
      hideHitTooltip();
      hidePhaseHover();
      scrubber.setPointerCapture(e.pointerId);
      scrubFromPointer(e.clientX, e.clientY);
    });
    scrubber?.addEventListener("pointermove", (e) => {
      if (!scrubbing) return;
      scrubFromPointer(e.clientX, e.clientY);
    });
    scrubber?.addEventListener("pointerup", (e) => endScrub(e.pointerId));
    scrubber?.addEventListener("pointercancel", (e) => endScrub(e.pointerId));
    scrubber?.addEventListener("keydown", (e) => {
      if (!isGraphReady()) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepFrame(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepFrame(1);
      } else if (e.key === "Home") {
        const win = selectedWindow();
        if (!win) return;
        e.preventDefault();
        stopPlayback();
        setPlayhead(win.windowStart);
      } else if (e.key === "End") {
        const win = selectedWindow();
        if (!win) return;
        e.preventDefault();
        stopPlayback();
        setPlayhead(win.windowEnd || win.windowStart + 300);
      }
    });
    document.addEventListener("keydown", (e) => {
      if (!modal || modal.hidden) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === " ") {
        if (!isGraphReady()) return;
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        if (!isGraphReady()) return;
        e.preventDefault();
        stepFrame(-1);
      } else if (e.key === "ArrowRight") {
        if (!isGraphReady()) return;
        e.preventDefault();
        stepFrame(1);
      } else if (e.key === "ArrowUp") {
        if (viewMode !== "play") return;
        e.preventDefault();
        stepWindow(-1);
      } else if (e.key === "ArrowDown") {
        if (viewMode !== "play") return;
        e.preventDefault();
        stepWindow(1);
      } else if (e.key === "h" || e.key === "H") {
        if (!windowsLoaded()) return;
        e.preventDefault();
        setViewMode(viewMode === "hits" ? "play" : "hits");
      }
    });
  }

  function close() {
    stopPlayback();
    endScrub(null);
    loadToken += 1;
    priceHistory = [];
    hoverTargets = [];
    playChartLayout = null;
    liveMode = false;
    playPredictionSensitivitySec = null;
    hidePhaseHover();
    clearHitsHighlight();
    stopSlotSpin();
    ticksLoading = false;
    stopHeaderLoadProgress();
    clearHeaderLoadCompleteTimer();
    headerLoadProgress = 0;
    headerLoadFinishing = false;
    setWindowsLoading(false);
    hideHitTooltip();
    window.Simulator?.discardPhaseModal?.();
    window.Simulator?.endExternalPhaseEdit?.();
    hideHeaderProgress();
    clearMetricsPanel();
    updateTransportEnabled();
    if (modal) modal.hidden = true;
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
  }

  async function open(placementId, options = {}) {
    ensureEls();
    if (!modal || !placementId) return;
    const openToken = ++loadToken;
    stopPlayback();
    payload = null;
    liveMode = options.live === true;
    selectedIndex = -1;
    priceHistory = [];
    tickCache.clear();
    bookQuoteCache.clear();
    playheadSec = 0;
    viewMode = "play";
    clearHitsHighlight();
    if (metaEl) metaEl.textContent = "—";
    clearMetricsPanel();
    setStatus("Loading windows…");
    setWindowsLoading(true, "Loading windows…");
    updateViewChrome();
    updateTransportEnabled();
    modal.hidden = false;

    playSeries =
      typeof options.series === "string" && options.series.trim()
        ? options.series.trim()
        : window.getSelectedSeries?.() || "btc-5m";
    const openPredSens = Number(options.prediction?.sensitivitySec);
    playPredictionSensitivitySec =
      Number.isFinite(openPredSens) && openPredSens >= 1
        ? Math.min(120, Math.round(openPredSens))
        : null;

    const wrap = $("schedule-play-chart-wrap");
    if (wrap && window.ResizeObserver) {
      resizeObserver?.disconnect();
      let lastRoW = -1;
      let lastRoH = -1;
      let roRaf = 0;
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        const box = entry?.contentRect;
        const w = Math.round(box?.width ?? wrap.clientWidth);
        const h = Math.round(box?.height ?? wrap.clientHeight);
        if (w === lastRoW && h === lastRoH) return;
        lastRoW = w;
        lastRoH = h;
        if (roRaf) cancelAnimationFrame(roRaf);
        roRaf = requestAnimationFrame(() => {
          roRaf = 0;
          drawFrame();
          if (slotSpinning) return;
          if (selectedIndex >= 0) {
            slideToIndex(selectedIndex, { instant: true });
            syncListSelectionClasses();
          }
        });
      });
      resizeObserver.observe(wrap);
      if (listEl) resizeObserver.observe(listEl);
    }

    // Slot-machine scroll while the play payload loads.
    renderLoadingPlaceholders(placeholderCount(options.windowCountHint));
    drawFrame();

    try {
      const latencyMs =
        typeof options.latencyMs === "number" && Number.isFinite(options.latencyMs)
          ? Math.max(0, Math.min(10000, Math.floor(options.latencyMs)))
          : 150;
      const fillSuccessPct =
        typeof options.fillSuccessPct === "number" && Number.isFinite(options.fillSuccessPct)
          ? Math.max(0, Math.min(100, options.fillSuccessPct))
          : 100;
      const series =
        typeof options.series === "string" && options.series.trim()
          ? options.series.trim()
          : currentSeries();
      const res = await fetch(
        `/api/schedule-placements/${encodeURIComponent(placementId)}/play`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            series,
            latencyMs,
            fillSuccessPct,
            setup: options.setup ?? null,
            prediction: options.prediction ?? null,
            triggers: Array.isArray(options.triggers) ? options.triggers : undefined,
            live: options.live === true,
            recordingsOnly: options.recordingsOnly === true,
          }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (openToken !== loadToken) return;
      if (!res.ok) throw new Error(body.error || `Open Replay failed (${res.status})`);
      payload = body;
      liveMode = options.live === true;
      // Replay: drop ledger-only / missing-tick rows. Live Open keeps them (trade windows).
      if (!liveMode && Array.isArray(payload.windows)) {
        payload.windows = payload.windows.filter((w) => w && w.recordingMissing !== true);
      }
      const titleEl = $("schedule-play-title");
      if (titleEl) {
        const prefix = liveMode ? "Live Open" : "Open Replay";
        titleEl.textContent = `${prefix} · ${body.title || "Placement"}`;
      }
      if (!payload.windows?.length) {
        stopSlotSpin();
        selectedIndex = -1;
        if (listTrackEl) listTrackEl.replaceChildren();
        syncListNavButtons();
        setWindowsLoading(false);
        setStatus(
          liveMode
            ? "No traded windows in this hour"
            : "No recorded windows with Chainlink ticks in this card",
        );
        drawFrame();
        return;
      }
      stopSlotSpin();
      setWindowsLoading(false);
      setStatus(`${body.windows.length} window${body.windows.length === 1 ? "" : "s"}`);
      if (listTrackEl) listTrackEl.replaceChildren();
      const startIndex = firstHitOrZeroIndex(body.windows);
      // Settle onto the target window with a slide (slot-machine stop).
      await selectWindow(startIndex, { instant: false });
    } catch (err) {
      if (openToken !== loadToken) return;
      stopSlotSpin();
      selectedIndex = -1;
      if (listTrackEl) listTrackEl.replaceChildren();
      syncListNavButtons();
      setWindowsLoading(false);
      setStatus(err?.message || "Failed to open play");
      drawFrame();
    }
  }

  function init() {
    ensureEls();
    if (!modal || modal.dataset.bound === "1") return;
    modal.dataset.bound = "1";
    bindControls();
  }

  window.SchedulePlay = {
    init,
    open,
    close,
  };
})();
