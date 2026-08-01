import { getMongoClient, getMongoDbName } from "./mongo-client.js";

const COLLECTION = "triggers";

export interface TriggerDemoStats {
  success: number;
  fail: number;
  blue: number;
  takeProfit: number;
  stopLoss: number;
  pnlUsd: number;
}

export interface UserTriggerRecord {
  id: string;
  name: string;
  color?: string;
  durationMs: number;
  buyShares: number;
  /** Always buy (Ask); sell-side quote mode removed from the editor. */
  priceSide: "buy" | "sell";
  startMode: "range" | "price";
  /** Single Ask ¢ when startMode is price (0–100). */
  startPriceCents: number;
  endMode: "range" | "change-side";
  endChangeSideCents: number;
  priceRanges: {
    start: { lowCents: number; highCents: number };
    end: { lowCents: number; highCents: number };
  };
  ptbGap: {
    start: "positive" | "negative" | null;
    end: "positive" | "negative" | null;
  };
  gapSize: {
    start: { bound: "min" | "max"; value: number };
    end: { bound: "min" | "max"; value: number };
  };
  /** Signed $ market-price change over Duration; active when both gaps share a side. */
  priceTrend: { dollars: number; bound: "min" | "max" };
  takeProfitCents: number;
  stopLossCents: number;
  /** Buy placement: FOK default; GTD only when durationMs is 0 and startMode is price. */
  buyOrderType: "FAK" | "FOK" | "GTD";
  sellOrderType: "FAK" | "FOK" | "GTD";
  windowArea: { start: number; end: number };
  runMode: "demo" | "trade";
  paused: boolean;
  demoStats: TriggerDemoStats;
  createdAt: string;
  updatedAt: string;
}

type UserTriggerDoc = UserTriggerRecord & { userId: string; _id?: unknown };

let indexesPromise: Promise<void> | null = null;

async function col() {
  const mongo = await getMongoClient();
  return mongo.db(getMongoDbName()).collection<UserTriggerDoc>(COLLECTION);
}

async function ensureIndexes(): Promise<void> {
  if (!indexesPromise) {
    indexesPromise = (async () => {
      const c = await col();
      await c.createIndex({ userId: 1, id: 1 }, { unique: true });
      await c.createIndex({ userId: 1, updatedAt: -1 });
    })().catch((err) => {
      indexesPromise = null;
      throw err;
    });
  }
  await indexesPromise;
}

function clampCents(raw: unknown, fallback: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

function clampOffset(raw: unknown, fallback = 10): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, n));
}

function clampSigned(raw: unknown, fallback = 20): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(-100, Math.min(100, n));
}

function normalizeRange(raw: unknown): { lowCents: number; highCents: number } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  let low = clampCents(o.lowCents, 40);
  let high = clampCents(o.highCents, 70);
  if (high < low) [low, high] = [high, low];
  return { lowCents: low, highCents: high };
}

function normalizeGapSize(raw: unknown): { bound: "min" | "max"; value: number } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const bound = o.bound === "max" ? "max" : "min";
  const value = Math.max(0, Number(o.value) || 0);
  return { bound, value };
}

function normalizePriceTrend(raw: unknown): { dollars: number; bound: "min" | "max" } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const bound = o.bound === "max" ? "max" : "min";
  let dollars = Number(o.dollars);
  if (!Number.isFinite(dollars)) dollars = 0;
  dollars = Math.max(-100_000, Math.min(100_000, Math.round(dollars * 100) / 100));
  return { dollars, bound };
}

function normalizeGapKind(raw: unknown): "positive" | "negative" | null {
  return raw === "positive" || raw === "negative" ? raw : null;
}

function normalizeDemoStats(raw: unknown): TriggerDemoStats {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    success: Math.max(0, Math.round(Number(o.success) || 0)),
    fail: Math.max(0, Math.round(Number(o.fail) || 0)),
    blue: Math.max(0, Math.round(Number(o.blue) || 0)),
    takeProfit: Math.max(0, Math.round(Number(o.takeProfit) || 0)),
    stopLoss: Math.max(0, Math.round(Number(o.stopLoss) || 0)),
    pnlUsd: Number.isFinite(Number(o.pnlUsd)) ? Number(o.pnlUsd) : 0,
  };
}

function normalizeWindowArea(raw: unknown): { start: number; end: number } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  let start = Number(o.start);
  let end = Number(o.end);
  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(end)) end = 1;
  start = Math.max(0, Math.min(1, start));
  end = Math.max(0, Math.min(1, end));
  if (end < start) [start, end] = [end, start];
  return { start, end };
}

/** Normalize a client trigger payload into a stored record (no userId). */
export function normalizeUserTriggerInput(
  raw: unknown,
  existing?: UserTriggerRecord | null,
): UserTriggerRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = o.id != null ? String(o.id).trim() : existing?.id ? String(existing.id) : "";
  if (!id) return null;
  const name =
    typeof o.name === "string" && o.name.trim()
      ? o.name.trim().slice(0, 120)
      : existing?.name || "Untitled trigger";
  const tp = Math.round(Number(o.takeProfitCents));
  const sl = Math.round(Number(o.stopLossCents));
  const exits =
    tp === 80 && (sl === 20 || !Number.isFinite(sl))
      ? { takeProfitCents: 10, stopLossCents: 10 }
      : {
          takeProfitCents: clampOffset(tp, existing?.takeProfitCents ?? 10),
          stopLossCents: clampOffset(sl, existing?.stopLossCents ?? 10),
        };
  const ranges =
    o.priceRanges && typeof o.priceRanges === "object"
      ? (o.priceRanges as Record<string, unknown>)
      : {};
  const gaps = o.ptbGap && typeof o.ptbGap === "object" ? (o.ptbGap as Record<string, unknown>) : {};
  const gapSize =
    o.gapSize && typeof o.gapSize === "object" ? (o.gapSize as Record<string, unknown>) : {};
  const now = new Date().toISOString();
  const createdAt =
    typeof o.createdAt === "string"
      ? o.createdAt
      : existing?.createdAt || now;
  const durationMs = (() => {
    const n = Math.floor(Number(o.durationMs));
    if (Number.isFinite(n) && n >= 0) return n;
    const prev = Math.floor(Number(existing?.durationMs));
    return Number.isFinite(prev) && prev >= 0 ? prev : 5000;
  })();
  const startMode: "range" | "price" =
    o.startMode === "price" || o.startMode === "change-side" ? "price" : "range";
  const buyOrderTypeRaw =
    o.buyOrderType === "FAK" || o.buyOrderType === "FOK" || o.buyOrderType === "GTD"
      ? o.buyOrderType
      : existing?.buyOrderType || "FOK";
  const buyOrderType: "FAK" | "FOK" | "GTD" =
    buyOrderTypeRaw === "GTD" && !(durationMs === 0 && startMode === "price")
      ? "FOK"
      : buyOrderTypeRaw;
  return {
    id,
    name,
    color: typeof o.color === "string" ? o.color : existing?.color || "#58a6ff",
    durationMs,
    buyShares: Math.max(
      1,
      Math.min(100_000, Math.floor(Number(o.buyShares) || existing?.buyShares || 10)),
    ),
    priceSide: "buy",
    startMode,
    startPriceCents: clampCents(
      o.startPriceCents ??
        (o.startMode === "change-side" || o.startMode === "price"
          ? Math.abs(Number(o.startChangeSideCents))
          : existing?.startPriceCents),
      existing?.startPriceCents ?? 50,
    ),
    endMode: o.endMode === "change-side" ? "change-side" : "range",
    endChangeSideCents: clampSigned(o.endChangeSideCents, existing?.endChangeSideCents ?? 20),
    priceRanges: {
      start: normalizeRange(ranges.start ?? existing?.priceRanges?.start),
      end: normalizeRange(ranges.end ?? existing?.priceRanges?.end),
    },
    ptbGap: {
      start: normalizeGapKind(gaps.start !== undefined ? gaps.start : existing?.ptbGap?.start),
      end: normalizeGapKind(gaps.end !== undefined ? gaps.end : existing?.ptbGap?.end),
    },
    gapSize: {
      start: normalizeGapSize(gapSize.start ?? existing?.gapSize?.start),
      end: normalizeGapSize(gapSize.end ?? existing?.gapSize?.end),
    },
    priceTrend: normalizePriceTrend(
      o.priceTrend !== undefined ? o.priceTrend : existing?.priceTrend,
    ),
    ...exits,
    buyOrderType,
    sellOrderType:
      o.sellOrderType === "FOK" || o.sellOrderType === "GTD"
        ? o.sellOrderType
        : o.sellOrderType === "FAK"
          ? "FAK"
          : existing?.sellOrderType || "FAK",
    windowArea: normalizeWindowArea(o.windowArea ?? existing?.windowArea),
    runMode: o.runMode === "trade" ? "trade" : "demo",
    paused: o.paused !== false,
    demoStats: normalizeDemoStats(o.demoStats ?? existing?.demoStats),
    createdAt,
    updatedAt: now,
  };
}

function toClient(doc: UserTriggerDoc): UserTriggerRecord {
  const { userId: _u, _id: _id, ...rest } = doc;
  return normalizeUserTriggerInput(rest, null) as UserTriggerRecord;
}

export async function listUserTriggers(userId: string): Promise<UserTriggerRecord[]> {
  await ensureIndexes();
  const c = await col();
  const docs = await c.find({ userId }).sort({ updatedAt: -1 }).toArray();
  return docs.map(toClient).filter(Boolean);
}

export async function getUserTrigger(
  userId: string,
  triggerId: string,
): Promise<UserTriggerRecord | null> {
  await ensureIndexes();
  const c = await col();
  const doc = await c.findOne({ userId, id: String(triggerId) });
  return doc ? toClient(doc) : null;
}

export async function upsertUserTrigger(
  userId: string,
  raw: unknown,
): Promise<UserTriggerRecord | null> {
  await ensureIndexes();
  const existingId =
    raw && typeof raw === "object" && (raw as { id?: unknown }).id != null
      ? String((raw as { id: unknown }).id)
      : "";
  const existing = existingId ? await getUserTrigger(userId, existingId) : null;
  const next = normalizeUserTriggerInput(raw, existing);
  if (!next) return null;
  const c = await col();
  await c.updateOne(
    { userId, id: next.id },
    { $set: { ...next, userId } },
    { upsert: true },
  );
  return next;
}

export async function patchUserTrigger(
  userId: string,
  triggerId: string,
  patch: Record<string, unknown>,
): Promise<UserTriggerRecord | null> {
  const existing = await getUserTrigger(userId, triggerId);
  if (!existing) return null;
  return upsertUserTrigger(userId, { ...existing, ...patch, id: triggerId });
}

export async function deleteUserTrigger(userId: string, triggerId: string): Promise<boolean> {
  await ensureIndexes();
  const c = await col();
  const result = await c.deleteOne({ userId, id: String(triggerId) });
  return result.deletedCount > 0;
}

/** Bulk upsert (e.g. one-time localStorage migration). */
export async function upsertUserTriggersBulk(
  userId: string,
  items: unknown[],
): Promise<UserTriggerRecord[]> {
  const out: UserTriggerRecord[] = [];
  for (const item of items) {
    const saved = await upsertUserTrigger(userId, item);
    if (saved) out.push(saved);
  }
  return out;
}
