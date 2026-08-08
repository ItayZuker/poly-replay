import { clobMarketFeed, hasSocketBook } from "./clob-market-feed.js";
import { chainlinkPriceFeed } from "./chainlink-price-feed.js";
import { getPolymarketWindowAssetPricesForPair } from "./asset-price-service.js";
import {
  fetchOfficialWindowResolution,
  hasOfficialWindowOutcome,
  waitForOfficialWindowResolution,
  type OfficialWindowResolution,
} from "./official-window-resolution.js";
import {
  fetchCurrentUpDownMarket,
  fetchCurrentUpDownMarketWithRetry,
  fetchMarketPairFromSlug,
  fetchUpDownMarketAtWindow,
  parseMarketSeries,
} from "./market-pair.js";
import { pickDisplayPrice, pickTriggerPrice } from "./quote-price.js";
import { takeLevels } from "./book-depth.js";
import { makeStoredTickId, roundTo4 } from "./tick-compact.js";
import { enrichWindowWithUniqueTraders, listUniqueTradersForWindow, resolveConditionIdForSlug } from "./market-participants.js";
import { classifyWindowTraders } from "./wallet-registry.js";
import {
  createWindowDynamicsTracker,
  finalizeWindowDynamics,
  isFlatPriceWindow,
  updateWindowDynamics,
  type WindowDynamicsTracker,
} from "./window-dynamics.js";
import { discardBadRecording } from "./bad-recording-cleanup.js";
import { logService } from "./log-service.js";
import type {
  ChainlinkTickDocument,
  ClobBookTickDocument,
  ClobRawTickDocument,
  MarketDocument,
  WindowHitRecord,
} from "./types.js";
import {
  ensureWindowTickDir,
  insertChainlinkTicks,
  insertClobBookTicks,
  insertClobRawTicks,
  stampOfficialChainlinkCloseTip,
} from "./db/tick-repository.js";
import {
  getRecordedWindow,
  saveRecordedWindow,
} from "./db/recorded-window-repository.js";
import { upsertRecordedWindowSummary } from "./db/recorded-window-mongo-repository.js";
import { ingestRecordedWindow } from "./heatmap-service.js";
import { pruneColdMarketData } from "./db/tick-archive.js";
import {
  marketWindowsDir,
  windowTicksDir,
} from "./db/data-dir.js";
import fs from "fs/promises";
import path from "path";

const TICK_FLUSH_MS = 1_500;
const POLL_MS = 500;
const TRADERS_POLL_MS = 15_000;
/** Subscribe the next window's CLOB tokens this many seconds before current end. */
const NEXT_WINDOW_PREFETCH_SEC = 30;
/** No book/chainlink ticks into the active window for this long → health recovery. */
const RECORDING_SILENCE_MS = 60_000;
/** No CLOB book ticks for this long (Chainlink may still be flowing) → CLOB reconnect. */
const CLOB_SILENCE_MS = 20_000;
/** Ignore silence right after a window opens (pair/book may still be warming up). */
const WINDOW_START_GRACE_MS = 20_000;
/**
 * After windowEnd, keep polling Gamma in the background this long before leaving
 * windowOutcome permanently unset (does not block the next recording window).
 */
const OFFICIAL_RESOLVE_MAX_WAIT_MS = 20 * 60 * 1000;
const OFFICIAL_RESOLVE_POLL_MS = 2_000;

type StateChangeListener = (series: string) => void;

export interface TraderStatsSnapshot {
  uniqueTraders?: number;
  newWallets?: number;
  knownWallets?: number;
}

/** Records CLOB book ticks and Chainlink asset ticks in separate collections. */
export class MarketRecorder {
  private readonly market: MarketDocument;
  private readonly onStateChange: StateChangeListener | null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private tradersPollTimer: ReturnType<typeof setInterval> | null = null;
  private tradersPollInFlight = false;
  private clobRawUnsub: (() => void) | null = null;
  private chainlinkUnsub: (() => void) | null = null;
  private sampleInFlight = false;
  private windowFetchPending = false;
  private fastRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private finalizedWindowStarts = new Set<number>();
  /** Windows abandoned after Chainlink stall — do not re-open or save. */
  private discardedWindowStarts = new Set<number>();
  private activeWindow: WindowHitRecord | null = null;
  private activeYesTokenId: string | null = null;
  private activeNoTokenId: string | null = null;
  private dynamicsTracker: WindowDynamicsTracker = createWindowDynamicsTracker();
  private clobRawBuffer: ClobRawTickDocument[] = [];
  private clobBookBuffer: ClobBookTickDocument[] = [];
  private chainlinkTickBuffer: ChainlinkTickDocument[] = [];
  private clobRawSeq = 0;
  private clobBookSeq = 0;
  private chainlinkSeq = 0;
  private windowTickCount = 0;
  private clobRawCount = 0;
  private clobBookCount = 0;
  private chainlinkCount = 0;
  private lastTraderStats: TraderStatsSnapshot | null = null;
  private assetPrices: { assetPrice?: number; prevCloseAsset?: number } = {};
  private prefetchedNextWindowStart: number | null = null;
  private nextWindowPrefetchInFlight = false;
  /** Wall-clock time of the last book/chainlink tick appended for the active window. */
  private lastUsefulTickAtMs = 0;
  /** Wall-clock time of the last CLOB book tick appended for the active window. */
  private lastClobTickAtMs = 0;
  private windowBeganAtMs = 0;
  /** True while captureEndPrices/finalizeWindow run — silence is expected (no in-window ticks). */
  private finalizing = false;
  /** In-flight background Gamma polls keyed by windowStart (non-blocking). */
  private pendingOfficialResolves = new Map<number, Promise<void>>();

  constructor(market: MarketDocument, onStateChange: StateChangeListener | null = null) {
    this.market = market;
    this.onStateChange = onStateChange;
  }

  getSeries(): string {
    return this.market._id;
  }

  getMarket(): MarketDocument {
    return this.market;
  }

  /**
   * True when an active window has gone too long without book/chainlink ticks.
   * Used by RecordingManager for broader feed recovery (beyond Chainlink-only stall).
   * Not used after windowEnd / while finalizing — in-window ticks stop by design then.
   */
  needsHealthRecovery(nowMs = Date.now()): boolean {
    if (!this.isActiveWindowEligibleForHealth(nowMs)) return false;
    const last = this.lastUsefulTickAtMs || this.windowBeganAtMs;
    if (!last) return false;
    return nowMs - last >= RECORDING_SILENCE_MS;
  }

  /**
   * True when CLOB book ticks have gone silent while the window is still open.
   * Chainlink-only flow must not mask a dead market WebSocket.
   */
  needsClobRecovery(nowMs = Date.now()): boolean {
    if (!this.isActiveWindowEligibleForHealth(nowMs)) return false;
    const last = this.lastClobTickAtMs || this.windowBeganAtMs;
    if (!last) return false;
    return nowMs - last >= CLOB_SILENCE_MS;
  }

  /** Re-subscribe the active window's YES/NO tokens after a CLOB reconnect. */
  resubscribeActiveClobTokens(): void {
    if (!this.activeYesTokenId || !this.activeNoTokenId) return;
    clobMarketFeed.ensureSubscribed([this.activeYesTokenId, this.activeNoTokenId]);
  }

  private isActiveWindowEligibleForHealth(nowMs: number): boolean {
    if (!this.interval || !this.activeWindow || this.finalizing) return false;
    if (nowMs >= this.activeWindow.windowEnd * 1000) return false;
    if (this.windowBeganAtMs > 0 && nowMs - this.windowBeganAtMs < WINDOW_START_GRACE_MS) {
      return false;
    }
    return true;
  }

  /** Health silence uses wall clock receipt time, not oracle/event stamps. */
  private noteUsefulTick(_eventTMs?: number): void {
    this.lastUsefulTickAtMs = Date.now();
  }

  private noteClobTick(_eventTMs?: number): void {
    const now = Date.now();
    this.lastClobTickAtMs = now;
    this.lastUsefulTickAtMs = now;
  }

  getActiveWindow(): WindowHitRecord | null {
    return this.activeWindow ? { ...this.activeWindow } : null;
  }

  getTraderStats(): TraderStatsSnapshot | null {
    if (this.activeWindow) {
      return {
        uniqueTraders: this.activeWindow.uniqueTraders,
        newWallets: this.activeWindow.newWallets,
        knownWallets: this.activeWindow.knownWallets,
      };
    }
    return this.lastTraderStats;
  }

  isRunning(): boolean {
    return this.interval != null;
  }

  start(): void {
    if (this.interval) return;

    const { asset } = parseMarketSeries(this.market._id);

    void this.collectSample().catch((err) => {
      logService.error("recorder", `${this.market._id}: ${String(err)}`);
    });

    this.interval = setInterval(() => {
      void this.collectSample().catch((err) => {
        logService.error("recorder", `${this.market._id}: ${String(err)}`);
      });
    }, POLL_MS);

    this.flushTimer = setInterval(() => {
      void this.flushTicks();
    }, TICK_FLUSH_MS);

    this.clobRawUnsub = clobMarketFeed.onRawMessage((event) => {
      this.recordClobRawMessage(event);
    });

    this.chainlinkUnsub = chainlinkPriceFeed.onUpdate((updatedAsset) => {
      if (updatedAsset !== asset) return;
      this.recordChainlinkTick();
    });

    logService.success("recorder", `Recording started for ${this.market._id}`);
  }

  stop(): void {
    if (this.fastRetryTimer) {
      clearTimeout(this.fastRetryTimer);
      this.fastRetryTimer = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.stopTradersPoll();
    if (this.clobRawUnsub) {
      this.clobRawUnsub();
      this.clobRawUnsub = null;
    }
    if (this.chainlinkUnsub) {
      this.chainlinkUnsub();
      this.chainlinkUnsub = null;
    }
    void this.flushTicks();
    this.resetActiveWindow();
    this.finalizedWindowStarts.clear();
    this.discardedWindowStarts.clear();
    logService.info("recorder", `Recording stopped for ${this.market._id}`);
  }

  /**
   * Abandon the in-progress window without saving — used when Chainlink stalls
   * or the health watchdog detects recording silence.
   */
  discardActiveWindow(reason: string): void {
    if (!this.activeWindow || this.finalizing) return;

    const windowStart = this.activeWindow.windowStart;
    const windowEnd = this.activeWindow.windowEnd;
    this.discardedWindowStarts.add(windowStart);

    this.clobRawBuffer = [];
    this.clobBookBuffer = [];
    this.chainlinkTickBuffer = [];
    this.resetActiveWindow();
    void this.purgeWindowArtifacts(windowStart);

    logService.warn(
      "recorder",
      `Discarded window ${new Date(windowStart * 1000).toLocaleTimeString()}–${new Date(windowEnd * 1000).toLocaleTimeString()} for ${this.market._id} (${reason})`,
    );
    this.onStateChange?.(this.market._id);
  }

  private async purgeWindowArtifacts(windowStart: number): Promise<void> {
    const series = this.market._id;
    const targets = [
      windowTicksDir(series, windowStart),
      path.join(marketWindowsDir(series), `${windowStart}.json`),
    ];
    await Promise.all(
      targets.map(async (target) => {
        try {
          await fs.rm(target, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }),
    );
  }

  private resetActiveWindow(): void {
    this.stopTradersPoll();
    this.activeWindow = null;
    this.activeYesTokenId = null;
    this.activeNoTokenId = null;
    this.dynamicsTracker = createWindowDynamicsTracker();
    this.clobRawBuffer = [];
    this.clobBookBuffer = [];
    this.chainlinkTickBuffer = [];
    this.clobRawSeq = 0;
    this.clobBookSeq = 0;
    this.chainlinkSeq = 0;
    this.windowTickCount = 0;
    this.clobRawCount = 0;
    this.clobBookCount = 0;
    this.chainlinkCount = 0;
    this.lastTraderStats = null;
    this.assetPrices = {};
    this.prefetchedNextWindowStart = null;
    this.nextWindowPrefetchInFlight = false;
    this.lastUsefulTickAtMs = 0;
    this.lastClobTickAtMs = 0;
    this.windowBeganAtMs = 0;
    this.finalizing = false;
  }

  private isInWindow(tMs: number): boolean {
    if (!this.activeWindow) return false;
    const startMs = this.activeWindow.windowStart * 1000;
    const endMs = this.activeWindow.windowEnd * 1000;
    return tMs >= startMs && tMs < endMs;
  }

  private nextClobRawId(windowStart: number): string {
    this.clobRawSeq += 1;
    return makeStoredTickId(windowStart, this.clobRawSeq).replace(":", ":raw:");
  }

  private nextClobBookId(windowStart: number): string {
    this.clobBookSeq += 1;
    return makeStoredTickId(windowStart, this.clobBookSeq).replace(":", ":book:");
  }

  private nextChainlinkId(windowStart: number): string {
    this.chainlinkSeq += 1;
    return makeStoredTickId(windowStart, this.chainlinkSeq).replace(":", ":cl:");
  }

  private buildClobBookTick(tMs: number): ClobBookTickDocument | null {
    if (!this.activeWindow || !this.activeYesTokenId || !this.activeNoTokenId) return null;
    if (!this.isInWindow(tMs)) return null;

    const yesInfo = clobMarketFeed.getCachedMarketInfo(this.activeYesTokenId);
    const noInfo = clobMarketFeed.getCachedMarketInfo(this.activeNoTokenId);
    const elapsed = Math.max(0, Math.floor(tMs / 1000 - this.activeWindow.windowStart));

    const tick: ClobBookTickDocument = {
      _id: this.nextClobBookId(this.activeWindow.windowStart),
      windowStart: this.activeWindow.windowStart,
      windowEnd: this.activeWindow.windowEnd,
      tMs,
      yesBids: takeLevels(yesInfo?.bids),
      yesAsks: takeLevels(yesInfo?.asks),
      noBids: takeLevels(noInfo?.bids),
      noAsks: takeLevels(noInfo?.asks),
    };

    if (yesInfo) {
      const yesTrigger = pickTriggerPrice(yesInfo, elapsed);
      if (yesTrigger.price != null) tick.yesPrice = roundTo4(yesTrigger.price);
    }
    if (noInfo) {
      const noTrigger = pickTriggerPrice(noInfo, elapsed);
      if (noTrigger.price != null) tick.noPrice = roundTo4(noTrigger.price);
    }

    return tick;
  }

  private appendClobBookTick(tMs: number): void {
    const tick = this.buildClobBookTick(tMs);
    if (!tick) return;
    this.clobBookBuffer.push(tick);
    this.clobBookCount += 1;
    this.noteClobTick(tMs);
    this.onStateChange?.(this.market._id);
  }

  private recordClobRawMessage(event: {
    tMs: number;
    payload: unknown;
    tokenIds: string[];
  }): void {
    if (!this.activeWindow || !this.activeYesTokenId || !this.activeNoTokenId) return;
    if (!this.isInWindow(event.tMs)) return;

    const relevant = event.tokenIds.some(
      (id) => id === this.activeYesTokenId || id === this.activeNoTokenId,
    );
    if (!relevant) return;

    this.clobRawBuffer.push({
      _id: this.nextClobRawId(this.activeWindow.windowStart),
      windowStart: this.activeWindow.windowStart,
      windowEnd: this.activeWindow.windowEnd,
      tMs: event.tMs,
      payload: event.payload,
    });
    this.clobRawCount += 1;
    this.appendClobBookTick(event.tMs);
  }

  private buildChainlinkTick(tMs: number): ChainlinkTickDocument | null {
    if (!this.activeWindow) return null;
    if (!this.isInWindow(tMs)) return null;

    const tick: ChainlinkTickDocument = {
      _id: this.nextChainlinkId(this.activeWindow.windowStart),
      windowStart: this.activeWindow.windowStart,
      windowEnd: this.activeWindow.windowEnd,
      tMs,
      ptbCrossings: this.activeWindow.ptbCrossings,
      minAssetPrice:
        this.activeWindow.minAssetPrice != null
          ? roundTo4(this.activeWindow.minAssetPrice)
          : undefined,
      maxAssetPrice:
        this.activeWindow.maxAssetPrice != null
          ? roundTo4(this.activeWindow.maxAssetPrice)
          : undefined,
    };

    if (this.assetPrices.assetPrice != null) {
      tick.assetPrice = roundTo4(this.assetPrices.assetPrice);
    }
    if (this.assetPrices.prevCloseAsset != null) {
      tick.prevCloseAsset = roundTo4(this.assetPrices.prevCloseAsset);
    }

    return tick;
  }

  private pushChainlinkTick(tMs: number): void {
    const tick = this.buildChainlinkTick(tMs);
    if (!tick) return;
    this.chainlinkTickBuffer.push(tick);
    this.chainlinkCount += 1;
    this.noteUsefulTick(tMs);
    this.onStateChange?.(this.market._id);
  }

  private recordChainlinkTick(): void {
    const { asset } = parseMarketSeries(this.market._id);
    const live = chainlinkPriceFeed.getLivePrice(asset);
    if (!live || !this.activeWindow) return;

    this.applyAssetPrices(live.value, this.assetPrices.prevCloseAsset);
    const tMs = live.timestampMs || Date.now();
    this.pushChainlinkTick(tMs);
  }

  private applyAssetPrices(assetPrice?: number, prevCloseAsset?: number): void {
    if (!this.activeWindow) return;

    if (assetPrice != null && Number.isFinite(assetPrice)) {
      this.activeWindow.assetPrice = assetPrice;
      this.assetPrices.assetPrice = assetPrice;
    }
    if (prevCloseAsset != null && Number.isFinite(prevCloseAsset)) {
      this.activeWindow.prevCloseAsset = prevCloseAsset;
      this.assetPrices.prevCloseAsset = prevCloseAsset;
    }
    if (
      this.activeWindow.assetPrice != null &&
      this.activeWindow.prevCloseAsset != null
    ) {
      this.activeWindow.assetGap =
        this.activeWindow.assetPrice - this.activeWindow.prevCloseAsset;
    }

    updateWindowDynamics(
      this.activeWindow,
      this.dynamicsTracker,
      this.activeWindow.assetPrice,
      this.activeWindow.prevCloseAsset,
    );
  }

  private async flushTicks(): Promise<void> {
    const rawBatch = this.clobRawBuffer.splice(0, this.clobRawBuffer.length);
    const bookBatch = this.clobBookBuffer.splice(0, this.clobBookBuffer.length);
    const chainlinkBatch = this.chainlinkTickBuffer.splice(0, this.chainlinkTickBuffer.length);
    if (rawBatch.length === 0 && bookBatch.length === 0 && chainlinkBatch.length === 0) return;

    try {
      await Promise.all([
        insertClobRawTicks(this.market, rawBatch),
        insertClobBookTicks(this.market, bookBatch),
        insertChainlinkTicks(this.market, chainlinkBatch),
      ]);
    } catch (err) {
      logService.error("recorder", `Tick flush failed (${this.market._id}): ${String(err)}`);
      this.clobRawBuffer.unshift(...rawBatch);
      this.clobBookBuffer.unshift(...bookBatch);
      this.chainlinkTickBuffer.unshift(...chainlinkBatch);
    }
  }

  private beginWindow(
    windowStart: number,
    windowEnd: number,
    meta: { slug?: string; question?: string; conditionId?: string },
  ): void {
    this.activeWindow = {
      windowStart,
      windowEnd,
      slug: meta.slug,
      question: meta.question,
      conditionId: meta.conditionId,
    };
    this.dynamicsTracker = createWindowDynamicsTracker();
    this.clobRawSeq = 0;
    this.clobBookSeq = 0;
    this.chainlinkSeq = 0;
    this.windowTickCount = 0;
    this.clobRawCount = 0;
    this.clobBookCount = 0;
    this.chainlinkCount = 0;
    this.clobRawBuffer = [];
    this.clobBookBuffer = [];
    this.chainlinkTickBuffer = [];
    this.lastTraderStats = null;
    const now = Date.now();
    this.windowBeganAtMs = now;
    this.lastUsefulTickAtMs = now;
    this.lastClobTickAtMs = now;
    void ensureWindowTickDir(this.market._id, windowStart);
    this.startTradersPoll();
    logService.info(
      "recorder",
      `Window started ${new Date(windowStart * 1000).toLocaleTimeString()} for ${this.market._id}`,
    );
  }

  private stopTradersPoll(): void {
    if (this.tradersPollTimer) {
      clearInterval(this.tradersPollTimer);
      this.tradersPollTimer = null;
    }
  }

  private startTradersPoll(): void {
    this.stopTradersPoll();
    void this.refreshUniqueTraders();
    this.tradersPollTimer = setInterval(() => {
      void this.refreshUniqueTraders();
    }, TRADERS_POLL_MS);
  }

  private async refreshUniqueTraders(): Promise<void> {
    if (!this.activeWindow || this.tradersPollInFlight) return;

    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= this.activeWindow.windowEnd) return;

    const windowStart = this.activeWindow.windowStart;
    this.tradersPollInFlight = true;
    try {
      let conditionId = this.activeWindow.conditionId;
      if (!conditionId && this.activeWindow.slug) {
        conditionId = await resolveConditionIdForSlug(this.activeWindow.slug);
        if (conditionId && this.activeWindow?.windowStart === windowStart) {
          this.activeWindow.conditionId = conditionId;
        }
      }
      if (!conditionId || this.activeWindow?.windowStart !== windowStart) return;

      const wallets = await listUniqueTradersForWindow({
        conditionId,
        windowStart: this.activeWindow.windowStart,
        windowEnd: this.activeWindow.windowEnd,
        slug: this.activeWindow.slug,
        waitForSettle: false,
      });
      const { newWallets, knownWallets } = await classifyWindowTraders(wallets);

      if (this.activeWindow?.windowStart !== windowStart) return;

      const count = wallets.length;
      const changed =
        this.activeWindow.uniqueTraders !== count ||
        this.activeWindow.newWallets !== newWallets ||
        this.activeWindow.knownWallets !== knownWallets;

      if (changed) {
        this.activeWindow.uniqueTraders = count;
        this.activeWindow.newWallets = newWallets;
        this.activeWindow.knownWallets = knownWallets;
        this.onStateChange?.(this.market._id);
      }
    } catch (err) {
      logService.error("recorder", `Trader poll failed (${this.market._id}): ${String(err)}`);
    } finally {
      this.tradersPollInFlight = false;
    }
  }

  private async captureEndPrices(): Promise<void> {
    if (!this.activeWindow?.slug) return;

    // Caller (rollClosedWindow) owns `finalizing` for the whole rollover so this
    // wait cannot leave the recorder permanently stuck if finalize fails.
    // Gamma often lands minutes after windowEnd — do not block the next window;
    // a one-shot check here, then background poll up to 20 minutes after end.
    try {
      const { asset, timeframe } = parseMarketSeries(this.market._id);
      const pair = await fetchMarketPairFromSlug(this.activeWindow.slug);
      const yesInfo = clobMarketFeed.getCachedMarketInfo(pair.yesTokenId);
      const noInfo = clobMarketFeed.getCachedMarketInfo(pair.noTokenId);
      if (yesInfo) this.activeWindow.yesPrice = pickDisplayPrice(yesInfo).price;
      if (noInfo) this.activeWindow.noPrice = pickDisplayPrice(noInfo).price;

      const official = await fetchOfficialWindowResolution(this.activeWindow.slug);
      if (official) {
        this.applyAssetPrices(official.finalPrice, official.priceToBeat);
        this.activeWindow.windowOutcome = official.outcome;
        if (official.yesPrice != null) this.activeWindow.yesPrice = official.yesPrice;
        if (official.noPrice != null) this.activeWindow.noPrice = official.noPrice;
        return;
      }

      // Record Chainlink/REST close/PTB when available, but do not invent windowOutcome
      // from incomplete prices — leave unset for background Gamma / later backfill.
      const prices = await getPolymarketWindowAssetPricesForPair(asset, timeframe, pair);
      this.applyAssetPrices(prices.assetPrice, prices.prevCloseAsset);
      logService.info(
        "recorder",
        `Gamma not ready for ${this.activeWindow.slug}; saving without windowOutcome (background poll ≤20m)`,
      );
    } catch {
      // best effort
    }
  }

  /** Non-blocking: poll Gamma until windowEnd+20m, then patch the saved recording. */
  private scheduleBackgroundOfficialResolve(input: {
    windowStart: number;
    windowEnd: number;
    slug: string;
  }): void {
    const slug = input.slug.trim();
    if (!slug || this.pendingOfficialResolves.has(input.windowStart)) return;
    const work = this.runBackgroundOfficialResolve({ ...input, slug }).finally(() => {
      this.pendingOfficialResolves.delete(input.windowStart);
    });
    this.pendingOfficialResolves.set(input.windowStart, work);
  }

  private async runBackgroundOfficialResolve(input: {
    windowStart: number;
    windowEnd: number;
    slug: string;
  }): Promise<void> {
    const deadlineMs = input.windowEnd * 1000 + OFFICIAL_RESOLVE_MAX_WAIT_MS;
    const remainingMs = Math.max(0, deadlineMs - Date.now());
    if (remainingMs <= 0) {
      logService.warn(
        "recorder",
        `Official resolution timed out for ${input.slug}; windowOutcome left unset`,
      );
      return;
    }

    logService.info(
      "recorder",
      `Background Gamma poll for ${input.slug} (up to ${Math.ceil(remainingMs / 1000)}s)`,
    );

    const official = await waitForOfficialWindowResolution(input.slug, {
      maxWaitMs: remainingMs,
      intervalMs: OFFICIAL_RESOLVE_POLL_MS,
    });

    if (!official) {
      logService.warn(
        "recorder",
        `Official resolution unavailable after 20m for ${input.slug}; windowOutcome left unset`,
      );
      return;
    }

    try {
      await this.applyOfficialResolutionToSavedWindow(input.windowStart, official);
      logService.success(
        "recorder",
        `Background Gamma settled ${input.slug} → ${official.outcome}`,
      );
    } catch (err) {
      logService.error(
        "recorder",
        `Failed to apply background Gamma for ${input.slug}: ${String(err)}`,
      );
    }
  }

  private async applyOfficialResolutionToSavedWindow(
    windowStart: number,
    official: OfficialWindowResolution,
  ): Promise<void> {
    const existing = await getRecordedWindow(this.market, windowStart);
    if (!existing) {
      logService.warn(
        "recorder",
        `Background Gamma: no saved window ${windowStart} for ${this.market._id}`,
      );
      return;
    }
    if (hasOfficialWindowOutcome(existing.windowOutcome)) return;

    const nextAsset = official.finalPrice ?? existing.assetPrice;
    const nextPtb = official.priceToBeat ?? existing.prevCloseAsset;
    const nextGap =
      nextAsset != null && nextPtb != null ? roundTo4(nextAsset - nextPtb) : existing.assetGap;

    if (
      official.finalPrice != null &&
      Number.isFinite(official.finalPrice) &&
      official.priceToBeat != null &&
      Number.isFinite(official.priceToBeat) &&
      Number.isFinite(existing.windowEnd)
    ) {
      await stampOfficialChainlinkCloseTip(
        this.market,
        existing.windowStart,
        existing.windowEnd,
        { closePrice: official.finalPrice, priceToBeat: official.priceToBeat },
      );
    }

    const nextDoc = {
      windowStart: existing.windowStart,
      windowEnd: existing.windowEnd,
      savedAt: existing.savedAt,
      slug: existing.slug,
      question: existing.question,
      conditionId: existing.conditionId,
      assetPrice: nextAsset,
      prevCloseAsset: nextPtb,
      assetGap: nextGap,
      windowOutcome: official.outcome,
      yesPrice: official.yesPrice ?? existing.yesPrice,
      noPrice: official.noPrice ?? existing.noPrice,
      ptbCrossings: existing.ptbCrossings,
      minAssetPrice: existing.minAssetPrice,
      maxAssetPrice: existing.maxAssetPrice,
      assetRange: existing.assetRange,
      rangeTop: existing.rangeTop,
      rangeBottom: existing.rangeBottom,
      uniqueTraders: existing.uniqueTraders,
      newWallets: existing.newWallets,
      knownWallets: existing.knownWallets,
      tickCount: existing.tickCount,
      clobRawCount: existing.clobRawCount,
      clobBookCount: existing.clobBookCount,
      chainlinkCount: existing.chainlinkCount,
    };
    await saveRecordedWindow(this.market, nextDoc);
    await upsertRecordedWindowSummary(this.market._id, {
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
    }).catch((err) => {
      logService.warn(
        "recorder",
        `Mongo recorded_windows upsert failed (${this.market._id}): ${String(err)}`,
      );
    });
    ingestRecordedWindow(this.market._id, {
      _id: String(nextDoc.windowStart),
      updatedAt: nextDoc.savedAt ?? new Date().toISOString(),
      ...nextDoc,
    });
    this.onStateChange?.(this.market._id);
  }

  /**
   * Close the active window after windowEnd: resolve official prices, then save.
   * Always clears `finalizing` / active window so a throw cannot stall recording forever.
   */
  private async rollClosedWindow(): Promise<void> {
    if (!this.activeWindow) return;
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < this.activeWindow.windowEnd) return;

    this.finalizing = true;
    try {
      await this.captureEndPrices();
      await this.finalizeWindow();
    } catch (err) {
      logService.error(
        "recorder",
        `Window rollover failed (${this.market._id}): ${String(err)}`,
      );
    } finally {
      // finalizeWindow normally clears this; belt-and-suspenders if it returned early
      // or threw before its own finally.
      if (this.finalizing || this.activeWindow) {
        this.resetActiveWindow();
      }
    }
  }

  /** Warm the next window's CLOB tokens on the socket ~30s before rollover. */
  private async prefetchNextWindowTokens(): Promise<void> {
    if (!this.activeWindow || this.nextWindowPrefetchInFlight) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const { windowStart, windowEnd } = this.activeWindow;
    if (nowSec < windowEnd - NEXT_WINDOW_PREFETCH_SEC) return;

    const nextStart = windowEnd;
    if (this.prefetchedNextWindowStart === nextStart) return;

    this.nextWindowPrefetchInFlight = true;
    try {
      const pair = await fetchUpDownMarketAtWindow(this.market._id, nextStart);
      clobMarketFeed.ensureSubscribed([pair.yesTokenId, pair.noTokenId]);
      this.prefetchedNextWindowStart = nextStart;
      logService.info(
        "recorder",
        `Prefetched next window ${new Date(nextStart * 1000).toLocaleTimeString()} tokens for ${this.market._id}`,
      );
    } catch (err) {
      logService.warn(
        "recorder",
        `Next-window prefetch failed (${this.market._id}): ${String(err)}`,
      );
    } finally {
      this.nextWindowPrefetchInFlight = false;
    }
  }

  private writeOpeningSocketTicks(windowStart: number, yesTokenId: string, noTokenId: string): void {
    this.activeYesTokenId = yesTokenId;
    this.activeNoTokenId = noTokenId;
    const openMs = windowStart * 1000;
    const yesInfo = clobMarketFeed.getCachedMarketInfo(yesTokenId);
    const noInfo = clobMarketFeed.getCachedMarketInfo(noTokenId);
    if (hasSocketBook(yesInfo) || hasSocketBook(noInfo)) {
      this.appendClobBookTick(openMs);
    }
    this.pushChainlinkTick(openMs);
  }

  private async pruneOldData(): Promise<void> {
    await pruneColdMarketData(this.market);
  }

  private async finalizeWindow(): Promise<void> {
    if (!this.activeWindow) return;

    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < this.activeWindow.windowEnd) return;

    const windowStart = this.activeWindow.windowStart;
    if (this.finalizedWindowStarts.has(windowStart)) {
      this.resetActiveWindow();
      return;
    }

    this.finalizing = true;
    try {
      // Must stay inside try — a throw here used to leave finalizing=true forever
      // and block health recovery / new windows.
      finalizeWindowDynamics(this.activeWindow);

      let record: WindowHitRecord = {
        windowStart: this.activeWindow.windowStart,
        windowEnd: this.activeWindow.windowEnd,
        slug: this.activeWindow.slug,
        question: this.activeWindow.question,
        conditionId: this.activeWindow.conditionId,
        assetPrice: this.activeWindow.assetPrice,
        prevCloseAsset: this.activeWindow.prevCloseAsset,
        assetGap: this.activeWindow.assetGap,
        ptbCrossings: this.activeWindow.ptbCrossings,
        minAssetPrice: this.activeWindow.minAssetPrice,
        maxAssetPrice: this.activeWindow.maxAssetPrice,
        assetRange: this.activeWindow.assetRange,
        rangeTop: this.activeWindow.rangeTop,
        rangeBottom: this.activeWindow.rangeBottom,
        windowOutcome: this.activeWindow.windowOutcome,
        yesPrice: this.activeWindow.yesPrice,
        noPrice: this.activeWindow.noPrice,
        savedAt: new Date().toISOString(),
      };

      await this.flushTicks();

      if (isFlatPriceWindow(record)) {
        await discardBadRecording(
          this.market._id,
          windowStart,
          "flat asset price through the window",
        );
        this.finalizedWindowStarts.add(windowStart);
        this.onStateChange?.(this.market._id);
        return;
      }

      record = await enrichWindowWithUniqueTraders(record, this.market._id, { force: true });

      const savedAt = record.savedAt ?? new Date().toISOString();
      const recordedDoc = {
        windowStart: record.windowStart,
        windowEnd: record.windowEnd,
        savedAt,
        slug: record.slug,
        question: record.question,
        conditionId: record.conditionId,
        assetPrice: record.assetPrice,
        prevCloseAsset: record.prevCloseAsset,
        assetGap: record.assetGap,
        windowOutcome: record.windowOutcome,
        yesPrice: record.yesPrice,
        noPrice: record.noPrice,
        ptbCrossings: record.ptbCrossings,
        minAssetPrice: record.minAssetPrice,
        maxAssetPrice: record.maxAssetPrice,
        assetRange: record.assetRange,
        rangeTop: record.rangeTop,
        rangeBottom: record.rangeBottom,
        uniqueTraders: record.uniqueTraders,
        newWallets: record.newWallets,
        knownWallets: record.knownWallets,
        tickCount: this.clobRawCount + this.clobBookCount + this.chainlinkCount,
        clobRawCount: this.clobRawCount,
        clobBookCount: this.clobBookCount,
        chainlinkCount: this.chainlinkCount,
      };
      await saveRecordedWindow(this.market, recordedDoc);
      await upsertRecordedWindowSummary(this.market._id, {
        windowStart: recordedDoc.windowStart,
        windowEnd: recordedDoc.windowEnd,
        savedAt,
        ptbCrossings: recordedDoc.ptbCrossings,
        rangeTop: recordedDoc.rangeTop,
        rangeBottom: recordedDoc.rangeBottom,
        uniqueTraders: recordedDoc.uniqueTraders,
        newWallets: recordedDoc.newWallets,
        windowOutcome: recordedDoc.windowOutcome,
        minAssetPrice: recordedDoc.minAssetPrice,
        maxAssetPrice: recordedDoc.maxAssetPrice,
        assetRange: recordedDoc.assetRange,
        prevCloseAsset: recordedDoc.prevCloseAsset,
        assetPrice: recordedDoc.assetPrice,
      }).catch((err) => {
        logService.warn(
          "recorder",
          `Mongo recorded_windows upsert failed (${this.market._id}): ${String(err)}`,
        );
      });
      ingestRecordedWindow(this.market._id, {
        _id: String(record.windowStart),
        updatedAt: savedAt,
        ...recordedDoc,
      });
      await this.pruneOldData();

      this.lastTraderStats = {
        uniqueTraders: record.uniqueTraders,
        newWallets: record.newWallets,
        knownWallets: record.knownWallets,
      };

      this.finalizedWindowStarts.add(windowStart);
      logService.success(
        "recorder",
        `Window saved ${new Date(windowStart * 1000).toLocaleTimeString()} (${this.clobRawCount} raw, ${this.clobBookCount} book, ${this.chainlinkCount} chainlink, ${record.newWallets ?? 0} new wallets)`,
      );
      this.onStateChange?.(this.market._id);

      if (
        !hasOfficialWindowOutcome(recordedDoc.windowOutcome) &&
        typeof recordedDoc.slug === "string" &&
        recordedDoc.slug.trim()
      ) {
        this.scheduleBackgroundOfficialResolve({
          windowStart: recordedDoc.windowStart,
          windowEnd: recordedDoc.windowEnd,
          slug: recordedDoc.slug,
        });
      }
    } catch (err) {
      logService.error("recorder", `Failed to finalize window (${this.market._id}): ${String(err)}`);
    } finally {
      this.finalizing = false;
      this.resetActiveWindow();
    }
  }

  private scheduleFastRetry(): void {
    if (this.fastRetryTimer || !this.interval) return;
    this.fastRetryTimer = setTimeout(() => {
      this.fastRetryTimer = null;
      void this.collectSample().catch((err) => {
        logService.error("recorder", `${this.market._id}: ${String(err)}`);
      });
    }, 1000);
  }

  private async fetchMarketPair(rolling = false) {
    if (rolling || this.windowFetchPending) {
      return fetchCurrentUpDownMarketWithRetry(this.market._id, {
        maxWaitMs: 30_000,
        intervalMs: 500,
      });
    }
    return fetchCurrentUpDownMarket(this.market._id);
  }

  private async collectSample(): Promise<void> {
    if (this.sampleInFlight) return;
    this.sampleInFlight = true;
    try {
      await this.runCollectSample();
    } finally {
      this.sampleInFlight = false;
    }
  }

  private async runCollectSample(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    let rolling = false;

    if (this.activeWindow && nowSec >= this.activeWindow.windowEnd) {
      await this.rollClosedWindow();
      rolling = true;
      this.windowFetchPending = true;
    } else if (this.activeWindow) {
      void this.prefetchNextWindowTokens();
    }

    let pair;
    try {
      pair = await this.fetchMarketPair(rolling);
      this.windowFetchPending = false;
      if (this.fastRetryTimer) {
        clearTimeout(this.fastRetryTimer);
        this.fastRetryTimer = null;
      }
    } catch (err) {
      if (rolling || this.windowFetchPending) {
        this.windowFetchPending = true;
        this.scheduleFastRetry();
      }
      throw err;
    }

    if (pair.windowEnd != null && Math.floor(Date.now() / 1000) >= pair.windowEnd) {
      this.windowFetchPending = true;
      try {
        pair = await fetchCurrentUpDownMarketWithRetry(this.market._id, {
          maxWaitMs: 30_000,
          intervalMs: 500,
        });
        this.windowFetchPending = false;
      } catch (err) {
        this.scheduleFastRetry();
        throw err;
      }
      const freshNow = Math.floor(Date.now() / 1000);
      if (pair.windowEnd != null && freshNow >= pair.windowEnd) {
        this.windowFetchPending = true;
        this.scheduleFastRetry();
        return;
      }
    }

    clobMarketFeed.ensureSubscribed([pair.yesTokenId, pair.noTokenId]);

    const { asset, timeframe } = parseMarketSeries(this.market._id);
    let assetPrice: number | undefined;
    let prevCloseAsset: number | undefined;
    try {
      if (pair.windowStart != null && pair.eventStartTimeIso && pair.eventEndTimeIso) {
        const prices = await getPolymarketWindowAssetPricesForPair(asset, timeframe, pair);
        assetPrice = prices.assetPrice;
        prevCloseAsset = prices.prevCloseAsset;
      }
    } catch {
      const live = chainlinkPriceFeed.getLivePrice(asset);
      if (live) assetPrice = live.value;
    }

    if (this.activeWindow && pair.windowStart === this.activeWindow.windowStart) {
      this.applyAssetPrices(assetPrice, prevCloseAsset);
      const yesInfo = clobMarketFeed.getCachedMarketInfo(pair.yesTokenId);
      const noInfo = clobMarketFeed.getCachedMarketInfo(pair.noTokenId);
      if (yesInfo) this.activeWindow.yesPrice = pickDisplayPrice(yesInfo).price;
      if (noInfo) this.activeWindow.noPrice = pickDisplayPrice(noInfo).price;
    }

    if (pair.windowStart != null && pair.windowEnd != null) {
      const windowStart = pair.windowStart;
      const windowEnd = pair.windowEnd;

      if (this.activeWindow && this.activeWindow.windowStart !== windowStart) {
        if (nowSec >= this.activeWindow.windowEnd) {
          await this.rollClosedWindow();
        } else if (this.activeWindow.slug) {
          try {
            pair = await fetchMarketPairFromSlug(this.activeWindow.slug);
          } catch {
            // keep current pair
          }
        }
      }

      if (!this.activeWindow) {
        if (
          this.discardedWindowStarts.has(windowStart) ||
          this.finalizedWindowStarts.has(windowStart)
        ) {
          // Stall-damaged or already finished — wait for the next window.
        } else {
          this.beginWindow(windowStart, windowEnd, {
            question: pair.question,
            slug: pair.slug,
            conditionId: pair.conditionId,
          });
          this.applyAssetPrices(assetPrice, prevCloseAsset);
          this.writeOpeningSocketTicks(windowStart, pair.yesTokenId, pair.noTokenId);
        }
      } else if (this.activeWindow.windowStart === windowStart && pair.conditionId) {
        this.activeWindow.conditionId = pair.conditionId;
      }

      if (this.activeWindow && this.activeWindow.windowStart === windowStart) {
        this.activeYesTokenId = pair.yesTokenId;
        this.activeNoTokenId = pair.noTokenId;
      }
    }

    this.onStateChange?.(this.market._id);
  }
}
