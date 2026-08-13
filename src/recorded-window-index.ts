import { listRecordedWindowsSince } from "./db/recorded-window-mongo-repository.js";
import {
  dayHourFromWindowStart,
  getWeekHistoryCutoffUtcSec,
  selectLatestDayHourWindows,
  type WeekDayId,
} from "./day-hour-slots.js";
import { logService } from "./log-service.js";
import { hasOfficialWindowOutcome } from "./official-window-resolution.js";
import { isFlatPriceWindow } from "./window-dynamics.js";

export type ReplaySlotDayId = WeekDayId;

export interface ReplaySlotWindowCount {
  day: ReplaySlotDayId;
  hour: number;
  /** Replay-usable windows on the latest calendar day for this weekday×hour. */
  windowCount: number;
}

interface StoredReplayWindow {
  series: string;
  windowStart: number;
  savedAt: string;
  day: ReplaySlotDayId;
  hour: number;
  hasOfficialOutcome: boolean;
}

function bucketKey(day: ReplaySlotDayId, hour: number): string {
  return `${day}:${hour}`;
}

function isInHistoryWindow(windowStart: number, cutoffUtc: number): boolean {
  return windowStart >= cutoffUtc;
}

function toStoredWindow(window: {
  series: string;
  windowStart: number;
  savedAt?: string;
  windowOutcome?: string | null;
}): StoredReplayWindow {
  const { day, hour } = dayHourFromWindowStart(window.windowStart);
  return {
    series: window.series,
    windowStart: window.windowStart,
    savedAt: window.savedAt ?? String(window.windowStart),
    day,
    hour,
    hasOfficialOutcome: hasOfficialWindowOutcome(window.windowOutcome),
  };
}

/** Ephemeral list from Mongo — not retained on the dyno after the request. */
async function loadStoredWindows(seriesFilter?: string): Promise<StoredReplayWindow[]> {
  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  const filter = seriesFilter ? String(seriesFilter).trim() : "";
  const windows = await listRecordedWindowsSince(cutoffUtc, filter || undefined);
  const out: StoredReplayWindow[] = [];
  for (const window of windows) {
    if (!isInHistoryWindow(window.windowStart, cutoffUtc)) continue;
    if (isFlatPriceWindow(window)) continue;
    if (filter && window.series !== filter) continue;
    out.push(toStoredWindow(window));
  }
  return out;
}

function activeFromStored(stored: StoredReplayWindow[], seriesFilter?: string): StoredReplayWindow[] {
  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  const filter = seriesFilter ? String(seriesFilter).trim() : "";
  const candidates: StoredReplayWindow[] = [];
  for (const w of stored) {
    if (filter && w.series !== filter) continue;
    if (!isInHistoryWindow(w.windowStart, cutoffUtc)) continue;
    candidates.push(w);
  }
  return selectLatestDayHourWindows(candidates);
}

function recordingsVersionFromWindows(windows: StoredReplayWindow[]): string {
  let latest: StoredReplayWindow | null = null;
  for (const w of windows) {
    if (!latest || w.windowStart > latest.windowStart) {
      latest = w;
      continue;
    }
    if (w.windowStart === latest.windowStart && w.savedAt > latest.savedAt) {
      latest = w;
    }
  }
  return latest ? `${latest.windowStart}:${latest.savedAt}` : "0";
}

/** Active Replay windows for a series (latest day per weekday×hour). */
export async function listActiveReplaySlotWindows(series?: string | null): Promise<
  Array<{
    series: string;
    windowStart: number;
    day: ReplaySlotDayId;
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
  /** Latest recorded window (`windowStart:savedAt`) — Replay cache invalidation. */
  recordingsVersion: string;
}> {
  const cutoffUtc = getWeekHistoryCutoffUtcSec();
  const filter = series ? String(series).trim() : "";
  try {
    const stored = await loadStoredWindows(filter || undefined);
    const active = activeFromStored(stored, filter || undefined);
    const counts = new Map<string, number>();
    for (const w of active) {
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
    const days: ReplaySlotDayId[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
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
    return {
      cutoffUtc,
      slots,
      recordingsVersion: recordingsVersionFromWindows(active),
    };
  } catch (err) {
    logService.warn("replay", `Mongo recorded-window index load failed: ${String(err)}`);
    const days: ReplaySlotDayId[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const slots: ReplaySlotWindowCount[] = [];
    for (const day of days) {
      for (let hour = 0; hour < 24; hour++) {
        slots.push({ day, hour, windowCount: 0 });
      }
    }
    return { cutoffUtc, slots, recordingsVersion: "0" };
  }
}

export { getWeekHistoryCutoffUtcSec };
