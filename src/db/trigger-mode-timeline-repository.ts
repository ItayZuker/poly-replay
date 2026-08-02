import { getMongoClient, getMongoDbName } from "./mongo-client.js";

const COLLECTION = "trigger_mode_timeline";

export interface TriggerModeTimelineEvent {
  userId: string;
  triggerId: string;
  atMs: number; // epoch ms UTC
  paused: boolean;
  runMode: "demo" | "trade";
}

type TriggerModeTimelineDoc = TriggerModeTimelineEvent & { _id?: unknown };

let indexesPromise: Promise<void> | null = null;

async function col() {
  const mongo = await getMongoClient();
  return mongo.db(getMongoDbName()).collection<TriggerModeTimelineDoc>(COLLECTION);
}

export async function ensureTriggerModeTimelineIndexes(): Promise<void> {
  if (!indexesPromise) {
    indexesPromise = (async () => {
      const c = await col();
      await c.createIndex({ userId: 1, triggerId: 1, atMs: 1 });
      await c.createIndex({ userId: 1, atMs: 1 });
    })().catch((err) => {
      indexesPromise = null;
      throw err;
    });
  }
  await indexesPromise;
}

/** Latest event for a trigger (by atMs, then insertion order). */
async function latestEventForTrigger(
  userId: string,
  triggerId: string,
): Promise<TriggerModeTimelineEvent | null> {
  await ensureTriggerModeTimelineIndexes();
  const c = await col();
  const doc = await c.findOne(
    { userId, triggerId: String(triggerId) },
    { sort: { atMs: -1, _id: -1 } },
  );
  if (!doc) return null;
  return {
    userId: doc.userId,
    triggerId: doc.triggerId,
    atMs: Number(doc.atMs) || 0,
    paused: Boolean(doc.paused),
    runMode: doc.runMode === "trade" ? "trade" : "demo",
  };
}

/**
 * Append a mode/pause change. Skips insert when identical to the latest state
 * for that trigger (paused + runMode).
 */
export async function appendTriggerModeEvent(
  userId: string,
  triggerId: string,
  state: { paused: boolean; runMode: "demo" | "trade"; atMs?: number },
): Promise<TriggerModeTimelineEvent | null> {
  const tid = String(triggerId).trim();
  if (!tid) return null;
  const paused = Boolean(state.paused);
  const runMode: "demo" | "trade" = state.runMode === "trade" ? "trade" : "demo";
  const atMs =
    state.atMs != null && Number.isFinite(state.atMs) ? Math.floor(state.atMs) : Date.now();

  const latest = await latestEventForTrigger(userId, tid);
  if (latest && latest.paused === paused && latest.runMode === runMode) {
    return null;
  }

  const event: TriggerModeTimelineEvent = {
    userId,
    triggerId: tid,
    atMs,
    paused,
    runMode,
  };
  const c = await col();
  await c.insertOne(event);
  return event;
}

export async function listTriggerModeEvents(
  userId: string,
  triggerIds?: string[],
): Promise<TriggerModeTimelineEvent[]> {
  await ensureTriggerModeTimelineIndexes();
  const c = await col();
  const filter: Record<string, unknown> = { userId };
  if (triggerIds?.length) {
    const ids = [...new Set(triggerIds.map((id) => String(id).trim()).filter(Boolean))];
    if (ids.length === 0) return [];
    filter.triggerId = { $in: ids };
  }
  const docs = await c.find(filter).sort({ triggerId: 1, atMs: 1, _id: 1 }).toArray();
  return docs.map((doc) => ({
    userId: doc.userId,
    triggerId: doc.triggerId,
    atMs: Number(doc.atMs) || 0,
    paused: Boolean(doc.paused),
    runMode: doc.runMode === "trade" ? "trade" : "demo",
  }));
}

/**
 * True when the latest timeline event at or before `atMs` has Trade mode and is not paused.
 * No events → false (callers may treat empty timelines as legacy separately).
 */
export function wasTriggerTradingActive(
  eventsForTrigger: TriggerModeTimelineEvent[],
  atMs: number,
): boolean {
  if (!eventsForTrigger.length || !Number.isFinite(atMs)) return false;
  let latest: TriggerModeTimelineEvent | null = null;
  for (const ev of eventsForTrigger) {
    if (ev.atMs > atMs) continue;
    if (!latest || ev.atMs > latest.atMs) latest = ev;
  }
  if (!latest) return false;
  return latest.runMode === "trade" && !latest.paused;
}

/**
 * If the trigger has no timeline rows yet, insert one at createdAtMs (or now).
 */
export async function seedTriggerModeTimelineIfEmpty(
  userId: string,
  triggerId: string,
  state: { paused: boolean; runMode: "demo" | "trade"; createdAtMs?: number },
): Promise<TriggerModeTimelineEvent | null> {
  const tid = String(triggerId).trim();
  if (!tid) return null;
  await ensureTriggerModeTimelineIndexes();
  const c = await col();
  const existing = await c.findOne({ userId, triggerId: tid });
  if (existing) return null;
  const atMs =
    state.createdAtMs != null && Number.isFinite(state.createdAtMs)
      ? Math.floor(state.createdAtMs)
      : Date.now();
  const event: TriggerModeTimelineEvent = {
    userId,
    triggerId: tid,
    atMs,
    paused: Boolean(state.paused),
    runMode: state.runMode === "trade" ? "trade" : "demo",
  };
  await c.insertOne(event);
  return event;
}
