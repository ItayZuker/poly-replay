/**
 * Server-side Market Trigger Demo: Active+Demo cards scored on the trading executor
 * with live feedLatencyMs (no browser required). Positions cards are written onto
 * LiveTradingService (demo: true); browser only reflects SSE state.
 */
import { listActiveDemoTriggersForSeries } from "./db/user-trigger-repository.js";
import { logService } from "./log-service.js";
import { liveTradingRegistry } from "./live-trading-service.js";
import { isTradingExecutor } from "./trading-executor.js";
import {
  normalizeReplayTriggerDef,
  TriggerReplayRaceSession,
  type ReplayTriggerDef,
} from "./trigger-replay-sim.js";
import type { LiveWindowState, ReplayTickDocument } from "./types.js";

type SessionEntry = {
  userId: string;
  series: string;
  windowStart: number;
  windowEnd: number;
  session: TriggerReplayRaceSession;
  defs: ReplayTriggerDef[];
  /** triggerId → open card id for this window */
  openCardByTrigger: Map<string, string>;
  /** Last known phase per trigger for edge detection */
  lastPhase: Map<string, string>;
  lastEntry: Map<string, { side: "up" | "down"; price: number; shares: number }>;
};

const sessions = new Map<string, SessionEntry>();

function sessionKey(userId: string, series: string, windowStart: number): string {
  return `${userId}|${series}|${windowStart}`;
}

function liveStateToTick(state: LiveWindowState, nowMs: number): ReplayTickDocument {
  const windowStart = Number(state.windowStart) || 0;
  const tSec = nowMs / 1000;
  return {
    tMs: nowMs,
    t: tSec,
    elapsedSec: Math.max(0, tSec - windowStart),
    source: "clob-book",
    yesBid: state.yesBid,
    yesAsk: state.yesAsk,
    noBid: state.noBid,
    noAsk: state.noAsk,
    yesBidSize: state.yesBidSize,
    yesAskSize: state.yesAskSize,
    noBidSize: state.noBidSize,
    noAskSize: state.noAskSize,
    yesBids: state.yesBids,
    yesAsks: state.yesAsks,
    noBids: state.noBids,
    noAsks: state.noAsks,
    assetPrice: state.assetPrice,
    prevCloseAsset: state.prevCloseAsset,
    assetGap: state.assetGap,
    ptbCrossings: state.ptbCrossings,
    minAssetPrice: state.minAssetPrice,
    maxAssetPrice: state.maxAssetPrice,
    assetRange: state.assetRange,
  };
}

function feedLatencyMs(state: LiveWindowState): number {
  const n = Number(state.feedLatencyMs);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(10_000, Math.floor(n));
}

async function ensureUserEngine(userId: string, series: string): Promise<void> {
  const engine = await liveTradingRegistry.ensureLoaded(userId);
  try {
    await engine.ensureBoundToSeries(series);
  } catch {
    /* ignore */
  }
}

function getEngine(userId: string) {
  return liveTradingRegistry.get(userId);
}

/** Inspect race session private rts via finalize-safe peek using markers/stats diffs. */
function peekRts(session: TriggerReplayRaceSession): Array<{
  def: ReplayTriggerDef;
  phase: string;
  side: "up" | "down" | null;
  entryPrice: number | null;
  entryShares: number;
}> {
  const any = session as unknown as {
    rts: Array<{
      def: ReplayTriggerDef;
      phase: string;
      side: "up" | "down" | null;
      entryPrice: number | null;
      entryShares: number;
    }>;
  };
  return Array.isArray(any.rts) ? any.rts : [];
}

async function tickSeries(state: LiveWindowState, nowMs: number): Promise<void> {
  const series = String(state.series || "")
    .trim()
    .toLowerCase();
  if (!series) return;
  const windowStart = Number(state.windowStart);
  const windowEnd = Number(state.windowEnd);
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) return;

  const active = await listActiveDemoTriggersForSeries(series);
  if (active.length === 0) return;

  const byUser = new Map<string, typeof active>();
  for (const t of active) {
    const list = byUser.get(t.userId) ?? [];
    list.push(t);
    byUser.set(t.userId, list);
  }

  const tick = liveStateToTick(state, nowMs);
  const latency = feedLatencyMs(state);
  const windowEnded = nowMs >= windowEnd * 1000;

  for (const [userId, triggers] of byUser) {
    await ensureUserEngine(userId, series);
    const engine = getEngine(userId);
    const key = sessionKey(userId, series, windowStart);
    let entry = sessions.get(key);
    const defs = triggers
      .map((t) => normalizeReplayTriggerDef(t))
      .filter((d): d is ReplayTriggerDef => Boolean(d));
    if (defs.length === 0) continue;

    if (!entry || entry.windowStart !== windowStart) {
      // Prior window: leave open Demo cards for Gamma held settle (do not invent Win/Loss).
      if (entry) {
        sessions.delete(sessionKey(userId, series, entry.windowStart));
      }
      entry = {
        userId,
        series,
        windowStart,
        windowEnd,
        session: new TriggerReplayRaceSession({
          triggers: defs,
          windowStart,
          windowEnd,
          latencyMs: latency,
          fillSuccessPct: 100,
          windowOutcome: null,
          // Demo: each Active card tests its own setup — no cross-trigger race.
          independentBuys: true,
        }),
        defs,
        openCardByTrigger: new Map(),
        lastPhase: new Map(),
        lastEntry: new Map(),
      };
      sessions.set(key, entry);
    } else {
      // Refresh latency on the live session (mutating private field).
      (entry.session as unknown as { latency: number }).latency = latency;
    }

    if (!windowEnded) {
      entry.session.onTickBeforePhase(tick, false);
    }

    const rts = peekRts(entry.session);
    for (const rt of rts) {
      const tid = rt.def.id;
      const prev = entry.lastPhase.get(tid) || "idle";
      const phase = rt.phase;

      if (phase === "open" && rt.side && rt.entryPrice != null) {
        const cardId = engine.upsertDemoTriggerOpen({
          triggerId: tid,
          triggerName: rt.def.name,
          side: rt.side,
          shares: rt.entryShares,
          buyPrice: rt.entryPrice,
          series,
          windowStart,
          slug: state.slug,
        });
        if (cardId) entry.openCardByTrigger.set(tid, cardId);
        entry.lastEntry.set(tid, {
          side: rt.side,
          price: rt.entryPrice,
          shares: rt.entryShares,
        });
      }

      // Transition open → idle without window-end: TP/SL sell inside the session.
      if (prev === "open" && phase === "idle" && !windowEnded) {
        const cardId = entry.openCardByTrigger.get(tid);
        const last = entry.lastEntry.get(tid);
        if (cardId && last) {
          // Prefer sell from last known bid on this tick.
          const bid =
            last.side === "up"
              ? Number(state.yesBid)
              : Number(state.noBid);
          const sellPrice = Number.isFinite(bid) ? bid : last.price;
          // Infer TP vs SL from P/L vs entry.
          const exitReason = sellPrice + 1e-9 >= last.price ? "tp" : "sl";
          engine.settleDemoTriggerSold({ cardId, sellPrice, exitReason });
          entry.openCardByTrigger.delete(tid);
        }
      }

      entry.lastPhase.set(tid, phase);
    }

    // Window ended while open: keep Open cards; server Gamma confirm loop settles them.
    if (windowEnded) {
      for (const rt of rts) {
        if (rt.phase !== "open" || !rt.side || rt.entryPrice == null) continue;
        engine.upsertDemoTriggerOpen({
          triggerId: rt.def.id,
          triggerName: rt.def.name,
          side: rt.side,
          shares: rt.entryShares,
          buyPrice: rt.entryPrice,
          series,
          windowStart,
          slug: state.slug,
        });
      }
      sessions.delete(key);
    }
  }
}

/** Called from live trading tick path on the executor host. */
export async function tickTriggerDemoEngine(
  state: LiveWindowState,
  nowMs = Date.now(),
): Promise<void> {
  if (!isTradingExecutor()) return;
  try {
    await tickSeries(state, nowMs);
  } catch (err) {
    logService.warn("trading", `Trigger Demo tick failed: ${String(err)}`);
  }
}

