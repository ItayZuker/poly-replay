import { pruneColdMarketData } from "./db/tick-archive.js";
import { listMarkets } from "./db/market-repository.js";
import { pruneInactiveWallets } from "./wallet-registry.js";
import { logService } from "./log-service.js";

const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** Trader wallets must be seen again within this many days or they are deleted. */
const TRADER_WALLET_MAX_IDLE_DAYS = 30;

let retentionTimer: ReturnType<typeof setInterval> | null = null;
let retentionInFlight = false;

export async function runRetentionForAllMarkets(): Promise<void> {
  if (retentionInFlight) return;
  retentionInFlight = true;
  try {
    const markets = await listMarkets();
    for (const market of markets) {
      try {
        await pruneColdMarketData(market);
      } catch (err) {
        logService.error("retention", `Failed for ${market._id}: ${String(err)}`);
      }
    }
    try {
      const removed = await pruneInactiveWallets(TRADER_WALLET_MAX_IDLE_DAYS);
      if (removed > 0) {
        logService.info(
          "retention",
          `Purged ${removed} trader wallet(s) idle longer than ${TRADER_WALLET_MAX_IDLE_DAYS} days`,
        );
      }
    } catch (err) {
      logService.error("retention", `Trader wallet prune failed: ${String(err)}`);
    }
  } finally {
    retentionInFlight = false;
  }
}

export function startArchiveScheduler(): void {
  if (retentionTimer) return;
  logService.info(
    "retention",
    `Scheduler started (delete tick/window data older than 14 days; trader wallets idle >${TRADER_WALLET_MAX_IDLE_DAYS} days)`,
  );
  void runRetentionForAllMarkets();
  retentionTimer = setInterval(() => {
    void runRetentionForAllMarkets();
  }, RETENTION_INTERVAL_MS);
}

export function stopArchiveScheduler(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}
