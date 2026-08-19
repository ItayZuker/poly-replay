/**
 * Repair held Positions where card.slug is a different 5m/15m market than
 * card.windowKey (rolled live slug). Keep windowKey (the window they traded),
 * rewrite slug to `{asset}-updown-{tf}-{windowStart}`, re-settle Win/Loss
 * from Gamma on that slug. Also re-checks held cards whose stored outcome
 * disagrees with that Gamma.
 *
 * Usage:
 *   npx tsx src/scripts/repair-slug-window-mismatch.ts           # dry-run
 *   npx tsx src/scripts/repair-slug-window-mismatch.ts --apply   # write
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { fetchOfficialWindowResolution } from "../official-window-resolution.js";
import { upDownSlugFromSeriesWindow } from "../market-pair.js";
import { roundTo4 } from "../tick-compact.js";
import { rebuildTriggerDemoStatsFromCards } from "../db/trigger-demo-stats-repository.js";
import type { TradingPositionCard } from "../types.js";

const uri = process.env.MONGODB_URI?.trim();
if (!uri) {
  console.error("MONGODB_URI missing");
  process.exit(1);
}
const dbName = process.env.MONGODB_DB?.trim() || "poly_recorder";
const apply = process.argv.includes("--apply");
const DELAY_MS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function windowStartFromUpDownSlug(slug: string): number | null {
  const m = String(slug || "")
    .trim()
    .toLowerCase()
    .match(/^[a-z]+-updown-(?:5m|15m)-(\d{9,})$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function windowStartFromKey(windowKey: string): number | null {
  const idx = String(windowKey || "").lastIndexOf(":");
  if (idx < 0) return null;
  const n = Number(String(windowKey).slice(idx + 1));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function seriesFromWindowKey(windowKey: string, fallback?: string): string {
  const idx = String(windowKey || "").lastIndexOf(":");
  const fromKey = idx > 0 ? String(windowKey).slice(0, idx).trim().toLowerCase() : "";
  if (fromKey) return fromKey;
  return String(fallback || "btc-5m")
    .trim()
    .toLowerCase();
}

function expectedSlugForCard(
  windowKey: string,
  seriesHint?: string,
): { series: string; windowStart: number; slug: string } | null {
  const windowStart = windowStartFromKey(windowKey);
  if (windowStart == null) return null;
  const series = seriesFromWindowKey(windowKey, seriesHint);
  const slug = upDownSlugFromSeriesWindow(series, windowStart);
  if (!slug) return null;
  return { series, windowStart, slug };
}

function heldPl(card: Record<string, unknown>, won: boolean): number | null {
  const shares = Number(card.shares);
  const buyCost = Number(card.buyCost);
  const buyFees = Number(card.buyFees ?? 0);
  if (!Number.isFinite(shares) || shares <= 0) return null;
  if (!Number.isFinite(buyCost) || buyCost < 0) return null;
  const fees = Number.isFinite(buyFees) ? buyFees : 0;
  const payout = won ? shares : 0;
  return roundTo4(payout - buyCost - fees);
}

async function gammaForSlug(
  slug: string,
  cache: Map<string, "up" | "down" | null>,
): Promise<"up" | "down" | null> {
  if (cache.has(slug)) return cache.get(slug) ?? null;
  let gamma: "up" | "down" | null = null;
  try {
    const resolution = await fetchOfficialWindowResolution(slug);
    gamma =
      resolution?.outcome === "up" || resolution?.outcome === "down"
        ? resolution.outcome
        : null;
  } catch {
    gamma = null;
  }
  cache.set(slug, gamma);
  await sleep(DELAY_MS);
  return gamma;
}

async function main(): Promise<void> {
  const client = new MongoClient(uri!);
  await client.connect();
  const db = client.db(dbName);
  const events = db.collection("trading_stat_events");
  const cardsCol = db.collection("position_cards");
  const backup = db.collection(
    `trading_stat_events_slug_window_backup_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
  );
  const cardsBackup = db.collection(
    `position_cards_slug_window_backup_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
  );

  console.log(apply ? "MODE: APPLY" : "MODE: dry-run (pass --apply to write)");
  console.log("Keep windowKey; rewrite slug to that window; re-settle held from Gamma.");

  const outcomeCache = new Map<string, "up" | "down" | null>();
  const rebuildDemo = new Map<string, { userId: string; triggerId: string }>();
  let eventWould = 0;
  let eventFixed = 0;
  let eventSkipped = 0;
  let flips = 0;
  let pnlDelta = 0;

  const eventRows = await events
    .find({
      "card.windowKey": { $type: "string" },
    })
    .toArray();

  for (const e of eventRows) {
    const card = (e.card ?? {}) as Record<string, unknown>;
    const oldKey = typeof card.windowKey === "string" ? card.windowKey : "";
    const expected = expectedSlugForCard(
      oldKey,
      typeof card.series === "string" ? card.series : undefined,
    );
    if (!expected) {
      eventSkipped += 1;
      continue;
    }
    const cardSlug = typeof card.slug === "string" ? card.slug.trim() : "";
    const slugMismatch = Boolean(cardSlug) && windowStartFromUpDownSlug(cardSlug) !== expected.windowStart;
    const status = String(e.status || card.status || "");
    const isHeld = status === "win" || status === "loss" || status === "open";
    const side = card.side === "up" || card.side === "down" ? card.side : null;
    if (!slugMismatch && !isHeld) {
      eventSkipped += 1;
      continue;
    }

    let gamma: "up" | "down" | null = null;
    if (isHeld && side) {
      gamma = await gammaForSlug(expected.slug, outcomeCache);
    }

    let nextStatus = status;
    let nextPl = Number(e.pnl ?? card.pl);
    let nextOutcome = typeof card.outcome === "string" ? card.outcome : undefined;
    if (gamma && side && isHeld) {
      const shouldWin = side === gamma;
      const pl = heldPl(card, shouldWin);
      if (pl != null) {
        nextStatus = shouldWin ? "win" : "loss";
        nextPl = pl;
        nextOutcome = gamma;
      }
    }

    const oldPl = Number(e.pnl ?? card.pl);
    const statusFlip = status !== nextStatus && (status === "win" || status === "loss");
    const slugChange = cardSlug !== expected.slug;
    if (!slugChange && !statusFlip && status === nextStatus) {
      eventSkipped += 1;
      continue;
    }

    eventWould += 1;
    if (statusFlip) flips += 1;
    if (Number.isFinite(nextPl) && Number.isFinite(oldPl)) {
      pnlDelta += nextPl - oldPl;
    }

    console.log(
      `[${apply ? "FIX" : "DRY"}] event ${String(e.cardId || e._id).slice(0, 24)}` +
        ` key ${oldKey}` +
        (slugChange ? ` slug ${cardSlug || "—"} → ${expected.slug}` : "") +
        ` ${status}` +
        (nextStatus !== status ? ` → ${nextStatus}` : "") +
        (Number.isFinite(oldPl) && Number.isFinite(nextPl) && Math.abs(oldPl - nextPl) > 1e-6
          ? ` pnl ${oldPl.toFixed(2)}→${nextPl.toFixed(2)}`
          : "") +
        (gamma ? ` gamma=${gamma}` : ""),
    );

    if (!apply) continue;

    await backup.replaceOne(
      { _id: e._id },
      {
        ...e,
        repairBackupAt: new Date().toISOString(),
        repairReason: "slug-aligned-to-windowKey",
      },
      { upsert: true },
    );

    const setDoc: Record<string, unknown> = {
      "card.slug": expected.slug,
      "card.series": expected.series,
      "card.windowKey": oldKey,
      updatedAt: new Date().toISOString(),
    };
    if (gamma && side && isHeld) {
      const shouldWin = side === gamma;
      setDoc.status = nextStatus;
      setDoc.pnl = nextPl;
      setDoc.green = 0;
      setDoc.red = shouldWin ? 0 : 1;
      setDoc.blue = shouldWin ? 1 : 0;
      setDoc["card.status"] = nextStatus;
      setDoc["card.pl"] = nextPl;
      setDoc["card.outcome"] = nextOutcome;
      setDoc["card.confirmed"] = true;
    }

    await events.updateOne({ _id: e._id }, { $set: setDoc });
    eventFixed += 1;
  }

  const cardRows = await cardsCol
    .find({
      windowKey: { $type: "string" },
    })
    .toArray();

  let cardWould = 0;
  let cardFixed = 0;

  for (const doc of cardRows) {
    const oldKey = typeof doc.windowKey === "string" ? doc.windowKey : "";
    const expected = expectedSlugForCard(
      oldKey,
      typeof doc.series === "string" ? doc.series : undefined,
    );
    if (!expected) continue;
    const cardSlug = typeof doc.slug === "string" ? doc.slug.trim() : "";
    const slugMismatch = Boolean(cardSlug) && windowStartFromUpDownSlug(cardSlug) !== expected.windowStart;
    const status = String(doc.status || "");
    const isHeld = status === "win" || status === "loss" || status === "open";
    const side = doc.side === "up" || doc.side === "down" ? doc.side : null;
    if (!slugMismatch && !isHeld) continue;

    let gamma: "up" | "down" | null = null;
    if (side && isHeld) {
      gamma = await gammaForSlug(expected.slug, outcomeCache);
    }

    let nextStatus = status;
    let nextPl = Number(doc.pl);
    let nextOutcome = doc.outcome;
    if (gamma && side) {
      const shouldWin = side === gamma;
      const pl = heldPl(doc as Record<string, unknown>, shouldWin);
      if (pl != null) {
        nextStatus = shouldWin ? "win" : "loss";
        nextPl = pl;
        nextOutcome = gamma;
      }
    }

    const statusFlip = status !== nextStatus;
    const slugChange = cardSlug !== expected.slug;
    if (!slugChange && !statusFlip) continue;

    cardWould += 1;
    if (statusFlip && (status === "win" || status === "loss")) flips += 1;

    console.log(
      `[${apply ? "FIX" : "DRY"}] position_card ${String(doc.id || doc._id).slice(0, 28)}` +
        ` key ${oldKey}` +
        (slugChange ? ` slug → ${expected.slug}` : "") +
        (statusFlip ? ` ${status}→${nextStatus}` : ""),
    );

    if (!apply) continue;

    await cardsBackup.replaceOne(
      { _id: doc._id },
      {
        ...doc,
        repairBackupAt: new Date().toISOString(),
        repairReason: "slug-aligned-to-windowKey",
      },
      { upsert: true },
    );

    const $set: Record<string, unknown> = {
      slug: expected.slug,
      series: expected.series,
      updatedAt: new Date().toISOString(),
    };
    if (gamma && side) {
      $set.status = nextStatus;
      $set.pl = nextPl;
      $set.outcome = nextOutcome;
      $set.confirmed = true;
    }
    await cardsCol.updateOne({ _id: doc._id }, { $set });
    cardFixed += 1;

    const tid = typeof doc.triggerId === "string" ? doc.triggerId.trim() : "";
    const uid = typeof doc.userId === "string" ? doc.userId.trim() : "";
    const isDemo = doc.demo === true || String(doc.id || "").startsWith("demo:");
    if (tid && uid && isDemo && statusFlip) {
      rebuildDemo.set(`${uid}:${tid}`, { userId: uid, triggerId: tid });
    }
  }

  let demoRebuilt = 0;
  if (apply && rebuildDemo.size > 0) {
    for (const { userId, triggerId } of rebuildDemo.values()) {
      const docs = await cardsCol
        .find({ userId, triggerId, $or: [{ demo: true }, { id: { $regex: `^demo:${triggerId}:` } }] })
        .toArray();
      const cards = docs as unknown as TradingPositionCard[];
      await rebuildTriggerDemoStatsFromCards(userId, triggerId, cards);
      demoRebuilt += 1;
      console.log(`Rebuilt Demo stats for trigger ${triggerId.slice(0, 12)}… (${cards.length} cards)`);
    }
  }

  console.log(
    JSON.stringify({
      apply,
      eventWould,
      eventFixed,
      eventSkippedOkOrNparse: eventSkipped,
      flips,
      pnlDelta: +pnlDelta.toFixed(4),
      cardWould,
      cardFixed,
      demoTriggersRebuilt: demoRebuilt,
      uniqueSlugs: outcomeCache.size,
    }),
  );
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
