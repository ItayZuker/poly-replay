import { getWindowDataVersion } from "./db/recorded-window-repository.js";
import {
  getRecordedWindowSummary,
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
import { hasOfficialWindowOutcome } from "./official-window-resolution.js";
import type { RecordedWindowDocument, WindowOutcome } from "./types.js";
import { isFlatPriceWindow } from "./window-dynamics.js";

export type HeatmapDayId = WeekDayId;
export type HeatmapMetric = "crossings" | "range" | "wallets" | "newWallets";

export interface HeatmapCellValues {
  crossings: number;
  range: number;
  wallets: number;
  newWallets: number;
}

export interface HeatmapSlotMeta {
  windowStart: number;
  savedAt: string;
}

export interface HeatmapPublicState {
  cutoffUtc: number;
  cells: Record<string, HeatmapCellValues>;
  max: HeatmapCellValues;
  /** Latest recorded window per series — used to invalidate schedule placement stats. */
  seriesDataVersions: Record<string, string>;
  /** Per day:hour slot — which window owns the cell (client patch / cache). */
  slotMeta: Record<string, HeatmapSlotMeta>;
}

/** Single finished window for client-side heatmap merge. */
export interface HeatmapWindowPatch {
  series: string;
  windowStart: number;
  savedAt: string;
  day: HeatmapDayId;
  hour: number;
  metrics: HeatmapCellValues;
  hasOfficialOutcome: boolean;
}

interface StoredHeatmapWindow {
  series: string;
  windowStart: number;
  savedAt: string;
  day: HeatmapDayId;
  hour: number;
  dayKey: string;
  metrics: HeatmapCellValues;
  /** Explicit Gamma Up/Down on the recording — required for Replay usability. */
  hasOfficialOutcome: boolean;
}

interface BucketAccumulator {
  crossingsSum: number;
  rangeSum: number;
  walletsSum: number;
  newWalletsSum: number;
  count: number;
  latestWindowStart: number;
  latestSavedAt: string;
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

function emptyCell(): HeatmapCellValues {
  return { crossings: 0, range: 0, wallets: 0, newWallets: 0 };
}

function emptyMax(): HeatmapCellValues {
  return { crossings: 0, range: 0, wallets: 0, newWallets: 0 };
}

function emptyHeatmapState(cutoffUtc = getWeekHistoryCutoffUtcSec()): HeatmapPublicState {
  return {
    cutoffUtc,
    cells: {},
    max: emptyMax(),
    seriesDataVersions: {},
    slotMeta: {},
  };
}

function toStoredWindow(
  series: string,
  window: HeatmapMetricSource & {
    windowStart: number;
    savedAt?: string;
    windowOutcome?: WindowOutcome | null;
  },
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
    hasOfficialOutcome: hasOfficialWindowOutcome(window.windowOutcome),
  };
}

/** Ephemeral list from Mongo — not retained on the dyno after the request. */
async function loadStoredWindows(seriesFilter?: string): Promise<StoredHeatmapWindow[]> {
  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  const filter = seriesFilter ? String(seriesFilter).trim() : "";
  const windows = await listRecordedWindowsSince(cutoffUtc, filter || undefined);
  const out: StoredHeatmapWindow[] = [];
  for (const window of windows) {
    if (!isInHistoryWindow(window.windowStart, cutoffUtc)) continue;
    if (isFlatPriceWindow(window)) continue;
    if (filter && window.series !== filter) continue;
    out.push(toStoredWindow(window.series, window));
  }
  return out;
}

function activeFromStored(stored: StoredHeatmapWindow[], seriesFilter?: string): StoredHeatmapWindow[] {
  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  const filter = seriesFilter ? String(seriesFilter).trim() : "";
  const candidates: StoredHeatmapWindow[] = [];
  for (const w of stored) {
    if (filter && w.series !== filter) continue;
    if (!isInHistoryWindow(w.windowStart, cutoffUtc)) continue;
    candidates.push(w);
  }
  return selectLatestDayHourWindows(candidates);
}

function buildStateFromStored(
  stored: StoredHeatmapWindow[],
  seriesFilter?: string | null,
): HeatmapPublicState {
  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  const filter = seriesFilter ? String(seriesFilter).trim() : "";
  const active = activeFromStored(stored, filter || undefined);
  const buckets = new Map<string, BucketAccumulator>();

  for (const w of active) {
    const key = bucketKey(w.day, w.hour);
    const bucket = buckets.get(key) ?? {
      crossingsSum: 0,
      rangeSum: 0,
      walletsSum: 0,
      newWalletsSum: 0,
      count: 0,
      latestWindowStart: 0,
      latestSavedAt: "",
    };
    bucket.crossingsSum += w.metrics.crossings;
    bucket.rangeSum += w.metrics.range;
    bucket.walletsSum += w.metrics.wallets;
    bucket.newWalletsSum += w.metrics.newWallets;
    bucket.count += 1;
    if (
      w.windowStart > bucket.latestWindowStart ||
      (w.windowStart === bucket.latestWindowStart && w.savedAt > bucket.latestSavedAt)
    ) {
      bucket.latestWindowStart = w.windowStart;
      bucket.latestSavedAt = w.savedAt;
    }
    buckets.set(key, bucket);
  }

  const cells: Record<string, HeatmapCellValues> = {};
  const slotMeta: Record<string, HeatmapSlotMeta> = {};
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
    slotMeta[key] = {
      windowStart: bucket.latestWindowStart,
      savedAt: bucket.latestSavedAt,
    };
    max.crossings = Math.max(max.crossings, cell.crossings);
    max.range = Math.max(max.range, cell.range);
    max.wallets = Math.max(max.wallets, cell.wallets);
    max.newWallets = Math.max(max.newWallets, cell.newWallets);
  }

  const latestBySeries = new Map<string, StoredHeatmapWindow>();
  for (const w of active) {
    const prev = latestBySeries.get(w.series);
    if (!prev || w.windowStart > prev.windowStart) {
      latestBySeries.set(w.series, w);
      continue;
    }
    if (w.windowStart === prev.windowStart && w.savedAt > prev.savedAt) {
      latestBySeries.set(w.series, w);
    }
  }
  const seriesDataVersions: Record<string, string> = {};
  for (const [series, window] of latestBySeries) {
    seriesDataVersions[series] = `${window.windowStart}:${window.savedAt}`;
  }

  return { cutoffUtc, cells, max, seriesDataVersions, slotMeta };
}

/** Build heatmap from Mongo for this request only (no dyno RAM cache). */
export async function getHeatmapState(series?: string | null): Promise<HeatmapPublicState> {
  const filter = series ? String(series).trim() : "";
  try {
    const stored = await loadStoredWindows(filter || undefined);
    return buildStateFromStored(stored, filter || undefined);
  } catch (err) {
    logService.warn("heatmap", `Mongo heatmap load failed: ${String(err)}`);
    return emptyHeatmapState();
  }
}

export interface ReplaySlotWindowCount {
  day: HeatmapDayId;
  hour: number;
  /** Replay-usable windows on the latest calendar day for this weekday×hour. */
  windowCount: number;
}

/** Active heatmap windows for a series (latest day per weekday×hour). */
export async function listActiveReplaySlotWindows(series?: string | null): Promise<
  Array<{
    series: string;
    windowStart: number;
    day: HeatmapDayId;
    hour: number;
  }>
> {
  const filter = series ? String(series).trim() : "";
  const stored = await loadStoredWindows(filter || undefined);
  return activeFromStored(stored, filter || undefined).map((w) => ({
    series: w.series,
    windowStart: w.windowStart,
    day: w.day,
    hour: w.hour,
  }));
}

/** `series:windowStart` keys for Replay-usable windows (CLOB book + Chainlink on disk). */
export function replayUsableWindowKey(series: string, windowStart: number): string {
  return `${series}:${windowStart}`;
}

/**
 * Per UTC weekday×hour counts for Replay Schedule baseline (gray before Run).
 * Loads Mongo for this request only.
 */
export async function getReplaySlotWindowCounts(
  series?: string | null,
  usableWindowKeys?: ReadonlySet<string> | null,
): Promise<{
  cutoffUtc: number;
  slots: ReplaySlotWindowCount[];
}> {
  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  const filter = series ? String(series).trim() : "";
  const stored = await loadStoredWindows(filter || undefined);
  const counts = new Map<string, number>();
  for (const w of activeFromStored(stored, filter || undefined)) {
    if (!w.hasOfficialOutcome) continue;
    if (
      usableWindowKeys &&
      !usableWindowKeys.has(replayUsableWindowKey(w.series, w.windowStart))
    ) {
      continue;
    }
    const key = bucketKey(w.day, w.hour);
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

/** One finished window for client merge (null if missing / flat / out of range). */
export async function getHeatmapWindowPatch(
  series: string,
  windowStart: number,
): Promise<HeatmapWindowPatch | null> {
  const ser = String(series || "").trim();
  const ws = Math.floor(Number(windowStart));
  if (!ser || !Number.isFinite(ws) || ws <= 0) return null;
  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  if (!isInHistoryWindow(ws, cutoffUtc)) return null;

  const window = await getRecordedWindowSummary(ser, ws);
  if (!window) return null;
  if (isFlatPriceWindow(window)) return null;

  const stored = toStoredWindow(ser, window);
  return {
    series: ser,
    windowStart: stored.windowStart,
    savedAt: stored.savedAt,
    day: stored.day,
    hour: stored.hour,
    metrics: stored.metrics,
    hasOfficialOutcome: stored.hasOfficialOutcome,
  };
}

/** No server RAM cache — clients own heatmap state. */
export function forgetRecordedWindow(_series: string, _windowStart: number): void {
  // intentionally empty
}

/**
 * Recorder hook — Mongo is already upserted by the caller.
 * No dyno heatmap cache; clients fetch / patch from Mongo via API.
 */
export function ingestRecordedWindow(
  _series: string,
  _window: RecordedWindowDocument,
): HeatmapPublicState {
  return emptyHeatmapState();
}

/** @deprecated Use ingestRecordedWindow */
export const ingestHeatmapWindow = ingestRecordedWindow;

/** No-op: heatmap is loaded on demand from Mongo (no boot RAM cache). */
export async function loadAllHeatmapWindows(): Promise<HeatmapPublicState> {
  return emptyHeatmapState();
}

/** @deprecated No server-side heatmap push; kept so older call sites compile. */
export function setHeatmapUpdateListener(
  _listener: ((state: HeatmapPublicState) => void) | null,
): void {
  // intentionally empty
}

export { getWindowDataVersion, getWeekHistoryCutoffUtcSec };
