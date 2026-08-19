/**
 * Executor-side Trigger Trade GTD: place/poll resting buys from Mongo
 * (no browser required). Survives dyno restart via persisted order ids.
 */
import {
  listActiveTradeGtdTriggersForSeries,
  pickHighestTradeGtdTriggerId,
} from "./db/user-trigger-repository.js";
import { liveTradingRegistry, type TriggerGtdDesire } from "./live-trading-service.js";
import { isTradingExecutor } from "./trading-executor.js";
import { normalizeReplayTriggerDef } from "./trigger-replay-sim.js";
import type { LiveWindowState } from "./types.js";

function isBuyGtdDef(def: {
  buyOrderType: string;
  durationMs: number;
  startMode: string;
}): boolean {
  return def.buyOrderType === "GTD" && def.durationMs === 0 && def.startMode === "price";
}

function inBuyGtdPlaceWindow(
  nowSec: number,
  windowStart: number,
  windowEnd: number,
  area: { start: number; end: number },
): boolean {
  const duration = Math.max(1, windowEnd - windowStart);
  const applyStart = windowStart + area.start * duration;
  const applyEnd = windowStart + area.end * duration;
  return nowSec + 1e-9 >= applyStart && nowSec <= applyEnd + 1e-9;
}

function desireForTrigger(
  trigger: { id: string; name?: string },
  def: ReturnType<typeof normalizeReplayTriggerDef>,
  stateForWindow: LiveWindowState,
  nowSec: number,
): TriggerGtdDesire | null {
  if (!def || !isBuyGtdDef(def)) return null;
  const ws = Number(stateForWindow.windowStart);
  const we = Number(stateForWindow.windowEnd);
  if (!Number.isFinite(ws) || !Number.isFinite(we) || we <= ws) return null;
  if (!inBuyGtdPlaceWindow(nowSec, ws, we, def.windowArea)) {
    return null;
  }
  return {
    triggerId: def.id,
    triggerName: String(trigger.name || def.name || "").trim() || "Untitled",
    sides: ["up", "down"],
    priceCents: def.startPriceCents,
    shares: def.buyShares,
    sellOrderType: def.sellOrderType,
    takeProfitCents: def.takeProfitCents,
    buySidesMode: def.buySidesMode === "both" ? "both" : "first",
    windowStart: ws,
    windowEnd: we,
  };
}

export async function tickTriggerGtdEngine(
  state: LiveWindowState,
  nowMs: number,
): Promise<void> {
  if (!isTradingExecutor()) return;
  const series = String(state.series || "")
    .trim()
    .toLowerCase();
  if (!series) return;

  const active = await listActiveTradeGtdTriggersForSeries(series);
  const byUser = new Map<string, typeof active>();
  for (const t of active) {
    const list = byUser.get(t.userId) ?? [];
    list.push(t);
    byUser.set(t.userId, list);
  }

  const nowSec = nowMs / 1000;

  const userIds = new Set<string>(byUser.keys());
  for (const engine of liveTradingRegistry.listEngines()) {
    if (engine.getBoundSeries() === series) userIds.add(engine.getUserId());
  }

  for (const userId of userIds) {
    const engine = await liveTradingRegistry.ensureLoaded(userId);
    try {
      await engine.ensureBoundToSeries(series);
    } catch {
      /* ignore */
    }
    if (!engine.getConfig().startTrading) {
      if (engine.hasTriggerGtdRests()) {
        await engine.syncTriggerGtdBuys(state, []).catch(() => {});
      }
      continue;
    }

    const mine = byUser.get(userId) ?? [];
    const winnerId = pickHighestTradeGtdTriggerId(mine);
    const winner = winnerId ? mine.find((t) => t.id === winnerId) : undefined;
    const desires: TriggerGtdDesire[] = [];
    if (winner) {
      const def = normalizeReplayTriggerDef(winner);
      if (def && isBuyGtdDef(def)) {
        const cur = desireForTrigger(winner, def, state, nowSec);
        if (cur) desires.push(cur);
      }
    }
    await engine.syncTriggerGtdBuys(state, desires).catch(() => {});
  }
}
