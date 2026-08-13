/**
 * Backfill windowOutcome (+ settlement prices) from official Gamma payout (~1/~0),
 * and stamp that Gamma close as the Chainlink JSONL tip at windowEnd.
 * Mid-window Chainlink samples are never rewritten.
 *
 * Usage:
 *   npm run backfill:outcomes
 *   npm run backfill:outcomes -- btc-5m
 */
import "dotenv/config";
import { getMarket, listMarkets } from "../db/market-repository.js";
import {
  listRecordedWindows,
  saveRecordedWindow,
} from "../db/recorded-window-repository.js";
import { upsertRecordedWindowSummary } from "../db/recorded-window-mongo-repository.js";
import { stampOfficialChainlinkCloseTip } from "../db/tick-repository.js";
import { closeMongoClient } from "../db/mongo-client.js";
import { initStorage } from "../db/data-dir.js";
import { fetchOfficialWindowResolution } from "../official-window-resolution.js";
import { buildUpDownSlug, parseMarketSeries } from "../market-pair.js";
import { roundTo4 } from "../tick-compact.js";
import type { MarketDocument } from "../types.js";

const DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backfillMarket(market: MarketDocument): Promise<void> {
  const { asset, timeframe } = parseMarketSeries(market._id);
  const windows = await listRecordedWindows(market);
  console.log(`[backfill] ${market._id}: ${windows.length} recorded windows`);

  let updated = 0;
  let unchanged = 0;
  let unresolved = 0;
  let failed = 0;
  let tipUpdated = 0;
  let tipUnchanged = 0;
  let tipSkipped = 0;

  for (let i = 0; i < windows.length; i += 1) {
    const window = windows[i];
    const label = `${i + 1}/${windows.length} ${window.windowStart}`;
    const slug =
      window.slug?.trim() ||
      buildUpDownSlug(asset, timeframe, window.windowStart);

    try {
      const resolution = await fetchOfficialWindowResolution(slug);
      if (!resolution) {
        unresolved += 1;
        console.warn(`[backfill] ${label}: unresolved (${slug})`);
        await sleep(DELAY_MS);
        continue;
      }

      const { outcome, finalPrice, priceToBeat, source, yesPrice, noPrice } = resolution;
      const nextAsset = finalPrice ?? window.assetPrice;
      const nextPtb = priceToBeat ?? window.prevCloseAsset;
      const nextGap =
        nextAsset != null && nextPtb != null ? roundTo4(nextAsset - nextPtb) : window.assetGap;

      let tipResult: "updated" | "unchanged" | "skipped-no-ticks" = "skipped-no-ticks";
      if (
        finalPrice != null &&
        Number.isFinite(finalPrice) &&
        priceToBeat != null &&
        Number.isFinite(priceToBeat) &&
        Number.isFinite(window.windowEnd)
      ) {
        tipResult = await stampOfficialChainlinkCloseTip(
          market,
          window.windowStart,
          window.windowEnd,
          { closePrice: finalPrice, priceToBeat },
        );
        if (tipResult === "updated") tipUpdated += 1;
        else if (tipResult === "unchanged") tipUnchanged += 1;
        else tipSkipped += 1;
      } else {
        tipSkipped += 1;
      }

      const outcomeSame = window.windowOutcome === outcome;
      const pricesSame =
        window.assetPrice === nextAsset && window.prevCloseAsset === nextPtb;
      const payoutSame =
        (yesPrice == null || window.yesPrice === yesPrice) &&
        (noPrice == null || window.noPrice === noPrice);

      if (outcomeSame && pricesSame && payoutSame && tipResult !== "updated") {
        unchanged += 1;
        if ((i + 1) % 50 === 0) {
          console.log(`[backfill] ${label}: ${outcome} (unchanged)`);
        }
        await sleep(DELAY_MS);
        continue;
      }

      const nextDoc = {
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        savedAt: window.savedAt,
        slug: window.slug,
        question: window.question,
        conditionId: window.conditionId,
        assetPrice: nextAsset,
        prevCloseAsset: nextPtb,
        assetGap: nextGap,
        windowOutcome: outcome,
        yesPrice: yesPrice ?? window.yesPrice,
        noPrice: noPrice ?? window.noPrice,
        ptbCrossings: window.ptbCrossings,
        minAssetPrice: window.minAssetPrice,
        maxAssetPrice: window.maxAssetPrice,
        assetRange: window.assetRange,
        rangeTop: window.rangeTop,
        rangeBottom: window.rangeBottom,
        uniqueTraders: window.uniqueTraders,
        newWallets: window.newWallets,
        knownWallets: window.knownWallets,
        tickCount: window.tickCount,
        clobRawCount: window.clobRawCount,
        clobBookCount: window.clobBookCount,
        chainlinkCount: window.chainlinkCount,
      };
      await saveRecordedWindow(market, nextDoc);
      // Keep Mongo Replay index in sync with disk (same fields as recorder finalize).
      await upsertRecordedWindowSummary(market._id, {
        windowStart: nextDoc.windowStart,
        windowEnd: nextDoc.windowEnd,
        savedAt: nextDoc.savedAt,
        ptbCrossings: nextDoc.ptbCrossings,
        rangeTop: nextDoc.rangeTop,
        rangeBottom: nextDoc.rangeBottom,
        uniqueTraders: nextDoc.uniqueTraders,
        newWallets: nextDoc.newWallets,
        windowOutcome: nextDoc.windowOutcome,
        minAssetPrice: nextDoc.minAssetPrice,
        maxAssetPrice: nextDoc.maxAssetPrice,
        assetRange: nextDoc.assetRange,
        prevCloseAsset: nextDoc.prevCloseAsset,
        assetPrice: nextDoc.assetPrice,
      });

      updated += 1;
      console.log(
        `[backfill] ${label}: ${window.windowOutcome ?? "?"} → ${outcome}` +
          (finalPrice != null && priceToBeat != null
            ? ` (ptb=${priceToBeat} close=${finalPrice})`
            : "") +
          ` tip=${tipResult}` +
          ` [${source}] ${slug}`,
      );
    } catch (err) {
      failed += 1;
      console.error(`[backfill] ${label}: ${String(err)}`);
    }

    await sleep(DELAY_MS);
  }

  console.log(
    `[backfill] ${market._id} done: updated=${updated} unchanged=${unchanged}` +
      ` unresolved=${unresolved} failed=${failed}` +
      ` tipUpdated=${tipUpdated} tipUnchanged=${tipUnchanged} tipSkipped=${tipSkipped}`,
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
    await backfillMarket(market);
  }
  await closeMongoClient();
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  await closeMongoClient().catch(() => undefined);
});
