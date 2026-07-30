import {
  fetchPolymarketCompletedSettlement,
  normalizePolymarketIso,
  type MarketWindowPriceContext,
} from "./asset-price-service.js";
import { sleepMs } from "./fetch-timeout.js";
import { fetchGammaWindowResolution } from "./gamma-window-resolution.js";
import { getUpDownDuration } from "./market-pair.js";
import type { WindowOutcome } from "./types.js";

export type OfficialOutcomeSource = "crypto-price" | "gamma";

export interface OfficialWindowResolution {
  outcome: WindowOutcome;
  source: OfficialOutcomeSource;
  finalPrice?: number;
  priceToBeat?: number;
  yesPrice?: number;
  noPrice?: number;
}

/** Derive crypto-price window bounds from `btc-updown-5m-{start}` slugs. */
function windowContextFromUpDownSlug(slug: string): {
  asset: string;
  timeframe: string;
  window: MarketWindowPriceContext;
} | null {
  const trimmed = slug.trim().toLowerCase();
  const match = trimmed.match(/^([a-z]+)-updown-(5m|15m)-(\d+)$/);
  if (!match) return null;

  const asset = match[1]!;
  const timeframe = match[2]!;
  const windowStart = Number(match[3]);
  if (!Number.isFinite(windowStart) || windowStart <= 0) return null;

  let duration: number;
  try {
    duration = getUpDownDuration(timeframe);
  } catch {
    return null;
  }
  const windowEnd = windowStart + duration;

  return {
    asset,
    timeframe,
    window: {
      eventStartTimeIso: normalizePolymarketIso(new Date(windowStart * 1000).toISOString()),
      eventEndTimeIso: normalizePolymarketIso(new Date(windowEnd * 1000).toISOString()),
      windowStart,
      windowEnd,
    },
  };
}

/**
 * Official Up/Down for a finished window.
 * Prefers Polymarket crypto-price when marked completed (site-aligned, ~10–20s),
 * else explicit Gamma resolve with ~1/~0 payout prices.
 * Never uses live Chainlink, mid-book marks, or incomplete crypto-price closes.
 */
export async function fetchOfficialWindowResolution(
  slug: string,
  signal?: AbortSignal,
): Promise<OfficialWindowResolution | null> {
  const trimmed = slug.trim();
  if (!trimmed) return null;

  const fromSlug = windowContextFromUpDownSlug(trimmed);

  const [crypto, gamma] = await Promise.all([
    fromSlug
      ? fetchPolymarketCompletedSettlement(
          fromSlug.asset,
          fromSlug.timeframe,
          fromSlug.window,
          signal,
        ).catch(() => null)
      : Promise.resolve(null),
    fetchGammaWindowResolution(trimmed, signal).catch(() => null),
  ]);

  if (crypto?.outcome === "up" || crypto?.outcome === "down") {
    return {
      outcome: crypto.outcome,
      source: "crypto-price",
      finalPrice: crypto.closePrice,
      priceToBeat: crypto.openPrice,
    };
  }

  if (gamma?.outcome === "up" || gamma?.outcome === "down") {
    return {
      outcome: gamma.outcome,
      source: "gamma",
      finalPrice: gamma.finalPrice,
      priceToBeat: gamma.priceToBeat,
      yesPrice: gamma.yesPrice,
      noPrice: gamma.noPrice,
    };
  }

  return null;
}

/**
 * Poll until crypto-price completes or Gamma explicitly resolves.
 * Used at recorder finalize — crypto-price usually lands first.
 */
export async function waitForOfficialWindowResolution(
  slug: string,
  options: { maxWaitMs?: number; intervalMs?: number } = {},
): Promise<OfficialWindowResolution | null> {
  const maxWaitMs = options.maxWaitMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 1000;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= maxWaitMs) {
    try {
      const resolution = await fetchOfficialWindowResolution(slug);
      if (resolution) return resolution;
    } catch {
      // keep polling until maxWaitMs
    }
    await sleepMs(intervalMs);
  }

  return null;
}
