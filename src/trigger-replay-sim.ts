/**
 * Evaluate Trigger cards on ticks (Schedule Replay + Market Demo).
 * When independentBuys is false (legacy / Trade-style race): first open blocks
 * other cards until flat. When true (Demo + Replay): each card buys independently.
 */
import { takeLevels, walkAsks, walkAsksAvailable, walkBids } from "./book-depth.js";
import type { ReplayTickDocument, SimMarker, WindowOutcome } from "./types.js";

export type TriggerSellOrderType = "FAK" | "FOK" | "GTD";

export interface ReplayTriggerPriceRange {
  lowCents: number;
  highCents: number;
}

export interface ReplayTriggerGapSize {
  bound: "min" | "max";
  value: number;
}

export interface ReplayTriggerDef {
  id: string;
  name?: string;
  durationMs: number;
  buyShares: number;
  priceSide: "buy" | "sell";
  startMode: "range" | "price";
  startPriceCents: number;
  endMode: "range" | "change-side";
  endChangeSideCents: number;
  priceRanges: {
    start: ReplayTriggerPriceRange;
    end: ReplayTriggerPriceRange;
  };
  ptbGap: {
    start: "positive" | "negative" | null;
    end: "positive" | "negative" | null;
  };
  /**
   * fixed: positive/negative = market above/below PTB.
   * relative: positive = With BUY (UP→+, DOWN→−); negative = Against BUY.
   */
  gapMode: "fixed" | "relative";
  gapSize: {
    start: ReplayTriggerGapSize;
    end: ReplayTriggerGapSize;
  };
  /** Signed $ market-price change over Duration; active when both gaps share a side. */
  priceTrend: { dollars: number; bound: "min" | "max" };
  /** ¢ above buy fill to take profit (1–100). */
  takeProfitCents: number;
  /** ¢ below buy fill to stop out (1–100). */
  stopLossCents: number;
  buyOrderType: "FAK" | "FOK" | "GTD";
  sellOrderType: TriggerSellOrderType;
  windowArea: { start: number; end: number };
}

export interface TriggerReplayStat {
  triggerId: string;
  name?: string;
  success: number;
  fail: number;
  /** Held to window end and market outcome matched the buy side. */
  blue: number;
  takeProfit: number;
  stopLoss: number;
  pnlUsd: number;
}

export interface TriggerReplaySimResult {
  pl: number;
  markers: SimMarker[];
  traded: boolean;
  stats: TriggerReplayStat[];
  /** Duration bands for Open Replay (compatible with predictionTriggers shape). */
  hits: Array<{
    triggerId: string;
    side: WindowOutcome;
    triggeredAtMs: number;
    sensitivitySec: number;
    score: "right" | "wrong" | null;
  }>;
}

type Phase = "idle" | "watching" | "open";

type Rt = {
  def: ReplayTriggerDef;
  phase: Phase;
  side: WindowOutcome | null;
  watchStartedAtMs: number | null;
  startPriceCents: number | null;
  startAssetPrice: number | null;
  entryPrice: number | null;
  entryShares: number;
  positionCost: number;
  /** Realized P/L from partial exits before the round-trip is fully closed. */
  realizedPl: number;
  buyReadyAtMs: number | null;
  /** Delayed FAK/FOK exit (feed latency); GTD sells fire with latency 0. */
  exitReadyAtMs: number | null;
  exitReason: "tp" | "sl" | null;
  stats: TriggerReplayStat;
};

function isBuyGtd(def: ReplayTriggerDef): boolean {
  return (
    def.buyOrderType === "GTD" &&
    def.durationMs === 0 &&
    def.startMode === "price"
  );
}

/** Absolute Price/Range ¢ — snap to 0.1¢ steps. */
function clampCents(raw: unknown, fallback: number): number {
  const n = Math.round(Number(raw) * 10) / 10;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

function roundCentsTenths(raw: number): number {
  return Math.round(raw * 10) / 10;
}

/** Take Profit / Stop Loss: ¢ offset from buy fill (1–100). */
function clampOffsetCents(raw: unknown, fallback = 10): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, n));
}

function normalizeExitOffsets(raw: Record<string, unknown>): {
  takeProfitCents: number;
  stopLossCents: number;
} {
  const tp = Math.round(Number(raw.takeProfitCents));
  const sl = Math.round(Number(raw.stopLossCents));
  // Legacy absolute quote defaults (pre offset-from-fill) → new offset defaults.
  if (tp === 80 && (sl === 20 || !Number.isFinite(sl))) {
    return { takeProfitCents: 10, stopLossCents: 10 };
  }
  return {
    takeProfitCents: clampOffsetCents(tp, 10),
    stopLossCents: clampOffsetCents(sl, 10),
  };
}

function clampSignedCents(raw: unknown, fallback = 20): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(-100, Math.min(100, n));
}

function normalizeRange(raw: unknown): ReplayTriggerPriceRange {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const minGap = 0.1;
  let low = clampCents(o.lowCents, 40);
  let high = clampCents(o.highCents, 70);
  if (high < low + minGap) {
    high = Math.min(100, low + minGap);
    if (high < low + minGap) {
      low = Math.max(0, high - minGap);
    }
  }
  return { lowCents: low, highCents: high };
}

function normalizeGapSize(raw: unknown): ReplayTriggerGapSize {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const bound = o.bound === "max" ? "max" : "min";
  const value = Math.max(0, Number(o.value) || 0);
  return { bound, value };
}

function normalizePriceTrend(raw: unknown): { dollars: number; bound: "min" | "max" } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const bound = o.bound === "max" ? "max" : "min";
  let dollars = Number(o.dollars);
  if (!Number.isFinite(dollars)) dollars = 0;
  dollars = Math.max(-100_000, Math.min(100_000, Math.round(dollars * 100) / 100));
  return { dollars, bound };
}

function sameSideGaps(gaps: ReplayTriggerDef["ptbGap"]): boolean {
  return (
    (gaps.start === "positive" || gaps.start === "negative") && gaps.start === gaps.end
  );
}

function normalizeGapKind(raw: unknown): "positive" | "negative" | null {
  return raw === "positive" || raw === "negative" ? raw : null;
}

function normalizeGapMode(raw: unknown): "fixed" | "relative" {
  return raw === "relative" ? "relative" : "fixed";
}

/** Resolve stored gap kind to absolute market-vs-PTB sign for a buy side. */
function absoluteGapKindForSide(
  side: "up" | "down",
  kind: "positive" | "negative",
  gapMode: "fixed" | "relative",
): "positive" | "negative" {
  if (gapMode !== "relative") return kind;
  // With BUY (positive): UP→+, DOWN→−. Against BUY (negative): UP→−, DOWN→+.
  if (kind === "positive") return side === "up" ? "positive" : "negative";
  return side === "up" ? "negative" : "positive";
}

export function normalizeReplayTriggerDef(raw: unknown): ReplayTriggerDef | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = o.id != null ? String(o.id).trim() : "";
  if (!id) return null;
  const durationMs = (() => {
    const n = Math.floor(Number(o.durationMs));
    return Number.isFinite(n) && n >= 0 ? n : 5000;
  })();
  const buyShares = Math.max(1, Math.min(100000, Math.floor(Number(o.buyShares) || 10)));
  const sellOrderType: TriggerSellOrderType =
    o.sellOrderType === "FOK" || o.sellOrderType === "GTD" ? o.sellOrderType : "FAK";
  const startMode: "range" | "price" =
    o.startMode === "price" || o.startMode === "change-side" ? "price" : "range";
  const wa = o.windowArea && typeof o.windowArea === "object" ? (o.windowArea as Record<string, unknown>) : {};
  let areaStart = Number(wa.start);
  let areaEnd = Number(wa.end);
  if (!Number.isFinite(areaStart)) areaStart = 0;
  if (!Number.isFinite(areaEnd)) areaEnd = 1;
  areaStart = Math.max(0, Math.min(1, areaStart));
  areaEnd = Math.max(0, Math.min(1, areaEnd));
  if (areaEnd < areaStart) [areaStart, areaEnd] = [areaEnd, areaStart];
  const ranges =
    o.priceRanges && typeof o.priceRanges === "object"
      ? (o.priceRanges as Record<string, unknown>)
      : {};
  const gaps = o.ptbGap && typeof o.ptbGap === "object" ? (o.ptbGap as Record<string, unknown>) : {};
  const gapSize =
    o.gapSize && typeof o.gapSize === "object" ? (o.gapSize as Record<string, unknown>) : {};
  const ptbGapStart =
    gaps.start === "positive" || gaps.start === "negative" ? gaps.start : null;
  const ptbGapEnd = gaps.end === "positive" || gaps.end === "negative" ? gaps.end : null;
  const hasPtbGap = ptbGapStart != null || ptbGapEnd != null;
  const buyOrderTypeRaw =
    o.buyOrderType === "FAK" || o.buyOrderType === "FOK" || o.buyOrderType === "GTD"
      ? o.buyOrderType
      : "FOK";
  const buyOrderType: "FAK" | "FOK" | "GTD" =
    buyOrderTypeRaw === "GTD" && !(durationMs === 0 && startMode === "price" && !hasPtbGap)
      ? "FOK"
      : buyOrderTypeRaw;
  return {
    id,
    name: typeof o.name === "string" ? o.name : undefined,
    durationMs,
    buyShares,
    priceSide: "buy",
    startMode,
    startPriceCents: clampCents(
      o.startPriceCents ??
        (o.startMode === "change-side" || o.startMode === "price"
          ? Math.abs(Number(o.startChangeSideCents))
          : 50),
      50,
    ),
    endMode: o.endMode === "change-side" ? "change-side" : "range",
    endChangeSideCents: clampSignedCents(o.endChangeSideCents, 20),
    priceRanges: {
      start: normalizeRange(ranges.start),
      end: normalizeRange(ranges.end),
    },
    ptbGap: {
      start: normalizeGapKind(gaps.start),
      end: normalizeGapKind(gaps.end),
    },
    gapMode: normalizeGapMode(o.gapMode),
    gapSize: {
      start: normalizeGapSize(gapSize.start),
      end: normalizeGapSize(gapSize.end),
    },
    priceTrend: normalizePriceTrend(o.priceTrend),
    ...normalizeExitOffsets(o),
    buyOrderType,
    sellOrderType,
    windowArea: { start: areaStart, end: areaEnd },
  };
}

export function normalizeReplayTriggerDefs(raw: unknown): ReplayTriggerDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeReplayTriggerDef).filter((t): t is ReplayTriggerDef => Boolean(t));
}

/** Offset 100 = that exit is disabled (never sell on that path). */
function isExitDisabled(offsetCents: number): boolean {
  return clampOffsetCents(offsetCents, 10) >= 100;
}

function emptyStat(def: ReplayTriggerDef): TriggerReplayStat {
  return {
    triggerId: def.id,
    name: def.name,
    success: 0,
    fail: 0,
    blue: 0,
    takeProfit: 0,
    stopLoss: 0,
    pnlUsd: 0,
  };
}

function acceptFillSuccess(fillSuccessPct: number): boolean {
  const pct = Math.max(0, Math.min(100, Number(fillSuccessPct)));
  if (!(pct < 100)) return true;
  if (!(pct > 0)) return false;
  return Math.random() * 100 < pct;
}

function asksForSide(tick: ReplayTickDocument, side: WindowOutcome) {
  if (side === "up") {
    const levels = takeLevels(tick.yesAsks);
    if (levels.length) return levels;
    if (tick.yesAsk != null && Number.isFinite(tick.yesAsk)) {
      return [{ price: tick.yesAsk, size: tick.yesAskSize ?? 1e9 }];
    }
  } else {
    const levels = takeLevels(tick.noAsks);
    if (levels.length) return levels;
    if (tick.noAsk != null && Number.isFinite(tick.noAsk)) {
      return [{ price: tick.noAsk, size: tick.noAskSize ?? 1e9 }];
    }
  }
  return [];
}

function bidsForSide(tick: ReplayTickDocument, side: WindowOutcome) {
  if (side === "up") {
    const levels = takeLevels(tick.yesBids);
    if (levels.length) return levels;
    if (tick.yesBid != null && Number.isFinite(tick.yesBid)) {
      return [{ price: tick.yesBid, size: tick.yesBidSize ?? 1e9 }];
    }
  } else {
    const levels = takeLevels(tick.noBids);
    if (levels.length) return levels;
    if (tick.noBid != null && Number.isFinite(tick.noBid)) {
      return [{ price: tick.noBid, size: tick.noBidSize ?? 1e9 }];
    }
  }
  return [];
}

function walkBidsAvailable(
  bids: Array<{ price: number; size: number }>,
  maxShares: number,
  chargeTakerFee: boolean,
) {
  if (!maxShares || maxShares <= 0) return null;
  let remaining = maxShares;
  let totalProceeds = 0;
  const legs: Array<{ price: number; shares: number; fee: number }> = [];
  for (const level of bids) {
    if (remaining <= 0) break;
    if (level.size <= 0 || !Number.isFinite(level.price)) continue;
    const take = Math.min(remaining, level.size);
    if (take <= 0) continue;
    totalProceeds += take * level.price;
    legs.push({ price: level.price, shares: take, fee: 0 });
    remaining -= take;
  }
  const filled = maxShares - remaining;
  if (filled <= 0) return null;
  if (chargeTakerFee) {
    return walkBids(
      legs.map((l) => ({ price: l.price, size: l.shares })),
      filled,
      true,
    );
  }
  return {
    shares: filled,
    avgPrice: totalProceeds / filled,
    cost: 0,
    proceeds: totalProceeds,
    fees: 0,
    legs,
  };
}

function quoteCents(tick: ReplayTickDocument, side: WindowOutcome, priceSide: "buy" | "sell"): number {
  const useBid = priceSide === "sell";
  if (side === "up") {
    const v = useBid ? Number(tick.yesBid) : Number(tick.yesAsk);
    return Number.isFinite(v) ? v * 100 : NaN;
  }
  const v = useBid ? Number(tick.noBid) : Number(tick.noAsk);
  return Number.isFinite(v) ? v * 100 : NaN;
}

function bidCents(tick: ReplayTickDocument, side: WindowOutcome): number {
  const v = side === "up" ? Number(tick.yesBid) : Number(tick.noBid);
  return Number.isFinite(v) ? v * 100 : NaN;
}

function gapMatches(
  tick: ReplayTickDocument,
  kind: "positive" | "negative" | null,
  size: ReplayTriggerGapSize,
  gapMode: "fixed" | "relative" = "fixed",
  side: "up" | "down" | null = null,
): boolean {
  if (kind !== "positive" && kind !== "negative") return true;
  if (gapMode === "relative" && (side !== "up" && side !== "down")) return false;
  const absKind =
    side === "up" || side === "down"
      ? absoluteGapKindForSide(side, kind, gapMode)
      : kind;
  const gap = Number(tick.assetGap);
  if (!Number.isFinite(gap)) return false;
  if (absKind === "positive" && !(gap > 0)) return false;
  if (absKind === "negative" && !(gap < 0)) return false;
  if (!(size.value > 0)) return true;
  const abs = Math.abs(gap);
  return size.bound === "max" ? abs <= size.value : abs >= size.value;
}

function priceTrendMatches(
  def: ReplayTriggerDef,
  startAsset: number | null,
  endAsset: number | undefined,
): boolean {
  if (!sameSideGaps(def.ptbGap)) return true;
  const trend = def.priceTrend;
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

function inPriceRange(cents: number, range: ReplayTriggerPriceRange): boolean {
  if (!Number.isFinite(cents)) return false;
  const c = roundCentsTenths(cents);
  return c >= range.lowCents && c <= range.highCents;
}

/** Signed ¢ change: 0 = unchanged; +N = rose ≥ N¢; −N = fell ≥ |N|¢. */
function signedChangeMet(needRaw: number, fromCents: number, toCents: number): boolean {
  if (!Number.isFinite(fromCents) || !Number.isFinite(toCents)) return false;
  const need = clampSignedCents(needRaw, 0);
  const delta = Math.round(toCents) - Math.round(fromCents);
  if (need === 0) return delta === 0;
  if (need > 0) return delta >= need;
  return delta <= need;
}

function startConditionMet(def: ReplayTriggerDef, currentCents: number): boolean {
  if (def.startMode === "price") {
    const need = clampCents(def.startPriceCents, 50);
    return Number.isFinite(currentCents) && roundCentsTenths(currentCents) === need;
  }
  return inPriceRange(currentCents, def.priceRanges.start);
}

/**
 * Buy GTD: no gap → both UP and DOWN (Ask ≤ Price; try each side until a fill).
 * Any gap → GTD not allowed (normalize coerces to FOK); empty sides.
 */
function gtdDesiredSides(
  def: ReplayTriggerDef,
  _tick: ReplayTickDocument,
): Array<"up" | "down"> {
  const start = def.ptbGap.start;
  const end = def.ptbGap.end;
  if (
    start === "positive" ||
    start === "negative" ||
    end === "positive" ||
    end === "negative"
  ) {
    return [];
  }
  return ["up", "down"];
}

function endConditionMet(def: ReplayTriggerDef, startCents: number, endCents: number): boolean {
  if (def.endMode === "change-side") {
    return signedChangeMet(def.endChangeSideCents, startCents, endCents);
  }
  return inPriceRange(endCents, def.priceRanges.end);
}

/** Buy Ask band (¢) — same diagram band as the fire start/end condition. */
function buyAskBandCents(def: ReplayTriggerDef): { lowCents: number; highCents: number } {
  // Buy GTD: resting limit — fill when Ask ≤ Price (any ask at or below the limit).
  if (isBuyGtd(def)) {
    const p = clampCents(def.startPriceCents, 50);
    return { lowCents: 0, highCents: p };
  }
  const useStart = def.durationMs === 0 || def.endMode === "change-side";
  if (useStart) {
    if (def.startMode === "price") {
      const p = clampCents(def.startPriceCents, 50);
      return { lowCents: p, highCents: p };
    }
    return {
      lowCents: def.priceRanges.start.lowCents,
      highCents: def.priceRanges.start.highCents,
    };
  }
  return {
    lowCents: def.priceRanges.end.lowCents,
    highCents: def.priceRanges.end.highCents,
  };
}

function inApplyWindow(tick: ReplayTickDocument, windowStart: number, windowEnd: number, area: { start: number; end: number }): boolean {
  const duration = Math.max(1, windowEnd - windowStart);
  const frac = (tick.t - windowStart) / duration;
  return frac >= area.start && frac <= area.end;
}

export class TriggerReplayRaceSession {
  private readonly rts: Rt[];
  private readonly endMs: number;
  private readonly windowStart: number;
  private readonly windowEnd: number;
  private readonly latency: number;
  private readonly fillSuccessPct: number;
  private readonly windowOutcome: WindowOutcome | null | undefined;
  /** When true, cards do not block each other (Demo / Replay testing). */
  private readonly independentBuys: boolean;
  private pl = 0;
  private markers: SimMarker[] = [];
  private traded = false;
  private hits: TriggerReplaySimResult["hits"] = [];

  constructor(input: {
    triggers: ReplayTriggerDef[];
    windowStart: number;
    windowEnd: number;
    latencyMs: number;
    fillSuccessPct: number;
    windowOutcome?: WindowOutcome | null;
    /** Default false. True = each trigger may open independently. */
    independentBuys?: boolean;
  }) {
    this.windowStart = input.windowStart;
    this.windowEnd = input.windowEnd;
    this.endMs = input.windowEnd * 1000;
    this.latency = Math.max(0, Number(input.latencyMs) || 0);
    this.fillSuccessPct = input.fillSuccessPct;
    this.windowOutcome = input.windowOutcome;
    this.independentBuys = input.independentBuys === true;
    this.rts = input.triggers.map((def) => ({
      def,
      phase: "idle" as Phase,
      side: null,
      watchStartedAtMs: null,
      startPriceCents: null,
      startAssetPrice: null,
      entryPrice: null,
      entryShares: def.buyShares,
      positionCost: 0,
      realizedPl: 0,
      buyReadyAtMs: null,
      exitReadyAtMs: null,
      exitReason: null,
      stats: emptyStat(def),
    }));
  }

  /** Feed latency for taker buys; Buy GTD resting limits ignore latency. */
  private buyLatencyMs(def: ReplayTriggerDef): number {
    return isBuyGtd(def) ? 0 : this.latency;
  }

  /** Feed latency for taker sells; Sell GTD resting TP ignores latency. */
  private sellLatencyMs(def: ReplayTriggerDef): number {
    return def.sellOrderType === "GTD" ? 0 : this.latency;
  }

  isHolding(): boolean {
    return this.rts.some((rt) => rt.phase === "open" || rt.buyReadyAtMs != null);
  }

  onTickBeforePhase(tick: ReplayTickDocument, phaseOpen: boolean): void {
    if (!(tick.tMs < this.endMs)) return;
    // Independent: only an external phaseOpen (if any) can block; cards never block peers.
    // Race: snapshot open peers at tick start (same-tick multi-open still possible).
    const peerOpen =
      !this.independentBuys && this.rts.some((rt) => rt.phase === "open");
    for (const rt of this.rts) {
      this.tickOne(rt, tick, phaseOpen || peerOpen);
    }
  }

  finalize(): TriggerReplaySimResult {
    for (const rt of this.rts) {
      if (rt.phase === "open") {
        this.settleOpen(rt, "window-end", null);
      }
      rt.phase = "idle";
      rt.buyReadyAtMs = null;
    }
    return {
      pl: this.pl,
      markers: this.markers,
      traded: this.traded,
      stats: this.rts.map((rt) => ({ ...rt.stats })),
      hits: this.hits.map((h) => ({ ...h })),
    };
  }

  private tickOne(rt: Rt, tick: ReplayTickDocument, slotBusy: boolean): void {
    const def = rt.def;
    if (rt.phase === "open" && rt.side) {
      this.tryExit(rt, tick);
      return;
    }

    if (rt.buyReadyAtMs != null && rt.side) {
      if (tick.tMs < rt.buyReadyAtMs) return;
      if (slotBusy && rt.phase !== "open") {
        // Missed the race — drop this buy attempt.
        rt.buyReadyAtMs = null;
        rt.phase = "idle";
        rt.side = null;
        rt.watchStartedAtMs = null;
        rt.startPriceCents = null;
        return;
      }
      this.tryBuy(rt, tick, slotBusy);
      return;
    }

    if (!inApplyWindow(tick, this.windowStart, this.windowEnd, def.windowArea)) {
      if (rt.phase === "watching") {
        rt.phase = "idle";
        rt.side = null;
        rt.watchStartedAtMs = null;
        rt.startPriceCents = null;
      }
      return;
    }

    const durationRaw = Number(def.durationMs);
    const durationMs = Number.isFinite(durationRaw) && durationRaw >= 0 ? durationRaw : 5000;
    const priceSide = "buy" as const;
    const buyGtd = isBuyGtd(def);

    // Buy GTD: rest at Price; fill when Ask ≤ Price (no feed latency). Try each side.
    if (buyGtd) {
      const sides = gtdDesiredSides(def, tick);
      const priceCents = clampCents(def.startPriceCents, 50);
      for (const side of sides) {
        const ask = quoteCents(tick, side, "buy");
        if (!Number.isFinite(ask) || ask > priceCents + 1e-9) continue;
        rt.side = side;
        rt.watchStartedAtMs = tick.tMs;
        rt.startPriceCents = priceCents;
        rt.buyReadyAtMs = tick.tMs; // Buy GTD: no latency
        this.tryBuy(rt, tick, slotBusy);
        if (rt.phase === "open") return;
        // Fill failed (size/band) — try the other side; do not stick on UP-only.
      }
      return;
    }

    if (durationMs > 0 && rt.phase === "watching" && rt.side && rt.watchStartedAtMs != null) {
      if (tick.tMs - rt.watchStartedAtMs < durationMs) return;
      const endCents = quoteCents(tick, rt.side, priceSide);
      const endGapOk = gapMatches(
        tick,
        def.ptbGap.end,
        def.gapSize.end,
        def.gapMode,
        rt.side,
      );
      const trendOk = priceTrendMatches(def, rt.startAssetPrice, tick.assetPrice);
      if (
        endGapOk &&
        trendOk &&
        endConditionMet(def, Number(rt.startPriceCents), endCents)
      ) {
        rt.buyReadyAtMs = tick.tMs + this.buyLatencyMs(def);
        if (tick.tMs >= rt.buyReadyAtMs) {
          this.tryBuy(rt, tick, slotBusy);
        }
      } else {
        rt.phase = "idle";
        rt.side = null;
        rt.watchStartedAtMs = null;
        rt.startPriceCents = null;
        rt.startAssetPrice = null;
      }
      return;
    }

    // Ask/price first, then gap (Relative needs the candidate BUY side).
    for (const side of ["up", "down"] as const) {
      const startCents = quoteCents(tick, side, priceSide);
      if (!startConditionMet(def, startCents)) continue;
      if (!gapMatches(tick, def.ptbGap.start, def.gapSize.start, def.gapMode, side)) {
        continue;
      }
      rt.side = side;
      rt.watchStartedAtMs = tick.tMs;
      rt.startPriceCents = startCents;
      rt.startAssetPrice = Number.isFinite(Number(tick.assetPrice))
        ? Number(tick.assetPrice)
        : null;
      if (durationMs === 0) {
        // Immediate fire: start Range/Price + start gap only (no end wait).
        rt.buyReadyAtMs = tick.tMs + this.buyLatencyMs(def);
        if (tick.tMs >= rt.buyReadyAtMs) {
          this.tryBuy(rt, tick, slotBusy);
        }
      } else {
        rt.phase = "watching";
      }
      break;
    }
  }

  private tryBuy(rt: Rt, tick: ReplayTickDocument, slotBusy: boolean): void {
    if (!rt.side || slotBusy) {
      rt.buyReadyAtMs = null;
      rt.phase = "idle";
      rt.side = null;
      rt.watchStartedAtMs = null;
      rt.startPriceCents = null;
      return;
    }
    if (!acceptFillSuccess(this.fillSuccessPct)) {
      rt.buyReadyAtMs = null;
      rt.phase = "idle";
      rt.side = null;
      rt.watchStartedAtMs = null;
      rt.startPriceCents = null;
      return;
    }
    const band = buyAskBandCents(rt.def);
    const minAsk = band.lowCents / 100;
    const maxAsk = band.highCents / 100;
    const bookAsks = asksForSide(tick, rt.side);
    const bestAsk = bookAsks[0]?.price;
    rt.buyReadyAtMs = null;
    if (
      bestAsk == null ||
      !Number.isFinite(bestAsk) ||
      bestAsk < minAsk - 1e-9 ||
      bestAsk > maxAsk + 1e-9
    ) {
      rt.phase = "idle";
      rt.side = null;
      rt.watchStartedAtMs = null;
      rt.startPriceCents = null;
      return;
    }
    // Only walk asks inside the user band; share-capped (FAK / Buy GTD may partial).
    const asks = bookAsks.filter(
      (l) => l.price >= minAsk - 1e-9 && l.price <= maxAsk + 1e-9,
    );
    const buyFill =
      rt.def.buyOrderType === "FAK" || isBuyGtd(rt.def)
        ? walkAsksAvailable(asks, rt.def.buyShares, true, undefined, maxAsk)
        : walkAsks(asks, rt.def.buyShares, true);
    if (!buyFill || buyFill.shares <= 0) {
      rt.phase = "idle";
      rt.side = null;
      rt.watchStartedAtMs = null;
      rt.startPriceCents = null;
      return;
    }
    this.traded = true;
    const positionCost = buyFill.cost + buyFill.fees;
    const windowKey = `trigger:${rt.def.id}:${this.windowStart}`;
    rt.realizedPl = 0;
    this.markers.push({
      type: "buy",
      side: rt.side,
      t: tick.tMs / 1000,
      y: tick.assetPrice ?? null,
      shares: buyFill.shares,
      price: buyFill.avgPrice,
      source: "trigger",
      cost: buyFill.cost,
      fees: buyFill.fees,
      windowKey,
    });
    this.hits.push({
      triggerId: rt.def.id,
      side: rt.side,
      triggeredAtMs: tick.tMs,
      sensitivitySec: Math.max(0.001, rt.def.durationMs / 1000),
      score: null,
    });
    rt.phase = "open";
    rt.entryPrice = buyFill.avgPrice;
    rt.entryShares = buyFill.shares;
    rt.positionCost = positionCost;
    rt.watchStartedAtMs = null;
    rt.startPriceCents = null;
    this.tryExit(rt, tick);
  }

  private tryExit(rt: Rt, tick: ReplayTickDocument): void {
    if (rt.phase !== "open" || !rt.side) return;
    const bid = bidCents(tick, rt.side);
    if (!Number.isFinite(bid)) return;
    const entryCents = Number(rt.entryPrice) * 100;
    if (!Number.isFinite(entryCents)) return;
    const tpOff = clampOffsetCents(rt.def.takeProfitCents, 10);
    const slOff = clampOffsetCents(rt.def.stopLossCents, 10);
    // 100 = disabled for that exit (never sell on that path).
    const tpEnabled = !isExitDisabled(tpOff);
    const slEnabled = !isExitDisabled(slOff);
    if (!tpEnabled && !slEnabled) return;
    const tpLevel = Math.min(100, entryCents + tpOff);
    // SL only if buy price (¢) > SL offset (e.g. SL 10 needs buy > 10¢). Never floor to 0¢.
    const slActive = slEnabled && entryCents > slOff;
    const slLevel = entryCents - slOff;
    const hitTp = tpEnabled && bid >= tpLevel;
    const hitSl = slActive && bid <= slLevel;
    // TP/SL are ¢ offsets from the buy fill; TP fills only use bids at/above that target.
    if (!hitTp && !hitSl) {
      rt.exitReadyAtMs = null;
      rt.exitReason = null;
      return;
    }
    const reason = hitTp ? "tp" : "sl";
    // Arm exit clock once; Sell GTD uses 0 latency (resting TP), FAK/FOK wait feed latency.
    if (rt.exitReadyAtMs == null || rt.exitReason !== reason) {
      rt.exitReason = reason;
      rt.exitReadyAtMs = tick.tMs + this.sellLatencyMs(rt.def);
    }
    if (tick.tMs < rt.exitReadyAtMs) return;
    if (!acceptFillSuccess(this.fillSuccessPct)) {
      // Keep trying on later ticks for FAK-style; for failed roll still retry.
      return;
    }
    // GTD sell TP: limit-style (bids at/above TP). SL / FAK/FOK: book walk as before.
    const sellType =
      rt.def.sellOrderType === "FOK"
        ? "FOK"
        : rt.def.sellOrderType === "GTD" && reason === "tp"
          ? "FOK"
          : "FAK";
    const bids = bidsForSide(tick, rt.side);
    const tpLimit = tpLevel / 100;
    const sellBids =
      reason === "tp" ? bids.filter((l) => l.price >= tpLimit - 1e-9) : bids;
    const sellFill =
      sellType === "FOK"
        ? walkBids(sellBids, rt.entryShares, true)
        : walkBidsAvailable(sellBids, rt.entryShares, true);
    if (!sellFill || sellFill.shares <= 0) return;
    if (sellFill.shares + 1e-9 < rt.entryShares && sellType === "FAK") {
      // Partial: reduce remaining and keep open (stats recorded when the round-trip closes).
      const fraction = sellFill.shares / rt.entryShares;
      const costPart = rt.positionCost * fraction;
      const tradePl = sellFill.proceeds - sellFill.fees - costPart;
      this.pl += tradePl;
      rt.realizedPl += tradePl;
      this.markers.push({
        type: "sell",
        side: rt.side,
        t: tick.tMs / 1000,
        y: tick.assetPrice ?? null,
        shares: sellFill.shares,
        price: sellFill.avgPrice,
        source: "trigger",
        proceeds: sellFill.proceeds,
        fees: sellFill.fees,
        profit: tradePl,
        windowKey: `trigger:${rt.def.id}:${this.windowStart}`,
      });
      rt.entryShares -= sellFill.shares;
      rt.positionCost -= costPart;
      return;
    }
    this.settleFilled(rt, sellFill, reason, tick);
  }

  private clearPosition(rt: Rt): void {
    rt.phase = "idle";
    rt.side = null;
    rt.entryPrice = null;
    rt.entryShares = rt.def.buyShares;
    rt.positionCost = 0;
    rt.realizedPl = 0;
    rt.buyReadyAtMs = null;
    rt.exitReadyAtMs = null;
    rt.exitReason = null;
  }

  private settleFilled(
    rt: Rt,
    sellFill: { shares: number; avgPrice: number; proceeds: number; fees: number },
    reason: "tp" | "sl",
    tick: ReplayTickDocument,
  ): void {
    if (!rt.side) return;
    const tradePl = sellFill.proceeds - sellFill.fees - rt.positionCost;
    this.pl += tradePl;
    this.markers.push({
      type: "sell",
      side: rt.side,
      t: tick.tMs / 1000,
      y: tick.assetPrice ?? null,
      shares: sellFill.shares,
      price: sellFill.avgPrice,
      source: "trigger",
      proceeds: sellFill.proceeds,
      fees: sellFill.fees,
      profit: tradePl,
      windowKey: `trigger:${rt.def.id}:${this.windowStart}`,
    });
    const roundTripPl = rt.realizedPl + tradePl;
    this.recordStat(rt, reason, roundTripPl);
    const hit = this.hits[this.hits.length - 1];
    if (hit && hit.triggerId === rt.def.id && hit.score == null) {
      hit.score = roundTripPl > 0 ? "right" : "wrong";
    }
    this.clearPosition(rt);
  }

  private settleOpen(rt: Rt, reason: "window-end" | "sl" | "tp", tick: ReplayTickDocument | null): void {
    if (rt.phase !== "open" || !rt.side) return;
    const windowKey = `trigger:${rt.def.id}:${this.windowStart}`;

    // Window end without TP/SL: hold to official outcome (blue/red) — do not dump into the book.
    if (reason === "window-end") {
      let won: boolean | null = null;
      let legPl = 0;
      if (this.windowOutcome === "up" || this.windowOutcome === "down") {
        won = this.windowOutcome === rt.side;
        const settlement = won ? rt.entryShares * 1 : 0;
        legPl = settlement - rt.positionCost;
      } else {
        legPl = -rt.positionCost;
      }
      this.pl += legPl;
      // If earlier partial TP/SL sells left size open, emit a heldSettlement leg so pairing closes.
      // Pure holds leave only the buy marker → classify as blue/red held.
      if (rt.realizedPl !== 0) {
        this.markers.push({
          type: "sell",
          side: rt.side,
          t: tick ? tick.tMs / 1000 : this.windowEnd,
          y: tick?.assetPrice ?? null,
          shares: rt.entryShares,
          price: won === true ? 1 : 0,
          source: "trigger",
          proceeds: won === true ? rt.entryShares * 1 : 0,
          fees: 0,
          profit: legPl,
          heldSettlement: true,
          windowKey,
        });
      }
      this.recordStat(rt, "window-end", rt.realizedPl + legPl, won);
      const hit = this.hits[this.hits.length - 1];
      if (hit && hit.triggerId === rt.def.id && hit.score == null) {
        hit.score = won === true ? "right" : "wrong";
      }
      this.clearPosition(rt);
      return;
    }

    // Forced SL/TP path: book exit when possible.
    let tradePl = 0;
    if (tick) {
      const bids = bidsForSide(tick, rt.side);
      const sellFill = walkBidsAvailable(bids, rt.entryShares, true);
      if (sellFill && sellFill.shares > 0) {
        const fullExit = sellFill.shares + 1e-9 >= rt.entryShares;
        const costPart = fullExit
          ? rt.positionCost
          : rt.positionCost * (sellFill.shares / rt.entryShares);
        const legPl = sellFill.proceeds - sellFill.fees - costPart;
        this.pl += legPl;
        tradePl += legPl;
        this.markers.push({
          type: "sell",
          side: rt.side,
          t: tick.tMs / 1000,
          y: tick.assetPrice ?? null,
          shares: sellFill.shares,
          price: sellFill.avgPrice,
          source: "trigger",
          proceeds: sellFill.proceeds,
          fees: sellFill.fees,
          profit: legPl,
          windowKey,
        });
        if (fullExit) {
          this.recordStat(rt, reason, rt.realizedPl + tradePl, null);
          this.clearPosition(rt);
          return;
        }
        rt.entryShares -= sellFill.shares;
        rt.positionCost -= costPart;
      }
    }

    if (this.windowOutcome === "up" || this.windowOutcome === "down") {
      const won = this.windowOutcome === rt.side;
      const settlement = won ? rt.entryShares * 1 : 0;
      const legPl = settlement - rt.positionCost;
      tradePl += legPl;
      this.pl += legPl;
      this.markers.push({
        type: "sell",
        side: rt.side,
        t: tick ? tick.tMs / 1000 : this.windowEnd,
        y: tick?.assetPrice ?? null,
        shares: rt.entryShares,
        price: won ? 1 : 0,
        source: "trigger",
        proceeds: settlement,
        fees: 0,
        profit: legPl,
        heldSettlement: true,
        windowKey,
      });
      this.recordStat(rt, "window-end", rt.realizedPl + tradePl, won);
    } else {
      const legPl = -rt.positionCost;
      tradePl += legPl;
      this.pl += legPl;
      this.markers.push({
        type: "sell",
        side: rt.side,
        t: tick ? tick.tMs / 1000 : this.windowEnd,
        y: tick?.assetPrice ?? null,
        shares: rt.entryShares,
        price: 0,
        source: "trigger",
        proceeds: 0,
        fees: 0,
        profit: legPl,
        heldSettlement: true,
        windowKey,
      });
      this.recordStat(rt, "window-end", rt.realizedPl + tradePl, false);
    }
    this.clearPosition(rt);
  }

  private recordStat(
    rt: Rt,
    reason: "tp" | "sl" | "window-end",
    pnlUsd: number,
    heldWon: boolean | null = null,
  ): void {
    const pnl = Number.isFinite(pnlUsd) ? pnlUsd : 0;
    if (reason === "window-end") {
      // Win / Loss — held to settlement only.
      if (heldWon === true) rt.stats.blue += 1;
      else rt.stats.fail += 1;
    } else if (pnl > 0) {
      // Sell — early exit with profit.
      rt.stats.takeProfit += 1;
    } else {
      // Stop Loss — early exit in losing conditions.
      rt.stats.stopLoss += 1;
    }
    rt.stats.pnlUsd += pnl;
  }
}

export function mergeTriggerStats(
  into: Map<string, TriggerReplayStat>,
  batch: TriggerReplayStat[],
): void {
  for (const s of batch) {
    const cur = into.get(s.triggerId) ?? {
      triggerId: s.triggerId,
      name: s.name,
      success: 0,
      fail: 0,
      blue: 0,
      takeProfit: 0,
      stopLoss: 0,
      pnlUsd: 0,
    };
    cur.success += s.success;
    cur.fail += s.fail;
    cur.blue += s.blue ?? 0;
    cur.takeProfit += s.takeProfit;
    cur.stopLoss += s.stopLoss;
    cur.pnlUsd += s.pnlUsd;
    if (s.name) cur.name = s.name;
    into.set(s.triggerId, cur);
  }
}
