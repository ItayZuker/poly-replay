import { getWindowDataVersion } from "./db/recorded-window-repository.js";
import {
  listRecordedWindowsSince,
  type HeatmapRecordedWindow,
} from "./db/recorded-window-mongo-repository.js";
import {
  dayHourFromWindowStart,
  getWeekHistoryCutoffUtcSec,
  selectLatestDayHourWindows,
  type WeekDayId,
} from "./day-hour-slots.js";
import { logService } from "./log-service.js";
import type { RecordedWindowDocument } from "./types.js";
import { isFlatPriceWindow } from "./window-dynamics.js";

export type HeatmapDayId = WeekDayId;
export type HeatmapMetric = "crossings" | "range" | "wallets" | "newWallets";

export interface HeatmapCellValues {
  crossings: number;
  range: number;
  wallets: number;
  newWallets: number;
}

export interface HeatmapPublicState {
  cutoffUtc: number;
  cells: Record<string, HeatmapCellValues>;
  max: HeatmapCellValues;
  /** Latest recorded window per series — used to invalidate schedule placement stats. */
  seriesDataVersions: Record<string, string>;
}

interface StoredHeatmapWindow {
  series: string;
  windowStart: number;
  savedAt: string;
  day: HeatmapDayId;
  hour: number;
  dayKey: string;
  metrics: HeatmapCellValues;
}

interface BucketAccumulator {
  crossingsSum: number;
  rangeSum: number;
  walletsSum: number;
  newWalletsSum: number;
  count: number;
}

let updateListener: ((state: HeatmapPublicState) => void) | null = null;
const windowStore = new Map<string, StoredHeatmapWindow>();

function emptyCell(): HeatmapCellValues {
  return { crossings: 0, range: 0, wallets: 0, newWallets: 0 };
}

function emptyMax(): HeatmapCellValues {
  return { crossings: 0, range: 0, wallets: 0, newWallets: 0 };
}

export function setHeatmapUpdateListener(listener: ((state: HeatmapPublicState) => void) | null): void {
  updateListener = listener;
}

/**
 * @deprecated Prefer getWeekHistoryCutoffUtcSec — kept for fill-success 7-day stats.
 * Start of UTC today − 6 days.
 */
export function getRollingCutoffUtcSec(now = new Date()): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  return Math.floor(Date.UTC(y, m, d - 6) / 1000);
}

function windowKey(series: string, windowStart: number): string {
  return `${series}:${windowStart}`;
}

function bucketKey(day: HeatmapDayId, hour: number): string {
  return `${day}:${hour}`;
}

type HeatmapMetricSource = Pick<
  HeatmapRecordedWindow,
  "ptbCrossings" | "rangeTop" | "rangeBottom" | "uniqueTraders" | "newWallets"
>;

function metricsFromWindow(window: HeatmapMetricSource): HeatmapCellValues {
  return {
    crossings: window.ptbCrossings ?? 0,
    range: (window.rangeTop ?? 0) + (window.rangeBottom ?? 0),
    wallets: window.uniqueTraders ?? 0,
    newWallets: window.newWallets ?? 0,
  };
}

function isInHistoryWindow(windowStart: number, cutoffUtc: number): boolean {
  return windowStart >= cutoffUtc;
}

function toStoredWindow(
  series: string,
  window: HeatmapMetricSource & { windowStart: number; savedAt?: string },
): StoredHeatmapWindow {
  const { day, hour, dayKey } = dayHourFromWindowStart(window.windowStart);
  return {
    series,
    windowStart: window.windowStart,
    savedAt: window.savedAt ?? String(window.windowStart),
    day,
    hour,
    dayKey,
    metrics: metricsFromWindow(window),
  };
}

/** Windows used for display: latest calendar day per weekday×hour only. */
function activeStoredWindows(seriesFilter?: string): StoredHeatmapWindow[] {
  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  const filter = seriesFilter ? String(seriesFilter).trim() : "";
  const candidates: StoredHeatmapWindow[] = [];
  for (const stored of windowStore.values()) {
    if (filter && stored.series !== filter) continue;
    if (!isInHistoryWindow(stored.windowStart, cutoffUtc)) continue;
    candidates.push(stored);
  }
  return selectLatestDayHourWindows(candidates);
}

function seriesDataVersionsFromStore(): Record<string, string> {
  const latestBySeries = new Map<string, StoredHeatmapWindow>();

  for (const stored of activeStoredWindows()) {
    const prev = latestBySeries.get(stored.series);
    if (!prev || stored.windowStart > prev.windowStart) {
      latestBySeries.set(stored.series, stored);
      continue;
    }
    if (stored.windowStart === prev.windowStart && stored.savedAt > prev.savedAt) {
      latestBySeries.set(stored.series, stored);
    }
  }

  const versions: Record<string, string> = {};
  for (const [series, window] of latestBySeries) {
    versions[series] = `${window.windowStart}:${window.savedAt}`;
  }
  return versions;
}

function rebuildState(seriesFilter?: string | null): HeatmapPublicState {
  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  const buckets = new Map<string, BucketAccumulator>();
  const filter = seriesFilter ? String(seriesFilter).trim() : "";

  for (const stored of activeStoredWindows(filter || undefined)) {
    const key = bucketKey(stored.day, stored.hour);
    const bucket = buckets.get(key) ?? {
      crossingsSum: 0,
      rangeSum: 0,
      walletsSum: 0,
      newWalletsSum: 0,
      count: 0,
    };
    bucket.crossingsSum += stored.metrics.crossings;
    bucket.rangeSum += stored.metrics.range;
    bucket.walletsSum += stored.metrics.wallets;
    bucket.newWalletsSum += stored.metrics.newWallets;
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  const cells: Record<string, HeatmapCellValues> = {};
  const max = emptyMax();

  for (const [key, bucket] of buckets) {
    if (bucket.count === 0) continue;
    const cell: HeatmapCellValues = {
      crossings: bucket.crossingsSum / bucket.count,
      range: bucket.rangeSum / bucket.count,
      wallets: bucket.walletsSum / bucket.count,
      newWallets: bucket.newWalletsSum / bucket.count,
    };
    cells[key] = cell;
    max.crossings = Math.max(max.crossings, cell.crossings);
    max.range = Math.max(max.range, cell.range);
    max.wallets = Math.max(max.wallets, cell.wallets);
    max.newWallets = Math.max(max.newWallets, cell.newWallets);
  }

  return { cutoffUtc, cells, max, seriesDataVersions: seriesDataVersionsFromStore() };
}

function pruneExpiredWindows(): void {
  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  for (const [key, stored] of windowStore) {
    if (!isInHistoryWindow(stored.windowStart, cutoffUtc)) {
      windowStore.delete(key);
    }
  }
}

export function getHeatmapState(series?: string | null): HeatmapPublicState {
  pruneExpiredWindows();
  return rebuildState(series);
}

export interface ReplaySlotWindowCount {
  day: HeatmapDayId;
  hour: number;
  /** Recorded windows on the latest calendar day for this weekday×hour. */
  windowCount: number;
}

/**
 * Per UTC weekday×hour counts for Replay Schedule baseline (gray before Run).
 * Uses the same latest-day-per-slot window set as Heatmap / Replay Run.
 */
export function getReplaySlotWindowCounts(series?: string | null): {
  cutoffUtc: number;
  slots: ReplaySlotWindowCount[];
} {
  pruneExpiredWindows();
  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  const filter = series ? String(series).trim() : "";
  const counts = new Map<string, number>();
  for (const stored of activeStoredWindows(filter || undefined)) {
    const key = bucketKey(stored.day, stored.hour);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const days: HeatmapDayId[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const slots: ReplaySlotWindowCount[] = [];
  for (const day of days) {
    for (let hour = 0; hour < 24; hour++) {
      slots.push({
        day,
        hour,
        windowCount: counts.get(bucketKey(day, hour)) ?? 0,
      });
    }
  }
  return { cutoffUtc, slots };
}

export function forgetRecordedWindow(series: string, windowStart: number): void {
  windowStore.delete(windowKey(series, windowStart));
}

export function ingestRecordedWindow(
  series: string,
  window: RecordedWindowDocument,
): HeatmapPublicState {
  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  if (!isInHistoryWindow(window.windowStart, cutoffUtc)) {
    pruneExpiredWindows();
    return rebuildState();
  }

  // Flat-price windows are bad recordings — never keep them in heatmap memory.
  if (isFlatPriceWindow(window)) {
    forgetRecordedWindow(series, window.windowStart);
    pruneExpiredWindows();
    const state = rebuildState();
    updateListener?.(state);
    return state;
  }

  windowStore.set(windowKey(series, window.windowStart), toStoredWindow(series, window));
  pruneExpiredWindows();
  const state = rebuildState();
  updateListener?.(state);
  return state;
}

/** @deprecated Use ingestRecordedWindow */
export const ingestHeatmapWindow = ingestRecordedWindow;

export async function loadAllHeatmapWindows(): Promise<HeatmapPublicState> {
  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  try {
    const windows = await listRecordedWindowsSince(cutoffUtc);
    windowStore.clear();
    let skippedFlat = 0;
    for (const window of windows) {
      if (!isInHistoryWindow(window.windowStart, cutoffUtc)) continue;
      if (isFlatPriceWindow(window)) {
        skippedFlat += 1;
        continue;
      }
      windowStore.set(
        windowKey(window.series, window.windowStart),
        toStoredWindow(window.series, window),
      );
    }
    logService.info(
      "heatmap",
      `Loaded ${windowStore.size} recorded windows from Mongo (since ${cutoffUtc})${
        skippedFlat ? `; skipped ${skippedFlat} flat-price` : ""
      }`,
    );
  } catch (err) {
    logService.warn(
      "heatmap",
      `Failed to load recorded_windows from Mongo — keeping previous cache (${windowStore.size} windows): ${String(err)}`,
    );
  }

  const state = rebuildState();
  updateListener?.(state);
  return state;
}

export { getWindowDataVersion, getWeekHistoryCutoffUtcSec };
