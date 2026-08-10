import type { TriggerModeTimelineEvent } from "./db/trigger-mode-timeline-repository.js";
import { wasTriggerTradingActive } from "./db/trigger-mode-timeline-repository.js";
import type { TradingStatEvent } from "./db/trading-session-memory-repository.js";
import { getWeekHistoryCutoffUtcSec } from "./day-hour-slots.js";
import type { ScheduleHourSlotStats, TradingPositionCard } from "./types.js";

/** UTC weekday ids matching schedule placements (Mon-first grid order). */
export const SCHEDULE_HOUR_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export type ScheduleHourDayId = (typeof SCHEDULE_HOUR_DAYS)[number];

const UTC_DAY_TO_ID: ScheduleHourDayId[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** UTC ISO week key (YYYY-Www) — same grouping as live placement week stats. */
export function utcIsoWeekKey(unixSec: number): string {
  const date = new Date(unixSec * 1000);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function currentUtcIsoWeekKey(nowMs = Date.now()): string {
  return utcIsoWeekKey(Math.floor(nowMs / 1000));
}

/** UTC calendar day key (YYYY-MM-DD) for a trade/window timestamp. */
export function utcDayKeyFromMs(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

export function slotKeyFromMs(atMs: number): { day: ScheduleHourDayId; hour: number; key: string } | null {
  if (!Number.isFinite(atMs)) return null;
  const date = new Date(atMs);
  const day = UTC_DAY_TO_ID[date.getUTCDay()] ?? "sun";
  const hour = date.getUTCHours();
  return { day, hour, key: `${day}:${hour}` };
}

const DAY_INDEX: Record<ScheduleHourDayId, number> = {
  mon: 0,
  tue: 1,
  wed: 2,
  thu: 3,
  fri: 4,
  sat: 5,
  sun: 6,
};

/** UTC Monday 00:00 of the Mon–Sun grid week that contains `nowMs`. */
export function utcMondayOfWeekMs(nowMs: number): number {
  const now = new Date(nowMs);
  const jsDay = now.getUTCDay() || 7; // 1=Mon … 7=Sun
  const mondayDate = now.getUTCDate() - (jsDay - 1);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), mondayDate);
}

/** This week’s UTC calendar day (YYYY-MM-DD) for a grid weekday. */
export function thisWeekDayKeyForSlotDay(day: ScheduleHourDayId, nowMs: number): string {
  const mondayMs = utcMondayOfWeekMs(nowMs);
  const dayMs = mondayMs + DAY_INDEX[day] * 86_400_000;
  return new Date(dayMs).toISOString().slice(0, 10);
}

/**
 * True once this week’s occurrence of `day`×`hour` has started (UTC hour floor).
 * Future slots this week keep last week’s fills until they arrive.
 */
export function liveSlotHasArrived(
  day: ScheduleHourDayId,
  hour: number,
  nowMs: number,
): boolean {
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return false;
  const dayKey = thisWeekDayKeyForSlotDay(day, nowMs);
  const hh = String(hour).padStart(2, "0");
  const slotStartMs = Date.parse(`${dayKey}T${hh}:00:00.000Z`);
  return Number.isFinite(slotStartMs) && nowMs >= slotStartMs;
}

function emptySlot(day: string, hour: number): ScheduleHourSlotStats {
  return {
    day,
    hour,
    green: 0,
    red: 0,
    blue: 0,
    stopLoss: 0,
    pnl: 0,
    hasData: false,
  };
}

/** All 7×24 slots with zeros (stable grid order: mon→sun, hour 0→23). */
export function emptyScheduleHourSlotStats(): ScheduleHourSlotStats[] {
  const out: ScheduleHourSlotStats[] = [];
  for (const day of SCHEDULE_HOUR_DAYS) {
    for (let hour = 0; hour < 24; hour++) {
      out.push(emptySlot(day, hour));
    }
  }
  return out;
}

function windowKeyUnixSec(windowKey: string | undefined | null): number {
  if (windowKey == null || windowKey === "") return NaN;
  const raw = String(windowKey).trim();
  const colon = raw.lastIndexOf(":");
  const tail = colon >= 0 ? raw.slice(colon + 1) : raw;
  const n = Number(tail);
  if (Number.isFinite(n) && n > 0) {
    return n > 1e12 ? n / 1000 : n;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms / 1000 : NaN;
}

/** Prefer buyAt; fall back to window start from windowKey. Returns epoch ms. */
export function triggerTradeWindowMs(input: {
  buyAt?: number | null;
  windowKey?: string | null;
}): number {
  const buyAt = input.buyAt;
  if (buyAt != null && Number.isFinite(buyAt)) {
    return buyAt > 1e12 ? buyAt : buyAt * 1000;
  }
  const winSec = windowKeyUnixSec(input.windowKey);
  return Number.isFinite(winSec) ? winSec * 1000 : NaN;
}

type SlotContrib = {
  green: number;
  red: number;
  blue: number;
  stopLoss: number;
  pnl: number;
};

function contribFromCounts(
  green: number,
  red: number,
  blue: number,
  pnl: number,
  stopLoss: number,
): SlotContrib | null {
  if (!green && !red && !blue && !stopLoss && !Number.isFinite(pnl)) return null;
  return {
    green: green ? 1 : 0,
    red: red ? 1 : 0,
    blue: blue ? 1 : 0,
    stopLoss: stopLoss ? 1 : 0,
    pnl: Number.isFinite(pnl) ? pnl : 0,
  };
}

function contribFromCard(card: TradingPositionCard): SlotContrib | null {
  if (card.status === "open") return null;
  // Include settled fills even when on-chain confirm is still pending.
  const pl = Number(card.pl);
  if (!Number.isFinite(pl)) return null;
  let green = 0;
  let red = 0;
  let blue = 0;
  if (card.status === "sold") {
    if (pl > 0) green = 1;
    else red = 1;
  } else if (card.status === "win" || card.status === "loss") {
    if (pl > 1e-9) blue = 1;
    else red = 1;
  } else {
    return null;
  }
  const stopLoss = card.triggerExitReason === "sl" ? 1 : 0;
  return contribFromCounts(green, red, blue, pl, stopLoss);
}

function contribFromEvent(event: TradingStatEvent): SlotContrib | null {
  // Settled ledger rows count even when confirm was still false at persist time.
  const pl = Number(event.pnl);
  if (!Number.isFinite(pl)) return null;
  let green = 0;
  let red = 0;
  let blue = 0;
  if (event.status === "sold") {
    if (pl > 0) green = 1;
    else red = 1;
  } else if (event.status === "win" || event.status === "loss") {
    if (pl > 1e-9) blue = 1;
    else red = 1;
  } else {
    return null;
  }
  const stopLoss = event.card?.triggerExitReason === "sl" ? 1 : 0;
  return contribFromCounts(green, red, blue, pl, stopLoss);
}

function triggerIdOfCard(card: Pick<TradingPositionCard, "source" | "triggerId">): string | null {
  const id = typeof card.triggerId === "string" ? card.triggerId.trim() : "";
  if (!id) return null;
  // Prefer explicit Trigger source; also accept triggerId on older rows missing source.
  if (card.source === "manual" || card.source === "auto") return null;
  return id;
}

function triggerIdOfEvent(event: TradingStatEvent): string | null {
  const id = typeof event.card?.triggerId === "string" ? event.card.triggerId.trim() : "";
  if (!id) return null;
  if (event.card?.source === "manual" || event.card?.source === "auto") return null;
  return id;
}

/**
 * Legacy phase / schedule-placement trades (pre Trigger-only Schedule).
 * Counted into hour cells until that weekday×hour is overridden by a newer day.
 */
function isLegacyPhaseTrade(card: Pick<TradingPositionCard, "source" | "placementId"> | null | undefined): boolean {
  if (!card) return false;
  if (card.source === "manual" || card.source === "trigger") return false;
  // Live phase fills use source "auto"; older rows may only carry placementId.
  return card.source === "auto" || Boolean(card.placementId);
}

function groupTimelineByTrigger(
  events: TriggerModeTimelineEvent[],
): Map<string, TriggerModeTimelineEvent[]> {
  const map = new Map<string, TriggerModeTimelineEvent[]>();
  for (const ev of events) {
    const list = map.get(ev.triggerId);
    if (list) list.push(ev);
    else map.set(ev.triggerId, [ev]);
  }
  return map;
}

/**
 * Include a trigger trade when:
 * - No timeline rows exist for that triggerId → legacy count (pre-timeline fills)
 * - Else only if wasTriggerTradingActive at the window time
 * - Late timeline seed: no row at/before the trade, but every known row is Trade+Active
 *   (timeline feature deployed after the trigger was already trading) → still count
 */
function shouldCountTriggerTrade(
  triggerId: string,
  atMs: number,
  byTrigger: Map<string, TriggerModeTimelineEvent[]>,
): boolean {
  const timeline = byTrigger.get(triggerId);
  // Legacy: triggers created before the Active/Paused (+ Trade/Demo) timeline
  // have no rows — keep counting their settled Trade fills in hour slots.
  if (!timeline || timeline.length === 0) return true;
  if (wasTriggerTradingActive(timeline, atMs)) return true;
  const hasRowAtOrBefore = timeline.some((ev) => ev.atMs <= atMs);
  if (hasRowAtOrBefore) return false;
  // Gap before the first timeline row — only backfill when we never recorded Demo/Pause.
  const everNotTrading = timeline.some((ev) => ev.paused || ev.runMode !== "trade");
  return !everNotTrading;
}

export interface ComputeHourSlotStatsInput {
  /** Settled ledger events (RAM / Mongo). */
  events: TradingStatEvent[];
  /** Open+settled position cards; settled trigger cards fill gaps not in the ledger. */
  cards?: TradingPositionCard[];
  /** Full Active/Paused (+ Trade/Demo) timeline for relevant triggers. */
  timelineEvents: TriggerModeTimelineEvent[];
  /**
   * Optional ISO week (YYYY-Www) pin for tests/debug.
   * When omitted (Live UI), each weekday×hour keeps the latest calendar day
   * within the ~14 day history window — newer fills override only that slot.
   */
  weekKey?: string;
  nowMs?: number;
}

type PendingSlotHit = {
  slotKey: string;
  dayKey: string;
  contrib: SlotContrib;
};

/**
 * Aggregate settled outcomes into UTC weekday×hour slots:
 * - Trigger Trade (timeline-gated Trade+Active)
 * - Legacy phase / schedule-placement ("auto") trades still in the ledger
 *
 * For each weekday×hour:
 * - Until this week’s occurrence of that hour arrives, keep the latest prior
 *   calendar day with fills (last week’s stats stay visible).
 * - Once the hour arrives (UTC), that day’s slot resets: only fills from this
 *   week’s day count. No buys → zeros with hasData (gray $0 P/L in the UI),
 *   even if last week had trades or there is no recording.
 */
export function computeScheduleHourSlotStats(
  input: ComputeHourSlotStatsInput,
): ScheduleHourSlotStats[] {
  const nowMs = input.nowMs ?? Date.now();
  const weekKey = input.weekKey;
  const cutoffMs = getWeekHistoryCutoffUtcSec(new Date(nowMs)) * 1000;
  const byTrigger = groupTimelineByTrigger(input.timelineEvents);
  const slots = new Map<string, ScheduleHourSlotStats>();
  for (const day of SCHEDULE_HOUR_DAYS) {
    for (let hour = 0; hour < 24; hour++) {
      slots.set(`${day}:${hour}`, emptySlot(day, hour));
    }
  }

  /** Slots whose this-week occurrence has started → force that calendar day. */
  const arrivedDayBySlot = new Map<string, string>();
  for (const day of SCHEDULE_HOUR_DAYS) {
    for (let hour = 0; hour < 24; hour++) {
      if (!liveSlotHasArrived(day, hour, nowMs)) continue;
      arrivedDayBySlot.set(`${day}:${hour}`, thisWeekDayKeyForSlotDay(day, nowMs));
    }
  }

  const seenIdentities = new Set<string>();
  const seenCardIds = new Set<string>();
  const pending: PendingSlotHit[] = [];

  const identityOf = (conditionId?: string, asset?: string, buyAt?: number): string | null => {
    if (!conditionId || !asset || buyAt == null || !Number.isFinite(buyAt)) return null;
    return `${conditionId}|${asset}|${buyAt}`;
  };

  const queue = (atMs: number, contrib: SlotContrib): void => {
    if (atMs < cutoffMs) return;
    if (weekKey != null && utcIsoWeekKey(atMs / 1000) !== weekKey) return;
    const slot = slotKeyFromMs(atMs);
    if (!slot) return;
    pending.push({
      slotKey: slot.key,
      dayKey: utcDayKeyFromMs(atMs),
      contrib,
    });
  };

  const shouldCountCard = (card: TradingPositionCard, atMs: number): boolean => {
    if (card.demo === true) return false;
    const triggerId = triggerIdOfCard(card);
    if (triggerId) return shouldCountTriggerTrade(triggerId, atMs, byTrigger);
    // Older Trigger fills often have source "trigger" but no triggerId persisted.
    if (card.source === "trigger") return true;
    return isLegacyPhaseTrade(card);
  };

  const shouldCountEvent = (event: TradingStatEvent, atMs: number): boolean => {
    if (event.card?.demo === true) return false;
    const triggerId = triggerIdOfEvent(event);
    if (triggerId) return shouldCountTriggerTrade(triggerId, atMs, byTrigger);
    if (event.card?.source === "trigger") return true;
    return isLegacyPhaseTrade(event.card);
  };

  for (const card of input.cards ?? []) {
    if (card.status === "open") continue;
    if (card.demo === true) continue;
    const contrib = contribFromCard(card);
    if (!contrib) continue;
    const atMs = triggerTradeWindowMs({ buyAt: card.buyAt, windowKey: card.windowKey });
    if (!Number.isFinite(atMs)) continue;
    if (!shouldCountCard(card, atMs)) continue;
    const id = identityOf(card.conditionId, card.asset, card.buyAt);
    if (id) {
      if (seenIdentities.has(id)) continue;
      seenIdentities.add(id);
    }
    seenCardIds.add(card.id);
    queue(atMs, contrib);
  }

  for (const event of input.events) {
    if (seenCardIds.has(event.cardId)) continue;
    const contrib = contribFromEvent(event);
    if (!contrib) continue;
    const atMs = triggerTradeWindowMs({
      buyAt: event.card?.buyAt,
      windowKey: event.card?.windowKey,
    });
    if (!Number.isFinite(atMs)) continue;
    if (!shouldCountEvent(event, atMs)) continue;
    const id = identityOf(event.card?.conditionId, event.card?.asset, event.card?.buyAt);
    if (id) {
      if (seenIdentities.has(id)) continue;
      seenIdentities.add(id);
    }
    queue(atMs, contrib);
  }

  const latestDayBySlot = new Map<string, string>();
  for (const hit of pending) {
    // Arrived slots ignore older days when picking the active day.
    const arrivedDay = arrivedDayBySlot.get(hit.slotKey);
    if (arrivedDay && hit.dayKey !== arrivedDay) continue;
    const prev = latestDayBySlot.get(hit.slotKey);
    if (!prev || hit.dayKey > prev) latestDayBySlot.set(hit.slotKey, hit.dayKey);
  }
  // Force arrived slots onto this week’s day even with zero fills (reset last week).
  for (const [slotKey, dayKey] of arrivedDayBySlot) {
    latestDayBySlot.set(slotKey, dayKey);
  }

  for (const hit of pending) {
    if (latestDayBySlot.get(hit.slotKey) !== hit.dayKey) continue;
    const row = slots.get(hit.slotKey);
    if (!row) continue;
    row.green += hit.contrib.green;
    row.red += hit.contrib.red;
    row.blue += hit.contrib.blue;
    row.stopLoss += hit.contrib.stopLoss;
    row.pnl += hit.contrib.pnl;
    row.hasData = true;
  }

  // Arrived with no buys → still show zero-dot row + gray $0 (not last week, not blank).
  for (const slotKey of arrivedDayBySlot.keys()) {
    const row = slots.get(slotKey);
    if (row && !row.hasData) row.hasData = true;
  }

  const out: ScheduleHourSlotStats[] = [];
  for (const day of SCHEDULE_HOUR_DAYS) {
    for (let hour = 0; hour < 24; hour++) {
      out.push(slots.get(`${day}:${hour}`) ?? emptySlot(day, hour));
    }
  }
  return out;
}
