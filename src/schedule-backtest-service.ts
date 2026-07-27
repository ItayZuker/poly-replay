import { getRecordedWindow, getWindowDataVersion } from "./db/recorded-window-repository.js";
import { listRecordedWindowsSince } from "./db/recorded-window-mongo-repository.js";
import { getTradingSetupById } from "./db/trading-setup-repository.js";
import type { SchedulePlacementListItem } from "./db/schedule-placement-repository.js";
import { listReplayTicks } from "./db/replay-tick-repository.js";
import { listChainlinkTicks } from "./db/tick-repository.js";
import { getWeekHistoryCutoffUtcSec } from "./heatmap-service.js";
import { selectLatestDayHourWindows } from "./day-hour-slots.js";
import { defaultPhaseConfig, recordAskSamples } from "./phase-config.js";
import { SimulatorEngine } from "./simulator-engine.js";
import { phaseSetupToSimSetup } from "./simulator-service.js";
import {
  buildPlacementCacheKey,
  getCachedPlacementStats,
  rollingCutoffDayUtc,
  flushPlacementStatsCache,
} from "./schedule-backtest-cache.js";
import { discardBadRecording } from "./bad-recording-cleanup.js";
import { logService } from "./log-service.js";
import { isFlatPriceFromTicks, isFlatPriceWindow } from "./window-dynamics.js";
import type {
  ChainlinkTickDocument,
  LiveWindowState,
  MarketDocument,
  RecordedWindowDocument,
  ReplayTickDocument,
  ScheduleDayId,
  SimLastWindow,
  SimMarker,
  SimSetup,
  TradingPhaseSetup,
  WindowOutcome,
} from "./types.js";

const UTC_DAY_TO_ID: ScheduleDayId[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Schedule columns left → right (Mon … Sun). */
const SCHEDULE_DAY_ORDER: Record<ScheduleDayId, number> = {
  mon: 0,
  tue: 1,
  wed: 2,
  thu: 3,
  fri: 4,
  sat: 5,
  sun: 6,
};

/**
 * Parallel window sims. Keep low: Dropbox + large jsonl reads stall badly when
 * several multi‑MB tick files are opened at once (Sat/Sun never finish).
 */
const WINDOW_SIM_CONCURRENCY = 1;

/** Top-left first: Monday→Sunday columns, then earlier start hour. */
export function sortPlacementsTopLeft(
  placements: SchedulePlacementListItem[],
): SchedulePlacementListItem[] {
  return [...placements].sort((a, b) => {
    const dayDiff =
      (SCHEDULE_DAY_ORDER[a.day as ScheduleDayId] ?? 99) -
      (SCHEDULE_DAY_ORDER[b.day as ScheduleDayId] ?? 99);
    if (dayDiff !== 0) return dayDiff;
    if (a.startHour !== b.startHour) return a.startHour - b.startHour;
    if (a.durationHours !== b.durationHours) return a.durationHours - b.durationHours;
    return String(a._id).localeCompare(String(b._id));
  });
}

export interface PlacementBacktestStats {
  placementId: string;
  hasData: boolean;
  green: number;
  red: number;
  blue: number;
  /** Windows simulated with ticks where no buy triggered (Replay gray dot). */
  gray: number;
  pnl: number;
}

export interface BacktestProgress {
  completed: number;
  total: number;
  /** When true, the UI should show an indeterminate animation. */
  indeterminate?: boolean;
}

export interface BacktestScheduleOptions {
  onProgress?: (progress: BacktestProgress) => void;
  /** Fired when each placement finishes (for SSE streaming). */
  onPlacementComplete?: (stats: PlacementBacktestStats) => void;
  shouldAbort?: () => boolean;
  /** When set, only placements using this setup are simulated; others are read from cache. */
  recomputeSetupId?: string;
  /**
   * When true, skip disk/memory placement-stats cache and always re-simulate.
   * Used for interactive Replay so UI always applies current setups to recordings.
   */
  forceResimulate?: boolean;
  tickCache?: Map<number, ReplayTickDocument[]>;
  /**
   * Prefer these phase setups (from the Replay request body) over Mongo.
   * Keys are setup ids.
   */
  setupsById?: Map<string, TradingPhaseSetup | null> | Record<string, TradingPhaseSetup | null>;
  /** 0–100: probability each would-be fill succeeds after latency. Default 100. */
  fillSuccessPct?: number;
}

type OutcomeBucket = "green" | "red" | "blue" | "none";

/** In-process cache: last Replay window list per user/placement (for Open Replay). */
const rememberedPlayByUser = new Map<string, Map<string, PlacementPlayPayload>>();

export function rememberPlacementPlay(userId: string, payload: PlacementPlayPayload): void {
  let byPlacement = rememberedPlayByUser.get(userId);
  if (!byPlacement) {
    byPlacement = new Map();
    rememberedPlayByUser.set(userId, byPlacement);
  }
  byPlacement.set(payload.placementId, payload);
}

export function getRememberedPlacementPlay(
  userId: string,
  placementId: string,
): PlacementPlayPayload | null {
  return rememberedPlayByUser.get(userId)?.get(placementId) ?? null;
}

export function clearRememberedPlacementPlay(userId: string, placementId: string): void {
  rememberedPlayByUser.get(userId)?.delete(placementId);
}

type WindowSimCacheEntry = {
  result: SimLastWindow | null;
  markers: SimMarker[];
};

function simSetupCacheKey(setup: SimSetup): string {
  return JSON.stringify(setup);
}

function windowSimCacheKey(windowStart: number, setup: SimSetup): string {
  return `${windowStart}|${simSetupCacheKey(setup)}`;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

function countSimOpsPerWindow(plans: PlacementPlan[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const plan of plans) {
    if (plan.kind !== "simulate") continue;
    for (const window of plan.slotWindows) {
      counts.set(window.windowStart, (counts.get(window.windowStart) ?? 0) + 1);
    }
  }
  return counts;
}

function releaseWindowTicks(
  windowStart: number,
  tickCache: Map<number, ReplayTickDocument[]>,
  tickUseRemaining: Map<number, number>,
): void {
  const left = (tickUseRemaining.get(windowStart) ?? 1) - 1;
  if (left <= 0) {
    tickUseRemaining.delete(windowStart);
    tickCache.delete(windowStart);
    return;
  }
  tickUseRemaining.set(windowStart, left);
}

/**
 * True when a recorded window belongs on this schedule card:
 * same UTC weekday as the column, and start time inside the card’s hour span.
 * Caller should already have selected latest day-per-hour windows.
 */
function windowMatchesPlacementSlot(
  windowStart: number,
  day: ScheduleDayId,
  startHour: number,
  durationHours: number,
): boolean {
  const date = new Date(windowStart * 1000);
  if (UTC_DAY_TO_ID[date.getUTCDay()] !== day) return false;
  const windowMinutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const slotStartMinutes = startHour * 60;
  const slotEndMinutes = (startHour + durationHours) * 60;
  return windowMinutes >= slotStartMinutes && windowMinutes < slotEndMinutes;
}

function replayTickToState(
  tick: ReplayTickDocument,
  series: string,
  windowStart: number,
  windowEnd: number,
  priceHistory: Array<{ t: number; price: number }>,
): LiveWindowState {
  // Prefer stored gap; otherwise derive like live Chainlink ingest.
  let assetGap = tick.assetGap;
  if (
    (assetGap == null || !Number.isFinite(assetGap)) &&
    tick.assetPrice != null &&
    tick.prevCloseAsset != null &&
    Number.isFinite(tick.assetPrice) &&
    Number.isFinite(tick.prevCloseAsset)
  ) {
    assetGap = tick.assetPrice - tick.prevCloseAsset;
  }
  return {
    series,
    windowStart,
    windowEnd,
    lastTickMs: tick.tMs,
    yesBid: tick.yesBid,
    yesAsk: tick.yesAsk,
    noBid: tick.noBid,
    noAsk: tick.noAsk,
    yesBidSize: tick.yesBidSize,
    yesAskSize: tick.yesAskSize,
    noBidSize: tick.noBidSize,
    noAskSize: tick.noAskSize,
    yesBids: tick.yesBids,
    yesAsks: tick.yesAsks,
    noBids: tick.noBids,
    noAsks: tick.noAsks,
    assetPrice: tick.assetPrice,
    prevCloseAsset: tick.prevCloseAsset,
    assetGap,
    ptbCrossings: tick.ptbCrossings,
    minAssetPrice: tick.minAssetPrice,
    maxAssetPrice: tick.maxAssetPrice,
    assetRange: tick.assetRange,
    priceHistory,
  };
}

export function classifyWindow(result: SimLastWindow | null): OutcomeBucket {
  if (!result || result.plLabel === "No trade") return "none";
  if (result.sold) return result.pl > 0 ? "green" : "red";
  return result.positionWon ? "blue" : "red";
}

export interface RecordedWindowSimulation {
  result: SimLastWindow | null;
  markers: SimMarker[];
  windowStart: number;
  windowEnd: number;
  /** False when window metadata exists but tick files are missing/empty on disk. */
  hadTicks: boolean;
}

export async function simulateRecordedWindow(
  market: MarketDocument,
  series: string,
  window: RecordedWindowDocument,
  setup: SimSetup,
  tickCache?: Map<number, ReplayTickDocument[]>,
  simResultCache?: Map<string, WindowSimCacheEntry>,
): Promise<RecordedWindowSimulation> {
  const simCacheKey = simResultCache ? windowSimCacheKey(window.windowStart, setup) : null;
  if (simCacheKey && simResultCache!.has(simCacheKey)) {
    const cached = simResultCache!.get(simCacheKey)!;
    return {
      result: cached.result,
      markers: cached.markers.map((m) => ({ ...m })),
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      // Cached entries were only stored after a tickful sim.
      hadTicks: true,
    };
  }

  let ticks = tickCache?.get(window.windowStart);
  if (!ticks) {
    ticks = await listReplayTicks(market, window.windowStart, 50_000);
    tickCache?.set(window.windowStart, ticks);
  }
  const windowEnd = window.windowEnd;
  const windowStart = window.windowStart;

  if (ticks.length === 0) {
    // Do not cache empties as sim results — missing files must stay distinguishable.
    return {
      result: null,
      markers: [],
      windowStart,
      windowEnd,
      hadTicks: false,
    };
  }

  // Stuck/flat Chainlink for the whole window — discard and skip Replay.
  if (isFlatPriceWindow(window) || isFlatPriceFromTicks(ticks)) {
    tickCache?.delete(windowStart);
    await discardBadRecording(series, windowStart, "flat asset price (replay)");
    return {
      result: null,
      markers: [],
      windowStart,
      windowEnd,
      hadTicks: false,
    };
  }

  // Mute per-fill/GTD spam — otherwise Replay floods SSE/console and freezes the UI.
  return logService.runWithMutedSources(["sim"], () => {
    const engine = new SimulatorEngine();
    const priceHistory: Array<{ t: number; price: number }> = [];
    let bookTickSequence = 0;

    for (const tick of ticks) {
      if (tick.tMs >= windowEnd * 1000) break;
      // Same series as live heatmap: append on each Chainlink sample (incl. same $).
      if (
        tick.source === "chainlink-tick" &&
        tick.assetPrice != null &&
        Number.isFinite(tick.assetPrice)
      ) {
        priceHistory.push({ t: tick.t, price: tick.assetPrice });
        if (priceHistory.length > 2000) {
          priceHistory.splice(0, priceHistory.length - 2000);
        }
      }
      const state = replayTickToState(tick, series, windowStart, windowEnd, priceHistory);
      state.bookTickSequence = bookTickSequence;
      if (tick.source === "clob-book") {
        recordAskSamples(state);
        bookTickSequence = state.bookTickSequence ?? bookTickSequence;
      }
      engine.tick(state, setup, tick.tMs);
    }

    const lastInWindow =
      [...ticks].reverse().find((t) => t.tMs < windowEnd * 1000) ?? ticks[ticks.length - 1];
    const endMs = windowEnd * 1000 - 1;
    const endState = replayTickToState(lastInWindow, series, windowStart, windowEnd, priceHistory);
    endState.bookTickSequence = bookTickSequence;
    if (lastInWindow.source === "clob-book") {
      recordAskSamples(endState);
    }
    engine.tick({ ...endState, lastTickMs: endMs }, setup, endMs);

    // Settle from stored Polymarket outcome in window JSON (backfilled / recorded at finalize).
    const result = engine.finalizeWindow(
      window.windowOutcome ? { outcome: window.windowOutcome } : undefined,
    );
    const markers = engine.getMarkers();

    if (simCacheKey) {
      simResultCache!.set(simCacheKey, {
        result: result ?? null,
        markers: markers.map((m) => ({ ...m })),
      });
    }

    return {
      result,
      markers,
      windowStart,
      windowEnd,
      hadTicks: true,
    };
  });
}

function emptyStats(placementId: string): PlacementBacktestStats {
  return {
    placementId,
    hasData: false,
    green: 0,
    red: 0,
    blue: 0,
    gray: 0,
    pnl: 0,
  };
}

function aggregateResult(
  placementId: string,
  results: Array<SimLastWindow | null>,
): PlacementBacktestStats {
  let green = 0;
  let red = 0;
  let blue = 0;
  let gray = 0;
  let pnl = 0;

  for (const result of results) {
    const bucket = classifyWindow(result);
    if (bucket === "green") green += 1;
    else if (bucket === "red") red += 1;
    else if (bucket === "blue") blue += 1;
    else gray += 1;
    if (result) pnl += result.pl ?? 0;
  }

  return {
    placementId,
    hasData: true,
    green,
    red,
    blue,
    gray,
    pnl: Number.isFinite(pnl) ? pnl : 0,
  };
}

type PlacementPlan =
  | {
      placement: SchedulePlacementListItem;
      cacheKey: string;
      kind: "cached";
      stats: PlacementBacktestStats;
    }
  | {
      placement: SchedulePlacementListItem;
      cacheKey: string;
      kind: "empty";
    }
  | {
      placement: SchedulePlacementListItem;
      cacheKey: string;
      kind: "simulate";
      slotWindows: RecordedWindowDocument[];
      simSetup: SimSetup;
    };

function workUnitsForPlan(plan: PlacementPlan): number {
  if (plan.kind === "simulate") return plan.slotWindows.length;
  return 1;
}

async function buildPlacementPlan(
  placement: SchedulePlacementListItem,
  input: {
    series: string;
    phaseSetup: TradingPhaseSetup | null;
    latencyMs: number;
    fillSuccessPct: number;
    heatmapVersion: string;
    cutoffDay: string;
    cutoffUtc: number;
    allWindows: RecordedWindowDocument[];
    allowCached: boolean;
  },
): Promise<PlacementPlan> {
  const {
    series,
    phaseSetup,
    latencyMs,
    fillSuccessPct,
    heatmapVersion,
    cutoffDay,
    cutoffUtc,
    allWindows,
    allowCached,
  } = input;
  const cacheKey = buildPlacementCacheKey({
    series,
    placement,
    phaseSetup,
    latencyMs,
    fillSuccessPct,
    heatmapVersion,
    cutoffDay,
  });

  if (allowCached) {
    const cached = await getCachedPlacementStats(series, placement._id, cacheKey);
    if (cached) {
      return { placement, cacheKey, kind: "cached", stats: cached };
    }
  }

  if (!phaseSetup) {
    return { placement, cacheKey, kind: "empty" };
  }

  const slotWindows = allWindows.filter((w) =>
    windowMatchesPlacementSlot(
      w.windowStart,
      placement.day,
      placement.startHour,
      placement.durationHours,
    ),
  );

  if (slotWindows.length === 0) {
    return { placement, cacheKey, kind: "empty" };
  }

  const windowDuration =
    slotWindows[0]?.windowEnd && slotWindows[0]?.windowStart
      ? slotWindows[0].windowEnd - slotWindows[0].windowStart
      : undefined;
  const simSetup = phaseSetupToSimSetup(phaseSetup, latencyMs, windowDuration, fillSuccessPct);
  return { placement, cacheKey, kind: "simulate", slotWindows, simSetup };
}

export async function backtestSchedulePlacements(
  userId: string,
  market: MarketDocument,
  placements: SchedulePlacementListItem[],
  latencyMs: number,
  options: BacktestScheduleOptions = {},
): Promise<PlacementBacktestStats[]> {
  if (placements.length === 0) return [];

  const rawFillPct = options.fillSuccessPct;
  const fillSuccessPct =
    typeof rawFillPct === "number" && Number.isFinite(rawFillPct)
      ? Math.max(0, Math.min(100, rawFillPct))
      : 100;

  // Always process Mon/top → Sun/bottom so the board fills left-to-right.
  placements = sortPlacementsTopLeft(placements);

  options.onProgress?.({ completed: 0, total: 0, indeterminate: true });

  const series = market._id;
  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  const cutoffDay = rollingCutoffDayUtc();
  // Same Mongo window index as the heatmap — keep ~2 weeks, then for each
  // weekday×hour keep only the latest calendar day (missed hours keep last week).
  const listed = await listRecordedWindowsSince(cutoffUtc, series);
  const allWindows: RecordedWindowDocument[] = selectLatestDayHourWindows(
    listed.filter((w) => !isFlatPriceWindow(w)),
  ).map((w) => ({
    _id: String(w.windowStart),
    windowStart: w.windowStart,
    windowEnd: w.windowEnd,
    savedAt: w.savedAt,
    updatedAt: w.savedAt,
    windowOutcome: w.windowOutcome,
    ptbCrossings: w.ptbCrossings,
    rangeTop: w.rangeTop,
    rangeBottom: w.rangeBottom,
    uniqueTraders: w.uniqueTraders,
    newWallets: w.newWallets,
    minAssetPrice: w.minAssetPrice,
    maxAssetPrice: w.maxAssetPrice,
    assetRange: w.assetRange,
    tickCount: 0,
  }));
  const heatmapVersion = await getWindowDataVersion(market, allWindows);
  const livePlacementIds = placements.map((p) => p._id);
  const tickCache = options.tickCache ?? new Map<number, ReplayTickDocument[]>();
  const recomputeSetupId = options.recomputeSetupId;
  const forceResimulate = options.forceResimulate === true;
  // Interactive Replay must re-run recordings + setups; cache is only for background recompute.
  const allowCached = !forceResimulate && !recomputeSetupId;

  logService.info(
    "replay",
    `Replay dataset: ${allWindows.length} recorded window(s) since cutoff; ${placements.length} card(s); cache=${allowCached ? "on" : "off"}`,
  );

  const setupCache = new Map<string, TradingPhaseSetup | null>();
  const providedSetups =
    options.setupsById instanceof Map
      ? options.setupsById
      : options.setupsById
        ? new Map(Object.entries(options.setupsById))
        : null;
  const uniqueSetupIds = [...new Set(placements.map((p) => p.setupId))];
  await Promise.all(
    uniqueSetupIds.map(async (setupId) => {
      if (providedSetups?.has(setupId)) {
        setupCache.set(setupId, providedSetups.get(setupId) ?? null);
        return;
      }
      // Replay workspace setups — never fall back to live collections by accident.
      const setup = await getTradingSetupById(userId, setupId, "replay");
      setupCache.set(setupId, setup?.setup ?? null);
    }),
  );

  const statsById = new Map<string, PlacementBacktestStats>();
  const simulateTargets: SchedulePlacementListItem[] = [];

  if (recomputeSetupId && !forceResimulate) {
    for (const placement of placements) {
      if (placement.setupId === recomputeSetupId) {
        simulateTargets.push(placement);
        continue;
      }
      const phaseSetup = setupCache.get(placement.setupId) ?? null;
      const cacheKey = buildPlacementCacheKey({
        series,
        placement,
        phaseSetup,
        latencyMs,
        fillSuccessPct,
        heatmapVersion,
        cutoffDay,
      });
      const cached = await getCachedPlacementStats(series, placement._id, cacheKey);
      if (cached) {
        statsById.set(placement._id, cached);
      } else {
        simulateTargets.push(placement);
      }
    }
  } else {
    simulateTargets.push(...placements);
  }

  const planInput = {
    series,
    latencyMs,
    fillSuccessPct,
    heatmapVersion,
    cutoffDay,
    cutoffUtc,
    allWindows,
    allowCached,
  };

  const plans: PlacementPlan[] = [];
  for (const placement of simulateTargets) {
    const phaseSetup = setupCache.get(placement.setupId) ?? null;
    plans.push(
      await buildPlacementPlan(placement, {
        ...planInput,
        phaseSetup,
      }),
    );
  }

  const simResultCache = new Map<string, WindowSimCacheEntry>();
  const tickUseRemaining = countSimOpsPerWindow(plans);
  const totalUnits = plans.reduce((sum, plan) => sum + workUnitsForPlan(plan), 0);
  let completedUnits = 0;

  const reportProgress = (indeterminate = false) => {
    if (totalUnits <= 0 && !indeterminate) return;
    options.onProgress?.({
      completed: completedUnits,
      total: totalUnits,
      indeterminate,
    });
  };

  if (totalUnits > 0) {
    reportProgress(false);
  }

  const cacheUpdates: Array<{
    placementId: string;
    cacheKey: string;
    stats: PlacementBacktestStats;
  }> = [];

  let cardIndex = 0;
  for (const plan of plans) {
    if (options.shouldAbort?.()) break;
    cardIndex += 1;
    const label = `${plan.placement.day} @ ${plan.placement.startHour}h`;

    if (plan.kind === "cached") {
      statsById.set(plan.placement._id, plan.stats);
      completedUnits += 1;
      reportProgress(false);
      options.onPlacementComplete?.(plan.stats);
      continue;
    }

    if (plan.kind === "empty") {
      const computed = emptyStats(plan.placement._id);
      statsById.set(plan.placement._id, computed);
      clearRememberedPlacementPlay(userId, plan.placement._id);
      if (allowCached) {
        cacheUpdates.push({ placementId: plan.placement._id, cacheKey: plan.cacheKey, stats: computed });
      }
      completedUnits += 1;
      reportProgress(false);
      const setupMissing = !(setupCache.get(plan.placement.setupId) ?? null);
      logService.info(
        "replay",
        `Card ${cardIndex}/${plans.length} ${label} — ${
          setupMissing ? "missing setup (skipped)" : "no recorded windows in slot"
        }`,
      );
      options.onPlacementComplete?.(computed);
      continue;
    }

    logService.info(
      "replay",
      `Card ${cardIndex}/${plans.length} ${label} — simulating ${plan.slotWindows.length} window(s) from recordings + setup`,
    );

    const windowResults = await mapWithConcurrency(
      plan.slotWindows,
      WINDOW_SIM_CONCURRENCY,
      async (window) => {
        if (options.shouldAbort?.()) return null;
        try {
          const sim = await simulateRecordedWindow(
            market,
            market._id,
            window,
            plan.simSetup,
            tickCache,
            simResultCache,
          );
          releaseWindowTicks(window.windowStart, tickCache, tickUseRemaining);
          completedUnits += 1;
          reportProgress(false);
          return sim;
        } catch (err) {
          logService.warn(
            "replay",
            `Card ${cardIndex}/${plans.length} ${label} — window ${window.windowStart} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          releaseWindowTicks(window.windowStart, tickCache, tickUseRemaining);
          completedUnits += 1;
          reportProgress(false);
          return {
            result: null,
            markers: [],
            windowStart: window.windowStart,
            windowEnd: window.windowEnd,
            hadTicks: false,
          } satisfies RecordedWindowSimulation;
        }
      },
    );

    const finished = windowResults.filter(
      (sim): sim is RecordedWindowSimulation => sim != null,
    );
    const withTicks = finished.filter((sim) => sim.hadTicks);
    // Include null results so “ran, no buy” windows count toward gray.
    const results = withTicks.map((sim) => sim.result);

    // Window metadata without tick files must not look like “ran, no trades”.
    if (withTicks.length === 0) {
      const computed = emptyStats(plan.placement._id);
      statsById.set(plan.placement._id, computed);
      clearRememberedPlacementPlay(userId, plan.placement._id);
      if (allowCached) {
        cacheUpdates.push({
          placementId: plan.placement._id,
          cacheKey: plan.cacheKey,
          stats: computed,
        });
      }
      logService.info(
        "replay",
        `Card ${cardIndex}/${plans.length} ${label} — ${plan.slotWindows.length} window(s) in slot but tick files missing on disk`,
      );
      options.onPlacementComplete?.(computed);
    } else {
      const computed = aggregateResult(plan.placement._id, results);
      statsById.set(plan.placement._id, computed);
      if (allowCached) {
        cacheUpdates.push({
          placementId: plan.placement._id,
          cacheKey: plan.cacheKey,
          stats: computed,
        });
      }
      const phaseSetup = setupCache.get(plan.placement.setupId);
      if (phaseSetup) {
        rememberPlacementPlay(userId, {
          placementId: plan.placement._id,
          setupId: plan.placement.setupId,
          title: plan.placement.title,
          day: plan.placement.day,
          startHour: plan.placement.startHour,
          durationHours: plan.placement.durationHours,
          setup: phaseSetup,
          latencyMs,
          fillSuccessPct,
          windows: await playWindowsFromSims(market, withTicks, plan.slotWindows),
        });
      }
      logService.info(
        "replay",
        `Card ${cardIndex}/${plans.length} ${label} — done (g${computed.green}/r${computed.red}/b${computed.blue}/gray${computed.gray} pnl ${computed.pnl.toFixed(2)}; ${withTicks.length}/${plan.slotWindows.length} windows with ticks)`,
      );
      options.onPlacementComplete?.(computed);
    }

    // Let SSE/progress flush between cards (Node otherwise stays CPU-bound).
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (options.shouldAbort?.()) break;
  }

  if (cacheUpdates.length > 0) {
    await flushPlacementStatsCache(series, cacheUpdates, livePlacementIds);
  }

  // Only return cards that were actually processed. Filling the rest with emptyStats
  // made aborted runs look like Sat/Sun finished with zeros.
  return placements
    .map((placement) => statsById.get(placement._id))
    .filter((stats): stats is PlacementBacktestStats => stats != null);
}

export type PlayOutcomeBucket = OutcomeBucket;

export interface PlacementPlayWindowItem {
  windowStart: number;
  windowEnd: number;
  prevCloseAsset?: number;
  /** Official market close (Gamma / window JSON) for Open Replay graph anchoring. */
  finalPrice?: number;
  /** Official Polymarket up/down for this window (Settlement source). */
  windowOutcome?: WindowOutcome;
  bucket: PlayOutcomeBucket;
  pnl: number;
  plLabel: string;
  sold: boolean;
  markers: SimMarker[];
}

export interface PlacementPlayPayload {
  placementId: string;
  setupId: string;
  title: string;
  day: ScheduleDayId;
  startHour: number;
  durationHours: number;
  setup: TradingPhaseSetup;
  latencyMs: number;
  fillSuccessPct: number;
  windows: PlacementPlayWindowItem[];
}

/** Nearest chainlink spot at-or-before tMs (fallback: first later tick). */
function assetPriceAtMs(chainlink: ChainlinkTickDocument[], tMs: number): number | null {
  if (!chainlink.length) return null;
  let best: number | null = null;
  for (const tick of chainlink) {
    if (tick.tMs > tMs) break;
    if (tick.assetPrice != null && Number.isFinite(tick.assetPrice)) {
      best = tick.assetPrice;
    }
  }
  if (best != null) return best;
  for (const tick of chainlink) {
    if (tick.assetPrice != null && Number.isFinite(tick.assetPrice)) return tick.assetPrice;
  }
  return null;
}

function enrichMarkersWithAssetPrice(
  markers: SimMarker[],
  chainlink: ChainlinkTickDocument[],
  fallbackPrice?: number,
): SimMarker[] {
  if (!markers.length) return markers;
  return markers.map((m) => {
    if (m.y != null && Number.isFinite(m.y)) return m;
    const fromChain = assetPriceAtMs(chainlink, Math.round(m.t * 1000));
    const y =
      fromChain ?? (fallbackPrice != null && Number.isFinite(fallbackPrice) ? fallbackPrice : null);
    return y == null ? m : { ...m, y };
  });
}

/** Official close / outcome from local window JSON (Gamma finalize), with sim fallback. */
async function playSettlementFields(
  market: MarketDocument,
  window: RecordedWindowDocument | undefined,
  result: SimLastWindow | null | undefined,
): Promise<{
  windowOutcome?: WindowOutcome;
  finalPrice?: number;
  prevCloseAsset?: number;
}> {
  const local =
    window != null ? await getRecordedWindow(market, window.windowStart).catch(() => null) : null;

  let windowOutcome: WindowOutcome | undefined =
    result?.outcome === "up" || result?.outcome === "down"
      ? result.outcome
      : window?.windowOutcome === "up" || window?.windowOutcome === "down"
        ? window.windowOutcome
        : local?.windowOutcome === "up" || local?.windowOutcome === "down"
          ? local.windowOutcome
          : undefined;

  // Infer from held Settlement when recorded outcome is missing.
  if (
    !windowOutcome &&
    result?.plLabel === "Settlement" &&
    (result.side === "up" || result.side === "down")
  ) {
    if (result.positionWon === true) windowOutcome = result.side;
    else if (result.positionWon === false) {
      windowOutcome = result.side === "up" ? "down" : "up";
    }
  }

  const prevCloseAssetRaw =
    local?.prevCloseAsset ?? window?.prevCloseAsset ?? result?.prevCloseAsset;
  const prevCloseAsset =
    prevCloseAssetRaw != null && Number.isFinite(prevCloseAssetRaw)
      ? Number(prevCloseAssetRaw)
      : undefined;

  let finalPriceRaw = local?.assetPrice ?? window?.assetPrice ?? result?.assetPrice;
  let finalPrice =
    finalPriceRaw != null && Number.isFinite(finalPriceRaw) ? Number(finalPriceRaw) : undefined;

  // Drop a close that contradicts the official outcome vs PTB (stale last live tick).
  if (
    finalPrice != null &&
    prevCloseAsset != null &&
    (windowOutcome === "up" || windowOutcome === "down")
  ) {
    if (windowOutcome === "up" && finalPrice < prevCloseAsset) {
      finalPrice = prevCloseAsset;
    } else if (windowOutcome === "down" && finalPrice >= prevCloseAsset) {
      finalPrice = prevCloseAsset - Math.max(1e-6, Math.abs(prevCloseAsset) * 1e-10);
    }
  }

  return {
    windowOutcome,
    finalPrice,
    prevCloseAsset,
  };
}

/** Convert Replay sims into Open Replay windows (no tick stream I/O — keep Replay responsive). */
async function playWindowsFromSims(
  market: MarketDocument,
  withTicks: RecordedWindowSimulation[],
  slotWindows: RecordedWindowDocument[],
): Promise<PlacementPlayWindowItem[]> {
  const byStart = new Map(slotWindows.map((w) => [w.windowStart, w]));
  const windows: PlacementPlayWindowItem[] = [];
  for (const sim of withTicks) {
    const window = byStart.get(sim.windowStart);
    const settlement = await playSettlementFields(market, window, sim.result);
    const fallbackY =
      settlement.finalPrice ??
      window?.rangeTop ??
      window?.rangeBottom ??
      settlement.prevCloseAsset ??
      sim.result?.prevCloseAsset ??
      sim.result?.assetPrice;
    const markers = (sim.markers ?? []).map((m) => {
      if (m.y != null && Number.isFinite(m.y)) return m;
      return fallbackY != null && Number.isFinite(fallbackY) ? { ...m, y: fallbackY } : m;
    });
    windows.push({
      windowStart: sim.windowStart,
      windowEnd: sim.windowEnd,
      prevCloseAsset: settlement.prevCloseAsset,
      finalPrice: settlement.finalPrice,
      windowOutcome: settlement.windowOutcome,
      bucket: classifyWindow(sim.result),
      pnl: sim.result?.pl ?? 0,
      plLabel: sim.result?.plLabel ?? "No trade",
      sold: Boolean(sim.result?.sold),
      markers,
    });
  }
  return windows.sort((a, b) => a.windowStart - b.windowStart);
}

export interface BuildPlacementPlayOptions {
  latencyMs: number;
  fillSuccessPct?: number;
  /** Prefer this setup over Mongo (e.g. in-memory Replay editor state). */
  phaseSetup?: TradingPhaseSetup | null;
  /** When true, ignore last-Replay cache and re-simulate (fresh random fills). */
  forceResimulate?: boolean;
}

/** Build window list + sim markers for the schedule Open Replay popup. */
export async function buildPlacementPlayPayload(
  userId: string,
  market: MarketDocument,
  placement: SchedulePlacementListItem,
  options: BuildPlacementPlayOptions,
): Promise<PlacementPlayPayload> {
  const series = market._id;
  const latencyMs = Math.max(0, Math.min(10000, Math.floor(options.latencyMs)));
  const rawFill = options.fillSuccessPct;
  const fillSuccessPct =
    typeof rawFill === "number" && Number.isFinite(rawFill)
      ? Math.max(0, Math.min(100, rawFill))
      : 100;

  // Prefer the exact windows/markers from the last Replay that painted this card.
  if (!options.forceResimulate) {
    const remembered = getRememberedPlacementPlay(userId, placement._id);
    if (remembered?.windows?.length) {
      logService.info(
        "replay",
        `Open Replay ${placement._id}: serving ${remembered.windows.length} cached window(s) from last Replay`,
      );
      // Enrich older cache entries that lack official close / outcome.
      const needsEnrich = remembered.windows.some(
        (w) => w.windowOutcome == null || w.finalPrice == null || w.prevCloseAsset == null,
      );
      if (!needsEnrich) return remembered;
      const enriched = await Promise.all(
        remembered.windows.map(async (w) => {
          if (w.windowOutcome != null && w.finalPrice != null && w.prevCloseAsset != null) {
            return w;
          }
          const settlement = await playSettlementFields(
            market,
            {
              _id: String(w.windowStart),
              windowStart: w.windowStart,
              windowEnd: w.windowEnd,
              savedAt: "",
              updatedAt: "",
              tickCount: 0,
            },
            null,
          );
          return {
            ...w,
            windowOutcome: w.windowOutcome ?? settlement.windowOutcome,
            finalPrice: w.finalPrice ?? settlement.finalPrice,
            prevCloseAsset: w.prevCloseAsset ?? settlement.prevCloseAsset,
          };
        }),
      );
      const next = { ...remembered, windows: enriched };
      rememberPlacementPlay(userId, next);
      return next;
    }
  }

  let phaseSetup = options.phaseSetup ?? null;
  if (!phaseSetup) {
    const setupDoc = await getTradingSetupById(userId, placement.setupId, "replay");
    phaseSetup = setupDoc?.setup ?? null;
  }

  const empty: PlacementPlayPayload = {
    placementId: placement._id,
    setupId: placement.setupId,
    title: placement.title,
    day: placement.day,
    startHour: placement.startHour,
    durationHours: placement.durationHours,
    setup: phaseSetup ?? {
      phaseSplit: [1 / 3, 2 / 3],
      phases: [defaultPhaseConfig(), defaultPhaseConfig(), defaultPhaseConfig()],
    },
    latencyMs,
    fillSuccessPct,
    windows: [],
  };

  if (!phaseSetup || !Array.isArray(phaseSetup.phases) || phaseSetup.phases.length !== 3) {
    logService.warn(
      "replay",
      `Open Replay ${placement._id}: missing/invalid setup (setupId=${placement.setupId})`,
    );
    return empty;
  }

  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  const listed = await listRecordedWindowsSince(cutoffUtc, series);
  const allWindows: RecordedWindowDocument[] = selectLatestDayHourWindows(
    listed.filter((w) => !isFlatPriceWindow(w)),
  ).map((w) => ({
    _id: String(w.windowStart),
    windowStart: w.windowStart,
    windowEnd: w.windowEnd,
    savedAt: w.savedAt,
    updatedAt: w.savedAt,
    windowOutcome: w.windowOutcome,
    ptbCrossings: w.ptbCrossings,
    rangeTop: w.rangeTop,
    rangeBottom: w.rangeBottom,
    uniqueTraders: w.uniqueTraders,
    newWallets: w.newWallets,
    minAssetPrice: w.minAssetPrice,
    maxAssetPrice: w.maxAssetPrice,
    assetRange: w.assetRange,
    tickCount: 0,
  }));

  const slotWindows = allWindows.filter((w) =>
    windowMatchesPlacementSlot(
      w.windowStart,
      placement.day,
      placement.startHour,
      placement.durationHours,
    ),
  );

  if (slotWindows.length === 0) {
    logService.warn(
      "replay",
      `Open Replay ${placement._id}: no slot windows (${placement.day} @ ${placement.startHour}h × ${placement.durationHours}h, series=${series}, pool=${allWindows.length})`,
    );
    return { ...empty, setup: phaseSetup };
  }

  const windowDuration =
    slotWindows[0]?.windowEnd && slotWindows[0]?.windowStart
      ? slotWindows[0].windowEnd - slotWindows[0].windowStart
      : undefined;
  const simSetup = phaseSetupToSimSetup(phaseSetup, latencyMs, windowDuration, fillSuccessPct);
  const tickCache = new Map<number, ReplayTickDocument[]>();

  logService.info(
    "replay",
    `Open Replay ${placement._id}: simulating ${slotWindows.length} window(s) (${placement.day} @ ${placement.startHour}h, latency ${latencyMs} ms, fill ${fillSuccessPct}%)`,
  );

  const sims = await mapWithConcurrency(slotWindows, WINDOW_SIM_CONCURRENCY, async (window) => {
    const sim = await simulateRecordedWindow(market, series, window, simSetup, tickCache);
    let markers = sim.markers ?? [];
    if (markers.some((m) => m.y == null || !Number.isFinite(m.y))) {
      const chainlink = await listChainlinkTicks(market, window.windowStart, 20_000);
      markers = enrichMarkersWithAssetPrice(
        markers,
        chainlink,
        window.rangeTop ?? window.rangeBottom ?? window.prevCloseAsset,
      );
    }
    return { window, sim, markers };
  });

  // Same set Replay counts toward card stats: every window that had tick files.
  const windows: PlacementPlayWindowItem[] = [];
  for (const { window, sim, markers } of sims.filter(({ sim: s }) => s.hadTicks)) {
    const result = sim.result;
    const settlement = await playSettlementFields(market, window, result);
    windows.push({
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      prevCloseAsset: settlement.prevCloseAsset,
      finalPrice: settlement.finalPrice,
      windowOutcome: settlement.windowOutcome,
      bucket: classifyWindow(result),
      pnl: result?.pl ?? 0,
      plLabel: result?.plLabel ?? "No trade",
      sold: Boolean(result?.sold),
      markers,
    });
  }
  windows.sort((a, b) => a.windowStart - b.windowStart);

  logService.info(
    "replay",
    `Open Replay ${placement._id}: ${windows.length}/${slotWindows.length} window(s) with ticks (re-simulated; run Replay first for card-matching hits)`,
  );

  const payload: PlacementPlayPayload = {
    placementId: placement._id,
    setupId: placement.setupId,
    title: placement.title,
    day: placement.day,
    startHour: placement.startHour,
    durationHours: placement.durationHours,
    setup: phaseSetup,
    latencyMs,
    fillSuccessPct,
    windows,
  };
  if (windows.length > 0) {
    rememberPlacementPlay(userId, payload);
  }
  return payload;
}
