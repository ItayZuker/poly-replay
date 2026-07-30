import { takeLevels, walkAsks, walkAsksAvailable, walkBids } from "./book-depth.js";
import type { WindowPredictionEvaluation } from "./prediction-detector.js";
import {
  normalizePredictionRiseCents,
  type PredictionDetectorConfig,
} from "./prediction-detector.js";
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

function sideSell(side: WindowOutcome, upBid: number, downBid: number): number {
  return side === "up" ? upBid : downBid;
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

type OpenPredPosition = {
  evaluation: WindowPredictionEvaluation;
  side: WindowOutcome;
  shares: number;
  positionCost: number;
  buyPrice: number;
  /** First tick ms where Bid >= buyPrice + Profit (after buy). */
  riseReadyAtMs: number | null;
};

/**
 * Tick-driven Prediction Trade session that races with phase Auto Trade:
 * - If phase has an open position, Prediction cannot buy.
 * - While Prediction holds, caller must pause phase buys (`isHolding()`).
 * - After Prediction sells (or settles), both may race again.
 * - Sell / Right when Bid reaches **fill price** + Profit prediction (¢).
 */
export class PredictionTradeRaceSession {
  private readonly evals: WindowPredictionEvaluation[];
  private readonly endMs: number;
  private readonly windowKey: string;
  private readonly shares: number;
  private readonly buyType: PredictionOrderType;
  private readonly sellType: PredictionOrderType;
  private readonly latency: number;
  private readonly fillSuccessPct: number;
  private readonly windowOutcome: WindowOutcome | null | undefined;
  private readonly riseCents: number;

  private evalIdx = 0;
  private open: OpenPredPosition | null = null;
  private pl = 0;
  private markers: SimMarker[] = [];
  private traded = false;

  constructor(input: {
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
  }) {
    this.evals = input.evals;
    this.endMs = input.windowEnd * 1000;
    this.windowKey = `pred:${input.windowStart}`;
    this.shares = normalizeShares(input.config.shares);
    this.buyType = normalizeOrderType(input.config.buyOrderType);
    this.sellType = normalizeOrderType(input.config.sellOrderType);
    this.latency = Math.max(0, Number(input.latencyMs) || 0);
    this.fillSuccessPct = input.fillSuccessPct;
    this.windowOutcome = input.windowOutcome;
    this.riseCents = normalizePredictionRiseCents(input.config.riseCents);
  }

  isHolding(): boolean {
    return this.open != null;
  }

  /**
   * Process Prediction sell (if due) then buy attempts that are due. Call before
   * phase tick so same-ms Prediction buy can take the race when phase is flat.
   * If the slot is busy when a buy becomes due, that Prediction trade is skipped
   * (same as a rejected live buy) — detector scoring is unchanged.
   */
  onTickBeforePhase(tick: ReplayTickDocument, phaseOpen: boolean): void {
    if (!(tick.tMs < this.endMs)) return;
    this.trySell(tick);
    this.consumeDueBuys(tick, phaseOpen);
  }

  /** Settle any still-open Prediction position at window end. */
  finalize(): PredictionTradeSimResult {
    if (this.open) {
      this.settleOpen();
      this.open = null;
    }
    return { pl: this.pl, markers: this.markers, traded: this.traded };
  }

  result(): PredictionTradeSimResult {
    return { pl: this.pl, markers: this.markers, traded: this.traded };
  }

  private trySell(tick: ReplayTickDocument): void {
    if (!this.open) return;
    const { side, shares, positionCost, buyPrice } = this.open;
    const upBid = Number(tick.yesBid);
    const downBid = Number(tick.noBid);
    if (!Number.isFinite(upBid) || !Number.isFinite(downBid)) return;

    const target = buyPrice + this.riseCents / 100;
    if (this.open.riseReadyAtMs == null) {
      if (sideSell(side, upBid, downBid) < target - 1e-12) return;
      this.open.riseReadyAtMs = tick.tMs;
    }

    const sellAt = this.open.riseReadyAtMs + this.latency;
    if (tick.tMs < sellAt) return;
    if (!(tick.tMs < this.endMs)) return;
    if (!acceptFillSuccess(this.fillSuccessPct)) {
      this.settleOpen();
      this.open = null;
      return;
    }
    const bids = bidsForSide(tick, side);
    const sellFill =
      this.sellType === "FOK"
        ? walkBids(bids, shares, true)
        : walkBidsAvailable(bids, shares, true);
    if (sellFill && sellFill.shares > 0) {
      const tradePl = sellFill.proceeds - sellFill.fees - positionCost;
      this.pl += tradePl;
      this.markers.push({
        type: "sell",
        side,
        t: tick.tMs / 1000,
        y: null,
        shares: sellFill.shares,
        price: sellFill.avgPrice,
        source: "prediction",
        proceeds: sellFill.proceeds,
        fees: sellFill.fees,
        profit: tradePl,
        windowKey: this.windowKey,
      });
      this.open = null;
      return;
    }
    this.settleOpen();
    this.open = null;
  }

  private consumeDueBuys(tick: ReplayTickDocument, phaseOpen: boolean): void {
    while (this.evalIdx < this.evals.length) {
      const evaluation = this.evals[this.evalIdx];
      const hit = evaluation?.hit;
      if (!hit || (hit.side !== "up" && hit.side !== "down")) {
        this.evalIdx += 1;
        continue;
      }
      const buyAt = hit.triggeredAtMs + this.latency;
      if (buyAt >= this.endMs) {
        this.evalIdx += 1;
        continue;
      }
      if (tick.tMs < buyAt) return;

      // Buy time arrived — consume this eval once (fill or miss).
      this.evalIdx += 1;
      if (this.open || phaseOpen) continue;
      if (!acceptFillSuccess(this.fillSuccessPct)) continue;

      const asks = asksForSide(tick, hit.side);
      const buyFill =
        this.buyType === "FOK"
          ? walkAsks(asks, this.shares, true)
          : walkAsksAvailable(asks, this.shares, true, undefined, Infinity);
      if (!buyFill || buyFill.shares <= 0) continue;

      this.traded = true;
      const positionCost = buyFill.cost + buyFill.fees;
      this.markers.push({
        type: "buy",
        side: hit.side,
        t: tick.tMs / 1000,
        y: null,
        shares: buyFill.shares,
        price: buyFill.avgPrice,
        source: "prediction",
        cost: buyFill.cost,
        fees: buyFill.fees,
        windowKey: this.windowKey,
      });
      this.open = {
        evaluation,
        side: hit.side,
        shares: buyFill.shares,
        positionCost,
        buyPrice: buyFill.avgPrice,
        riseReadyAtMs: null,
      };
      // Same tick may already meet fill+Profit (thin books / latency).
      this.trySell(tick);
      return;
    }
  }

  private settleOpen(): void {
    if (!this.open) return;
    const { side, shares, positionCost } = this.open;
    if (this.windowOutcome === "up" || this.windowOutcome === "down") {
      const won = this.windowOutcome === side;
      const settlement = won ? shares * 1 : 0;
      this.pl += settlement - positionCost;
    } else {
      this.pl -= positionCost;
    }
  }
}

/**
 * Simulate Prediction Trade fills for scored detector hits with no phase race
 * (legacy / tests). Prefer {@link PredictionTradeRaceSession} when phase Auto
 * Trade also runs in the window.
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
  const session = new PredictionTradeRaceSession(input);
  const endMs = input.windowEnd * 1000;
  for (const tick of input.ticks) {
    if (!(tick.tMs < endMs)) break;
    session.onTickBeforePhase(tick, false);
  }
  return session.finalize();
}

export function mergePredictionTradeResult(
  result: SimLastWindow | null,
  trade: PredictionTradeSimResult,
  windowStart: number,
  windowEnd: number,
): SimLastWindow | null {
  if (!trade.traded && trade.pl === 0) return result;
  const predSold = trade.markers.some((m) => m.type === "sell");
  if (result) {
    const nextPl = (Number.isFinite(result.pl) ? result.pl : 0) + trade.pl;
    return {
      ...result,
      pl: nextPl,
      sold: Boolean(result.sold) || predSold,
      plLabel: result.plLabel === "No trade" && trade.traded ? "Trade" : result.plLabel,
    };
  }
  if (!trade.traded) return null;
  return {
    windowKey: `pred:${windowStart}`,
    windowStart,
    windowEnd,
    sold: predSold,
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
