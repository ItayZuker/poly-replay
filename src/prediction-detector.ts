import type { WindowOutcome } from "./types.js";

export interface PredictionDetectorConfig {
  /** Seconds the adverse UP/DOWN vs gap condition must hold. */
  sensitivitySec: number;
  /**
   * Max Buy price (¢) allowed when Duration starts on the cheapening side
   * (UP Buy for Prediction DOWN, DOWN Buy for Prediction UP).
   */
  maxQuoteCents: number;
  /**
   * Min Buy price (¢) allowed when Duration starts on the cheapening side
   * (same side as Max Quote). Must be ≤ Max Quote.
   */
  minQuoteCents: number;
  /** Minimum drop (¢) of that cheapening Buy over Duration. */
  shiftCents: number;
  /**
   * Profit prediction (¢): after trigger, predicted-side Buy must rise by at
   * least this many ¢ sometime before window end for the prediction to score right.
   */
  riseCents: number;
  /** Start of detection area as fraction of the market window [0, 1]. */
  areaStart: number;
  /** End of detection area as fraction of the market window [0, 1]. */
  areaEnd: number;
}

export interface PredictionTickSample {
  tMs: number;
  assetGap?: number;
  assetPrice?: number;
  prevCloseAsset?: number;
  yesAsk?: number;
  noAsk?: number;
  yesBid?: number;
  noBid?: number;
}

const SAMPLE_MAX = 600;

export function normalizePredictionSensitivitySec(value: unknown, fallback = 5): number {
  const n = Number(value);
  return Math.max(1, Math.min(120, Math.round(Number.isFinite(n) ? n : fallback)));
}

export function normalizePredictionMaxQuoteCents(value: unknown, fallback = 90): number {
  const n = Math.round(Number(value));
  return Math.max(1, Math.min(99, Number.isFinite(n) ? n : fallback));
}

export function normalizePredictionMinQuoteCents(value: unknown, fallback = 70): number {
  const n = Math.round(Number(value));
  return Math.max(1, Math.min(99, Number.isFinite(n) ? n : fallback));
}

export function normalizePredictionShiftCents(value: unknown, fallback = 5): number {
  const n = Math.round(Number(value));
  return Math.max(1, Math.min(50, Number.isFinite(n) ? n : fallback));
}

export function normalizePredictionRiseCents(value: unknown, fallback = 5): number {
  const n = Math.round(Number(value));
  return Math.max(1, Math.min(50, Number.isFinite(n) ? n : fallback));
}

/** Normalize Min/Max Quote band; clamps Min so it never exceeds Max. */
export function normalizePredictionQuoteBand(
  minRaw: unknown,
  maxRaw: unknown,
  fallbacks: { min?: number; max?: number } = {},
): { minQuoteCents: number; maxQuoteCents: number } {
  const maxQuoteCents = normalizePredictionMaxQuoteCents(maxRaw, fallbacks.max ?? 90);
  let minQuoteCents = normalizePredictionMinQuoteCents(minRaw, fallbacks.min ?? 70);
  if (minQuoteCents > maxQuoteCents) minQuoteCents = maxQuoteCents;
  return { minQuoteCents, maxQuoteCents };
}

export function normalizePredictionArea(
  startRaw: unknown,
  endRaw: unknown,
): { areaStart: number; areaEnd: number } {
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
  return { areaStart: start, areaEnd: end };
}

export function normalizePredictionDetectorConfig(
  raw: Partial<PredictionDetectorConfig> | null | undefined,
): PredictionDetectorConfig {
  const area = normalizePredictionArea(raw?.areaStart, raw?.areaEnd);
  const quotes = normalizePredictionQuoteBand(raw?.minQuoteCents, raw?.maxQuoteCents);
  return {
    sensitivitySec: normalizePredictionSensitivitySec(raw?.sensitivitySec),
    ...quotes,
    shiftCents: normalizePredictionShiftCents(raw?.shiftCents),
    riseCents: normalizePredictionRiseCents(raw?.riseCents),
    ...area,
  };
}

function gapFromTick(tick: PredictionTickSample): number | null {
  if (tick.assetGap != null && Number.isFinite(tick.assetGap)) return tick.assetGap;
  if (
    tick.assetPrice != null &&
    tick.prevCloseAsset != null &&
    Number.isFinite(tick.assetPrice) &&
    Number.isFinite(tick.prevCloseAsset)
  ) {
    return tick.assetPrice - tick.prevCloseAsset;
  }
  return null;
}

function isInArea(
  tMs: number,
  windowStart: number,
  windowEnd: number,
  areaStart: number,
  areaEnd: number,
): boolean {
  if (!(windowEnd > windowStart)) return false;
  const tSec = tMs / 1000;
  if (tSec < windowStart || tSec >= windowEnd) return false;
  const frac = (tSec - windowStart) / (windowEnd - windowStart);
  return frac >= areaStart && frac <= areaEnd;
}

/**
 * On top of Gap/adverse-buy rules: the cheapening Buy must be within
 * [Min Quote, Max Quote] when Duration starts, and must drop by at least Shift
 * over Duration.
 */
export function meetsPredictionMaxQuoteAndShift(
  predictionSide: WindowOutcome,
  baseline: { upBuy: number; downBuy: number },
  now: { upBuy: number; downBuy: number },
  maxQuoteCents: number,
  shiftCents: number,
  minQuoteCents = 70,
): boolean {
  const { minQuoteCents: minQ, maxQuoteCents: maxQ } = normalizePredictionQuoteBand(
    minQuoteCents,
    maxQuoteCents,
  );
  const minP = minQ / 100;
  const maxP = maxQ / 100;
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

export interface WindowPredictionHit {
  side: WindowOutcome;
  /** Tick time (ms) when the detector first fired. */
  triggeredAtMs: number;
  /** Predicted-side Buy (0–1) at trigger time. */
  triggerSideBuy: number;
}

function sideBuy(side: WindowOutcome, upBuy: number, downBuy: number): number {
  return side === "up" ? upBuy : downBuy;
}

export interface WindowPredictionEvaluation {
  hit: WindowPredictionHit;
  score: "right" | "wrong";
  /** Tick time (ms) when Profit prediction was met; null when Wrong. */
  resolvedAtMs: number | null;
}

/**
 * Walk recorded ticks and return the first Prediction hit for the window, or null.
 * Mirrors the live Market Prediction detector rules.
 */
export function evaluateWindowPrediction(
  ticks: PredictionTickSample[],
  windowStart: number,
  windowEnd: number,
  configInput?: Partial<PredictionDetectorConfig> | null,
): WindowPredictionHit | null {
  const all = evaluateWindowPredictions(ticks, windowStart, windowEnd, configInput);
  return all[0]?.hit ?? null;
}

/**
 * Walk recorded ticks and return every Prediction trigger in the window.
 * After a Right, detection can fire again while still inside Trigger Area
 * (same as live). An open trigger at window end scores Wrong.
 */
export function evaluateWindowPredictions(
  ticks: PredictionTickSample[],
  windowStart: number,
  windowEnd: number,
  configInput?: Partial<PredictionDetectorConfig> | null,
): WindowPredictionEvaluation[] {
  const config = normalizePredictionDetectorConfig(configInput);
  const samples: Array<{ tMs: number; gap: number; upBuy: number; downBuy: number }> = [];
  const out: WindowPredictionEvaluation[] = [];
  let active: WindowPredictionHit | null = null;
  const endMs = windowEnd * 1000;
  const riseP = config.riseCents / 100;

  for (const tick of ticks) {
    if (!(tick.tMs < endMs)) break;

    const gap = gapFromTick(tick);
    const upBuy = Number(tick.yesAsk);
    const downBuy = Number(tick.noAsk);

    if (
      gap == null ||
      gap === 0 ||
      !Number.isFinite(upBuy) ||
      !Number.isFinite(downBuy)
    ) {
      continue;
    }

    const nowMs = tick.tMs;

    if (active) {
      if (sideBuy(active.side, upBuy, downBuy) >= active.triggerSideBuy + riseP - 1e-12) {
        out.push({ hit: active, score: "right", resolvedAtMs: nowMs });
        active = null;
        samples.length = 0;
      }
      continue;
    }

    if (!isInArea(nowMs, windowStart, windowEnd, config.areaStart, config.areaEnd)) {
      samples.length = 0;
      continue;
    }

    samples.push({ tMs: nowMs, gap, upBuy, downBuy });
    const cutoff = nowMs - (config.sensitivitySec + 2) * 1000;
    while (samples.length > 0 && samples[0].tMs < cutoff) {
      samples.shift();
    }
    if (samples.length > SAMPLE_MAX) {
      samples.splice(0, samples.length - SAMPLE_MAX);
    }

    const targetT = nowMs - config.sensitivitySec * 1000;
    let baseline: (typeof samples)[number] | null = null;
    for (const sample of samples) {
      if (sample.tMs <= targetT) baseline = sample;
      else break;
    }
    if (!baseline || nowMs - baseline.tMs < config.sensitivitySec * 1000) continue;

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
          config.maxQuoteCents,
          config.shiftCents,
          config.minQuoteCents,
        )
      ) {
        active = {
          side: "down",
          triggeredAtMs: nowMs,
          triggerSideBuy: downBuy,
        };
        samples.length = 0;
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
          config.maxQuoteCents,
          config.shiftCents,
          config.minQuoteCents,
        )
      ) {
        active = {
          side: "up",
          triggeredAtMs: nowMs,
          triggerSideBuy: upBuy,
        };
        samples.length = 0;
      }
    }
  }

  if (active) {
    out.push({ hit: active, score: "wrong", resolvedAtMs: null });
  }

  return out;
}

/**
 * Score a prediction by whether the predicted-side Buy rose by ≥ Profit
 * prediction (¢) anytime after trigger and before window end. Window outcome is ignored.
 */
export function scorePrediction(
  hit: WindowPredictionHit | null | undefined,
  ticks: PredictionTickSample[],
  windowEndSec: number,
  riseCents: number,
): "right" | "wrong" | null {
  if (!hit) return null;
  const riseP = normalizePredictionRiseCents(riseCents) / 100;
  // Reuse multi-hit walker for a single known trigger by scoring only that hit window span.
  if (!Number.isFinite(hit.triggeredAtMs) || !Number.isFinite(hit.triggerSideBuy)) return null;
  if (hit.side !== "up" && hit.side !== "down") return null;
  const target = hit.triggerSideBuy + riseP;
  const endMs = windowEndSec * 1000;

  for (const tick of ticks) {
    if (tick.tMs < hit.triggeredAtMs) continue;
    if (!(tick.tMs < endMs)) break;
    const upBuy = Number(tick.yesAsk);
    const downBuy = Number(tick.noAsk);
    if (!Number.isFinite(upBuy) || !Number.isFinite(downBuy)) continue;
    if (sideBuy(hit.side, upBuy, downBuy) >= target - 1e-12) {
      return "right";
    }
  }
  return "wrong";
}
