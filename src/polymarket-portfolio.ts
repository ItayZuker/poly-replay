import { fetchWithTimeout, sleepMs } from "./fetch-timeout.js";
import { getTradingAccountStatus } from "./trading-client.js";

const DATA_API_BASE = "https://data-api.polymarket.com";

export interface PolymarketTrade {
  proxyWallet?: string;
  side?: "BUY" | "SELL" | string;
  asset?: string;
  conditionId?: string;
  size?: number;
  price?: number;
  /** USDC notional actually exchanged (includes taker fee when present). */
  usdcSize?: number;
  timestamp?: number;
  slug?: string;
  outcome?: string;
  transactionHash?: string;
}

/**
 * Exact fee from Data API trade row when `usdcSize` is present.
 * BUY: fee ≈ usdc paid − shares×price; SELL: fee ≈ shares×price − usdc received.
 * Falls back to null when the API omitted usdcSize or the residual is noise.
 */
export function feeFromTradeUsdc(
  side: "BUY" | "SELL",
  shares: number,
  price: number,
  usdcSize: number | undefined | null,
): number | null {
  if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(price) || price <= 0) {
    return null;
  }
  if (usdcSize == null || !Number.isFinite(Number(usdcSize))) return null;
  const usdc = Number(usdcSize);
  const notional = shares * price;
  const raw = side === "BUY" ? usdc - notional : notional - usdc;
  if (!Number.isFinite(raw) || raw < 0) return null;
  // Sub-cent noise / rounding — treat as zero fee, not "unknown".
  if (raw < 1e-6) return 0;
  return Math.round(raw * 1e5) / 1e5;
}

export interface PolymarketPosition {
  proxyWallet?: string;
  asset?: string;
  conditionId?: string;
  size?: number;
  avgPrice?: number;
  initialValue?: number;
  currentValue?: number;
  cashPnl?: number;
  realizedPnl?: number;
  curPrice?: number;
  redeemable?: boolean;
  slug?: string;
  outcome?: string;
  outcomeIndex?: number;
}

export interface PolymarketClosedPosition {
  proxyWallet?: string;
  asset?: string;
  conditionId?: string;
  avgPrice?: number;
  totalBought?: number;
  realizedPnl?: number;
  curPrice?: number;
  timestamp?: number;
  slug?: string;
  outcome?: string;
  outcomeIndex?: number;
}

function funderAddress(userId: string): string | undefined {
  const addr = getTradingAccountStatus(userId).funderAddress?.trim();
  return addr || process.env.FUNDER_ADDRESS?.trim() || undefined;
}

async function fetchJsonArray<T>(url: string): Promise<T[]> {
  const res = await fetchWithTimeout(url, { timeoutMs: 12_000 });
  if (!res.ok) {
    throw new Error(`Data API ${res.status}: ${url}`);
  }
  const payload = (await res.json()) as unknown;
  return Array.isArray(payload) ? (payload as T[]) : [];
}

export async function fetchUserTrades(
  userId: string,
  options: {
    asset?: string;
    conditionId?: string;
    limit?: number;
  },
): Promise<PolymarketTrade[]> {
  const user = funderAddress(userId);
  if (!user) return [];
  const params = new URLSearchParams({
    user,
    limit: String(options.limit ?? 25),
  });
  if (options.asset) params.set("asset", options.asset);
  if (options.conditionId) params.set("market", options.conditionId);
  return fetchJsonArray<PolymarketTrade>(`${DATA_API_BASE}/trades?${params}`);
}

export async function fetchUserPositions(
  userId: string,
  options: {
    conditionId?: string;
    sizeThreshold?: number;
    limit?: number;
  },
): Promise<PolymarketPosition[]> {
  const user = funderAddress(userId);
  if (!user) return [];
  const params = new URLSearchParams({
    user,
    limit: String(Math.max(1, Math.min(500, options.limit ?? 100))),
    sizeThreshold: String(options.sizeThreshold ?? 0),
  });
  if (options.conditionId) params.set("market", options.conditionId);
  return fetchJsonArray<PolymarketPosition>(`${DATA_API_BASE}/positions?${params}`);
}

export async function fetchClosedPositions(
  userId: string,
  options: {
    conditionId?: string;
    limit?: number;
  },
): Promise<PolymarketClosedPosition[]> {
  const user = funderAddress(userId);
  if (!user) return [];
  const params = new URLSearchParams({
    user,
    limit: String(options.limit ?? 20),
    sortBy: "TIMESTAMP",
    sortDirection: "DESC",
  });
  if (options.conditionId) params.set("market", options.conditionId);
  return fetchJsonArray<PolymarketClosedPosition>(
    `${DATA_API_BASE}/closed-positions?${params}`,
  );
}

export async function pollUntil<T>(
  attempt: () => Promise<T | null>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T | null> {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? 800;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const result = await attempt();
      if (result != null) return result;
    } catch {
      // retry
    }
    if (i < attempts - 1) await sleepMs(delayMs);
  }
  return null;
}

export function isValidSharePrice(price: unknown): boolean {
  const n = Number(price);
  return Number.isFinite(n) && n > 0 && n <= 1;
}

export function isValidShareSize(size: unknown): boolean {
  const n = Number(size);
  return Number.isFinite(n) && n > 0;
}

/** Polymarket position `outcome` is the token held (Up/Down), not the market winner. */
export function outcomeLabelMatchesSide(
  outcome: string | undefined | null,
  side: "up" | "down",
): boolean {
  const o = String(outcome ?? "")
    .trim()
    .toLowerCase();
  if (!o) return false;
  if (side === "up") return o === "up" || o === "yes";
  return o === "down" || o === "no";
}

/** Token mark is final enough to settle (~0¢ or ~100¢). */
export function isClearlyResolvedTokenPrice(curPrice: unknown): boolean {
  if (curPrice == null || !Number.isFinite(Number(curPrice))) return false;
  const cur = Number(curPrice);
  return cur <= 0.02 || cur >= 0.98;
}

export function findTrade(
  trades: PolymarketTrade[],
  opts: {
    side: "BUY" | "SELL";
    asset?: string;
    conditionId?: string;
    afterTs?: number;
  },
): PolymarketTrade | undefined {
  // Never match an unrelated market — require asset and/or conditionId.
  if (!opts.asset && !opts.conditionId) return undefined;

  const afterTs = opts.afterTs ?? 0;
  return trades.find((t) => {
    if (String(t.side || "").toUpperCase() !== opts.side) return false;
    if (opts.asset) {
      if (!t.asset || t.asset !== opts.asset) return false;
    }
    if (opts.conditionId) {
      if (!t.conditionId || t.conditionId !== opts.conditionId) return false;
    }
    const ts = Number(t.timestamp);
    if (Number.isFinite(ts) && ts + 2 < afterTs) return false;
    return isValidShareSize(t.size) && isValidSharePrice(t.price);
  });
}

export function findPosition(
  positions: PolymarketPosition[],
  opts: { asset?: string; conditionId?: string } = {},
): PolymarketPosition | undefined {
  if (!opts.asset && !opts.conditionId) return undefined;
  return positions.find((p) => {
    if (opts.asset) {
      if (!p.asset || p.asset !== opts.asset) return false;
    }
    if (opts.conditionId) {
      if (!p.conditionId || p.conditionId !== opts.conditionId) return false;
    }
    return isValidShareSize(p.size) && isValidSharePrice(p.avgPrice);
  });
}

/** True when an open position has resolved (redeemable or token ~0¢/~100¢). Losses often stay here instead of closed-positions. */
export function isResolvedPosition(p: PolymarketPosition): boolean {
  if (!isValidShareSize(p.size) || !isValidSharePrice(p.avgPrice)) return false;
  if (p.redeemable) return true;
  if (p.curPrice == null || !Number.isFinite(Number(p.curPrice))) return false;
  const cur = Number(p.curPrice);
  return cur <= 0.02 || cur >= 0.98;
}

/**
 * Find a resolved open position for held-to-settlement confirmation.
 * Prefer exact asset match; fall back to conditionId + side (never the opposite token).
 */
export function findResolvedPosition(
  positions: PolymarketPosition[],
  opts: { asset?: string; conditionId?: string; side?: "up" | "down" },
): PolymarketPosition | undefined {
  if (!opts.asset && !opts.conditionId) return undefined;

  const sideOk = (p: PolymarketPosition) =>
    !opts.side ||
    !p.outcome ||
    outcomeLabelMatchesSide(p.outcome, opts.side);

  if (opts.asset) {
    const byAsset = positions.find(
      (p) =>
        p.asset === opts.asset &&
        isResolvedPosition(p) &&
        sideOk(p) &&
        (!opts.conditionId || p.conditionId === opts.conditionId),
    );
    if (byAsset) return byAsset;
  }

  if (opts.conditionId) {
    // Prefer a row whose outcome label matches the bet side.
    if (opts.side) {
      const bySide = positions.find(
        (p) =>
          p.conditionId === opts.conditionId &&
          isResolvedPosition(p) &&
          outcomeLabelMatchesSide(p.outcome, opts.side!),
      );
      if (bySide) return bySide;
    }
    // Only accept conditionId-only when the row has no outcome label to contradict.
    return positions.find(
      (p) =>
        p.conditionId === opts.conditionId &&
        isResolvedPosition(p) &&
        (!p.outcome || (opts.side ? outcomeLabelMatchesSide(p.outcome, opts.side) : true)),
    );
  }

  return undefined;
}

export function findClosedPosition(
  closed: PolymarketClosedPosition[],
  opts: { asset?: string; conditionId?: string; afterTs?: number; side?: "up" | "down" },
): PolymarketClosedPosition | undefined {
  if (!opts.asset && !opts.conditionId) return undefined;
  const afterTs = opts.afterTs ?? 0;
  const matches = closed.filter((p) => {
    if (opts.asset) {
      if (!p.asset || p.asset !== opts.asset) return false;
    }
    if (opts.conditionId) {
      if (!p.conditionId || p.conditionId !== opts.conditionId) return false;
    }
    if (opts.side && p.outcome && !outcomeLabelMatchesSide(p.outcome, opts.side)) {
      return false;
    }
    const ts = Number(p.timestamp);
    if (Number.isFinite(ts) && ts + 2 < afterTs) return false;
    if (p.realizedPnl == null || !Number.isFinite(Number(p.realizedPnl))) return false;
    // avgPrice can be missing on some closed rows; if present it must be valid
    if (p.avgPrice != null && !isValidSharePrice(p.avgPrice)) return false;
    return true;
  });
  if (matches.length === 0) return undefined;
  if (opts.side) {
    const labeled = matches.find((p) => outcomeLabelMatchesSide(p.outcome, opts.side!));
    if (labeled) return labeled;
  }
  return matches[0];
}
