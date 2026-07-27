import { fetchWithTimeout } from "./fetch-timeout.js";
import {
  getTraderWalletPnlCache,
  setTraderWalletPnl,
} from "./db/trader-wallet-repository.js";

const LB_API_BASE = "https://lb-api.polymarket.com";
/** Refresh Polymarket all-time PnL at most this often. */
const PNL_TTL_SEC = 6 * 60 * 60;
const FETCH_CONCURRENCY = 12;

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await worker(items[i]!);
    }
  });
  await Promise.all(runners);
  return results;
}

/** All-time realized/leaderboard PnL for a proxy wallet (Polymarket lb-api). */
export async function fetchPolymarketWalletProfit(address: string): Promise<number | null> {
  const addr = normalizeAddress(address);
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  try {
    const params = new URLSearchParams({ address: addr, window: "all" });
    const res = await fetchWithTimeout(`${LB_API_BASE}/profit?${params.toString()}`, {
      timeoutMs: 12_000,
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as unknown;
    if (!Array.isArray(payload) || payload.length === 0) return 0;
    const row = payload[0] as { amount?: unknown };
    const amount = Number(row?.amount);
    return Number.isFinite(amount) ? amount : 0;
  } catch {
    return null;
  }
}

/**
 * Resolve Polymarket all-time PnL for many wallets (Mongo cache + lb-api refresh).
 */
export async function resolvePolymarketPnls(
  addresses: string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(addresses.map(normalizeAddress).filter(Boolean))];
  const out = new Map<string, number>();
  if (unique.length === 0) return out;

  const nowSec = Math.floor(Date.now() / 1000);
  const cache = await getTraderWalletPnlCache(unique);
  const needFetch: string[] = [];

  for (const addr of unique) {
    const hit = cache.get(addr);
    if (
      hit &&
      Number.isFinite(hit.pnl) &&
      Number.isFinite(hit.updatedAt) &&
      nowSec - hit.updatedAt < PNL_TTL_SEC
    ) {
      out.set(addr, hit.pnl);
    } else {
      needFetch.push(addr);
    }
  }

  await mapPool(needFetch, FETCH_CONCURRENCY, async (addr) => {
    const fetched = await fetchPolymarketWalletProfit(addr);
    const pnl = fetched == null ? (cache.get(addr)?.pnl ?? 0) : fetched;
    out.set(addr, pnl);
    if (fetched != null) {
      await setTraderWalletPnl(addr, pnl).catch(() => undefined);
    }
    return pnl;
  });

  return out;
}
