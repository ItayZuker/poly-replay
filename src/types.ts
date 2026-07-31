import type { BookLevel } from "./clob-service.js";

export type WindowOutcome = "up" | "down";
export type TickSource = "clob-book" | "chainlink-tick";

export const BOOK_DEPTH_LEVELS = 5;

export interface MarketDocument {
  _id: string;
  label: string;
  timeframeMinutes: number;
  /** When true, series is shown in the trader app and trading APIs allow it. */
  available: boolean;
  /** When true, a non-executor process captures ticks/windows for this series. */
  recordingEnabled: boolean;
  /** Hot tick/window retention for this series (days). Default 14. */
  retentionDays: number;
  createdAt: string;
  updatedAt: string;
}

export interface RecordedWindowDocument {
  _id: string;
  windowStart: number;
  windowEnd: number;
  savedAt: string;
  updatedAt: string;
  slug?: string;
  question?: string;
  conditionId?: string;
  assetPrice?: number;
  prevCloseAsset?: number;
  assetGap?: number;
  windowOutcome?: WindowOutcome;
  yesPrice?: number;
  noPrice?: number;
  ptbCrossings?: number;
  minAssetPrice?: number;
  maxAssetPrice?: number;
  assetRange?: number;
  rangeTop?: number;
  rangeBottom?: number;
  uniqueTraders?: number;
  newWallets?: number;
  knownWallets?: number;
  tickCount: number;
  clobRawCount?: number;
  clobBookCount?: number;
  chainlinkCount?: number;
}

export interface WalletRegistryEntry {
  address: string;
  firstSeenAt: number;
  lastSeenAt: number;
  markets: Record<string, number>;
  totalSightings: number;
}

export type WalletRegistry = Record<string, WalletRegistryEntry>;

/** Raw CLOB websocket payload for audit replay. */
export interface ClobRawTickDocument {
  _id: string;
  windowStart: number;
  windowEnd: number;
  tMs: number;
  payload: unknown;
}

/** Parsed top-of-book depth snapshot after each raw WS message. */
export interface ClobBookTickDocument {
  _id: string;
  windowStart: number;
  windowEnd: number;
  tMs: number;
  yesPrice?: number;
  noPrice?: number;
  yesBids: BookLevel[];
  yesAsks: BookLevel[];
  noBids: BookLevel[];
  noAsks: BookLevel[];
}

/** @deprecated Use ClobBookTickDocument */
export type BookTickDocument = ClobBookTickDocument;

/** Chainlink asset price and per-window dynamics. */
export interface ChainlinkTickDocument {
  _id: string;
  windowStart: number;
  windowEnd: number;
  tMs: number;
  assetPrice?: number;
  prevCloseAsset?: number;
  assetGap?: number;
  ptbCrossings?: number;
  minAssetPrice?: number;
  maxAssetPrice?: number;
  assetRange?: number;
  rangeTop?: number;
  rangeBottom?: number;
}

/** Merged book + chainlink state for replay APIs. */
export interface ReplayTickDocument {
  tMs: number;
  t: number;
  elapsedSec: number;
  source: TickSource;
  yesPrice?: number;
  noPrice?: number;
  yesBid?: number;
  noBid?: number;
  yesAsk?: number;
  noAsk?: number;
  yesBidSize?: number;
  noBidSize?: number;
  yesAskSize?: number;
  noAskSize?: number;
  yesBids?: BookLevel[];
  yesAsks?: BookLevel[];
  noBids?: BookLevel[];
  noAsks?: BookLevel[];
  assetPrice?: number;
  prevCloseAsset?: number;
  assetGap?: number;
  ptbCrossings?: number;
  minAssetPrice?: number;
  maxAssetPrice?: number;
  assetRange?: number;
  rangeTop?: number;
  rangeBottom?: number;
}

/** @deprecated Use BookTickDocument */
export type TickDocument = BookTickDocument;

export interface HeatmapWindowDocument {
  _id: string;
  windowStart: number;
  windowEnd: number;
  savedAt: string;
  ptbCrossings?: number;
  assetRange?: number;
  minAssetPrice?: number;
  maxAssetPrice?: number;
  rangeTop?: number;
  rangeBottom?: number;
  uniqueTraders?: number;
  newWallets?: number;
  knownWallets?: number;
  windowOutcome?: WindowOutcome;
}

export interface WindowHitRecord {
  windowStart: number;
  windowEnd: number;
  slug?: string;
  question?: string;
  conditionId?: string;
  assetPrice?: number;
  prevCloseAsset?: number;
  assetGap?: number;
  windowOutcome?: WindowOutcome;
  yesPrice?: number;
  noPrice?: number;
  ptbCrossings?: number;
  minAssetPrice?: number;
  maxAssetPrice?: number;
  assetRange?: number;
  rangeTop?: number;
  rangeBottom?: number;
  uniqueTraders?: number;
  newWallets?: number;
  knownWallets?: number;
  savedAt?: string;
}

export interface LiveWindowState {
  series: string;
  windowStart: number;
  windowEnd: number;
  slug?: string;
  question?: string;
  prevCloseAsset?: number;
  assetPrice?: number;
  assetGap?: number;
  /** Where prevCloseAsset (PTB) came from — Polymarket published window open. */
  priceToBeatSource?: "polymarket-openPrice";
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  yesBidSize?: number;
  yesAskSize?: number;
  noBidSize?: number;
  noAskSize?: number;
  yesBids?: BookLevel[];
  yesAsks?: BookLevel[];
  noBids?: BookLevel[];
  noAsks?: BookLevel[];
  yesDisplay?: number;
  noDisplay?: number;
  ptbCrossings?: number;
  minAssetPrice?: number;
  maxAssetPrice?: number;
  assetRange?: number;
  uniqueTraders?: number;
  lastTickMs?: number;
  /** Measured CLOB WebSocket round-trip latency (ms). */
  feedLatencyMs?: number;
  priceHistory: Array<{ t: number; price: number }>;
  /** Monotonic sequence incremented once per CLOB book update. */
  bookTickSequence?: number;
}

/** Direction / dual-side policy vs PTB. Same meaning for FAK and GTD. */
export type GapVsPtb = "with" | "opposite" | "first" | "both";

/** Optimize off → GTD resting limit; optimize on → immediate FAK. */
export type BuyOrderType = "GTD" | "FAK";

export interface SimPhaseConfig {
  buyEnabled: boolean;
  buyShares: number;
  /** Ask touch / limit price in cents (1–99). */
  buyTrigger: number;
  /** After touching trigger, hunt a better (≤) fill. */
  buyOptimize: boolean;
  /**
   * Buy execution type for this phase (derived from buyOptimize).
   * Optimize off: GTD. Optimize on: FAK.
   */
  buyOrderType: BuyOrderType;
  /** Min |asset−PTB| in $; 0 = ignore. */
  minGap: number;
  /** Max |asset−PTB| in $; 0 = ignore. */
  maxGap: number;
  /** Gap direction relative to the side being bought. */
  gapVsPtb: GapVsPtb;
  /**
   * Abort unfilled buys after this many PTB crossings in the current phase.
   * 0 = off; clamped 0–1000.
   */
  buyAbortOnCrossing: number;
  /**
   * Sell limit = buy + this many cents.
   * 100 = off (hold to settlement, no sell). Clamped 1–100.
   */
  sellProfitCents: number;
}


export interface SimTakerFeeParams {
  feeRate: number;
  feeExponent: number;
}

export interface SimSetup {
  phaseSplit: [number, number];
  phases: [SimPhaseConfig, SimPhaseConfig, SimPhaseConfig];
  /** Simulated order latency before fill re-check (ms). */
  latencyMs: number;
  /**
   * Probability (0–100) that a would-be fill succeeds after latency.
   * 100 = always fill when the book allows; 0 = never fill.
   */
  fillSuccessPct?: number;
  /** Polymarket taker fee params (crypto default; override from CLOB when available). */
  feeParams?: SimTakerFeeParams;
}

/** Phase trading config persisted for replay (no latency or market). */
export interface TradingPhaseSetup {
  phaseSplit: [number, number];
  phases: [SimPhaseConfig, SimPhaseConfig, SimPhaseConfig];
}

export interface TradingSetupRecord {
  /** Owner — required for multi-user isolation. */
  userId: string;
  title: string;
  description?: string;
  color?: string;
  setup: TradingPhaseSetup;
  createdAt: Date;
  /** Lower = higher in the schedule setups list. */
  sortOrder?: number;
  /**
   * True while at least one card using this setup is on the live schedule
   * (`schedual_setups_real`). Sim apps should refuse to delete when set.
   */
  liveScheduleInUse?: boolean;
  /**
   * True while at least one card using this setup is on the sim schedule
   * (`schedual_setups_sim`). Real app disables delete when set.
   */
  simScheduleInUse?: boolean;
}

/** Replay-mode setups live in `trading_setups_replay`; placements in `schedual_setups_replay`. */

export type ScheduleDayId = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface SchedulePlacementRecord {
  /** Owner — required for multi-user isolation. */
  userId: string;
  /** Market series this schedule board belongs to (e.g. btc-5m). */
  series: string;
  setupId: string;
  title: string;
  day: ScheduleDayId;
  startHour: number;
  durationHours: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SimMarker {
  type: "buy" | "sell";
  side: "up" | "down";
  t: number;
  y: number | null;
  shares: number;
  price: number;
  /** FAK buy execution cap inherited from the armed watch. */
  triggerCents?: number;
  /** Phase index at buy fill (sell profit source). */
  phaseIndex?: number;
  /** Who placed the fill — used for Replay per-trade dots. */
  source?: "phase" | "prediction" | "trigger";
  cost?: number;
  fees?: number;
  proceeds?: number;
  profit?: number;
  /** Total position cost (buy: cost+fees) or total sale (sell: proceeds). */
  total?: number;
  /** Trigger held-to-window settlement (Replay dots: blue/red by outcome, not P/L). */
  heldSettlement?: boolean;
  windowKey: string;
}

export interface SimLastWindow {
  windowKey: string;
  windowStart: number;
  windowEnd?: number;
  outcome?: "up" | "down";
  prevCloseAsset?: number;
  assetPrice?: number;
  assetGap?: number;
  side?: "up" | "down";
  shares?: number;
  buyPrice?: number;
  buyCost?: number;
  buyFees?: number;
  positionCost?: number;
  sold: boolean;
  sellPrice?: number;
  sellProceeds?: number;
  positionWon?: boolean | null;
  pl: number;
  plLabel: "Trade" | "Settlement" | "No trade";
}

export interface SimQuoteLocks {
  upBuy: number | null;
  upSell: number | null;
  downBuy: number | null;
  downSell: number | null;
}

export interface SimPublicState {
  setup: SimSetup;
  markers: SimMarker[];
  quoteLocks: SimQuoteLocks;
  lastWindow: SimLastWindow | null;
}

export interface TradingConfig {
  autoTrade: boolean;
  useSchedule: boolean;
  startTrading: boolean;
  /** Manual buy size (share count or USDC, depending on manualOrderUnit). */
  manualShares: number;
  manualOrderUnit: "shares" | "usdc";
  /** Order type for manual quote Buy clicks. */
  manualBuyOrderType: "FAK" | "FOK";
  /** Order type for manual quote Sell clicks. */
  manualSellOrderType: "FAK" | "FOK";
  /** Client-side manipulation detector (visual flag only when predictionTrade is off). */
  manipulationDetector: boolean;
  /**
   * When true (and Allow trade + Prediction are on), detector triggers place real
   * Buy/Sell using predictionShares and prediction Buy/Sell order types.
   */
  predictionTrade: boolean;
  /** Share count for Prediction Trade buys (sells use held shares). */
  predictionShares: number;
  /** Order type for Prediction Trade buys. */
  predictionBuyOrderType: "FAK" | "FOK";
  /**
   * Order type for Prediction Trade sells.
   * GTD: rest limit at buy + Profit prediction as soon as the Buy fills.
   */
  predictionSellOrderType: "FAK" | "FOK" | "GTD";
  /** Seconds the adverse UP/DOWN vs gap condition must hold. */
  manipulationSensitivitySec: number;
  /**
   * Max Buy price (¢) allowed when Duration starts on the cheapening side
   * (UP Buy for Prediction DOWN, DOWN Buy for Prediction UP).
   */
  predictionMaxQuoteCents: number;
  /**
   * Min Buy price (¢) allowed when Duration starts on the cheapening side
   * (same side as Max Quote). Must be ≤ Max Quote.
   */
  predictionMinQuoteCents: number;
  /** Minimum drop (¢) of that cheapening Buy over Duration (1–50). */
  predictionShiftCents: number;
  /**
   * Profit prediction (¢): after trigger, predicted-side Sell must reach
   * trigger Buy + this many ¢ before window end for Right (1–50).
   */
  predictionRiseCents: number;
  /** Start of detection area as fraction of the market window [0, 1]. */
  manipulationAreaStart: number;
  /** End of detection area as fraction of the market window [0, 1]. */
  manipulationAreaEnd: number;
  /** Prediction detector: windows scored correct (per series). */
  predictionRightCount: number;
  /** Prediction detector: windows scored incorrect (per series). */
  predictionWrongCount: number;
}

export interface LiveSidePosition {
  shares: number;
  avgPrice: number;
  cost: number;
  cardId?: string;
}

export type TradingPositionCardStatus = "open" | "sold" | "win" | "loss";

export interface TradingPositionCard {
  id: string;
  windowKey: string;
  series: string;
  side: "up" | "down";
  shares: number;
  buyPrice: number;
  buyCost: number;
  /** Estimated Polymarket taker fee paid on the buy (USDC). */
  buyFees?: number;
  buyAt: number;
  status: TradingPositionCardStatus;
  sellPrice?: number;
  sellProceeds?: number;
  /** Estimated Polymarket taker fee paid on the sell (USDC). */
  sellFees?: number;
  soldAt?: number;
  pl?: number;
  outcome?: "up" | "down";
  /** Polymarket outcome token id */
  asset?: string;
  conditionId?: string;
  slug?: string;
  /** Whether buy/sell/P/L numbers were confirmed from Polymarket Data API */
  confirmed?: boolean;
  /** Schedule placement that auto-triggered this trade (real schedule only). */
  placementId?: string;
  /**
   * How the buy was initiated. Manual trades count in Market/Live only —
   * never on Schedule cards or Schedule totals.
   */
  source?: "manual" | "auto";
}

/** Live real-trade aggregates for a schedule placement card. */
export interface PlacementLiveStats {
  placementId: string;
  hasData: boolean;
  green: number;
  red: number;
  blue: number;
  pnl: number;
  /** True once the placement has started at least one window (locked until removed). */
  locked: boolean;
}

/** Per CLOB order style inside Market → Trade fill success. */
export interface FillSuccessKindPublicStats {
  attempts: number;
  successes: number;
  /** 0–100; null when there are no attempts for this kind. */
  ratePct: number | null;
}

export interface FillSuccessPublicStats {
  attempts: number;
  successes: number;
  /** 0–100; null when there are no countable attempts in the rolling window. */
  ratePct: number | null;
  cutoffUtc: number;
  /** FAK / FOK / GTD breakdown (partial fill = success). */
  byKind: {
    FAK: FillSuccessKindPublicStats;
    FOK: FillSuccessKindPublicStats;
    GTD: FillSuccessKindPublicStats;
  };
}

export interface TradingPublicState {
  config: TradingConfig;
  positions: { up: LiveSidePosition | null; down: LiveSidePosition | null };
  positionCards: TradingPositionCard[];
  placementStats: PlacementLiveStats[];
  /** Settled real outcomes in the header Live range (after last header reset; includes trades without a schedule card). */
  sessionTotals: {
    green: number;
    red: number;
    blue: number;
    pnl: number;
    hasData: boolean;
  };
  /**
   * Latest finished auto-engine window (preview or mirrored) — client accumulates
   * into local "Demo update". Null when Auto Trade is off.
   */
  demoLastWindow: SimLastWindow | null;
  quoteLocks: SimQuoteLocks;
  markers: SimMarker[];
  phaseSetup: TradingPhaseSetup | null;
  phasesVisible: boolean;
  phasesEditable: boolean;
  scheduleTitle: string | null;
  scheduleSetupId: string | null;
  quotesEnabled: boolean;
  previewMode: boolean;
  /**
   * Rolling ~7-day CLOB fill success by order kind (buys + sells; any size = success).
   * GTD counts only when the limit was touched while live.
   */
  fillSuccess: FillSuccessPublicStats;
}

export interface EnrichedLiveWindowState extends LiveWindowState {
  sim: SimPublicState;
  trading: TradingPublicState | null;
}
