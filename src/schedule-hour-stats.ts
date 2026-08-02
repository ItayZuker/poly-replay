import type { TriggerModeTimelineEvent } from "./db/trigger-mode-timeline-repository.js";
import { wasTriggerTradingActive } from "./db/trigger-mode-timeline-repository.js";
import type { TradingStatEvent } from "./db/trading-session-memory-repository.js";
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

export function slotKeyFromMs(atMs: number): { day: ScheduleHourDayId; hour: number; key: string } | null {
  if (!Number.isFinite(atMs)) return null;
  const date = new Date(atMs);
  const day = UTC_DAY_TO_ID[date.getUTCDay()] ?? "sun";
  const hour = date.getUTCHours();
  return { day, hour, key: `${day}:${hour}` };
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
  if (card.confirmed === false) return null;
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
  if (event.card?.confirmed === false) return null;
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
  if (card.source !== "trigger") return null;
  const id = typeof card.triggerId === "string" ? card.triggerId.trim() : "";
  return id || null;
}

function triggerIdOfEvent(event: TradingStatEvent): string | null {
  if (event.card?.source !== "trigger") return null;
  const id = typeof event.card.triggerId === "string" ? event.card.triggerId.trim() : "";
  return id || null;
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
  return wasTriggerTradingActive(timeline, atMs);
}

export interface ComputeHourSlotStatsInput {
  /** Settled ledger events (RAM / Mongo). */
  events: TradingStatEvent[];
  /** Open+settled position cards; settled trigger cards fill gaps not in the ledger. */
  cards?: TradingPositionCard[];
  /** Full Active/Paused (+ Trade/Demo) timeline for relevant triggers. */
  timelineEvents: TriggerModeTimelineEvent[];
  /** Restrict to this ISO week (YYYY-Www). Defaults to the current UTC ISO week. */
  weekKey?: string;
  nowMs?: number;
}

/**
 * Aggregate Trigger Trade settled outcomes into UTC weekday×hour slots for one ISO week.
 */
export function computeScheduleHourSlotStats(
  input: ComputeHourSlotStatsInput,
): ScheduleHourSlotStats[] {
  const nowMs = input.nowMs ?? Date.now();
  const weekKey = input.weekKey ?? currentUtcIsoWeekKey(nowMs);
  const byTrigger = groupTimelineByTrigger(input.timelineEvents);
  const slots = new Map<string, ScheduleHourSlotStats>();
  for (const day of SCHEDULE_HOUR_DAYS) {
    for (let hour = 0; hour < 24; hour++) {
      slots.set(`${day}:${hour}`, emptySlot(day, hour));
    }
  }

  const seenIdentities = new Set<string>();
  const seenCardIds = new Set<string>();

  const identityOf = (conditionId?: string, asset?: string, buyAt?: number): string | null => {
    if (!conditionId || !asset || buyAt == null || !Number.isFinite(buyAt)) return null;
    return `${conditionId}|${asset}|${buyAt}`;
  };

  const add = (atMs: number, contrib: SlotContrib): void => {
    const week = utcIsoWeekKey(atMs / 1000);
    if (week !== weekKey) return;
    const slot = slotKeyFromMs(atMs);
    if (!slot) return;
    const row = slots.get(slot.key);
    if (!row) return;
    row.green += contrib.green;
    row.red += contrib.red;
    row.blue += contrib.blue;
    row.stopLoss += contrib.stopLoss;
    row.pnl += contrib.pnl;
    row.hasData = true;
  };

  for (const card of input.cards ?? []) {
    const triggerId = triggerIdOfCard(card);
    if (!triggerId) continue;
    if (card.status === "open") continue;
    const contrib = contribFromCard(card);
    if (!contrib) continue;
    const atMs = triggerTradeWindowMs({ buyAt: card.buyAt, windowKey: card.windowKey });
    if (!Number.isFinite(atMs)) continue;
    if (!shouldCountTriggerTrade(triggerId, atMs, byTrigger)) continue;
    const id = identityOf(card.conditionId, card.asset, card.buyAt);
    if (id) {
      if (seenIdentities.has(id)) continue;
      seenIdentities.add(id);
    }
    seenCardIds.add(card.id);
    add(atMs, contrib);
  }

  for (const event of input.events) {
    const triggerId = triggerIdOfEvent(event);
    if (!triggerId) continue;
    if (seenCardIds.has(event.cardId)) continue;
    const contrib = contribFromEvent(event);
    if (!contrib) continue;
    const atMs = triggerTradeWindowMs({
      buyAt: event.card?.buyAt,
      windowKey: event.card?.windowKey,
    });
    if (!Number.isFinite(atMs)) continue;
    if (!shouldCountTriggerTrade(triggerId, atMs, byTrigger)) continue;
    const id = identityOf(event.card?.conditionId, event.card?.asset, event.card?.buyAt);
    if (id) {
      if (seenIdentities.has(id)) continue;
      seenIdentities.add(id);
    }
    add(atMs, contrib);
  }

  const out: ScheduleHourSlotStats[] = [];
  for (const day of SCHEDULE_HOUR_DAYS) {
    for (let hour = 0; hour < 24; hour++) {
      out.push(slots.get(`${day}:${hour}`) ?? emptySlot(day, hour));
    }
  }
  return out;
}
