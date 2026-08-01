/**
 * Schedule Replay: evaluate user Trigger cards on recorded ticks (per window).
 * Races with phase Auto Trade the same way Prediction Trade did:
 * first open position blocks the other until flat.
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
  stats: TriggerReplayStat;
};

function clampCents(raw: unknown, fallback: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
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
  let low = clampCents(o.lowCents, 40);
  let high = clampCents(o.highCents, 70);
  if (high < low) [low, high] = [high, low];
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

export function normalizeReplayTriggerDef(raw: unknown): ReplayTriggerDef | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = o.id != null ? String(o.id).trim() : "";
  if (!id) return null;
  const durationMs = Math.max(1, Math.floor(Number(o.durationMs) || 5000));
  const buyShares = Math.max(1, Math.min(100000, Math.floor(Number(o.buyShares) || 10)));
  const sellOrderType: TriggerSellOrderType =
    o.sellOrderType === "FOK" || o.sellOrderType === "GTD" ? o.sellOrderType : "FAK";
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
  return {
    id,
    name: typeof o.name === "string" ? o.name : undefined,
    durationMs,
    buyShares,
    priceSide: o.priceSide === "sell" ? "sell" : "buy",
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
    gapSize: {
      start: normalizeGapSize(gapSize.start),
      end: normalizeGapSize(gapSize.end),
    },
    priceTrend: normalizePriceTrend(o.priceTrend),
    ...normalizeExitOffsets(o),
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
): boolean {
  if (kind !== "positive" && kind !== "negative") return true;
  const gap = Number(tick.assetGap);
  if (!Number.isFinite(gap)) return false;
  if (kind === "positive" && !(gap > 0)) return false;
  if (kind === "negative" && !(gap < 0)) return false;
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
  return Number.isFinite(cents) && cents >= range.lowCents && cents <= range.highCents;
}

function endConditionMet(def: ReplayTriggerDef, startCents: number, endCents: number): boolean {
  if (def.endMode === "change-side") {
    if (!Number.isFinite(startCents) || !Number.isFinite(endCents)) return false;
    const need = def.endChangeSideCents;
    // Round to whole ¢ so quote float noise does not count as a change.
    const delta = Math.round(endCents) - Math.round(startCents);
    // 0 = price must be unchanged (not “any rise”). +N = rose ≥ N¢; −N = fell ≥ |N|¢.
    if (need === 0) return delta === 0;
    if (need > 0) return delta >= need;
    return delta <= need;
  }
  return inPriceRange(endCents, def.priceRanges.end);
}

/** Max Ask (¢) allowed for the FOK buy — band high so fills cannot walk above the setup. */
function buyMaxAskCents(def: ReplayTriggerDef): number {
  if (def.endMode === "change-side") {
    return def.priceRanges.start.highCents;
  }
  return def.priceRanges.end.highCents;
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
  }) {
    this.windowStart = input.windowStart;
    this.windowEnd = input.windowEnd;
    this.endMs = input.windowEnd * 1000;
    this.latency = Math.max(0, Number(input.latencyMs) || 0);
    this.fillSuccessPct = input.fillSuccessPct;
    this.windowOutcome = input.windowOutcome;
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
      stats: emptyStat(def),
    }));
  }

  isHolding(): boolean {
    return this.rts.some((rt) => rt.phase === "open" || rt.buyReadyAtMs != null);
  }

  onTickBeforePhase(tick: ReplayTickDocument, phaseOpen: boolean): void {
    if (!(tick.tMs < this.endMs)) return;
    const anyTriggerOpen = this.rts.some((rt) => rt.phase === "open");
    for (const rt of this.rts) {
      this.tickOne(rt, tick, phaseOpen || anyTriggerOpen);
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

    const durationMs = def.durationMs;
    if (rt.phase === "watching" && rt.side && rt.watchStartedAtMs != null) {
      if (tick.tMs - rt.watchStartedAtMs < durationMs) return;
      const endCents = quoteCents(tick, rt.side, def.priceSide);
      const endGapOk = gapMatches(tick, def.ptbGap.end, def.gapSize.end);
      const trendOk = priceTrendMatches(def, rt.startAssetPrice, tick.assetPrice);
      if (
        endGapOk &&
        trendOk &&
        endConditionMet(def, Number(rt.startPriceCents), endCents)
      ) {
        rt.buyReadyAtMs = tick.tMs + this.latency;
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

    if (!gapMatches(tick, def.ptbGap.start, def.gapSize.start)) return;
    for (const side of ["up", "down"] as const) {
      const startCents = quoteCents(tick, side, def.priceSide);
      if (!inPriceRange(startCents, def.priceRanges.start)) continue;
      rt.phase = "watching";
      rt.side = side;
      rt.watchStartedAtMs = tick.tMs;
      rt.startPriceCents = startCents;
      rt.startAssetPrice = Number.isFinite(Number(tick.assetPrice))
        ? Number(tick.assetPrice)
        : null;
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
    const maxAsk = buyMaxAskCents(rt.def) / 100;
    const asks = asksForSide(tick, rt.side).filter((l) => l.price <= maxAsk + 1e-9);
    // Trigger buys are always FOK — full size at/below the band high, or no fill.
    const buyFill = walkAsks(asks, rt.def.buyShares, true);
    rt.buyReadyAtMs = null;
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
    const slLevel = Math.max(0, entryCents - slOff);
    const hitTp = tpEnabled && bid >= tpLevel;
    const hitSl = slEnabled && bid <= slLevel;
    // TP/SL are ¢ offsets from the buy fill; TP fills only use bids at/above that target.
    if (!hitTp && !hitSl) return;
    const reason = hitTp ? "tp" : "sl";
    if (!acceptFillSuccess(this.fillSuccessPct)) {
      // Keep trying on later ticks for FAK-style; for failed roll still retry.
      return;
    }
    const sellType = rt.def.sellOrderType === "FOK" ? "FOK" : "FAK";
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
      if (heldWon === true) rt.stats.blue += 1;
      else rt.stats.fail += 1;
    } else {
      if (pnl > 0) rt.stats.success += 1;
      else rt.stats.fail += 1;
      if (reason === "tp") rt.stats.takeProfit += 1;
      else if (reason === "sl") rt.stats.stopLoss += 1;
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
