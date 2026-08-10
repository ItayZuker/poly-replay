import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
  initStorageAndSeed,
  ensureAllMarketIndexes,
  listAvailableMarkets,
  getMarket,
  requireAvailableMarket,
} from "./db/market-repository.js";
import { listReplayTicks } from "./db/replay-tick-repository.js";
import {
  listChainlinkTicks,
  listClobBookTicks,
  listClobRawTicks,
  windowsHavingChainlinkTicks,
  windowsHavingReplayTickFiles,
} from "./db/tick-repository.js";
import { clobMarketFeed } from "./clob-market-feed.js";
import { chainlinkPriceFeed } from "./chainlink-price-feed.js";
import { displayService } from "./display-service.js";
import { simulatorService } from "./simulator-service.js";
import { logService } from "./log-service.js";
import {
  deleteSchedulePlacement,
  deletePlacementsByDay,
  deletePlacementsBySetupId,
  deleteAllSchedulePlacementsForUser,
  ensureSchedulePlacementsUserId,
  getSchedulePlacementById,
  insertSchedulePlacement,
  listSchedulePlacements,
  replaceAllPlacementsSetup,
  replaceDayWithSetup,
  replaceWeekWithSetup,
  updatePlacementTitlesBySetupId,
  updateSchedulePlacement,
} from "./db/schedule-placement-repository.js";
import type { SchedulePlacementListItem } from "./db/schedule-placement-repository.js";
import {
  insertTradingSetup,
  listTradingSetups,
  getTradingSetupById,
  updateTradingSetup,
  deleteTradingSetup,
  deleteAllTradingSetupsForUser,
  reorderTradingSetups,
  normalizePhaseSetup,
  ensureTradingSetupsUserId,
} from "./db/trading-setup-repository.js";
import {
  reconcileLiveScheduleInUseFlags,
  syncLiveScheduleInUseForSetup,
} from "./db/live-schedule-setup-usage.js";
import {
  parseScheduleWorkspaceMode,
  type ScheduleWorkspaceMode,
} from "./schedule-workspace-mode.js";
import {
  deleteAllTradingSessionDataForUser,
  ensureTradingSessionMemoryUserId,
  sumTradingSessionMemory,
  sumTradingStatEventsForSeries,
} from "./db/trading-session-memory-repository.js";
import { deleteAllPositionCardsForUser } from "./db/position-card-repository.js";
import {
  deleteAllTriggerDemoStatsCreditsForUser,
  deleteTriggerDemoStatsCredits,
} from "./db/trigger-demo-stats-repository.js";
import {
  deleteAllTriggerLiveStatsForUser,
  deleteTriggerLiveStats,
  getTriggerLiveStats,
  recordTriggerLiveStatsEvent,
} from "./db/trigger-live-stats-repository.js";
import {
  ensureTriggerModeTimelineIndexes,
  listTriggerModeEvents,
  sumTriggerActiveMs,
} from "./db/trigger-mode-timeline-repository.js";
import {
  deleteAllUserTriggers,
  deleteUserTrigger,
  getUserTrigger,
  listUserTriggers,
  patchUserTrigger,
  reorderUserTriggers,
  upsertUserTrigger,
  upsertUserTriggersBulk,
} from "./db/user-trigger-repository.js";
import { closeMongoClient } from "./db/mongo-client.js";
import {
  getHeatmapState,
  getReplaySlotWindowCounts,
  listActiveReplaySlotWindows,
  loadAllHeatmapWindows,
  replayUsableWindowKey,
  setHeatmapUpdateListener,
} from "./heatmap-service.js";
import type {
  EnrichedLiveWindowState,
  SimSetup,
  TradingPhaseSetup,
  WalletRegistryEntry,
} from "./types.js";
import {
  dropTradingClient,
  getTradingAccountStatus,
  isTradingConfigured,
  onBalanceRefresh,
  reconnectTradingClient,
  refreshCollateralBalance,
} from "./trading-client.js";
import { liveTradingRegistry } from "./live-trading-service.js";
import { isTradingExecutor } from "./trading-executor.js";
import { canProcessRecord } from "./recording-enabled.js";
import { recordingManager } from "./recording-manager.js";
import { startArchiveScheduler, stopArchiveScheduler } from "./archive-service.js";
import {
  backtestSchedulePlacements,
  buildPlacementPlayPayload,
  parseSyntheticHourPlacement,
  type PlacementBacktestStats,
} from "./schedule-backtest-service.js";
import { buildLiveHourPlayPayload } from "./schedule-live-play.js";
import { purgeFlatPriceRecordings } from "./bad-recording-cleanup.js";
import { ensureWalletRegistryReady, listWalletsForSeries, countWalletsForSeries } from "./wallet-registry.js";
import { computeWalletWinLossForUser } from "./db/wallet-win-loss.js";
import { resolvePolymarketPnls } from "./wallet-pnl.js";
import { traderRegistryService } from "./trader-registry-service.js";
import {
  authenticateUser,
  deleteUserById,
  ensureDefaultUser,
  ensureUserIndexes,
  getBootstrapUserId,
  getUserPublicById,
  maybeBootstrapAdminFromEnv,
  maybeBootstrapDefaultPassword,
  registerUser,
  updateUserProfile,
  updateUserWallet,
  type UserPublic,
} from "./db/user-repository.js";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  createSession,
  destroySession,
  destroySessionsForUser,
  ensureSessionIndexes,
  getSessionTokenFromRequest,
  isSecureRequest,
  resolveSessionUserId,
} from "./auth/session.js";
import { ObjectId } from "mongodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3848;
/** Sparse Mongo → RAM heatmap refresh (sim upserts windows elsewhere). */
const HEATMAP_REFRESH_MS = 10 * 60 * 1000;
const publicDir = path.join(__dirname, "../public");

const app = express();
app.use(express.json());

function sendIndexHtml(_req: express.Request, res: express.Response): void {
  res.sendFile(path.join(publicDir, "index.html"));
}

// Exact SPA pages (before static so /docs is the app, not the docs/ folder).
app.get(["/docs", "/version"], sendIndexHtml);

app.use(
  express.static(publicDir, {
    setHeaders(res, filePath) {
      if (/\.(?:js|css|html)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

type AuthedRequest = express.Request & { authUser?: UserPublic };

function requireUserId(req: express.Request): string {
  const user = (req as AuthedRequest).authUser;
  if (!user?.id) throw new Error("Unauthorized");
  return user.id;
}

function tradingFor(req: express.Request) {
  return liveTradingRegistry.get(requireUserId(req));
}

type SseClient = { id: number; res: express.Response; userId?: string };
let sseClients: SseClient[] = [];
let sseId = 0;

async function loadAuthUser(req: express.Request): Promise<UserPublic | null> {
  const token = getSessionTokenFromRequest(req.headers.cookie);
  const userId = await resolveSessionUserId(token);
  if (!userId) return null;
  return getUserPublicById(userId);
}

function isPublicAuthPath(req: express.Request): boolean {
  if (req.method === "POST" && req.path === "/api/auth/login") return true;
  if (req.method === "POST" && req.path === "/api/auth/register") return true;
  if (req.method === "GET" && req.path === "/api/auth/me") return true;
  // Live→recorder worker; gated by SCHEDULE_REPLAY_WORKER_SECRET when set.
  if (req.method === "POST" && req.path === "/api/internal/schedule-replay") return true;
  if (req.method === "POST" && /^\/api\/internal\/schedule-placements\/[^/]+\/play$/.test(req.path)) {
    return true;
  }
  if (req.method === "GET" && req.path === "/api/internal/ticks") return true;
  if (req.method === "POST" && req.path === "/api/internal/ticks/presence") return true;
  return false;
}

async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  if (!req.path.startsWith("/api/")) {
    next();
    return;
  }
  if (isPublicAuthPath(req)) {
    next();
    return;
  }
  try {
    const user = await loadAuthUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    (req as AuthedRequest).authUser = user;
    next();
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

app.use(requireAuth);

app.post("/api/auth/login", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { email?: string; password?: string };
    const user = await authenticateUser(body.email ?? "", body.password ?? "");
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const { token, expiresAt } = await createSession(new ObjectId(user.id));
    res.setHeader("Set-Cookie", buildSessionCookie(token, expiresAt, isSecureRequest(req)));
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      email?: string;
      password?: string;
      name?: string;
    };
    const user = await registerUser({
      email: body.email ?? "",
      password: body.password ?? "",
      name: body.name,
    });
    const { token, expiresAt } = await createSession(new ObjectId(user.id));
    res.setHeader("Set-Cookie", buildSessionCookie(token, expiresAt, isSecureRequest(req)));
    res.status(201).json({ user });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/auth/me", async (req, res) => {
  try {
    const user = await loadAuthUser(req);
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = getSessionTokenFromRequest(req.headers.cookie);
    await destroySession(token);
    res.setHeader("Set-Cookie", buildClearSessionCookie(isSecureRequest(req)));
    // Live trading continues from server-side config — do not stop it on logout.
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/auth/account", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const oid = new ObjectId(userId);

    await destroySessionsForUser(oid);

    // Cascade user-owned trading data before dropping the user doc.
    await Promise.all([
      deleteAllTradingSetupsForUser(userId, "live"),
      deleteAllTradingSetupsForUser(userId, "replay"),
      deleteAllSchedulePlacementsForUser(userId, "live"),
      deleteAllSchedulePlacementsForUser(userId, "replay"),
      deleteAllTradingSessionDataForUser(userId),
      deleteAllPositionCardsForUser(userId),
      deleteAllUserTriggers(userId),
      deleteAllTriggerLiveStatsForUser(userId),
      deleteAllTriggerDemoStatsCreditsForUser(userId),
    ]);

    const deleted = await deleteUserById(oid);
    if (!deleted) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    dropTradingClient(userId);
    liveTradingRegistry.drop(userId);

    // Keep a bootstrap default user if the DB is empty after delete.
    try {
      await ensureDefaultUser();
    } catch {
      // ignore
    }

    res.setHeader("Set-Cookie", buildClearSessionCookie(isSecureRequest(req)));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function broadcast(event: string, data: unknown, userId?: string): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    if (userId != null && client.userId !== userId) continue;
    client.res.write(payload);
  }
}

function broadcastLog(entry: ReturnType<typeof logService.getRecent>[number]): void {
  broadcast("log", entry);
}

function windowDurationSec(state: { windowStart?: number; windowEnd?: number }): number {
  if (state.windowStart && state.windowEnd) return state.windowEnd - state.windowStart;
  return 300;
}

/** Full window snapshots (history + trading) — paced so book ticks don't re-stringify huge payloads. */
const FULL_WINDOW_SSE_MS = 200;
let fullWindowTimer: ReturnType<typeof setTimeout> | null = null;
let fullWindowDirty = false;
let lastQuotesPayload = "";

function enrichWindowStateForUser(
  userId: string | undefined,
  state: ReturnType<typeof displayService.getState>,
): EnrichedLiveWindowState {
  const trading = userId
    ? liveTradingRegistry.get(userId).getPublicState()
    : undefined;
  return {
    ...state,
    sim: simulatorService.getPublicState(),
    trading: trading ?? null,
  };
}

function quotesPayloadFromState(state: ReturnType<typeof displayService.getState>) {
  return {
    series: state.series,
    windowStart: state.windowStart,
    windowEnd: state.windowEnd,
    assetPrice: state.assetPrice,
    assetGap: state.assetGap,
    prevCloseAsset: state.prevCloseAsset,
    priceToBeatSource: state.priceToBeatSource,
    yesBid: state.yesBid,
    yesAsk: state.yesAsk,
    noBid: state.noBid,
    noAsk: state.noAsk,
    yesBidSize: state.yesBidSize,
    yesAskSize: state.yesAskSize,
    noBidSize: state.noBidSize,
    noAskSize: state.noAskSize,
    yesBids: state.yesBids ?? [],
    yesAsks: state.yesAsks ?? [],
    noBids: state.noBids ?? [],
    noAsks: state.noAsks ?? [],
    yesDisplay: state.yesDisplay,
    noDisplay: state.noDisplay,
    feedLatencyMs: state.feedLatencyMs,
    lastTickMs: state.lastTickMs,
  };
}

/** Tick-live quotes for clickable up/down buttons — small payload, every price change. */
function pushQuotesLive(): void {
  const state = displayService.getState();
  const quotes = quotesPayloadFromState(state);
  const payload = JSON.stringify(quotes);
  if (payload === lastQuotesPayload) return;
  lastQuotesPayload = payload;
  const message = `event: quotes\ndata: ${payload}\n\n`;
  for (const client of sseClients) {
    client.res.write(message);
  }
}

function pushWindowState(): void {
  const state = displayService.getState();
  for (const client of sseClients) {
    const payload = `event: window\ndata: ${JSON.stringify(enrichWindowStateForUser(client.userId, state))}\n\n`;
    client.res.write(payload);
  }
}

/** Immediate full snapshot (config/trading changes, HTTP handlers). */
function pushWindowStateImmediate(): void {
  fullWindowDirty = false;
  if (fullWindowTimer) {
    clearTimeout(fullWindowTimer);
    fullWindowTimer = null;
  }
  pushWindowState();
}

/** Coalesce chart/history/trading blob after display ticks. */
function scheduleFullWindowPush(): void {
  fullWindowDirty = true;
  if (fullWindowTimer) return;
  fullWindowTimer = setTimeout(() => {
    fullWindowTimer = null;
    if (!fullWindowDirty) return;
    fullWindowDirty = false;
    pushWindowState();
  }, FULL_WINDOW_SSE_MS);
}

async function broadcastSchedulePlacements(
  userId: string,
  series?: string | null,
  mode: ScheduleWorkspaceMode = "live",
): Promise<void> {
  const placements = await listSchedulePlacements(userId, series ?? undefined, mode);
  broadcast("schedule-placements", { mode, placements }, userId);
}

function getDisplaySeries(req: express.Request): string {
  const series = String(req.query.series ?? displayService.getState().series);
  return series;
}

function parseSeriesParam(req: express.Request, bodySeries?: unknown): string {
  const fromQuery = typeof req.query.series === "string" ? req.query.series.trim() : "";
  const fromBody = typeof bodySeries === "string" ? bodySeries.trim() : "";
  return fromQuery || fromBody || displayService.getState().series || "btc-5m";
}

async function assertSeriesAvailable(series: string): Promise<void> {
  await requireAvailableMarket(series);
}

function marketUnavailableStatus(message: string): number {
  return message.startsWith("Market unavailable:") ? 403 : 404;
}

function parseWorkspaceMode(req: express.Request): ScheduleWorkspaceMode {
  const fromQuery = req.query.mode;
  const fromBody = req.body?.mode;
  return parseScheduleWorkspaceMode(fromQuery ?? fromBody);
}

function parsePlacementIdsQuery(req: express.Request): string[] | undefined {
  const raw = req.query.placementIds;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

function filterSchedulePlacements(
  all: SchedulePlacementListItem[],
  placementIds: string[] | undefined,
): SchedulePlacementListItem[] {
  if (!placementIds?.length) return all;
  const idSet = new Set(placementIds);
  return all.filter((p) => idSet.has(p._id));
}

/**
 * Live role: point at the recorder instance's `/api/internal/schedule-replay`.
 * Empty → run backtest in-process (typical for a local recorder).
 */
const SCHEDULE_REPLAY_SERVICE_URL = String(process.env.SCHEDULE_REPLAY_SERVICE_URL ?? "").trim();
/** Optional shared secret for `/api/internal/schedule-replay` and outbound proxy. */
const SCHEDULE_REPLAY_WORKER_SECRET = String(process.env.SCHEDULE_REPLAY_WORKER_SECRET ?? "").trim();

function sseJsonStringify(data: unknown): string {
  return JSON.stringify(data, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) return 0;
    return value;
  });
}

function writeSseEvent(
  res: express.Response,
  closed: { value: boolean },
  event: string,
  data: unknown,
  options: { force?: boolean } = {},
): void {
  if (closed.value && !options.force) return;
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`event: ${event}\ndata: ${sseJsonStringify(data)}\n\n`);
  } catch {
    closed.value = true;
    return;
  }
  const flush = (res as express.Response & { flush?: () => void }).flush;
  if (typeof flush === "function") flush.call(res);
  // Encourage Node to push SSE chunks promptly (no compression middleware flush).
  const socket = res.socket;
  if (socket && typeof socket.uncork === "function" && socket.writable) {
    socket.uncork();
  }
}

function assertReplayWorkerAuth(req: express.Request): boolean {
  if (!SCHEDULE_REPLAY_WORKER_SECRET) return true;
  const header = String(req.headers["x-replay-worker-secret"] ?? "");
  return header === SCHEDULE_REPLAY_WORKER_SECRET;
}

function setupsByIdFromBody(setups: unknown): Map<string, TradingPhaseSetup | null> {
  const map = new Map<string, TradingPhaseSetup | null>();
  if (!Array.isArray(setups)) return map;
  for (const item of setups) {
    const id = String((item as { _id?: unknown })?._id ?? "").trim();
    if (!id) continue;
    const rawSetup = (item as { setup?: TradingPhaseSetup })?.setup;
    if (!rawSetup) continue;
    const normalized = normalizePhaseSetup(rawSetup);
    // Only pin body setups that normalize cleanly — otherwise fall back to Mongo.
    if (normalized) map.set(id, normalized);
  }
  return map;
}

async function runScheduleReplaySse(
  res: express.Response,
  closed: { value: boolean },
  input: {
    userId: string;
    series: string;
    placements: SchedulePlacementListItem[];
    setups: unknown;
    latencyMs?: number;
    fillSuccessPct?: number;
    prediction?: {
      sensitivitySec?: number;
      maxQuoteCents?: number;
      minQuoteCents?: number;
      shiftCents?: number;
      riseCents?: number;
      areaStart?: number;
      areaEnd?: number;
      shares?: number;
      buyOrderType?: "FAK" | "FOK";
      sellOrderType?: "FAK" | "FOK";
    } | null;
    triggers?: unknown[] | null;
  },
): Promise<void> {
  let market;
  try {
    market = await requireAvailableMarket(input.series);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeSseEvent(res, closed, "failure", { error: message });
    res.end();
    return;
  }

  const latencyMs =
    typeof input.latencyMs === "number" && Number.isFinite(input.latencyMs)
      ? Math.max(0, Math.min(10000, Math.floor(input.latencyMs)))
      : simulatorService.getSetup().latencyMs;
  const fillSuccessPct =
    typeof input.fillSuccessPct === "number" && Number.isFinite(input.fillSuccessPct)
      ? Math.max(0, Math.min(100, input.fillSuccessPct))
      : 100;
  const triggers = Array.isArray(input.triggers) ? input.triggers : [];
  // Triggers replace Prediction. null = Prediction Off; object = On; undefined = default.
  const prediction =
    triggers.length > 0 ? null : input.prediction === null ? null : input.prediction;

  writeSseEvent(res, closed, "progress", {
    completed: 0,
    total: Math.max(1, input.placements.length),
    indeterminate: true,
  });

  logService.info(
    "replay",
    `Schedule replay started for ${input.series} (${input.placements.length} placement(s), latency ${latencyMs} ms, fill success ${fillSuccessPct}%, triggers ${triggers.length}, prediction ${prediction === null ? "off" : "on"}) — loads ticks + applies setups`,
  );

  let lastProgress = { completed: 0, total: Math.max(1, input.placements.length) };
  let lastProgressWriteMs = 0;
  const stats = await backtestSchedulePlacements(
    input.userId,
    market,
    input.placements,
    latencyMs,
    {
      setupsById: setupsByIdFromBody(input.setups),
      fillSuccessPct,
      prediction,
      triggers,
      // Always re-sim on interactive Replay so stats match current setups + recordings.
      forceResimulate: true,
      shouldAbort: () => closed.value,
      onProgress: (progress) => {
        lastProgress = {
          completed: progress.completed,
          total: Math.max(1, progress.total),
        };
        // Throttle progress SSE — per-window events can flood the browser.
        const now = Date.now();
        if (
          progress.indeterminate ||
          progress.completed >= progress.total ||
          now - lastProgressWriteMs >= 250
        ) {
          lastProgressWriteMs = now;
          writeSseEvent(res, closed, "progress", progress);
        }
      },
      onPlacementComplete: (placementStats: PlacementBacktestStats) => {
        writeSseEvent(res, closed, "placement", {
          ...placementStats,
          progress: lastProgress,
        });
      },
    },
  );

  const withData = stats.filter((s) => s.hasData).length;
  if (!closed.value) {
    logService.info(
      "replay",
      `Schedule replay finished for ${input.series} (${withData}/${stats.length} cards with data)`,
    );
  } else {
    logService.info(
      "replay",
      `Schedule replay aborted for ${input.series} after ${withData}/${stats.length} card(s) with data`,
    );
  }
  // Keep done small — per-card stats already streamed via "placement" events.
  // A huge final JSON payload was brittle over long Dropbox/local runs.
  writeSseEvent(
    res,
    closed,
    "done",
    { ok: true, count: stats.length, withData },
    { force: true },
  );
  if (!res.writableEnded) res.end();
}

app.get("/api/account", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const authUser = (req as AuthedRequest).authUser!;
    const status = await refreshCollateralBalance(userId);
    const user = (await getUserPublicById(userId)) ?? authUser;
    res.json({
      ...status,
      hasPrivateKey: user.wallet.hasPrivateKey || Boolean(status.hasPrivateKey),
      funderAddress: status.funderAddress ?? user.wallet.funderAddress,
      signerAddress: status.signerAddress ?? user.wallet.signerAddress,
      privateKeyHint: user.wallet.privateKeyHint,
    });
  } catch {
    try {
      const userId = requireUserId(req);
      const authUser = (req as AuthedRequest).authUser!;
      const user = (await getUserPublicById(userId)) ?? authUser;
      const status = getTradingAccountStatus(userId);
      res.json({
        ...status,
        hasPrivateKey: user.wallet.hasPrivateKey,
        funderAddress: status.funderAddress ?? user.wallet.funderAddress,
        signerAddress: status.signerAddress ?? user.wallet.signerAddress,
        privateKeyHint: user.wallet.privateKeyHint,
      });
    } catch {
      try {
        res.json(getTradingAccountStatus(requireUserId(req)));
      } catch {
        res.json({ connected: false });
      }
    }
  }
});

app.get("/api/user", async (req, res) => {
  try {
    const authUser = (req as AuthedRequest).authUser;
    if (!authUser) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const user = await getUserPublicById(authUser.id);
    res.json(user ?? authUser);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch("/api/user", async (req, res) => {
  try {
    const authUser = (req as AuthedRequest).authUser;
    if (!authUser) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const body = (req.body ?? {}) as { name?: string; email?: string };
    if (!("name" in body) && !("email" in body)) {
      res.status(400).json({ error: "Provide name and/or email" });
      return;
    }
    const user = await updateUserProfile(authUser.id, {
      name: body.name,
      email: body.email,
    });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch("/api/account/wallet", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const body = (req.body ?? {}) as {
      funderAddress?: string;
      privateKey?: string;
      signatureType?: number;
    };
    if (
      body.funderAddress == null &&
      body.privateKey == null &&
      body.signatureType == null
    ) {
      res.status(400).json({ error: "Provide funderAddress and/or privateKey" });
      return;
    }

    const user = await updateUserWallet(userId, {
      funderAddress: body.funderAddress,
      privateKey: body.privateKey,
      signatureType: body.signatureType,
    });

    let status = getTradingAccountStatus(userId);
    try {
      status = await reconnectTradingClient(userId);
      await liveTradingRegistry.ensureLoaded(userId);
    } catch (err) {
      status = getTradingAccountStatus(userId);
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
        wallet: user.wallet,
        account: {
          ...status,
          hasPrivateKey: user.wallet.hasPrivateKey,
          funderAddress: status.funderAddress ?? user.wallet.funderAddress,
          signerAddress: status.signerAddress ?? user.wallet.signerAddress,
          privateKeyHint: user.wallet.privateKeyHint,
        },
      });
      return;
    }

    broadcast(
      "account",
      {
        ...status,
        hasPrivateKey: user.wallet.hasPrivateKey,
        privateKeyHint: user.wallet.privateKeyHint,
      },
      userId,
    );

    res.json({
      ok: true,
      user,
      wallet: user.wallet,
      account: {
        ...status,
        hasPrivateKey: user.wallet.hasPrivateKey,
        funderAddress: status.funderAddress ?? user.wallet.funderAddress,
        signerAddress: status.signerAddress ?? user.wallet.signerAddress,
        privateKeyHint: user.wallet.privateKeyHint,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/trading/config", async (req, res) => {
  try {
    const series = parseSeriesParam(req);
    await assertSeriesAvailable(series);
    const engine = tradingFor(req);
    await engine.ensureBoundToSeries(series);
    res.json(engine.getConfig());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("Market unavailable:") || message.startsWith("Unknown series:")) {
      res.status(marketUnavailableStatus(message)).json({ error: message });
      return;
    }
    res.status(401).json({ error: message });
  }
});

app.put("/api/trading/config", async (req, res) => {
  try {
    const series = parseSeriesParam(req, req.body?.series);
    await assertSeriesAvailable(series);
    const engine = tradingFor(req);
    await engine.ensureBoundToSeries(series);
    const body = req.body as Partial<import("./types.js").TradingConfig>;
    const config = engine.setConfig(body);
    void engine.refreshScheduleContext(true);
    pushWindowStateImmediate();
    res.json(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("Market unavailable:") || message.startsWith("Unknown series:")) {
      res.status(marketUnavailableStatus(message)).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.post("/api/trading/order", async (req, res) => {
  try {
    const userId = requireUserId(req);
    if (!isTradingConfigured(userId)) {
      res.status(400).json({ error: "Trading account not configured" });
      return;
    }
    const side = req.body?.side;
    const leg = req.body?.leg;
    const source =
      req.body?.source === "prediction"
        ? "prediction"
        : req.body?.source === "trigger"
          ? "trigger"
          : "manual";
    if (source === "manual" || source === "prediction") {
      res.status(400).json({
        error: "Only Trigger Trade places orders (Trade + Active)",
      });
      return;
    }
    if (side !== "up" && side !== "down") {
      res.status(400).json({ error: "side must be up or down" });
      return;
    }
    if (leg !== "buy" && leg !== "sell") {
      res.status(400).json({ error: "leg must be buy or sell" });
      return;
    }
    const state = displayService.getState();
    await assertSeriesAvailable(state.series);
    const sharesRaw = Number(req.body?.shares);
    const takeProfitCentsRaw = Number(req.body?.takeProfitCents);
    const maxPriceRaw = Number(req.body?.maxPrice);
    const minPriceRaw = Number(req.body?.minPrice);
    const orderType =
      req.body?.orderType === "FAK" || req.body?.orderType === "FOK"
        ? req.body.orderType
        : undefined;
    const sellOrderType =
      req.body?.sellOrderType === "FAK" ||
      req.body?.sellOrderType === "FOK" ||
      req.body?.sellOrderType === "GTD"
        ? req.body.sellOrderType
        : undefined;
    const triggerIdRaw =
      typeof req.body?.triggerId === "string" ? req.body.triggerId.trim() : "";
    const triggerNameRaw =
      typeof req.body?.triggerName === "string" ? req.body.triggerName.trim().slice(0, 120) : "";
    const triggerExitReason =
      req.body?.triggerExitReason === "tp" || req.body?.triggerExitReason === "sl"
        ? req.body.triggerExitReason
        : undefined;
    const result = await tradingFor(req).manualOrder(state, side, leg, {
      source,
      ...(Number.isFinite(sharesRaw) && sharesRaw > 0
        ? { shares: Math.floor(sharesRaw) }
        : {}),
      ...(orderType ? { orderType } : {}),
      ...(sellOrderType ? { sellOrderType } : {}),
      ...(Number.isFinite(takeProfitCentsRaw)
        ? { takeProfitCents: Math.round(takeProfitCentsRaw) }
        : {}),
      ...(source === "trigger" && triggerIdRaw ? { triggerId: triggerIdRaw } : {}),
      ...(source === "trigger" && triggerNameRaw ? { triggerName: triggerNameRaw } : {}),
      ...(source === "trigger" && triggerExitReason ? { triggerExitReason } : {}),
      ...(Number.isFinite(maxPriceRaw) && maxPriceRaw > 0 && maxPriceRaw < 1
        ? { maxPrice: maxPriceRaw }
        : {}),
      ...(Number.isFinite(minPriceRaw) && minPriceRaw > 0 && minPriceRaw < 1
        ? { minPrice: minPriceRaw }
        : {}),
    });
    pushWindowStateImmediate();
    if (!result.ok) {
      res.status(400).json({ error: result.error ?? "Order failed" });
      return;
    }
    res.json({
      ok: true,
      ...(result.fillShares != null && Number.isFinite(result.fillShares)
        ? { fillShares: result.fillShares }
        : {}),
      ...(result.fillPrice != null && Number.isFinite(result.fillPrice)
        ? { fillPrice: result.fillPrice }
        : {}),
      ...(result.remainingShares != null && Number.isFinite(result.remainingShares)
        ? { remainingShares: result.remainingShares }
        : {}),
      ...(result.triggerMiss === true ? { triggerMiss: true } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("Market unavailable:") || message.startsWith("Unknown series:")) {
      res.status(marketUnavailableStatus(message)).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

/** Reconcile Trigger Trade GTD resting buys (Duration 0 + Price). */
app.post("/api/trading/trigger-gtd-sync", async (req, res) => {
  try {
    const userId = requireUserId(req);
    if (!isTradingConfigured(userId)) {
      res.status(400).json({ error: "Trading account not configured" });
      return;
    }
    const state = displayService.getState();
    await assertSeriesAvailable(state.series);
    const rawDesires = Array.isArray(req.body?.desires) ? req.body.desires : [];
    const desires = rawDesires
      .map((d: Record<string, unknown>) => {
        const triggerId = d?.triggerId != null ? String(d.triggerId).trim() : "";
        if (!triggerId) return null;
        const sides = Array.isArray(d?.sides)
          ? (d.sides as unknown[]).filter((s) => s === "up" || s === "down")
          : [];
        const priceCents = Math.round(Number(d?.priceCents) * 10) / 10;
        const shares = Math.floor(Number(d?.shares));
        if (!Number.isFinite(priceCents) || !Number.isFinite(shares)) return null;
        const sellOrderType =
          d?.sellOrderType === "FAK" || d?.sellOrderType === "FOK" || d?.sellOrderType === "GTD"
            ? d.sellOrderType
            : undefined;
        const takeProfitCents = Math.round(Number(d?.takeProfitCents));
        const triggerName =
          typeof d?.triggerName === "string" && d.triggerName.trim()
            ? String(d.triggerName).trim().slice(0, 120)
            : undefined;
        return {
          triggerId,
          sides: sides as Array<"up" | "down">,
          priceCents,
          shares,
          ...(sellOrderType ? { sellOrderType } : {}),
          ...(Number.isFinite(takeProfitCents) ? { takeProfitCents } : {}),
          ...(triggerName ? { triggerName } : {}),
        };
      })
      .filter(Boolean);
    const result = await tradingFor(req).syncTriggerGtdBuys(state, desires as never);
    pushWindowStateImmediate();
    res.json({ ok: true, fills: result.fills ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("Market unavailable:") || message.startsWith("Unknown series:")) {
      res.status(marketUnavailableStatus(message)).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.post("/api/trading/positions/clear", async (req, res) => {
  try {
    const mode = String(req.body?.mode || "").trim().toLowerCase();
    if (mode === "settled") {
      const filterRaw = String(req.body?.filter || "all").trim().toLowerCase();
      const filter =
        filterRaw === "demo" || filterRaw === "trade" ? filterRaw : "all";
      const removed = await tradingFor(req).clearSettledPositionCards(filter);
      pushWindowStateImmediate();
      res.json({ ok: true, mode: "settled", filter, removed });
      return;
    }
    // Reset Live header counters only — Market / Week keep full history in Mongo.
    // Schedule placement card stats keep collecting until cards are removed.
    tradingFor(req).clearPositionCards();
    pushWindowStateImmediate();
    res.json({ ok: true, archived: false });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Reload schedule-card / Live stats from Mongo into RAM (e.g. after restore script). */
app.post("/api/trading/stats/rehydrate", async (req, res) => {
  try {
    await tradingFor(req).hydrateLiveStatsFromMongo();
    pushWindowStateImmediate();
    const live = tradingFor(req).getLiveSessionTotals();
    res.json({
      ok: true,
      green: live.green,
      red: live.red,
      blue: live.blue,
      pnl: live.pnl,
      placementStats: live.placementStats,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/trading/session-memory", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = String(req.query.mode ?? "live").toLowerCase();
    const live = tradingFor(req).getLiveSessionTotals();
    const liveTotals = {
      green: live.green,
      red: live.red,
      blue: live.blue,
      pnl: live.pnl,
      hasData: live.hasBalance,
      sessionCount: live.hasBalance ? 1 : 0,
    };

    if (mode === "live") {
      res.json({ mode, ...liveTotals, live: liveTotals });
      return;
    }

    if (mode === "market") {
      const { DEFAULT_MARKET_SERIES } = await import("./collections.js");
      const series = String(req.query.series ?? DEFAULT_MARKET_SERIES).trim() || DEFAULT_MARKET_SERIES;
      const archived = await sumTradingStatEventsForSeries(userId, series);
      res.json({
        mode: "market",
        series,
        green: archived.green,
        red: archived.red,
        blue: archived.blue,
        pnl: archived.pnl,
        sessionCount: archived.sessionCount,
        hasData: archived.hasData,
        archived,
        live: liveTotals,
      });
      return;
    }

    let fromMs: number | undefined;
    let toMs: number | undefined;
    const now = Date.now();

    if (mode === "week") {
      fromMs = now - 7 * 24 * 60 * 60 * 1000;
      toMs = now;
    } else if (mode === "all" || mode === "alltime" || mode === "all-time") {
      fromMs = undefined;
      toMs = undefined;
    } else {
      res.status(400).json({ error: "mode must be live, market, week, or all" });
      return;
    }

    // Events are written on each settled-stat update — do not add live again (would double-count).
    const archived = await sumTradingSessionMemory(userId, { fromMs, toMs });

    res.json({
      mode: mode === "alltime" || mode === "all-time" ? "all" : mode,
      green: archived.green,
      red: archived.red,
      blue: archived.blue,
      pnl: archived.pnl,
      sessionCount: archived.sessionCount,
      hasData: archived.hasData,
      archived,
      live: liveTotals,
      includeLive: false,
    });
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.get("/api/markets", async (_req, res) => {
  try {
    const markets = await listAvailableMarkets();
    res.json(markets);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Ops market settings are owned by Admin CRM (shared Mongo); traders cannot patch. */
app.patch("/api/markets/:series", async (_req, res) => {
  res.status(403).json({
    error: "Market ops settings are managed in Admin CRM",
  });
});

app.get("/api/quotes", async (req, res) => {
  try {
    const series = getDisplaySeries(req);
    displayService.setSeries(series);
    const state = displayService.getState();
    res.json({
      series,
      yesBid: state.yesBid,
      yesAsk: state.yesAsk,
      noBid: state.noBid,
      noAsk: state.noAsk,
      yesDisplay: state.yesDisplay,
      noDisplay: state.noDisplay,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/book", async (req, res) => {
  try {
    const series = getDisplaySeries(req);
    displayService.setSeries(series);
    const state = displayService.getState();

    const pair = await import("./market-pair.js").then((m) =>
      m.fetchCurrentUpDownMarket(series),
    );
    clobMarketFeed.ensureSubscribed([pair.yesTokenId, pair.noTokenId]);

    const yesBook = clobMarketFeed.getCachedBookDepth(pair.yesTokenId);
    const noBook = clobMarketFeed.getCachedBookDepth(pair.noTokenId);

    res.json({
      series,
      windowStart: state.windowStart,
      windowEnd: state.windowEnd,
      up: yesBook ?? { bids: [], asks: [] },
      down: noBook ?? { bids: [], asks: [] },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/window", async (req, res) => {
  try {
    const series = getDisplaySeries(req);
    displayService.setSeries(series);
    const userId = (req as AuthedRequest).authUser?.id;
    if (userId) {
      // Await hydrate + series bind so Positions gets a ready card list (no demo→live jump).
      await liveTradingRegistry.ensureLoaded(userId);
      await tradingFor(req).ensureBoundToSeries(series);
    }
    res.json(enrichWindowStateForUser(userId, displayService.getState()));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Official window outcome: explicit Gamma payout (~1/~0) — Polymarket settlement source. */
app.get("/api/window-resolution", async (req, res) => {
  try {
    const slug = String(req.query.slug || "").trim();
    if (!slug) {
      res.status(400).json({ error: "slug required" });
      return;
    }
    const { fetchOfficialWindowResolution } = await import("./official-window-resolution.js");
    const resolution = await fetchOfficialWindowResolution(slug);
    if (!resolution?.outcome) {
      res.json({ resolved: false });
      return;
    }
    res.json({
      resolved: true,
      outcome: resolution.outcome,
      source: resolution.source,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message });
  }
});

app.get("/api/sim/setup", (_req, res) => {
  res.json(simulatorService.getSetup());
});

app.put("/api/sim/setup", (req, res) => {
  try {
    const body = req.body as SimSetup;
    if (!body?.phaseSplit || !body?.phases || body.phases.length !== 3) {
      res.status(400).json({ error: "phaseSplit and 3 phases required" });
      return;
    }
    const setup = simulatorService.setSetup(body, windowDurationSec(displayService.getState()));
    logService.info("sim", `Setup updated (latency ${setup.latencyMs} ms)`);
    pushWindowStateImmediate();
    res.json(setup);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/trading-setups", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const title = String(req.body?.title ?? "").trim();
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const descriptionRaw = req.body?.description;
    const description =
      descriptionRaw == null || String(descriptionRaw).trim() === ""
        ? undefined
        : String(descriptionRaw).trim();

    let phaseSetup = simulatorService.getPhaseSetup();
    if (req.body?.setup != null) {
      const parsed = normalizePhaseSetup(req.body.setup);
      if (!parsed) {
        res.status(400).json({ error: "Invalid setup phases" });
        return;
      }
      phaseSetup = parsed;
    }

    const saved = await insertTradingSetup(
      userId,
      {
        title,
        description,
        setup: phaseSetup,
      },
      mode,
    );
    logService.success("sim", `Trading setup saved (${mode}): "${title}"`);
    res.status(201).json(saved);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.get("/api/trading-setups", async (req, res) => {
  try {
    const setups = await listTradingSetups(requireUserId(req), parseWorkspaceMode(req));
    res.json(setups);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.put("/api/trading-setups/reorder", async (req, res) => {
  try {
    const mode = parseWorkspaceMode(req);
    const orderedIds = Array.isArray(req.body?.orderedIds)
      ? req.body.orderedIds.map((id: unknown) => String(id))
      : null;
    if (!orderedIds) {
      res.status(400).json({ error: "orderedIds is required" });
      return;
    }
    const setups = await reorderTradingSetups(requireUserId(req), orderedIds, mode);
    res.json(setups);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    if (
      message.includes("required") ||
      message.includes("unique") ||
      message.includes("every setup") ||
      message.includes("Unknown setup") ||
      message.includes("Invalid setup")
    ) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.get("/api/trading-setups/:id", async (req, res) => {
  try {
    const setup = await getTradingSetupById(
      requireUserId(req),
      req.params.id,
      parseWorkspaceMode(req),
    );
    if (!setup) {
      res.status(404).json({ error: "Setup not found" });
      return;
    }
    res.json(setup);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.patch("/api/trading-setups/:id", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const descriptionRaw = req.body?.description;
    const updated = await updateTradingSetup(
      userId,
      req.params.id,
      {
        title: req.body?.title != null ? String(req.body.title) : undefined,
        description:
          descriptionRaw === undefined
            ? undefined
            : descriptionRaw == null || String(descriptionRaw).trim() === ""
              ? null
              : String(descriptionRaw).trim(),
        color: req.body?.color != null ? String(req.body.color) : undefined,
        setup: req.body?.setup,
      },
      mode,
    );
    if (!updated) {
      res.status(404).json({ error: "Setup not found" });
      return;
    }
    if (req.body?.title != null) {
      await updatePlacementTitlesBySetupId(userId, req.params.id, updated.title, mode);
      await broadcastSchedulePlacements(userId, undefined, mode);
    }
    if (req.body?.setup != null && mode === "live") {
      await tradingFor(req).refreshScheduleContext(true);
      pushWindowStateImmediate();
    }
    logService.success("sim", `Trading setup updated (${mode}): "${updated.title}"`);
    res.json(updated);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    if (message.includes("required") || message.includes("Invalid")) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

/** Market Trigger card definitions (Mongo, per user × series). Replay Triggers stay browser-local. */
app.get("/api/triggers", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const series = String(req.query.series || "").trim().toLowerCase();
    const triggers = await listUserTriggers(userId, series || undefined);
    res.json({ triggers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/triggers", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const saved = await upsertUserTrigger(userId, req.body);
    if (!saved) {
      res.status(400).json({ error: "invalid trigger" });
      return;
    }
    res.json(saved);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/triggers/migrate", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const series = String(req.body?.series || "").trim().toLowerCase();
    const items = Array.isArray(req.body?.triggers) ? req.body.triggers : [];
    const stamped = series
      ? items.map((item: unknown) =>
          item && typeof item === "object" ? { ...(item as object), series } : item,
        )
      : items;
    const saved = await upsertUserTriggersBulk(userId, stamped);
    const triggers = await listUserTriggers(userId, series || undefined);
    res.json({ migrated: saved.length, triggers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/** Persist Market Triggers display order (per user × series). Must be before /api/triggers/:id. */
app.put("/api/triggers/reorder", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const series = String(req.body?.series || "").trim().toLowerCase();
    const triggers = await reorderUserTriggers(userId, req.body?.ids, series || undefined);
    res.json({ triggers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.put("/api/triggers/:id", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const triggerId = String(req.params.id || "").trim();
    if (!triggerId) {
      res.status(400).json({ error: "trigger id required" });
      return;
    }
    // Replace existing only — never upsert-resurrect a deleted card (POST creates).
    const existing = await getUserTrigger(userId, triggerId);
    if (!existing) {
      res.status(404).json({ error: "trigger not found" });
      return;
    }
    const saved = await upsertUserTrigger(userId, { ...req.body, id: triggerId });
    if (!saved) {
      res.status(400).json({ error: "invalid trigger" });
      return;
    }
    res.json(saved);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.patch("/api/triggers/:id", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const triggerId = String(req.params.id || "").trim();
    if (!triggerId) {
      res.status(400).json({ error: "trigger id required" });
      return;
    }
    const patch =
      req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const saved = await patchUserTrigger(userId, triggerId, patch);
    if (!saved) {
      res.status(404).json({ error: "trigger not found" });
      return;
    }
    res.json(saved);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.delete("/api/triggers/:id", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const triggerId = String(req.params.id || "").trim();
    if (!triggerId) {
      res.status(400).json({ error: "trigger id required" });
      return;
    }
    const ok = await deleteUserTrigger(userId, triggerId);
    if (ok) {
      await deleteTriggerLiveStats(userId, triggerId).catch(() => undefined);
      await deleteTriggerDemoStatsCredits(userId, triggerId).catch(() => undefined);
      // Demo Positions are owned by the trigger; Trade Positions / stats ledger stay.
      await tradingFor(req)
        .dropDemoPositionCardsForTrigger(triggerId)
        .catch(() => undefined);
    }
    res.json({ ok });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.get("/api/triggers/:id/stats", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const triggerId = String(req.params.id || "").trim();
    if (!triggerId) {
      res.status(400).json({ error: "trigger id required" });
      return;
    }
    const stats = await getTriggerLiveStats(userId, triggerId);
    const timeline = await listTriggerModeEvents(userId, [triggerId]);
    const activeMs = sumTriggerActiveMs(timeline, Date.now(), "trade");
    const demoActiveMs = sumTriggerActiveMs(timeline, Date.now(), "demo");
    res.json({ ...stats, activeMs, demoActiveMs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/triggers/:id/stats/event", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const triggerId = String(req.params.id || "").trim();
    if (!triggerId) {
      res.status(400).json({ error: "trigger id required" });
      return;
    }
    const result =
      req.body?.result === "fail"
        ? "fail"
        : req.body?.result === "success"
          ? "success"
          : req.body?.result === "blue"
            ? "blue"
            : null;
    if (!result) {
      res.status(400).json({ error: "result must be success, fail, or blue" });
      return;
    }
    const pnlUsd = Number(req.body?.pnlUsd);
    const exitReasonRaw = String(req.body?.exitReason || "").trim();
    const exitReason =
      exitReasonRaw === "tp" || exitReasonRaw === "sl" || exitReasonRaw === "window-end"
        ? exitReasonRaw
        : undefined;
    const stats = await recordTriggerLiveStatsEvent(
      userId,
      triggerId,
      result,
      Number.isFinite(pnlUsd) ? pnlUsd : 0,
      exitReason,
    );
    res.json(stats);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.delete("/api/triggers/:id/stats", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const triggerId = String(req.params.id || "").trim();
    if (!triggerId) {
      res.status(400).json({ error: "trigger id required" });
      return;
    }
    await deleteTriggerLiveStats(userId, triggerId);
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.delete("/api/trading-setups/:id", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const existing = await getTradingSetupById(userId, req.params.id, mode);
    if (!existing) {
      res.status(404).json({ error: "Setup not found" });
      return;
    }
    const setupId = String(req.params.id);
    const linked = (await listSchedulePlacements(userId, undefined, mode)).filter(
      (p) => p.setupId === setupId,
    );
    await deletePlacementsBySetupId(userId, setupId, mode);
    if (mode === "live") {
      for (const placement of linked) {
        tradingFor(req).forgetPlacement(placement._id);
      }
    }
    const ok = await deleteTradingSetup(userId, setupId, mode);
    if (!ok) {
      res.status(404).json({ error: "Setup not found" });
      return;
    }
    await broadcastSchedulePlacements(userId, undefined, mode);
    if (mode === "live") pushWindowStateImmediate();
    logService.success("sim", `Trading setup deleted (${mode}): "${existing.title}"`);
    res.status(204).send();
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.get("/api/heatmap", (req, res) => {
  try {
    const series = parseSeriesParam(req);
    res.json(getHeatmapState(series));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Replay Schedule: usable recorded window counts per UTC weekday×hour (latest day per slot). */
app.get("/api/schedule-replay-slot-counts", async (req, res) => {
  try {
    const series = parseSeriesParam(req);
    const active = listActiveReplaySlotWindows(series);
    const bySeries = new Map<string, number[]>();
    for (const w of active) {
      const list = bySeries.get(w.series) ?? [];
      list.push(w.windowStart);
      bySeries.set(w.series, list);
    }
    const usable = new Set<string>();
    const workerBase = replayWorkerBaseUrl();
    for (const [ser, starts] of bySeries) {
      const uniqueStarts = [...new Set(starts)];
      let present: number[] | null = null;
      if (workerBase) {
        present = await fetchRemoteTickPresence(workerBase, ser, uniqueStarts, {
          requireBook: true,
        });
      }
      if (present == null) {
        const market = await getMarket(ser);
        present = market
          ? await windowsHavingReplayTickFiles(market, uniqueStarts)
          : [];
      }
      for (const ws of present) usable.add(replayUsableWindowKey(ser, ws));
    }
    res.json(getReplaySlotWindowCounts(series, usable));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/trader-wallets", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const series = parseSeriesParam(req);
    const sortRaw = typeof req.query.sort === "string" ? req.query.sort.trim() : "sightings";
    const sort =
      sortRaw === "iWin" ||
      sortRaw === "iLost" ||
      sortRaw === "pnl" ||
      sortRaw === "sightings"
        ? sortRaw
        : "sightings";
    const dir = req.query.dir === "asc" ? "asc" : "desc";
    const limitRaw = Number(req.query.limit);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 100;

    const [winLoss, total] = await Promise.all([
      computeWalletWinLossForUser(userId, series),
      countWalletsForSeries(series),
    ]);

    const attachUserStats = <T extends { address: string }>(wallet: T) => {
      const stats = winLoss.get(String(wallet.address).toLowerCase()) ?? {
        iWin: 0,
        iLost: 0,
      };
      return {
        ...wallet,
        iWin: stats.iWin,
        iLost: stats.iLost,
      };
    };

    type TraderWalletApiRow = WalletRegistryEntry & {
      iWin: number;
      iLost: number;
      pnl: number;
    };
    let rows: TraderWalletApiRow[];
    if (sort === "sightings") {
      const wallets = await listWalletsForSeries(series, {
        sortBy: "sightings",
        dir,
        limit,
      });
      const withUser = wallets.map(attachUserStats);
      const pnlMap = await resolvePolymarketPnls(withUser.map((w) => w.address));
      rows = withUser.map((wallet) => ({
        ...wallet,
        pnl: Math.round((pnlMap.get(String(wallet.address).toLowerCase()) ?? 0) * 100) / 100,
      }));
    } else if (sort === "pnl") {
      // Rank among the most-seen wallets in this series (refresh PnL, then top/bottom 100).
      const candidates = await listWalletsForSeries(series, {
        sortBy: "sightings",
        dir: "desc",
        limit: Math.max(limit, 300),
      });
      const withUser = candidates.map(attachUserStats);
      const pnlMap = await resolvePolymarketPnls(withUser.map((w) => w.address));
      rows = withUser.map((wallet) => ({
        ...wallet,
        pnl: Math.round((pnlMap.get(String(wallet.address).toLowerCase()) ?? 0) * 100) / 100,
      }));
      const dirMul = dir === "asc" ? 1 : -1;
      rows.sort((a, b) => {
        if (a.pnl !== b.pnl) return a.pnl < b.pnl ? -dirMul : dirMul;
        const as = Number(a.markets?.[series]) || 0;
        const bs = Number(b.markets?.[series]) || 0;
        if (as !== bs) return bs - as;
        return String(a.address).localeCompare(String(b.address));
      });
      rows = rows.slice(0, limit);
    } else {
      const wallets = await listWalletsForSeries(series);
      const withUser = wallets.map(attachUserStats);
      const metric = sort === "iWin" ? "iWin" : "iLost";
      const dirMul = dir === "asc" ? 1 : -1;
      withUser.sort((a, b) => {
        const av = Number(a[metric]) || 0;
        const bv = Number(b[metric]) || 0;
        if (av !== bv) return av < bv ? -dirMul : dirMul;
        const as = Number(a.markets?.[series]) || 0;
        const bs = Number(b.markets?.[series]) || 0;
        if (as !== bs) return bs - as;
        return String(a.address).localeCompare(String(b.address));
      });
      const page = withUser.slice(0, limit);
      const pnlMap = await resolvePolymarketPnls(page.map((w) => w.address));
      rows = page.map((wallet) => ({
        ...wallet,
        pnl: Math.round((pnlMap.get(String(wallet.address).toLowerCase()) ?? 0) * 100) / 100,
      }));
    }

    res.json({
      series,
      sort,
      dir,
      limit,
      total,
      wallets: rows,
      count: rows.length,
    });
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.get("/api/schedule-placements", async (req, res) => {
  try {
    const series = parseSeriesParam(req);
    const mode = parseWorkspaceMode(req);
    const placements = await listSchedulePlacements(requireUserId(req), series, mode);
    res.json(placements);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.post("/api/schedule-placements", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const series = parseSeriesParam(req, req.body?.series);
    await assertSeriesAvailable(series);
    const saved = await insertSchedulePlacement(
      userId,
      {
        series,
        setupId: String(req.body?.setupId ?? ""),
        title: String(req.body?.title ?? ""),
        day: String(req.body?.day ?? ""),
        startHour: Number(req.body?.startHour),
        durationHours: Number(req.body?.durationHours),
      },
      mode,
    );
    if (mode === "live") {
      await syncLiveScheduleInUseForSetup(userId, saved.setupId);
    }
    await broadcastSchedulePlacements(userId, series, mode);
    res.status(201).json(saved);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    if (message.includes("overlap") || message.includes("Invalid") || message.includes("exceeds")) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.delete("/api/schedule-placements/day/:day", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const series = parseSeriesParam(req);
    const before = await listSchedulePlacements(userId, series, mode);
    const removed = before.filter((placement) => placement.day === req.params.day);
    await deletePlacementsByDay(userId, req.params.day, series, mode);
    if (mode === "live") {
      for (const placement of removed) tradingFor(req).forgetPlacement(placement._id);
      await reconcileLiveScheduleInUseFlags(userId);
      await tradingFor(req).refreshScheduleContext(true);
      pushWindowStateImmediate();
    }
    const placements = await listSchedulePlacements(userId, series, mode);
    await broadcastSchedulePlacements(userId, series, mode);
    res.json(placements);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

app.post("/api/schedule-placements/replace-day", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const series = parseSeriesParam(req, req.body?.series);
    await assertSeriesAvailable(series);
    const setupId = String(req.body?.setupId ?? "");
    const setup = await getTradingSetupById(userId, setupId, mode);
    if (!setup) {
      res.status(404).json({ error: "Trading setup not found" });
      return;
    }
    const before = await listSchedulePlacements(userId, series, mode);
    const day = String(req.body?.day ?? "");
    const removed = before.filter((placement) => placement.day === day);
    const placements = await replaceDayWithSetup(
      userId,
      day,
      setupId,
      setup.title,
      series,
      mode,
    );
    if (mode === "live") {
      for (const placement of removed) tradingFor(req).forgetPlacement(placement._id);
      await reconcileLiveScheduleInUseFlags(userId);
      await tradingFor(req).refreshScheduleContext(true);
      pushWindowStateImmediate();
    }
    await broadcastSchedulePlacements(userId, series, mode);
    res.json(placements);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

app.post("/api/schedule-placements/replace-week", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const series = parseSeriesParam(req, req.body?.series);
    await assertSeriesAvailable(series);
    const setupId = String(req.body?.setupId ?? "");
    const setup = await getTradingSetupById(userId, setupId, mode);
    if (!setup) {
      res.status(404).json({ error: "Trading setup not found" });
      return;
    }
    const before = await listSchedulePlacements(userId, series, mode);
    const placements = await replaceWeekWithSetup(
      userId,
      setupId,
      setup.title,
      series,
      mode,
    );
    if (mode === "live") {
      for (const placement of before) tradingFor(req).forgetPlacement(placement._id);
      await reconcileLiveScheduleInUseFlags(userId);
      await tradingFor(req).refreshScheduleContext(true);
      pushWindowStateImmediate();
    }
    await broadcastSchedulePlacements(userId, series, mode);
    res.json(placements);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

app.post("/api/schedule-placements/apply-setup", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const series = parseSeriesParam(req, req.body?.series);
    const setupId = String(req.body?.setupId ?? "");
    const title = String(req.body?.title ?? "");
    const setup = await getTradingSetupById(userId, setupId, mode);
    if (!setup) {
      res.status(404).json({ error: "Trading setup not found" });
      return;
    }
    const placements = await replaceAllPlacementsSetup(
      userId,
      setupId,
      title || setup.title,
      series,
      mode,
    );
    if (mode === "live") {
      await reconcileLiveScheduleInUseFlags(userId);
    }
    await broadcastSchedulePlacements(userId, series, mode);
    res.json(placements);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    if (message.includes("Invalid")) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.patch("/api/schedule-placements/:id", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const placementId = String(req.params.id);
    if (mode === "live" && tradingFor(req).isPlacementLocked(placementId)) {
      res.status(409).json({ error: "Placement is locked after its first window started" });
      return;
    }
    const updated = await updateSchedulePlacement(
      userId,
      placementId,
      {
        day: req.body?.day != null ? String(req.body.day) : undefined,
        startHour: req.body?.startHour != null ? Number(req.body.startHour) : undefined,
        durationHours: req.body?.durationHours != null ? Number(req.body.durationHours) : undefined,
      },
      mode,
    );
    if (!updated) {
      res.status(404).json({ error: "Placement not found" });
      return;
    }
    await broadcastSchedulePlacements(userId, updated.series, mode);
    res.json(updated);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    if (message.includes("overlap") || message.includes("Invalid") || message.includes("exceeds")) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.delete("/api/schedule-placements/:id", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const id = String(req.params.id);
    const existing = await getSchedulePlacementById(userId, id, mode);
    const ok = await deleteSchedulePlacement(userId, id, mode);
    if (!ok) {
      res.status(404).json({ error: "Placement not found" });
      return;
    }
    if (mode === "live") {
      if (existing?.setupId) {
        await syncLiveScheduleInUseForSetup(userId, existing.setupId);
      }
      tradingFor(req).forgetPlacement(id);
      pushWindowStateImmediate();
    }
    await broadcastSchedulePlacements(userId, existing?.series, mode);
    res.status(204).send();
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

function replayWorkerBaseUrl(): string | null {
  if (!SCHEDULE_REPLAY_SERVICE_URL) return null;
  try {
    return new URL(SCHEDULE_REPLAY_SERVICE_URL).origin;
  } catch {
    return null;
  }
}

/** Ask the recorder which window starts still have tick files. */
async function fetchRemoteTickPresence(
  workerBase: string,
  series: string,
  windowStarts: number[],
  options?: { requireBook?: boolean },
): Promise<number[] | null> {
  if (windowStarts.length === 0) return [];
  const remoteHeaders: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (SCHEDULE_REPLAY_WORKER_SECRET) {
    remoteHeaders["x-replay-worker-secret"] = SCHEDULE_REPLAY_WORKER_SECRET;
  }
  try {
    const remoteRes = await fetch(`${workerBase}/api/internal/ticks/presence`, {
      method: "POST",
      headers: remoteHeaders,
      body: JSON.stringify({
        series,
        windowStarts,
        requireBook: options?.requireBook === true,
      }),
    });
    const body = (await remoteRes.json().catch(() => ({}))) as {
      present?: unknown;
      error?: string;
    };
    if (!remoteRes.ok) {
      logService.warn(
        "replay",
        `Recorder tick presence failed (${remoteRes.status}): ${body.error ?? remoteRes.statusText}`,
      );
      return null;
    }
    const present = Array.isArray(body.present)
      ? body.present.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : [];
    return present;
  } catch (err) {
    logService.warn("replay", `Recorder tick presence error: ${String(err)}`);
    return null;
  }
}

/** @deprecated Prefer fetchRemoteTickPresence — Chainlink-only presence for Live Open Replay. */
async function fetchRemoteChainlinkPresence(
  workerBase: string,
  series: string,
  windowStarts: number[],
): Promise<number[] | null> {
  return fetchRemoteTickPresence(workerBase, series, windowStarts);
}

async function runPlacementPlay(
  userId: string,
  placementId: string,
  input: {
    series?: string;
    latencyMs?: number;
    fillSuccessPct?: number;
    phaseSetup?: unknown;
    triggers?: unknown[] | null;
    live?: boolean;
    /** Idle Replay board: clean recordings, no buy/sell markers. */
    recordingsOnly?: boolean;
    prediction?: {
      sensitivitySec?: number;
      maxQuoteCents?: number;
      minQuoteCents?: number;
      shiftCents?: number;
      riseCents?: number;
      areaStart?: number;
      areaEnd?: number;
      shares?: number;
      buyOrderType?: "FAK" | "FOK";
      sellOrderType?: "FAK" | "FOK";
    } | null;
  },
) {
  const seriesHint =
    typeof input.series === "string" && input.series.trim() ? input.series.trim() : "";

  // Live Schedule hour review: real ledger markers + Mongo windows (not proxied / re-sim).
  // Tick-file presence is probed on the recorder when SCHEDULE_REPLAY_SERVICE_URL is set.
  if (input.live === true) {
    const synthetic = parseSyntheticHourPlacement(placementId, seriesHint);
    if (!synthetic) {
      return { status: 400 as const, body: { error: "Live Open Replay requires an hour slot id" } };
    }
    const series = String(synthetic.series || seriesHint).trim();
    const market = await getMarket(series);
    if (!market) {
      return { status: 404 as const, body: { error: "Market not found" } };
    }
    const workerBase = replayWorkerBaseUrl();
    const engine = await liveTradingRegistry.ensureLoaded(userId);
    const payload = await buildLiveHourPlayPayload(userId, market, placementId, {
      cards: engine.getPublicState().positionCards,
      events: engine.getLiveStatEvents(),
      resolveWindowsWithTicks: workerBase
        ? async (windowStarts) => {
            const remote = await fetchRemoteChainlinkPresence(workerBase, series, windowStarts);
            if (remote != null) return remote;
            // Fallback if recorder unreachable (local/dev dual-role).
            return windowsHavingChainlinkTicks(market, windowStarts);
          }
        : undefined,
    });
    if (!payload) {
      return { status: 404 as const, body: { error: "Hour slot not found" } };
    }
    return { status: 200 as const, body: payload };
  }

  let placement = await getSchedulePlacementById(userId, placementId, "replay");
  if (!placement) {
    placement = parseSyntheticHourPlacement(placementId, seriesHint);
  }
  if (!placement) {
    return { status: 404 as const, body: { error: "Placement not found" } };
  }
  // Prefer the placement's own series so Open matches the card, not a stale selector.
  const series = String(placement.series ?? "").trim() || seriesHint;
  const market = await getMarket(series);
  if (!market) {
    return { status: 404 as const, body: { error: "Market not found" } };
  }
  const latencyMs =
    typeof input.latencyMs === "number" && Number.isFinite(input.latencyMs)
      ? Math.max(0, Math.min(10000, Math.floor(input.latencyMs)))
      : simulatorService.getSetup().latencyMs;
  const fillSuccessPct =
    typeof input.fillSuccessPct === "number" && Number.isFinite(input.fillSuccessPct)
      ? Math.max(0, Math.min(100, input.fillSuccessPct))
      : 100;
  const phaseSetup = normalizePhaseSetup(input.phaseSetup as never) ?? undefined;
  const hasTriggers = Array.isArray(input.triggers) && input.triggers.length > 0;
  const recordingsOnly = input.recordingsOnly === true;
  const payload = await buildPlacementPlayPayload(userId, market, placement, {
    latencyMs,
    fillSuccessPct,
    phaseSetup: phaseSetup ?? null,
    prediction: hasTriggers || recordingsOnly ? null : input.prediction === null ? null : input.prediction,
    triggers: recordingsOnly ? [] : input.triggers,
    recordingsOnly,
    forceResimulate: recordingsOnly ? true : undefined,
  });
  return { status: 200 as const, body: payload };
}

function parsePlayRequestBody(req: express.Request): {
  series?: string;
  latencyMs?: number;
  fillSuccessPct?: number;
  phaseSetup?: unknown;
  triggers?: unknown[] | null;
  live?: boolean;
  recordingsOnly?: boolean;
  prediction?: {
    sensitivitySec?: number;
    maxQuoteCents?: number;
    minQuoteCents?: number;
    shiftCents?: number;
    riseCents?: number;
    areaStart?: number;
    areaEnd?: number;
    shares?: number;
    buyOrderType?: "FAK" | "FOK";
    sellOrderType?: "FAK" | "FOK";
  } | null;
} {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const q = req.query;
  const series =
    typeof body.series === "string"
      ? body.series
      : typeof q.series === "string"
        ? q.series
        : undefined;
  const latencyRaw = Number(body.latencyMs ?? q.latencyMs);
  const fillRaw = Number(body.fillSuccessPct ?? q.fillSuccessPct);
  const rawSetup = body.setup ?? body.phaseSetup;
  const phaseSetup =
    rawSetup && typeof rawSetup === "object"
      ? rawSetup.setup && typeof rawSetup.setup === "object"
        ? rawSetup.setup
        : rawSetup
      : undefined;
  const prediction = Object.prototype.hasOwnProperty.call(body, "prediction")
    ? body.prediction === null
      ? null
      : body.prediction && typeof body.prediction === "object"
        ? body.prediction
        : undefined
    : undefined;
  const triggers = Array.isArray(body.triggers) ? body.triggers : undefined;
  const live = body.live === true || body.mode === "live" || q.live === "1";
  const recordingsOnly =
    body.recordingsOnly === true || body.mode === "recordings" || q.recordingsOnly === "1";
  return {
    series,
    latencyMs: Number.isFinite(latencyRaw) ? latencyRaw : undefined,
    fillSuccessPct: Number.isFinite(fillRaw) ? fillRaw : undefined,
    phaseSetup,
    triggers,
    live,
    recordingsOnly,
    prediction,
  };
}

/** Open Replay popup payload: per-window sim markers for a Replay schedule card. */
app.post("/api/schedule-placements/:id/play", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const id = String(req.params.id);
    const parsed = parsePlayRequestBody(req);

    // Live hour review must run where the user's trade ledger lives (not the recorder).
    const workerBase = replayWorkerBaseUrl();
    if (workerBase && !parsed.live) {
      const remoteHeaders: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
      };
      if (SCHEDULE_REPLAY_WORKER_SECRET) {
        remoteHeaders["x-replay-worker-secret"] = SCHEDULE_REPLAY_WORKER_SECRET;
      }
      const remoteRes = await fetch(
        `${workerBase}/api/internal/schedule-placements/${encodeURIComponent(id)}/play`,
        {
          method: "POST",
          headers: remoteHeaders,
          body: JSON.stringify({
            userId,
            series: parsed.series,
            latencyMs: parsed.latencyMs,
            fillSuccessPct: parsed.fillSuccessPct,
            setup: parsed.phaseSetup,
            prediction: parsed.prediction,
            triggers: parsed.recordingsOnly ? [] : parsed.triggers,
            recordingsOnly: parsed.recordingsOnly === true,
          }),
        },
      );
      const body = await remoteRes.json().catch(() => ({}));
      res.status(remoteRes.status).json(body);
      return;
    }

    const result = await runPlacementPlay(userId, id, parsed);
    res.status(result.status).json(result.body);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

/** Recorder worker: Open Replay payload (live proxy → ticks on DATA_DIR). */
app.post("/api/internal/schedule-placements/:id/play", async (req, res) => {
  if (!assertReplayWorkerAuth(req)) {
    res.status(401).json({ error: "Unauthorized replay worker request" });
    return;
  }
  try {
    const userId = String(req.body?.userId ?? req.query.userId ?? "").trim();
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    const id = String(req.params.id);
    const parsed = parsePlayRequestBody(req);
    const result = await runPlacementPlay(userId, id, parsed);
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/**
 * Replay the current Replay-mode schedule over historical windows.
 * Streams per-placement stats (event: placement) then event: done.
 *
 * If SCHEDULE_REPLAY_SERVICE_URL is set (live role), proxies to that worker.
 * Otherwise runs the backtest in-process against local DATA_DIR (recorder role).
 */
app.post("/api/schedule-replay", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const closed = { value: false };
  let responseFinished = false;
  // Abort when the TCP socket drops (Stop / navigate). Do NOT use req "close" —
  // for POST that fires when the body is consumed and would abort immediately.
  // Prefer the socket over res "close", which can race with normal completion.
  const abortSocket = req.socket;
  const onSocketClose = () => {
    if (!responseFinished && !res.writableEnded) closed.value = true;
  };
  abortSocket?.once("close", onSocketClose);

  try {
    const userId = requireUserId(req);
    const series = parseSeriesParam(req, req.body?.series);
    const placements = Array.isArray(req.body?.placements)
      ? req.body.placements
      : await listSchedulePlacements(userId, series, "replay");
    const setupIds: string[] = [
      ...new Set(
        (placements as Array<{ setupId?: string }>)
          .map((p) => String(p?.setupId ?? "").trim())
          .filter(Boolean),
      ),
    ];
    const setups =
      Array.isArray(req.body?.setups) && req.body.setups.length > 0
        ? req.body.setups
        : (
            await Promise.all(setupIds.map((id: string) => getTradingSetupById(userId, id, "replay")))
          ).filter(Boolean);

    if (!SCHEDULE_REPLAY_SERVICE_URL) {
      await runScheduleReplaySse(res, closed, {
        userId,
        series,
        placements,
        setups,
        latencyMs: req.body?.latencyMs,
        fillSuccessPct: req.body?.fillSuccessPct,
        prediction: req.body?.prediction,
        triggers: req.body?.triggers,
      });
      responseFinished = true;
      abortSocket?.off("close", onSocketClose);
      return;
    }

    writeSseEvent(res, closed, "progress", {
      completed: 0,
      total: Math.max(1, placements.length),
      indeterminate: true,
    });

    const remoteHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (SCHEDULE_REPLAY_WORKER_SECRET) {
      remoteHeaders["x-replay-worker-secret"] = SCHEDULE_REPLAY_WORKER_SECRET;
    }

    const remoteRes = await fetch(SCHEDULE_REPLAY_SERVICE_URL, {
      method: "POST",
      headers: remoteHeaders,
      body: JSON.stringify({
        userId,
        series,
        placements,
        setups,
        latencyMs: req.body?.latencyMs ?? simulatorService.getSetup().latencyMs,
        fillSuccessPct: req.body?.fillSuccessPct ?? 100,
        prediction: req.body?.prediction,
        triggers: req.body?.triggers,
      }),
    });
    if (!remoteRes.ok || !remoteRes.body) {
      const remoteText = await remoteRes.text().catch(() => "");
      writeSseEvent(res, closed, "failure", {
        error: remoteText || `Replay service returned ${remoteRes.status}`,
      });
      res.end();
      return;
    }

    const reader = remoteRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!closed.value) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("\n\n")) {
        res.write(buffer);
        buffer = "";
        const flush = (res as express.Response & { flush?: () => void }).flush;
        if (typeof flush === "function") flush.call(res);
      }
    }
    if (buffer && !closed.value) res.write(buffer);
    if (!closed.value) res.end();
  } catch (err) {
    writeSseEvent(res, closed, "failure", { error: String(err) });
    res.end();
  }
});

/**
 * Recorder-role worker endpoint. Live instances proxy here via SCHEDULE_REPLAY_SERVICE_URL.
 * Auth: optional x-replay-worker-secret when SCHEDULE_REPLAY_WORKER_SECRET is set.
 */
app.post("/api/internal/schedule-replay", async (req, res) => {
  if (!assertReplayWorkerAuth(req)) {
    res.status(401).json({ error: "Unauthorized replay worker request" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const closed = { value: false };
  let responseFinished = false;
  const abortSocket = req.socket;
  const onSocketClose = () => {
    if (!responseFinished && !res.writableEnded) closed.value = true;
  };
  abortSocket?.once("close", onSocketClose);

  try {
    const userId = String(req.body?.userId ?? "").trim();
    if (!userId) {
      writeSseEvent(res, closed, "failure", { error: "userId is required" });
      res.end();
      return;
    }
    const series = parseSeriesParam(req, req.body?.series);
    const placements = Array.isArray(req.body?.placements) ? req.body.placements : [];
    await runScheduleReplaySse(res, closed, {
      userId,
      series,
      placements,
      setups: req.body?.setups,
      latencyMs: req.body?.latencyMs,
      fillSuccessPct: req.body?.fillSuccessPct,
      prediction: req.body?.prediction,
      triggers: req.body?.triggers,
    });
    responseFinished = true;
  } catch (err) {
    writeSseEvent(res, closed, "failure", { error: String(err) });
    res.end();
  } finally {
    abortSocket?.off("close", onSocketClose);
  }
});

app.get("/api/schedule-placement-stats", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    if (mode === "replay") {
      res.json([]);
      return;
    }
    const series = parseSeriesParam(req);
    const engine = await liveTradingRegistry.ensureLoaded(userId);
    await engine.ensureBoundToSeries(series);
    const allPlacements = await listSchedulePlacements(userId, series, "live");
    const placementIds = parsePlacementIdsQuery(req);
    const placements = filterSchedulePlacements(allPlacements, placementIds);
    const stats = engine.getPlacementStats(placements.map((p) => p._id));
    res.json(stats);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

/** Trigger Trade UTC weekday×hour slot stats (latest calendar day per slot; Live engine). */
app.get("/api/schedule-hour-stats", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const engine = await liveTradingRegistry.ensureLoaded(userId);
    const slots = await engine.getHourSlotStats();
    res.json({ slots });
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.get("/api/schedule-placement-stats/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  const writeEvent = (event: string, data: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const flush = (res as express.Response & { flush?: () => void }).flush;
    if (typeof flush === "function") flush.call(res);
  };

  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    if (mode === "replay") {
      writeEvent("progress", { completed: 1, total: 1 });
      writeEvent("done", []);
      res.end();
      return;
    }
    const series = parseSeriesParam(req);
    writeEvent("progress", { completed: 1, total: 1 });
    const engine = await liveTradingRegistry.ensureLoaded(userId);
    await engine.ensureBoundToSeries(series);
    const allPlacements = await listSchedulePlacements(userId, series, "live");
    const placementIds = parsePlacementIdsQuery(req);
    const placements = filterSchedulePlacements(allPlacements, placementIds);
    const stats = engine.getPlacementStats(placements.map((p) => p._id));
    if (!closed) {
      writeEvent("done", stats);
      res.end();
    }
  } catch (err) {
    writeEvent("failure", { error: String(err) });
    res.end();
  }
});

app.get("/api/ticks", async (req, res) => {
  try {
    const workerBase = replayWorkerBaseUrl();
    if (workerBase) {
      const qs = new URLSearchParams();
      const series = String(req.query.series ?? "").trim();
      const windowStart = String(req.query.windowStart ?? "").trim();
      const stream = String(req.query.stream ?? "").trim();
      const limit = String(req.query.limit ?? "").trim();
      if (series) qs.set("series", series);
      if (windowStart) qs.set("windowStart", windowStart);
      if (stream) qs.set("stream", stream);
      if (limit) qs.set("limit", limit);
      const remoteHeaders: Record<string, string> = { Accept: "application/json" };
      if (SCHEDULE_REPLAY_WORKER_SECRET) {
        remoteHeaders["x-replay-worker-secret"] = SCHEDULE_REPLAY_WORKER_SECRET;
      }
      const remoteRes = await fetch(`${workerBase}/api/internal/ticks?${qs.toString()}`, {
        method: "GET",
        headers: remoteHeaders,
      });
      const body = await remoteRes.json().catch(() => ({}));
      res.status(remoteRes.status).json(body);
      return;
    }

    const result = await loadTicksPayload(req);
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Recorder worker: Open Replay / graph ticks from local DATA_DIR. */
app.get("/api/internal/ticks", async (req, res) => {
  if (!assertReplayWorkerAuth(req)) {
    res.status(401).json({ error: "Unauthorized replay worker request" });
    return;
  }
  try {
    const result = await loadTicksPayload(req);
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/**
 * Recorder worker: which window starts still have tick files.
 * Default = Chainlink only (Live Open Replay). `requireBook: true` = CLOB book + Chainlink
 * (Replay Schedule idle counts / Replay Open Replay usability).
 */
app.post("/api/internal/ticks/presence", async (req, res) => {
  if (!assertReplayWorkerAuth(req)) {
    res.status(401).json({ error: "Unauthorized replay worker request" });
    return;
  }
  try {
    const series = String(req.body?.series ?? req.query.series ?? "").trim();
    if (!series) {
      res.status(400).json({ error: "series is required" });
      return;
    }
    const market = await getMarket(series);
    if (!market) {
      res.status(404).json({ error: "Market not found" });
      return;
    }
    const raw = req.body?.windowStarts ?? req.body?.windows;
    const windowStarts = Array.isArray(raw)
      ? raw.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n))
      : [];
    const requireBook = req.body?.requireBook === true;
    const present = requireBook
      ? await windowsHavingReplayTickFiles(market, windowStarts)
      : await windowsHavingChainlinkTicks(market, windowStarts);
    res.status(200).json({ series, present, requireBook });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

async function loadTicksPayload(req: express.Request): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const series = getDisplaySeries(req);
  const windowStart = Number(req.query.windowStart);
  if (!Number.isFinite(windowStart)) {
    return { status: 400, body: { error: "windowStart query param required" } };
  }
  const market = await getMarket(series);
  if (!market) {
    return { status: 404, body: { error: "Market not found" } };
  }
  const limit = Math.min(Number(req.query.limit) || 5000, 50_000);
  const stream = String(req.query.stream || "merged");
  let ticks: unknown[];
  if (stream === "raw") {
    ticks = await listClobRawTicks(market, windowStart, limit);
  } else if (stream === "book") {
    ticks = await listClobBookTicks(market, windowStart, limit);
  } else if (stream === "chainlink") {
    ticks = await listChainlinkTicks(market, windowStart, limit);
  } else {
    ticks = await listReplayTicks(market, windowStart, limit);
  }
  return {
    status: 200,
    body: { series, windowStart, stream, count: ticks.length, ticks },
  };
}

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const userId = (req as AuthedRequest).authUser?.id;
  const client: SseClient = { id: ++sseId, res, userId };
  sseClients.push(client);

  void (async () => {
    try {
      const markets = await listAvailableMarkets();
      res.write(`event: markets\ndata: ${JSON.stringify(markets)}\n\n`);
      res.write(
        `event: window\ndata: ${JSON.stringify(enrichWindowStateForUser(userId, displayService.getState()))}\n\n`,
      );
      res.write(`event: log-history\ndata: ${JSON.stringify(logService.getRecent())}\n\n`);
      const series = displayService.getState().series || "btc-5m";
      res.write(`event: heatmap\ndata: ${JSON.stringify(getHeatmapState(series))}\n\n`);
      if (userId) {
        const placements = await listSchedulePlacements(userId, series, "live");
        res.write(`event: schedule-placements\ndata: ${JSON.stringify({ mode: "live", placements })}\n\n`);
      }
    } catch {
      // ignore
    }
  })();

  req.on("close", () => {
    sseClients = sseClients.filter((c) => c.id !== client.id);
  });
});

async function main(): Promise<void> {
  await initStorageAndSeed();
  await ensureAllMarketIndexes();
  try {
    await ensureUserIndexes();
    await ensureSessionIndexes();
    await ensureTriggerModeTimelineIndexes();
    await ensureDefaultUser();
    await ensureWalletRegistryReady();
    await maybeBootstrapDefaultPassword();
    await maybeBootstrapAdminFromEnv();
    const bootstrapId = await getBootstrapUserId();
    await ensureTradingSetupsUserId(bootstrapId);
    await ensureSchedulePlacementsUserId(bootstrapId);
    await ensureTradingSessionMemoryUserId(bootstrapId);
    await reconcileLiveScheduleInUseFlags(bootstrapId);
  } catch (err) {
    logService.warn("server", `Failed to ensure default user / auth indexes: ${String(err)}`);
  }

  liveTradingRegistry.startPolling(60_000);
  liveTradingRegistry.onUpdate(() => {
    // Positions/markers changed — send full snapshot now (not only throttled).
    pushWindowStateImmediate();
  });
  traderRegistryService.start();

  if (isTradingExecutor()) {
    logService.info("server", "TRADING_EXECUTOR enabled — this process may place orders");
  } else {
    logService.info("server", "TRADING_EXECUTOR off — settings only, no order placement");
  }
  if (canProcessRecord()) {
    logService.info(
      "server",
      "Recording available — Admin CRM Recording flags start capture on this process",
    );
  } else {
    logService.info(
      "server",
      "TRADING_EXECUTOR on — Admin CRM Recording flags save to Mongo but this process will not record",
    );
  }
  if (SCHEDULE_REPLAY_SERVICE_URL) {
    logService.info(
      "server",
      `Schedule replay + /api/ticks proxy to ${SCHEDULE_REPLAY_SERVICE_URL}`,
    );
  } else {
    logService.info("server", "Schedule replay runs in-process (no SCHEDULE_REPLAY_SERVICE_URL)");
  }

  logService.onEntry((entry) => {
    broadcastLog(entry);
  });

  onBalanceRefresh((userId, status) => {
    broadcast("account", status, userId);
  });

  setHeatmapUpdateListener((state) => {
    broadcast("heatmap", state);
  });
  // Drop stuck/flat Chainlink windows before the heatmap/Replay indexes load.
  await purgeFlatPriceRecordings().catch((err) => {
    logService.warn("recorder", `Flat-price purge failed: ${String(err)}`);
  });
  await loadAllHeatmapWindows();
  const heatmapRefreshTimer = setInterval(() => {
    void loadAllHeatmapWindows().catch((err) => {
      logService.warn("heatmap", `Periodic recorded_windows refresh failed: ${String(err)}`);
    });
  }, HEATMAP_REFRESH_MS);
  heatmapRefreshTimer.unref?.();

  chainlinkPriceFeed.start();
  clobMarketFeed.start();
  displayService.start();

  let recordingSyncTimer: ReturnType<typeof setInterval> | null = null;
  if (canProcessRecord()) {
    await recordingManager.sync();
    startArchiveScheduler();
    // Pick up Recording toggles saved by another process (e.g. live UI → shared Mongo).
    recordingSyncTimer = setInterval(() => {
      void recordingManager.sync().catch((err) => {
        logService.warn("recorder", `Periodic sync failed: ${String(err)}`);
      });
    }, 30_000);
    recordingSyncTimer.unref?.();
  }

  // Send each Chainlink point as a tiny incremental event. Full window
  // snapshots remain the recovery path for initial load and reconnects.
  const chainlinkTickUnsub = chainlinkPriceFeed.onUpdate((asset, timestampMs) => {
    const live = chainlinkPriceFeed.getLivePrice(asset);
    if (!live || live.timestampMs !== timestampMs) return;
    broadcast("chainlink-tick", {
      asset,
      price: live.value,
      timestampMs,
    });
  });

  // Quotes: every tick (small). Full window (history + trading): coalesced ~200ms.
  displayService.onUpdate(() => {
    pushQuotesLive();
    scheduleFullWindowPush();
  });

  app.listen(PORT, () => {
    logService.info("server", `Listening on http://localhost:${PORT}`);
  });

  const shutdown = async () => {
    clearInterval(heatmapRefreshTimer);
    if (recordingSyncTimer) clearInterval(recordingSyncTimer);
    stopArchiveScheduler();
    recordingManager.stopAll();
    traderRegistryService.stop();
    liveTradingRegistry.stopPolling();
    displayService.stop();
    chainlinkTickUnsub();
    clobMarketFeed.stop();
    chainlinkPriceFeed.stop();
    await closeMongoClient().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
