import type { WalletRegistry } from "./types.js";
import { walletsFilePath } from "./db/data-dir.js";
import { readJsonFile } from "./db/file-store.js";
import {
  ensureTraderWalletIndexes,
  findTraderWalletsByAddresses,
  importTraderWalletsFromRegistry,
  upsertTraderWalletsForWindow,
  deleteInactiveTraderWallets,
} from "./db/trader-wallet-repository.js";
let migratePromise: Promise<void> | null = null;

async function migrateFromDiskIfNeeded(): Promise<void> {
  if (!migratePromise) {
    migratePromise = (async () => {
      try {
        const loaded = await readJsonFile<WalletRegistry>(walletsFilePath());
        if (!loaded || Object.keys(loaded).length === 0) return;
        const imported = await importTraderWalletsFromRegistry(loaded);
        if (imported > 0) {
          // Keep the file for backup; Mongo is now source of truth.
        }
      } catch {
        // No legacy file or unreadable — fine.
      }
    })();
  }
  await migratePromise;
}

/** Address presence only — for heatmap New wallets counts (no list / window_traders). */
export async function ensureWalletRegistryReady(): Promise<void> {
  await ensureTraderWalletIndexes();
  await migrateFromDiskIfNeeded();
}

export interface RegisterWindowTradersResult {
  newWallets: number;
  knownWallets: number;
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Classify wallets against the registry without writing (for live UI during a window). */
export async function classifyWindowTraders(
  addresses: string[],
): Promise<RegisterWindowTradersResult> {
  await migrateFromDiskIfNeeded();
  const unique = [...new Set(addresses.map(normalizeAddress).filter(Boolean))];
  if (unique.length === 0) {
    return { newWallets: 0, knownWallets: 0 };
  }

  const existing = await findTraderWalletsByAddresses(unique);
  let newWallets = 0;
  let knownWallets = 0;

  for (const address of unique) {
    if (existing.has(address)) {
      knownWallets += 1;
    } else {
      newWallets += 1;
    }
  }

  return { newWallets, knownWallets };
}

/**
 * Classify + remember address presence for New wallets counts.
 * Does not store per-window address lists (window_traders retired).
 */
export async function registerWindowTraders(
  marketSeries: string,
  addresses: string[],
  _windowStart?: number,
): Promise<RegisterWindowTradersResult> {
  await migrateFromDiskIfNeeded();
  return upsertTraderWalletsForWindow(marketSeries, addresses);
}

/** Drop wallets whose last sighting is older than `maxAgeDays` (default 30). */
export async function pruneInactiveWallets(maxAgeDays = 30): Promise<number> {
  await migrateFromDiskIfNeeded();
  return deleteInactiveTraderWallets(maxAgeDays);
}
