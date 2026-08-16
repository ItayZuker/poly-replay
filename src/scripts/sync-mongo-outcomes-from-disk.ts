/**
 * Copy windowOutcome (+ PTB / close) from local windows/ JSON into Mongo
 * recorded_windows. Disk is the authority when it has an official outcome.
 *
 * Usage:
 *   npm run sync:mongo-outcomes
 *   npm run sync:mongo-outcomes -- btc-5m
 */
import "dotenv/config";
import { getMarket, listMarkets } from "../db/market-repository.js";
import { initStorage } from "../db/data-dir.js";
import { listRecordedWindows } from "../db/recorded-window-repository.js";
import { upsertRecordedWindowSummary } from "../db/recorded-window-mongo-repository.js";
import { recordingPtbFields } from "../ptb-history.js";
import { closeMongoClient } from "../db/mongo-client.js";
import type { MarketDocument } from "../types.js";

async function syncMarket(market: MarketDocument): Promise<void> {
  const windows = await listRecordedWindows(market);
  console.log(`[sync-mongo] ${market._id}: ${windows.length} readable disk windows`);

  let updated = 0;
  let skippedNoOutcome = 0;
  let failed = 0;

  for (let i = 0; i < windows.length; i += 1) {
    const window = windows[i];
    const label = `${i + 1}/${windows.length} ${window.windowStart}`;
    if (window.windowOutcome !== "up" && window.windowOutcome !== "down") {
      skippedNoOutcome += 1;
      continue;
    }

    try {
      await upsertRecordedWindowSummary(market._id, {
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        savedAt: window.savedAt,
        ptbCrossings: window.ptbCrossings,
        rangeTop: window.rangeTop,
        rangeBottom: window.rangeBottom,
        uniqueTraders: window.uniqueTraders,
        newWallets: window.newWallets,
        windowOutcome: window.windowOutcome,
        minAssetPrice: window.minAssetPrice,
        maxAssetPrice: window.maxAssetPrice,
        assetRange: window.assetRange,
        prevCloseAsset: window.prevCloseAsset,
        assetPrice: window.assetPrice,
        ...recordingPtbFields(window),
      });
      updated += 1;
      if (updated <= 5 || updated % 250 === 0 || i + 1 === windows.length) {
        console.log(
          `[sync-mongo] ${label}: ${window.windowOutcome}` +
            (window.prevCloseAsset != null && window.assetPrice != null
              ? ` (ptb=${window.prevCloseAsset} close=${window.assetPrice})`
              : ""),
        );
      }
    } catch (err) {
      failed += 1;
      console.error(`[sync-mongo] ${label}: ${String(err)}`);
    }
  }

  console.log(
    `[sync-mongo] ${market._id} done: updated=${updated}` +
      ` skippedNoOutcome=${skippedNoOutcome} failed=${failed}`,
  );
}

async function main(): Promise<void> {
  await initStorage();
  const seriesArg = process.argv[2]?.trim();
  const markets = seriesArg
    ? [await getMarket(seriesArg)].filter((m): m is MarketDocument => m != null)
    : await listMarkets();

  if (markets.length === 0) {
    console.error(seriesArg ? `Market not found: ${seriesArg}` : "No markets found");
    process.exitCode = 1;
    return;
  }

  for (const market of markets) {
    await syncMarket(market);
  }
  await closeMongoClient();
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  await closeMongoClient().catch(() => undefined);
});
