import { listTradingStatEvents } from "./trading-session-memory-repository.js";
import { listWindowTradersByStarts } from "./window-trader-repository.js";

export type WalletWinLossStats = {
  iWin: number;
  iLost: number;
};

function windowKeyUnixSec(windowKey: string | undefined | null): number {
  if (windowKey == null || windowKey === "") return NaN;
  const raw = String(windowKey).trim();
  const colon = raw.lastIndexOf(":");
  const tail = colon >= 0 ? raw.slice(colon + 1) : raw;
  const n = Number(tail);
  if (Number.isFinite(n) && n > 0) {
    return n > 1e12 ? n / 1000 : n;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms / 1000 : NaN;
}

/**
 * For each trader wallet address, count this user's settled wins/losses in
 * windows where that wallet was recorded present (series-scoped).
 */
export async function computeWalletWinLossForUser(
  userId: string,
  series: string,
): Promise<Map<string, WalletWinLossStats>> {
  const out = new Map<string, WalletWinLossStats>();
  const marketSeries = String(series ?? "").trim();
  if (!userId || !marketSeries) return out;

  const events = await listTradingStatEvents(userId, {});
  const contributions: { windowStart: number; green: number; red: number }[] = [];
  for (const event of events) {
    const eventSeries = String(event.card?.series ?? "").trim();
    if (eventSeries && eventSeries !== marketSeries) continue;
    if (!eventSeries) continue;
    const windowStart = Math.floor(windowKeyUnixSec(event.card?.windowKey));
    if (!Number.isFinite(windowStart) || windowStart <= 0) continue;
    const green = Math.max(0, Math.floor(Number(event.green) || 0));
    const red = Math.max(0, Math.floor(Number(event.red) || 0));
    if (green === 0 && red === 0) continue;
    contributions.push({ windowStart, green, red });
  }
  if (contributions.length === 0) return out;

  const starts = contributions.map((c) => c.windowStart);
  const byWindow = await listWindowTradersByStarts(marketSeries, starts);

  for (const { windowStart, green, red } of contributions) {
    const addresses = byWindow.get(windowStart);
    if (!addresses?.length) continue;
    for (const address of addresses) {
      const prev = out.get(address) ?? { iWin: 0, iLost: 0 };
      prev.iWin += green;
      prev.iLost += red;
      out.set(address, prev);
    }
  }
  return out;
}
