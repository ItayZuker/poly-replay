/**
 * Live Schedule Open Replay: recorded windows for a UTC weekday×hour slot,
 * with buy/sell markers from real Trigger (and legacy phase) fills — not re-sim.
 *
 * Uses the latest calendar day for that slot (same override rule as Live hour
 * stats): prefer the day that still has ledger fills; otherwise the latest
 * recorded day. A new ISO week does not clear other days' Open Replay.
 *
 * Windows without Chainlink tick files are omitted (same rule as Replay Run):
 * no price path ⇒ no Open Replay row (avoids empty charts / false review).
 * On Live/Heroku, pass `windowsWithTicks` from the recorder worker — local DATA_DIR
 * on the trading executor usually has no tick files.
 */
import { listRecordedWindowsSince } from "./db/recorded-window-mongo-repository.js";
import { windowsHavingChainlinkTicks } from "./db/tick-repository.js";
import { listTradingStatEvents, type TradingStatEvent } from "./db/trading-session-memory-repository.js";
import { getWeekHistoryCutoffUtcSec, utcDayKeyFromWindowStart } from "./day-hour-slots.js";
import { isFlatPriceWindow } from "./window-dynamics.js";
import {
  triggerTradeWindowMs,
  utcDayKeyFromMs,
} from "./schedule-hour-stats.js";
import {
  parseSyntheticHourPlacement,
  type PlacementPlayPayload,
  type PlacementPlayWindowItem,
  type PlayOutcomeBucket,
  type TradeDot,
} from "./schedule-backtest-service.js";
import { defaultPhaseConfig } from "./phase-config.js";
import type {
  MarketDocument,
  ScheduleDayId,
  SimMarker,
  TradingPhaseSetup,
  WindowOutcome,
} from "./types.js";

const UTC_DAY_TO_ID: ScheduleDayId[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function triggerOnlyPhaseSetup(): TradingPhaseSetup {
  const phaseOff = { ...defaultPhaseConfig(), buyEnabled: false };
  return {
    phaseSplit: [1 / 3, 2 / 3],
    phases: [phaseOff, phaseOff, phaseOff],
  };
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

function windowMatchesHourSlot(
  windowStart: number,
  day: ScheduleDayId,
  startHour: number,
): boolean {
  const date = new Date(windowStart * 1000);
  if (UTC_DAY_TO_ID[date.getUTCDay()] !== day) return false;
  return date.getUTCHours() === startHour;
}

function isLiveTradeEvent(event: TradingStatEvent): boolean {
  if (event.card?.source === "manual") return false;
  if (event.card?.source === "trigger") return true;
  if (event.card?.triggerId) return true;
  if (event.card?.source === "auto" || event.placementId || event.card?.placementId) return true;
  return false;
}

function markersFromEvent(event: TradingStatEvent): SimMarker[] {
  const card = event.card;
  if (!card) return [];
  const side = card.side === "down" ? "down" : "up";
  const buyAt = Number(card.buyAt);
  if (!Number.isFinite(buyAt) || buyAt <= 0) return [];
  const tBuy = buyAt > 1e12 ? buyAt / 1000 : buyAt;
  const windowKey = String(card.windowKey || `${tBuy}`);
  const shares = Number(card.shares) || 0;
  const buyPrice = Number(card.buyPrice) || 0;
  const source: SimMarker["source"] =
    card.source === "trigger" || card.triggerId ? "trigger" : "phase";

  const markers: SimMarker[] = [
    {
      type: "buy",
      side,
      t: tBuy,
      y: null,
      shares,
      price: buyPrice,
      source,
      cost: card.buyCost,
      fees: card.buyFees,
      total:
        card.buyCost != null || card.buyFees != null
          ? (Number(card.buyCost) || 0) + (Number(card.buyFees) || 0)
          : undefined,
      windowKey,
    },
  ];

  // Real book sells only. Held win/loss leave the buy marker alone (blue/red via tradeDots).
  const soldAt = Number(card.soldAt);
  if (event.status === "sold" && Number.isFinite(soldAt) && soldAt > 0) {
    const tSell = soldAt > 1e12 ? soldAt / 1000 : soldAt;
    markers.push({
      type: "sell",
      side,
      t: tSell,
      y: null,
      shares,
      price: Number(card.sellPrice) || 0,
      source,
      proceeds: card.sellProceeds,
      fees: card.sellFees,
      profit: Number.isFinite(event.pnl) ? event.pnl : card.pl,
      total: card.sellProceeds,
      windowKey,
    });
  }

  return markers;
}

function bucketFromEvent(event: TradingStatEvent): PlayOutcomeBucket {
  if (event.green) return "green";
  if (event.blue) return "blue";
  if (event.red) return "red";
  return "none";
}

function tradeDotsFromEvent(event: TradingStatEvent): TradeDot[] {
  const bucket = bucketFromEvent(event);
  if (bucket === "none") return [];
  const card = event.card;
  const buyAt = Number(card?.buyAt);
  if (!Number.isFinite(buyAt) || buyAt <= 0) return [];
  const buyT = buyAt > 1e12 ? buyAt / 1000 : buyAt;
  const soldAt = Number(card?.soldAt);
  const sellT =
    Number.isFinite(soldAt) && soldAt > 0 ? (soldAt > 1e12 ? soldAt / 1000 : soldAt) : undefined;
  return [
    {
      bucket,
      source: event.card?.source === "trigger" || event.card?.triggerId ? "trigger" : "phase",
      side: card?.side === "down" ? "down" : "up",
      buyT,
      sellT,
    },
  ];
}

/**
 * Build Open Replay payload for a Live Schedule hour cell (`hour:mon:14`).
 * Uses Mongo recorded_windows for the active calendar day of that slot + ledger markers.
 * Omits windows with no Chainlink ticks (and ledger-only / orphan rows).
 */
export async function buildLiveHourPlayPayload(
  userId: string,
  market: MarketDocument,
  placementId: string,
  options: {
    nowMs?: number;
    /**
     * Resolve which candidates still have Chainlink ticks.
     * Live/Heroku should probe the recorder; default = local DATA_DIR.
     */
    resolveWindowsWithTicks?: (windowStarts: number[]) => Promise<number[]>;
  } = {},
): Promise<PlacementPlayPayload | null> {
  const placement = parseSyntheticHourPlacement(placementId, market._id);
  if (!placement) return null;

  const nowMs = options.nowMs ?? Date.now();
  const day = placement.day;
  const startHour = placement.startHour;
  const series = market._id;

  const cutoffUtc = getWeekHistoryCutoffUtcSec(new Date(nowMs));
  const listed = await listRecordedWindowsSince(cutoffUtc, series);
  const slotWindowsAll = listed
    .filter((w) => !isFlatPriceWindow(w))
    .filter((w) => windowMatchesHourSlot(w.windowStart, day, startHour))
    .sort((a, b) => a.windowStart - b.windowStart);

  const events = (await listTradingStatEvents(userId, {})).filter(isLiveTradeEvent);

  type SlotEvent = { atMs: number; winStart: number; event: TradingStatEvent };
  const slotEvents: SlotEvent[] = [];

  for (const event of events) {
    const atMs = triggerTradeWindowMs({
      buyAt: event.card?.buyAt,
      windowKey: event.card?.windowKey,
    });
    if (!Number.isFinite(atMs)) continue;
    if (atMs < cutoffUtc * 1000) continue;
    const slotDay = UTC_DAY_TO_ID[new Date(atMs).getUTCDay()] ?? "sun";
    if (slotDay !== day || new Date(atMs).getUTCHours() !== startHour) continue;

    let winStart = windowKeyUnixSec(event.card?.windowKey);
    if (!Number.isFinite(winStart)) {
      // Fallback: snap buy time to 5m boundary if unknown.
      const buySec = Math.floor(atMs / 1000);
      winStart = buySec - (buySec % 300);
    }
    if (!Number.isFinite(winStart)) continue;
    slotEvents.push({ atMs, winStart, event });
  }

  // Prefer the calendar day that still drives Live hour-cell stats (ledger fills).
  // If none, fall back to the latest recorded day for this weekday×hour.
  let activeDayKey: string | null = null;
  for (const row of slotEvents) {
    const dayKey = utcDayKeyFromMs(row.atMs);
    if (!activeDayKey || dayKey > activeDayKey) activeDayKey = dayKey;
  }
  if (!activeDayKey) {
    for (const w of slotWindowsAll) {
      const dayKey = utcDayKeyFromWindowStart(w.windowStart);
      if (!activeDayKey || dayKey > activeDayKey) activeDayKey = dayKey;
    }
  }

  const slotWindows = activeDayKey
    ? slotWindowsAll.filter((w) => utcDayKeyFromWindowStart(w.windowStart) === activeDayKey)
    : [];

  // Group events by window start (from windowKey, else buyAt floored to window).
  const eventsByWindow = new Map<number, TradingStatEvent[]>();
  for (const row of slotEvents) {
    if (activeDayKey && utcDayKeyFromMs(row.atMs) !== activeDayKey) continue;
    const list = eventsByWindow.get(row.winStart) ?? [];
    list.push(row.event);
    eventsByWindow.set(row.winStart, list);
  }

  const candidateStarts = slotWindows.map((w) => w.windowStart);
  const presentStarts = options.resolveWindowsWithTicks
    ? await options.resolveWindowsWithTicks(candidateStarts)
    : await windowsHavingChainlinkTicks(market, candidateStarts);
  const tickSet = new Set(presentStarts);

  const windows: PlacementPlayWindowItem[] = [];
  for (const meta of slotWindows) {
    if (!tickSet.has(meta.windowStart)) continue;

    const windowStart = meta.windowStart;
    const windowEnd = meta.windowEnd ?? windowStart + 300;
    const winEvents = eventsByWindow.get(windowStart) ?? [];
    const markers: SimMarker[] = [];
    let pnl = 0;
    let sold = false;
    const tradeDots: PlacementPlayWindowItem["tradeDots"] = [];
    let bucket: PlayOutcomeBucket = "none";

    for (const event of winEvents) {
      markers.push(...markersFromEvent(event));
      pnl += Number(event.pnl) || 0;
      if (event.status === "sold") sold = true;
      const dots = tradeDotsFromEvent(event);
      tradeDots.push(...dots);
      if (bucket === "none" && dots[0]) bucket = dots[0].bucket;
    }

    // Official settlement only from the recording (crypto-price / Gamma finalize).
    const windowOutcome: WindowOutcome | undefined =
      meta.windowOutcome === "up" || meta.windowOutcome === "down"
        ? meta.windowOutcome
        : undefined;
    const prevCloseAsset =
      meta.prevCloseAsset != null && Number.isFinite(meta.prevCloseAsset)
        ? Number(meta.prevCloseAsset)
        : undefined;
    const finalPrice =
      meta.assetPrice != null && Number.isFinite(meta.assetPrice)
        ? Number(meta.assetPrice)
        : undefined;

    windows.push({
      windowStart,
      windowEnd,
      windowOutcome,
      prevCloseAsset,
      finalPrice,
      bucket,
      tradeDots,
      pnl,
      plLabel: markers.length ? (sold ? "Trade" : "Settlement") : "No trade",
      sold,
      markers: markers.sort((a, b) => a.t - b.t),
      recordingMissing: false,
      predictionSide: null,
      predictionScore: null,
      predictionScores: [],
      predictionTriggers: [],
      predictionTriggeredAtMs: null,
      predictionSensitivitySec: null,
    });
  }

  windows.sort((a, b) => a.windowStart - b.windowStart);

  return {
    placementId: placement._id,
    setupId: placement.setupId,
    title: `${placement.title} · Live`,
    day: placement.day,
    startHour: placement.startHour,
    durationHours: 1,
    setup: triggerOnlyPhaseSetup(),
    latencyMs: 0,
    fillSuccessPct: 100,
    triggerOnly: true,
    windows,
  };
}
