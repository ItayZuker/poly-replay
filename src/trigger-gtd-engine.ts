/**
 * Executor-side Trigger Trade GTD: place/poll resting buys from Mongo
 * (no browser required). Survives dyno restart via persisted order ids.
 */
import { listActiveTradeGtdTriggersForSeries } from "./db/user-trigger-repository.js";
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
  offsetMs: number,
): boolean {
  const duration = Math.max(1, windowEnd - windowStart);
  const applyStart = windowStart + area.start * duration;
  const applyEnd = windowStart + area.end * duration;
  const offsetSec = Math.max(0, Number(offsetMs) || 0) / 1000;
  const placeAt = applyStart - offsetSec;
  return nowSec + 1e-9 >= placeAt && nowSec <= applyEnd + 1e-9;
}

function nextWindow(state: LiveWindowState): LiveWindowState | null {
  const ws = Number(state.windowStart);
  const we = Number(state.windowEnd);
  const dur = we - ws;
  if (!Number.isFinite(ws) || !Number.isFinite(we) || !(dur > 0)) return null;
  return { ...state, windowStart: we, windowEnd: we + dur };
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
  if (!inBuyGtdPlaceWindow(nowSec, ws, we, def.windowArea, def.gtdPlaceOffsetMs)) {
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
  const nxt = nextWindow(state);

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

    const desires: TriggerGtdDesire[] = [];
    for (const t of byUser.get(userId) ?? []) {
      const def = normalizeReplayTriggerDef(t);
      if (!def || !isBuyGtdDef(def)) continue;
      const cur = desireForTrigger(t, def, state, nowSec);
      if (cur) desires.push(cur);
      if (nxt) {
        const nextDesire = desireForTrigger(t, def, nxt, nowSec);
        if (nextDesire) desires.push(nextDesire);
      }
    }
    await engine.syncTriggerGtdBuys(state, desires).catch(() => {});
  }
}
