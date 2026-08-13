import { getRecordedWindow, getWindowDataVersion } from "./db/recorded-window-repository.js";
import { listRecordedWindowsSince } from "./db/recorded-window-mongo-repository.js";
import { getTradingSetupById } from "./db/trading-setup-repository.js";
import type { SchedulePlacementListItem } from "./db/schedule-placement-repository.js";
import { listReplayTicks } from "./db/replay-tick-repository.js";
import {
  listChainlinkTicks,
  windowsHavingReplayTickFiles,
} from "./db/tick-repository.js";
import { getWeekHistoryCutoffUtcSec, selectLatestDayHourWindows } from "./day-hour-slots.js";
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
import {
  evaluateWindowPredictions,
  normalizePredictionDetectorConfig,
  type PredictionDetectorConfig,
} from "./prediction-detector.js";
import {
  mergePredictionTradeResult,
  PredictionTradeRaceSession,
} from "./prediction-trade-sim.js";
import {
  mergeTriggerStats,
  normalizeReplayTriggerDefs,
  TriggerReplayRaceSession,
  type TriggerReplayStat,
} from "./trigger-replay-sim.js";
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

export interface PlacementTriggerStat {
  triggerId: string;
  name?: string;
  success: number;
  fail: number;
  takeProfit: number;
  stopLoss: number;
  pnlUsd: number;
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
  /** Replay Prediction: windows where the detector was right. */
  predictionRight: number;
  /** Replay Prediction: windows where the detector was wrong. */
  predictionWrong: number;
  /** Per-trigger Replay stats for this card (summed across its windows). */
  triggerStats?: PlacementTriggerStat[];
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
  /** Replay-only Prediction detector settings (separate from live Market Prediction). */
  prediction?: Partial<PredictionDetectorConfig> | null;
  /** Replay Trigger cards applied on each simulated window. */
  triggers?: unknown[] | null;
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

export type TradeDotBucket = "green" | "red" | "blue";

/** One settled buy→sell (or held-to-settlement) trade for Replay dots/stats. */
export interface TradeDot {
  source: "phase" | "prediction" | "trigger";
  bucket: TradeDotBucket;
  /** Prediction trades only — feeds Replay Right/Wrong totals. */
  predictionScore?: "right" | "wrong";
  side: "up" | "down";
  buyT: number;
  sellT?: number;
}

function markerTradeSource(m: SimMarker): "phase" | "prediction" | "trigger" {
  if (m.source === "prediction" || m.source === "phase" || m.source === "trigger") {
    return m.source;
  }
  const key = String(m.windowKey || "");
  if (key.startsWith("pred:")) return "prediction";
  if (key.startsWith("trigger:")) return "trigger";
  return "phase";
}

function settleUnsoldTrade(
  buy: SimMarker,
  source: "phase" | "prediction" | "trigger",
  windowOutcome: WindowOutcome | null | undefined,
): TradeDot {
  const won =
    windowOutcome === "up" || windowOutcome === "down" ? windowOutcome === buy.side : null;
  if (source === "prediction") {
    if (won === true) {
      return {
        source,
        bucket: "blue",
        predictionScore: "right",
        side: buy.side,
        buyT: buy.t,
      };
    }
    return {
      source,
      bucket: "red",
      predictionScore: "wrong",
      side: buy.side,
      buyT: buy.t,
    };
  }
  if (won === true) {
    return { source, bucket: "blue", side: buy.side, buyT: buy.t };
  }
  return { source, bucket: "red", side: buy.side, buyT: buy.t };
}

const SHARE_EPS = 1e-9;

/** Pair buy→sell(s) within one windowKey. Multi-leg FAK exits sum P/L into one dot. */
function pairMarkersRoundTrips(
  markers: SimMarker[],
  source: "phase" | "prediction" | "trigger",
  windowOutcome: WindowOutcome | null | undefined,
): TradeDot[] {
  const sorted = markers.slice().sort((a, b) => a.t - b.t || (a.type === "buy" ? -1 : 1));
  const dots: TradeDot[] = [];
  let openBuy: SimMarker | null = null;
  let remaining = 0;
  let realizedPl = 0;
  let lastSellT: number | undefined;
  let heldSettlement = false;

  const resetOpen = () => {
    openBuy = null;
    remaining = 0;
    realizedPl = 0;
    lastSellT = undefined;
    heldSettlement = false;
  };

  const pushSoldDot = () => {
    if (!openBuy || lastSellT == null) return;
    if (source === "prediction") {
      // Profit-target sell → green + Right (market outcome ignored).
      dots.push({
        source,
        bucket: "green",
        predictionScore: "right",
        side: openBuy.side,
        buyT: openBuy.t,
        sellT: lastSellT,
      });
    } else if (source === "trigger" && heldSettlement) {
      // Held remainder / window settlement → blue/red by market outcome.
      const won =
        windowOutcome === "up" || windowOutcome === "down"
          ? windowOutcome === openBuy.side
          : null;
      dots.push({
        source,
        bucket: won === true ? "blue" : "red",
        side: openBuy.side,
        buyT: openBuy.t,
        sellT: lastSellT,
      });
    } else {
      dots.push({
        source,
        bucket: realizedPl > 0 ? "green" : "red",
        side: openBuy.side,
        buyT: openBuy.t,
        sellT: lastSellT,
      });
    }
    resetOpen();
  };

  const pushOpenDot = () => {
    if (!openBuy) return;
    if (lastSellT != null) {
      // Partial exits then still open (missing settlement marker): use net realized.
      pushSoldDot();
      return;
    }
    dots.push(settleUnsoldTrade(openBuy, source, windowOutcome));
    resetOpen();
  };

  for (const m of sorted) {
    if (m.type === "buy") {
      if (openBuy) pushOpenDot();
      openBuy = m;
      remaining = Number(m.shares);
      if (!Number.isFinite(remaining) || remaining < 0) remaining = 0;
      realizedPl = 0;
      lastSellT = undefined;
      continue;
    }
    if (m.type !== "sell" || !openBuy) continue;
    const sh = Number(m.shares);
    remaining -= Number.isFinite(sh) ? sh : 0;
    const legPl = Number.isFinite(m.profit) ? Number(m.profit) : 0;
    realizedPl += legPl;
    lastSellT = m.t;
    if (m.heldSettlement) heldSettlement = true;
    if (remaining <= SHARE_EPS) pushSoldDot();
  }
  if (openBuy) pushOpenDot();
  return dots;
}

function pairSourceTrades(
  markers: SimMarker[],
  source: "phase" | "prediction" | "trigger",
  windowOutcome: WindowOutcome | null | undefined,
): TradeDot[] {
  const list = markers.filter((m) => markerTradeSource(m) === source);
  // Keep each trigger/phase/pred windowKey separate so concurrent buys do not cross-pair.
  const groups = new Map<string, SimMarker[]>();
  for (const m of list) {
    const key = String(m.windowKey || "__default__");
    const arr = groups.get(key);
    if (arr) arr.push(m);
    else groups.set(key, [m]);
  }
  const dots: TradeDot[] = [];
  for (const group of groups.values()) {
    dots.push(...pairMarkersRoundTrips(group, source, windowOutcome));
  }
  return dots.sort((a, b) => a.buyT - b.buyT);
}

/** Pair phase + prediction + trigger fills into per-trade green/red/blue dots. */
export function classifyTradesFromMarkers(
  markers: SimMarker[] | null | undefined,
  windowOutcome?: WindowOutcome | null,
): TradeDot[] {
  const list = markers ?? [];
  const phase = pairSourceTrades(list, "phase", windowOutcome);
  const pred = pairSourceTrades(list, "prediction", windowOutcome);
  const trig = pairSourceTrades(list, "trigger", windowOutcome);
  return [...phase, ...pred, ...trig].sort((a, b) => a.buyT - b.buyT);
}

function primaryBucketFromTradeDots(dots: TradeDot[]): OutcomeBucket {
  return dots.length === 0 ? "none" : dots[0].bucket;
}

/** One scored Prediction trigger in a window (Open Replay Duration band + badge). */
export interface PredictionTriggerPlayItem {
  side: WindowOutcome;
  triggeredAtMs: number;
  sensitivitySec: number;
  score: "right" | "wrong";
}

/** True when merged replay ticks include a Chainlink asset price (or derivable gap). */
function replayTicksHaveChainlinkPath(ticks: ReplayTickDocument[]): boolean {
  return ticks.some((t) => {
    if (t.assetPrice != null && Number.isFinite(t.assetPrice)) return true;
    return (
      t.assetGap != null &&
      Number.isFinite(t.assetGap) &&
      t.prevCloseAsset != null &&
      Number.isFinite(t.prevCloseAsset)
    );
  });
}

/** True when merged replay ticks include CLOB book quotes (Ask path for triggers). */
function replayTicksHaveClobBookPath(ticks: ReplayTickDocument[]): boolean {
  return ticks.some((t) => {
    if (t.source === "clob-book") return true;
    return (
      (t.yesAsk != null && Number.isFinite(t.yesAsk)) ||
      (t.noAsk != null && Number.isFinite(t.noAsk))
    );
  });
}

export interface RecordedWindowSimulation {
  result: SimLastWindow | null;
  markers: SimMarker[];
  windowStart: number;
  windowEnd: number;
  /** False when CLOB book and/or Chainlink tick data is missing/empty. */
  hadTicks: boolean;
  /** Official / inferred market outcome for held-position trade dots. */
  windowOutcome?: WindowOutcome | null;
  predictionSide?: WindowOutcome | null;
  predictionScore?: "right" | "wrong" | null;
  /** All scored predictions in the window (supports re-trigger after Right). */
  predictionScores?: Array<"right" | "wrong">;
  /** Every trigger in time order (Duration bands + badge for each). */
  predictionTriggers?: PredictionTriggerPlayItem[];
  predictionTriggeredAtMs?: number | null;
  /** Duration (sec) used when the Prediction fired (for Open Replay band). */
  predictionSensitivitySec?: number | null;
  /** Per-trigger stats for this window. */
  triggerStats?: TriggerReplayStat[];
}

export async function simulateRecordedWindow(
  market: MarketDocument,
  series: string,
  window: RecordedWindowDocument,
  setup: SimSetup,
  tickCache?: Map<number, ReplayTickDocument[]>,
  simResultCache?: Map<string, WindowSimCacheEntry>,
  predictionConfig?: PredictionDetectorConfig | null,
  triggerDefs?: ReturnType<typeof normalizeReplayTriggerDefs> | null,
): Promise<RecordedWindowSimulation> {
  const windowEnd = window.windowEnd;
  const windowStart = window.windowStart;
  // Official Gamma required for Replay Run / Open Replay (no inferred price outcome).
  if (window.windowOutcome !== "up" && window.windowOutcome !== "down") {
    return {
      result: null,
      markers: [],
      windowStart,
      windowEnd,
      hadTicks: false,
      predictionSide: null,
      predictionScore: null,
      predictionScores: [],
      predictionTriggers: [],
      predictionTriggeredAtMs: null,
      predictionSensitivitySec: null,
      triggerStats: [],
    };
  }

  const simCacheKey = simResultCache ? windowSimCacheKey(window.windowStart, setup) : null;
  const hasTriggers = Array.isArray(triggerDefs) && triggerDefs.length > 0;
  // Phase-only cache: Prediction/Triggers race with phase on a shared timeline.
  if (simCacheKey && simResultCache!.has(simCacheKey) && !predictionConfig && !hasTriggers) {
    const cached = simResultCache!.get(simCacheKey)!;
    const windowOutcome: WindowOutcome | null =
      window.windowOutcome === "up" || window.windowOutcome === "down"
        ? window.windowOutcome
        : cached.result?.outcome === "up" || cached.result?.outcome === "down"
          ? cached.result.outcome
          : null;
    return {
      result: cached.result,
      markers: cached.markers.map((m) => ({ ...m })),
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      hadTicks: true,
      windowOutcome,
      predictionSide: null,
      predictionScore: null,
      predictionScores: [],
      predictionTriggers: [],
      predictionTriggeredAtMs: null,
      predictionSensitivitySec: null,
      triggerStats: [],
    };
  }

  let ticks = tickCache?.get(window.windowStart);
  if (!ticks) {
    ticks = await listReplayTicks(market, window.windowStart, 50_000);
    tickCache?.set(window.windowStart, ticks);
  }

  // Missing CLOB book or Chainlink → exclude from Replay (either side alone is unusable).
  if (
    ticks.length === 0 ||
    !replayTicksHaveChainlinkPath(ticks) ||
    !replayTicksHaveClobBookPath(ticks)
  ) {
    // Do not cache empties as sim results — missing files must stay distinguishable.
    return {
      result: null,
      markers: [],
      windowStart,
      windowEnd,
      hadTicks: false,
      predictionSide: null,
      predictionScore: null,
      predictionScores: [],
      predictionTriggers: [],
      predictionTriggeredAtMs: null,
      predictionSensitivitySec: null,
      triggerStats: [],
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
      predictionSide: null,
      predictionScore: null,
      predictionScores: [],
      predictionTriggers: [],
      predictionTriggeredAtMs: null,
      predictionSensitivitySec: null,
      triggerStats: [],
    };
  }

  // Triggers replace Replay Prediction when present.
  const useTriggers = hasTriggers;
  const predictionEvals =
    !useTriggers && predictionConfig
      ? evaluateWindowPredictions(ticks, windowStart, windowEnd, predictionConfig)
      : [];
  const predictionHit = predictionEvals[0]?.hit ?? null;
  const predictionSide = predictionHit?.side ?? null;
  const predictionTriggeredAtMs = predictionHit?.triggeredAtMs ?? null;
  const predictionSensitivitySec = predictionHit
    ? predictionConfig!.sensitivitySec
    : null;
  const predictionScores = predictionEvals.map((e) => e.score);
  const predictionScore = predictionScores[predictionScores.length - 1] ?? null;
  const predictionTriggers: PredictionTriggerPlayItem[] = [];
  for (const e of predictionEvals) {
    const hit = e.hit;
    if (!hit || (hit.side !== "up" && hit.side !== "down")) continue;
    predictionTriggers.push({
      side: hit.side,
      triggeredAtMs: hit.triggeredAtMs,
      sensitivitySec: predictionConfig!.sensitivitySec,
      score: e.score,
    });
  }

  // Mute per-fill/GTD spam — otherwise Replay floods SSE/console and freezes the UI.
  return logService.runWithMutedSources(["sim"], () => {
    const engine = new SimulatorEngine();
    const priceHistory: Array<{ t: number; price: number }> = [];
    let bookTickSequence = 0;
    const fillSuccessPct = setup.fillSuccessPct ?? 100;
    const predSession =
      !useTriggers && predictionConfig && predictionEvals.length > 0
        ? new PredictionTradeRaceSession({
            ticks,
            evals: predictionEvals,
            config: predictionConfig,
            windowStart,
            windowEnd,
            latencyMs: setup.latencyMs,
            fillSuccessPct,
            windowOutcome: window.windowOutcome ?? null,
          })
        : null;
    const triggerSession = useTriggers
      ? new TriggerReplayRaceSession({
          triggers: triggerDefs!,
          windowStart,
          windowEnd,
          latencyMs: setup.latencyMs,
          fillSuccessPct,
          windowOutcome: window.windowOutcome ?? null,
          // Replay Run: every Active card may buy (same as Market Demo testing).
          independentBuys: true,
        })
      : null;

    for (const tick of ticks) {
      if (tick.tMs >= windowEnd * 1000) break;
      // Same series as live recordings: append on each Chainlink sample (incl. same $).
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

      // Shared race with live: first buy holds until sell; then both may race again.
      const phaseOpenBefore = engine.hasOpenPosition();
      predSession?.onTickBeforePhase(tick, phaseOpenBefore);
      triggerSession?.onTickBeforePhase(
        tick,
        phaseOpenBefore || Boolean(predSession?.isHolding()),
      );
      engine.setExternalBuyPaused(
        Boolean(predSession?.isHolding()) || Boolean(triggerSession?.isHolding()),
      );
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
    engine.setExternalBuyPaused(
      Boolean(predSession?.isHolding()) || Boolean(triggerSession?.isHolding()),
    );
    engine.tick({ ...endState, lastTickMs: endMs }, setup, endMs);

    const predTrade = predSession
      ? predSession.finalize()
      : { pl: 0, markers: [] as SimMarker[], traded: false };
    const triggerTrade = triggerSession
      ? triggerSession.finalize()
      : {
          pl: 0,
          markers: [] as SimMarker[],
          traded: false,
          stats: [] as TriggerReplayStat[],
          hits: [],
        };

    // Settle from stored Polymarket outcome in window JSON (backfilled / recorded at finalize).
    const result = engine.finalizeWindow(
      window.windowOutcome ? { outcome: window.windowOutcome } : undefined,
    );
    const markers = engine.getMarkers();

    // Only cache phase-only results (external races must re-run with ticks).
    if (simCacheKey && !predictionConfig && !useTriggers) {
      simResultCache!.set(simCacheKey, {
        result: result ?? null,
        markers: markers.map((m) => ({ ...m })),
      });
    }

    const mergedWithPred = mergePredictionTradeResult(result, predTrade, windowStart, windowEnd);
    const mergedResult = mergePredictionTradeResult(
      mergedWithPred,
      triggerTrade,
      windowStart,
      windowEnd,
    );

    const windowOutcome: WindowOutcome | null =
      window.windowOutcome === "up" || window.windowOutcome === "down"
        ? window.windowOutcome
        : mergedResult?.outcome === "up" || mergedResult?.outcome === "down"
          ? mergedResult.outcome
          : null;

    // Map trigger hits into predictionTriggers shape for Open Replay bands/badge.
    const triggerPlayItems: PredictionTriggerPlayItem[] = triggerTrade.hits
      .filter((h) => h.side === "up" || h.side === "down")
      .map((h) => ({
        side: h.side,
        triggeredAtMs: h.triggeredAtMs,
        sensitivitySec: h.sensitivitySec,
        score: h.score === "right" || h.score === "wrong" ? h.score : "wrong",
      }));

    return {
      result: mergedResult,
      markers: [...markers, ...predTrade.markers, ...triggerTrade.markers],
      windowStart,
      windowEnd,
      hadTicks: true,
      windowOutcome,
      predictionSide: useTriggers
        ? triggerPlayItems[0]?.side ?? null
        : predictionSide,
      predictionScore: useTriggers
        ? triggerPlayItems[triggerPlayItems.length - 1]?.score ?? null
        : predictionScore,
      predictionScores: useTriggers
        ? triggerPlayItems.map((t) => t.score)
        : predictionScores,
      predictionTriggers: useTriggers ? triggerPlayItems : predictionTriggers,
      predictionTriggeredAtMs: useTriggers
        ? triggerPlayItems[0]?.triggeredAtMs ?? null
        : predictionTriggeredAtMs,
      predictionSensitivitySec: useTriggers
        ? triggerPlayItems[0]?.sensitivitySec ?? null
        : predictionSensitivitySec,
      triggerStats: triggerTrade.stats,
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
    predictionRight: 0,
    predictionWrong: 0,
    triggerStats: [],
  };
}

function aggregateResult(
  placementId: string,
  sims: RecordedWindowSimulation[],
): PlacementBacktestStats {
  let green = 0;
  let red = 0;
  let blue = 0;
  let gray = 0;
  let pnl = 0;
  let predictionRight = 0;
  let predictionWrong = 0;
  const triggerMap = new Map<string, TriggerReplayStat>();

  for (const sim of sims) {
    const outcome = sim.windowOutcome ?? sim.result?.outcome ?? null;
    const dots = classifyTradesFromMarkers(sim.markers, outcome);
    if (dots.length === 0) {
      gray += 1;
    } else {
      for (const d of dots) {
        if (d.bucket === "green") green += 1;
        else if (d.bucket === "red") red += 1;
        else if (d.bucket === "blue") blue += 1;
        if (d.predictionScore === "right") predictionRight += 1;
        else if (d.predictionScore === "wrong") predictionWrong += 1;
      }
    }
    if (sim.result) pnl += sim.result.pl ?? 0;
    if (Array.isArray(sim.triggerStats) && sim.triggerStats.length) {
      mergeTriggerStats(triggerMap, sim.triggerStats);
    }
  }

  return {
    placementId,
    hasData: true,
    green,
    red,
    blue,
    gray,
    pnl: Number.isFinite(pnl) ? pnl : 0,
    predictionRight,
    predictionWrong,
    triggerStats: [...triggerMap.values()],
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
    recordingsVersion: string;
    cutoffDay: string;
    cutoffUtc: number;
    allWindows: RecordedWindowDocument[];
    allowCached: boolean;
    prediction: PredictionDetectorConfig | null;
  },
): Promise<PlacementPlan> {
  const {
    series,
    phaseSetup,
    latencyMs,
    fillSuccessPct,
    recordingsVersion,
    cutoffDay,
    cutoffUtc,
    allWindows,
    allowCached,
    prediction,
  } = input;
  const cacheKey = buildPlacementCacheKey({
    series,
    placement,
    phaseSetup,
    latencyMs,
    fillSuccessPct,
    recordingsVersion,
    cutoffDay,
    prediction,
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
  // null = Prediction Off (do not evaluate). Object / omitted → normalize defaults.
  const triggers = normalizeReplayTriggerDefs(options.triggers);
  const prediction =
    triggers.length > 0
      ? null
      : options.prediction === null
        ? null
        : normalizePredictionDetectorConfig(options.prediction);

  // Always process Mon/top → Sun/bottom so the board fills left-to-right.
  placements = sortPlacementsTopLeft(placements);

  options.onProgress?.({ completed: 0, total: 0, indeterminate: true });

  const series = market._id;
  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  const cutoffDay = rollingCutoffDayUtc();
  // Same Mongo window index as Replay — keep ~2 weeks, then for each
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
    prevCloseAsset: w.prevCloseAsset,
    assetPrice: w.assetPrice,
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
  const recordingsVersion = await getWindowDataVersion(market, allWindows);
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
        recordingsVersion,
        cutoffDay,
        prediction,
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
    recordingsVersion,
    cutoffDay,
    cutoffUtc,
    allWindows,
    allowCached,
    prediction,
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
            prediction,
            triggers,
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
            predictionSide: null,
            predictionScore: null,
            predictionScores: [],
            predictionTriggers: [],
            predictionTriggeredAtMs: null,
            predictionSensitivitySec: null,
            triggerStats: [],
          } satisfies RecordedWindowSimulation;
        }
      },
    );

    const finished = windowResults.filter(
      (sim): sim is RecordedWindowSimulation => sim != null,
    );
    const withTicks = finished.filter((sim) => sim.hadTicks);

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
        `Card ${cardIndex}/${plans.length} ${label} — ${plan.slotWindows.length} window(s) in slot but CLOB/Chainlink tick files missing on disk`,
      );
      options.onPlacementComplete?.(computed);
    } else {
      const computed = aggregateResult(plan.placement._id, withTicks);
      statsById.set(plan.placement._id, computed);
      if (allowCached) {
        cacheUpdates.push({
          placementId: plan.placement._id,
          cacheKey: plan.cacheKey,
          stats: computed,
        });
      }
      const phaseSetup = setupCache.get(plan.placement.setupId) ?? triggerOnlyPhaseSetup();
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
        triggerOnly: triggers.length > 0,
        windows: await playWindowsFromSims(market, withTicks, plan.slotWindows),
      });
      logService.info(
        "replay",
        `Card ${cardIndex}/${plans.length} ${label} — done (g${computed.green}/r${computed.red}/b${computed.blue}/gray${computed.gray} pnl ${computed.pnl.toFixed(2)}; pred ${computed.predictionRight}/${computed.predictionWrong}; ${withTicks.length}/${plan.slotWindows.length} windows with ticks)`,
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
  /** Legacy primary bucket (first trade, or none). Prefer tradeDots. */
  bucket: PlayOutcomeBucket;
  /** Per-trade outcome dots (phase + Prediction); empty → gray in the list. */
  tradeDots: TradeDot[];
  pnl: number;
  plLabel: string;
  sold: boolean;
  markers: SimMarker[];
  /** Live Open: true when the ledger has a trade but Mongo has no recorded_windows row. */
  recordingMissing?: boolean;
  /** Replay Prediction side when the detector fired in this window. */
  predictionSide?: WindowOutcome | null;
  /** Last Prediction trade score in the window (null if none). Prefer predictionScores. */
  predictionScore?: "right" | "wrong" | null;
  /** Prediction trade Right/Wrong scores (from settled Prediction fills). */
  predictionScores?: Array<"right" | "wrong">;
  /** Every trigger in time order (Duration bands + badge). */
  predictionTriggers?: PredictionTriggerPlayItem[];
  /** Tick time (ms) when Prediction first triggered. */
  predictionTriggeredAtMs?: number | null;
  /** Duration (sec) used for the trigger (Open Replay highlight band). */
  predictionSensitivitySec?: number | null;
}

function playTradeFields(
  markers: SimMarker[],
  windowOutcome?: WindowOutcome | null,
): {
  tradeDots: TradeDot[];
  bucket: PlayOutcomeBucket;
  predictionScores: Array<"right" | "wrong">;
  predictionScore: "right" | "wrong" | null;
} {
  const tradeDots = classifyTradesFromMarkers(markers, windowOutcome);
  const predictionScores = tradeDots
    .map((d) => d.predictionScore)
    .filter((s): s is "right" | "wrong" => s === "right" || s === "wrong");
  return {
    tradeDots,
    bucket: primaryBucketFromTradeDots(tradeDots),
    predictionScores,
    predictionScore: predictionScores.length ? predictionScores[predictionScores.length - 1] : null,
  };
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
  /** Trigger-only Open Replay — hide phase bands / phase editor chrome. */
  triggerOnly?: boolean;
}

const SCHEDULE_DAY_IDS: ScheduleDayId[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Synthetic Replay hour cell id (`hour:mon:14`) — not stored in Mongo. */
export function parseSyntheticHourPlacement(
  placementId: string,
  series: string,
): SchedulePlacementListItem | null {
  const m = /^hour:([a-z]+):(\d{1,2})$/i.exec(String(placementId || ""));
  if (!m) return null;
  const day = m[1].toLowerCase() as ScheduleDayId;
  const hour = Number(m[2]);
  if (!SCHEDULE_DAY_IDS.includes(day) || !Number.isFinite(hour) || hour < 0 || hour > 23) {
    return null;
  }
  const now = new Date().toISOString();
  const seriesId = String(series || "").trim();
  return {
    _id: `hour:${day}:${hour}`,
    series: seriesId,
    setupId: "__trigger_only__",
    title: `${day.toUpperCase()} ${String(hour).padStart(2, "0")}:00`,
    day,
    startHour: hour,
    durationHours: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function triggerOnlyPhaseSetup(): TradingPhaseSetup {
  const phaseOff = { ...defaultPhaseConfig(), buyEnabled: false };
  return {
    phaseSplit: [1 / 3, 2 / 3],
    phases: [phaseOff, phaseOff, phaseOff],
  };
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

/**
 * Official close / PTB / outcome from the recording (crypto-price / Gamma finalize).
 * No inferred outcomes and no mirrored closes — missing fields stay unset.
 */
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

  const windowOutcome: WindowOutcome | undefined =
    local?.windowOutcome === "up" || local?.windowOutcome === "down"
      ? local.windowOutcome
      : window?.windowOutcome === "up" || window?.windowOutcome === "down"
        ? window.windowOutcome
        : result?.outcome === "up" || result?.outcome === "down"
          ? result.outcome
          : undefined;

  const prevCloseAssetRaw =
    local?.prevCloseAsset ?? window?.prevCloseAsset ?? result?.prevCloseAsset;
  const prevCloseAsset =
    prevCloseAssetRaw != null && Number.isFinite(prevCloseAssetRaw)
      ? Number(prevCloseAssetRaw)
      : undefined;

  const finalPriceRaw = local?.assetPrice ?? window?.assetPrice ?? result?.assetPrice;
  const finalPrice =
    finalPriceRaw != null && Number.isFinite(finalPriceRaw) ? Number(finalPriceRaw) : undefined;

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
    const trade = playTradeFields(markers, settlement.windowOutcome);
    windows.push({
      windowStart: sim.windowStart,
      windowEnd: sim.windowEnd,
      prevCloseAsset: settlement.prevCloseAsset,
      finalPrice: settlement.finalPrice,
      windowOutcome: settlement.windowOutcome,
      bucket: trade.bucket,
      tradeDots: trade.tradeDots,
      pnl: sim.result?.pl ?? 0,
      plLabel: sim.result?.plLabel ?? "No trade",
      sold: Boolean(sim.result?.sold),
      markers,
      predictionSide: sim.predictionSide ?? null,
      predictionScore: trade.predictionScore,
      predictionScores: trade.predictionScores,
      predictionTriggers: playTriggersFromSim(sim),
      predictionTriggeredAtMs: sim.predictionTriggeredAtMs ?? null,
      predictionSensitivitySec: sim.predictionSensitivitySec ?? null,
    });
  }
  return windows.sort((a, b) => a.windowStart - b.windowStart);
}

function playTriggersFromSim(sim: RecordedWindowSimulation): PredictionTriggerPlayItem[] {
  if (Array.isArray(sim.predictionTriggers) && sim.predictionTriggers.length > 0) {
    return sim.predictionTriggers.map((t) => ({ ...t }));
  }
  // Legacy single-trigger payload.
  if (
    (sim.predictionSide === "up" || sim.predictionSide === "down") &&
    sim.predictionTriggeredAtMs != null &&
    Number.isFinite(sim.predictionTriggeredAtMs)
  ) {
    const score =
      sim.predictionScore === "right" || sim.predictionScore === "wrong"
        ? sim.predictionScore
        : "wrong";
    return [
      {
        side: sim.predictionSide,
        triggeredAtMs: sim.predictionTriggeredAtMs,
        sensitivitySec:
          sim.predictionSensitivitySec != null && Number.isFinite(sim.predictionSensitivitySec)
            ? sim.predictionSensitivitySec
            : 5,
        score,
      },
    ];
  }
  return [];
}

export interface BuildPlacementPlayOptions {
  latencyMs: number;
  fillSuccessPct?: number;
  /** Prefer this setup over Mongo (e.g. in-memory Replay editor state). */
  phaseSetup?: TradingPhaseSetup | null;
  /** When true, ignore last-Replay cache and re-simulate (fresh random fills). */
  forceResimulate?: boolean;
  /**
   * Replay idle / reset board: list recorded windows with ticks only —
   * no buy/sell markers, no trigger re-sim, do not overwrite last-Run cache.
   */
  recordingsOnly?: boolean;
  /** Replay Prediction settings (same as Schedule Run). */
  prediction?: Partial<PredictionDetectorConfig> | null;
  /** Replay Triggers (when present, replace Prediction; phase buys stay muted). */
  triggers?: unknown[] | null;
}

function ensurePlayTradeDots(windows: PlacementPlayWindowItem[]): PlacementPlayWindowItem[] {
  return windows.map((w) => {
    if (Array.isArray(w.tradeDots)) return w;
    const trade = playTradeFields(w.markers ?? [], w.windowOutcome);
    return {
      ...w,
      tradeDots: trade.tradeDots,
      bucket: trade.bucket,
      predictionScore: trade.predictionScore,
      predictionScores: trade.predictionScores,
    };
  });
}

function stripPredictionFromPlayWindows(
  windows: PlacementPlayWindowItem[],
): PlacementPlayWindowItem[] {
  return windows.map((w) => {
    const markers = (w.markers ?? []).filter((m) => markerTradeSource(m) !== "prediction");
    const trade = playTradeFields(markers, w.windowOutcome);
    // Keep predictionTriggers / sensitivity — Replay Triggers reuse that payload for
    // Open Replay Duration bands. Only strip Prediction-detector fill markers.
    return {
      ...w,
      markers,
      tradeDots: trade.tradeDots,
      bucket: trade.bucket,
      predictionScore: trade.predictionScore,
      predictionScores: trade.predictionScores,
    };
  });
}

async function listSlotRecordedWindows(
  series: string,
  placement: SchedulePlacementListItem,
): Promise<RecordedWindowDocument[]> {
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
    prevCloseAsset: w.prevCloseAsset,
    assetPrice: w.assetPrice,
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
  return allWindows.filter((w) =>
    windowMatchesPlacementSlot(
      w.windowStart,
      placement.day,
      placement.startHour,
      placement.durationHours,
    ),
  );
}

/** Clean Open Replay: recordings + official settlement only (no trade markers). */
async function buildRecordingsOnlyPlayPayload(
  market: MarketDocument,
  placement: SchedulePlacementListItem,
  latencyMs: number,
  fillSuccessPct: number,
): Promise<PlacementPlayPayload> {
  const series = market._id;
  const phaseSetup = triggerOnlyPhaseSetup();
  const empty: PlacementPlayPayload = {
    placementId: placement._id,
    setupId: placement.setupId,
    title: placement.title,
    day: placement.day,
    startHour: placement.startHour,
    durationHours: placement.durationHours,
    setup: phaseSetup,
    latencyMs,
    fillSuccessPct,
    triggerOnly: true,
    windows: [],
  };

  const slotWindows = await listSlotRecordedWindows(series, placement);
  if (slotWindows.length === 0) {
    logService.info(
      "replay",
      `Open Replay ${placement._id}: recordings-only — no slot windows`,
    );
    return empty;
  }

  const present = new Set(
    await windowsHavingReplayTickFiles(
      market,
      slotWindows.map((w) => w.windowStart),
    ),
  );
  const windows: PlacementPlayWindowItem[] = [];
  for (const window of slotWindows) {
    if (!present.has(window.windowStart)) continue;
    // Replay-usable only with explicit Gamma Up/Down on the recording.
    if (window.windowOutcome !== "up" && window.windowOutcome !== "down") continue;
    const settlement = await playSettlementFields(market, window, null);
    windows.push({
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      prevCloseAsset: settlement.prevCloseAsset,
      finalPrice: settlement.finalPrice,
      windowOutcome: settlement.windowOutcome,
      bucket: "none",
      tradeDots: [],
      pnl: 0,
      plLabel: "No trade",
      sold: false,
      markers: [],
      predictionSide: null,
      predictionScore: null,
      predictionScores: [],
      predictionTriggers: [],
      predictionTriggeredAtMs: null,
      predictionSensitivitySec: null,
    });
  }
  windows.sort((a, b) => a.windowStart - b.windowStart);

  logService.info(
    "replay",
    `Open Replay ${placement._id}: recordings-only — ${windows.length}/${slotWindows.length} window(s) with ticks (no markers)`,
  );

  return { ...empty, windows };
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

  if (options.recordingsOnly === true) {
    return buildRecordingsOnlyPlayPayload(market, placement, latencyMs, fillSuccessPct);
  }

  const triggers = normalizeReplayTriggerDefs(options.triggers);
  const triggerOnly = triggers.length > 0;
  // Triggers replace Prediction; also honor explicit prediction: null.
  const predictionOff = triggerOnly || options.prediction === null;

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
      const withFlags = {
        ...remembered,
        triggerOnly: remembered.triggerOnly === true || triggerOnly,
      };
      if (!needsEnrich) {
        const windows = ensurePlayTradeDots(remembered.windows);
        return predictionOff
          ? { ...withFlags, windows: stripPredictionFromPlayWindows(windows) }
          : { ...withFlags, windows };
      }
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
      const windows = ensurePlayTradeDots(enriched);
      const next = { ...withFlags, windows };
      rememberPlacementPlay(userId, next);
      return predictionOff
        ? { ...next, windows: stripPredictionFromPlayWindows(windows) }
        : next;
    }
  }

  let phaseSetup = options.phaseSetup ?? null;
  if (!phaseSetup && !triggerOnly) {
    const setupDoc = await getTradingSetupById(userId, placement.setupId, "replay");
    phaseSetup = setupDoc?.setup ?? null;
  }
  if (!phaseSetup) {
    phaseSetup = triggerOnly ? triggerOnlyPhaseSetup() : null;
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
    triggerOnly,
    windows: [],
  };

  if (!phaseSetup || !Array.isArray(phaseSetup.phases) || phaseSetup.phases.length !== 3) {
    logService.warn(
      "replay",
      `Open Replay ${placement._id}: missing/invalid setup (setupId=${placement.setupId})`,
    );
    return empty;
  }

  const slotWindows = await listSlotRecordedWindows(series, placement);

  if (slotWindows.length === 0) {
    logService.warn(
      "replay",
      `Open Replay ${placement._id}: no slot windows (${placement.day} @ ${placement.startHour}h × ${placement.durationHours}h, series=${series})`,
    );
    return { ...empty, setup: phaseSetup };
  }

  const windowDuration =
    slotWindows[0]?.windowEnd && slotWindows[0]?.windowStart
      ? slotWindows[0].windowEnd - slotWindows[0].windowStart
      : undefined;
  const simSetup = phaseSetupToSimSetup(phaseSetup, latencyMs, windowDuration, fillSuccessPct);
  const prediction = triggerOnly
    ? null
    : options.prediction === null
      ? null
      : normalizePredictionDetectorConfig(options.prediction);
  const tickCache = new Map<number, ReplayTickDocument[]>();

  logService.info(
    "replay",
    `Open Replay ${placement._id}: simulating ${slotWindows.length} window(s) (${placement.day} @ ${placement.startHour}h, latency ${latencyMs} ms, fill ${fillSuccessPct}%${triggerOnly ? `, ${triggers.length} trigger(s)` : ""})`,
  );

  const sims = await mapWithConcurrency(slotWindows, WINDOW_SIM_CONCURRENCY, async (window) => {
    const sim = await simulateRecordedWindow(
      market,
      series,
      window,
      simSetup,
      tickCache,
      undefined,
      prediction,
      triggerOnly ? triggers : null,
    );
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
    const trade = playTradeFields(markers, settlement.windowOutcome);
    windows.push({
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      prevCloseAsset: settlement.prevCloseAsset,
      finalPrice: settlement.finalPrice,
      windowOutcome: settlement.windowOutcome,
      bucket: trade.bucket,
      tradeDots: trade.tradeDots,
      pnl: result?.pl ?? 0,
      plLabel: result?.plLabel ?? "No trade",
      sold: Boolean(result?.sold),
      markers,
      predictionSide: sim.predictionSide ?? null,
      predictionScore: trade.predictionScore,
      predictionScores: trade.predictionScores,
      predictionTriggers: playTriggersFromSim(sim),
      predictionTriggeredAtMs: sim.predictionTriggeredAtMs ?? null,
      predictionSensitivitySec: sim.predictionSensitivitySec ?? null,
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
    triggerOnly,
    windows,
  };
  if (windows.length > 0) {
    rememberPlacementPlay(userId, payload);
  }
  return payload;
}
