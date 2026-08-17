import { createPublicClient, getClobHost, getChainId } from "./clob-service.js";
import { clobMarketFeed } from "./clob-market-feed.js";
import { chainlinkPriceFeed } from "./chainlink-price-feed.js";
import {
  appendCappedHistory,
  twapLookbackSecondsForTimeframe,
} from "./asset-price-mode.js";
import {
  getPolymarketWindowAssetPricesForPair,
  applyRtdsLivePrice,
} from "./asset-price-service.js";
import {
  fetchCurrentUpDownMarket,
  fetchCurrentUpDownMarketWithRetry,
  fetchUpDownMarketAtWindow,
  parseMarketSeries,
} from "./market-pair.js";
import { takeLevels } from "./book-depth.js";
import { pickDisplayPrice } from "./quote-price.js";
import { recordAskSamples } from "./phase-config.js";
import { getPtbSide, type PtbSide } from "./window-dynamics.js";
import { simulatorService } from "./simulator-service.js";
import { liveTradingRegistry } from "./live-trading-service.js";
import { createCoalescer } from "./coalesce-async.js";
import { resolveTakerFeeParams } from "./taker-fee.js";
import { logService } from "./log-service.js";
import { fetchOfficialWindowResolution } from "./official-window-resolution.js";
import {
  assetGapOrUnset,
  roundPolymarketAssetPriceMaybe,
} from "./polymarket-display-price.js";
import type { LiveWindowState } from "./types.js";

type UpdateListener = (state: LiveWindowState) => void;

const NEXT_WINDOW_PREFETCH_SEC = 30;

/** Display-only observer for the UI-selected market (no persistence). */
export class DisplayService {
  private series = "btc-5m";
  private interval: ReturnType<typeof setInterval> | null = null;
  private clobUnsub: (() => void) | null = null;
  private chainlinkUnsub: (() => void) | null = null;
  private twapUnsub: (() => void) | null = null;
  private listeners = new Set<UpdateListener>();
  private state: LiveWindowState = this.emptyState("btc-5m");
  private yesTokenId: string | null = null;
  private noTokenId: string | null = null;
  private sampleInFlight = false;
  /** One executor tick at a time; extra CLOB/Chainlink updates coalesce. */
  private readonly scheduleTradingTick = createCoalescer();
  private prefetchedNextWindowStart: number | null = null;
  private prefetchedYesTokenId: string | null = null;
  private prefetchedNoTokenId: string | null = null;
  private nextWindowPrefetchInFlight = false;
  private lastPtbSide: PtbSide | null = null;
  /** True once Gamma PTB/close were applied for this window (stop following live ticks). */
  private officialSettled = false;

  private emptyState(series: string): LiveWindowState {
    const now = Math.floor(Date.now() / 1000);
    return {
      series,
      windowStart: now,
      windowEnd: now + 300,
      priceHistory: [],
      priceHistoryTwap: [],
      ptbCrossings: 0,
      bookTickSequence: 0,
    };
  }

  start(): void {
    if (this.interval) return;

    void this.collectSample();
    this.interval = setInterval(() => void this.collectSample(), 500);

    this.clobUnsub = clobMarketFeed.onUpdate((tokenIds) => {
      if (!this.yesTokenId || !this.noTokenId) return;
      if (!tokenIds.includes(this.yesTokenId) && !tokenIds.includes(this.noTokenId)) return;
      this.updateQuotesFromCache();
    });

    this.chainlinkUnsub = chainlinkPriceFeed.onUpdate((asset) => {
      const { asset: seriesAsset } = parseMarketSeries(this.series);
      if (asset !== seriesAsset) return;
      this.updateAssetFromChainlink();
    });

    this.twapUnsub = chainlinkPriceFeed.onTwapUpdate((asset) => {
      const { asset: seriesAsset } = parseMarketSeries(this.series);
      if (asset !== seriesAsset) return;
      this.updateTwapFromFeed();
    });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.clobUnsub) {
      this.clobUnsub();
      this.clobUnsub = null;
    }
    if (this.chainlinkUnsub) {
      this.chainlinkUnsub();
      this.chainlinkUnsub = null;
    }
    if (this.twapUnsub) {
      this.twapUnsub();
      this.twapUnsub = null;
    }
  }

  setSeries(series: string): void {
    if (this.series === series) return;
    this.series = series;
    this.state = this.emptyState(series);
    this.yesTokenId = null;
    this.noTokenId = null;
    this.prefetchedNextWindowStart = null;
    this.prefetchedYesTokenId = null;
    this.prefetchedNoTokenId = null;
    this.officialSettled = false;
    void this.collectSample();
  }

  private syncClobSubscriptions(): void {
    const ids = [
      this.yesTokenId,
      this.noTokenId,
      this.prefetchedYesTokenId,
      this.prefetchedNoTokenId,
    ].filter((id): id is string => Boolean(id));
    clobMarketFeed.setOwnerSubscriptions("display", ids);
  }

  getState(): LiveWindowState {
    return {
      ...this.state,
      priceHistory: [...this.state.priceHistory],
      priceHistoryTwap: [...(this.state.priceHistoryTwap ?? [])],
    };
  }

  /** Hot-path view — no priceHistory clone (SSE quotes / roll detection). */
  peekState(): LiveWindowState {
    return this.state;
  }

  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  /** Score live books once; if more quotes arrived, run again with the latest. */
  private async runTradingTick(): Promise<void> {
    try {
      const tickMs = Date.now();
      this.state.lastTickMs = tickMs;
      await liveTradingRegistry.tickAll(this.state, tickMs);
      const { tickTriggerDemoEngine } = await import("./trigger-demo-engine.js");
      await tickTriggerDemoEngine(this.state, tickMs).catch(() => {});
      const { tickTriggerGtdEngine } = await import("./trigger-gtd-engine.js");
      await tickTriggerGtdEngine(this.state, tickMs).catch(() => {});
    } catch (err) {
      logService.warn("display", `Trading tick failed: ${String(err)}`);
    }
  }

  private updateQuotesFromCache(): void {
    if (!this.yesTokenId || !this.noTokenId) return;
    const yesInfo = clobMarketFeed.getCachedMarketInfo(this.yesTokenId);
    const noInfo = clobMarketFeed.getCachedMarketInfo(this.noTokenId);
    if (yesInfo) {
      this.state.yesBid = yesInfo.bestBid;
      this.state.yesAsk = yesInfo.bestAsk;
      this.state.yesBidSize = yesInfo.bestBidSize;
      this.state.yesAskSize = yesInfo.bestAskSize;
      this.state.yesBids = takeLevels(yesInfo.bids);
      this.state.yesAsks = takeLevels(yesInfo.asks);
      this.state.yesDisplay = pickDisplayPrice(yesInfo).price;
    }
    if (noInfo) {
      this.state.noBid = noInfo.bestBid;
      this.state.noAsk = noInfo.bestAsk;
      this.state.noBidSize = noInfo.bestBidSize;
      this.state.noAskSize = noInfo.bestAskSize;
      this.state.noBids = takeLevels(noInfo.bids);
      this.state.noAsks = takeLevels(noInfo.asks);
      this.state.noDisplay = pickDisplayPrice(noInfo).price;
    }
    const tickMs = Date.now();
    this.state.lastTickMs = tickMs;
    const feedLatency = clobMarketFeed.getFeedLatencyMs();
    if (feedLatency != null) {
      this.state.feedLatencyMs = feedLatency;
    }
    recordAskSamples(this.state);
    this.notify();
    this.scheduleTradingTick(() => this.runTradingTick());
  }

  private updateAssetFromChainlink(): void {
    if (this.officialSettled) return;
    const { asset } = parseMarketSeries(this.series);
    const live = chainlinkPriceFeed.getLivePrice(asset);
    if (!live) return;

    const current = roundPolymarketAssetPriceMaybe(live.value);
    if (current == null) return;
    this.state.assetPrice = current;
    this.refreshTwapPrice(live.timestampMs);
    const nowSec = Date.now() / 1000;
    if (
      this.state.prevCloseAsset == null &&
      nowSec >= this.state.windowStart &&
      nowSec < this.state.windowEnd
    ) {
      this.state.prevCloseAsset = current;
      this.state.priceToBeatSource = "chainlink-rtds";
    }
    this.state.assetGap = assetGapOrUnset(current, this.state.prevCloseAsset);
    if (this.state.prevCloseAsset != null) {
      const ptbSide = getPtbSide(current, this.state.prevCloseAsset);
      if (ptbSide != null) {
        if (this.lastPtbSide != null && this.lastPtbSide !== ptbSide) {
          this.state.ptbCrossings = (this.state.ptbCrossings ?? 0) + 1;
        }
        this.lastPtbSide = ptbSide;
      }
    } else {
      this.lastPtbSide = null;
    }
    // Phase / GTD scheduling must follow wall clock, not oracle stamp (which can lag
    // or arrive out of order and briefly look like an earlier phase).
    const tickMs = Date.now();
    this.state.lastTickMs = tickMs;

    const tickSec = tickMs / 1000;
    if (tickSec >= this.state.windowStart && tickSec < this.state.windowEnd) {
      appendCappedHistory(this.state.priceHistory, tickSec, current);
      if (this.state.assetPriceTwap != null) {
        if (!this.state.priceHistoryTwap) this.state.priceHistoryTwap = [];
        appendCappedHistory(this.state.priceHistoryTwap, tickSec, this.state.assetPriceTwap);
      }
    }

    this.notify();
    this.scheduleTradingTick(() => this.runTradingTick());
  }

  private refreshTwapPrice(atMs = Date.now()): void {
    try {
      const { asset, timeframe } = parseMarketSeries(this.series);
      const lookback = twapLookbackSecondsForTimeframe(timeframe);
      this.state.assetPriceTwap = chainlinkPriceFeed.resolveTwapPrice(asset, lookback, atMs);
    } catch {
      this.state.assetPriceTwap = undefined;
    }
  }

  private updateTwapFromFeed(): void {
    if (this.officialSettled) return;
    this.refreshTwapPrice();
    const twap = this.state.assetPriceTwap;
    if (twap == null) return;
    const tickMs = Date.now();
    const tickSec = tickMs / 1000;
    if (tickSec >= this.state.windowStart && tickSec < this.state.windowEnd) {
      if (!this.state.priceHistoryTwap) this.state.priceHistoryTwap = [];
      appendCappedHistory(this.state.priceHistoryTwap, tickSec, twap);
    }
    this.state.lastTickMs = tickMs;
    this.notify();
    this.scheduleTradingTick(() => this.runTradingTick());
  }

  private async prefetchNextWindowTokens(): Promise<void> {
    if (this.nextWindowPrefetchInFlight) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const { windowEnd } = this.state;
    if (!windowEnd || nowSec < windowEnd - NEXT_WINDOW_PREFETCH_SEC) return;

    const nextStart = windowEnd;
    if (this.prefetchedNextWindowStart === nextStart) return;

    this.nextWindowPrefetchInFlight = true;
    try {
      const pair = await fetchUpDownMarketAtWindow(this.series, nextStart);
      this.prefetchedYesTokenId = pair.yesTokenId;
      this.prefetchedNoTokenId = pair.noTokenId;
      this.prefetchedNextWindowStart = nextStart;
      this.syncClobSubscriptions();
    } catch {
      // next market may not be listed yet
    } finally {
      this.nextWindowPrefetchInFlight = false;
    }
  }

  private async collectSample(): Promise<void> {
    if (this.sampleInFlight) return;
    this.sampleInFlight = true;
    try {
      void this.prefetchNextWindowTokens();

      let pair;
      try {
        pair = await fetchCurrentUpDownMarket(this.series);
      } catch {
        pair = await fetchCurrentUpDownMarketWithRetry(this.series, { maxWaitMs: 5000 });
      }

      if (!pair.windowStart || !pair.windowEnd) return;

      if (this.state.windowStart !== pair.windowStart) {
        this.state.priceHistory = [];
        this.state.priceHistoryTwap = [];
        this.state.assetPriceTwap = undefined;
        this.state.ptbCrossings = 0;
        this.state.bookTickSequence = 0;
        this.lastPtbSide = null;
        // Never carry prior window PTB/gap.
        this.state.prevCloseAsset = undefined;
        this.state.assetGap = undefined;
        this.state.priceToBeatSource = undefined;
        this.state.officialSettled = false;
        this.officialSettled = false;
        const { asset } = parseMarketSeries(this.series);
        const liveOpen = chainlinkPriceFeed.getLivePrice(asset);
        const openPtb = roundPolymarketAssetPriceMaybe(liveOpen?.value);
        if (openPtb != null) {
          this.state.prevCloseAsset = openPtb;
          this.state.priceToBeatSource = "chainlink-rtds";
        }
        logService.setActiveWindow(pair.windowStart);
        this.prefetchedNextWindowStart = null;
        this.prefetchedYesTokenId = null;
        this.prefetchedNoTokenId = null;
      }

      this.state.series = this.series;
      this.state.windowStart = pair.windowStart;
      this.state.windowEnd = pair.windowEnd;
      this.state.slug = pair.slug;
      this.state.question = pair.question;

      this.yesTokenId = pair.yesTokenId;
      this.noTokenId = pair.noTokenId;
      this.syncClobSubscriptions();

      void createPublicClient(getClobHost(), getChainId())
        .then((client) => resolveTakerFeeParams(client, pair.yesTokenId))
        .then((feeParams) => simulatorService.setFeeParams(feeParams))
        .catch(() => {});

      const nowSec = Math.floor(Date.now() / 1000);
      if (
        !this.officialSettled &&
        nowSec >= pair.windowEnd &&
        pair.slug
      ) {
        try {
          const official = await fetchOfficialWindowResolution(pair.slug);
          if (official) {
            // Live Market keeps REST PTB/Current. Gamma is recording/replay only.
            this.officialSettled = true;
            this.state.officialSettled = true;
            this.updateQuotesFromCache();
            return;
          }
        } catch {
          // Gamma not ready — keep following published open + Chainlink until it is.
        }
      }

      if (this.officialSettled) {
        this.updateQuotesFromCache();
        return;
      }

      const { asset, timeframe } = parseMarketSeries(this.series);
      try {
        const prices = await getPolymarketWindowAssetPricesForPair(asset, timeframe, pair);
        const live = applyRtdsLivePrice(asset, prices);
        // Follow published crypto-price openPrice until Polymarket freezes it.
        if (live.prevCloseAsset != null && Number.isFinite(live.prevCloseAsset)) {
          this.state.prevCloseAsset = live.prevCloseAsset;
          this.state.priceToBeatSource = live.priceToBeatSource;
        }
        if (live.assetPrice != null) {
          this.state.assetPrice = live.assetPrice;
        }
        this.refreshTwapPrice();
        this.state.assetGap = assetGapOrUnset(
          this.state.assetPrice,
          this.state.prevCloseAsset,
        );
      } catch {
        const live = chainlinkPriceFeed.getLivePrice(asset);
        if (live) {
          this.state.assetPrice = roundPolymarketAssetPriceMaybe(live.value);
        }
        this.refreshTwapPrice();
        this.state.assetGap = assetGapOrUnset(
          this.state.assetPrice,
          this.state.prevCloseAsset,
        );
      }

      this.updateQuotesFromCache();
    } catch (err) {
      logService.error("display", `Sample error (${this.series}): ${String(err)}`);
    } finally {
      this.sampleInFlight = false;
    }
  }
}

export const displayService = new DisplayService();
