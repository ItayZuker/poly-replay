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
  const config = normalizePredictionDetectorConfig(configInput);
  const samples: Array<{ tMs: number; gap: number; upBuy: number; downBuy: number }> = [];

  for (const tick of ticks) {
    if (!(tick.tMs < windowEnd * 1000)) break;

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

    if (!isInArea(tick.tMs, windowStart, windowEnd, config.areaStart, config.areaEnd)) {
      samples.length = 0;
      continue;
    }

    const nowMs = tick.tMs;
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
        return { side: "down", triggeredAtMs: nowMs };
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
        return { side: "up", triggeredAtMs: nowMs };
      }
    }
  }

  return null;
}

export function scorePrediction(
  side: WindowOutcome | null | undefined,
  outcome: WindowOutcome | null | undefined,
): "right" | "wrong" | null {
  if (side !== "up" && side !== "down") return null;
  if (outcome !== "up" && outcome !== "down") return null;
  return side === outcome ? "right" : "wrong";
}
