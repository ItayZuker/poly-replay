import type { TradingPositionCard } from "../types.js";
import { getMongoClient, getMongoDbName } from "./mongo-client.js";

const COLLECTION = "position_cards";

/** Positions UI retention: settled cards older than this are pruned. Open cards stay. */
export const POSITION_CARD_RETENTION_MS = 24 * 60 * 60 * 1000;

type PositionCardDoc = TradingPositionCard & {
  _id: string;
  userId: string;
  updatedAt: string;
};

let indexesPromise: Promise<void> | null = null;

async function col() {
  const mongo = await getMongoClient();
  return mongo.db(getMongoDbName()).collection<PositionCardDoc>(COLLECTION);
}

async function ensureIndexes(): Promise<void> {
  if (!indexesPromise) {
    indexesPromise = (async () => {
      const c = await col();
      await c.createIndex({ userId: 1, id: 1 }, { unique: true });
      await c.createIndex({ userId: 1, series: 1, buyAt: -1 });
      await c.createIndex({ userId: 1, series: 1, demo: 1, status: 1 });
      await c.createIndex({ userId: 1, triggerId: 1, demo: 1 });
      await c.createIndex({ userId: 1, status: 1, buyAt: 1 });
    })().catch((err) => {
      indexesPromise = null;
      throw err;
    });
  }
  await indexesPromise;
}

function docId(userId: string, cardId: string): string {
  return `${userId}::${cardId}`;
}

function normalizeSeriesKey(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function isDemoCard(card: Pick<TradingPositionCard, "demo" | "id">): boolean {
  return card.demo === true || String(card.id || "").startsWith("demo:");
}

/** Settled buy time older than retention → prune. Open always kept. */
export function isSettledPositionCardExpired(
  card: Pick<TradingPositionCard, "status" | "buyAt" | "soldAt">,
  nowMs: number = Date.now(),
  retentionMs: number = POSITION_CARD_RETENTION_MS,
): boolean {
  if (String(card.status || "").toLowerCase() === "open") return false;
  const buyMs =
    card.buyAt != null && Number.isFinite(card.buyAt) ? Number(card.buyAt) * 1000 : NaN;
  if (!Number.isFinite(buyMs)) return false;
  return buyMs < nowMs - retentionMs;
}

export function filterPositionCardsForUi(
  cards: TradingPositionCard[],
  nowMs: number = Date.now(),
): TradingPositionCard[] {
  return cards.filter((c) => c && !isSettledPositionCardExpired(c, nowMs));
}

function toPublic(doc: PositionCardDoc): TradingPositionCard {
  const { _id: _, userId: _uid, updatedAt: _u, ...card } = doc;
  if (isDemoCard(card)) card.demo = true;
  return card;
}

/** Upsert one Positions card (open or settled). */
export async function upsertPositionCard(
  userId: string,
  card: TradingPositionCard,
): Promise<TradingPositionCard | null> {
  await ensureIndexes();
  const uid = String(userId || "").trim();
  const id = String(card?.id || "").trim();
  if (!uid || !id || !card) return null;
  const series = normalizeSeriesKey(card.series);
  const now = new Date().toISOString();
  const doc: PositionCardDoc = {
    ...card,
    id,
    series: series || String(card.series || ""),
    demo: isDemoCard(card) ? true : card.demo,
    _id: docId(uid, id),
    userId: uid,
    updatedAt: now,
  };
  const c = await col();
  await c.replaceOne({ _id: doc._id, userId: uid }, doc, { upsert: true });
  return toPublic(doc);
}

export async function upsertPositionCardsBulk(
  userId: string,
  cards: TradingPositionCard[],
): Promise<number> {
  let n = 0;
  for (const card of cards) {
    const saved = await upsertPositionCard(userId, card);
    if (saved) n += 1;
  }
  return n;
}

export async function listPositionCards(
  userId: string,
  options: { series?: string; includeExpiredSettled?: boolean } = {},
): Promise<TradingPositionCard[]> {
  await ensureIndexes();
  const uid = String(userId || "").trim();
  if (!uid) return [];
  const filter: Record<string, unknown> = { userId: uid };
  const series = normalizeSeriesKey(options.series);
  if (series) {
    filter.$or = [
      { series },
      { series: { $exists: false } },
      { series: "" },
      { series: null },
    ];
  }
  const c = await col();
  const rows = await c.find(filter).sort({ buyAt: -1 }).toArray();
  const cards = rows.map(toPublic);
  if (options.includeExpiredSettled) return cards;
  return filterPositionCardsForUi(cards);
}

export async function deletePositionCardsByIds(
  userId: string,
  cardIds: string[],
): Promise<number> {
  await ensureIndexes();
  const uid = String(userId || "").trim();
  const ids = [...new Set(cardIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!uid || ids.length === 0) return 0;
  const c = await col();
  const result = await c.deleteMany({ userId: uid, id: { $in: ids } });
  return result.deletedCount ?? 0;
}

/** Remove settled Positions older than retention (Open kept). Optional series scope. */
export async function pruneExpiredSettledPositionCards(
  userId: string,
  series?: string,
): Promise<number> {
  await ensureIndexes();
  const uid = String(userId || "").trim();
  if (!uid) return 0;
  const cutoffSec = Math.floor((Date.now() - POSITION_CARD_RETENTION_MS) / 1000);
  const filter: Record<string, unknown> = {
    userId: uid,
    status: { $ne: "open" },
    buyAt: { $lt: cutoffSec },
  };
  const seriesKey = normalizeSeriesKey(series);
  if (seriesKey) {
    filter.$or = [
      { series: seriesKey },
      { series: { $exists: false } },
      { series: "" },
      { series: null },
    ];
  }
  const c = await col();
  const result = await c.deleteMany(filter);
  return result.deletedCount ?? 0;
}

/** Demo Positions are owned by the trigger — remove when the trigger is deleted. */
export async function deleteDemoPositionCardsForTrigger(
  userId: string,
  triggerId: string,
): Promise<number> {
  await ensureIndexes();
  const uid = String(userId || "").trim();
  const tid = String(triggerId || "").trim();
  if (!uid || !tid) return 0;
  const c = await col();
  const rows = await c.find({ userId: uid, triggerId: tid }).toArray();
  const ids = rows.filter((r) => isDemoCard(r)).map((r) => String(r.id));
  // Also catch demo ids that omit triggerId field.
  const prefix = `demo:${tid}:`;
  const byId = await c
    .find({ userId: uid, id: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` } })
    .toArray();
  for (const r of byId) {
    if (!ids.includes(String(r.id))) ids.push(String(r.id));
  }
  if (ids.length === 0) return 0;
  const result = await c.deleteMany({ userId: uid, id: { $in: ids } });
  return result.deletedCount ?? 0;
}

export async function deleteAllPositionCardsForUser(userId: string): Promise<number> {
  await ensureIndexes();
  const uid = String(userId || "").trim();
  if (!uid) return 0;
  const c = await col();
  const result = await c.deleteMany({ userId: uid });
  return result.deletedCount ?? 0;
}

/** Clear settled Positions for filter; never deletes Open. Does not touch stats ledger. */
export async function clearSettledPositionCardsInDb(
  userId: string,
  scope: "demo" | "trade" | "all",
  series?: string,
): Promise<string[]> {
  await ensureIndexes();
  const uid = String(userId || "").trim();
  if (!uid) return [];
  const seriesKey = normalizeSeriesKey(series);
  const c = await col();
  const rows = await c
    .find({ userId: uid, status: { $ne: "open" } })
    .toArray();
  const ids: string[] = [];
  for (const row of rows) {
    const card = toPublic(row);
    if (seriesKey && card.series && card.series !== seriesKey) continue;
    const demo = isDemoCard(card);
    if (scope === "demo" && !demo) continue;
    if (scope === "trade" && demo) continue;
    ids.push(card.id);
  }
  if (ids.length === 0) return [];
  await c.deleteMany({ userId: uid, id: { $in: ids } });
  return ids;
}
