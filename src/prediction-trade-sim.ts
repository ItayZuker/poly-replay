import { takeLevels, walkAsks, walkAsksAvailable, walkBids } from "./book-depth.js";
import type { WindowPredictionEvaluation } from "./prediction-detector.js";
import type { PredictionDetectorConfig } from "./prediction-detector.js";
import type { ReplayTickDocument, SimLastWindow, SimMarker, WindowOutcome } from "./types.js";

export type PredictionOrderType = "FAK" | "FOK";

function normalizeOrderType(raw: unknown, fallback: PredictionOrderType = "FOK"): PredictionOrderType {
  return raw === "FAK" || raw === "FOK" ? raw : fallback;
}

function normalizeShares(raw: unknown, fallback = 10): number {
  const n = Math.floor(Number(raw));
  return Math.max(1, Math.min(100000, Number.isFinite(n) && n > 0 ? n : fallback));
}

function acceptFillSuccess(fillSuccessPct: number): boolean {
  const pct = Math.max(0, Math.min(100, Number(fillSuccessPct)));
  if (!(pct < 100)) return true;
  if (!(pct > 0)) return false;
  return Math.random() * 100 < pct;
}

function tickAtOrAfter(
  ticks: ReplayTickDocument[],
  tMs: number,
  endMs: number,
): ReplayTickDocument | null {
  for (const tick of ticks) {
    if (tick.tMs < tMs) continue;
    if (!(tick.tMs < endMs)) break;
    return tick;
  }
  return null;
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

/** FAK-style taker sell: fill up to maxShares from available bids; partial OK. */
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
  // Fees via walkBids path when full; for partial reuse walkBids on truncated size.
  if (chargeTakerFee) {
    const full = walkBids(
      legs.map((l) => ({ price: l.price, size: l.shares })),
      filled,
      true,
    );
    return full;
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

export interface PredictionTradeSimResult {
  pl: number;
  markers: SimMarker[];
  traded: boolean;
}

/**
 * Simulate Prediction Trade fills for scored detector hits: Buy after latency at
 * trigger, Sell after latency at Profit hit (or settle at window end if Wrong).
 */
export function simulatePredictionTrades(input: {
  ticks: ReplayTickDocument[];
  evals: WindowPredictionEvaluation[];
  config: PredictionDetectorConfig & {
    shares?: number;
    buyOrderType?: PredictionOrderType;
    sellOrderType?: PredictionOrderType;
  };
  windowStart: number;
  windowEnd: number;
  latencyMs: number;
  fillSuccessPct: number;
  windowOutcome?: WindowOutcome | null;
}): PredictionTradeSimResult {
  const {
    ticks,
    evals,
    config,
    windowStart,
    windowEnd,
    latencyMs,
    fillSuccessPct,
    windowOutcome,
  } = input;
  const endMs = windowEnd * 1000;
  const windowKey = `pred:${windowStart}`;
  const shares = normalizeShares(config.shares);
  const buyType = normalizeOrderType(config.buyOrderType);
  const sellType = normalizeOrderType(config.sellOrderType);
  const latency = Math.max(0, Number(latencyMs) || 0);
  let pl = 0;
  const markers: SimMarker[] = [];
  let traded = false;

  for (const evaluation of evals) {
    const hit = evaluation.hit;
    if (!hit || (hit.side !== "up" && hit.side !== "down")) continue;
    const buyAt = hit.triggeredAtMs + latency;
    if (!(buyAt < endMs)) continue;
    const buyTick = tickAtOrAfter(ticks, buyAt, endMs);
    if (!buyTick) continue;
    if (!acceptFillSuccess(fillSuccessPct)) continue;

    const asks = asksForSide(buyTick, hit.side);
    const buyFill =
      buyType === "FOK"
        ? walkAsks(asks, shares, true)
        : walkAsksAvailable(asks, shares, true, undefined, Infinity);
    if (!buyFill || buyFill.shares <= 0) continue;

    traded = true;
    const positionCost = buyFill.cost + buyFill.fees;
    markers.push({
      type: "buy",
      side: hit.side,
      t: buyTick.tMs / 1000,
      y: null,
      shares: buyFill.shares,
      price: buyFill.avgPrice,
      cost: buyFill.cost,
      fees: buyFill.fees,
      windowKey,
    });

    if (evaluation.score === "right" && evaluation.resolvedAtMs != null) {
      const sellAt = evaluation.resolvedAtMs + latency;
      const sellTick =
        sellAt < endMs ? tickAtOrAfter(ticks, sellAt, endMs) : null;
      if (sellTick && acceptFillSuccess(fillSuccessPct)) {
        const bids = bidsForSide(sellTick, hit.side);
        const sellFill =
          sellType === "FOK"
            ? walkBids(bids, buyFill.shares, true)
            : walkBidsAvailable(bids, buyFill.shares, true);
        if (sellFill && sellFill.shares > 0) {
          const tradePl = sellFill.proceeds - sellFill.fees - positionCost;
          pl += tradePl;
          markers.push({
            type: "sell",
            side: hit.side,
            t: sellTick.tMs / 1000,
            y: null,
            shares: sellFill.shares,
            price: sellFill.avgPrice,
            proceeds: sellFill.proceeds,
            fees: sellFill.fees,
            profit: tradePl,
            windowKey,
          });
          continue;
        }
      }
    }

    // Wrong or failed sell: settle vs official window outcome if known.
    if (windowOutcome === "up" || windowOutcome === "down") {
      const won = windowOutcome === hit.side;
      const settlement = won ? buyFill.shares * 1 : 0;
      pl += settlement - positionCost;
    } else {
      // No outcome: mark-to-zero remaining (lose premium).
      pl -= positionCost;
    }
  }

  return { pl, markers, traded };
}

export function mergePredictionTradeResult(
  result: SimLastWindow | null,
  trade: PredictionTradeSimResult,
  windowStart: number,
  windowEnd: number,
): SimLastWindow | null {
  if (!trade.traded && trade.pl === 0) return result;
  if (result) {
    const nextPl = (Number.isFinite(result.pl) ? result.pl : 0) + trade.pl;
    return {
      ...result,
      pl: nextPl,
      plLabel: result.plLabel === "No trade" && trade.traded ? "Trade" : result.plLabel,
    };
  }
  if (!trade.traded) return null;
  return {
    windowKey: `pred:${windowStart}`,
    windowStart,
    windowEnd,
    sold: trade.markers.some((m) => m.type === "sell"),
    pl: trade.pl,
    plLabel: "Trade",
  };
}

export function normalizePredictionTradeFields(raw: {
  shares?: unknown;
  buyOrderType?: unknown;
  sellOrderType?: unknown;
} | null | undefined): {
  shares: number;
  buyOrderType: PredictionOrderType;
  sellOrderType: PredictionOrderType;
} {
  return {
    shares: normalizeShares(raw?.shares),
    buyOrderType: normalizeOrderType(raw?.buyOrderType),
    sellOrderType: normalizeOrderType(raw?.sellOrderType),
  };
}
