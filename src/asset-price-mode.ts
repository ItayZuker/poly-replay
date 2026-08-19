import {
  assetGapOrUnset,
  roundPolymarketAssetPrice,
  roundPolymarketAssetPriceMaybe,
} from "./polymarket-display-price.js";
import { parseMarketSeries } from "./market-pair.js";
import type { LiveWindowState } from "./types.js";

export type AssetPriceMode = "raw" | "twap30" | "twap60";

/** Default: last raw Chainlink tick on every market. */
export const DEFAULT_ASSET_PRICE_MODE: AssetPriceMode = "raw";

const modeByUser = new Map<string, AssetPriceMode>();

export function normalizeAssetPriceMode(raw: unknown): AssetPriceMode {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "twap30" || value === "30" || value === "twap_30") return "twap30";
  if (value === "twap60" || value === "60" || value === "twap_60") return "twap60";
  // Legacy Match Polymarket (series-based 30s/60s) → keep an average; 30s is global.
  if (value === "twap") return "twap30";
  return "raw";
}

export function twapLookbackSecondsForMode(mode: AssetPriceMode): 30 | 60 | null {
  if (mode === "twap30") return 30;
  if (mode === "twap60") return 60;
  return null;
}

export function rememberAssetPriceMode(userId: string, mode: AssetPriceMode): void {
  const id = String(userId || "").trim();
  if (!id) return;
  modeByUser.set(id, mode);
}

export function peekAssetPriceMode(userId?: string | null): AssetPriceMode {
  const id = String(userId || "").trim();
  if (!id) return DEFAULT_ASSET_PRICE_MODE;
  return modeByUser.get(id) ?? DEFAULT_ASSET_PRICE_MODE;
}

export function twapLookbackSecondsForTimeframe(timeframe: string): 30 | 60 {
  return String(timeframe || "").toLowerCase() === "15m" ? 60 : 30;
}

export function twapLookbackSecondsForSeries(series: string): 30 | 60 {
  try {
    return twapLookbackSecondsForTimeframe(parseMarketSeries(series).timeframe);
  } catch {
    return 30;
  }
}

export interface PriceSample {
  tMs: number;
  price: number;
}

/** Time-weighted average of a step-held price over [atMs − windowMs, atMs]. */
export function computeTwapAt(
  samples: PriceSample[],
  atMs: number,
  windowMs: number,
): number | undefined {
  if (!Number.isFinite(atMs) || !Number.isFinite(windowMs) || windowMs <= 0) {
    return undefined;
  }
  const pts = samples
    .filter(
      (s) =>
        s != null &&
        Number.isFinite(s.tMs) &&
        Number.isFinite(s.price),
    )
    .sort((a, b) => a.tMs - b.tMs);
  if (pts.length === 0) return undefined;

  const startMs = atMs - windowMs;
  let carry: number | undefined;
  for (const p of pts) {
    if (p.tMs <= startMs) carry = p.price;
    else break;
  }

  const segs: PriceSample[] = [];
  if (carry != null) segs.push({ tMs: startMs, price: carry });
  for (const p of pts) {
    if (p.tMs <= startMs) continue;
    if (p.tMs > atMs) break;
    segs.push(p);
  }
  if (segs.length === 0) {
    const last = pts[pts.length - 1];
    return last.tMs <= atMs ? last.price : undefined;
  }

  let area = 0;
  let covered = 0;
  for (let i = 0; i < segs.length; i += 1) {
    const from = Math.max(segs[i].tMs, startMs);
    const to = i + 1 < segs.length ? segs[i + 1].tMs : atMs;
    const dt = to - from;
    if (dt <= 0) continue;
    area += segs[i].price * dt;
    covered += dt;
  }
  if (covered <= 0) return segs[segs.length - 1].price;
  return area / covered;
}

export function applyTwapToReplayTicks<
  T extends {
    tMs: number;
    assetPrice?: number;
    prevCloseAsset?: number;
    assetGap?: number;
  },
>(ticks: T[], lookbackSec: number): T[] {
  const windowMs = Math.max(1, lookbackSec) * 1000;
  const samples: PriceSample[] = [];
  for (const tick of ticks) {
    if (tick.assetPrice == null || !Number.isFinite(tick.assetPrice)) continue;
    samples.push({ tMs: tick.tMs, price: tick.assetPrice });
  }
  if (samples.length === 0) return ticks;

  return ticks.map((tick) => {
    if (tick.assetPrice == null || !Number.isFinite(tick.assetPrice)) return tick;
    const twap = roundPolymarketAssetPriceMaybe(
      computeTwapAt(samples, tick.tMs, windowMs),
    );
    if (twap == null) return tick;
    return {
      ...tick,
      assetPrice: twap,
      assetGap: assetGapOrUnset(twap, tick.prevCloseAsset),
    };
  });
}

export function applyTwapToPriceHistory(
  history: Array<{ t: number; price: number }>,
  lookbackSec: number,
): Array<{ t: number; price: number }> {
  const windowMs = Math.max(1, lookbackSec) * 1000;
  const samples: PriceSample[] = history
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.price))
    .map((p) => ({ tMs: p.t * 1000, price: p.price }));
  if (samples.length === 0) return history;
  return history.map((point) => {
    const twap = roundPolymarketAssetPriceMaybe(
      computeTwapAt(samples, point.t * 1000, windowMs),
    );
    if (twap == null) return point;
    return { t: point.t, price: twap };
  });
}

function twapValueForMode(state: LiveWindowState, lookback: 30 | 60): number | undefined {
  if (lookback === 60) {
    return state.assetPriceTwap60 ?? state.assetPriceTwap;
  }
  return state.assetPriceTwap30 ?? state.assetPriceTwap;
}

/** Shared live state stores raw Current; overlay TWAP for a user who selected it. */
export function applyLiveStatePriceMode(
  state: LiveWindowState,
  mode: AssetPriceMode,
): LiveWindowState {
  const lookback = twapLookbackSecondsForMode(mode);
  if (lookback == null) return state;
  const twap = roundPolymarketAssetPriceMaybe(twapValueForMode(state, lookback));
  const history = applyTwapToPriceHistory(state.priceHistory ?? [], lookback);
  const price = twap ?? history[history.length - 1]?.price;
  if (price == null || !Number.isFinite(price)) return state;
  return {
    ...state,
    assetPrice: price,
    assetGap: assetGapOrUnset(price, state.prevCloseAsset),
    priceHistory: history,
  };
}

export function appendCappedHistory(
  history: Array<{ t: number; price: number }>,
  t: number,
  price: number,
  max = 2000,
): void {
  const last = history[history.length - 1];
  if (!last || last.t !== t || last.price !== price) {
    history.push({ t, price });
    if (history.length > max) history.splice(0, history.length - max);
  }
}

export function roundedTwapOrUndefined(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return roundPolymarketAssetPrice(value);
}
