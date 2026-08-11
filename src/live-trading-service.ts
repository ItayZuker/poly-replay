import {
  findActiveScheduleContext,
  getUtcScheduleClock,
  isScheduleContextActive,
  isSchedulePlacementElapsed,
  schedulePlacementSortKey,
  type ActiveScheduleContext,
} from "./schedule-active.js";
import { listSchedulePlacements } from "./db/schedule-placement-repository.js";
import {
  cancelOpenOrder,
  fetchOpenOrder,
  placeLimitGtdBuy,
  placeLimitGtdSell,
  placeMarketOrder,
  type MarketOrderType,
} from "./order-service.js";
import { fetchCurrentUpDownMarket } from "./market-pair.js";
import {
  getTradingClient,
  initTradingClient,
  isTradingClientReady,
  refreshCollateralBalance,
} from "./trading-client.js";
import { SimulatorEngine } from "./simulator-engine.js";
import { simulatorService, phaseSetupToSimSetup } from "./simulator-service.js";
import { logService } from "./log-service.js";
import {
  fetchClosedPositions,
  fetchUserPositions,
  fetchUserTrades,
  feeFromTradeUsdc,
  findClosedPosition,
  findPosition,
  findTrade,
  isValidSharePrice,
  isValidShareSize,
  type PolymarketClosedPosition,
  type PolymarketTrade,
} from "./polymarket-portfolio.js";
import { fetchOfficialWindowResolution } from "./official-window-resolution.js";
import {
  DEFAULT_CRYPTO_TAKER_FEE_PARAMS,
  estimateTakerFeeUsd,
  resolveTakerFeeParams,
} from "./taker-fee.js";
import {
  addActivatedPlacementId,
  ensureLiveCollectionStartedAt,
  getLiveCollectionStartedAt,
  getLiveResetAt,
  listActivatedPlacementIds,
  listTradingStatEvents,
  markLiveReset,
  setActivatedPlacementIds,
  upsertTradingStatEvent,
  type TradingStatEvent,
} from "./db/trading-session-memory-repository.js";
import {
  clearSettledPositionCardsInDb,
  deleteDemoPositionCardsForTrigger,
  deletePositionCardsByIds,
  filterPositionCardsForUi,
  listPositionCards,
  pruneExpiredSettledPositionCards,
  upsertPositionCard,
  upsertPositionCardsBulk,
} from "./db/position-card-repository.js";
import {
  closeFillAttempt,
  markFillAttemptSuccess,
  markFillAttemptTouched,
  recordFillAttempt,
  summarizeFillSuccess,
  type FillOrderKind,
  type FillSuccessStats,
} from "./db/fill-attempt-repository.js";
import { recordTriggerLiveStatsForSettledCard } from "./db/trigger-live-stats-repository.js";
import { listTriggerModeEvents } from "./db/trigger-mode-timeline-repository.js";
import {
  getUserTrigger,
  listUserTriggers,
  setTriggerLiveBuy,
  setTriggerLiveSell,
  setTriggerLiveUi,
  TRIGGER_LIVE_SELL_FLASH_MS,
  type TriggerLiveUiState,
} from "./db/user-trigger-repository.js";
import {
  classifyDemoStatKind,
  recordTriggerDemoStatsForSettledCard,
  rebuildTriggerDemoStatsFromCards,
} from "./db/trigger-demo-stats-repository.js";
import { getMongoClient, getMongoDbName } from "./db/mongo-client.js";
import { computeScheduleHourSlotStats } from "./schedule-hour-stats.js";
import { getRollingCutoffUtcSec } from "./heatmap-service.js";
import { clobMarketFeed } from "./clob-market-feed.js";
import {
  getUserById,
  listUsersForLiveTrading,
  resolveUserTradingForSeries,
  updateUserTrading,
} from "./db/user-repository.js";
import { DEFAULT_MARKET_SERIES } from "./collections.js";
import { isTradingExecutor } from "./trading-executor.js";
import { seriesMarketHub } from "./series-market-hub.js";
import {
  centsToPrice,
  describeGapFilterCancelReason,
  gapAllowsBuy,
  gapAllowsSecondSide,
  gtdExpirationUnix,
  phaseIndexForState,
  priceToCents,
  sellEnabledForPhase,
  shouldPreCancelGtdForNextPhase,
  SIDES_ORDER,
} from "./phase-config.js";
import type {
  LiveWindowState,
  SimMarker,
  SimPhaseConfig,
  SimQuoteLocks,
  SimSetup,
  TradingConfig,
  TradingPhaseSetup,
  TradingPositionCard,
  TradingPublicState,
  PlacementLiveStats,
  ScheduleHourSlotStats,
  FillSuccessPublicStats,
} from "./types.js";

interface RestingBuyOrder {
  orderId: string;
  side: "up" | "down";
  phaseIdx: number;
  sessionKey: string;
  shares: number;
  limitPrice: number;
  sizeMatched: number;
  tokenId?: string;
  conditionId?: string;
  slug?: string;
  cardId?: string;
  /** Schedule card that owned this order when it was placed. */
  placementId?: string;
  /** Limit was touched while live (fill-success GTD opportunity). */
  levelTouched?: boolean;
}

/** Resting GTD buy owned by a Market Trigger (zero-duration Price mode). */
interface TriggerRestingBuyOrder {
  orderId: string;
  triggerId: string;
  side: "up" | "down";
  sessionKey: string;
  shares: number;
  limitPrice: number;
  sizeMatched: number;
  sellOrderType: "FAK" | "FOK" | "GTD";
  takeProfitCents: number;
  tokenId?: string;
  conditionId?: string;
  slug?: string;
  /**
   * Cancel requested but CLOB order may still be live.
   * Keep in `triggerRestingBuys` until confirmed gone — never re-place while set.
   */
  cancelPending?: boolean;
  /** Cancel / confirm attempts while `cancelPending` (cap before force-drop). */
  cancelAttempts?: number;
}

export type TriggerGtdDesire = {
  triggerId: string;
  sides: Array<"up" | "down">;
  priceCents: number;
  shares: number;
  sellOrderType?: "FAK" | "FOK" | "GTD";
  takeProfitCents?: number;
  /** Optional title hint; server also resolves from Mongo by triggerId. */
  triggerName?: string;
};

/** Trigger GTD limit from 0.1¢ steps (0.5¢ → 0.005). Unlike phase centsToPrice (min 1¢). */
function triggerGtdLimitPrice(priceCents: number): number {
  const tenths = Math.round(Number(priceCents) * 10) / 10;
  const clamped = Math.max(0, Math.min(100, tenths));
  return Math.max(0.001, Math.min(0.999, clamped / 100));
}

export type TriggerGtdFill = {
  triggerId: string;
  side: "up" | "down";
  fillPrice: number;
  fillShares: number;
};

/** Live optimize (FAK) arm/hunt state — independent of SimulatorEngine. */
interface LiveFakBuyWatch {
  side: "up" | "down";
  phaseIdx: number;
  shares: number;
  triggerCents: number;
  armed: boolean;
  stallCents: number | null;
  stallTicks: number;
  prevAskCents: number | null;
  lastBookSampleCount: number;
}

/** Phase/GTD buy cancel still settling on the CLOB (race-fill harvest / retry). */
interface PendingBuyCancel {
  resting: {
    orderId: string;
    side: "up" | "down";
    sessionKey: string;
    shares: number;
    limitPrice: number;
    sizeMatched: number;
    phaseIdx?: number;
    tokenId?: string;
    conditionId?: string;
    slug?: string;
    cardId?: string;
    placementId?: string;
    levelTouched?: boolean;
  };
  reason: string;
  attempts: number;
  nextAttemptMs: number;
  kind: "phase";
}

/**
 * Unverified buy awaiting CLOB / positions confirmation.
 * Blocks further buys until resolved as filled or clearly unfilled.
 */
interface PendingBuyConfirm {
  sessionKey: string;
  side: "up" | "down";
  source: "manual" | "auto" | "trigger";
  reason: string;
  startedAtMs: number;
  nextCheckAtMs: number;
  orderId?: string;
  tokenId?: string;
  conditionId?: string;
  slug?: string;
  buyPhaseIdx?: number;
  /** Market Trigger id when source is trigger. */
  triggerId?: string;
  /** Optional size hint when confirming from a resting GTD. */
  sharesHint?: number;
  limitPriceHint?: number;
}

interface RestingSellOrder {
  orderId: string;
  side: "up" | "down";
  sessionKey: string;
  shares: number;
  limitPrice: number;
  sizeMatched: number;
  phaseIdx: number;
  /** Phase Auto Trade vs Prediction / Trigger Trade GTD sell. */
  source?: "phase" | "prediction" | "trigger";
  /** Market Trigger id when source is trigger. */
  triggerId?: string;
  /** Trigger exit path for this resting sell (TP). */
  triggerExitReason?: "tp" | "sl";
  /** Limit was touched while live (fill-success GTD opportunity). */
  levelTouched?: boolean;
  tokenId?: string;
  conditionId?: string;
  slug?: string;
  cardId?: string;
}

type SettledStatContribution = {
  green: number;
  red: number;
  blue: number;
  pnl: number;
  status: Exclude<TradingPositionCard["status"], "open">;
};

interface SidePosition {
  shares: number;
  avgPrice: number;
  cost: number;
  buyFees: number;
  cardId: string;
  asset?: string;
  conditionId?: string;
  /** Phase index where the position was bought (sell profit source). */
  buyPhaseIdx?: number;
}

type UpdateListener = () => void;

function sessionKey(state: LiveWindowState): string {
  return `${state.series || ""}:${state.windowStart || ""}`;
}

function contributionFromCard(card: TradingPositionCard): SettledStatContribution | null {
  if (card.status === "open") return null;
  const pl = Number(card.pl);
  if (!Number.isFinite(pl)) return null;

  let green = 0;
  let red = 0;
  let blue = 0;
  let status = card.status;
  if (card.status === "sold") {
    if (pl > 0) green = 1;
    else red = 1;
  } else if (card.status === "win" || card.status === "loss") {
    // Never trust a stale status that disagrees with settled P/L.
    if (pl > 1e-9) {
      blue = 1;
      status = "win";
    } else {
      red = 1;
      status = "loss";
    }
  } else {
    return null;
  }
  return { green, red, blue, pnl: pl, status };
}

function eventStatContribution(event: TradingStatEvent): SettledStatContribution | null {
  if (!isConfirmedStatEvent(event)) return null;
  const pl = Number(event.pnl);
  if (!Number.isFinite(pl)) return null;

  let green = 0;
  let red = 0;
  let blue = 0;
  let status = event.status;
  if (event.status === "sold") {
    if (pl > 0) green = 1;
    else red = 1;
  } else if (event.status === "win" || event.status === "loss") {
    if (pl > 1e-9) {
      blue = 1;
      status = "win";
    } else {
      red = 1;
      status = "loss";
    }
  } else {
    return null;
  }
  return { green, red, blue, pnl: pl, status };
}

function confirmedContributionFromCard(
  card: TradingPositionCard,
): SettledStatContribution | null {
  if (card.confirmed !== true) return null;
  return contributionFromCard(card);
}

function isConfirmedStatEvent(event: TradingStatEvent): boolean {
  // Older events may predate card snapshots. Only reject events explicitly saved as provisional.
  return event.card?.confirmed !== false;
}

function cardStatIdentity(
  card: Pick<
    TradingPositionCard,
    "conditionId" | "asset" | "buyAt"
  >,
): string | null {
  if (!card.conditionId || !card.asset || !Number.isFinite(card.buyAt)) return null;
  return `${card.conditionId}|${card.asset}|${card.buyAt}`;
}

function eventStatIdentity(event: TradingStatEvent): string | null {
  return event.card ? cardStatIdentity(event.card) : null;
}

/** Parse market window key to unix seconds (`1784536500` or `btc-5m:1784536500`). */
function windowKeyUnixSec(windowKey: string | undefined | null): number {
  if (windowKey == null || windowKey === "") return NaN;
  const raw = String(windowKey).trim();
  const colon = raw.lastIndexOf(":");
  const tail = colon >= 0 ? raw.slice(colon + 1) : raw;
  const n = Number(tail);
  if (Number.isFinite(n) && n > 0) {
    // ms timestamps are >> 1e12
    return n > 1e12 ? n / 1000 : n;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms / 1000 : NaN;
}

/** Series prefix of `series:windowStart` → market window length in seconds. */
function windowDurationSecFromKey(windowKey: string | undefined | null): number {
  const series = String(windowKey || "")
    .split(":")[0]
    .toLowerCase();
  if (series.includes("15m")) return 900;
  if (series.includes("1h") || series.includes("60m")) return 3600;
  if (series.includes("4h")) return 14_400;
  return 300; // default 5m up/down
}

/** Hard Gamma poll for held cards: 20 minutes after window end (matches recorder). */
const HELD_GAMMA_HARD_POLL_MS = 20 * 60 * 1000;
const CONFIRM_HARD_INTERVAL_MS = 2_000;
const CONFIRM_LIGHT_INTERVAL_MS = 30_000;

/** UTC ISO week key (YYYY-Www) — groups one weekly “run” of a schedule card. */
function utcIsoWeekKey(unixSec: number): string {
  const date = new Date(unixSec * 1000);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function totalTradeFees(card: Pick<TradingPositionCard, "buyFees" | "sellFees">): number {
  return (card.buyFees ?? 0) + (card.sellFees ?? 0);
}

/** Gross Polymarket position P/L minus estimated taker fees (wallet-closer). */
function feeAwarePlFromGross(
  grossPl: number,
  card: Pick<TradingPositionCard, "buyFees" | "sellFees">,
): number {
  return grossPl - totalTradeFees(card);
}

function feeAwarePlHeld(card: TradingPositionCard, won: boolean): number {
  const payout = won ? card.shares : 0;
  return payout - card.buyCost - (card.buyFees ?? 0);
}

function feeAwarePlSold(card: TradingPositionCard): number {
  const proceeds = Number(card.sellProceeds ?? 0);
  return proceeds - (card.sellFees ?? 0) - card.buyCost - (card.buyFees ?? 0);
}

async function estimateLiveTakerFee(
  userId: string,
  tokenId: string | undefined,
  shares: number,
  price: number,
): Promise<number> {
  if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(price) || price <= 0 || price >= 1) {
    return 0;
  }
  const client = getTradingClient(userId);
  const params =
    tokenId && client
      ? await resolveTakerFeeParams(client, tokenId)
      : DEFAULT_CRYPTO_TAKER_FEE_PARAMS;
  return estimateTakerFeeUsd(shares, price, params);
}

/** Prefer exact fee from trade usdcSize; otherwise estimate from CLOB fee curve. */
async function resolveTradeFeeUsd(
  userId: string,
  side: "BUY" | "SELL",
  tokenId: string | undefined,
  shares: number,
  price: number,
  trade?: Pick<PolymarketTrade, "usdcSize"> | null,
): Promise<number> {
  const exact = feeFromTradeUsdc(side, shares, price, trade?.usdcSize);
  if (exact != null) return exact;
  return estimateLiveTakerFee(userId, tokenId, shares, price);
}

let loggedNonExecutorSkip = false;
function logNonExecutorSkipOnce(): void {
  if (loggedNonExecutorSkip) return;
  loggedNonExecutorSkip = true;
  logService.warn(
    "trading",
    "TRADING_EXECUTOR is not set — live order placement disabled in this process",
  );
}

function eventFingerprint(
  event: Pick<TradingStatEvent, "status" | "green" | "red" | "blue" | "pnl" | "placementId" | "card">,
): string {
  const card = event.card;
  return [
    event.status,
    event.green,
    event.red,
    event.blue,
    event.pnl,
    event.placementId ?? "",
    card?.shares ?? "",
    card?.buyPrice ?? "",
    card?.pl ?? "",
    card?.buyFees ?? "",
    card?.sellFees ?? "",
    card?.confirmed ? 1 : 0,
    card?.source ?? "",
  ].join("|");
}

function eventSettledMs(event: TradingStatEvent): number {
  const at = Date.parse(event.settledAt);
  return Number.isFinite(at) ? at : NaN;
}

/** Prefer root placementId; fall back to card snapshot (older Mongo rows). */
function eventPlacementId(event: TradingStatEvent): string | undefined {
  return event.placementId || event.card?.placementId || undefined;
}

/** Best clock for attributing a settled trade to a schedule slot (buy time, not settle). */
function eventAttributionMs(event: TradingStatEvent): number {
  const buyAt = event.card?.buyAt;
  if (buyAt != null && Number.isFinite(buyAt)) {
    return buyAt > 1e12 ? buyAt : buyAt * 1000;
  }
  return eventSettledMs(event);
}

function cardSettledMs(card: TradingPositionCard): number {
  const sec = card.soldAt ?? card.buyAt;
  if (sec == null || !Number.isFinite(sec)) return NaN;
  return sec * 1000;
}

function isManualTradeCard(
  card: Pick<TradingPositionCard, "source" | "placementId"> | null | undefined,
): boolean {
  return card?.source === "manual";
}

function isManualStatEvent(event: TradingStatEvent): boolean {
  return event.card?.source === "manual";
}

/** Manual trades never belong on a schedule placement. */
function stripManualScheduleAttribution(card: TradingPositionCard): void {
  if (card.source !== "manual") return;
  if (card.placementId) delete card.placementId;
}

function cardSnapshotFromPosition(card: TradingPositionCard): TradingStatEvent["card"] {
  if (card.status === "open") return undefined;
  const snap: NonNullable<TradingStatEvent["card"]> = {
    windowKey: card.windowKey,
    series: card.series,
    side: card.side,
    shares: card.shares,
    buyPrice: card.buyPrice,
    buyCost: card.buyCost,
    buyAt: card.buyAt,
    status: card.status,
    confirmed: card.confirmed === true,
  };
  if (card.pl != null) snap.pl = card.pl;
  if (card.outcome) snap.outcome = card.outcome;
  if (card.asset) snap.asset = card.asset;
  if (card.conditionId) snap.conditionId = card.conditionId;
  if (card.slug) snap.slug = card.slug;
  if (card.source === "manual" || card.source === "auto" || card.source === "trigger") {
    snap.source = card.source;
  }
  // Manual wins/losses must not carry a schedule placement id into stats.
  if (card.source !== "manual" && card.placementId) snap.placementId = card.placementId;
  if (card.triggerId) snap.triggerId = card.triggerId;
  if (typeof card.triggerName === "string" && card.triggerName.trim()) {
    snap.triggerName = card.triggerName.trim();
  }
  if (card.triggerExitReason === "tp" || card.triggerExitReason === "sl") {
    snap.triggerExitReason = card.triggerExitReason;
  }
  if (card.triggerMiss === true) snap.triggerMiss = true;
  if (card.demo === true) snap.demo = true;
  if (card.buyFees != null) snap.buyFees = card.buyFees;
  if (card.sellPrice != null) snap.sellPrice = card.sellPrice;
  if (card.sellProceeds != null) snap.sellProceeds = card.sellProceeds;
  if (card.sellFees != null) snap.sellFees = card.sellFees;
  if (card.soldAt != null) snap.soldAt = card.soldAt;
  return snap;
}

function positionCardFromEvent(event: TradingStatEvent): TradingPositionCard | null {
  const snap = event.card;
  if (!snap) return null;
  if (snap.status === "open") return null;
  const card: TradingPositionCard = {
    id: event.cardId,
    windowKey: snap.windowKey,
    series: snap.series,
    side: snap.side,
    shares: snap.shares,
    buyPrice: snap.buyPrice,
    buyCost: snap.buyCost,
    buyAt: snap.buyAt,
    status: snap.status,
    confirmed: snap.confirmed === true,
  };
  if (snap.pl != null) card.pl = snap.pl;
  else card.pl = event.pnl;
  if (snap.outcome) card.outcome = snap.outcome;
  if (snap.asset) card.asset = snap.asset;
  if (snap.conditionId) card.conditionId = snap.conditionId;
  if (snap.slug) card.slug = snap.slug;
  if (snap.buyFees != null) card.buyFees = snap.buyFees;
  if (snap.source === "manual" || snap.source === "auto" || snap.source === "trigger") {
    card.source = snap.source;
  }
  if (!isManualTradeCard(card) && (snap.placementId || event.placementId)) {
    card.placementId = snap.placementId ?? event.placementId;
  }
  if (typeof snap.triggerId === "string" && snap.triggerId.trim()) {
    card.triggerId = snap.triggerId.trim();
  }
  if (typeof snap.triggerName === "string" && snap.triggerName.trim()) {
    card.triggerName = snap.triggerName.trim();
  }
  if (snap.triggerExitReason === "tp" || snap.triggerExitReason === "sl") {
    card.triggerExitReason = snap.triggerExitReason;
  }
  if (snap.triggerMiss === true) card.triggerMiss = true;
  if (snap.demo === true) card.demo = true;
  if (snap.sellPrice != null) card.sellPrice = snap.sellPrice;
  if (snap.sellProceeds != null) card.sellProceeds = snap.sellProceeds;
  if (snap.sellFees != null) card.sellFees = snap.sellFees;
  if (snap.soldAt != null) card.soldAt = snap.soldAt;
  stripManualScheduleAttribution(card);
  return card;
}

function emptyQuoteLocks(): SimQuoteLocks {
  return { upBuy: [], upSell: [], downBuy: [], downSell: [] };
}

/** Quiet period after gap-filter cancel before placing another resting GTD buy. */
const GTD_FILTER_REPRESS_MS = 2500;
/** Quiet period after sell balance/allowance reject (tokens not credited yet). */
const GTD_SELL_BALANCE_REPRESS_MS = 2500;
/** While a buy is pending confirmation, poll CLOB/positions on this cadence. */
const PENDING_BUY_CONFIRM_POLL_MS = 2500;
function isDemoPositionCard(card: Pick<TradingPositionCard, "demo" | "id">): boolean {
  return card.demo === true || String(card.id || "").startsWith("demo:");
}

/** Positions UI: keep Open + settled from the last 24h. */
function trimPositionCardsForUi(cards: TradingPositionCard[]): TradingPositionCard[] {
  return filterPositionCardsForUi(cards).sort((a, b) => (b.buyAt ?? 0) - (a.buyAt ?? 0));
}

function isRoutineGtdCancelReason(reason: string): boolean {
  return reason.startsWith("gap filter");
}

function emptyFillSuccessStats(cutoffUtc = getRollingCutoffUtcSec()): FillSuccessStats {
  const emptyKind = { attempts: 0, successes: 0, ratePct: null as number | null };
  return {
    attempts: 0,
    successes: 0,
    ratePct: null,
    cutoffUtc,
    byKind: { FAK: { ...emptyKind }, FOK: { ...emptyKind }, GTD: { ...emptyKind } },
  };
}

/** True when the book/trade reached a resting GTD limit (opportunity to fill). */
function gtdLimitTouched(
  state: LiveWindowState,
  side: "up" | "down",
  leg: "buy" | "sell",
  limitPrice: number,
  tokenId?: string,
): boolean {
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) return false;
  const ask = side === "up" ? state.yesAsk : state.noAsk;
  const bid = side === "up" ? state.yesBid : state.noBid;
  if (leg === "buy") {
    if (ask != null && ask <= limitPrice + 1e-9) return true;
  } else if (bid != null && bid >= limitPrice - 1e-9) {
    return true;
  }
  const id = String(tokenId ?? "").trim();
  if (!id) return false;
  const last = clobMarketFeed.getCachedMarketInfo(id)?.lastTradePrice;
  if (last == null || !Number.isFinite(last)) return false;
  return leg === "buy" ? last <= limitPrice + 1e-9 : last >= limitPrice - 1e-9;
}

function isBalanceAllowanceError(err: string): boolean {
  return /not enough balance|allowance/i.test(err);
}

function newCardId(): string {
  return `pos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeManualOrderType(raw: unknown): "FAK" | "FOK" {
  return raw === "FAK" ? "FAK" : "FOK";
}

function normalizePredictionSellOrderType(raw: unknown): "FAK" | "FOK" | "GTD" {
  if (raw === "FAK" || raw === "FOK" || raw === "GTD") return raw;
  return "FOK";
}

function defaultTradingConfig(): TradingConfig {
  return {
    autoTrade: false,
    useSchedule: false,
    startTrading: false,
    manualShares: 10,
    manualOrderUnit: "shares",
    manualBuyOrderType: "FOK",
    manualSellOrderType: "FOK",
    manipulationDetector: false,
    predictionTrade: false,
    predictionShares: 10,
    predictionBuyOrderType: "FOK",
    predictionSellOrderType: "FOK",
    manipulationSensitivitySec: 5,
    predictionMaxQuoteCents: 90,
    predictionMinQuoteCents: 70,
    predictionShiftCents: 5,
    predictionRiseCents: 5,
    manipulationAreaStart: 0,
    manipulationAreaEnd: 1,
    predictionRightCount: 0,
    predictionWrongCount: 0,
  };
}

function normalizePredictionCount(raw: unknown): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(1_000_000, n) : 0;
}

function normalizePredictionMaxQuoteCents(raw: unknown, fallback = 90): number {
  const n = Math.round(Number(raw));
  return Math.max(1, Math.min(99, Number.isFinite(n) ? n : fallback));
}

function normalizePredictionMinQuoteCents(raw: unknown, fallback = 70): number {
  const n = Math.round(Number(raw));
  return Math.max(1, Math.min(99, Number.isFinite(n) ? n : fallback));
}

function normalizePredictionQuoteBand(
  minRaw: unknown,
  maxRaw: unknown,
  fallbacks: { min?: number; max?: number } = {},
): { predictionMinQuoteCents: number; predictionMaxQuoteCents: number } {
  const predictionMaxQuoteCents = normalizePredictionMaxQuoteCents(
    maxRaw,
    fallbacks.max ?? 90,
  );
  let predictionMinQuoteCents = normalizePredictionMinQuoteCents(
    minRaw,
    fallbacks.min ?? 70,
  );
  if (predictionMinQuoteCents > predictionMaxQuoteCents) {
    predictionMinQuoteCents = predictionMaxQuoteCents;
  }
  return { predictionMinQuoteCents, predictionMaxQuoteCents };
}

function normalizePredictionShiftCents(raw: unknown, fallback = 5): number {
  const n = Math.round(Number(raw));
  return Math.max(1, Math.min(50, Number.isFinite(n) ? n : fallback));
}

function normalizePredictionRiseCents(raw: unknown, fallback = 5): number {
  const n = Math.round(Number(raw));
  return Math.max(1, Math.min(50, Number.isFinite(n) ? n : fallback));
}

function normalizeManipulationArea(startRaw: unknown, endRaw: unknown): {
  manipulationAreaStart: number;
  manipulationAreaEnd: number;
} {
  let start = Number(startRaw);
  let end = Number(endRaw);
  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(end)) end = 1;
  start = Math.max(0, Math.min(1, start));
  end = Math.max(0, Math.min(1, end));
  const minSpan = 0.02;
  if (end - start < minSpan) {
    if (start > 1 - minSpan) {
      start = 1 - minSpan;
      end = 1;
    } else {
      end = Math.min(1, start + minSpan);
    }
  }
  return { manipulationAreaStart: start, manipulationAreaEnd: end };
}

function normalizeTradingConfig(
  raw: Partial<TradingConfig> | null | undefined,
): TradingConfig {
  const base = defaultTradingConfig();
  if (!raw || typeof raw !== "object") return base;
  const unit = raw.manualOrderUnit === "usdc" ? "usdc" : "shares";
  const amountRaw = Number(raw.manualShares);
  const amount =
    unit === "usdc"
      ? Math.max(0.01, Math.min(100000, Math.round((Number.isFinite(amountRaw) ? amountRaw : 10) * 100) / 100))
      : Math.max(1, Math.min(100000, Math.floor(Number.isFinite(amountRaw) ? amountRaw : 10) || 10));
  const sensRaw = Number(raw.manipulationSensitivitySec);
  const manipulationSensitivitySec = Math.max(
    1,
    Math.min(120, Math.round(Number.isFinite(sensRaw) ? sensRaw : base.manipulationSensitivitySec)),
  );
  const quotes = normalizePredictionQuoteBand(
    raw.predictionMinQuoteCents,
    raw.predictionMaxQuoteCents,
    {
      min: base.predictionMinQuoteCents,
      max: base.predictionMaxQuoteCents,
    },
  );
  const predictionShiftCents = normalizePredictionShiftCents(
    raw.predictionShiftCents,
    base.predictionShiftCents,
  );
  const predictionRiseCents = normalizePredictionRiseCents(
    raw.predictionRiseCents,
    base.predictionRiseCents,
  );
  const area = normalizeManipulationArea(
    raw.manipulationAreaStart ?? base.manipulationAreaStart,
    raw.manipulationAreaEnd ?? base.manipulationAreaEnd,
  );
  const predSharesRaw = Number(raw.predictionShares);
  const predictionShares = Math.max(
    1,
    Math.min(100000, Math.floor(Number.isFinite(predSharesRaw) ? predSharesRaw : 10) || 10),
  );
  const next: TradingConfig = {
    autoTrade: Boolean(raw.autoTrade),
    useSchedule: Boolean(raw.useSchedule),
    startTrading: Boolean(raw.startTrading),
    manualShares: amount,
    manualOrderUnit: unit,
    manualBuyOrderType: normalizeManualOrderType(raw.manualBuyOrderType),
    manualSellOrderType: normalizeManualOrderType(raw.manualSellOrderType),
    manipulationDetector: Boolean(raw.manipulationDetector),
    // Live Prediction Trade removed — Trigger cards only.
    predictionTrade: false,
    predictionShares,
    predictionBuyOrderType: normalizeManualOrderType(raw.predictionBuyOrderType),
    predictionSellOrderType: normalizePredictionSellOrderType(raw.predictionSellOrderType),
    manipulationSensitivitySec,
    ...quotes,
    predictionShiftCents,
    predictionRiseCents,
    ...area,
    predictionRightCount: normalizePredictionCount(raw.predictionRightCount),
    predictionWrongCount: normalizePredictionCount(raw.predictionWrongCount),
  };
  if (!next.autoTrade) {
    next.useSchedule = false;
  }
  next.predictionTrade = false;
  return next;
}

/** Live trading — Trigger Trade orders + portfolio / schedule stats. */
export class LiveTradingService {
  private config: TradingConfig = defaultTradingConfig();
  private persistChain: Promise<void> = Promise.resolve();
  private statsPersistChain: Promise<void> = Promise.resolve();
  private positionCardsPersistChain: Promise<void> = Promise.resolve();
  /** Trigger BUY/SELL highlight cache (Mongo triggers.liveUi) for SSE. */
  private triggerLiveUiById = new Map<string, TriggerLiveUiState>();
  private triggerLiveSellClearTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private positions: { up: SidePosition | null; down: SidePosition | null } = {
    up: null,
    down: null,
  };

  private quoteLocks: SimQuoteLocks = emptyQuoteLocks();
  private markers: SimMarker[] = [];
  private positionCards: TradingPositionCard[] = [];
  /** Placement ids that have had schedule auto-trades this session (for live card stats). */
  private knownPlacementIds = new Set<string>();
  /**
   * Settled contributions for schedule card stats + Live header (filtered by liveResetAtMs).
   * Keyed by cardId — survives restart and header Live reset; cleared per placement on remove.
   */
  private liveStatLedger = new Map<string, TradingStatEvent>();
  /** Last written fingerprints — skip identical Mongo upserts. */
  private lastPersistedStatFingerprint = new Map<string, string>();
  /** True after the first successful Mongo ledger hydrate for this process. */
  private statsHydrated = false;
  /** Header "Live" range cut — events at/before this ms are excluded from session totals only. */
  private liveResetAtMs: number | null = null;
  /** Schedule live collection arm time — slots before this stay pre-run (dashes). */
  private liveCollectionStartedAtMs: number | null = null;
  private sessionKey: string | null = null;
  private mirroredMarkerCount = 0;
  private orderInFlight = false;
  /** True across the complete manual BUY attempt. */
  private manualBuyPending = false;
  /** Successful manual BUY suppresses all phase buys until this window rolls. */
  private manualBuyOverrideWindowKey: string | null = null;
  /**
   * While a Prediction Trade position is open, suppress phase Auto Trade buys
   * for this window (open race with phase — first buy wins until sell).
   * Cleared on Prediction sell or window roll; then both may race again.
   */
  private predictionTradeHoldWindowKey: string | null = null;
  /**
   * Ambiguous / unverified buy response — block further buys for this window
   * until we adopt an on-chain position or the window rolls.
   */
  private buyBlockedWindowKey: string | null = null;
  /** Resting GTD limit buy for the active non-optimize phase. */
  /** Resting GTD buys by side (First/Both may have both). */
  private restingBuys = new Map<"up" | "down", RestingBuyOrder>();
  /**
   * Trigger Trade GTD buys (Duration 0 + Price). Keyed by `${triggerId}:${side}`.
   * Separate from phase restingBuys so First dual-rest does not collide.
   */
  private triggerRestingBuys = new Map<string, TriggerRestingBuyOrder>();
  /**
   * After a Trigger GTD buy fill, latch that triggerId → sessionKey until the
   * position is confirmed sold (or the window rolls). Blocks further rests on
   * either side while holding; sibling + other-trigger rests cancel on first fill.
   * Trade race: first fill owns the window until sell / roll (see predictionTradeHoldWindowKey).
   */
  private triggerGtdHoldSessionById = new Map<string, string>();
  /**
   * After a Trigger GTD place is accepted this window (orderId returned), never
   * place again for that triggerId+side until the window rolls.
   * No-gap GTD may accept one rest per side (UP + DOWN); first fill cancels the sibling.
   * Key: `${triggerId}:${side}` → sessionKey. Failed places do not latch (retry allowed).
   */
  private triggerGtdPlacedSessionById = new Map<string, string>();
  /** Serialize Trigger GTD sync so concurrent client posts cannot double-place. */
  private triggerGtdSyncChain: Promise<void> = Promise.resolve();
  /** After gap-filter cancel, delay before placing another resting GTD buy. */
  private gtdBuyRepressUntilMs = 0;
  /** Last phase index for clearing buy repress across phase boundaries. */
  private lastGtdBuyPhaseIdx = -1;
  /** After a rejected phase GTD buy (e.g. expiration), skip further places this window. */
  private gtdBuyBlockedWindowKey: string | null = null;
  /** Live FAK optimize watch (only while live-armed; sim is not ticked). */
  private liveFakWatch: LiveFakBuyWatch | null = null;
  /** Resting phase GTD buys awaiting confirmed CLOB cancel (and possible race fill). */
  private pendingBuyCancels: PendingBuyCancel[] = [];
  /** PTB-crossing abort state for live (replaces sim abort while armed). */
  private liveAbortedBuyPhases = new Set<number>();
  private livePendingPhaseAborts = new Map<number, number>();
  private liveCompletedPhaseAbortCancellations = new Set<number>();
  private liveTrackedPhaseIdx = -1;
  private livePhaseCrossingBaseline = 0;
  private liveLastPtbCrossings = 0;
  /** Resting GTD maker sell for the open auto/manual-managed position. */
  private restingSell: RestingSellOrder | null = null;
  /** After a rejected GTD sell (e.g. expiration), skip further sell places this window. */
  private gtdSellBlockedWindowKey: string | null = null;
  /** After balance/allowance reject, delay before retrying GTD sell. */
  private gtdSellRepressUntilMs = 0;
  /** Serialize CLOB + Chainlink tick handlers for this user. */
  private tickQueue: Promise<void> = Promise.resolve();
  /** Unverified buy — poll until filled or clearly unfilled; blocks new buys. */
  private pendingBuyConfirm: PendingBuyConfirm | null = null;
  /** Exponential backoff after Data API / CLOB 429s while resolving pending buys (ms). */
  private pendingBuyConfirmBackoffMs = 0;
  private scheduleContext: ActiveScheduleContext | null = null;
  private scheduleContextFetchedAt = 0;
  private activePhaseSetup: TradingPhaseSetup | null = null;
  private readonly autoEngine = new SimulatorEngine();
  private readonly listeners = new Set<UpdateListener>();
  private confirmLoopTimer: ReturnType<typeof setTimeout> | null = null;
  private confirmInFlight = false;
  /** Confirmed win/loss cards already re-checked against Polymarket this process. */
  private settlementRecheckedIds = new Set<string>();
  /** Market this engine's config/schedule/resting orders are bound to. */
  private boundSeries: string = DEFAULT_MARKET_SERIES;
  /** Rolling ~7-day CLOB fill success (buys + sells) by order kind. */
  private fillSuccessStats: FillSuccessStats = emptyFillSuccessStats();

  constructor(private readonly userId: string) {}

  getBoundSeries(): string {
    return this.boundSeries;
  }

  getUserId(): string {
    return this.userId;
  }

  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private applyFillSuccessStats(stats: FillSuccessStats): void {
    this.fillSuccessStats = stats;
    this.notify();
  }

  /** Record a CLOB place/fire attempt; success=true when any size already matched. */
  private async noteFillAttempt(input: {
    leg: "buy" | "sell";
    side?: "up" | "down";
    series?: string;
    orderId?: string;
    orderKind: FillOrderKind;
    limitPrice?: number;
    countable?: boolean;
    touched?: boolean;
    success?: boolean;
  }): Promise<void> {
    if (!isTradingExecutor()) return;
    try {
      const stats = await recordFillAttempt({
        userId: this.userId,
        leg: input.leg,
        side: input.side,
        series: input.series ?? this.boundSeries,
        orderId: input.orderId,
        orderKind: input.orderKind,
        limitPrice: input.limitPrice,
        countable: input.countable,
        touched: input.touched,
        success: input.success,
      });
      this.applyFillSuccessStats(stats);
    } catch (err) {
      logService.warn("trading", `Failed to record fill attempt: ${String(err)}`);
    }
  }

  /** Mark a previously recorded attempt successful once any size matches. */
  private async noteFillSuccess(orderId: string | undefined): Promise<void> {
    if (!isTradingExecutor()) return;
    const id = String(orderId ?? "").trim();
    if (!id) return;
    try {
      const stats = await markFillAttemptSuccess(this.userId, id);
      this.applyFillSuccessStats(stats);
    } catch (err) {
      logService.warn("trading", `Failed to mark fill success: ${String(err)}`);
    }
  }

  /** GTD: book/trade reached the limit while the order was live. */
  private async noteFillTouched(orderId: string | undefined): Promise<void> {
    if (!isTradingExecutor()) return;
    const id = String(orderId ?? "").trim();
    if (!id) return;
    try {
      const stats = await markFillAttemptTouched(this.userId, id);
      this.applyFillSuccessStats(stats);
    } catch (err) {
      logService.warn("trading", `Failed to mark fill touch: ${String(err)}`);
    }
  }

  /**
   * GTD left the book without a further fill. Countable only if touched while live.
   */
  private async noteFillClose(orderId: string | undefined): Promise<void> {
    if (!isTradingExecutor()) return;
    const id = String(orderId ?? "").trim();
    if (!id) return;
    try {
      const stats = await closeFillAttempt(this.userId, id);
      this.applyFillSuccessStats(stats);
    } catch (err) {
      logService.warn("trading", `Failed to close fill attempt: ${String(err)}`);
    }
  }

  private async maybeNoteGtdTouch(
    state: LiveWindowState,
    resting: {
      orderId: string;
      side: "up" | "down";
      limitPrice: number;
      tokenId?: string;
      levelTouched?: boolean;
    },
    leg: "buy" | "sell",
  ): Promise<boolean> {
    if (resting.levelTouched) return true;
    if (
      !gtdLimitTouched(state, resting.side, leg, resting.limitPrice, resting.tokenId)
    ) {
      return false;
    }
    resting.levelTouched = true;
    await this.noteFillTouched(resting.orderId);
    return true;
  }

  getFillSuccessStats(): FillSuccessPublicStats {
    const stats = this.fillSuccessStats?.byKind
      ? this.fillSuccessStats
      : emptyFillSuccessStats(this.fillSuccessStats?.cutoffUtc);
    return {
      ...stats,
      byKind: {
        FAK: { ...stats.byKind.FAK },
        FOK: { ...stats.byKind.FOK },
        GTD: { ...stats.byKind.GTD },
      },
    };
  }

  getConfig(): TradingConfig {
    return { ...this.config };
  }

  async loadPersistedConfig(options?: {
    hydrateStats?: boolean;
    series?: string;
  }): Promise<TradingConfig> {
    const series =
      String(options?.series ?? this.boundSeries ?? DEFAULT_MARKET_SERIES).trim() ||
      DEFAULT_MARKET_SERIES;
    this.boundSeries = series;
    try {
      const user = await getUserById(this.userId);
      if (!user) {
        throw new Error(`User not found: ${this.userId}`);
      }
      this.config = resolveUserTradingForSeries(user, series);
    } catch (err) {
      logService.warn("trading", `Failed to load trading config: ${String(err)}`);
      this.config = defaultTradingConfig();
    }
    // Always hydrate once so schedule cards aren't empty after deploy; later polls can skip.
    const skipHydrate = options?.hydrateStats === false && this.statsHydrated;
    if (!skipHydrate) {
      await this.hydrateLiveStatsFromMongo();
    }
    return this.getConfig();
  }

  /** Reload stats ledger + Positions UI cards from Mongo (after boot). */
  async hydrateLiveStatsFromMongo(): Promise<void> {
    try {
      const resetAt = await getLiveResetAt(this.userId);
      const resetMs = resetAt ? Date.parse(resetAt) : NaN;
      this.liveResetAtMs = Number.isFinite(resetMs) ? resetMs : null;

      const collectionStartedAt = await getLiveCollectionStartedAt(this.userId);
      const collectionMs = collectionStartedAt ? Date.parse(collectionStartedAt) : NaN;
      this.liveCollectionStartedAtMs = Number.isFinite(collectionMs) ? collectionMs : null;

      try {
        this.fillSuccessStats = await summarizeFillSuccess(this.userId);
      } catch (err) {
        logService.warn("trading", `Failed to load fill success stats: ${String(err)}`);
      }

      const events = await listTradingStatEvents(this.userId, {});
      if (this.liveCollectionStartedAtMs == null && events.length > 0) {
        let earliest = Infinity;
        for (const event of events) {
          const at = eventSettledMs(event);
          if (Number.isFinite(at) && at < earliest) earliest = at;
        }
        if (Number.isFinite(earliest)) {
          this.liveCollectionStartedAtMs = earliest;
          await ensureLiveCollectionStartedAt(this.userId, new Date(earliest).toISOString());
        }
      }

      const activated = await listActivatedPlacementIds(this.userId);
      this.liveStatLedger.clear();
      this.lastPersistedStatFingerprint.clear();
      this.knownPlacementIds.clear();

      for (const id of activated) {
        this.knownPlacementIds.add(id);
      }

      // Stats ledger (Market / Schedule) — durable Real history; not cleared by Positions Clear.
      for (const event of events) {
        if (event.card?.demo === true || String(event.cardId).startsWith("demo:")) {
          // Demo belongs on Positions + trigger.demoStats only.
          continue;
        }
        if (isManualStatEvent(event)) {
          delete event.placementId;
          if (event.card?.placementId) {
            const { placementId: _pid, ...rest } = event.card;
            event.card = rest;
          }
        } else {
          const pid = eventPlacementId(event);
          if (pid && !event.placementId) event.placementId = pid;
          if (pid && event.card && !event.card.placementId) {
            event.card = { ...event.card, placementId: pid };
          }
        }
        this.liveStatLedger.set(event.cardId, event);
        this.lastPersistedStatFingerprint.set(event.cardId, eventFingerprint(event));
        const pid = eventPlacementId(event);
        if (pid && !isManualStatEvent(event)) this.knownPlacementIds.add(pid);
      }

      // Positions UI — Mongo position_cards (Open + last 24h settled).
      await pruneExpiredSettledPositionCards(this.userId).catch(() => 0);
      let uiCards = await listPositionCards(this.userId, { series: this.boundSeries });
      if (uiCards.length === 0) {
        // One-time seed from legacy event snapshots + any RAM open cards (this series).
        const seeded: TradingPositionCard[] = [];
        const seen = new Set<string>();
        for (const c of this.positionCards) {
          if (!c?.id || seen.has(c.id)) continue;
          if (!this.cardMatchesBoundSeries(c)) continue;
          seen.add(c.id);
          seeded.push(c);
        }
        for (const event of events) {
          const card = positionCardFromEvent(event);
          if (!card || seen.has(card.id)) continue;
          if (!this.cardMatchesBoundSeries(card)) continue;
          seen.add(card.id);
          seeded.push(card);
        }
        const keep = trimPositionCardsForUi(seeded);
        if (keep.length > 0) {
          await upsertPositionCardsBulk(this.userId, keep).catch((err) => {
            logService.warn("trading", `Failed to seed position_cards: ${String(err)}`);
          });
          uiCards = keep;
        }
      }

      this.positionCards = trimPositionCardsForUi(uiCards);
      for (const card of this.positionCards) {
        if (card.placementId && !isManualTradeCard(card)) {
          this.knownPlacementIds.add(card.placementId);
        }
      }

      const backfilled = await this.backfillOrphanPlacementIds();
      logService.info(
        "trading",
        `Hydrated ${this.liveStatLedger.size} live stat event(s) + ${this.positionCards.length} position card(s) (${this.knownPlacementIds.size} placement(s)${
          backfilled > 0 ? `, backfilled ${backfilled} placementId(s)` : ""
        })`,
      );
      await this.syncActivatedSchedulePlacements();
      await this.reconcileDemoStatsFromPositionCards();
      await this.reloadTriggerLiveUiFromMongo();
      this.ensureConfirmLoop();
    } catch (err) {
      logService.warn("trading", `Failed to hydrate live stats from Mongo: ${String(err)}`);
    } finally {
      // Always unblock clients (Positions spinner) even if Mongo hydrate failed.
      this.statsHydrated = true;
    }
  }

  private async reloadTriggerLiveUiFromMongo(): Promise<void> {
    try {
      const triggers = await listUserTriggers(this.userId, this.boundSeries);
      this.triggerLiveUiById.clear();
      const now = Date.now();
      for (const t of triggers) {
        const id = String(t.id || "");
        if (!id || !t.liveUi) continue;
        const live = t.liveUi;
        const sellAt = live.sell?.atMs;
        if (
          live.sell &&
          Number.isFinite(sellAt) &&
          now - Number(sellAt) >= TRIGGER_LIVE_SELL_FLASH_MS
        ) {
          // Expired SELL flash — clear in Mongo + RAM.
          void this.clearTriggerLiveUi(id);
          continue;
        }
        this.triggerLiveUiById.set(id, live);
        if (live.sell && Number.isFinite(sellAt)) {
          this.scheduleTriggerLiveSellClear(id, TRIGGER_LIVE_SELL_FLASH_MS - (now - Number(sellAt)));
        }
      }
    } catch (err) {
      logService.warn("trading", `Failed to load trigger liveUi: ${String(err)}`);
    }
  }

  private cancelTriggerLiveSellClear(triggerId: string): void {
    const tid = String(triggerId || "");
    const t = this.triggerLiveSellClearTimers.get(tid);
    if (t) clearTimeout(t);
    this.triggerLiveSellClearTimers.delete(tid);
  }

  private scheduleTriggerLiveSellClear(triggerId: string, delayMs: number): void {
    const tid = String(triggerId || "");
    if (!tid) return;
    this.cancelTriggerLiveSellClear(tid);
    const wait = Math.max(0, Math.floor(delayMs));
    const timer = setTimeout(() => {
      this.triggerLiveSellClearTimers.delete(tid);
      void this.clearTriggerLiveUi(tid);
    }, wait);
    this.triggerLiveSellClearTimers.set(tid, timer);
  }

  private publishTriggerLiveBuy(
    triggerId: string,
    side: "up" | "down",
    price: number,
    shares: number,
  ): void {
    const tid = String(triggerId || "").trim();
    if (!tid) return;
    this.cancelTriggerLiveSellClear(tid);
    void setTriggerLiveBuy(this.userId, tid, side, price, shares)
      .then((live) => {
        if (live) this.triggerLiveUiById.set(tid, live);
        else this.triggerLiveUiById.delete(tid);
        this.notify();
      })
      .catch((err) => {
        logService.warn("trading", `Failed to set trigger BUY liveUi ${tid}: ${String(err)}`);
      });
  }

  private publishTriggerLiveSell(
    triggerId: string,
    side: "up" | "down",
    price: number,
    shares: number,
  ): void {
    const tid = String(triggerId || "").trim();
    if (!tid) return;
    const prev = this.triggerLiveUiById.get(tid);
    void setTriggerLiveSell(this.userId, tid, side, price, shares, prev?.buy ?? null)
      .then((live) => {
        if (live) {
          this.triggerLiveUiById.set(tid, live);
          this.scheduleTriggerLiveSellClear(tid, TRIGGER_LIVE_SELL_FLASH_MS);
        } else {
          this.triggerLiveUiById.delete(tid);
        }
        this.notify();
      })
      .catch((err) => {
        logService.warn("trading", `Failed to set trigger SELL liveUi ${tid}: ${String(err)}`);
      });
  }

  private async clearTriggerLiveUi(triggerId: string): Promise<void> {
    const tid = String(triggerId || "").trim();
    if (!tid) return;
    this.cancelTriggerLiveSellClear(tid);
    this.triggerLiveUiById.delete(tid);
    try {
      await setTriggerLiveUi(this.userId, tid, null);
    } catch (err) {
      logService.warn("trading", `Failed to clear trigger liveUi ${tid}: ${String(err)}`);
    }
    this.notify();
  }

  /** Clear BUY/SELL highlights for triggers when the market window rolls. */
  private clearTriggerLiveUiForWindowEnd(): void {
    const ids = [...this.triggerLiveUiById.keys()];
    for (const id of ids) void this.clearTriggerLiveUi(id);
  }

  /** Persist Positions UI card to Mongo (source of truth). Does not write the stats ledger. */
  private scheduleUpsertPositionCard(card: TradingPositionCard): void {
    if (!card?.id) return;
    const snap: TradingPositionCard = { ...card };
    if (isDemoPositionCard(snap)) snap.demo = true;
    this.positionCardsPersistChain = this.positionCardsPersistChain
      .then(async () => {
        await upsertPositionCard(this.userId, snap);
        await pruneExpiredSettledPositionCards(this.userId, this.boundSeries);
        this.positionCards = trimPositionCardsForUi(this.positionCards);
      })
      .catch((err) => {
        logService.warn("trading", `Failed to persist position card ${snap.id}: ${String(err)}`);
      });
  }

  /** Drop Demo Positions for a deleted Market Trigger (Mongo + RAM). */
  async dropDemoPositionCardsForTrigger(triggerId: string): Promise<number> {
    const tid = String(triggerId || "").trim();
    if (!tid) return 0;
    const removed = await deleteDemoPositionCardsForTrigger(this.userId, tid).catch((err) => {
      logService.warn("trading", `Failed to delete Demo positions for trigger ${tid}: ${String(err)}`);
      return 0;
    });
    const before = this.positionCards.length;
    this.positionCards = this.positionCards.filter(
      (c) => !(isDemoPositionCard(c) && String(c.triggerId || "") === tid),
    );
    // Also drop by demo id prefix when triggerId field missing.
    this.positionCards = this.positionCards.filter(
      (c) => !(isDemoPositionCard(c) && String(c.id || "").startsWith(`demo:${tid}:`)),
    );
    if (this.positionCards.length !== before || removed > 0) {
      this.stopConfirmLoopIfIdle();
      this.notify();
    }
    return Math.max(removed, before - this.positionCards.length);
  }

  /**
   * Map settled auto/trigger trades that never got a placementId (late GTD fills, wiped upserts)
   * onto the schedule slot that was live at buy time so card stats match.
   * Manual trades are never attributed to Schedule cards.
   * Trigger Trade backfill does not require Use Schedule (same as live attribution).
   */
  private async backfillOrphanPlacementIds(): Promise<number> {
    let placements: Awaited<ReturnType<typeof listSchedulePlacements>>;
    try {
      placements = await listSchedulePlacements(this.userId, this.boundSeries);
    } catch {
      return 0;
    }
    if (placements.length === 0) return 0;

    const findPlacementAt = (atMs: number): string | undefined => {
      if (!Number.isFinite(atMs)) return undefined;
      const clock = getUtcScheduleClock(new Date(atMs));
      const match = placements.find(
        (p) =>
          p.day === clock.day &&
          clock.hour >= p.startHour &&
          clock.hour < p.startHour + p.durationHours,
      );
      return match?._id;
    };

    let fixed = 0;
    for (const event of this.liveStatLedger.values()) {
      // Strip any prior mistaken schedule link on manual trades.
      if (isManualStatEvent(event)) {
        if (event.placementId || event.card?.placementId) {
          delete event.placementId;
          if (event.card?.placementId) {
            const { placementId: _pid, ...rest } = event.card;
            event.card = rest;
          }
          const ramCard = this.findCard(event.cardId);
          if (ramCard) stripManualScheduleAttribution(ramCard);
          this.lastPersistedStatFingerprint.set(event.cardId, eventFingerprint(event));
          const snapshot: TradingStatEvent = { ...event, updatedAt: new Date().toISOString() };
          this.statsPersistChain = this.statsPersistChain
            .then(() =>
              upsertTradingStatEvent(this.userId, {
                cardId: snapshot.cardId,
                placementId: undefined,
                status: snapshot.status,
                green: snapshot.green,
                red: snapshot.red,
                blue: snapshot.blue,
                pnl: snapshot.pnl,
                settledAt: snapshot.settledAt,
                card: snapshot.card,
              }).then(() => undefined),
            )
            .catch((err) => {
              this.lastPersistedStatFingerprint.delete(snapshot.cardId);
              logService.warn(
                "trading",
                `Failed to clear manual placementId for ${snapshot.cardId}: ${String(err)}`,
              );
            });
          fixed += 1;
        }
        continue;
      }

      if (eventPlacementId(event)) continue;
      // Only backfill known auto/trigger trades — never invent a schedule link for unlabeled orphans
      // (those are often manuals from before source was persisted).
      const src = event.card?.source;
      if (src !== "auto" && src !== "trigger") continue;

      const placementId = findPlacementAt(eventAttributionMs(event));
      if (!placementId) continue;

      event.placementId = placementId;
      if (event.card) {
        event.card = { ...event.card, placementId };
      }
      this.knownPlacementIds.add(placementId);

      const ramCard = this.findCard(event.cardId);
      if (ramCard && !ramCard.placementId && ramCard.source !== "manual") {
        ramCard.placementId = placementId;
      }

      this.lastPersistedStatFingerprint.set(event.cardId, eventFingerprint(event));
      const snapshot: TradingStatEvent = {
        cardId: event.cardId,
        placementId: event.placementId,
        status: event.status,
        green: event.green,
        red: event.red,
        blue: event.blue,
        pnl: event.pnl,
        settledAt: event.settledAt,
        updatedAt: event.updatedAt,
        card: event.card,
      };
      this.statsPersistChain = this.statsPersistChain
        .then(() =>
          upsertTradingStatEvent(this.userId, {
            cardId: snapshot.cardId,
            placementId: snapshot.placementId,
            status: snapshot.status,
            green: snapshot.green,
            red: snapshot.red,
            blue: snapshot.blue,
            pnl: snapshot.pnl,
            settledAt: snapshot.settledAt,
            card: snapshot.card,
          }).then(() => undefined),
        )
        .catch((err) => {
          this.lastPersistedStatFingerprint.delete(snapshot.cardId);
          logService.warn(
            "trading",
            `Failed to persist backfilled placementId for ${snapshot.cardId}: ${String(err)}`,
          );
        });
      fixed += 1;
    }
    return fixed;
  }

  /** Mark a schedule placement as live this session so cards show 0/0/0 until the first fill. */
  private rememberActivatedPlacement(
    placementId: string | undefined,
    opts?: { quiet?: boolean },
  ): void {
    if (!placementId || this.knownPlacementIds.has(placementId)) return;
    this.knownPlacementIds.add(placementId);
    this.statsPersistChain = this.statsPersistChain
      .then(() => addActivatedPlacementId(this.userId, placementId))
      .catch((err) => {
        logService.warn(
          "trading",
          `Failed to persist activated placement ${placementId}: ${String(err)}`,
        );
      });
    if (!opts?.quiet) this.notify();
  }

  /**
   * Zero-trade slots that ran after live collection started (or sit between slots with
   * live fills) show gray +$0.00. Slots before collection start stay pre-run (dashes).
   */
  private async syncActivatedSchedulePlacements(): Promise<void> {
    if (!this.config.autoTrade || !this.config.useSchedule) return;

    let placements: Awaited<ReturnType<typeof listSchedulePlacements>>;
    try {
      placements = await listSchedulePlacements(this.userId, this.boundSeries);
    } catch {
      return;
    }
    if (placements.length === 0) return;

    if (this.config.startTrading) {
      await this.ensureCollectionStarted();
    }

    const floorKey = this.collectionFloorKey();
    const keyed = placements
      .map((p) => ({ p, key: schedulePlacementSortKey(p) }))
      .sort((a, b) => a.key - b.key);

    // Drop pre-run activations that fully ended before recording/collection start.
    // Use end time (not start): a slot that was already running when collection began
    // must stay activated — otherwise remember/prune thrash and the live card flickers.
    if (floorKey != null) {
      const keep: string[] = [];
      let pruned = false;
      for (const { p, key } of keyed) {
        if (!this.knownPlacementIds.has(p._id)) continue;
        // Never prune the slot that is live right now.
        if (isScheduleContextActive(p)) {
          keep.push(p._id);
          continue;
        }
        const endKey = key + p.durationHours;
        if (endKey <= floorKey + 1e-9) {
          // Keep cards that already have live outcomes — they stay locked on the board.
          if (this.placementHasRecordedStats(p._id)) {
            keep.push(p._id);
            continue;
          }
          this.knownPlacementIds.delete(p._id);
          pruned = true;
        } else {
          keep.push(p._id);
        }
      }
      // Keep ids not on this week's board (shouldn't happen) — only persist board survivors + events.
      for (const id of this.knownPlacementIds) {
        if (!keyed.some(({ p }) => p._id === id)) keep.push(id);
      }
      if (this.scheduleContext?.placementId) {
        keep.push(this.scheduleContext.placementId);
      }
      if (pruned) {
        const unique = [...new Set(keep)];
        this.knownPlacementIds = new Set(unique);
        this.statsPersistChain = this.statsPersistChain
          .then(() => setActivatedPlacementIds(this.userId, unique))
          .catch((err) => {
            logService.warn("trading", `Failed to prune activated placements: ${String(err)}`);
          });
      }
    }

    let changed = false;
    const remember = (id: string): void => {
      if (this.knownPlacementIds.has(id)) return;
      this.rememberActivatedPlacement(id, { quiet: true });
      changed = true;
    };

    // While live: every elapsed slot that overlaps/after collection start is a real zero result.
    if (this.config.startTrading && floorKey != null) {
      for (const { p, key } of keyed) {
        const endKey = key + p.durationHours;
        if (endKey <= floorKey + 1e-9) continue;
        if (isSchedulePlacementElapsed(p)) remember(p._id);
      }
    }

    // Fill gaps between slots that actually have fills (still not before floor).
    const eventPlacementIds = new Set<string>();
    for (const event of this.liveStatLedger.values()) {
      const pid = eventPlacementId(event);
      if (pid) eventPlacementIds.add(pid);
    }
    const seedKeys = keyed
      .filter(({ p, key }) => {
        if (!eventPlacementIds.has(p._id)) return false;
        const endKey = key + p.durationHours;
        if (floorKey != null && endKey <= floorKey + 1e-9) return false;
        return true;
      })
      .map(({ key }) => key);
    if (seedKeys.length >= 1) {
      const minK = Math.min(...seedKeys);
      const maxK = Math.max(...seedKeys);
      for (const { p, key } of keyed) {
        const endKey = key + p.durationHours;
        if (floorKey != null && endKey <= floorKey + 1e-9) continue;
        if (key >= minK && key <= maxK) remember(p._id);
      }
    }

    if (changed) this.notify();
  }

  private collectionFloorKey(): number | null {
    if (this.liveCollectionStartedAtMs == null) return null;
    const { day, hour } = getUtcScheduleClock(new Date(this.liveCollectionStartedAtMs));
    return schedulePlacementSortKey({ day, startHour: hour });
  }

  private async ensureCollectionStarted(at = new Date()): Promise<void> {
    if (this.liveCollectionStartedAtMs != null) return;
    const iso = at.toISOString();
    this.liveCollectionStartedAtMs = at.getTime();
    try {
      const stored = await ensureLiveCollectionStartedAt(this.userId, iso);
      const ms = Date.parse(stored);
      if (Number.isFinite(ms)) this.liveCollectionStartedAtMs = ms;
    } catch (err) {
      logService.warn("trading", `Failed to persist live collection start: ${String(err)}`);
    }
  }

  /**
   * Demo trigger card stats — once per settled Positions card id (atomic credit + $inc).
   * Demo cards always credit demoStats (independent of current Demo/Trade switch).
   */
  private creditTriggerDemoStatsFromCard(card: TradingPositionCard): void {
    if (!isDemoPositionCard(card) || card.source !== "trigger") return;
    const triggerId = typeof card.triggerId === "string" ? card.triggerId.trim() : "";
    if (!triggerId) return;
    const classified = classifyDemoStatKind(card);
    if (!classified) return;
    void recordTriggerDemoStatsForSettledCard(
      this.userId,
      triggerId,
      card.id,
      classified.kind,
      classified.pnlUsd,
    ).catch((err) => {
      logService.warn(
        "trading",
        `Failed to credit Demo stats for ${card.id}: ${String(err)}`,
      );
    });
  }

  /**
   * Heal Demo stats vs Positions: if a trigger has no credit rows yet, rebuild from
   * settled Demo cards; otherwise credit any settled Demo cards missing a credit row.
   */
  private async reconcileDemoStatsFromPositionCards(): Promise<void> {
    try {
      const cards = await listPositionCards(this.userId, {
        series: this.boundSeries,
        includeExpiredSettled: true,
      });
      const byTrigger = new Map<string, TradingPositionCard[]>();
      for (const card of cards) {
        if (!isDemoPositionCard(card) || card.status === "open") continue;
        const tid = typeof card.triggerId === "string" ? card.triggerId.trim() : "";
        if (!tid) continue;
        const list = byTrigger.get(tid) ?? [];
        list.push(card);
        byTrigger.set(tid, list);
      }
      if (byTrigger.size === 0) return;

      const mongo = await getMongoClient();
      const credits = mongo.db(getMongoDbName()).collection("trigger_demo_stats_credits");

      for (const [tid, list] of byTrigger) {
        const creditCount = await credits.countDocuments({
          userId: this.userId,
          triggerId: tid,
        });
        if (creditCount === 0) {
          await rebuildTriggerDemoStatsFromCards(this.userId, tid, list);
          continue;
        }
        for (const card of list) {
          const classified = classifyDemoStatKind(card);
          if (!classified) continue;
          await recordTriggerDemoStatsForSettledCard(
            this.userId,
            tid,
            card.id,
            classified.kind,
            classified.pnlUsd,
          );
        }
      }
    } catch (err) {
      logService.warn("trading", `Failed to reconcile Demo stats from Positions: ${String(err)}`);
    }
  }

  private creditTriggerLiveStatsFromCard(card: TradingPositionCard): void {
    if (card.source !== "trigger") return;
    // Demo cards credit demoStats separately (not Trade live totals / Schedule).
    if (card.demo === true) return;
    const triggerId = typeof card.triggerId === "string" ? card.triggerId.trim() : "";
    if (!triggerId) return;
    const contrib = contributionFromCard(card);
    if (!contrib) return;

    let result: "success" | "fail" | "blue";
    let exitReason: "tp" | "sl" | "window-end" | undefined;
    if (contrib.blue) {
      result = "blue";
      exitReason = "window-end";
    } else if (contrib.green) {
      result = "success";
      if (card.triggerExitReason === "tp" || card.triggerExitReason === "sl") {
        exitReason = card.triggerExitReason;
      }
    } else {
      result = "fail";
      if (card.status === "win" || card.status === "loss") {
        exitReason = "window-end";
      } else if (card.triggerExitReason === "tp" || card.triggerExitReason === "sl") {
        exitReason = card.triggerExitReason;
      }
    }

    void recordTriggerLiveStatsForSettledCard(
      this.userId,
      triggerId,
      card.id,
      result,
      contrib.pnl,
      exitReason,
    ).catch((err) => {
      logService.warn(
        "trading",
        `Failed to credit trigger stats for ${card.id}: ${String(err)}`,
      );
    });
  }

  private persistCardStat(card: TradingPositionCard): void {
    stripManualScheduleAttribution(card);
    // Positions UI always persists (including open confirms); stats ledger is Trade settled only.
    this.scheduleUpsertPositionCard(card);
    const contrib = contributionFromCard(card);
    if (!contrib) return;

    if (isDemoPositionCard(card)) {
      this.creditTriggerDemoStatsFromCard(card);
      return;
    }

    const event: TradingStatEvent = {
      cardId: card.id,
      status: contrib.status,
      green: contrib.green,
      red: contrib.red,
      blue: contrib.blue,
      pnl: contrib.pnl,
      settledAt: new Date(
        (card.soldAt ?? card.buyAt ?? Math.floor(Date.now() / 1000)) * 1000,
      ).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (card.source !== "manual" && card.placementId) event.placementId = card.placementId;
    const snap = cardSnapshotFromPosition(card);
    if (snap) event.card = snap;

    const fingerprint = eventFingerprint(event);
    if (this.lastPersistedStatFingerprint.get(card.id) === fingerprint) return;

    this.liveStatLedger.set(card.id, event);
    this.lastPersistedStatFingerprint.set(card.id, fingerprint);
    if (card.source !== "manual" && card.placementId) {
      this.knownPlacementIds.add(card.placementId);
    }

    this.creditTriggerLiveStatsFromCard(card);

    this.statsPersistChain = this.statsPersistChain
      .then(async () => {
        await upsertTradingStatEvent(this.userId, {
          cardId: event.cardId,
          placementId: event.placementId,
          status: event.status,
          green: event.green,
          red: event.red,
          blue: event.blue,
          pnl: event.pnl,
          settledAt: event.settledAt,
          card: event.card,
        });
      })
      .catch((err) => {
        // Allow retry on next change
        this.lastPersistedStatFingerprint.delete(card.id);
        logService.warn("trading", `Failed to persist stat event ${card.id}: ${String(err)}`);
      });
  }

  private persistConfig(): void {
    const snapshot = this.getConfig();
    const series = this.boundSeries;
    this.persistChain = this.persistChain
      .then(() => updateUserTrading(this.userId, snapshot, series).then(() => undefined))
      .catch((err) => {
        logService.warn("trading", `Failed to save trading config: ${String(err)}`);
      });
  }

  setConfig(patch: Partial<TradingConfig>): TradingConfig {
    const wasLive =
      this.config.autoTrade && this.config.useSchedule && this.config.startTrading;
    if (patch.autoTrade != null) this.config.autoTrade = Boolean(patch.autoTrade);
    if (patch.useSchedule != null) this.config.useSchedule = Boolean(patch.useSchedule);
    if (patch.startTrading != null) this.config.startTrading = Boolean(patch.startTrading);
    if (patch.manualOrderUnit === "shares" || patch.manualOrderUnit === "usdc") {
      this.config.manualOrderUnit = patch.manualOrderUnit;
    }
    if (patch.manualBuyOrderType === "FAK" || patch.manualBuyOrderType === "FOK") {
      this.config.manualBuyOrderType = patch.manualBuyOrderType;
    }
    if (patch.manualSellOrderType === "FAK" || patch.manualSellOrderType === "FOK") {
      this.config.manualSellOrderType = patch.manualSellOrderType;
    }
    if (patch.manualShares != null) {
      const amount = Number(patch.manualShares);
      if (this.config.manualOrderUnit === "usdc") {
        this.config.manualShares = Math.max(
          0.01,
          Math.min(100000, Math.round((Number.isFinite(amount) ? amount : 10) * 100) / 100),
        );
      } else {
        this.config.manualShares = Math.max(
          1,
          Math.min(100000, Math.floor(Number.isFinite(amount) ? amount : 10) || 10),
        );
      }
    }
    if (patch.manipulationDetector != null) {
      this.config.manipulationDetector = Boolean(patch.manipulationDetector);
    }
    // Prediction Trade disabled — ignore client patches.
    this.config.predictionTrade = false;
    if (patch.predictionShares != null) {
      const shares = Number(patch.predictionShares);
      this.config.predictionShares = Math.max(
        1,
        Math.min(100000, Math.floor(Number.isFinite(shares) ? shares : 10) || 10),
      );
    }
    if (patch.predictionBuyOrderType === "FAK" || patch.predictionBuyOrderType === "FOK") {
      this.config.predictionBuyOrderType = patch.predictionBuyOrderType;
    }
    if (
      patch.predictionSellOrderType === "FAK" ||
      patch.predictionSellOrderType === "FOK" ||
      patch.predictionSellOrderType === "GTD"
    ) {
      this.config.predictionSellOrderType = patch.predictionSellOrderType;
    }
    if (patch.manipulationSensitivitySec != null) {
      const sens = Number(patch.manipulationSensitivitySec);
      this.config.manipulationSensitivitySec = Math.max(
        1,
        Math.min(120, Math.round(Number.isFinite(sens) ? sens : 5)),
      );
    }
    if (patch.predictionMaxQuoteCents != null || patch.predictionMinQuoteCents != null) {
      const quotes = normalizePredictionQuoteBand(
        patch.predictionMinQuoteCents ?? this.config.predictionMinQuoteCents,
        patch.predictionMaxQuoteCents ?? this.config.predictionMaxQuoteCents,
        {
          min: this.config.predictionMinQuoteCents,
          max: this.config.predictionMaxQuoteCents,
        },
      );
      this.config.predictionMinQuoteCents = quotes.predictionMinQuoteCents;
      this.config.predictionMaxQuoteCents = quotes.predictionMaxQuoteCents;
    }
    if (patch.predictionShiftCents != null) {
      this.config.predictionShiftCents = normalizePredictionShiftCents(
        patch.predictionShiftCents,
        this.config.predictionShiftCents,
      );
    }
    if (patch.predictionRiseCents != null) {
      this.config.predictionRiseCents = normalizePredictionRiseCents(
        patch.predictionRiseCents,
        this.config.predictionRiseCents,
      );
    }
    if (patch.manipulationAreaStart != null || patch.manipulationAreaEnd != null) {
      const area = normalizeManipulationArea(
        patch.manipulationAreaStart ?? this.config.manipulationAreaStart,
        patch.manipulationAreaEnd ?? this.config.manipulationAreaEnd,
      );
      this.config.manipulationAreaStart = area.manipulationAreaStart;
      this.config.manipulationAreaEnd = area.manipulationAreaEnd;
    }
    if (patch.predictionRightCount != null) {
      this.config.predictionRightCount = normalizePredictionCount(patch.predictionRightCount);
    }
    if (patch.predictionWrongCount != null) {
      this.config.predictionWrongCount = normalizePredictionCount(patch.predictionWrongCount);
    }
    // Re-normalize amount if unit changed after amount in the same patch
    if (patch.manualOrderUnit != null && patch.manualShares == null) {
      this.config = normalizeTradingConfig(this.config);
    }
    if (!this.config.autoTrade) {
      this.config.useSchedule = false;
    }
    this.config.predictionTrade = false;
    this.persistConfig();
    const isLive =
      this.config.autoTrade && this.config.useSchedule && this.config.startTrading;
    if (isLive && (!wasLive || patch.startTrading === true || patch.useSchedule === true)) {
      // Arm collection + current live slot only. Do NOT run full
      // syncActivatedSchedulePlacements here — that retroactively zeros every
      // elapsed card and looks like an Allow-trade "reset".
      void this.ensureCollectionStarted()
        .then(() => this.refreshScheduleContext(true))
        .then(() => {
          const liveId = this.scheduleContext?.placementId;
          if (liveId) this.rememberActivatedPlacement(liveId);
        });
    }
    return this.getConfig();
  }

  private isPreviewMode(): boolean {
    // startTrading alone is not enough — non-executor processes stay in preview.
    return this.config.autoTrade && !(this.config.startTrading && isTradingExecutor());
  }

  private canExecuteOrders(): boolean {
    if (!isTradingExecutor()) return false;
    // Allow trade gates both auto and manual order placement for this market.
    return this.config.startTrading;
  }

  /** True when this process may place/cancel live orders for the current config. */
  private isLiveArmed(): boolean {
    return this.config.startTrading && isTradingExecutor();
  }

  private getDisplayMarkers(): SimMarker[] {
    const key = this.sessionKey;
    if (this.isPreviewMode() && key) {
      return this.autoEngine.getMarkers().filter((m) => m.windowKey === key);
    }
    return [...this.markers];
  }

  /** Settled ledger events (RAM) for Live Open Replay / hour stats freshness. */
  getLiveStatEvents(): TradingStatEvent[] {
    return [...this.liveStatLedger.values()].map((e) => ({ ...e, card: e.card ? { ...e.card } : e.card }));
  }

  getPublicState(): TradingPublicState {
    const phasesVisible = this.shouldShowPhases();
    const previewMode = this.isPreviewMode();
    const live = this.getLiveSessionTotals();
    return {
      config: this.getConfig(),
      positions: {
        up: this.positions.up ? { ...this.positions.up } : null,
        down: this.positions.down ? { ...this.positions.down } : null,
      },
      positionCards: this.positionCards
        .filter((card) => this.cardMatchesBoundSeries(card))
        .map((card) => ({ ...card })),
      positionCardsReady: this.statsHydrated,
      triggerLiveUi: Object.fromEntries(
        [...this.triggerLiveUiById.entries()].map(([id, live]) => [id, live ? { ...live } : null]),
      ),
      placementStats: this.getPlacementStatsFromCards(),
      sessionTotals: {
        green: live.green,
        red: live.red,
        blue: live.blue,
        pnl: live.pnl,
        hasData: live.hasBalance,
      },
      demoLastWindow:
        this.config.autoTrade && !this.isLiveArmed()
          ? this.autoEngine.getLastWindow()
          : null,
      quoteLocks: previewMode
        ? this.autoEngine.getQuoteLocks()
        : {
            upBuy: [...this.quoteLocks.upBuy],
            upSell: [...this.quoteLocks.upSell],
            downBuy: [...this.quoteLocks.downBuy],
            downSell: [...this.quoteLocks.downSell],
          },
      markers: this.getDisplayMarkers(),
      phaseSetup: phasesVisible ? this.getDisplayPhaseSetup() : null,
      phasesVisible,
      // Schedule mode: bars follow the active card only (view/click, no drag-edit).
      phasesEditable: phasesVisible && this.config.autoTrade && !this.config.useSchedule,
      scheduleTitle: this.config.useSchedule && this.scheduleContext ? this.scheduleContext.title : null,
      scheduleSetupId:
        this.config.useSchedule && this.scheduleContext ? this.scheduleContext.setupId : null,
      quotesEnabled: this.canExecuteOrders(),
      previewMode,
      fillSuccess: this.getFillSuccessStats(),
    };
  }

  private cardMatchesBoundSeries(card: Pick<TradingPositionCard, "series">): boolean {
    return !card.series || card.series === this.boundSeries;
  }

  private eventMatchesBoundSeries(event: TradingStatEvent): boolean {
    const series = event.card?.series;
    return !series || series === this.boundSeries;
  }

  /** Aggregate real-trade outcomes for schedule placement cards (last weekly run only). */
  getPlacementStats(placementIds: string[]): PlacementLiveStats[] {
    return placementIds.map((id) => this.statsForPlacement(id));
  }

  /**
   * UTC weekday×hour slot stats for the current ISO week:
   * Trigger Trade (timeline-gated) plus legacy phase/auto placement trades still in this week.
   * Prior week clears automatically when the UTC ISO week rolls.
   */
  async getHourSlotStats(): Promise<ScheduleHourSlotStats[]> {
    const triggerIds = new Set<string>();
    for (const card of this.positionCards) {
      const tid = typeof card.triggerId === "string" ? card.triggerId.trim() : "";
      if (tid && card.source !== "manual" && card.source !== "auto") triggerIds.add(tid);
    }
    for (const event of this.liveStatLedger.values()) {
      const tid = typeof event.card?.triggerId === "string" ? event.card.triggerId.trim() : "";
      if (
        tid &&
        event.card?.source !== "manual" &&
        event.card?.source !== "auto"
      ) {
        triggerIds.add(tid);
      }
    }
    const timelineEvents = triggerIds.size
      ? await listTriggerModeEvents(this.userId, [...triggerIds])
      : [];
    return computeScheduleHourSlotStats({
      events: [...this.liveStatLedger.values()],
      cards: this.positionCards,
      timelineEvents,
    });
  }

  /** True once the card has started at least one window — stays locked until removed. */
  isPlacementLocked(placementId: string): boolean {
    if (!placementId) return false;
    if (this.knownPlacementIds.has(placementId)) return true;
    if (this.scheduleContext?.placementId === placementId) return true;
    // Any recorded live outcome for this card locks it (incl. after activation prune).
    if (this.placementHasRecordedStats(placementId)) return true;
    return false;
  }

  private placementHasRecordedStats(placementId: string): boolean {
    for (const event of this.liveStatLedger.values()) {
      if (eventPlacementId(event) !== placementId) continue;
      if (isManualStatEvent(event)) continue;
      if (!this.eventMatchesBoundSeries(event)) continue;
      return true;
    }
    for (const card of this.positionCards) {
      if (card.placementId !== placementId) continue;
      if (isManualTradeCard(card)) continue;
      if (!this.cardMatchesBoundSeries(card)) continue;
      if (card.status === "open") continue;
      return true;
    }
    return false;
  }

  private getPlacementStatsFromCards(): PlacementLiveStats[] {
    const ids = new Set(this.knownPlacementIds);
    for (const event of this.liveStatLedger.values()) {
      if (isManualStatEvent(event)) continue;
      const pid = eventPlacementId(event);
      if (pid) ids.add(pid);
    }
    for (const card of this.positionCards) {
      if (isManualTradeCard(card)) continue;
      if (card.placementId) ids.add(card.placementId);
    }
    // Always include the in-progress schedule slot so the live card stays stable.
    if (this.scheduleContext?.placementId) {
      ids.add(this.scheduleContext.placementId);
    }
    return this.getPlacementStats([...ids]);
  }

  private emptyPlacementStats(placementId: string): PlacementLiveStats {
    return {
      placementId,
      hasData: false,
      green: 0,
      red: 0,
      blue: 0,
      pnl: 0,
      locked: this.isPlacementLocked(placementId),
    };
  }

  /** Live-armed placement with no fills yet — match demo “0 cards” zeros, not dashes. */
  private zeroPlacementStats(placementId: string): PlacementLiveStats {
    return {
      placementId,
      hasData: true,
      green: 0,
      red: 0,
      blue: 0,
      pnl: 0,
      locked: true,
    };
  }

  private statsForPlacement(placementId: string): PlacementLiveStats {
    type RunHit = {
      weekKey: string;
      windowSec: number;
      identity: string | null;
      contrib: { green: number; red: number; blue: number; pnl: number };
    };
    const hits: RunHit[] = [];
    const cardIdsFromRam = new Set<string>();
    const tradeIdentities = new Set<string>();

    const pushHit = (
      windowKey: string | undefined,
      identity: string | null,
      contrib: { green: number; red: number; blue: number; pnl: number },
      fallbackUnixSec?: number,
    ): void => {
      let windowSec = windowKeyUnixSec(windowKey);
      if (!Number.isFinite(windowSec) && fallbackUnixSec != null && Number.isFinite(fallbackUnixSec)) {
        windowSec = fallbackUnixSec > 1e12 ? fallbackUnixSec / 1000 : fallbackUnixSec;
      }
      if (!Number.isFinite(windowSec)) return;
      if (identity) {
        if (tradeIdentities.has(identity)) return;
        tradeIdentities.add(identity);
      }
      hits.push({
        weekKey: utcIsoWeekKey(windowSec),
        windowSec,
        identity,
        contrib,
      });
    };

    for (const card of this.positionCards) {
      if (card.placementId !== placementId) continue;
      if (isManualTradeCard(card)) continue;
      if (!this.cardMatchesBoundSeries(card)) continue;
      if (card.status === "open") continue;
      const contrib = confirmedContributionFromCard(card);
      if (!contrib) continue;
      cardIdsFromRam.add(card.id);
      pushHit(card.windowKey, cardStatIdentity(card), contrib, card.soldAt ?? card.buyAt);
    }

    for (const event of this.liveStatLedger.values()) {
      if (eventPlacementId(event) !== placementId) continue;
      if (isManualStatEvent(event)) continue;
      if (!this.eventMatchesBoundSeries(event)) continue;
      if (cardIdsFromRam.has(event.cardId)) continue;
      const contrib = eventStatContribution(event);
      if (!contrib) continue;
      const settledSec = eventSettledMs(event);
      pushHit(
        event.card?.windowKey,
        eventStatIdentity(event),
        contrib,
        Number.isFinite(settledSec) ? settledSec / 1000 : undefined,
      );
    }

    if (hits.length === 0) {
      const liveArmedSlot =
        this.config.startTrading && this.scheduleContext?.placementId === placementId;
      if (this.knownPlacementIds.has(placementId) || liveArmedSlot) {
        return this.zeroPlacementStats(placementId);
      }
      return this.emptyPlacementStats(placementId);
    }

    // Any card with recorded outcomes is locked until removed.
    this.rememberActivatedPlacement(placementId, { quiet: true });

    let latest = hits[0]!;
    for (const hit of hits) {
      if (hit.windowSec > latest.windowSec) latest = hit;
    }
    const lastWeek = latest.weekKey;

    let green = 0;
    let red = 0;
    let blue = 0;
    let pnl = 0;
    for (const hit of hits) {
      if (hit.weekKey !== lastWeek) continue;
      green += hit.contrib.green;
      red += hit.contrib.red;
      blue += hit.contrib.blue;
      pnl += hit.contrib.pnl;
    }

    return { placementId, hasData: true, green, red, blue, pnl, locked: true };
  }

  /** Clears Positions UI cards tied to a removed schedule placement. Stats ledger stays. */
  forgetPlacement(placementId: string): void {
    this.knownPlacementIds.delete(placementId);
    const removedIds = this.positionCards
      .filter((card) => card.placementId === placementId)
      .map((card) => card.id);
    const before = this.positionCards.length;
    this.positionCards = this.positionCards.filter((card) => card.placementId !== placementId);
    if (removedIds.length > 0) {
      void deletePositionCardsByIds(this.userId, removedIds).catch((err) => {
        logService.warn("trading", `Failed to delete placement position cards: ${String(err)}`);
      });
    }
    if (this.positionCards.length !== before) {
      this.stopConfirmLoopIfIdle();
    }
    this.notify();
  }

  /** Snapshot of settled live counters (Live range: RAM + hydrated Mongo since header reset). */
  getLiveSessionTotals(): {
    green: number;
    red: number;
    blue: number;
    pnl: number;
    hasBalance: boolean;
    placementStats: PlacementLiveStats[];
    startedAt?: string;
  } {
    const placementStats = this.getPlacementStatsFromCards();
    let green = 0;
    let red = 0;
    let blue = 0;
    let pnl = 0;
    const seen = new Set<string>();
    const tradeIdentities = new Set<string>();
    let earliestBuyAt: number | null = null;

    for (const card of this.positionCards) {
      if (card.status === "open") continue;
      if (card.demo === true) continue;
      if (!this.cardMatchesBoundSeries(card)) continue;
      if (!this.countsTowardLiveHeader(cardSettledMs(card))) continue;
      const contrib = confirmedContributionFromCard(card);
      if (!contrib) continue;
      const identity = cardStatIdentity(card);
      if (identity && tradeIdentities.has(identity)) continue;
      if (identity) tradeIdentities.add(identity);
      seen.add(card.id);
      green += contrib.green;
      red += contrib.red;
      blue += contrib.blue;
      pnl += contrib.pnl;
      if (card.buyAt != null && Number.isFinite(card.buyAt)) {
        if (earliestBuyAt == null || card.buyAt < earliestBuyAt) earliestBuyAt = card.buyAt;
      }
    }

    for (const event of this.liveStatLedger.values()) {
      if (seen.has(event.cardId)) continue;
      if (event.card?.demo === true) continue;
      if (!this.eventMatchesBoundSeries(event)) continue;
      if (!this.countsTowardLiveHeader(eventSettledMs(event))) continue;
      const contrib = eventStatContribution(event);
      if (!contrib) continue;
      const identity = eventStatIdentity(event);
      if (identity && tradeIdentities.has(identity)) continue;
      if (identity) tradeIdentities.add(identity);
      green += contrib.green;
      red += contrib.red;
      blue += contrib.blue;
      pnl += contrib.pnl;
      const settled = eventSettledMs(event);
      if (Number.isFinite(settled)) {
        const buyAtSec = Math.floor(settled / 1000);
        if (earliestBuyAt == null || buyAtSec < earliestBuyAt) earliestBuyAt = buyAtSec;
      }
    }

    const hasData = green + red + blue > 0 || pnl !== 0;
    const hasBalance = hasData;
    const out: {
      green: number;
      red: number;
      blue: number;
      pnl: number;
      hasBalance: boolean;
      placementStats: PlacementLiveStats[];
      startedAt?: string;
    } = {
      green,
      red,
      blue,
      pnl,
      hasBalance,
      placementStats,
    };
    if (earliestBuyAt != null) out.startedAt = new Date(earliestBuyAt * 1000).toISOString();
    return out;
  }

  private countsTowardLiveHeader(settledAtMs: number): boolean {
    if (!Number.isFinite(settledAtMs)) return false;
    if (this.liveResetAtMs == null) return true;
    return settledAtMs > this.liveResetAtMs;
  }

  /**
   * Reset header "Live" counters only. Schedule placement cards keep collecting;
   * Week / All keep Mongo events. Does not clear activated placements or card ledgers.
   */
  clearPositionCards(): void {
    const at = new Date().toISOString();
    const ms = Date.parse(at);
    this.liveResetAtMs = Number.isFinite(ms) ? ms : Date.now();
    this.statsPersistChain = this.statsPersistChain
      .then(() => markLiveReset(this.userId, at))
      .catch((err) => {
        logService.warn("trading", `Failed to mark live stats reset: ${String(err)}`);
      });
    this.notify();
  }

  /**
   * Remove settled Positions UI cards for the current filter. Never removes Open.
   * Does not touch the stats ledger, trigger Demo/Trade totals, Market P/L, or Schedule.
   */
  async clearSettledPositionCards(scope: "demo" | "trade" | "all"): Promise<number> {
    const want = scope === "demo" || scope === "trade" || scope === "all" ? scope : "all";
    const removedIds = await clearSettledPositionCardsInDb(
      this.userId,
      want,
      this.boundSeries,
    ).catch((err) => {
      logService.warn("trading", `Failed to clear settled position cards: ${String(err)}`);
      return [] as string[];
    });
    const removeSet = new Set(removedIds);
    // Also drop any matching RAM cards (in case Mongo was already empty).
    for (const card of this.positionCards) {
      if (!card || card.status === "open") continue;
      if (!this.cardMatchesBoundSeries(card)) continue;
      const demo = isDemoPositionCard(card);
      if (want === "demo" && !demo) continue;
      if (want === "trade" && demo) continue;
      removeSet.add(card.id);
    }
    if (removeSet.size === 0) {
      this.notify();
      return 0;
    }
    if (removedIds.length === 0) {
      await deletePositionCardsByIds(this.userId, [...removeSet]).catch(() => 0);
    }
    this.positionCards = this.positionCards.filter((c) => !removeSet.has(c.id));
    this.notify();
    return removeSet.size;
  }

  private shouldShowPhases(): boolean {
    // Phase Auto Trade / chart setups are removed (Trigger-only). Keep false always.
    return false;
  }

  private getDisplayPhaseSetup(): TradingPhaseSetup | null {
    if (!this.shouldShowPhases()) return null;
    if (this.config.useSchedule && this.scheduleContext) return this.scheduleContext.setup;
    return simulatorService.getPhaseSetup();
  }

  /** Official market UP/DOWN for a card (Gamma payout ~1/~0 — same as Polymarket settlement). */
  private async fetchOfficialMarketOutcome(
    card: TradingPositionCard,
  ): Promise<"up" | "down" | null> {
    const slug = typeof card.slug === "string" ? card.slug.trim() : "";
    if (!slug) return null;
    try {
      const resolution = await fetchOfficialWindowResolution(slug);
      if (resolution?.outcome === "up" || resolution?.outcome === "down") {
        return resolution.outcome;
      }
    } catch {
      // keep polling
    }
    return null;
  }

  /**
   * Finalize held settlement only from official Gamma Up/Down (~1/~0 payout).
   * No token-mark / portfolio fallback — cards stay Open until Gamma resolves.
   */
  private applyHeldSettlementToCard(
    card: TradingPositionCard,
    officialOutcome: "up" | "down",
  ): boolean {
    if (officialOutcome !== "up" && officialOutcome !== "down") return false;
    if (!isValidSharePrice(card.buyPrice) || !isValidShareSize(card.shares)) return false;

    const won = card.side === officialOutcome;
    card.outcome = officialOutcome;
    card.status = won ? "win" : "loss";
    card.pl = feeAwarePlHeld(card, won);
    card.confirmed = true;
    const tid = typeof card.triggerId === "string" ? card.triggerId.trim() : "";
    if (tid && card.source === "trigger") {
      void this.clearTriggerLiveUi(tid);
    }
    return true;
  }

  /**
   * Settle a held card from Gamma only (same source as recordings / Open Replay Official).
   */
  private async trySettleHeldCardFromGamma(card: TradingPositionCard): Promise<boolean> {
    if (!isValidSharePrice(card.buyPrice) || !isValidShareSize(card.shares)) return false;
    if (!Number.isFinite(card.buyCost) || card.buyCost <= 0) {
      card.buyCost = card.shares * card.buyPrice;
    }
    if (card.buyFees == null) {
      card.buyFees = await estimateLiveTakerFee(
        this.userId,
        card.asset,
        card.shares,
        card.buyPrice,
      );
    }
    const officialOutcome = await this.fetchOfficialMarketOutcome(card);
    if (!officialOutcome) return false;
    return this.applyHeldSettlementToCard(card, officialOutcome);
  }

  private async settleOpenCardsForWindow(windowKey: string): Promise<boolean> {
    const openCards = this.positionCards.filter(
      (card) => card.windowKey === windowKey && card.status === "open",
    );
    if (openCards.length === 0) return false;

    let settledCount = 0;
    for (const card of openCards) {
      if (await this.trySettleHeldCardFromGamma(card)) {
        settledCount += 1;
        continue;
      }
      // Still unresolved — leave Open; confirm loop hard-polls 20m then light retries.
      card.confirmed = false;
    }

    logService.info(
      "trading",
      `Settled ${settledCount}/${openCards.length} held position(s) for prior window` +
        (settledCount < openCards.length
          ? ` (${openCards.length - settledCount} waiting on Gamma)`
          : ""),
    );
    for (const card of openCards) {
      this.persistCardStat(card);
    }
    this.notify();
    this.ensureConfirmLoop();
    return settledCount > 0 || openCards.length > 0;
  }

  private resetWindow(state: LiveWindowState): void {
    const prevKey = this.sessionKey;
    const prevRestings = [...this.restingBuys.values()];
    const prevRestingSell = this.restingSell;
    this.restingBuys.clear();
    this.restingSell = null;
    this.gtdBuyRepressUntilMs = 0;
    this.lastGtdBuyPhaseIdx = -1;
    this.gtdBuyBlockedWindowKey = null;
    this.liveFakWatch = null;
    // Keep pendingBuyCancels — old GTDs may still fill after window roll.
    this.liveAbortedBuyPhases.clear();
    this.livePendingPhaseAborts.clear();
    this.liveCompletedPhaseAbortCancellations.clear();
    this.liveTrackedPhaseIdx = -1;
    this.livePhaseCrossingBaseline = 0;
    this.liveLastPtbCrossings = 0;
    this.gtdSellBlockedWindowKey = null;
    this.gtdSellRepressUntilMs = 0;
    if (isTradingExecutor()) {
      for (const prevResting of prevRestings) {
        if (prevResting.orderId) {
          void this.finishBuyCancel(prevResting, "window roll", state);
        }
      }
      if (prevRestingSell?.orderId) void cancelOpenOrder(this.userId, prevRestingSell.orderId);
    }
    this.positions = { up: null, down: null };
    this.quoteLocks = emptyQuoteLocks();
    this.markers = [];
    this.mirroredMarkerCount = 0;
    this.manualBuyPending = false;
    this.manualBuyOverrideWindowKey = null;
    this.predictionTradeHoldWindowKey = null;
    this.triggerGtdHoldSessionById.clear();
    this.triggerGtdPlacedSessionById.clear();
    this.buyBlockedWindowKey = null;
    this.pendingBuyConfirm = null;
    this.pendingBuyConfirmBackoffMs = 0;
    // Window end clears BUY/SELL highlights (SELL flash also ends).
    this.clearTriggerLiveUiForWindowEnd();
    this.sessionKey = sessionKey(state);
    if (prevKey) {
      void this.settleOpenCardsForWindow(prevKey).then((hadHits) => {
        if (hadHits) {
          // Stats already written via persistCardStat; wait for Mongo flush then refresh placement aggregates.
          void this.statsPersistChain.then(() => this.syncActivatedSchedulePlacements());
        }
      });
    }
    // Keep trying to confirm any pending cards from prior fills
    this.ensureConfirmLoop();
  }

  private ensureWindow(state: LiveWindowState): void {
    const key = sessionKey(state);
    if (this.sessionKey !== key) {
      this.resetWindow(state);
    }
  }

  private lockQuote(side: "up" | "down", leg: "buy" | "sell", price: number): void {
    if (!Number.isFinite(price)) return;
    const key = leg === "buy" ? (`${side}Buy` as const) : (`${side}Sell` as const);
    // Append oldest→newest; UI reverses so newest is on the left.
    this.quoteLocks[key] = [...this.quoteLocks[key], price];
  }

  /** Clear a quote latch (e.g. resting sell cancelled without a fill). */
  private unlockQuote(side: "up" | "down", leg: "buy" | "sell"): void {
    const key = leg === "buy" ? (`${side}Buy` as const) : (`${side}Sell` as const);
    this.quoteLocks[key] = [];
  }

  private addMarker(
    state: LiveWindowState,
    marker: Omit<SimMarker, "windowKey">,
  ): void {
    this.markers.push({ ...marker, windowKey: sessionKey(state) });
  }

  private findCard(id: string): TradingPositionCard | undefined {
    return this.positionCards.find((card) => card.id === id);
  }

  /** True when this phase no longer wants any more auto buys. */
  private buysFullySatisfied(phase: Pick<SimPhaseConfig, "gapVsPtb">): boolean {
    if (gapAllowsSecondSide(phase.gapVsPtb)) {
      return Boolean(this.positions.up && this.positions.down);
    }
    return Boolean(this.positions.up || this.positions.down);
  }

  /** Whether this side may still receive an auto buy under the phase gap mode. */
  private sideStillWantsBuy(
    side: "up" | "down",
    phase: Pick<SimPhaseConfig, "gapVsPtb">,
  ): boolean {
    if (this.positions[side]) return false;
    if (!gapAllowsSecondSide(phase.gapVsPtb) && (this.positions.up || this.positions.down)) {
      return false;
    }
    return true;
  }

  private isBuyBlocked(state: LiveWindowState, phase?: Pick<SimPhaseConfig, "gapVsPtb">): boolean {
    const key = sessionKey(state);
    if (phase ? this.buysFullySatisfied(phase) : this.positions.up || this.positions.down) {
      return true;
    }
    if (this.manualBuyPending) return true;
    if (this.manualBuyOverrideWindowKey === key) return true;
    if (this.predictionTradeHoldWindowKey === key) return true;
    if (this.buyBlockedWindowKey === key) return true;
    if (this.pendingBuyConfirm) return true;
    // Prior-phase GTD cancels continue in the background; do not block the next
    // phase place — early cancel + race-fill harvest cover the overlap.
    return false;
  }

  private blockFurtherBuys(state: LiveWindowState, reason: string): void {
    this.buyBlockedWindowKey = sessionKey(state);
    this.liveFakWatch = null;
    if (!this.isLiveArmed()) this.autoEngine.suppressBuysForWindow();
    logService.warn("trading", `Further buys blocked for window (${reason})`);
  }

  private beginPendingBuyConfirm(
    state: LiveWindowState,
    opts: {
      side: "up" | "down";
      source: "manual" | "auto" | "trigger";
      reason: string;
      orderId?: string;
      tokenId?: string;
      conditionId?: string;
      slug?: string;
      buyPhaseIdx?: number;
      triggerId?: string;
      sharesHint?: number;
      limitPriceHint?: number;
    },
  ): void {
    if (this.pendingBuyConfirm) return;
    if (this.positions.up || this.positions.down) return;
    const nowMs = Date.now();
    this.pendingBuyConfirm = {
      sessionKey: sessionKey(state),
      side: opts.side,
      source: opts.source,
      reason: opts.reason,
      startedAtMs: nowMs,
      // Immediate first check on the next tick / resolve call.
      nextCheckAtMs: nowMs,
      orderId: opts.orderId,
      tokenId: opts.tokenId,
      conditionId: opts.conditionId,
      slug: opts.slug,
      buyPhaseIdx: opts.buyPhaseIdx,
      triggerId: opts.triggerId,
      sharesHint: opts.sharesHint,
      limitPriceHint: opts.limitPriceHint,
    };
    this.liveFakWatch = null;
    if (!this.isLiveArmed()) this.autoEngine.setExternalBuyPaused(true);
    logService.warn(
      "trading",
      `Buy pending confirmation (${opts.reason}) — blocking further buys until resolved`,
    );
  }

  private clearPendingBuyConfirm(resolution: string): void {
    if (!this.pendingBuyConfirm) return;
    this.pendingBuyConfirm = null;
    this.pendingBuyConfirmBackoffMs = 0;
    if (!this.isLiveArmed() && !this.positions.up && !this.positions.down) {
      this.autoEngine.setExternalBuyPaused(false);
    }
    logService.info("trading", `Pending buy cleared (${resolution})`);
  }

  private schedulePendingBuyConfirmRetry(delayMs: number): void {
    if (!this.pendingBuyConfirm) return;
    this.pendingBuyConfirm.nextCheckAtMs = Date.now() + delayMs;
  }

  private notePendingBuyConfirmRateLimit(): void {
    this.pendingBuyConfirmBackoffMs = Math.min(
      120_000,
      Math.max(15_000, this.pendingBuyConfirmBackoffMs * 2 || 15_000),
    );
    this.schedulePendingBuyConfirmRetry(this.pendingBuyConfirmBackoffMs);
    logService.warn(
      "trading",
      `Pending buy confirm rate-limited; backing off ${Math.round(this.pendingBuyConfirmBackoffMs / 1000)}s`,
    );
  }

  private isClearlyUnfilledOrderStatus(status: string): boolean {
    const s = status.toLowerCase();
    return (
      s === "cancelled" ||
      s === "canceled" ||
      s === "unmatched" ||
      s === "expired"
    );
  }

  /**
   * Poll CLOB order + positions only while a buy is pending confirmation.
   * No preempt / every-tick position scans.
   */
  private async resolvePendingBuyConfirm(
    state: LiveWindowState,
    nowMs?: number,
  ): Promise<void> {
    const pending = this.pendingBuyConfirm;
    if (!pending) return;
    if (!isTradingExecutor()) return;

    if (this.positions.up || this.positions.down) {
      this.clearPendingBuyConfirm("local position already recorded");
      return;
    }

    const now = nowMs ?? Date.now();
    if (now < pending.nextCheckAtMs) return;

    // Mark next healthy poll time up front so overlapping ticks don't stampede.
    pending.nextCheckAtMs = now + PENDING_BUY_CONFIRM_POLL_MS;

    try {
      if (pending.orderId) {
        const snap = await fetchOpenOrder(this.userId, pending.orderId);
        if (snap) {
          const matched = Math.max(0, snap.sizeMatched);
          const status = snap.status.toLowerCase();
          if (matched > 0 || status === "matched") {
            const fillShares =
              matched > 0 ? matched : Math.max(1, pending.sharesHint ?? 0);
            const fillPrice =
              snap.price > 0
                ? snap.price
                : pending.limitPriceHint && pending.limitPriceHint > 0
                  ? pending.limitPriceHint
                  : 0;
            if (isValidShareSize(fillShares) && isValidSharePrice(fillPrice)) {
              const tokenId = pending.tokenId ?? snap.assetId;
              const conditionId = pending.conditionId ?? snap.market;
              logService.warn(
                "trading",
                `Pending buy confirmed via order: ${pending.side.toUpperCase()} ${fillShares} sh @ ${(fillPrice * 100).toFixed(1)}¢`,
              );
              await this.noteFillSuccess(pending.orderId);
              await this.recordBuyFill(
                state,
                pending.side,
                fillShares,
                fillPrice,
                fillShares * fillPrice,
                tokenId,
                conditionId,
                pending.slug,
                pending.source,
                undefined,
                pending.buyPhaseIdx,
                pending.triggerId ? { triggerId: pending.triggerId } : undefined,
              );
              if (!this.isLiveArmed()) {
                const nowSec = Math.floor(Date.now() / 1000);
                this.autoEngine.adoptExternalBuy(
                  state,
                  pending.side,
                  fillShares,
                  fillPrice,
                  pending.buyPhaseIdx ?? 0,
                  nowSec,
                );
                this.autoEngine.suppressBuysForWindow();
              }
              this.clearPendingBuyConfirm("order filled");
              return;
            }
          }
          if (this.isClearlyUnfilledOrderStatus(status) && matched <= 0) {
            // Still verify positions once — race fill can land after cancel.
            // Fall through to positions check below.
          } else if (status === "live" || status === "delayed") {
            this.schedulePendingBuyConfirmRetry(PENDING_BUY_CONFIRM_POLL_MS);
            return;
          }
        }
      }

      const pair = await fetchCurrentUpDownMarket(state.series);
      const conditionId = pending.conditionId ?? pair.conditionId;
      const rows = await fetchUserPositions(this.userId, {
        conditionId,
        sizeThreshold: 0,
      });
      this.pendingBuyConfirmBackoffMs = 0;

      for (const side of SIDES_ORDER) {
        const sideToken = side === "up" ? pair.yesTokenId : pair.noTokenId;
        const sideMatch = findPosition(rows, {
          asset: sideToken,
          conditionId,
        });
        if (!sideMatch) continue;
        const shares = Number(sideMatch.size);
        const price = Number(sideMatch.avgPrice);
        if (!isValidShareSize(shares) || !isValidSharePrice(price)) continue;
        const cost = Number(sideMatch.initialValue ?? shares * price);
        logService.warn(
          "trading",
          `Pending buy confirmed on-chain: ${side.toUpperCase()} ${shares} sh @ ${(price * 100).toFixed(1)}¢`,
        );
        await this.noteFillSuccess(pending.orderId);
        await this.recordBuyFill(
          state,
          side,
          shares,
          price,
          cost,
          sideToken,
          conditionId,
          sideMatch.slug ?? pending.slug ?? pair.slug,
          pending.source,
          undefined,
          pending.buyPhaseIdx,
          pending.triggerId ? { triggerId: pending.triggerId } : undefined,
        );
        if (!this.isLiveArmed()) {
          const nowSec = Math.floor(Date.now() / 1000);
          this.autoEngine.adoptExternalBuy(
            state,
            side,
            shares,
            price,
            pending.buyPhaseIdx ?? 0,
            nowSec,
          );
          this.autoEngine.suppressBuysForWindow();
        }
        this.clearPendingBuyConfirm("on-chain position found");
        return;
      }

      // Successful empty positions read: if order is clearly dead (or no order id
      // after at least one successful empty scan), release the buy lock.
      if (pending.orderId) {
        const snap = await fetchOpenOrder(this.userId, pending.orderId);
        const status = snap?.status?.toLowerCase() ?? "";
        const matched = Math.max(0, snap?.sizeMatched ?? 0);
        if (snap && this.isClearlyUnfilledOrderStatus(status) && matched <= 0) {
          this.clearPendingBuyConfirm("order unfilled, no on-chain position");
          return;
        }
        if (!snap && now - pending.startedAtMs >= 15_000) {
          // Order vanished from open book and positions empty — treat as no fill.
          this.clearPendingBuyConfirm("order gone, no on-chain position");
          return;
        }
      } else if (now - pending.startedAtMs >= 15_000) {
        // Ambiguous post with no order id: after a successful empty positions
        // read and a short settle window, allow buys again.
        this.clearPendingBuyConfirm("no on-chain position after settle window");
        return;
      }

      this.schedulePendingBuyConfirmRetry(PENDING_BUY_CONFIRM_POLL_MS);
    } catch (err) {
      const message = String(err);
      const isRateLimited = /\b429\b/.test(message) || /rate.?limit/i.test(message);
      if (isRateLimited) {
        this.notePendingBuyConfirmRateLimit();
      } else {
        logService.warn("trading", `Pending buy confirm failed: ${message}`);
        this.schedulePendingBuyConfirmRetry(PENDING_BUY_CONFIRM_POLL_MS);
      }
    }
  }

  /**
   * Live placement covering the current UTC slot for Trigger Trade attribution.
   * Independent of Use Schedule (phase Auto Trade still requires that switch).
   */
  private async resolveLivePlacementIdForTriggers(): Promise<string | undefined> {
    if (this.config.useSchedule && this.scheduleContext?.placementId) {
      return this.scheduleContext.placementId;
    }
    try {
      const next = await findActiveScheduleContext(this.userId, this.boundSeries);
      return next?.placementId;
    } catch {
      return undefined;
    }
  }

  async refreshScheduleContext(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.scheduleContextFetchedAt < 5000) return;
    this.scheduleContextFetchedAt = now;

    const prevPlacementId = this.scheduleContext?.placementId ?? null;
    const prevVisible = this.shouldShowPhases();

    if (!this.config.autoTrade || !this.config.useSchedule) {
      this.scheduleContext = null;
      this.activePhaseSetup = null;
    } else {
      try {
        const next = await findActiveScheduleContext(this.userId, this.boundSeries);
        if (next) {
          this.scheduleContext = next;
          this.activePhaseSetup = next.setup;
        } else if (this.scheduleContext && isScheduleContextActive(this.scheduleContext)) {
          // Keep last known setup across transient empty lookups (DB flake, brief gaps).
        } else {
          this.scheduleContext = null;
          this.activePhaseSetup = null;
        }
      } catch {
        // Keep previous context on fetch errors so phases don't blink off mid-window.
      }
    }

    const nextPlacementId = this.scheduleContext?.placementId ?? null;
    // Do not run syncActivatedSchedulePlacements on this 5s cadence — pruning/gap-fill
    // + notify was flipping active-card stats (zeros ↔ dashes) every refresh.
    // Activation sync runs on hydrate, live arming, and settlement instead.
    if (
      this.config.startTrading &&
      this.config.autoTrade &&
      this.config.useSchedule &&
      nextPlacementId
    ) {
      this.rememberActivatedPlacement(nextPlacementId, { quiet: true });
    }
    if (prevVisible !== this.shouldShowPhases() || prevPlacementId !== nextPlacementId) {
      this.notify();
    }
  }

  private resolveAutoSimSetup(state: LiveWindowState): SimSetup | null {
    if (!this.config.autoTrade) return null;
    if (this.config.useSchedule) {
      if (!this.activePhaseSetup) return null;
      const latency = state.feedLatencyMs ?? simulatorService.getSetup().latencyMs;
      const duration =
        state.windowStart && state.windowEnd ? state.windowEnd - state.windowStart : 300;
      return phaseSetupToSimSetup(this.activePhaseSetup, latency, duration);
    }
    return simulatorService.getSetup();
  }

  async tick(state: LiveWindowState, nowMs?: number): Promise<void> {
    // Defer tickUnlocked until the previous tick fully finishes — do not start it eagerly.
    const queued = this.tickQueue.then(
      () => this.tickUnlocked(state, nowMs),
      () => this.tickUnlocked(state, nowMs),
    );
    this.tickQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    await queued;
  }

  /**
   * Bind this engine to a market series: load that market's trading config + schedule.
   * Cancels resting orders when switching away from a previously armed market.
   */
  async ensureBoundToSeries(seriesInput: string): Promise<void> {
    const series = String(seriesInput || DEFAULT_MARKET_SERIES).trim() || DEFAULT_MARKET_SERIES;
    if (series === this.boundSeries) return;

    if (this.restingBuys.size > 0) await this.cancelAllRestingBuys("market switch");
    if (this.triggerRestingBuys.size > 0) {
      await this.cancelAllTriggerRestingBuys("market switch");
    }
    if (this.restingSell) await this.cancelRestingSell("market switch");

    this.boundSeries = series;
    this.scheduleContext = null;
    this.activePhaseSetup = null;
    await this.loadPersistedConfig({ hydrateStats: false, series });
    await this.reloadPositionCardsForBoundSeries();
    await this.reloadTriggerLiveUiFromMongo();
    await this.refreshScheduleContext(true);
    this.notify();
  }

  /** Swap Positions UI RAM to the bound market's Mongo cards (Open + last 24h). */
  private async reloadPositionCardsForBoundSeries(): Promise<void> {
    try {
      await pruneExpiredSettledPositionCards(this.userId, this.boundSeries).catch(() => 0);
      const uiCards = await listPositionCards(this.userId, { series: this.boundSeries });
      this.positionCards = trimPositionCardsForUi(uiCards);
    } catch (err) {
      logService.warn("trading", `Failed to reload position cards for ${this.boundSeries}: ${String(err)}`);
    }
  }

  private lastUiMongoSyncMs = 0;

  private positionsUiFingerprint(): string {
    return this.positionCards
      .map(
        (c) =>
          `${c.id}:${c.status}:${c.shares ?? ""}:${c.pl ?? ""}:${c.demo ? 1 : 0}`,
      )
      .join("|");
  }

  private triggerLiveUiFingerprint(): string {
    return [...this.triggerLiveUiById.entries()]
      .map(([id, live]) => {
        if (!live) return `${id}:null`;
        return `${id}:${live.side}:${live.buy?.price ?? ""}:${live.sell?.price ?? ""}:${live.sell?.atMs ?? ""}`;
      })
      .join("|");
  }

  /**
   * Pull Positions + trigger BUY/SELL highlight from Mongo into RAM.
   * Used so localhost (non-executor) reflects Clear / opens done on Heroku.
   */
  async syncUiStateFromMongo(options?: { force?: boolean; minIntervalMs?: number }): Promise<void> {
    const minInterval = options?.minIntervalMs ?? 5_000;
    const now = Date.now();
    if (!options?.force && now - this.lastUiMongoSyncMs < minInterval) return;
    this.lastUiMongoSyncMs = now;
    const beforePos = this.positionsUiFingerprint();
    const beforeLive = this.triggerLiveUiFingerprint();
    await this.reloadPositionCardsForBoundSeries();
    await this.reloadTriggerLiveUiFromMongo();
    if (
      beforePos !== this.positionsUiFingerprint() ||
      beforeLive !== this.triggerLiveUiFingerprint()
    ) {
      this.notify();
    }
  }

  private async tickUnlocked(state: LiveWindowState, nowMs?: number): Promise<void> {
    // Never rebind from a shared display/feed series — each engine stays on its
    // own boundSeries (set via ensureBoundToSeries from that user's API).
    const feedSeries =
      String(state.series || "").trim() || this.boundSeries || DEFAULT_MARKET_SERIES;
    if (feedSeries !== this.boundSeries) return;

    const prevSessionKey = this.sessionKey;
    this.ensureWindow(state);
    const windowRolled = prevSessionKey != null && prevSessionKey !== this.sessionKey;
    await this.refreshScheduleContext(windowRolled);
    await this.resolvePendingBuyConfirm(state, nowMs);

    // Prediction / Trigger GTD sells must poll / retry even when Auto Trade is off / phase tick is paused.
    if (!this.orderInFlight) {
      if (this.restingSell?.source === "prediction" || this.restingSell?.source === "trigger") {
        await this.pollRestingSell(state);
      } else if (
        this.config.predictionSellOrderType === "GTD" &&
        this.predictionTradeHoldWindowKey === sessionKey(state)
      ) {
        const side = this.positions.up ? "up" : this.positions.down ? "down" : null;
        const pos = side ? this.positions[side] : null;
        if (side && pos) {
          await this.ensurePredictionGtdSell(state, side, pos.avgPrice, pos.shares);
        }
      }
    }

    if (!this.config.autoTrade) {
      return;
    }

    const autoSetup = this.resolveAutoSimSetup(state);
    if (!autoSetup) {
      // Still commit the prior window's demo result when leaving a schedule slot.
      if (!this.isLiveArmed()) this.autoEngine.rollWindowIfNeeded(state);
      return;
    }

    // Prediction / Trigger Trade open: pause phase Auto Trade until that position sells.
    if (this.predictionTradeHoldWindowKey === sessionKey(state)) {
      if (this.restingBuys.size > 0) {
        await this.cancelAllRestingBuys("prediction trade hold");
      }
      // Keep Prediction/Trigger GTD resting sell; cancel only phase rests.
      if (
        this.restingSell &&
        this.restingSell.source !== "prediction" &&
        this.restingSell.source !== "trigger"
      ) {
        await this.cancelRestingSell("prediction trade hold", state);
      }
      if (!this.isLiveArmed()) {
        this.autoEngine.setExternalBuyPaused(true);
      }
      return;
    }

    // Live-armed: do not tick or log via SimulatorEngine — live owns FAK/GTD/abort.
    if (this.isLiveArmed()) {
      await this.sweepPendingBuyCancels(state, nowMs);
      await this.syncLivePhaseCrossingAbort(state, autoSetup, nowMs);
      await this.manageLiveOptimizeBuys(state, autoSetup, nowMs);
      await this.manageRestingGtdBuys(state, autoSetup, nowMs);
      await this.manageRestingGtdSells(state, autoSetup, nowMs);
      return;
    }

    // Preview / demo: simulator drives markers and logs.
    this.autoEngine.tick(state, autoSetup, nowMs);
    this.mirroredMarkerCount = this.autoEngine
      .getMarkers()
      .filter((m) => m.windowKey === sessionKey(state)).length;
    if (this.restingBuys.size > 0 && !this.config.startTrading) {
      await this.cancelAllRestingBuys("startTrading off");
    }
    if (this.triggerRestingBuys.size > 0 && !this.config.startTrading) {
      await this.cancelAllTriggerRestingBuys("startTrading off");
    }
    if (this.restingSell && !this.config.startTrading) {
      await this.cancelRestingSell("startTrading off", state);
    }
  }

  private liveAskCents(state: LiveWindowState, side: "up" | "down"): number | null {
    const ask = side === "up" ? state.yesAsk : state.noAsk;
    if (ask == null || !Number.isFinite(ask)) return null;
    return priceToCents(ask);
  }

  private isLivePhaseBuyAborted(phaseIdx: number): boolean {
    return this.liveAbortedBuyPhases.has(phaseIdx);
  }

  private isLivePhaseAbortCancellationDue(phaseIdx: number): boolean {
    return this.liveCompletedPhaseAbortCancellations.has(phaseIdx);
  }

  private async syncLivePhaseCrossingAbort(
    state: LiveWindowState,
    setup: SimSetup,
    nowMs?: number,
  ): Promise<void> {
    const now = nowMs ?? state.lastTickMs ?? Date.now();
    const nowSec = Math.floor(now / 1000);
    const phaseIdx = phaseIndexForState(state, setup.phaseSplit, nowSec);
    const phase = setup.phases[phaseIdx] ?? setup.phases[0];
    const crossings = Math.max(0, Math.floor(state.ptbCrossings ?? 0));

    if (this.liveTrackedPhaseIdx !== phaseIdx) {
      const firstObservedPhase = this.liveTrackedPhaseIdx < 0;
      this.liveTrackedPhaseIdx = phaseIdx;
      this.livePhaseCrossingBaseline = firstObservedPhase
        ? crossings
        : this.liveLastPtbCrossings;
      this.liveFakWatch = null;
    }
    this.liveLastPtbCrossings = crossings;

    for (const [idx, executeAtMs] of this.livePendingPhaseAborts) {
      if (now < executeAtMs) continue;
      this.livePendingPhaseAborts.delete(idx);
      this.liveCompletedPhaseAbortCancellations.add(idx);
      if (this.liveFakWatch?.phaseIdx === idx) this.liveFakWatch = null;
      for (const side of SIDES_ORDER) {
        const resting = this.restingBuys.get(side);
        if (resting?.phaseIdx === idx) {
          await this.cancelRestingBuySide(side, "PTB crossing abort", now, state);
        }
      }
      logService.info("trading", `Phase ${idx + 1} PTB-crossing cancellation executed`);
    }

    const threshold = Math.max(0, Math.min(1000, Math.floor(phase.buyAbortOnCrossing || 0)));
    if (
      threshold <= 0 ||
      this.liveAbortedBuyPhases.has(phaseIdx) ||
      this.livePendingPhaseAborts.has(phaseIdx) ||
      crossings - this.livePhaseCrossingBaseline < threshold
    ) {
      return;
    }

    this.liveAbortedBuyPhases.add(phaseIdx);
    if (this.liveFakWatch?.phaseIdx === phaseIdx) this.liveFakWatch = null;
    logService.info(
      "trading",
      `Phase ${phaseIdx + 1} buys aborted after PTB crossing threshold`,
    );

    const latency = Math.max(0, setup.latencyMs ?? state.feedLatencyMs ?? 0);
    if (latency <= 0) {
      this.liveCompletedPhaseAbortCancellations.add(phaseIdx);
      for (const side of SIDES_ORDER) {
        const resting = this.restingBuys.get(side);
        if (resting?.phaseIdx === phaseIdx) {
          await this.cancelRestingBuySide(side, "PTB crossing abort", now, state);
        }
      }
      logService.info("trading", `Phase ${phaseIdx + 1} PTB-crossing cancellation executed`);
      return;
    }
    this.livePendingPhaseAborts.set(phaseIdx, now + latency);
    logService.info(
      "trading",
      `Phase ${phaseIdx + 1} buy abort scheduled, latency ${latency} ms`,
    );
  }

  /** Live optimize/FAK buys — same arm/hunt rules as sim, without running SimulatorEngine. */
  private async manageLiveOptimizeBuys(
    state: LiveWindowState,
    setup: SimSetup,
    nowMs?: number,
  ): Promise<void> {
    const nowSec = Math.floor((nowMs ?? state.lastTickMs ?? Date.now()) / 1000);
    const phaseIdx = phaseIndexForState(state, setup.phaseSplit, nowSec);
    const phase = setup.phases[phaseIdx] ?? setup.phases[0];

    if (this.orderInFlight || this.buysFullySatisfied(phase)) {
      this.liveFakWatch = null;
      return;
    }
    if (this.isBuyBlocked(state, phase) || this.manualBuyPending) {
      this.liveFakWatch = null;
      return;
    }
    if (this.restingBuys.size > 0) {
      this.liveFakWatch = null;
      return;
    }

    if (this.liveFakWatch && this.liveFakWatch.phaseIdx !== phaseIdx) {
      this.liveFakWatch = null;
    }
    if (this.liveFakWatch && !this.sideStillWantsBuy(this.liveFakWatch.side, phase)) {
      this.liveFakWatch = null;
    }

    if (
      !phase.buyOptimize ||
      !phase.buyEnabled ||
      this.isLivePhaseBuyAborted(phaseIdx)
    ) {
      this.liveFakWatch = null;
      return;
    }

    if (!this.liveFakWatch) {
      const shares = Math.max(1, phase.buyShares || 1);
      const triggerCents = phase.buyTrigger;
      for (const side of SIDES_ORDER) {
        if (!this.sideStillWantsBuy(side, phase)) continue;
        const askCents = this.liveAskCents(state, side);
        if (askCents == null || askCents !== triggerCents) continue;
        if (!gapAllowsBuy(side, phase, state.assetGap)) continue;
        this.liveFakWatch = {
          side,
          phaseIdx,
          shares,
          triggerCents,
          armed: true,
          stallCents: null,
          stallTicks: 0,
          prevAskCents: askCents,
          lastBookSampleCount: state.bookTickSequence ?? 0,
        };
        logService.info(
          "trading",
          `FAK optimize armed: ${side} touched ${triggerCents}¢`,
        );
        return;
      }
      return;
    }

    const w = this.liveFakWatch;
    const askCents = this.liveAskCents(state, w.side);
    if (askCents == null) return;

    const bookSampleCount = state.bookTickSequence ?? 0;
    if (bookSampleCount <= w.lastBookSampleCount) return;
    w.lastBookSampleCount = bookSampleCount;

    if (askCents > w.triggerCents) {
      w.armed = false;
      w.stallCents = null;
      w.stallTicks = 0;
      w.prevAskCents = askCents;
      return;
    }

    if (!w.armed) {
      if (askCents !== w.triggerCents) {
        w.prevAskCents = askCents;
        return;
      }
      w.armed = true;
      w.stallCents = null;
      w.stallTicks = 0;
      w.prevAskCents = askCents;
      logService.info("trading", `FAK optimize re-armed: ${w.side} @ ${w.triggerCents}¢`);
      return;
    }

    let shouldFire = false;
    if (askCents <= w.triggerCents) {
      if (w.prevAskCents != null && askCents > w.prevAskCents) {
        shouldFire = true;
      } else if (w.stallCents === askCents) {
        w.stallTicks += 1;
        if (w.stallTicks >= 3) shouldFire = true;
      } else {
        w.stallCents = askCents;
        w.stallTicks = 1;
      }
    }
    w.prevAskCents = askCents;
    if (!shouldFire) return;

    logService.info(
      "trading",
      `FAK buy firing: ${w.side} up to ${w.shares} sh @ ≤${w.triggerCents}¢`,
    );
    const result = await this.executeOrder(
      state,
      w.side,
      "buy",
      w.shares,
      "auto",
      "shares",
      "FAK",
      centsToPrice(w.triggerCents),
      phaseIdx,
    );
    // Keep the watch only for clearly-unfilled retries; pending/block clears via isBuyBlocked.
    if (result.ok || this.isBuyBlocked(state, phase) || !this.sideStillWantsBuy(w.side, phase)) {
      this.liveFakWatch = null;
    }
  }

  private async cancelAllRestingBuys(
    reason: string,
    nowMs?: number,
    state?: LiveWindowState,
  ): Promise<void> {
    for (const side of SIDES_ORDER) {
      if (this.restingBuys.has(side)) {
        await this.cancelRestingBuySide(side, reason, nowMs, state);
      }
    }
  }

  private async cancelRestingBuySide(
    side: "up" | "down",
    reason: string,
    nowMs?: number,
    state?: LiveWindowState,
  ): Promise<void> {
    const resting = this.restingBuys.get(side);
    if (!resting) return;
    // Drop local tracking immediately so we never re-manage / leave it as "active"
    // in the next phase — but keep working the CLOB cancel until confirmed.
    this.restingBuys.delete(side);
    if (isRoutineGtdCancelReason(reason)) {
      this.gtdBuyRepressUntilMs = (nowMs ?? Date.now()) + GTD_FILTER_REPRESS_MS;
    }
    logService.info(
      "trading",
      `Cancel resting GTD (${reason}) ${resting.side.toUpperCase()} ${resting.shares} sh @ ${(resting.limitPrice * 100).toFixed(0)}¢ [phase ${((resting.phaseIdx ?? 0) + 1)}]`,
    );
    if (!this.positions.up && !this.positions.down && this.restingBuys.size === 0) {
      this.autoEngine.setExternalBuyPaused(false);
    }
    if (!isTradingExecutor()) return;
    await this.finishBuyCancel(resting, reason, state, nowMs);
  }

  /** After a fill under First: cancel the sibling resting GTD immediately. */
  private async cancelSiblingRestingAfterFirstFill(
    filledSide: "up" | "down",
    phase: Pick<SimPhaseConfig, "gapVsPtb">,
    nowMs?: number,
    state?: LiveWindowState,
  ): Promise<void> {
    if (phase.gapVsPtb !== "first") return;
    const other = filledSide === "up" ? "down" : "up";
    if (!this.restingBuys.has(other)) return;
    await this.cancelRestingBuySide(other, "first fill — cancel other", nowMs, state);
  }

  private async cancelRestingSell(
    reason: string,
    state?: LiveWindowState,
  ): Promise<void> {
    const resting = this.restingSell;
    if (!resting) return;
    this.restingSell = null;
    // Resting sell placement must not look like a fill — clear any stale sell latch.
    this.unlockQuote(resting.side, "sell");
    logService.info("trading", `Cancel resting GTD sell (${reason})`);
    if (!isTradingExecutor()) return;
    if (state) {
      await this.maybeNoteGtdTouch(state, resting, "sell");
    }
    await cancelOpenOrder(this.userId, resting.orderId);
    const snap = await fetchOpenOrder(this.userId, resting.orderId);
    const matched = Math.max(0, snap?.sizeMatched ?? 0);
    if (matched > resting.sizeMatched + 1e-9 && state) {
      const delta = matched - resting.sizeMatched;
      const fillPrice =
        snap && snap.price > 0 ? snap.price : resting.limitPrice;
      await this.noteFillSuccess(resting.orderId);
      await this.recordSellFill(
        state,
        resting.side,
        delta,
        fillPrice,
        delta * fillPrice,
        resting.tokenId ?? snap?.assetId,
        resting.conditionId ?? snap?.market,
        undefined,
      );
      return;
    }
    await this.noteFillClose(resting.orderId);
  }

  /**
   * Cancel on the CLOB, then re-check for a race fill. If the order is still live,
   * queue retries so a phase-1 5¢ GTD cannot silently fill in phase 2.
   */
  private async finishBuyCancel(
    resting: PendingBuyCancel["resting"] & { levelTouched?: boolean },
    reason: string,
    state: LiveWindowState | undefined,
    nowMs?: number,
  ): Promise<void> {
    const now = nowMs ?? Date.now();
    if (state) {
      await this.maybeNoteGtdTouch(state, resting, "buy");
    }
    if (state && (await this.harvestBuyCancelFill(resting, state))) {
      return;
    }

    // Reason already logged by cancelRestingBuy.
    const result = await cancelOpenOrder(this.userId, resting.orderId, { quiet: true });

    if (state && (await this.harvestBuyCancelFill(resting, state))) {
      return;
    }

    const snap = await fetchOpenOrder(this.userId, resting.orderId);
    const status = snap?.status?.toLowerCase() ?? "";
    const stillOpen = status === "live" || status === "delayed";
    if (!result.ok || stillOpen) {
      this.enqueueBuyCancel(resting, reason, now + 400);
      if (!result.ok) {
        logService.warn(
          "trading",
          `GTD buy cancel queued for retry (${reason}): ${result.error ?? "still open"}`,
        );
      }
      return;
    }
    await this.noteFillClose(resting.orderId);
  }

  private enqueueBuyCancel(
    resting: PendingBuyCancel["resting"],
    reason: string,
    nextAttemptMs: number,
    attempts = 1,
  ): void {
    if (this.pendingBuyCancels.some((p) => p.resting.orderId === resting.orderId)) return;
    this.pendingBuyCancels.push({
      resting: { ...resting },
      reason,
      attempts,
      nextAttemptMs,
      kind: "phase",
    });
  }

  /** If the order filled (fully or partially) while cancelling, record it. */
  private async harvestBuyCancelFill(
    resting: PendingBuyCancel["resting"],
    state: LiveWindowState,
  ): Promise<boolean> {
    const snap = await fetchOpenOrder(this.userId, resting.orderId);
    if (!snap) return false;

    const matched = Math.max(0, snap.sizeMatched);
    if (matched > resting.sizeMatched + 1e-9) {
      const delta = matched - resting.sizeMatched;
      const fillPrice = snap.price > 0 ? snap.price : resting.limitPrice;
      resting.sizeMatched = matched;
      resting.tokenId = resting.tokenId ?? snap.assetId;
      resting.conditionId = resting.conditionId ?? snap.market;

      logService.warn(
        "trading",
        `GTD buy filled during cancel (${resting.side} ${delta} sh @ ~${(fillPrice * 100).toFixed(1)}¢) — recording race fill`,
      );
      await this.noteFillSuccess(resting.orderId);
      await this.recordBuyFill(
        state,
        resting.side,
        delta,
        fillPrice,
        delta * fillPrice,
        resting.tokenId,
        resting.conditionId,
        resting.slug,
        "auto",
        resting.cardId,
        resting.phaseIdx,
        { placementId: resting.placementId },
      );
      const setup = this.resolveAutoSimSetup(state);
      const phase = setup?.phases[resting.phaseIdx ?? 0];
      if (phase) {
        await this.cancelSiblingRestingAfterFirstFill(resting.side, phase, undefined, state);
      }
      // Fully matched → nothing left to cancel.
      const status = snap.status.toLowerCase();
      if (status !== "live" && status !== "delayed") return true;
      if (matched + 1e-9 >= resting.shares) return true;
    }

    const status = snap.status.toLowerCase();
    return status !== "live" && status !== "delayed";
  }

  private async sweepPendingBuyCancels(
    state: LiveWindowState,
    nowMs?: number,
  ): Promise<void> {
    if (!isTradingExecutor() || this.pendingBuyCancels.length === 0) return;
    const now = nowMs ?? Date.now();
    const due = this.pendingBuyCancels.filter((p) => now >= p.nextAttemptMs);
    if (due.length === 0) return;

    const remaining: PendingBuyCancel[] = this.pendingBuyCancels.filter(
      (p) => now < p.nextAttemptMs,
    );
    this.pendingBuyCancels = remaining;

    for (const item of due) {
      await this.maybeNoteGtdTouch(state, item.resting, "buy");
      if (await this.harvestBuyCancelFill(item.resting, state)) {
        continue;
      }
      if (item.attempts >= 8) {
        logService.warn(
          "trading",
          `Giving up GTD buy cancel after ${item.attempts} tries (${item.resting.orderId.slice(0, 10)}…)`,
        );
        // Last-ditch cancel; confirm any race fill via pending buy poll.
        void cancelOpenOrder(this.userId, item.resting.orderId, { quiet: true });
        await this.noteFillClose(item.resting.orderId);
        if (!this.positions.up && !this.positions.down) {
          this.beginPendingBuyConfirm(state, {
            side: item.resting.side,
            source: "auto",
            reason: `GTD cancel abandoned (${item.resting.orderId.slice(0, 10)}…)`,
            orderId: item.resting.orderId,
            tokenId: item.resting.tokenId,
            conditionId: item.resting.conditionId,
            slug: item.resting.slug,
            buyPhaseIdx: item.resting.phaseIdx,
            sharesHint: item.resting.shares,
            limitPriceHint: item.resting.limitPrice,
          });
        }
        continue;
      }
      const result = await cancelOpenOrder(this.userId, item.resting.orderId, { quiet: true });
      if (await this.harvestBuyCancelFill(item.resting, state)) {
        continue;
      }
      const snap = await fetchOpenOrder(this.userId, item.resting.orderId);
      const status = snap?.status?.toLowerCase() ?? "";
      if (status === "live" || status === "delayed" || !result.ok) {
        if (item.attempts === 1 || item.attempts % 3 === 0) {
          logService.warn(
            "trading",
            `GTD buy cancel retry ${item.attempts} (${item.resting.orderId.slice(0, 10)}… still ${status || "unknown"})`,
          );
        }
        this.enqueueBuyCancel(
          item.resting,
          item.reason,
          now + Math.min(5_000, 400 * item.attempts),
          item.attempts + 1,
        );
      } else {
        await this.noteFillClose(item.resting.orderId);
      }
    }
  }

  private async manageRestingGtdBuys(
    state: LiveWindowState,
    setup: SimSetup,
    nowMs?: number,
  ): Promise<void> {
    if (this.manualBuyPending || this.manualBuyOverrideWindowKey === sessionKey(state)) return;
    if (this.buyBlockedWindowKey === sessionKey(state)) {
      if (this.restingBuys.size > 0) await this.cancelAllRestingBuys("buy blocked", nowMs, state);
      return;
    }

    const now = nowMs ?? state.lastTickMs ?? Date.now();
    const nowSec = Math.floor(now / 1000);
    const phaseIdx = phaseIndexForState(state, setup.phaseSplit, nowSec);
    const phase = setup.phases[phaseIdx] ?? setup.phases[0];
    const key = sessionKey(state);
    const crossingAborted = this.isLivePhaseBuyAborted(phaseIdx);
    const preCancelForNextPhase = shouldPreCancelGtdForNextPhase(
      state,
      setup.phaseSplit,
      phaseIdx,
      nowSec,
    );

    // Phase boundary must not inherit gap-filter repress from the prior phase.
    if (this.lastGtdBuyPhaseIdx !== phaseIdx) {
      this.lastGtdBuyPhaseIdx = phaseIdx;
      this.gtdBuyRepressUntilMs = 0;
    }

    // Always cancel stale resting buys even while another order is in flight —
    // skipping this left phase-1 limits live into phase 2/3.
    for (const side of SIDES_ORDER) {
      const r = this.restingBuys.get(side);
      if (!r) continue;
      const restingGapOk = gapAllowsBuy(r.side, phase, state.assetGap);
      const endingThisPhase = r.phaseIdx === phaseIdx && preCancelForNextPhase;
      const filledBlocksSibling =
        !gapAllowsSecondSide(phase.gapVsPtb) &&
        Boolean(this.positions.up || this.positions.down) &&
        !this.positions[side];
      if (
        r.sessionKey !== key ||
        r.phaseIdx !== phaseIdx ||
        phase.buyOptimize ||
        !phase.buyEnabled ||
        !restingGapOk ||
        endingThisPhase ||
        filledBlocksSibling ||
        this.positions[side]
      ) {
        await this.cancelRestingBuySide(
          side,
          endingThisPhase
            ? "phase ending"
            : this.positions[side]
              ? "side filled"
              : filledBlocksSibling
                ? "first fill — cancel other"
                : r.phaseIdx !== phaseIdx
                  ? "phase change"
                  : phase.buyOptimize
                    ? "optimize on"
                    : !phase.buyEnabled
                      ? "buy disabled"
                      : !restingGapOk
                        ? describeGapFilterCancelReason(r.side, phase, state.assetGap)
                        : "buy disabled",
          now,
          state,
        );
      }
    }

    // Poll open resting orders for fills (First may cancel sibling mid-poll).
    for (const side of [...SIDES_ORDER]) {
      if (!this.restingBuys.has(side)) continue;
      await this.pollRestingBuySide(side, state, setup, nowMs);
    }

    if (this.orderInFlight) return;
    if (crossingAborted) return;
    // Last seconds of phase 1/2: do not place a fresh GTD that would be cancelled immediately.
    if (preCancelForNextPhase) return;

    // Place GTD when optimize is off and phase allows buys.
    if (phase.buyOptimize || !phase.buyEnabled) return;
    if (this.buysFullySatisfied(phase)) return;
    if (this.isBuyBlocked(state, phase)) return;
    if (this.gtdBuyBlockedWindowKey === key) return;
    if (now < this.gtdBuyRepressUntilMs) return;

    const windowEnd = state.windowEnd ?? nowSec + 300;
    const limitPrice = centsToPrice(phase.buyTrigger);
    const shares = Math.max(1, phase.buyShares || 1);

    for (const side of SIDES_ORDER) {
      if (this.restingBuys.has(side)) continue;
      if (!this.sideStillWantsBuy(side, phase)) continue;
      if (!gapAllowsBuy(side, phase, state.assetGap)) continue;

      this.orderInFlight = true;
      try {
        this.autoEngine.setExternalBuyPaused(true);
        const result = await placeLimitGtdBuy(this.userId, {
          series: state.series,
          side,
          size: shares,
          price: limitPrice,
          expirationSec: gtdExpirationUnix(windowEnd, nowSec),
          state,
          logTag: `phase ${phaseIdx + 1}`,
        });
        if (!result.success || !result.orderId) {
          // Place never rested — not a GTD fill opportunity.
          if (this.restingBuys.size === 0) this.autoEngine.setExternalBuyPaused(false);
          const err = result.error ?? "";
          if (/expiration/i.test(err)) {
            this.gtdBuyBlockedWindowKey = key;
            logService.warn("trading", `GTD buy skipped for rest of window (${err})`);
            return;
          } else if (err) {
            logService.warn("trading", `GTD place failed (${side}): ${err}`);
          }
          continue;
        }

        const immediateFill =
          result.fillShares != null && result.fillPrice != null && result.fillShares > 0;
        await this.noteFillAttempt({
          leg: "buy",
          side,
          series: state.series,
          orderId: result.orderId,
          orderKind: "GTD",
          limitPrice,
          countable: immediateFill,
          touched: immediateFill,
          success: immediateFill,
        });

        if (immediateFill) {
          await this.recordBuyFill(
            state,
            side,
            result.fillShares!,
            result.fillPrice!,
            result.usdcAmount,
            result.tokenId,
            result.conditionId,
            result.slug,
            "auto",
            undefined,
            phaseIdx,
          );
          await this.cancelSiblingRestingAfterFirstFill(side, phase, now, state);
          if (!gapAllowsSecondSide(phase.gapVsPtb)) return;
          continue;
        }

        this.restingBuys.set(side, {
          orderId: result.orderId,
          side,
          phaseIdx,
          sessionKey: key,
          shares,
          limitPrice,
          sizeMatched: 0,
          tokenId: result.tokenId,
          conditionId: result.conditionId,
          slug: result.slug,
          placementId: this.scheduleContext?.placementId,
        });
        this.notify();
      } finally {
        this.orderInFlight = false;
      }
    }
  }

  private async pollRestingBuySide(
    side: "up" | "down",
    state: LiveWindowState,
    setup: SimSetup,
    nowMs?: number,
  ): Promise<void> {
    const resting = this.restingBuys.get(side);
    if (!resting) return;

    const nowSec = Math.floor((nowMs ?? state.lastTickMs ?? Date.now()) / 1000);
    const phaseIdx = phaseIndexForState(state, setup.phaseSplit, nowSec);
    const phase = setup.phases[phaseIdx] ?? setup.phases[0];
    const crossingCancellationDue = this.isLivePhaseAbortCancellationDue(phaseIdx);
    if (!crossingCancellationDue && !gapAllowsBuy(resting.side, phase, state.assetGap)) {
      await this.cancelRestingBuySide(
        side,
        describeGapFilterCancelReason(resting.side, phase, state.assetGap),
        nowMs ?? nowSec * 1000,
        state,
      );
      return;
    }
    await this.maybeNoteGtdTouch(state, resting, "buy");
    const snap = await fetchOpenOrder(this.userId, resting.orderId);
    // Transient fetch failures — keep tracking so we don't double-place.
    if (!snap) return;

    const matched = Math.max(0, snap.sizeMatched);
    if (matched > resting.sizeMatched + 1e-9) {
      const delta = matched - resting.sizeMatched;
      const fillPrice = snap.price > 0 ? snap.price : resting.limitPrice;
      resting.levelTouched = true;
      await this.noteFillSuccess(resting.orderId);
      await this.recordBuyFill(
        state,
        resting.side,
        delta,
        fillPrice,
        delta * fillPrice,
        resting.tokenId ?? snap.assetId,
        resting.conditionId ?? snap.market,
        resting.slug,
        "auto",
        resting.cardId,
        resting.phaseIdx,
        { placementId: resting.placementId },
      );
      await this.cancelSiblingRestingAfterFirstFill(
        resting.side,
        phase,
        nowMs ?? nowSec * 1000,
        state,
      );
      const pos = this.positions[resting.side];
      const still = this.restingBuys.get(side);
      if (still) {
        still.cardId = pos?.cardId ?? still.cardId;
        still.sizeMatched = matched;
        still.tokenId = still.tokenId ?? snap.assetId;
        still.conditionId = still.conditionId ?? snap.market;
        still.levelTouched = true;
      }
    }

    const current = this.restingBuys.get(side);
    if (!current) return;

    const status = snap.status.toLowerCase();
    if (crossingCancellationDue) {
      if (matched > 0) {
        logService.warn(
          "trading",
          `PTB crossing abort lost race to ${matched} GTD fill shares; cancelling remainder`,
        );
      }
      if (status === "live" || status === "delayed") {
        await this.cancelRestingBuySide(side, "PTB crossing abort", nowMs, state);
      } else {
        this.restingBuys.delete(side);
        if (matched <= current.sizeMatched + 1e-9) {
          await this.noteFillClose(current.orderId);
        }
        this.notify();
      }
      return;
    }

    // Still working — leave resting open.
    if (status === "live" || status === "delayed") return;

    // Matched, cancelled, expired, unmatched, etc.
    this.restingBuys.delete(side);
    if (matched <= 1e-9) {
      await this.noteFillClose(current.orderId);
    }
    if (!this.positions.up && !this.positions.down && this.restingBuys.size === 0) {
      this.autoEngine.setExternalBuyPaused(false);
    }
    this.notify();
  }

  private async manageRestingGtdSells(
    state: LiveWindowState,
    setup: SimSetup,
    nowMs?: number,
  ): Promise<void> {
    // Prediction / Trigger GTD is owned/polled separately — do not retarget to phase profit.
    if (
      this.restingSell?.source === "prediction" ||
      this.restingSell?.source === "trigger"
    ) {
      if (!this.orderInFlight) await this.pollRestingSell(state);
      return;
    }
    const heldSides = SIDES_ORDER.filter((s) => this.positions[s]);
    if (heldSides.length === 0) {
      if (this.restingSell) await this.cancelRestingSell("no position", state);
      return;
    }
    const nowSec = Math.floor((nowMs ?? state.lastTickMs ?? Date.now()) / 1000);
    // Sell follows the clock phase, not the phase that bought.
    const phaseIdx = phaseIndexForState(state, setup.phaseSplit, nowSec);
    const phase = setup.phases[phaseIdx] ?? setup.phases[0];
    if (!sellEnabledForPhase(phase)) {
      if (this.restingSell) await this.cancelRestingSell("sell disabled", state);
      return;
    }
    if (this.restingSell) {
      const sellSide = this.restingSell.side;
      const pos = this.positions[sellSide];
      if (!pos) {
        await this.cancelRestingSell("no position", state);
      } else {
        const wantLimit = Math.min(
          0.99,
          Math.max(0.01, pos.avgPrice + centsToPrice(phase.sellProfitCents)),
        );
        const stalePhase =
          this.restingSell.phaseIdx !== phaseIdx ||
          Math.abs(this.restingSell.limitPrice - wantLimit) > 1e-9;
        if (stalePhase) {
          await this.cancelRestingSell("phase sell settings change", state);
        } else {
          if (this.orderInFlight) return;
          await this.pollRestingSell(state);
          if (this.restingSell) return;
        }
      }
    }
    if (this.orderInFlight) return;
    // Prefer a held side that does not yet have a resting sell (Both may hold two).
    for (const side of heldSides) {
      if (!this.positions[side]) continue;
      await this.ensureRestingGtdSell(state, setup, side, nowMs);
      if (this.restingSell) return;
    }
  }

  private async ensureRestingGtdSell(
    state: LiveWindowState,
    setup: SimSetup,
    side: "up" | "down",
    nowMs?: number,
  ): Promise<void> {
    if (!this.isLiveArmed()) return;
    const pos = this.positions[side];
    if (!pos || pos.shares <= 0) return;

    const nowSec = Math.floor((nowMs ?? state.lastTickMs ?? Date.now()) / 1000);
    const phaseIdx = phaseIndexForState(state, setup.phaseSplit, nowSec);
    const phase = setup.phases[phaseIdx] ?? setup.phases[0];
    if (!sellEnabledForPhase(phase)) return;
    const limitPrice = Math.min(0.99, Math.max(0.01, pos.avgPrice + centsToPrice(phase.sellProfitCents)));
    const shares = Math.max(1, Math.floor(pos.shares));
    const key = sessionKey(state);
    if (this.gtdSellBlockedWindowKey === key) return;
    const now = nowMs ?? Date.now();
    if (now < this.gtdSellRepressUntilMs) return;

    if (
      this.restingSell &&
      this.restingSell.side === side &&
      this.restingSell.sessionKey === key &&
      this.restingSell.phaseIdx === phaseIdx &&
      Math.abs(this.restingSell.limitPrice - limitPrice) < 1e-9 &&
      this.restingSell.shares === shares
    ) {
      return;
    }

    if (this.restingSell) {
      await this.cancelRestingSell("resize sell", state);
    }

    const windowEnd = state.windowEnd ?? nowSec + 300;

    const wasInFlight = this.orderInFlight;
    this.orderInFlight = true;
    try {
      const result = await placeLimitGtdSell(this.userId, {
        series: state.series,
        side,
        size: shares,
        price: limitPrice,
        expirationSec: gtdExpirationUnix(windowEnd, nowSec),
        state,
      });
      if (!result.success || !result.orderId) {
        // Place never rested — not a GTD fill opportunity.
        const err = result.error ?? "";
        if (/expiration/i.test(err)) {
          this.gtdSellBlockedWindowKey = key;
          logService.warn(
            "trading",
            `GTD sell skipped for rest of window (${err})`,
          );
        } else if (isBalanceAllowanceError(err)) {
          // Tokens often lag the buy fill; backoff instead of spamming every tick.
          // order-service already logged the CLOB error — don't duplicate here.
          this.gtdSellRepressUntilMs = now + GTD_SELL_BALANCE_REPRESS_MS;
        } else if (err) {
          logService.warn("trading", `GTD sell place failed: ${err}`);
        }
        return;
      }

      this.gtdSellRepressUntilMs = 0;

      const immediateSellFill =
        result.fillShares != null && result.fillPrice != null && result.fillShares > 0;
      await this.noteFillAttempt({
        leg: "sell",
        side,
        series: state.series,
        orderId: result.orderId,
        orderKind: "GTD",
        limitPrice,
        countable: immediateSellFill,
        touched: immediateSellFill,
        success: immediateSellFill,
      });

      if (immediateSellFill) {
        await this.recordSellFill(
          state,
          side,
          result.fillShares!,
          result.fillPrice!,
          result.usdcAmount,
          result.tokenId,
          result.conditionId,
          result.slug,
        );
        return;
      }

      this.restingSell = {
        orderId: result.orderId,
        side,
        sessionKey: key,
        shares,
        limitPrice,
        sizeMatched: 0,
        phaseIdx,
        source: "phase",
        tokenId: result.tokenId ?? pos.asset,
        conditionId: result.conditionId ?? pos.conditionId,
        cardId: pos.cardId,
      };
      // Do not latch the sell quote here — only real fills should highlight it.
      this.notify();
    } finally {
      this.orderInFlight = wasInFlight;
    }
  }

  /**
   * Prediction Trade Sell=GTD: rest limit at buy + Profit prediction as soon as Buy fills.
   */
  private async ensurePredictionGtdSell(
    state: LiveWindowState,
    side: "up" | "down",
    buyPrice: number,
    fillShares: number,
  ): Promise<void> {
    if (!this.isLiveArmed()) return;
    if (this.config.predictionSellOrderType !== "GTD") return;
    const pos = this.positions[side];
    if (!pos || pos.shares <= 0) return;

    const nowSec = Math.floor((state.lastTickMs ?? Date.now()) / 1000);
    const riseCents = Math.max(1, Math.min(50, Math.round(this.config.predictionRiseCents || 5)));
    const limitPrice = Math.min(0.99, Math.max(0.01, buyPrice + centsToPrice(riseCents)));
    await this.placeOwnedGtdSell(state, side, fillShares, limitPrice, "prediction", riseCents);
  }

  /**
   * Trigger Trade Sell=GTD: rest limit at buy fill + Take Profit offset (¢) as soon as Buy fills.
   */
  private async ensureTriggerGtdSell(
    state: LiveWindowState,
    side: "up" | "down",
    takeProfitOffsetCents: number,
    fillShares: number,
    fillPrice?: number,
    triggerId?: string,
  ): Promise<void> {
    if (!this.isLiveArmed()) return;
    const pos = this.positions[side];
    if (!pos || pos.shares <= 0) return;
    const tpOff = Math.max(1, Math.min(100, Math.round(takeProfitOffsetCents)));
    // Offset 100 = Take Profit disabled — do not rest a sell.
    if (tpOff >= 100) return;
    const buyPrice =
      fillPrice != null && Number.isFinite(fillPrice) && fillPrice > 0
        ? fillPrice
        : Number(pos.avgPrice);
    if (!Number.isFinite(buyPrice) || !(buyPrice > 0)) return;
    const limitPrice = Math.min(0.99, Math.max(0.01, buyPrice + centsToPrice(tpOff)));
    const card = this.findCard(pos.cardId);
    const tid =
      (typeof triggerId === "string" && triggerId.trim()) ||
      (typeof card?.triggerId === "string" && card.triggerId.trim()) ||
      undefined;
    await this.placeOwnedGtdSell(state, side, fillShares, limitPrice, "trigger", undefined, {
      triggerId: tid,
      triggerExitReason: "tp",
    });
  }

  private async placeOwnedGtdSell(
    state: LiveWindowState,
    side: "up" | "down",
    fillShares: number,
    limitPrice: number,
    source: "prediction" | "trigger",
    riseCents?: number,
    meta?: { triggerId?: string; triggerExitReason?: "tp" | "sl" },
  ): Promise<void> {
    const pos = this.positions[side];
    if (!pos || pos.shares <= 0) return;

    const nowSec = Math.floor((state.lastTickMs ?? Date.now()) / 1000);
    const shares = Math.max(1, Math.floor(fillShares > 0 ? fillShares : pos.shares));
    const key = sessionKey(state);
    if (this.gtdSellBlockedWindowKey === key) return;
    const now = Date.now();
    if (now < this.gtdSellRepressUntilMs) return;
    const triggerId =
      typeof meta?.triggerId === "string" && meta.triggerId.trim()
        ? meta.triggerId.trim()
        : undefined;
    const triggerExitReason =
      meta?.triggerExitReason === "tp" || meta?.triggerExitReason === "sl"
        ? meta.triggerExitReason
        : undefined;

    if (
      this.restingSell &&
      this.restingSell.source === source &&
      this.restingSell.side === side &&
      this.restingSell.sessionKey === key &&
      Math.abs(this.restingSell.limitPrice - limitPrice) < 1e-9 &&
      this.restingSell.shares === shares
    ) {
      return;
    }

    if (this.restingSell) {
      await this.cancelRestingSell(`${source} GTD sell`, state);
    }

    const windowEnd = state.windowEnd ?? nowSec + 300;
    const wasInFlight = this.orderInFlight;
    this.orderInFlight = true;
    try {
      const result = await placeLimitGtdSell(this.userId, {
        series: state.series,
        side,
        size: shares,
        price: limitPrice,
        expirationSec: gtdExpirationUnix(windowEnd, nowSec),
        state,
        logTag: source,
      });
      if (!result.success || !result.orderId) {
        const err = result.error ?? "";
        if (/expiration/i.test(err)) {
          this.gtdSellBlockedWindowKey = key;
          logService.warn("trading", `${source} GTD sell skipped for rest of window (${err})`);
        } else if (isBalanceAllowanceError(err)) {
          this.gtdSellRepressUntilMs = now + GTD_SELL_BALANCE_REPRESS_MS;
        } else if (err) {
          logService.warn("trading", `${source} GTD sell place failed: ${err}`);
        }
        return;
      }

      this.gtdSellRepressUntilMs = 0;

      const immediateSellFill =
        result.fillShares != null && result.fillPrice != null && result.fillShares > 0;
      await this.noteFillAttempt({
        leg: "sell",
        side,
        series: state.series,
        orderId: result.orderId,
        orderKind: "GTD",
        limitPrice,
        countable: immediateSellFill,
        touched: immediateSellFill,
        success: immediateSellFill,
      });

      if (immediateSellFill) {
        await this.recordSellFill(
          state,
          side,
          result.fillShares!,
          result.fillPrice!,
          result.usdcAmount,
          result.tokenId,
          result.conditionId,
          result.slug,
          triggerExitReason ? { triggerExitReason } : undefined,
        );
        return;
      }

      this.restingSell = {
        orderId: result.orderId,
        side,
        sessionKey: key,
        shares,
        limitPrice,
        sizeMatched: 0,
        phaseIdx: -1,
        source,
        ...(triggerId ? { triggerId } : {}),
        ...(triggerExitReason ? { triggerExitReason } : {}),
        tokenId: result.tokenId ?? pos.asset,
        conditionId: result.conditionId ?? pos.conditionId,
        cardId: pos.cardId,
      };
      const detail =
        source === "prediction" && riseCents != null
          ? ` (buy + ${riseCents}¢)`
          : source === "trigger"
            ? " (trigger take-profit)"
            : "";
      logService.info(
        "trading",
        `${source} GTD sell resting: ${side.toUpperCase()} ${shares} sh @ ${(limitPrice * 100).toFixed(0)}¢${detail}`,
      );
      this.notify();
    } finally {
      this.orderInFlight = wasInFlight;
    }
  }

  private async pollRestingSell(state: LiveWindowState): Promise<void> {
    const resting = this.restingSell;
    if (!resting) return;

    await this.maybeNoteGtdTouch(state, resting, "sell");
    const snap = await fetchOpenOrder(this.userId, resting.orderId);
    if (!snap) return;

    const matched = Math.max(0, snap.sizeMatched);
    if (matched > resting.sizeMatched + 1e-9) {
      const delta = matched - resting.sizeMatched;
      const fillPrice = snap.price > 0 ? snap.price : resting.limitPrice;
      resting.levelTouched = true;
      await this.noteFillSuccess(resting.orderId);
      await this.recordSellFill(
        state,
        resting.side,
        delta,
        fillPrice,
        delta * fillPrice,
        resting.tokenId ?? snap.assetId,
        resting.conditionId ?? snap.market,
        resting.slug,
      );
      resting.sizeMatched = matched;
    }

    const status = snap.status.toLowerCase();
    if (status === "live" || status === "delayed") return;

    this.restingSell = null;
    if (matched <= 1e-9) {
      await this.noteFillClose(resting.orderId);
    }
    this.notify();
  }

  private async recordSellFill(
    state: LiveWindowState,
    side: "up" | "down",
    fillShares: number,
    fillPrice: number,
    usdcAmount: number | undefined,
    tokenId: string | undefined,
    conditionId: string | undefined,
    slug: string | undefined,
    opts?: { triggerExitReason?: "tp" | "sl" },
  ): Promise<void> {
    const pos = this.positions[side];
    if (!pos) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const proceeds = usdcAmount ?? fillShares * fillPrice;
    const sellFees = await estimateLiveTakerFee(
      this.userId,
      tokenId ?? pos.asset,
      fillShares,
      fillPrice,
    );
    const buyFees = pos.buyFees ?? 0;
    const profit = proceeds - sellFees - (pos.cost + buyFees);
    this.lockQuote(side, "sell", fillPrice);
    const card = this.findCard(pos.cardId);
    const exitReason =
      opts?.triggerExitReason === "tp" || opts?.triggerExitReason === "sl"
        ? opts.triggerExitReason
        : this.restingSell?.source === "trigger" &&
            (this.restingSell.triggerExitReason === "tp" ||
              this.restingSell.triggerExitReason === "sl")
          ? this.restingSell.triggerExitReason
          : undefined;
    if (card && card.status === "open") {
      card.status = "sold";
      card.sellPrice = fillPrice;
      card.sellProceeds = proceeds;
      card.sellFees = sellFees;
      card.buyFees = card.buyFees ?? buyFees;
      card.soldAt = nowSec;
      card.pl = profit;
      card.shares = fillShares;
      card.asset = card.asset ?? tokenId ?? pos.asset;
      card.conditionId = card.conditionId ?? conditionId ?? pos.conditionId;
      card.slug = card.slug ?? slug;
      card.confirmed = false;
      if (exitReason) card.triggerExitReason = exitReason;
      this.persistCardStat(card);
      const tid = typeof card.triggerId === "string" ? card.triggerId.trim() : "";
      if (tid && card.source === "trigger") {
        this.publishTriggerLiveSell(tid, card.side, fillPrice, fillShares);
      }
      void this.enrichCardFromPolymarketSell(card.id, nowSec);
    }
    this.addMarker(state, {
      type: "sell",
      side,
      t: nowSec,
      y: state.assetPrice ?? null,
      shares: fillShares,
      price: fillPrice,
      proceeds,
      fees: sellFees,
      profit,
      total: proceeds,
    });
    this.positions[side] = null;
    if (!this.isLiveArmed()) this.autoEngine.clearExternalPosition(side);
    this.restingSell = null;
    // Confirmed sell: allow Trigger GTD to re-arm for this card's trigger.
    if (card?.triggerId) {
      this.clearTriggerGtdHold(card.triggerId);
    }
    // Prediction Trade race: sell (FAK/FOK or GTD fill) releases the hold.
    if (this.predictionTradeHoldWindowKey) {
      this.predictionTradeHoldWindowKey = null;
      if (!this.isLiveArmed()) this.autoEngine.setExternalBuyPaused(false);
    }
    void refreshCollateralBalance(this.userId);
    this.notify();
  }

  private latchTriggerGtdHold(triggerId: string, session: string): void {
    const id = String(triggerId || "").trim();
    if (!id || !session) return;
    this.triggerGtdHoldSessionById.set(id, session);
  }

  private clearTriggerGtdHold(triggerId: string): void {
    const id = String(triggerId || "").trim();
    if (!id) return;
    this.triggerGtdHoldSessionById.delete(id);
  }

  /** True while this trigger already filled a buy this window and has not sold yet. */
  private isTriggerGtdHeld(triggerId: string, session: string): boolean {
    const id = String(triggerId || "").trim();
    if (!id || !session) return false;
    if (this.triggerGtdHoldSessionById.get(id) === session) return true;
    return this.positionCards.some(
      (c) =>
        c.source === "trigger" &&
        c.triggerId === id &&
        c.status === "open" &&
        c.windowKey === session,
    );
  }

  private triggerGtdPlacedKey(triggerId: string, side: "up" | "down"): string {
    return `${triggerId}:${side}`;
  }

  /** True after a GTD place was accepted for this trigger+side in this window. */
  private isTriggerGtdPlaced(
    triggerId: string,
    side: "up" | "down",
    session: string,
  ): boolean {
    const id = String(triggerId || "").trim();
    if (!id || !session || (side !== "up" && side !== "down")) return false;
    return this.triggerGtdPlacedSessionById.get(this.triggerGtdPlacedKey(id, side)) === session;
  }

  private latchTriggerGtdPlaced(
    triggerId: string,
    side: "up" | "down",
    session: string,
  ): void {
    const id = String(triggerId || "").trim();
    if (!id || !session || (side !== "up" && side !== "down")) return;
    this.triggerGtdPlacedSessionById.set(this.triggerGtdPlacedKey(id, side), session);
  }

  /** Trigger title for Positions cards — hint first, else Mongo name. */
  private async resolveTriggerDisplayName(
    triggerId: string | undefined,
    hint?: string,
  ): Promise<string | undefined> {
    const fromHint = typeof hint === "string" ? hint.trim().slice(0, 120) : "";
    if (fromHint) return fromHint;
    const id = typeof triggerId === "string" ? triggerId.trim() : "";
    if (!id) return undefined;
    try {
      const t = await getUserTrigger(this.userId, id);
      const name = typeof t?.name === "string" ? t.name.trim().slice(0, 120) : "";
      return name || undefined;
    } catch {
      return undefined;
    }
  }

  private async recordBuyFill(
    state: LiveWindowState,
    side: "up" | "down",
    fillShares: number,
    fillPrice: number,
    usdcAmount: number | undefined,
    tokenId: string | undefined,
    conditionId: string | undefined,
    slug: string | undefined,
    source: "manual" | "auto" | "trigger",
    existingCardId?: string,
    buyPhaseIdx?: number,
    opts?: {
      holdToSettlement?: boolean;
      placementId?: string;
      triggerId?: string;
      triggerName?: string;
      triggerMiss?: boolean;
    },
  ): Promise<void> {
    const holdToSettlement = Boolean(opts?.holdToSettlement);
    const resolvedTriggerId =
      source === "trigger" && typeof opts?.triggerId === "string" && opts.triggerId.trim()
        ? opts.triggerId.trim()
        : undefined;
    const resolvedTriggerName = resolvedTriggerId
      ? await this.resolveTriggerDisplayName(resolvedTriggerId, opts?.triggerName)
      : undefined;
    const triggerMiss = source === "trigger" && opts?.triggerMiss === true;
    // Phase Auto Trade: placement only when Use Schedule is on.
    // Trigger Trade: hour-slot stats via triggerId + mode timeline (no placementId).
    let resolvedPlacementId: string | undefined;
    if (source === "trigger") {
      resolvedPlacementId = undefined;
    } else if (source === "auto" && this.config.useSchedule) {
      resolvedPlacementId = opts?.placementId ?? this.scheduleContext?.placementId;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const cost = usdcAmount ?? fillShares * fillPrice;
    const buyFees = await estimateLiveTakerFee(this.userId, tokenId, fillShares, fillPrice);
    const windowKey = sessionKey(state);
    const setup = this.resolveAutoSimSetup(state);
    const phaseIdx =
      buyPhaseIdx ??
      (setup ? phaseIndexForState(state, setup.phaseSplit, nowSec) : 0);

    const existing =
      (existingCardId ? this.findCard(existingCardId) : undefined) ??
      this.positionCards.find(
        (card) => card.status === "open" && card.windowKey === windowKey && card.side === side,
      );

    if (existing && existing.status === "open") {
      // Manual fills never inherit / keep a schedule placement id.
      if (source === "manual") {
        existing.source = "manual";
        stripManualScheduleAttribution(existing);
      } else if (source === "auto" || source === "trigger") {
        if (existing.source !== "manual") {
          existing.source = source;
        }
        if (existing.source !== "manual" && !existing.placementId && resolvedPlacementId) {
          existing.placementId = resolvedPlacementId;
        }
        if (source === "trigger" && resolvedTriggerId && !existing.triggerId) {
          existing.triggerId = resolvedTriggerId;
        }
        if (source === "trigger" && resolvedTriggerName && !existing.triggerName) {
          existing.triggerName = resolvedTriggerName;
        }
      }
      if (!this.positions[side]) {
        this.positions[side] = {
          shares: existing.shares,
          avgPrice: existing.buyPrice,
          cost: existing.buyCost,
          buyFees: existing.buyFees ?? 0,
          cardId: existing.id,
          asset: existing.asset,
          conditionId: existing.conditionId,
          buyPhaseIdx: phaseIdx,
        };
      }
      const livePos = this.positions[side]!;
      const totalShares = livePos.shares + fillShares;
      const totalCost = livePos.cost + cost;
      const totalFees = (livePos.buyFees ?? 0) + buyFees;
      livePos.shares = totalShares;
      livePos.avgPrice = totalShares > 0 ? totalCost / totalShares : fillPrice;
      livePos.cost = totalCost;
      livePos.buyFees = totalFees;
      livePos.asset = livePos.asset ?? tokenId;
      livePos.conditionId = livePos.conditionId ?? conditionId;
      livePos.buyPhaseIdx = livePos.buyPhaseIdx ?? phaseIdx;
      existing.shares = totalShares;
      existing.buyPrice = livePos.avgPrice;
      existing.buyCost = totalCost;
      existing.buyFees = totalFees;
      existing.asset = existing.asset ?? tokenId;
      existing.conditionId = existing.conditionId ?? conditionId;
      existing.slug = existing.slug ?? slug;
      if (triggerMiss) existing.triggerMiss = true;
      this.scheduleUpsertPositionCard(existing);
      if (source === "trigger" && resolvedTriggerId) {
        this.publishTriggerLiveBuy(
          resolvedTriggerId,
          side,
          existing.buyPrice,
          existing.shares,
        );
      }
    } else {
      // Hard stop: never open a second card for the same window/side/market.
      const dup = this.positionCards.find(
        (card) =>
          card.windowKey === windowKey &&
          card.side === side &&
          ((tokenId && card.asset === tokenId) ||
            (conditionId && card.conditionId === conditionId)),
      );
      if (dup) {
        logService.warn(
          "trading",
          `Skipped duplicate buy card for ${windowKey} ${side} (existing ${dup.id})`,
        );
        return;
      }

      const cardId = newCardId();
      this.positions[side] = {
        shares: fillShares,
        avgPrice: fillPrice,
        cost,
        buyFees,
        cardId,
        asset: tokenId,
        conditionId,
        buyPhaseIdx: phaseIdx,
      };
      this.lockQuote(side, "buy", fillPrice);
      const opened: TradingPositionCard = {
        id: cardId,
        windowKey,
        series: state.series,
        side,
        shares: fillShares,
        buyPrice: fillPrice,
        buyCost: cost,
        buyFees,
        buyAt: nowSec,
        status: "open",
        asset: tokenId,
        conditionId,
        slug,
        confirmed: false,
        source,
        // Manual buys never attach to a schedule card.
        placementId: source === "manual" ? undefined : resolvedPlacementId,
        ...(resolvedTriggerId ? { triggerId: resolvedTriggerId } : {}),
        ...(resolvedTriggerName ? { triggerName: resolvedTriggerName } : {}),
        ...(triggerMiss ? { triggerMiss: true } : {}),
      };
      this.positionCards.unshift(opened);
      if (source !== "manual" && resolvedPlacementId) {
        this.rememberActivatedPlacement(resolvedPlacementId);
      }
      this.positionCards = trimPositionCardsForUi(this.positionCards);
      this.scheduleUpsertPositionCard(opened);
      if (source === "trigger" && resolvedTriggerId) {
        this.publishTriggerLiveBuy(resolvedTriggerId, side, fillPrice, fillShares);
      }
      void this.enrichCardFromPolymarketBuy(cardId);
    }

    this.addMarker(state, {
      type: "buy",
      side,
      t: nowSec,
      y: state.assetPrice ?? null,
      shares: fillShares,
      price: fillPrice,
      cost,
      fees: buyFees,
      total: cost + buyFees,
    });

    const pos = this.positions[side];
    if (pos) {
      // Keep sim in sync only while previewing — live must not drive SimulatorEngine.
      if (!this.isLiveArmed()) {
        this.autoEngine.adoptExternalBuy(state, side, pos.shares, pos.avgPrice, phaseIdx, nowSec);
        if (holdToSettlement) {
          this.autoEngine.suppressBuysForWindow();
          this.autoEngine.suppressSellsForWindow();
        } else {
          this.autoEngine.setExternalBuyPaused(false);
        }
      }
      if (holdToSettlement) {
        this.liveFakWatch = null;
      } else {
        // Phase Auto Trade only — Trigger/Prediction own their exit path.
        if (source === "auto" && this.isLiveArmed() && setup) {
          await this.ensureRestingGtdSell(state, setup, side);
        }
      }
    }

    // Latch Trigger GTD until a confirmed sell (or window roll). Blocks a second rest
    // while holding to TP/SL / settlement — even if the client keeps desiring both sides.
    if (source === "trigger" && resolvedTriggerId) {
      this.latchTriggerGtdHold(resolvedTriggerId, windowKey);
      this.predictionTradeHoldWindowKey = windowKey;
    }

    void refreshCollateralBalance(this.userId);
    this.notify();
  }

  canManualTrade(side: "up" | "down", leg: "buy" | "sell"): boolean {
    if (leg === "buy") {
      return !this.positions[side] && !this.pendingBuyConfirm;
    }
    return Boolean(this.positions[side]);
  }

  private triggerRestKey(triggerId: string, side: "up" | "down"): string {
    return `${triggerId}:${side}`;
  }

  private async cancelAllTriggerRestingBuys(
    reason: string,
    state?: LiveWindowState,
  ): Promise<void> {
    const keys = [...this.triggerRestingBuys.keys()];
    for (const key of keys) {
      await this.cancelTriggerRestingBuy(key, reason, state);
    }
  }

  /**
   * Slot may free only on: fully filled, confirm-cancelled, or window end (handled by caller).
   * Unknown / empty / unexpected status → keep blocking (no second place).
   *
   * Polymarket `unmatched` = after delay, no immediate match, order is still resting
   * on the book — NOT cancelled. Treating it as cancel caused a second 100-share place.
   */
  private classifyTriggerRestDisposition(
    snap: { status: string; sizeMatched: number } | null,
    resting: TriggerRestingBuyOrder,
  ): "open" | "filled" | "cancel_confirmed" | "unknown" {
    if (!snap) return "unknown";
    const status = String(snap.status || "").toLowerCase().trim();
    const matched = Math.max(0, Number(snap.sizeMatched) || 0);
    const fullyFilled = matched + 1e-9 >= resting.shares;

    // 1) Fully filled only (do not free on partial `matched` while size remains).
    if (fullyFilled) return "filled";
    if (status === "matched" && fullyFilled) return "filled";

    // 2) Confirm cancel / expired only — never `unmatched` (that is still on the book).
    if (status === "cancelled" || status === "canceled" || status === "expired") {
      // Partial fill then cancel: fill already recorded; slot may free.
      return matched > 1e-9 ? "filled" : "cancel_confirmed";
    }

    // Still working — including empty status and post-delay resting (`unmatched`).
    if (
      status === "live" ||
      status === "delayed" ||
      status === "unmatched" ||
      status === "open" ||
      status === ""
    ) {
      return "open";
    }

    // Anything else: do not free the slot.
    return "unknown";
  }

  private async fetchTriggerRestDisposition(
    resting: TriggerRestingBuyOrder,
  ): Promise<"open" | "filled" | "cancel_confirmed" | "unknown"> {
    const snap = await fetchOpenOrder(this.userId, resting.orderId);
    return this.classifyTriggerRestDisposition(snap, resting);
  }

  private releaseTriggerRestSlot(
    key: string,
    resting: TriggerRestingBuyOrder,
    why: "filled" | "cancel confirmed" | "window end",
    reason: string,
  ): void {
    this.triggerRestingBuys.delete(key);
    logService.info(
      "trading",
      `Trigger GTD slot free — ${why} ${resting.side.toUpperCase()} (${reason})`,
    );
    this.notify();
  }

  /**
   * Request cancel of a Trigger GTD rest.
   * Keeps the map entry until filled or cancel is explicitly confirmed.
   * Never drops for unknown status (blocks second place).
   */
  private async cancelTriggerRestingBuy(
    key: string,
    reason: string,
    state?: LiveWindowState,
  ): Promise<void> {
    const resting = this.triggerRestingBuys.get(key);
    if (!resting) return;
    resting.cancelPending = true;
    resting.cancelAttempts = (resting.cancelAttempts ?? 0) + 1;

    // Harvest before / after cancel — a race fill must latch hold first.
    if (state) {
      await this.harvestTriggerGtdFill(resting, state);
      if (!this.triggerRestingBuys.has(key)) return;
    }
    let disposition = await this.fetchTriggerRestDisposition(resting);
    if (disposition === "filled" || disposition === "cancel_confirmed") {
      if (disposition === "cancel_confirmed" && resting.sizeMatched <= 1e-9) {
        await this.noteFillClose(resting.orderId);
      }
      this.releaseTriggerRestSlot(
        key,
        resting,
        disposition === "filled" ? "filled" : "cancel confirmed",
        reason,
      );
      return;
    }

    const result = await cancelOpenOrder(this.userId, resting.orderId, { quiet: true });
    if (state) {
      await this.harvestTriggerGtdFill(resting, state);
      if (!this.triggerRestingBuys.has(key)) return;
    }
    disposition = await this.fetchTriggerRestDisposition(resting);
    if (disposition === "filled" || disposition === "cancel_confirmed") {
      if (disposition === "cancel_confirmed" && resting.sizeMatched <= 1e-9) {
        await this.noteFillClose(resting.orderId);
      }
      this.releaseTriggerRestSlot(
        key,
        resting,
        disposition === "filled" ? "filled" : "cancel confirmed",
        reason,
      );
      return;
    }

    // Still open or unknown — keep tracking; no second place.
    const attempts = resting.cancelAttempts ?? 1;
    if (attempts === 1 || attempts % 3 === 0) {
      logService.warn(
        "trading",
        `Trigger GTD block re-place — still ${disposition} ${resting.side.toUpperCase()} (${reason})` +
          ` attempt ${attempts}${result.ok ? "" : `: ${result.error ?? "failed"}`}`,
      );
    }
    this.notify();
  }

  /**
   * Record a Trigger GTD buy fill (poll or cancel race). Latches hold for the trigger.
   * Returns true only when disposition is filled or cancel_confirmed.
   */
  private async harvestTriggerGtdFill(
    resting: TriggerRestingBuyOrder,
    state: LiveWindowState,
  ): Promise<boolean> {
    const snap = await fetchOpenOrder(this.userId, resting.orderId);
    if (!snap) {
      return false; // unknown — keep tracking
    }
    const matched = Math.max(0, snap.sizeMatched);
    if (matched > resting.sizeMatched + 1e-9) {
      const delta = matched - resting.sizeMatched;
      const fillPrice = snap.price > 0 ? snap.price : resting.limitPrice;
      resting.sizeMatched = matched;
      await this.recordBuyFill(
        state,
        resting.side,
        delta,
        fillPrice,
        delta * fillPrice,
        resting.tokenId ?? snap.assetId,
        resting.conditionId ?? snap.market,
        resting.slug,
        "trigger",
        undefined,
        undefined,
        { triggerId: resting.triggerId },
      );
      if (resting.sellOrderType === "GTD") {
        await this.ensureTriggerGtdSell(
          state,
          resting.side,
          resting.takeProfitCents,
          delta,
          fillPrice,
          resting.triggerId,
        );
      }
      // First Trigger Trade fill wins the window slot: cancel every other rest
      // (sibling side + other Active Trade cards) until sell / window end.
      await this.cancelTriggerSiblingRests(resting.triggerId, resting.side, state);
      await this.cancelOtherTriggerRestingBuys(resting.triggerId, state);
      resting.cancelPending = true;
      const status = String(snap.status || "").toLowerCase();
      if (
        status === "live" ||
        status === "delayed" ||
        status === "unmatched" ||
        status === "open" ||
        status === ""
      ) {
        await cancelOpenOrder(this.userId, resting.orderId, { quiet: true });
      }
      this.notify();
    }

    const after = await fetchOpenOrder(this.userId, resting.orderId);
    const disposition = this.classifyTriggerRestDisposition(after, resting);
    if (disposition === "filled" || disposition === "cancel_confirmed") {
      if (disposition === "cancel_confirmed" && resting.sizeMatched <= 1e-9) {
        await this.noteFillClose(resting.orderId);
      }
      return true;
    }
    return false;
  }

  private async cancelTriggerSiblingRests(
    triggerId: string,
    filledSide: "up" | "down",
    state?: LiveWindowState,
  ): Promise<void> {
    for (const side of SIDES_ORDER) {
      if (side === filledSide) continue;
      const key = this.triggerRestKey(triggerId, side);
      if (this.triggerRestingBuys.has(key)) {
        await this.cancelTriggerRestingBuy(key, "first fill — cancel other", state);
      }
    }
  }

  /** Cancel resting GTD buys for every trigger other than the winner. */
  private async cancelOtherTriggerRestingBuys(
    winnerTriggerId: string,
    state?: LiveWindowState,
  ): Promise<void> {
    const winner = String(winnerTriggerId || "").trim();
    for (const [rk, resting] of [...this.triggerRestingBuys.entries()]) {
      if (winner && resting.triggerId === winner) continue;
      await this.cancelTriggerRestingBuy(rk, "Trade race — other trigger filled", state);
    }
  }

  /**
   * Reconcile Trigger Trade GTD buys (Duration 0 + Price).
   * Client sends desired rests each tick; server places/cancels/polls and returns fills.
   * Serialized: concurrent client posts share one chain so two 100-share rests cannot race.
   */
  async syncTriggerGtdBuys(
    state: LiveWindowState,
    desires: TriggerGtdDesire[],
  ): Promise<{ ok: boolean; fills: TriggerGtdFill[]; error?: string }> {
    const run = this.triggerGtdSyncChain.then(() =>
      this.syncTriggerGtdBuysLocked(state, desires),
    );
    this.triggerGtdSyncChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async syncTriggerGtdBuysLocked(
    state: LiveWindowState,
    desires: TriggerGtdDesire[],
  ): Promise<{ ok: boolean; fills: TriggerGtdFill[]; error?: string }> {
    this.ensureWindow(state);
    const fills: TriggerGtdFill[] = [];
    if (!this.canExecuteOrders() || !this.config.startTrading) {
      if (this.triggerRestingBuys.size > 0) {
        await this.cancelAllTriggerRestingBuys("Allow trade off", state);
      }
      return { ok: true, fills };
    }

    const key = sessionKey(state);
    const nowSec = Math.floor((state.lastTickMs ?? Date.now()) / 1000);
    const windowEnd = state.windowEnd ?? nowSec + 300;

    const desireByKey = new Map<string, TriggerGtdDesire & { side: "up" | "down" }>();
    for (const d of desires) {
      const triggerId = String(d.triggerId || "").trim();
      if (!triggerId) continue;
      // Already filled this window and not sold yet — do not rest again.
      if (this.isTriggerGtdHeld(triggerId, key)) continue;
      const priceCents = Math.max(0, Math.min(100, Math.round(Number(d.priceCents) * 10) / 10));
      if (!Number.isFinite(priceCents)) continue;
      const shares = Math.max(1, Math.floor(Number(d.shares) || 1));
      const sellOrderType =
        d.sellOrderType === "FOK" || d.sellOrderType === "GTD" || d.sellOrderType === "FAK"
          ? d.sellOrderType
          : "FAK";
      const takeProfitCents = Math.max(
        1,
        Math.min(100, Math.round(Number(d.takeProfitCents) || 10)),
      );
      const triggerName =
        typeof d.triggerName === "string" && d.triggerName.trim()
          ? d.triggerName.trim().slice(0, 120)
          : undefined;
      for (const side of d.sides) {
        if (side !== "up" && side !== "down") continue;
        const rk = this.triggerRestKey(triggerId, side);
        desireByKey.set(rk, {
          triggerId,
          sides: d.sides,
          side,
          priceCents,
          shares,
          sellOrderType,
          takeProfitCents,
          ...(triggerName ? { triggerName } : {}),
        });
      }
    }

    // Drop rests for held triggers (client may still send desires while holding).
    // Cancel keeps tracking until CLOB confirms — blocks re-place of a second rest.
    for (const [rk, resting] of [...this.triggerRestingBuys.entries()]) {
      if (this.isTriggerGtdHeld(resting.triggerId, key)) {
        await this.cancelTriggerRestingBuy(rk, "trigger holding — no rearm", state);
      }
    }

    // If desire matches again while a cancel was in flight, keep the live rest.
    for (const [rk, resting] of [...this.triggerRestingBuys.entries()]) {
      if (!resting.cancelPending) continue;
      const want = desireByKey.get(rk);
      if (!want || this.isTriggerGtdHeld(resting.triggerId, key)) continue;
      const limitPrice = triggerGtdLimitPrice(want.priceCents);
      const matches =
        resting.sessionKey === key &&
        Math.abs(resting.limitPrice - limitPrice) <= 1e-9 &&
        resting.shares === want.shares;
      if (matches) {
        resting.cancelPending = false;
        resting.cancelAttempts = 0;
      }
    }

    // Cancel rests that are no longer desired or at a different price/size.
    // Once a side has placed this window, keep that rest even if its desire
    // briefly drops — latch forbids a replacement on the same side.
    for (const [rk, resting] of [...this.triggerRestingBuys.entries()]) {
      if (
        resting.sessionKey === key &&
        this.isTriggerGtdPlaced(resting.triggerId, resting.side, key) &&
        !this.isTriggerGtdHeld(resting.triggerId, key)
      ) {
        // Reclaim if a brief cancel race marked cancel — do not drop a live rest.
        if (resting.cancelPending && desireByKey.has(rk)) {
          resting.cancelPending = false;
          resting.cancelAttempts = 0;
        }
        if (!resting.cancelPending) continue;
      }
      const want = desireByKey.get(rk);
      const limitPrice = want ? triggerGtdLimitPrice(want.priceCents) : NaN;
      const stale =
        !want ||
        resting.sessionKey !== key ||
        Math.abs(resting.limitPrice - limitPrice) > 1e-9 ||
        resting.shares !== want.shares;
      if (stale || resting.cancelPending) {
        await this.cancelTriggerRestingBuy(
          rk,
          !want
            ? "gap/window — not desired"
            : resting.cancelPending
              ? "cancel retry"
              : "price/size change",
          state,
        );
      }
    }

    // Poll remaining rests for fills.
    for (const [rk, resting] of [...this.triggerRestingBuys.entries()]) {
      // 3) End of window — best-effort cancel, then always free the slot.
      if (resting.sessionKey !== key) {
        await this.cancelTriggerRestingBuy(rk, "window roll", state);
        if (this.triggerRestingBuys.has(rk)) {
          this.releaseTriggerRestSlot(rk, resting, "window end", "window roll");
        }
        continue;
      }
      const beforeMatched = resting.sizeMatched;
      const beforeSide = resting.side;
      const beforeTriggerId = resting.triggerId;
      const beforeShares = resting.shares;
      const beforePrice = resting.limitPrice;
      const done = await this.harvestTriggerGtdFill(resting, state);
      if (resting.sizeMatched > beforeMatched + 1e-9) {
        fills.push({
          triggerId: beforeTriggerId,
          side: beforeSide,
          fillPrice: beforePrice,
          fillShares: Math.min(beforeShares, resting.sizeMatched - beforeMatched),
        });
        const card = this.positionCards.find(
          (c) =>
            c.source === "trigger" &&
            c.triggerId === beforeTriggerId &&
            c.status === "open" &&
            c.windowKey === key,
        );
        if (card) {
          fills[fills.length - 1]!.fillPrice = card.buyPrice;
          fills[fills.length - 1]!.fillShares = Math.min(
            beforeShares,
            resting.sizeMatched - beforeMatched,
          );
        }
        this.notify();
      }
      // Drop tracking only on filled / cancel_confirmed (harvest), never on unknown.
      if (done) {
        const why: "filled" | "cancel confirmed" =
          resting.sizeMatched > 1e-9 ? "filled" : "cancel confirmed";
        this.releaseTriggerRestSlot(rk, resting, why, "poll");
      } else if (resting.cancelPending) {
        await this.cancelTriggerRestingBuy(rk, "cancel retry", state);
      }
    }

    // Global blocks: open position / pending confirm / prediction hold.
    if (
      this.positions.up ||
      this.positions.down ||
      this.manualBuyPending ||
      this.pendingBuyConfirm ||
      this.buyBlockedWindowKey === key ||
      this.predictionTradeHoldWindowKey === key
    ) {
      if (this.triggerRestingBuys.size > 0 && (this.positions.up || this.positions.down)) {
        await this.cancelAllTriggerRestingBuys("position open", state);
      }
      return { ok: true, fills };
    }

    if (this.orderInFlight) return { ok: true, fills };

    for (const [rk, want] of desireByKey.entries()) {
      // Still tracking a rest (including cancel-pending) → never place a duplicate.
      if (this.triggerRestingBuys.has(rk)) continue;
      if (this.isTriggerGtdHeld(want.triggerId, key)) continue;
      // Already accepted a resting GTD on this side this window — never re-place.
      if (this.isTriggerGtdPlaced(want.triggerId, want.side, key)) continue;
      if (this.positions.up || this.positions.down) break;
      if (this.predictionTradeHoldWindowKey === key) break;
      // Hard cap: never place again if this trigger already bought ≥ Shares this window
      // (blocks double-place even if a rest was dropped early).
      const matchedForTrigger = [...this.triggerRestingBuys.values()]
        .filter((r) => r.triggerId === want.triggerId)
        .reduce((sum, r) => sum + r.sizeMatched, 0);
      const cardShares = this.positionCards
        .filter(
          (c) =>
            c.source === "trigger" &&
            c.triggerId === want.triggerId &&
            c.windowKey === key &&
            c.status === "open",
        )
        .reduce((sum, c) => sum + (Number(c.shares) || 0), 0);
      if (matchedForTrigger + cardShares >= want.shares - 1e-9) {
        this.latchTriggerGtdPlaced(want.triggerId, want.side, key);
        continue;
      }

      // Trigger GTD takes the slot — drop phase rests first.
      if (this.restingBuys.size > 0) {
        await this.cancelAllRestingBuys("trigger GTD buy");
      }

      const limitPrice = triggerGtdLimitPrice(want.priceCents);
      this.orderInFlight = true;
      try {
        this.autoEngine.setExternalBuyPaused(true);
        const result = await placeLimitGtdBuy(this.userId, {
          series: state.series,
          side: want.side,
          size: want.shares,
          price: limitPrice,
          expirationSec: gtdExpirationUnix(windowEnd, nowSec),
          state,
          logTag: `trigger ${want.triggerId.slice(0, 8)}`,
        });
        if (!result.success || !result.orderId) {
          if (this.triggerRestingBuys.size === 0 && this.restingBuys.size === 0) {
            this.autoEngine.setExternalBuyPaused(false);
          }
          const err = result.error ?? "";
          if (err) logService.warn("trading", `Trigger GTD place failed (${want.side}): ${err}`);
          // Do not latch on failure — allow retry until a rest is accepted.
          continue;
        }
        // Accepted by CLOB — one rest max per side this window (UP + DOWN both allowed).
        this.latchTriggerGtdPlaced(want.triggerId, want.side, key);

        const immediateFill =
          result.fillShares != null && result.fillPrice != null && result.fillShares > 0;
        if (immediateFill) {
          await this.recordBuyFill(
            state,
            want.side,
            result.fillShares!,
            result.fillPrice!,
            result.usdcAmount,
            result.tokenId,
            result.conditionId,
            result.slug,
            "trigger",
            undefined,
            undefined,
            {
              triggerId: want.triggerId,
              ...(want.triggerName ? { triggerName: want.triggerName } : {}),
            },
          );
          if (want.sellOrderType === "GTD") {
            await this.ensureTriggerGtdSell(
              state,
              want.side,
              want.takeProfitCents ?? 10,
              result.fillShares!,
              result.fillPrice!,
              want.triggerId,
            );
          }
          fills.push({
            triggerId: want.triggerId,
            side: want.side,
            fillPrice: result.fillPrice!,
            fillShares: result.fillShares!,
          });
          // Track until CLOB confirms the order is done (blocks duplicate place).
          this.triggerRestingBuys.set(rk, {
            orderId: result.orderId,
            triggerId: want.triggerId,
            side: want.side,
            sessionKey: key,
            shares: want.shares,
            limitPrice,
            sizeMatched: result.fillShares!,
            sellOrderType: want.sellOrderType ?? "FAK",
            takeProfitCents: want.takeProfitCents ?? 10,
            tokenId: result.tokenId,
            conditionId: result.conditionId,
            slug: result.slug,
            cancelPending: true,
            cancelAttempts: 0,
          });
          await this.cancelTriggerSiblingRests(want.triggerId, want.side, state);
          await this.cancelTriggerRestingBuy(rk, "immediate fill — close rest", state);
          // Stop placing further rests this sync — hold latch is set; rearm only after sell.
          break;
        }

        this.triggerRestingBuys.set(rk, {
          orderId: result.orderId,
          triggerId: want.triggerId,
          side: want.side,
          sessionKey: key,
          shares: want.shares,
          limitPrice,
          sizeMatched: 0,
          sellOrderType: want.sellOrderType ?? "FAK",
          takeProfitCents: want.takeProfitCents ?? 10,
          tokenId: result.tokenId,
          conditionId: result.conditionId,
          slug: result.slug,
        });
        this.notify();
      } finally {
        this.orderInFlight = false;
      }
    }

    return { ok: true, fills };
  }

  async manualOrder(
    state: LiveWindowState,
    side: "up" | "down",
    leg: "buy" | "sell",
    options?: {
      source?: "manual" | "prediction" | "trigger";
      shares?: number;
      orderType?: "FAK" | "FOK";
      sellOrderType?: "FAK" | "FOK" | "GTD";
      takeProfitCents?: number;
      /** Buy max Ask (dollars) — trigger FAK/FOK must not walk above the diagram band. */
      maxPrice?: number;
      /** Buy min Ask (dollars) — trigger must not buy below the diagram band low. */
      minPrice?: number;
      /** Market Trigger id when source is trigger. */
      triggerId?: string;
      /** Trigger title hint for Positions. */
      triggerName?: string;
      /** Trigger exit reason for sells (tp / sl). */
      triggerExitReason?: "tp" | "sl";
    },
  ): Promise<{
    ok: boolean;
    error?: string;
    fillShares?: number;
    fillPrice?: number;
    remainingShares?: number;
    triggerMiss?: boolean;
  }> {
    this.ensureWindow(state);
    if (!this.canExecuteOrders()) {
      return { ok: false, error: "Allow trade to place orders" };
    }
    const fromPrediction = options?.source === "prediction";
    const fromTrigger = options?.source === "trigger";
    const holdsPhases = fromPrediction || fromTrigger;
    const triggerSellOrderType =
      options?.sellOrderType === "FOK" || options?.sellOrderType === "GTD"
        ? options.sellOrderType
        : options?.sellOrderType === "FAK"
          ? "FAK"
          : "FAK";
    if (fromPrediction) {
      if (
        !this.config.predictionTrade ||
        !this.config.manipulationDetector ||
        !this.config.startTrading
      ) {
        return { ok: false, error: "Prediction Trade is off" };
      }
    }
    if (fromTrigger && !this.config.startTrading) {
      return { ok: false, error: "Allow trade to place trigger orders" };
    }
    if (leg === "buy") {
      const key = sessionKey(state);
      if (holdsPhases) {
        // May buy after a prior manual override; still respect pending/unresolved buys.
        if (
          this.manualBuyPending ||
          this.pendingBuyConfirm ||
          this.buyBlockedWindowKey === key ||
          this.positions.up ||
          this.positions.down
        ) {
          return {
            ok: false,
            error: this.pendingBuyConfirm
              ? "Buy pending confirmation"
              : this.positions.up || this.positions.down
                ? "Already holding position"
                : "Buy blocked until window rolls (prior order unresolved)",
          };
        }
      } else if (this.isBuyBlocked(state)) {
        return {
          ok: false,
          error: this.pendingBuyConfirm
            ? "Buy pending confirmation"
            : "Buy blocked until window rolls (prior order unresolved)",
        };
      }
    }
    if (!this.canManualTrade(side, leg)) {
      return { ok: false, error: leg === "buy" ? "Already holding position" : "No position to sell" };
    }
    const requestedShares =
      options?.shares != null && Number.isFinite(options.shares) && options.shares > 0
        ? Math.max(1, Math.floor(options.shares))
        : null;
    const size =
      leg === "sell" && this.positions[side]
        ? this.positions[side]!.shares
        : fromTrigger && requestedShares != null
          ? requestedShares
          : fromPrediction
            ? this.config.predictionShares
            : this.config.autoTrade && !fromTrigger
              ? (this.getPhaseBuyShares(state) ?? this.config.manualShares)
              : this.config.manualShares;
    const sizeUnit =
      fromPrediction || fromTrigger || leg === "sell" || this.config.autoTrade
        ? "shares"
        : this.config.manualOrderUnit;
    if (leg === "buy") {
      this.manualBuyPending = true;
      this.liveFakWatch = null;
      if (!this.isLiveArmed()) this.autoEngine.setExternalBuyPaused(true);
      await this.cancelAllRestingBuys(
        fromPrediction ? "prediction buy" : fromTrigger ? "trigger buy" : "manual buy",
      );
      if (fromTrigger && this.triggerRestingBuys.size > 0) {
        await this.cancelAllTriggerRestingBuys("trigger FAK/FOK buy", state);
      }
    } else if (
      !(fromPrediction && this.config.predictionSellOrderType === "GTD") &&
      !(fromTrigger && this.restingSell?.source === "trigger" && options?.orderType == null)
    ) {
      // Trigger SL / window-end / FAK-FOK exits cancel any resting GTD first.
      await this.cancelRestingSell(
        fromPrediction ? "prediction sell" : fromTrigger ? "trigger sell" : "manual sell",
        state,
      );
    }

    try {
      if (fromPrediction && leg === "sell" && this.config.predictionSellOrderType === "GTD") {
        // GTD sell is placed with the buy; client Bid-hit sell is a no-op.
        if (this.restingSell?.source === "prediction" && this.restingSell.side === side) {
          return { ok: true };
        }
        return { ok: false, error: "Prediction Sell is GTD (resting after buy)" };
      }
      // Trigger GTD: resting TP was placed on buy; ignore client TP sells (SL uses orderType).
      if (
        fromTrigger &&
        leg === "sell" &&
        this.restingSell?.source === "trigger" &&
        this.restingSell.side === side &&
        options?.orderType == null
      ) {
        return { ok: true };
      }
      const orderType: "FAK" | "FOK" = fromTrigger
        ? leg === "buy"
          ? options?.orderType === "FAK"
            ? "FAK"
            : "FOK"
          : options?.orderType === "FOK"
            ? "FOK"
            : "FAK"
        : fromPrediction
          ? leg === "buy"
            ? this.config.predictionBuyOrderType
            : this.config.predictionSellOrderType === "GTD"
              ? "FOK"
              : this.config.predictionSellOrderType
          : leg === "buy"
            ? this.config.manualBuyOrderType
            : this.config.manualSellOrderType;
      const maxPrice =
        fromTrigger &&
        leg === "buy" &&
        options?.maxPrice != null &&
        Number.isFinite(options.maxPrice) &&
        options.maxPrice > 0
          ? options.maxPrice
          : undefined;
      const minPrice =
        fromTrigger &&
        leg === "buy" &&
        options?.minPrice != null &&
        Number.isFinite(options.minPrice) &&
        options.minPrice > 0
          ? options.minPrice
          : undefined;
      const triggerId =
        fromTrigger && typeof options?.triggerId === "string" && options.triggerId.trim()
          ? options.triggerId.trim()
          : undefined;
      const triggerName =
        fromTrigger && typeof options?.triggerName === "string" && options.triggerName.trim()
          ? options.triggerName.trim().slice(0, 120)
          : undefined;
      const triggerExitReason =
        fromTrigger &&
        leg === "sell" &&
        (options?.triggerExitReason === "tp" || options?.triggerExitReason === "sl")
          ? options.triggerExitReason
          : fromTrigger && leg === "sell" && options?.orderType != null
            ? "sl"
            : undefined;
      const result = await this.executeOrder(
        state,
        side,
        leg,
        size,
        fromTrigger ? "trigger" : "manual",
        sizeUnit,
        orderType,
        maxPrice,
        undefined,
        { triggerId, triggerName, triggerExitReason, minPrice },
      );
      if (result.ok) {
        if (leg === "buy") {
          if (!this.isLiveArmed()) {
            const nowSec = Math.floor(Date.now() / 1000);
            const setup = this.resolveAutoSimSetup(state);
            const phaseIdx = setup
              ? phaseIndexForState(state, setup.phaseSplit, nowSec)
              : 0;
            if (result.fillShares != null && result.fillPrice != null) {
              this.autoEngine.adoptExternalBuy(
                state,
                side,
                result.fillShares,
                result.fillPrice,
                phaseIdx,
                nowSec,
              );
            }
            if (!holdsPhases) this.autoEngine.suppressBuysForWindow();
          }
          if (holdsPhases) {
            // Pause phase Auto Trade for the window (Prediction + detector Triggers).
            this.predictionTradeHoldWindowKey = sessionKey(state);
            if (fromTrigger && triggerId) {
              this.latchTriggerGtdHold(triggerId, sessionKey(state));
            }
            if (
              fromPrediction &&
              this.config.predictionSellOrderType === "GTD" &&
              result.fillPrice != null &&
              result.fillShares != null
            ) {
              await this.ensurePredictionGtdSell(
                state,
                side,
                result.fillPrice,
                result.fillShares,
              );
            }
            if (
              fromTrigger &&
              triggerSellOrderType === "GTD" &&
              result.fillShares != null
            ) {
              const tpOff =
                options?.takeProfitCents != null && Number.isFinite(options.takeProfitCents)
                  ? Math.round(options.takeProfitCents)
                  : 10;
              await this.ensureTriggerGtdSell(
                state,
                side,
                tpOff,
                result.fillShares,
                result.fillPrice ?? undefined,
                triggerId,
              );
            }
          } else {
            this.manualBuyOverrideWindowKey = sessionKey(state);
          }
        } else {
          const remaining = this.positions[side]?.shares ?? 0;
          if (holdsPhases && remaining <= 0) {
            this.predictionTradeHoldWindowKey = null;
            if (triggerId) this.clearTriggerGtdHold(triggerId);
            if (!this.isLiveArmed()) this.autoEngine.setExternalBuyPaused(false);
          }
          if (!this.isLiveArmed() && remaining <= 0) {
            this.autoEngine.clearExternalPosition(side);
          }
          return { ...result, remainingShares: remaining };
        }
        return result;
      }
      logService.error(
        "trading",
        `${leg.toUpperCase()} ${side.toUpperCase()} failed (single attempt)`,
      );
      return result;
    } finally {
      if (leg === "buy") {
        this.manualBuyPending = false;
        if (
          !this.isLiveArmed() &&
          this.manualBuyOverrideWindowKey !== sessionKey(state) &&
          this.predictionTradeHoldWindowKey !== sessionKey(state)
        ) {
          this.autoEngine.setExternalBuyPaused(false);
        }
      }
    }
  }

  private getPhaseBuyShares(state: LiveWindowState): number | null {
    const setup = this.resolveAutoSimSetup(state);
    if (!setup) return null;
    const nowSec = Math.floor((state.lastTickMs ?? Date.now()) / 1000);
    const duration =
      state.windowStart && state.windowEnd ? state.windowEnd - state.windowStart : 300;
    const frac =
      duration > 0 && state.windowStart
        ? Math.min(1, Math.max(0, (nowSec - state.windowStart) / duration))
        : 0;
    let phaseIdx = 2;
    if (frac < setup.phaseSplit[0]) phaseIdx = 0;
    else if (frac < setup.phaseSplit[1]) phaseIdx = 1;
    return Math.max(1, setup.phases[phaseIdx]?.buyShares ?? this.config.manualShares);
  }

  private hasPendingCards(): boolean {
    const currentKey = this.sessionKey;
    return this.positionCards.some((card) => {
      if (this.isCorruptConfirmedCard(card)) return true;
      if (this.needsSettlementRecheck(card)) return true;
      if (!card.confirmed) return true;
      // Prior-window holds need Gamma settlement even if the buy fill was confirmed.
      if (card.status === "open" && currentKey && card.windowKey !== currentKey) return true;
      return false;
    });
  }

  /** Confirmed cards that clearly used bad Polymarket data (e.g. 0¢) should be re-verified. */
  private isCorruptConfirmedCard(card: TradingPositionCard): boolean {
    if (!card.confirmed) return false;
    if (!isValidSharePrice(card.buyPrice)) return true;
    if (!isValidShareSize(card.shares)) return true;
    if (card.status === "sold" && card.sellPrice != null && !isValidSharePrice(card.sellPrice)) {
      return true;
    }
    return false;
  }

  /** Once per process, re-settle confirmed win/loss against Polymarket (catches false wins). */
  private needsSettlementRecheck(card: TradingPositionCard): boolean {
    if (card.status !== "win" && card.status !== "loss") return false;
    if (!card.confirmed) return true;
    return !this.settlementRecheckedIds.has(card.id);
  }

  private invalidateCorruptConfirmedCards(): void {
    for (const card of this.positionCards) {
      if (this.isCorruptConfirmedCard(card)) {
        card.confirmed = false;
      }
    }
  }

  /** True while any prior-window Open card is still inside the hard Gamma poll window. */
  private hasHeldCardsInHardPollWindow(nowMs = Date.now()): boolean {
    const currentKey = this.sessionKey;
    for (const card of this.positionCards) {
      if (card.status !== "open") continue;
      if (!card.windowKey || (currentKey && card.windowKey === currentKey)) continue;
      const ws = windowKeyUnixSec(card.windowKey);
      if (!Number.isFinite(ws)) return true;
      const windowEndMs = (ws + windowDurationSecFromKey(card.windowKey)) * 1000;
      if (nowMs < windowEndMs + HELD_GAMMA_HARD_POLL_MS) return true;
    }
    return false;
  }

  private nextConfirmDelayMs(): number {
    if (this.hasHeldCardsInHardPollWindow()) return CONFIRM_HARD_INTERVAL_MS;
    const currentKey = this.sessionKey;
    const hasOpenHeld = this.positionCards.some(
      (c) =>
        c.status === "open" &&
        Boolean(c.windowKey) &&
        Boolean(currentKey) &&
        c.windowKey !== currentKey,
    );
    // Held past hard window: light Gamma retries. Other pending (sold/fill) stays snappy.
    if (hasOpenHeld) return CONFIRM_LIGHT_INTERVAL_MS;
    return 3000;
  }

  private ensureConfirmLoop(): void {
    this.invalidateCorruptConfirmedCards();
    if (this.confirmLoopTimer || !this.hasPendingCards()) return;
    const tick = (): void => {
      void this.reconfirmPendingCards().finally(() => {
        this.confirmLoopTimer = null;
        if (!this.hasPendingCards()) return;
        this.confirmLoopTimer = setTimeout(tick, this.nextConfirmDelayMs());
      });
    };
    this.confirmLoopTimer = setTimeout(tick, 0);
  }

  private stopConfirmLoopIfIdle(): void {
    if (this.hasPendingCards() || !this.confirmLoopTimer) return;
    clearTimeout(this.confirmLoopTimer);
    this.confirmLoopTimer = null;
  }

  private async reconfirmPendingCards(): Promise<void> {
    if (this.confirmInFlight) return;
    this.invalidateCorruptConfirmedCards();
    const currentKey = this.sessionKey;
    const pending = this.positionCards.filter((card) => {
      if (this.isCorruptConfirmedCard(card)) return true;
      if (this.needsSettlementRecheck(card)) return true;
      if (!card.confirmed) return true;
      if (card.status === "open" && currentKey && card.windowKey !== currentKey) return true;
      return false;
    });
    if (pending.length === 0) {
      this.stopConfirmLoopIfIdle();
      return;
    }

    this.confirmInFlight = true;
    let changed = false;
    try {
      for (const card of pending) {
        if (this.isCorruptConfirmedCard(card)) card.confirmed = false;
        const before = {
          confirmed: card.confirmed,
          buyPrice: card.buyPrice,
          shares: card.shares,
          sellPrice: card.sellPrice,
          pl: card.pl,
          status: card.status,
        };
        await this.tryConfirmCard(card);
        if (card.status === "win" || card.status === "loss") {
          this.settlementRecheckedIds.add(card.id);
        }
        if (
          card.confirmed !== before.confirmed ||
          card.buyPrice !== before.buyPrice ||
          card.shares !== before.shares ||
          card.sellPrice !== before.sellPrice ||
          card.pl !== before.pl ||
          card.status !== before.status
        ) {
          changed = true;
          this.persistCardStat(card);
        }
      }
      if (changed) this.notify();
    } finally {
      this.confirmInFlight = false;
      this.stopConfirmLoopIfIdle();
    }
  }

  /** One verification pass against Polymarket Data API. Does not poll long — the confirm loop retries. */
  private async tryConfirmCard(card: TradingPositionCard): Promise<void> {
    if (card.status === "sold") {
      if (card.confirmed) return;
      await this.tryConfirmSoldCard(card);
      return;
    }
    if (card.status === "win" || card.status === "loss") {
      // Always allow one Polymarket re-settle pass — confirmed false wins used to stick forever.
      if (card.confirmed && this.settlementRecheckedIds.has(card.id)) return;
      await this.tryConfirmSettledCard(card);
      return;
    }
    if (card.status === "open") {
      const priorWindow =
        Boolean(this.sessionKey) && Boolean(card.windowKey) && card.windowKey !== this.sessionKey;
      if (priorWindow) {
        // Held past window end — Gamma only (no token-mark fallback).
        const settled = await this.trySettleHeldCardFromGamma(card);
        if (!settled) card.confirmed = false;
        return;
      }
      if (!card.confirmed) {
        await this.tryConfirmOpenCard(card);
      }
    }
  }

  private async tryConfirmOpenCard(card: TradingPositionCard): Promise<void> {
    if (!card.asset && !card.conditionId) return;

    try {
      const trades = await fetchUserTrades(this.userId, {
        asset: card.asset,
        conditionId: card.conditionId,
        limit: 40,
      });
      const trade = findTrade(trades, {
        side: "BUY",
        asset: card.asset,
        conditionId: card.conditionId,
        afterTs: card.buyAt - 30,
      });

      if (trade && isValidShareSize(trade.size) && isValidSharePrice(trade.price)) {
        const size = Number(trade.size);
        const price = Number(trade.price);
        card.shares = size;
        card.buyPrice = price;
        card.buyCost = size * price;
        card.buyFees = await resolveTradeFeeUsd(
          this.userId,
          "BUY",
          card.asset ?? trade.asset,
          size,
          price,
          trade,
        );
        card.asset = card.asset ?? trade.asset;
        card.conditionId = card.conditionId ?? trade.conditionId;
        card.slug = card.slug ?? trade.slug;
        if (trade.timestamp != null) card.buyAt = Number(trade.timestamp);
        card.confirmed = true;
      } else {
        const rows = await fetchUserPositions(this.userId, {
          conditionId: card.conditionId,
          sizeThreshold: 0,
        });
        const pos = findPosition(rows, {
          asset: card.asset,
          conditionId: card.conditionId,
        });
        if (pos && isValidShareSize(pos.size) && isValidSharePrice(pos.avgPrice)) {
          card.shares = Number(pos.size);
          card.buyPrice = Number(pos.avgPrice);
          card.buyCost = Number(pos.initialValue ?? card.shares * card.buyPrice);
          card.buyFees = await estimateLiveTakerFee(
            this.userId,
            card.asset ?? pos.asset,
            card.shares,
            card.buyPrice,
          );
          card.asset = card.asset ?? pos.asset;
          card.conditionId = card.conditionId ?? pos.conditionId;
          card.slug = card.slug ?? pos.slug;
          card.confirmed = true;
        }
      }
    } catch {
      // keep pending; loop will retry
    }

    const sidePos = this.positions[card.side];
    if (sidePos?.cardId === card.id && card.confirmed) {
      sidePos.shares = card.shares;
      sidePos.avgPrice = card.buyPrice;
      sidePos.cost = card.buyCost;
      sidePos.buyFees = card.buyFees ?? 0;
      sidePos.asset = card.asset;
      sidePos.conditionId = card.conditionId;
    }
    if (card.confirmed) {
      this.syncBuyMarkerFromCard(card);
      this.scheduleUpsertPositionCard(card);
    }
  }

  private syncBuyMarkerFromCard(card: TradingPositionCard): void {
    for (let i = this.markers.length - 1; i >= 0; i -= 1) {
      const marker = this.markers[i];
      if (
        marker.type === "buy" &&
        marker.windowKey === card.windowKey &&
        marker.side === card.side
      ) {
        marker.shares = card.shares;
        marker.price = card.buyPrice;
        marker.cost = card.buyCost;
        marker.fees = card.buyFees ?? 0;
        marker.total = card.buyCost + (card.buyFees ?? 0);
        break;
      }
    }
  }

  private async tryConfirmSoldCard(card: TradingPositionCard): Promise<void> {
    if (!card.asset && !card.conditionId) return;

    try {
      const soldAt = card.soldAt ?? card.buyAt;
      const trades = await fetchUserTrades(this.userId, {
        asset: card.asset,
        conditionId: card.conditionId,
        limit: 40,
      });
      const trade = findTrade(trades, {
        side: "SELL",
        asset: card.asset,
        conditionId: card.conditionId,
        afterTs: soldAt - 30,
      });

      if (trade && isValidShareSize(trade.size) && isValidSharePrice(trade.price)) {
        const size = Number(trade.size);
        const price = Number(trade.price);
        const buyTrade = findTrade(trades, {
          side: "BUY",
          asset: card.asset ?? trade.asset,
          conditionId: card.conditionId ?? trade.conditionId,
          afterTs: card.buyAt - 120,
        });
        if (!isValidSharePrice(card.buyPrice) && buyTrade && isValidSharePrice(buyTrade.price)) {
          card.buyPrice = Number(buyTrade.price);
        }
        card.shares = size;
        card.sellPrice = price;
        card.sellProceeds = size * price;
        card.buyCost = size * card.buyPrice;
        card.buyFees = await resolveTradeFeeUsd(
          this.userId,
          "BUY",
          card.asset,
          card.shares,
          card.buyPrice,
          buyTrade,
        );
        card.sellFees = await resolveTradeFeeUsd(
          this.userId,
          "SELL",
          card.asset ?? trade.asset,
          size,
          price,
          trade,
        );
        card.asset = card.asset ?? trade.asset;
        card.conditionId = card.conditionId ?? trade.conditionId;
        card.slug = card.slug ?? trade.slug;
        if (trade.timestamp != null) card.soldAt = Number(trade.timestamp);
        card.pl = feeAwarePlSold(card);
        if (isValidSharePrice(card.buyPrice)) {
          card.confirmed = true;
        }
      }

      const rows = await fetchClosedPositions(this.userId, {
        conditionId: card.conditionId,
        limit: 30,
      });
      const closed = findClosedPosition(rows, {
        asset: card.asset,
        conditionId: card.conditionId,
        afterTs: card.buyAt - 30,
        side: card.side,
      });

      if (closed?.realizedPnl != null && Number.isFinite(Number(closed.realizedPnl))) {
        if (closed.avgPrice != null && isValidSharePrice(closed.avgPrice)) {
          card.buyPrice = Number(closed.avgPrice);
        }
        if (closed.totalBought != null && isValidShareSize(closed.totalBought)) {
          const bought = Number(closed.totalBought);
          card.shares = bought;
          card.buyCost = bought * card.buyPrice;
          if (card.sellPrice != null && isValidSharePrice(card.sellPrice)) {
            card.sellProceeds = bought * card.sellPrice;
          }
        }
        card.buyFees = await estimateLiveTakerFee(this.userId, card.asset, card.shares, card.buyPrice);
        if (card.sellPrice != null) {
          card.sellFees = await estimateLiveTakerFee(this.userId, card.asset, card.shares, card.sellPrice);
        }
        card.asset = card.asset ?? closed.asset;
        card.conditionId = card.conditionId ?? closed.conditionId;
        card.slug = card.slug ?? closed.slug;
        card.pl = feeAwarePlFromGross(Number(closed.realizedPnl), card);
        if (isValidSharePrice(card.buyPrice) && isValidShareSize(card.shares)) {
          card.confirmed = true;
        }
      }
    } catch {
      // keep pending
    }
  }

  private async tryConfirmSettledCard(card: TradingPositionCard): Promise<void> {
    // Re-verify Win/Loss against Gamma only (catches stale wrong outcomes).
    await this.trySettleHeldCardFromGamma(card);
  }

  private async enrichCardFromPolymarketBuy(cardId: string): Promise<void> {
    const card = this.findCard(cardId);
    if (!card) return;
    await this.tryConfirmCard(card);
    this.persistCardStat(card);
    this.notify();
    this.ensureConfirmLoop();
  }

  private async enrichCardFromPolymarketSell(cardId: string, _soldAt: number): Promise<void> {
    const card = this.findCard(cardId);
    if (!card) return;
    await this.tryConfirmCard(card);
    this.persistCardStat(card);
    this.notify();
    this.ensureConfirmLoop();
  }

  private async executeOrder(
    state: LiveWindowState,
    side: "up" | "down",
    leg: "buy" | "sell",
    size: number,
    source: "manual" | "auto" | "trigger",
    sizeUnit: "shares" | "usdc" = "shares",
    orderType: MarketOrderType = "FOK",
    maxPrice?: number,
    buyPhaseIdx?: number,
    opts?: {
      triggerId?: string;
      triggerName?: string;
      triggerExitReason?: "tp" | "sl";
      minPrice?: number;
    },
  ): Promise<{
    ok: boolean;
    error?: string;
    fillShares?: number;
    fillPrice?: number;
    triggerMiss?: boolean;
  }> {
    if (!isTradingExecutor()) {
      logNonExecutorSkipOnce();
      return { ok: false, error: "Trading executor not enabled in this process" };
    }
    if (this.orderInFlight) return { ok: false, error: "Order already in progress" };
    if (leg === "buy") {
      if (this.isBuyBlocked(state) && source === "auto") {
        return { ok: false, error: "Buy blocked for this window" };
      }
      if (this.pendingBuyConfirm) {
        return { ok: false, error: "Buy pending confirmation" };
      }
    }
    this.orderInFlight = true;
    try {
      const result = await placeMarketOrder(this.userId, {
        series: state.series,
        side,
        leg,
        size,
        sizeUnit: leg === "sell" ? "shares" : sizeUnit,
        orderType,
        maxPrice: leg === "buy" ? maxPrice : undefined,
        minPrice: leg === "buy" ? opts?.minPrice : undefined,
        state,
      });
      const fillKind: FillOrderKind = orderType;
      if (!result.success || result.fillPrice == null || result.fillShares == null) {
        if (leg === "buy" && result.ambiguous) {
          const reason = result.error ?? "ambiguous buy response";
          await this.noteFillAttempt({
            leg: "buy",
            side,
            series: state.series,
            orderId: result.orderId,
            orderKind: fillKind,
            success: false,
          });
          this.beginPendingBuyConfirm(state, {
            side,
            source,
            reason,
            orderId: result.orderId,
            tokenId: result.tokenId,
            conditionId: result.conditionId,
            slug: result.slug,
            buyPhaseIdx,
            triggerId: opts?.triggerId,
          });
          await this.resolvePendingBuyConfirm(state);
          const pos = this.positions[side] ?? this.positions.up ?? this.positions.down;
          if (pos) {
            await this.noteFillSuccess(result.orderId);
            return { ok: true, fillShares: pos.shares, fillPrice: pos.avgPrice };
          }
        } else {
          await this.noteFillAttempt({
            leg,
            side,
            series: state.series,
            orderId: result.orderId,
            orderKind: fillKind,
            success: false,
          });
        }
        return { ok: false, error: result.error ?? "Order failed" };
      }

      await this.noteFillAttempt({
        leg,
        side,
        series: state.series,
        orderId: result.orderId,
        orderKind: fillKind,
        success: true,
      });

      const nowSec = Math.floor(Date.now() / 1000);
      const fillShares = result.fillShares;
      const fillPrice = result.fillPrice;
      const triggerMiss = result.triggerMiss === true;

      if (leg === "buy") {
        await this.recordBuyFill(
          state,
          side,
          fillShares,
          fillPrice,
          result.usdcAmount,
          result.tokenId,
          result.conditionId,
          result.slug,
          source,
          undefined,
          buyPhaseIdx,
          {
            ...(opts?.triggerId ? { triggerId: opts.triggerId } : {}),
            ...(opts?.triggerName ? { triggerName: opts.triggerName } : {}),
            ...(triggerMiss ? { triggerMiss: true } : {}),
          },
        );
      } else {
        const pos = this.positions[side]!;
        const proceeds = result.usdcAmount ?? fillShares * fillPrice;
        const sellFees = await estimateLiveTakerFee(
          this.userId,
          result.tokenId ?? pos.asset,
          fillShares,
          fillPrice,
        );
        const buyFees = pos.buyFees ?? 0;
        const profit = proceeds - sellFees - (pos.cost + buyFees);
        this.lockQuote(side, "sell", fillPrice);
        const card = this.findCard(pos.cardId);
        if (card && card.status === "open") {
          card.status = "sold";
          card.sellPrice = fillPrice;
          card.sellProceeds = proceeds;
          card.sellFees = sellFees;
          card.buyFees = card.buyFees ?? buyFees;
          card.soldAt = nowSec;
          card.pl = profit;
          card.shares = fillShares;
          card.asset = card.asset ?? result.tokenId ?? pos.asset;
          card.conditionId = card.conditionId ?? result.conditionId ?? pos.conditionId;
          card.slug = card.slug ?? result.slug;
          card.confirmed = false;
          if (opts?.triggerExitReason === "tp" || opts?.triggerExitReason === "sl") {
            card.triggerExitReason = opts.triggerExitReason;
          }
          this.persistCardStat(card);
          const tid = typeof card.triggerId === "string" ? card.triggerId.trim() : "";
          if (tid && card.source === "trigger") {
            this.publishTriggerLiveSell(tid, card.side, fillPrice, fillShares);
          }
          void this.enrichCardFromPolymarketSell(card.id, nowSec);
        }
        this.addMarker(state, {
          type: "sell",
          side,
          t: nowSec,
          y: state.assetPrice ?? null,
          shares: fillShares,
          price: fillPrice,
          proceeds,
          fees: sellFees,
          profit,
          total: proceeds,
        });
        this.positions[side] = null;
        if (card?.triggerId) this.clearTriggerGtdHold(card.triggerId);
        void refreshCollateralBalance(this.userId);
        this.notify();
      }

      return {
        ok: true,
        fillShares,
        fillPrice,
        ...(leg === "buy" && triggerMiss ? { triggerMiss: true } : {}),
      };
    } finally {
      this.orderInFlight = false;
    }
  }

  /** Server Trigger Demo buy — Positions card only (no wallet / CLOB). */
  upsertDemoTriggerOpen(input: {
    triggerId: string;
    triggerName?: string;
    side: "up" | "down";
    shares: number;
    buyPrice: number;
    series: string;
    windowStart: number;
    slug?: string;
    triggerMiss?: boolean;
  }): string {
    const triggerId = String(input.triggerId || "").trim();
    const side = input.side === "down" ? "down" : "up";
    const windowStart = Math.floor(Number(input.windowStart));
    const shares = Math.max(0, Number(input.shares) || 0);
    const buyPrice = Number(input.buyPrice);
    const series =
      String(input.series || "").trim().toLowerCase() || this.boundSeries || DEFAULT_MARKET_SERIES;
    if (!triggerId || !Number.isFinite(windowStart) || windowStart <= 0) return "";
    if (!Number.isFinite(buyPrice) || buyPrice <= 0 || shares <= 0) return "";
    const windowKey = `${series}:${windowStart}`;
    const buyAt = Math.floor(Date.now() / 1000);
    // At most one Open Demo card per trigger per market window (ticks may re-upsert).
    // Prior-window Open cards waiting for Gamma settlement stay — never overwrite them.
    const openExisting = this.positionCards.find(
      (c) =>
        isDemoPositionCard(c) &&
        c.status === "open" &&
        String(c.triggerId || "") === triggerId &&
        String(c.windowKey || "") === windowKey,
    );
    if (openExisting) {
      openExisting.shares = shares;
      openExisting.buyPrice = buyPrice;
      openExisting.buyCost = shares * buyPrice;
      openExisting.side = side;
      if (input.triggerMiss) openExisting.triggerMiss = true;
      if (input.slug) openExisting.slug = input.slug;
      this.scheduleUpsertPositionCard(openExisting);
      this.publishTriggerLiveBuy(triggerId, side, buyPrice, shares);
      this.notify();
      return openExisting.id;
    }
    const id = `demo:${triggerId}:${windowStart}:${side}:${buyAt}`;
    const card: TradingPositionCard = {
      id,
      windowKey,
      series,
      side,
      shares,
      buyPrice,
      buyCost: shares * buyPrice,
      buyFees: 0,
      buyAt,
      status: "open",
      confirmed: true,
      source: "trigger",
      triggerId,
      demo: true,
    };
    if (typeof input.triggerName === "string" && input.triggerName.trim()) {
      card.triggerName = input.triggerName.trim();
    }
    if (input.slug) card.slug = input.slug;
    if (input.triggerMiss) card.triggerMiss = true;
    this.positionCards.unshift(card);
    this.positionCards = trimPositionCardsForUi(this.positionCards);
    this.scheduleUpsertPositionCard(card);
    this.publishTriggerLiveBuy(triggerId, side, buyPrice, shares);
    this.notify();
    return id;
  }

  /** Server Trigger Demo early exit (TP/SL). */
  settleDemoTriggerSold(input: {
    cardId: string;
    sellPrice: number;
    exitReason: "tp" | "sl";
  }): void {
    const card = this.findCard(input.cardId);
    if (!card || card.demo !== true || card.status !== "open") return;
    const sellPrice = Number(input.sellPrice);
    if (!Number.isFinite(sellPrice)) return;
    const shares = Number(card.shares) || 0;
    card.status = "sold";
    card.sellPrice = sellPrice;
    card.sellProceeds = shares * sellPrice;
    card.sellFees = 0;
    card.soldAt = Math.floor(Date.now() / 1000);
    card.pl = (sellPrice - Number(card.buyPrice)) * shares;
    card.triggerExitReason = input.exitReason === "sl" ? "sl" : "tp";
    card.confirmed = true;
    this.persistCardStat(card);
    const tid = typeof card.triggerId === "string" ? card.triggerId.trim() : "";
    if (tid) this.publishTriggerLiveSell(tid, card.side, sellPrice, shares);
    this.notify();
  }
}

class LiveTradingRegistry {
  private engines = new Map<string, LiveTradingService>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<UpdateListener>();
  private readonly fanOut = (): void => {
    for (const listener of this.listeners) listener();
  };

  get(userId: string): LiveTradingService {
    let engine = this.engines.get(userId);
    if (!engine) {
      engine = new LiveTradingService(userId);
      engine.onUpdate(this.fanOut);
      this.engines.set(userId, engine);
    }
    return engine;
  }

  async ensureLoaded(userId: string): Promise<LiveTradingService> {
    const engine = this.get(userId);
    // Hydrate stats once; later ensureLoaded calls only refresh config.
    await engine.loadPersistedConfig({ hydrateStats: false });
    // Connect once — skip full CLOB re-init when the client is already live
    // (hour-stats / placement-stats hit this on every Schedule SSE refresh).
    if (isTradingExecutor() && !isTradingClientReady(userId)) {
      try {
        await initTradingClient(userId);
      } catch {
        /* logged in client */
      }
    }
    return engine;
  }

  async tickAll(state: LiveWindowState, nowMs?: number): Promise<void> {
    const engines = [...this.engines.values()];
    const displaySeries =
      String(state.series || "").trim() || DEFAULT_MARKET_SERIES;
    const matching = engines.filter((e) => e.getBoundSeries() === displaySeries);
    const otherSeries = [
      ...new Set(
        engines
          .map((e) => e.getBoundSeries())
          .filter((s) => s && s !== displaySeries),
      ),
    ];

    await Promise.all(matching.map((e) => e.tick(state, nowMs).catch(() => {})));

    if (otherSeries.length === 0) {
      seriesMarketHub.setActiveSeries([]);
      return;
    }
    await seriesMarketHub.ensureSeries(otherSeries);
    await Promise.all(
      otherSeries.map(async (series) => {
        const feed = seriesMarketHub.getState(series);
        if (!feed) return;
        await Promise.all(
          engines
            .filter((e) => e.getBoundSeries() === series)
            .map((e) => e.tick(feed, nowMs).catch(() => {})),
        );
      }),
    );
  }

  drop(userId: string): void {
    this.engines.delete(userId);
  }

  async syncFromMongo(): Promise<void> {
    const users = await listUsersForLiveTrading();
    for (const user of users) {
      const id = String(user._id);
      const engine = this.get(id);
      // Config refresh; first call still hydrates stats once (see loadPersistedConfig).
      await engine.loadPersistedConfig({ hydrateStats: false });
      if (isTradingExecutor() && user.wallet?.privateKeyEnc && user.wallet?.funderAddress) {
        try {
          // Connected: balance refresh only. Disconnected: full connect (logged once).
          await initTradingClient(id, { reason: "poll" });
        } catch {
          /* logged in client */
        }
      }
    }
    // Keep engines + series feeds warm for Active Demo (browser may be closed).
    if (isTradingExecutor()) {
      try {
        const { listAllActiveDemoTriggers } = await import("./db/user-trigger-repository.js");
        const demos = await listAllActiveDemoTriggers();
        const seriesSet = new Set<string>();
        const userSet = new Set<string>();
        for (const t of demos) {
          userSet.add(t.userId);
          if (t.series) seriesSet.add(t.series);
        }
        for (const userId of userSet) {
          const engine = this.get(userId);
          await engine.loadPersistedConfig({ hydrateStats: false });
        }
        if (seriesSet.size > 0) {
          await seriesMarketHub.ensureSeries([...seriesSet]);
        }
      } catch {
        /* ignore */
      }
    }
  }

  /** Discover live users + refresh config. Default 60s (was 5s full hydrate). */
  startPolling(intervalMs = 60_000): void {
    if (this.pollTimer) return;
    void this.syncFromMongo();
    this.pollTimer = setInterval(() => {
      void this.syncFromMongo();
    }, intervalMs);
  }

  stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Forward engine updates — same contract as LiveTradingService.onUpdate. */
  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listEngines(): LiveTradingService[] {
    return [...this.engines.values()];
  }
}

export const liveTradingRegistry = new LiveTradingRegistry();