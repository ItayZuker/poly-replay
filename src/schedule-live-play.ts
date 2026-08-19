/**
 * Live Schedule Open Replay: one window row per traded window in a UTC
 * weekday×hour slot (same trades as Live hour-cell dots), with buy/sell markers
 * from real Trigger / legacy phase fills — not re-sim.
 *
 * Uses the last occurrence of that weekday×hour (this week once arrived;
 * otherwise last week) — including empty zero days. Trade windows are always
 * listed even when Chainlink ticks are missing (`recordingMissing: true`);
 * empty recorded windows with no trade are omitted.
 */
import { listRecordedWindowsSince } from "./db/recorded-window-mongo-repository.js";
import { recordingPtbFields } from "./ptb-history.js";
import {
  listTriggerModeEvents,
  wasTriggerTradingActive,
  type TriggerModeTimelineEvent,
} from "./db/trigger-mode-timeline-repository.js";
import { windowsHavingChainlinkTicks } from "./db/tick-repository.js";
import { listTradingStatEvents, type TradingStatEvent } from "./db/trading-session-memory-repository.js";
import {
  activeLiveSlotDayKey,
  getLiveScheduleStatsCutoffUtcSec,
  triggerTradeWindowMs,
  utcDayKeyFromMs,
  type ScheduleHourDayId,
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
  TradingPositionCard,
  WindowOutcome,
} from "./types.js";

const UTC_DAY_TO_ID: ScheduleDayId[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DEFAULT_WINDOW_SEC = 300;

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

function resolveWinStart(windowKey: string | undefined | null, atMs: number): number {
  let winStart = windowKeyUnixSec(windowKey);
  if (!Number.isFinite(winStart)) {
    const buySec = Math.floor(atMs / 1000);
    winStart = buySec - (buySec % DEFAULT_WINDOW_SEC);
  }
  return winStart;
}

function isLiveTradeSource(source: string | undefined, triggerId?: string | null): boolean {
  if (source === "manual") return false;
  if (source === "trigger") return true;
  if (typeof triggerId === "string" && triggerId.trim()) return true;
  if (source === "auto") return true;
  return false;
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

/** Same gate as Live hour-cell stats (Trade+Active timeline). */
function shouldCountTriggerTrade(
  triggerId: string,
  atMs: number,
  byTrigger: Map<string, TriggerModeTimelineEvent[]>,
): boolean {
  const timeline = byTrigger.get(triggerId);
  if (!timeline || timeline.length === 0) return true;
  if (wasTriggerTradingActive(timeline, atMs)) return true;
  const hasRowAtOrBefore = timeline.some((ev) => ev.atMs <= atMs);
  if (hasRowAtOrBefore) return false;
  const everNotTrading = timeline.some((ev) => ev.paused || ev.runMode !== "trade");
  return !everNotTrading;
}

function bucketFromStatus(
  status: string,
  pnl: number,
  official?: WindowOutcome | null,
  side?: "up" | "down" | string,
): PlayOutcomeBucket {
  if (status === "sold") return pnl > 0 ? "green" : "red";
  if (
    (official === "up" || official === "down") &&
    (side === "up" || side === "down")
  ) {
    return side === official ? "blue" : "red";
  }
  if (status === "win") return "blue";
  if (status === "loss") return "red";
  return "none";
}

type TradeRow = {
  cardId: string;
  atMs: number;
  winStart: number;
  series: string;
  status: "sold" | "win" | "loss";
  pnl: number;
  card: NonNullable<TradingStatEvent["card"]>;
  event: TradingStatEvent | null;
};

function markersFromCard(
  card: NonNullable<TradingStatEvent["card"]>,
  status: string,
  pnl: number,
): SimMarker[] {
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

  const soldAt = Number(card.soldAt);
  if (status === "sold" && Number.isFinite(soldAt) && soldAt > 0) {
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
      profit: Number.isFinite(pnl) ? pnl : card.pl,
      total: card.sellProceeds,
      windowKey,
    });
  }

  return markers;
}

function tradeDotsFromCard(
  card: NonNullable<TradingStatEvent["card"]>,
  bucket: PlayOutcomeBucket,
): TradeDot[] {
  if (bucket === "none") return [];
  const buyAt = Number(card.buyAt);
  if (!Number.isFinite(buyAt) || buyAt <= 0) return [];
  const buyT = buyAt > 1e12 ? buyAt / 1000 : buyAt;
  const soldAt = Number(card.soldAt);
  const sellT =
    Number.isFinite(soldAt) && soldAt > 0 ? (soldAt > 1e12 ? soldAt / 1000 : soldAt) : undefined;
  return [
    {
      bucket,
      source: card.source === "trigger" || card.triggerId ? "trigger" : "phase",
      side: card.side === "down" ? "down" : "up",
      buyT,
      sellT,
    },
  ];
}

function cardToSnap(card: TradingPositionCard): NonNullable<TradingStatEvent["card"]> | null {
  if (card.status === "open") return null;
  return {
    windowKey: card.windowKey,
    series: card.series,
    side: card.side,
    shares: card.shares,
    buyPrice: card.buyPrice,
    buyCost: card.buyCost,
    buyAt: card.buyAt,
    status: card.status,
    confirmed: card.confirmed === true,
    ...(card.pl != null ? { pl: card.pl } : {}),
    ...(card.outcome ? { outcome: card.outcome } : {}),
    ...(card.asset ? { asset: card.asset } : {}),
    ...(card.conditionId ? { conditionId: card.conditionId } : {}),
    ...(card.slug ? { slug: card.slug } : {}),
    ...(card.source === "manual" || card.source === "auto" || card.source === "trigger"
      ? { source: card.source }
      : {}),
    ...(card.source !== "manual" && card.placementId ? { placementId: card.placementId } : {}),
    ...(card.triggerId ? { triggerId: card.triggerId } : {}),
    ...(card.triggerExitReason === "tp" || card.triggerExitReason === "sl"
      ? { triggerExitReason: card.triggerExitReason }
      : {}),
    ...(card.triggerMiss === true ? { triggerMiss: true } : {}),
    ...(card.sellPrice != null ? { sellPrice: card.sellPrice } : {}),
    ...(card.sellProceeds != null ? { sellProceeds: card.sellProceeds } : {}),
    ...(card.sellFees != null ? { sellFees: card.sellFees } : {}),
    ...(card.soldAt != null ? { soldAt: card.soldAt } : {}),
    ...(card.buyFees != null ? { buyFees: card.buyFees } : {}),
  };
}

/**
 * Build Open Replay payload for a Live Schedule hour cell (`hour:mon:14`).
 * Trade windows only — one row per window that has ledger/card fills for the
 * active calendar day. Chainlink optional (`recordingMissing` when absent).
 */
export async function buildLiveHourPlayPayload(
  userId: string,
  market: MarketDocument,
  placementId: string,
  options: {
    nowMs?: number;
    /** Settled position cards (RAM) — fills gaps not yet in Mongo events. */
    cards?: TradingPositionCard[];
    /** Prefer in-memory ledger when provided; else load from Mongo. */
    events?: TradingStatEvent[];
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
  const day = placement.day as ScheduleHourDayId;
  const startHour = placement.startHour;
  const series = market._id;
  const activeDayKey = activeLiveSlotDayKey(day, startHour, nowMs);

  const cutoffUtc = getLiveScheduleStatsCutoffUtcSec(new Date(nowMs));
  const listed = await listRecordedWindowsSince(cutoffUtc, series);
  const recordedByStart = new Map(
    listed
      .filter((w) => {
        const date = new Date(w.windowStart * 1000);
        return (
          UTC_DAY_TO_ID[date.getUTCDay()] === day && date.getUTCHours() === startHour
        );
      })
      .map((w) => [w.windowStart, w] as const),
  );

  const mongoEvents = options.events ?? (await listTradingStatEvents(userId, {}));
  const cards = Array.isArray(options.cards) ? options.cards : [];

  const triggerIds = new Set<string>();
  for (const event of mongoEvents) {
    const tid = typeof event.card?.triggerId === "string" ? event.card.triggerId.trim() : "";
    if (tid && event.card?.source !== "manual" && event.card?.source !== "auto") {
      triggerIds.add(tid);
    }
  }
  for (const card of cards) {
    const tid = typeof card.triggerId === "string" ? card.triggerId.trim() : "";
    if (tid && card.source !== "manual" && card.source !== "auto") triggerIds.add(tid);
  }
  const timelineEvents = triggerIds.size
    ? await listTriggerModeEvents(userId, [...triggerIds])
    : [];
  const byTrigger = groupTimelineByTrigger(timelineEvents);

  const seenCardIds = new Set<string>();
  const seenIdentities = new Set<string>();
  const rows: TradeRow[] = [];

  const identityOf = (conditionId?: string, asset?: string, buyAt?: number): string | null => {
    if (!conditionId || !asset || buyAt == null || !Number.isFinite(buyAt)) return null;
    return `${conditionId}|${asset}|${buyAt}`;
  };

  const tryPush = (row: TradeRow): void => {
    if (row.atMs < cutoffUtc * 1000) return;
    const slotDay = UTC_DAY_TO_ID[new Date(row.atMs).getUTCDay()] ?? "sun";
    if (slotDay !== day || new Date(row.atMs).getUTCHours() !== startHour) return;
    if (row.series && row.series !== series) return;

    const tid =
      typeof row.card.triggerId === "string" && row.card.triggerId.trim()
        ? row.card.triggerId.trim()
        : "";
    if (tid) {
      if (!shouldCountTriggerTrade(tid, row.atMs, byTrigger)) return;
    } else if (row.card.source === "trigger") {
      // Older Trigger fills with no triggerId — still count (same as hour stats).
    } else if (row.card.source !== "auto" && !row.card.placementId) {
      return;
    }

    if (seenCardIds.has(row.cardId)) return;
    const id = identityOf(row.card.conditionId, row.card.asset, row.card.buyAt);
    if (id) {
      if (seenIdentities.has(id)) return;
      seenIdentities.add(id);
    }
    seenCardIds.add(row.cardId);
    rows.push(row);
  };

  for (const card of cards) {
    if (card.status === "open") continue;
    if (!isLiveTradeSource(card.source, card.triggerId) && card.source !== "auto" && !card.placementId) {
      continue;
    }
    if (card.source === "manual") continue;
    const snap = cardToSnap(card);
    if (!snap) continue;
    const pl = Number(card.pl);
    if (!Number.isFinite(pl)) continue;
    if (card.status !== "sold" && card.status !== "win" && card.status !== "loss") continue;
    const atMs = triggerTradeWindowMs({ buyAt: card.buyAt, windowKey: card.windowKey });
    if (!Number.isFinite(atMs)) continue;
    tryPush({
      cardId: card.id,
      atMs,
      winStart: resolveWinStart(card.windowKey, atMs),
      series: String(card.series || series),
      status: card.status,
      pnl: pl,
      card: snap,
      event: null,
    });
  }

  for (const event of mongoEvents) {
    if (!isLiveTradeSource(event.card?.source, event.card?.triggerId)) {
      if (!(event.card?.source === "auto" || event.placementId || event.card?.placementId)) {
        continue;
      }
    }
    if (event.card?.source === "manual") continue;
    if (!event.card) continue;
    if (event.status !== "sold" && event.status !== "win" && event.status !== "loss") continue;
    const pl = Number(event.pnl);
    if (!Number.isFinite(pl)) continue;
    const atMs = triggerTradeWindowMs({
      buyAt: event.card.buyAt,
      windowKey: event.card.windowKey,
    });
    if (!Number.isFinite(atMs)) continue;
    tryPush({
      cardId: event.cardId,
      atMs,
      winStart: resolveWinStart(event.card.windowKey, atMs),
      series: String(event.card.series || series),
      status: event.status,
      pnl: pl,
      card: event.card,
      event,
    });
  }

  const dayRows = rows.filter((r) => utcDayKeyFromMs(r.atMs) === activeDayKey);

  const rowsByWindow = new Map<number, TradeRow[]>();
  for (const row of dayRows) {
    if (!Number.isFinite(row.winStart)) continue;
    const list = rowsByWindow.get(row.winStart) ?? [];
    list.push(row);
    rowsByWindow.set(row.winStart, list);
  }

  const tradeStarts = [...rowsByWindow.keys()].sort((a, b) => a - b);
  if (tradeStarts.length === 0) {
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
      windows: [],
    };
  }

  const presentStarts = options.resolveWindowsWithTicks
    ? await options.resolveWindowsWithTicks(tradeStarts)
    : await windowsHavingChainlinkTicks(market, tradeStarts);
  const tickSet = new Set(presentStarts);

  const windows: PlacementPlayWindowItem[] = [];
  for (const windowStart of tradeStarts) {
    const winRows = rowsByWindow.get(windowStart) ?? [];
    if (!winRows.length) continue;

    const meta = recordedByStart.get(windowStart);
    const windowEnd = meta?.windowEnd ?? windowStart + DEFAULT_WINDOW_SEC;
    // Live Open Replay requires official Gamma on the recording (same gate as Replay).
    const windowOutcome: WindowOutcome | undefined =
      meta?.windowOutcome === "up" || meta?.windowOutcome === "down"
        ? meta.windowOutcome
        : undefined;
    if (!windowOutcome) continue;

    const markers: SimMarker[] = [];
    let pnl = 0;
    let sold = false;
    const tradeDots: TradeDot[] = [];
    let bucket: PlayOutcomeBucket = "none";

    for (const row of winRows) {
      markers.push(...markersFromCard(row.card, row.status, row.pnl));
      pnl += row.pnl;
      if (row.status === "sold") sold = true;
      const b = bucketFromStatus(row.status, row.pnl, windowOutcome, row.card.side);
      tradeDots.push(...tradeDotsFromCard(row.card, b));
      if (bucket === "none" && b !== "none") bucket = b;
    }

    if (!tradeDots.length && !markers.length) continue;

    const hasTicks = tickSet.has(windowStart);
    const prevCloseAsset =
      meta?.prevCloseAsset != null && Number.isFinite(meta.prevCloseAsset)
        ? Number(meta.prevCloseAsset)
        : undefined;
    const finalPrice =
      meta?.assetPrice != null && Number.isFinite(meta.assetPrice)
        ? Number(meta.assetPrice)
        : undefined;

    windows.push({
      windowStart,
      windowEnd,
      windowOutcome,
      prevCloseAsset,
      ...recordingPtbFields(meta ?? {}),
      finalPrice,
      bucket,
      tradeDots,
      pnl,
      plLabel: sold ? "Trade" : "Settlement",
      sold,
      markers: markers.sort((a, b) => a.t - b.t),
      recordingMissing: !hasTicks,
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

function isDemoTriggerCard(card: TradingPositionCard, triggerId: string, series: string): boolean {
  if (!card || card.demo !== true) return false;
  if (String(card.triggerId || "").trim() !== triggerId) return false;
  if (card.source != null && card.source !== "trigger") return false;
  const cardSeries = String(card.series || "").trim();
  if (cardSeries && cardSeries !== series) return false;
  return true;
}

function demoCardToSnap(card: TradingPositionCard): NonNullable<TradingStatEvent["card"]> | null {
  if (card.status !== "open" && card.status !== "sold" && card.status !== "win" && card.status !== "loss") {
    return null;
  }
  return {
    windowKey: card.windowKey,
    series: card.series,
    side: card.side,
    shares: card.shares,
    buyPrice: card.buyPrice,
    buyCost: card.buyCost,
    buyAt: card.buyAt,
    status: card.status,
    confirmed: card.confirmed === true,
    ...(card.pl != null ? { pl: card.pl } : {}),
    ...(card.outcome ? { outcome: card.outcome } : {}),
    ...(card.asset ? { asset: card.asset } : {}),
    ...(card.conditionId ? { conditionId: card.conditionId } : {}),
    ...(card.slug ? { slug: card.slug } : {}),
    source: "trigger",
    ...(card.triggerId ? { triggerId: card.triggerId } : {}),
    ...(card.triggerExitReason === "tp" || card.triggerExitReason === "sl"
      ? { triggerExitReason: card.triggerExitReason }
      : {}),
    ...(card.triggerMiss === true ? { triggerMiss: true } : {}),
    ...(card.sellPrice != null ? { sellPrice: card.sellPrice } : {}),
    ...(card.sellProceeds != null ? { sellProceeds: card.sellProceeds } : {}),
    ...(card.sellFees != null ? { sellFees: card.sellFees } : {}),
    ...(card.soldAt != null ? { soldAt: card.soldAt } : {}),
    ...(card.buyFees != null ? { buyFees: card.buyFees } : {}),
  };
}

/**
 * Open Replay for Market Trigger Demo Positions: one window row per Demo fill
 * window for that trigger (Open + last-24h settled UI cards).
 */
export async function buildDemoTriggerPlayPayload(
  userId: string,
  market: MarketDocument,
  triggerId: string,
  options: {
    triggerTitle?: string;
    cards?: TradingPositionCard[];
    resolveWindowsWithTicks?: (windowStarts: number[]) => Promise<number[]>;
  } = {},
): Promise<PlacementPlayPayload> {
  const series = market._id;
  const tid = String(triggerId || "").trim();
  const title =
    typeof options.triggerTitle === "string" && options.triggerTitle.trim()
      ? options.triggerTitle.trim()
      : "Trigger";

  const empty: PlacementPlayPayload = {
    placementId: `demo-trigger:${tid}`,
    setupId: tid,
    title,
    day: "mon",
    startHour: 0,
    durationHours: 1,
    setup: triggerOnlyPhaseSetup(),
    latencyMs: 0,
    fillSuccessPct: 100,
    triggerOnly: true,
    windows: [],
  };

  if (!tid) return empty;

  const cards = (Array.isArray(options.cards) ? options.cards : []).filter((c) =>
    isDemoTriggerCard(c, tid, series),
  );
  if (cards.length === 0) return empty;

  const rowsByWindow = new Map<
    number,
    Array<{
      status: TradingPositionCard["status"];
      pnl: number;
      card: NonNullable<TradingStatEvent["card"]>;
    }>
  >();

  for (const card of cards) {
    const snap = demoCardToSnap(card);
    if (!snap) continue;
    const atMs = triggerTradeWindowMs({ buyAt: card.buyAt, windowKey: card.windowKey });
    if (!Number.isFinite(atMs)) continue;
    const winStart = resolveWinStart(card.windowKey, atMs);
    if (!Number.isFinite(winStart)) continue;
    const pl = Number(card.pl);
    const list = rowsByWindow.get(winStart) ?? [];
    list.push({
      status: card.status,
      pnl: Number.isFinite(pl) ? pl : 0,
      card: snap,
    });
    rowsByWindow.set(winStart, list);
  }

  const tradeStarts = [...rowsByWindow.keys()].sort((a, b) => a - b);
  if (tradeStarts.length === 0) return empty;

  const cutoffUtc = Math.min(...tradeStarts) - DEFAULT_WINDOW_SEC;
  const listed = await listRecordedWindowsSince(Math.max(0, cutoffUtc), series);
  const recordedByStart = new Map(listed.map((w) => [w.windowStart, w] as const));

  const presentStarts = options.resolveWindowsWithTicks
    ? await options.resolveWindowsWithTicks(tradeStarts)
    : await windowsHavingChainlinkTicks(market, tradeStarts);
  const tickSet = new Set(presentStarts);

  const windows: PlacementPlayWindowItem[] = [];
  for (const windowStart of tradeStarts) {
    const winRows = rowsByWindow.get(windowStart) ?? [];
    if (!winRows.length) continue;

    const meta = recordedByStart.get(windowStart);
    const windowEnd = meta?.windowEnd ?? windowStart + DEFAULT_WINDOW_SEC;
    const windowOutcome: WindowOutcome | undefined =
      meta?.windowOutcome === "up" || meta?.windowOutcome === "down"
        ? meta.windowOutcome
        : undefined;
    const markers: SimMarker[] = [];
    let pnl = 0;
    let sold = false;
    let anyOpen = false;
    const tradeDots: TradeDot[] = [];
    let bucket: PlayOutcomeBucket = "none";

    for (const row of winRows) {
      if (row.status === "open") {
        anyOpen = true;
        markers.push(...markersFromCard(row.card, "open", row.pnl));
        continue;
      }
      markers.push(...markersFromCard(row.card, row.status, row.pnl));
      pnl += row.pnl;
      if (row.status === "sold") sold = true;
      const b = bucketFromStatus(row.status, row.pnl, windowOutcome, row.card.side);
      tradeDots.push(...tradeDotsFromCard(row.card, b));
      if (bucket === "none" && b !== "none") bucket = b;
    }

    if (!markers.length) continue;

    const hasTicks = tickSet.has(windowStart);
    const prevCloseAsset =
      meta?.prevCloseAsset != null && Number.isFinite(meta.prevCloseAsset)
        ? Number(meta.prevCloseAsset)
        : undefined;
    const finalPrice =
      meta?.assetPrice != null && Number.isFinite(meta.assetPrice)
        ? Number(meta.assetPrice)
        : undefined;

    windows.push({
      windowStart,
      windowEnd,
      windowOutcome,
      prevCloseAsset,
      ...recordingPtbFields(meta ?? {}),
      finalPrice,
      bucket,
      tradeDots,
      pnl,
      plLabel: anyOpen && !sold && bucket === "none" ? "Open" : sold ? "Trade" : "Settlement",
      sold,
      markers: markers.sort((a, b) => a.t - b.t),
      recordingMissing: !hasTicks,
      predictionSide: null,
      predictionScore: null,
      predictionScores: [],
      predictionTriggers: [],
      predictionTriggeredAtMs: null,
      predictionSensitivitySec: null,
    });
  }

  windows.sort((a, b) => a.windowStart - b.windowStart);
  void userId;

  return {
    ...empty,
    title,
    windows,
  };
}
