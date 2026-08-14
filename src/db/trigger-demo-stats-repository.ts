import type { TradingPositionCard } from "../types.js";
import { getMongoClient, getMongoDbName } from "./mongo-client.js";

export type TriggerDemoStats = {
  success: number;
  fail: number;
  blue: number;
  takeProfit: number;
  stopLoss: number;
  pnlUsd: number;
};

const CREDITS_COLLECTION = "trigger_demo_stats_credits";
const TRIGGERS_COLLECTION = "triggers";

export type TriggerDemoStatKind = "fail" | "blue" | "takeProfit" | "stopLoss";

type TriggerDemoStatsCreditDoc = {
  _id: string;
  userId: string;
  triggerId: string;
  cardId: string;
  kind: TriggerDemoStatKind;
  pnlUsd: number;
  createdAt: string;
};

let indexesPromise: Promise<void> | null = null;

async function creditsCol() {
  const mongo = await getMongoClient();
  return mongo.db(getMongoDbName()).collection<TriggerDemoStatsCreditDoc>(CREDITS_COLLECTION);
}

async function triggersCol() {
  const mongo = await getMongoClient();
  return mongo.db(getMongoDbName()).collection(TRIGGERS_COLLECTION);
}

async function ensureIndexes(): Promise<void> {
  if (!indexesPromise) {
    indexesPromise = (async () => {
      const c = await creditsCol();
      await c.createIndex({ userId: 1, triggerId: 1 });
      await c.createIndex({ userId: 1, cardId: 1 }, { unique: true });
    })().catch((err) => {
      indexesPromise = null;
      throw err;
    });
  }
  await indexesPromise;
}

function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000,
  );
}

function emptyDemoStats(): TriggerDemoStats {
  return { success: 0, fail: 0, blue: 0, takeProfit: 0, stopLoss: 0, pnlUsd: 0 };
}

/** Map a settled Demo Positions card to a Demo stats bucket. */
export function classifyDemoStatKind(
  card: Pick<TradingPositionCard, "status" | "pl" | "triggerExitReason">,
): { kind: TriggerDemoStatKind; pnlUsd: number } | null {
  if (String(card.status || "").toLowerCase() === "open") return null;
  const pl = Number(card.pl);
  if (!Number.isFinite(pl)) return null;
  if (card.status === "win") return { kind: "blue", pnlUsd: pl };
  if (card.status === "loss") return { kind: "fail", pnlUsd: pl };
  if (card.status === "sold") {
    if (card.triggerExitReason === "sl" || pl <= 0) return { kind: "stopLoss", pnlUsd: pl };
    return { kind: "takeProfit", pnlUsd: pl };
  }
  return null;
}

/**
 * Credit Demo stats once per settled position card.
 * Unique credit row + atomic $inc so concurrent settles cannot lose or double-count.
 */
export async function recordTriggerDemoStatsForSettledCard(
  userId: string,
  triggerId: string,
  cardId: string,
  kind: TriggerDemoStatKind,
  pnlUsd: number,
): Promise<boolean> {
  const uid = String(userId || "").trim();
  const tid = String(triggerId || "").trim();
  const cid = String(cardId || "").trim();
  if (!uid || !tid || !cid) return false;
  await ensureIndexes();

  try {
    await (await creditsCol()).insertOne({
      _id: `${uid}:${cid}`,
      userId: uid,
      triggerId: tid,
      cardId: cid,
      kind,
      pnlUsd: Number.isFinite(pnlUsd) ? pnlUsd : 0,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }

  const inc: Record<string, number> = {
    "demoStats.pnlUsd": Number.isFinite(pnlUsd) ? pnlUsd : 0,
  };
  if (kind === "fail") inc["demoStats.fail"] = 1;
  else if (kind === "blue") inc["demoStats.blue"] = 1;
  else if (kind === "takeProfit") inc["demoStats.takeProfit"] = 1;
  else if (kind === "stopLoss") inc["demoStats.stopLoss"] = 1;

  await (await triggersCol()).updateOne(
    { userId: uid, id: tid },
    {
      $inc: inc,
      $set: { updatedAt: new Date().toISOString() },
    },
  );
  return true;
}

export async function deleteTriggerDemoStatsCredits(
  userId: string,
  triggerId?: string,
): Promise<number> {
  await ensureIndexes();
  const uid = String(userId || "").trim();
  if (!uid) return 0;
  const filter: Record<string, string> = { userId: uid };
  if (triggerId) filter.triggerId = String(triggerId);
  const result = await (await creditsCol()).deleteMany(filter);
  return result.deletedCount ?? 0;
}

export async function deleteAllTriggerDemoStatsCreditsForUser(userId: string): Promise<number> {
  return deleteTriggerDemoStatsCredits(userId);
}

/**
 * Rebuild Demo stats for a trigger from settled Demo Positions cards (heals lost races).
 * Replaces credits + demoStats for that trigger.
 */
export async function rebuildTriggerDemoStatsFromCards(
  userId: string,
  triggerId: string,
  cards: TradingPositionCard[],
): Promise<TriggerDemoStats> {
  const uid = String(userId || "").trim();
  const tid = String(triggerId || "").trim();
  const stats = emptyDemoStats();
  if (!uid || !tid) return stats;

  await deleteTriggerDemoStatsCredits(uid, tid);
  await (await triggersCol()).updateOne(
    { userId: uid, id: tid },
    { $set: { demoStats: emptyDemoStats(), updatedAt: new Date().toISOString() } },
  );

  for (const card of cards) {
    if (!card || String(card.triggerId || "") !== tid) continue;
    if (!(card.demo === true || String(card.id || "").startsWith("demo:"))) continue;
    const classified = classifyDemoStatKind(card);
    if (!classified) continue;
    const ok = await recordTriggerDemoStatsForSettledCard(
      uid,
      tid,
      String(card.id),
      classified.kind,
      classified.pnlUsd,
    );
    if (!ok) continue;
    if (classified.kind === "fail") stats.fail += 1;
    else if (classified.kind === "blue") stats.blue += 1;
    else if (classified.kind === "takeProfit") stats.takeProfit += 1;
    else if (classified.kind === "stopLoss") stats.stopLoss += 1;
    stats.pnlUsd += classified.pnlUsd;
  }
  return stats;
}
