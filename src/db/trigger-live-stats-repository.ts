import { getMongoClient, getMongoDbName } from "./mongo-client.js";

const COLLECTION = "trigger_live_stats";

export interface TriggerLiveStatsDoc {
  _id: string;
  userId: string;
  triggerId: string;
  success: number;
  fail: number;
  blue: number;
  takeProfit: number;
  stopLoss: number;
  pnlUsd: number;
  updatedAt: string;
}

export interface TriggerLiveStats {
  triggerId: string;
  success: number;
  fail: number;
  blue: number;
  takeProfit: number;
  stopLoss: number;
  pnlUsd: number;
  updatedAt: string | null;
}

export type TriggerExitReason = "tp" | "sl" | "window-end" | string;

let indexesPromise: Promise<void> | null = null;

async function col() {
  const mongo = await getMongoClient();
  return mongo.db(getMongoDbName()).collection<TriggerLiveStatsDoc>(COLLECTION);
}

async function ensureIndexes(): Promise<void> {
  if (!indexesPromise) {
    indexesPromise = (async () => {
      const c = await col();
      await c.createIndex({ userId: 1, triggerId: 1 }, { unique: true });
    })().catch((err) => {
      indexesPromise = null;
      throw err;
    });
  }
  await indexesPromise;
}

function docId(userId: string, triggerId: string): string {
  return `${userId}:${triggerId}`;
}

function emptyStats(triggerId: string): TriggerLiveStats {
  return {
    triggerId,
    success: 0,
    fail: 0,
    blue: 0,
    takeProfit: 0,
    stopLoss: 0,
    pnlUsd: 0,
    updatedAt: null,
  };
}

export async function getTriggerLiveStats(
  userId: string,
  triggerId: string,
): Promise<TriggerLiveStats> {
  await ensureIndexes();
  const c = await col();
  const doc = await c.findOne({ _id: docId(userId, triggerId), userId });
  if (!doc) return emptyStats(triggerId);
  return {
    triggerId,
    success: Number(doc.success) || 0,
    fail: Number(doc.fail) || 0,
    blue: Number(doc.blue) || 0,
    takeProfit: Number(doc.takeProfit) || 0,
    stopLoss: Number(doc.stopLoss) || 0,
    pnlUsd: Number(doc.pnlUsd) || 0,
    updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : null,
  };
}

export async function recordTriggerLiveStatsEvent(
  userId: string,
  triggerId: string,
  result: "success" | "fail" | "blue",
  pnlUsd: number,
  exitReason?: TriggerExitReason,
): Promise<TriggerLiveStats> {
  await ensureIndexes();
  const c = await col();
  const id = docId(userId, triggerId);
  const pnl = Number.isFinite(pnlUsd) ? pnlUsd : 0;
  const now = new Date().toISOString();
  const inc = {
    success: result === "success" ? 1 : 0,
    fail: result === "fail" ? 1 : 0,
    blue: result === "blue" ? 1 : 0,
    takeProfit: exitReason === "tp" ? 1 : 0,
    stopLoss: exitReason === "sl" ? 1 : 0,
    pnlUsd: pnl,
  };
  // Do not put `blue` (or any $inc field) in $setOnInsert — Mongo rejects path conflicts
  // and the first Trade stats event 500s, so totals never get created.
  await c.updateOne(
    { _id: id, userId },
    {
      $setOnInsert: { userId, triggerId },
      $inc: {
        success: inc.success,
        fail: inc.fail,
        blue: inc.blue,
        takeProfit: inc.takeProfit,
        stopLoss: inc.stopLoss,
        pnlUsd: inc.pnlUsd,
      },
      $set: { updatedAt: now },
    },
    { upsert: true },
  );
  return getTriggerLiveStats(userId, triggerId);
}

const CREDITS_COLLECTION = "trigger_live_stats_credits";

type TriggerStatsCreditDoc = {
  _id: string;
  userId: string;
  triggerId: string;
  cardId: string;
  result: "success" | "fail" | "blue";
  pnlUsd: number;
  exitReason: string | null;
  createdAt: string;
};

async function creditsCol() {
  const mongo = await getMongoClient();
  return mongo.db(getMongoDbName()).collection<TriggerStatsCreditDoc>(CREDITS_COLLECTION);
}

function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000,
  );
}

/**
 * Credit Trade trigger stats once per settled position card (same settlement as Positions).
 * Duplicate card ids are ignored so enrich/retry cannot double-count.
 */
export async function recordTriggerLiveStatsForSettledCard(
  userId: string,
  triggerId: string,
  cardId: string,
  result: "success" | "fail" | "blue",
  pnlUsd: number,
  exitReason?: TriggerExitReason,
): Promise<TriggerLiveStats | null> {
  const tid = String(triggerId || "").trim();
  const cid = String(cardId || "").trim();
  if (!tid || !cid) return null;
  await ensureIndexes();
  const credits = await creditsCol();
  try {
    await credits.insertOne({
      _id: `${userId}:${cid}`,
      userId,
      triggerId: tid,
      cardId: cid,
      result,
      pnlUsd: Number.isFinite(pnlUsd) ? pnlUsd : 0,
      exitReason: exitReason != null ? String(exitReason) : null,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) return null;
    throw err;
  }
  return recordTriggerLiveStatsEvent(userId, tid, result, pnlUsd, exitReason);
}

export async function deleteTriggerLiveStats(
  userId: string,
  triggerId: string,
): Promise<void> {
  await ensureIndexes();
  const c = await col();
  await c.deleteOne({ _id: docId(userId, triggerId), userId });
}
