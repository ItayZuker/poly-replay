import type { MarketDocument } from "./types.js";
import { listMarkets } from "./db/market-repository.js";
import { MarketRecorder } from "./market-recorder.js";
import { chainlinkPriceFeed } from "./chainlink-price-feed.js";
import { clobMarketFeed } from "./clob-market-feed.js";
import { parseMarketSeries } from "./market-pair.js";
import { logService } from "./log-service.js";
import { canProcessRecord } from "./recording-enabled.js";

const HEALTH_CHECK_MS = 5_000;
/** Avoid thrashing reconnects if silence persists across consecutive windows. */
const RECOVERY_COOLDOWN_MS = 90_000;

export class RecordingManager {
  private recorders = new Map<string, MarketRecorder>();
  private onChange: ((series: string) => void) | null = null;
  private stallUnsub: (() => void) | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private lastRecoveryAtMs = 0;
  private recoveryInFlight = false;

  setOnChange(listener: (series: string) => void): void {
    this.onChange = listener;
  }

  private ensureStallHandler(): void {
    if (this.stallUnsub) return;
    this.stallUnsub = chainlinkPriceFeed.onAssetStall((asset) => {
      logService.warn("chainlink", `${asset.toUpperCase()} price stalled — reconnecting RTDS`);
      this.discardWindowsForAsset(asset);
    });
  }

  private ensureHealthWatchdog(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      void this.checkRecordingHealth();
    }, HEALTH_CHECK_MS);
  }

  private discardWindowsForAsset(asset: string): void {
    const target = asset.toLowerCase();
    for (const [series, recorder] of this.recorders) {
      try {
        const { asset: seriesAsset } = parseMarketSeries(series);
        if (seriesAsset !== target) continue;
        recorder.discardActiveWindow(`chainlink ${target} stall`);
      } catch {
        // ignore unknown series ids
      }
    }
  }

  /**
   * Broader than Chainlink-only stall: if any recorder's active window has had
   * no book/chainlink ticks for too long, discard that window, reconnect feeds,
   * and restart the stuck recorder(s).
   */
  private async checkRecordingHealth(): Promise<void> {
    if (!canProcessRecord() || this.recorders.size === 0) return;
    if (this.recoveryInFlight) return;

    const now = Date.now();
    if (now - this.lastRecoveryAtMs < RECOVERY_COOLDOWN_MS) return;

    const stuck: MarketRecorder[] = [];
    for (const recorder of this.recorders.values()) {
      if (recorder.needsHealthRecovery(now)) stuck.push(recorder);
    }
    if (stuck.length === 0) return;

    this.recoveryInFlight = true;
    this.lastRecoveryAtMs = now;
    const labels = stuck.map((r) => r.getSeries()).join(", ");
    try {
      logService.warn(
        "recorder",
        `Recording silence on ${labels} — discarding window(s), reconnecting feeds, restarting recorder(s)`,
      );
      for (const recorder of stuck) {
        recorder.discardActiveWindow("recording silence (health watchdog)");
      }
      chainlinkPriceFeed.forceReconnect();
      clobMarketFeed.forceReconnect();
      for (const recorder of stuck) {
        await this.refreshMarket(recorder.getMarket());
      }
    } catch (err) {
      logService.error("recorder", `Health recovery failed: ${String(err)}`);
    } finally {
      this.recoveryInFlight = false;
    }
  }

  /** Start/stop recorders from each market's `recordingEnabled` flag. */
  async sync(): Promise<void> {
    if (!canProcessRecord()) {
      this.stopAll();
      return;
    }

    this.ensureStallHandler();
    this.ensureHealthWatchdog();
    const markets = await listMarkets();
    const enabled = new Set(
      markets.filter((m) => m.recordingEnabled).map((m) => m._id),
    );

    for (const [series, recorder] of this.recorders) {
      if (!enabled.has(series)) {
        recorder.stop();
        this.recorders.delete(series);
        logService.info("recorder", `Recording stopped for ${series}`);
      }
    }

    for (const market of markets) {
      if (!market.recordingEnabled) continue;
      if (this.recorders.has(market._id)) continue;
      const recorder = new MarketRecorder(market, (s) => this.onChange?.(s));
      recorder.start();
      this.recorders.set(market._id, recorder);
      logService.info("recorder", `Recording started for ${market._id}`);
    }
  }

  async refreshMarket(market: MarketDocument): Promise<void> {
    if (!canProcessRecord()) {
      const existing = this.recorders.get(market._id);
      if (existing) {
        existing.stop();
        this.recorders.delete(market._id);
      }
      return;
    }

    this.ensureStallHandler();
    this.ensureHealthWatchdog();
    const existing = this.recorders.get(market._id);
    if (market.recordingEnabled) {
      if (existing) {
        existing.stop();
        this.recorders.delete(market._id);
      }
      const recorder = new MarketRecorder(market, (s) => this.onChange?.(s));
      recorder.start();
      this.recorders.set(market._id, recorder);
      logService.info("recorder", `Recording started for ${market._id}`);
    } else if (existing) {
      existing.stop();
      this.recorders.delete(market._id);
      logService.info("recorder", `Recording stopped for ${market._id}`);
    }
  }

  getRecorder(series: string): MarketRecorder | undefined {
    return this.recorders.get(series);
  }

  getActiveWindow(series: string) {
    return this.recorders.get(series)?.getActiveWindow() ?? null;
  }

  getTraderStats(series: string) {
    return this.recorders.get(series)?.getTraderStats() ?? null;
  }

  stopAll(): void {
    if (this.stallUnsub) {
      this.stallUnsub();
      this.stallUnsub = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.recoveryInFlight = false;
    for (const recorder of this.recorders.values()) {
      recorder.stop();
    }
    this.recorders.clear();
  }
}

export const recordingManager = new RecordingManager();
