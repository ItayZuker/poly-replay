import { fetchWithTimeout, sleepMs } from "./fetch-timeout.js";
import { roundTo4 } from "./tick-compact.js";
import type { WindowOutcome } from "./types.js";

const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";

/** Only treat near-settled token prices as official (~1 / ~0). */
const RESOLVED_PRICE_MIN = 0.95;

export interface GammaWindowResolution {
  outcome: WindowOutcome;
  finalPrice?: number;
  priceToBeat?: number;
  yesPrice?: number;
  noPrice?: number;
}

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeOutcomeLabel(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

/** Map outcomePrices by Up/Down (or Yes/No) labels; fall back to [0]=Up, [1]=Down. */
export function pricesFromGammaMarket(market: Record<string, unknown>): {
  yesPrice?: number;
  noPrice?: number;
} {
  const prices = parseJsonArray<string>(market.outcomePrices).map(Number);
  const outcomes = parseJsonArray<string>(market.outcomes).map(normalizeOutcomeLabel);

  const upIdx = outcomes.findIndex((o) => o === "up" || o === "yes");
  const downIdx = outcomes.findIndex((o) => o === "down" || o === "no");

  if (upIdx >= 0 && downIdx >= 0) {
    return {
      yesPrice: Number.isFinite(prices[upIdx]) ? prices[upIdx] : undefined,
      noPrice: Number.isFinite(prices[downIdx]) ? prices[downIdx] : undefined,
    };
  }

  return {
    yesPrice: Number.isFinite(prices[0]) ? prices[0] : undefined,
    noPrice: Number.isFinite(prices[1]) ? prices[1] : undefined,
  };
}

/**
 * Resolved Gamma markets expose ~1 / ~0 on the winning side.
 * Do not treat mid-book prices (e.g. 0.85) as resolved — those are common
 * right after the window ends and often disagree with the eventual winner.
 */
export function outcomeFromGammaPrices(
  yesPrice?: number,
  noPrice?: number,
): WindowOutcome | undefined {
  if (yesPrice != null && Number.isFinite(yesPrice) && yesPrice >= RESOLVED_PRICE_MIN) {
    return "up";
  }
  if (noPrice != null && Number.isFinite(noPrice) && noPrice >= RESOLVED_PRICE_MIN) {
    return "down";
  }
  return undefined;
}

/** Official Chainlink close vs PTB (Polymarket Up = close >= open). */
export function outcomeFromFinalVsPtb(
  finalPrice?: number,
  priceToBeat?: number,
): WindowOutcome | undefined {
  if (
    finalPrice == null ||
    priceToBeat == null ||
    !Number.isFinite(finalPrice) ||
    !Number.isFinite(priceToBeat)
  ) {
    return undefined;
  }
  return finalPrice >= priceToBeat ? "up" : "down";
}

/** One-shot Gamma lookup by market/event slug. Returns null if not resolved yet. */
export async function fetchGammaWindowResolution(
  slug: string,
  signal?: AbortSignal,
): Promise<GammaWindowResolution | null> {
  const trimmed = slug.trim();
  if (!trimmed) return null;

  const res = await fetchWithTimeout(
    `${GAMMA_EVENTS_URL}?slug=${encodeURIComponent(trimmed)}`,
    { signal },
  );
  if (!res.ok) {
    throw new Error(`Gamma events error (${res.status})`);
  }

  const events = (await res.json()) as Record<string, unknown>[];
  if (!Array.isArray(events) || events.length === 0) return null;

  const event = events[0];
  const markets = event.markets as Record<string, unknown>[] | undefined;
  const market = markets?.[0];
  if (!market) return null;

  const { yesPrice, noPrice } = pricesFromGammaMarket(market);

  const meta = event.eventMetadata as
    | { finalPrice?: number; priceToBeat?: number }
    | undefined;
  const finalPrice =
    meta?.finalPrice != null && Number.isFinite(meta.finalPrice)
      ? roundTo4(meta.finalPrice)
      : undefined;
  const priceToBeat =
    meta?.priceToBeat != null && Number.isFinite(meta.priceToBeat)
      ? roundTo4(meta.priceToBeat)
      : undefined;

  // Prefer Chainlink metadata when present; otherwise require ~1/0 token prices.
  const outcome =
    outcomeFromFinalVsPtb(finalPrice, priceToBeat) ??
    outcomeFromGammaPrices(yesPrice, noPrice);
  if (!outcome) return null;

  return { outcome, finalPrice, priceToBeat, yesPrice, noPrice };
}

/**
 * Wait until Gamma marks the market resolved (outcomePrices ~1/0 or final vs PTB).
 * Used at live window finalize — resolution can lag a few seconds.
 */
export async function waitForGammaWindowResolution(
  slug: string,
  options: { maxWaitMs?: number; intervalMs?: number } = {},
): Promise<GammaWindowResolution | null> {
  const maxWaitMs = options.maxWaitMs ?? 25_000;
  const intervalMs = options.intervalMs ?? 500;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= maxWaitMs) {
    try {
      const resolution = await fetchGammaWindowResolution(slug);
      if (resolution) return resolution;
    } catch {
      // keep polling until maxWaitMs
    }
    await sleepMs(intervalMs);
  }

  return null;
}
