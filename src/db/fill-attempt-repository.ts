import { ObjectId } from "mongodb";
import { getMongoClient, getMongoDbName } from "./mongo-client.js";
import { getRollingCutoffUtcSec } from "../heatmap-service.js";

const COLLECTION = "fill_attempts";

/** CLOB order styles tracked in Market → Trade fill success. */
export type FillOrderKind = "FAK" | "FOK" | "GTD";

export const FILL_ORDER_KINDS: FillOrderKind[] = ["FAK", "FOK", "GTD"];

export interface FillAttemptDoc {
  _id: string;
  userId: string;
  attemptedAt: string;
  /** Unix seconds — used with rolling cutoff. */
  attemptedAtSec: number;
  series?: string;
  leg: "buy" | "sell";
  side?: "up" | "down";
  /** CLOB order id when known — used to mark success / touch later. */
  orderId?: string;
  /** Order style; omitted on legacy rows (excluded from typed stats). */
  orderKind?: FillOrderKind;
  /**
   * Eligible for fill-success stats.
   * FAK/FOK: true on place. GTD: true only after a fill, or after close when the
   * limit was touched while live (strategy cancel with no touch stays false).
   */
  countable?: boolean;
  /** GTD: book/trade reached the limit while the order was live. */
  touched?: boolean;
  /** Limit price (0–1) for GTD touch checks. */
  limitPrice?: number;
  /** True once any size matched on this attempt. */
  success: boolean;
}

export interface FillSuccessKindStats {
  attempts: number;
  successes: number;
  /** 0–100; null when there are no attempts in the window. */
  ratePct: number | null;
}

export interface FillSuccessStats {
  attempts: number;
  successes: number;
  /** 0–100; null when there are no attempts in the window. */
  ratePct: number | null;
  cutoffUtc: number;
  byKind: Record<FillOrderKind, FillSuccessKindStats>;
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

function emptyKindStats(): FillSuccessKindStats {
  return { attempts: 0, successes: 0, ratePct: null };
}

function emptyStats(cutoffUtc = getRollingCutoffUtcSec()): FillSuccessStats {
  return {
    attempts: 0,
    successes: 0,
    ratePct: null,
    cutoffUtc,
    byKind: {
      FAK: emptyKindStats(),
      FOK: emptyKindStats(),
      GTD: emptyKindStats(),
    },
  };
}

function ratePct(successes: number, attempts: number): number | null {
  if (attempts <= 0) return null;
  return Math.round((successes / attempts) * 1000) / 10;
}

function kindStats(successes: number, attempts: number): FillSuccessKindStats {
  return {
    attempts,
    successes,
    ratePct: ratePct(successes, attempts),
  };
}

async function pruneOld(userId: string, cutoffUtc: number): Promise<void> {
  const c = await col();
  await c.deleteMany({
    userId,
    attemptedAtSec: { $lt: cutoffUtc },
  });
}

export async function recordFillAttempt(input: {
  userId: string;
  leg: "buy" | "sell";
  side?: "up" | "down";
  series?: string;
  orderId?: string;
  orderKind: FillOrderKind;
  /** Override; default true for FAK/FOK, false for GTD unless success. */
  countable?: boolean;
  touched?: boolean;
  limitPrice?: number;
  success?: boolean;
  atMs?: number;
}): Promise<FillSuccessStats> {
  await ensureIndexes();
  const c = await col();
  const atMs = input.atMs ?? Date.now();
  const attemptedAtSec = Math.floor(atMs / 1000);
  const cutoffUtc = getRollingCutoffUtcSec();
  const orderId = String(input.orderId ?? "").trim() || undefined;
  const success = input.success === true;
  const orderKind = input.orderKind;
  const countable =
    input.countable ??
    (orderKind === "GTD" ? success : true);
  const touched = input.touched === true || success;

  // Prefer updating an existing row for the same order (place → later fill).
  if (orderId) {
    const existing = await c.findOne({ userId: input.userId, orderId });
    if (existing) {
      const patch: Partial<FillAttemptDoc> = {};
      if (success && !existing.success) {
        patch.success = true;
        patch.countable = true;
        patch.touched = true;
      }
      if (orderKind && !existing.orderKind) patch.orderKind = orderKind;
      if (input.limitPrice != null && existing.limitPrice == null) {
        patch.limitPrice = input.limitPrice;
      }
      if (Object.keys(patch).length > 0) {
        await c.updateOne({ _id: existing._id }, { $set: patch });
      }
      await pruneOld(input.userId, cutoffUtc);
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
    orderKind,
    countable,
    touched,
    limitPrice: input.limitPrice,
    success,
  };
  await c.insertOne(doc);
  await pruneOld(input.userId, cutoffUtc);
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
  await c.updateOne(
    { userId, orderId: id },
    { $set: { success: true, countable: true, touched: true } },
  );
  return summarizeFillSuccess(userId);
}

/** GTD: mark that the limit was touched while the order was live. */
export async function markFillAttemptTouched(
  userId: string,
  orderId: string,
): Promise<FillSuccessStats> {
  await ensureIndexes();
  const id = String(orderId ?? "").trim();
  if (!id) return summarizeFillSuccess(userId);
  const c = await col();
  await c.updateOne(
    { userId, orderId: id },
    { $set: { touched: true } },
  );
  return summarizeFillSuccess(userId);
}

/**
 * GTD order left the book (cancel / expire) without a further fill.
 * Countable only when the limit was touched while live — strategy cancels with
 * no touch stay out of both success and miss.
 */
export async function closeFillAttempt(
  userId: string,
  orderId: string,
): Promise<FillSuccessStats> {
  await ensureIndexes();
  const id = String(orderId ?? "").trim();
  if (!id) return summarizeFillSuccess(userId);
  const c = await col();
  const existing = await c.findOne({ userId, orderId: id });
  if (!existing) return summarizeFillSuccess(userId);
  if (existing.success) {
    await c.updateOne(
      { _id: existing._id },
      { $set: { countable: true, touched: true } },
    );
  } else if (existing.touched) {
    await c.updateOne(
      { _id: existing._id },
      { $set: { countable: true } },
    );
  } else {
    await c.updateOne(
      { _id: existing._id },
      { $set: { countable: false } },
    );
  }
  return summarizeFillSuccess(userId);
}

export async function summarizeFillSuccess(
  userId: string,
  cutoffUtc = getRollingCutoffUtcSec(),
): Promise<FillSuccessStats> {
  await ensureIndexes();
  const c = await col();
  const rows = await c
    .find({
      userId,
      attemptedAtSec: { $gte: cutoffUtc },
      countable: true,
      orderKind: { $in: FILL_ORDER_KINDS },
    })
    .project({ success: 1, orderKind: 1 })
    .toArray();

  const byKindRaw: Record<FillOrderKind, { attempts: number; successes: number }> = {
    FAK: { attempts: 0, successes: 0 },
    FOK: { attempts: 0, successes: 0 },
    GTD: { attempts: 0, successes: 0 },
  };

  for (const row of rows) {
    const kind = row.orderKind as FillOrderKind | undefined;
    if (!kind || !(kind in byKindRaw)) continue;
    byKindRaw[kind].attempts += 1;
    if (row.success) byKindRaw[kind].successes += 1;
  }

  const attempts = rows.length;
  const successes = rows.reduce((n, r) => n + (r.success ? 1 : 0), 0);
  if (attempts === 0) return emptyStats(cutoffUtc);

  return {
    attempts,
    successes,
    ratePct: ratePct(successes, attempts),
    cutoffUtc,
    byKind: {
      FAK: kindStats(byKindRaw.FAK.successes, byKindRaw.FAK.attempts),
      FOK: kindStats(byKindRaw.FOK.successes, byKindRaw.FOK.attempts),
      GTD: kindStats(byKindRaw.GTD.successes, byKindRaw.GTD.attempts),
    },
  };
}
