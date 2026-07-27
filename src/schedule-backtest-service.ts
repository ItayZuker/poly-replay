import { getWindowDataVersion } from "./db/recorded-window-repository.js";
import { listRecordedWindowsSince } from "./db/recorded-window-mongo-repository.js";
import { getTradingSetupById } from "./db/trading-setup-repository.js";
import type { SchedulePlacementListItem } from "./db/schedule-placement-repository.js";
import { listReplayTicks } from "./db/replay-tick-repository.js";
import { getWeekHistoryCutoffUtcSec } from "./heatmap-service.js";
import { selectLatestDayHourWindows } from "./day-hour-slots.js";
import { recordAskSamples } from "./phase-config.js";
import { SimulatorEngine } from "./simulator-engine.js";
import { phaseSetupToSimSetup } from "./simulator-service.js";
import {
  buildPlacementCacheKey,
  getCachedPlacementStats,
  rollingCutoffDayUtc,
  flushPlacementStatsCache,
} from "./schedule-backtest-cache.js";
import { logService } from "./log-service.js";
import type {
  LiveWindowState,
  MarketDocument,
  RecordedWindowDocument,
  ReplayTickDocument,
  ScheduleDayId,
  SimLastWindow,
  SimMarker,
  SimSetup,
  TradingPhaseSetup,
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
  simResultCache?: Map<string, SimLastWindow | null>,
): Promise<RecordedWindowSimulation> {
  const simCacheKey = simResultCache ? windowSimCacheKey(window.windowStart, setup) : null;
  if (simCacheKey && simResultCache!.has(simCacheKey)) {
    const cached = simResultCache!.get(simCacheKey) ?? null;
    return {
      result: cached,
      markers: [],
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      // Cached entries were only stored after a tickful sim.
      hadTicks: cached != null,
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

  const lastInWindow = [...ticks].reverse().find((t) => t.tMs < windowEnd * 1000) ?? ticks[ticks.length - 1];
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

  if (simCacheKey) {
    simResultCache!.set(simCacheKey, result ?? null);
  }

  return {
    result,
    markers: engine.getMarkers(),
    windowStart,
    windowEnd,
    hadTicks: true,
  };
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
  const allWindows: RecordedWindowDocument[] = selectLatestDayHourWindows(
    await listRecordedWindowsSince(cutoffUtc, series),
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

  const simResultCache = new Map<string, SimLastWindow | null>();
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
      logService.info(
        "replay",
        `Card ${cardIndex}/${plans.length} ${label} — done (g${computed.green}/r${computed.red}/b${computed.blue}/gray${computed.gray} pnl ${computed.pnl.toFixed(2)}; ${withTicks.length}/${plan.slotWindows.length} windows with ticks)`,
      );
      options.onPlacementComplete?.(computed);
    }

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
