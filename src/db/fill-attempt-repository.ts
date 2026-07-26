import { ObjectId } from "mongodb";
import { getMongoClient, getMongoDbName } from "./mongo-client.js";
import { getRollingCutoffUtcSec } from "../heatmap-service.js";

const COLLECTION = "fill_attempts";

export interface FillAttemptDoc {
  _id: string;
  userId: string;
  attemptedAt: string;
  /** Unix seconds — used with rolling cutoff. */
  attemptedAtSec: number;
  series?: string;
  leg: "buy" | "sell";
  side?: "up" | "down";
  /** CLOB order id when known — used to mark success later. */
  orderId?: string;
  /** True once any size matched on this attempt. */
  success: boolean;
}

export interface FillSuccessStats {
  attempts: number;
  successes: number;
  /** 0–100; null when there are no attempts in the window. */
  ratePct: number | null;
  cutoffUtc: number;
}

let indexesPromise: Promise<void> | null = null;

async function col() {
  const mongo = await getMongoClient();
  return mongo.db(getMongoDbName()).collection<FillAttemptDoc>(COLLECTION);
}

async function ensureIndexes(): Promise<void> {
  if (!indexesPromise) {
    indexesPromise = (async () => {
      const c = await col();
      await Promise.all([
        c.createIndex({ userId: 1, attemptedAtSec: -1 }),
        c.createIndex({ userId: 1, orderId: 1 }, { sparse: true }),
      ]);
    })().catch((err) => {
      indexesPromise = null;
      throw err;
    });
  }
  await indexesPromise;
}

function emptyStats(cutoffUtc = getRollingCutoffUtcSec()): FillSuccessStats {
  return { attempts: 0, successes: 0, ratePct: null, cutoffUtc };
}

export async function recordFillAttempt(input: {
  userId: string;
  leg: "buy" | "sell";
  side?: "up" | "down";
  series?: string;
  orderId?: string;
  success?: boolean;
  atMs?: number;
}): Promise<FillSuccessStats> {
  await ensureIndexes();
  const c = await col();
  const atMs = input.atMs ?? Date.now();
  const attemptedAtSec = Math.floor(atMs / 1000);
  const cutoffUtc = getRollingCutoffUtcSec();
  const orderId = String(input.orderId ?? "").trim() || undefined;

  // Prefer updating an existing row for the same order (place → later fill).
  if (orderId) {
    const existing = await c.findOne({ userId: input.userId, orderId });
    if (existing) {
      if (input.success === true && !existing.success) {
        await c.updateOne({ _id: existing._id }, { $set: { success: true } });
      }
      await c.deleteMany({
        userId: input.userId,
        attemptedAtSec: { $lt: cutoffUtc },
      });
      return summarizeFillSuccess(input.userId, cutoffUtc);
    }
  }

  const doc: FillAttemptDoc = {
    _id: new ObjectId().toHexString(),
    userId: input.userId,
    attemptedAt: new Date(atMs).toISOString(),
    attemptedAtSec,
    series: input.series,
    leg: input.leg,
    side: input.side,
    orderId,
    success: input.success === true,
  };
  await c.insertOne(doc);
  await c.deleteMany({
    userId: input.userId,
    attemptedAtSec: { $lt: cutoffUtc },
  });
  return summarizeFillSuccess(input.userId, cutoffUtc);
}

export async function markFillAttemptSuccess(
  userId: string,
  orderId: string,
): Promise<FillSuccessStats> {
  await ensureIndexes();
  const id = String(orderId ?? "").trim();
  if (!id) return summarizeFillSuccess(userId);
  const c = await col();
  await c.updateOne({ userId, orderId: id }, { $set: { success: true } });
  return summarizeFillSuccess(userId);
}

export async function summarizeFillSuccess(
  userId: string,
  cutoffUtc = getRollingCutoffUtcSec(),
): Promise<FillSuccessStats> {
  await ensureIndexes();
  const c = await col();
  const rows = await c
    .find({ userId, attemptedAtSec: { $gte: cutoffUtc } })
    .project({ success: 1 })
    .toArray();
  const attempts = rows.length;
  const successes = rows.reduce((n, r) => n + (r.success ? 1 : 0), 0);
  if (attempts === 0) return emptyStats(cutoffUtc);
  return {
    attempts,
    successes,
    ratePct: Math.round((successes / attempts) * 1000) / 10,
    cutoffUtc,
  };
}
