/**
 * Repair Trigger (and other) position cards where card.windowKey disagrees with
 * card.slug — usually from Trigger GTD harvest using the live window on cancel/roll.
 *
 * Aligns windowKey (+ series) to the slug market, then re-settles held win/loss
 * from Gamma on that slug. Also updates position_cards when present.
 *
 * Usage:
 *   npx tsx src/scripts/repair-slug-window-mismatch.ts           # dry-run
 *   npx tsx src/scripts/repair-slug-window-mismatch.ts --apply   # write
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { fetchOfficialWindowResolution } from "../official-window-resolution.js";
import { roundTo4 } from "../tick-compact.js";

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

function seriesFromUpDownSlug(slug: string): string | null {
  const m = String(slug || "")
    .trim()
    .toLowerCase()
    .match(/^([a-z]+)-updown-(5m|15m)-\d{9,}$/);
  return m ? `${m[1]}-${m[2]}` : null;
}

function windowStartFromKey(windowKey: string): number | null {
  const idx = String(windowKey || "").lastIndexOf(":");
  if (idx < 0) return null;
  const n = Number(String(windowKey).slice(idx + 1));
  return Number.isFinite(n) && n > 0 ? n : null;
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

  const eventRows = await events
    .find({
      "card.slug": { $type: "string" },
      "card.windowKey": { $type: "string" },
    })
    .toArray();

  const outcomeCache = new Map<string, "up" | "down" | null>();
  let eventWould = 0;
  let eventFixed = 0;
  let eventSkipped = 0;
  let flips = 0;
  let pnlDelta = 0;

  for (const e of eventRows) {
    const card = (e.card ?? {}) as Record<string, unknown>;
    const slug = typeof card.slug === "string" ? card.slug.trim() : "";
    const oldKey = typeof card.windowKey === "string" ? card.windowKey : "";
    const slugWs = windowStartFromUpDownSlug(slug);
    const keyWs = windowStartFromKey(oldKey);
    if (slugWs == null || keyWs == null || slugWs === keyWs) {
      eventSkipped += 1;
      continue;
    }

    const series =
      seriesFromUpDownSlug(slug) ||
      (typeof card.series === "string" && card.series.trim()
        ? card.series.trim().toLowerCase()
        : oldKey.split(":")[0] || "btc-5m");
    const nextKey = `${series}:${slugWs}`;
    const side = card.side === "up" || card.side === "down" ? card.side : null;
    const status = String(e.status || card.status || "");
    const isHeld = status === "win" || status === "loss" || status === "open";

    let gamma: "up" | "down" | null = null;
    if (isHeld && side) {
      gamma = outcomeCache.get(slug) ?? null;
      if (!outcomeCache.has(slug)) {
        try {
          const resolution = await fetchOfficialWindowResolution(slug);
          gamma =
            resolution?.outcome === "up" || resolution?.outcome === "down"
              ? resolution.outcome
              : null;
        } catch {
          gamma = null;
        }
        outcomeCache.set(slug, gamma);
        await sleep(DELAY_MS);
      } else {
        gamma = outcomeCache.get(slug) ?? null;
      }
    }

    let nextStatus = status;
    let nextPl = Number(e.pnl ?? card.pl);
    let nextOutcome = typeof card.outcome === "string" ? card.outcome : undefined;
    if (gamma && side && (status === "win" || status === "loss" || status === "open")) {
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
    eventWould += 1;
    if (statusFlip) flips += 1;
    if (Number.isFinite(nextPl) && Number.isFinite(oldPl)) {
      pnlDelta += nextPl - oldPl;
    }

    console.log(
      `[${apply ? "FIX" : "DRY"}] event ${String(e.cardId || e._id).slice(0, 20)}` +
        ` key ${oldKey} → ${nextKey}` +
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
        repairReason: "slug-window-mismatch",
      },
      { upsert: true },
    );

    const setDoc: Record<string, unknown> = {
      "card.windowKey": nextKey,
      "card.series": series,
      updatedAt: new Date().toISOString(),
    };
    if (gamma && side && (status === "win" || status === "loss" || status === "open")) {
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
      slug: { $type: "string" },
      windowKey: { $type: "string" },
    })
    .toArray();

  let cardWould = 0;
  let cardFixed = 0;

  for (const doc of cardRows) {
    const slug = typeof doc.slug === "string" ? doc.slug.trim() : "";
    const oldKey = typeof doc.windowKey === "string" ? doc.windowKey : "";
    const slugWs = windowStartFromUpDownSlug(slug);
    const keyWs = windowStartFromKey(oldKey);
    if (slugWs == null || keyWs == null || slugWs === keyWs) continue;

    const series =
      seriesFromUpDownSlug(slug) ||
      (typeof doc.series === "string" && doc.series.trim()
        ? doc.series.trim().toLowerCase()
        : oldKey.split(":")[0] || "btc-5m");
    const nextKey = `${series}:${slugWs}`;
    const side = doc.side === "up" || doc.side === "down" ? doc.side : null;
    const status = String(doc.status || "");

    let gamma: "up" | "down" | null = null;
    if (side && (status === "win" || status === "loss" || status === "open")) {
      if (!outcomeCache.has(slug)) {
        try {
          const resolution = await fetchOfficialWindowResolution(slug);
          gamma =
            resolution?.outcome === "up" || resolution?.outcome === "down"
              ? resolution.outcome
              : null;
        } catch {
          gamma = null;
        }
        outcomeCache.set(slug, gamma);
        await sleep(DELAY_MS);
      } else {
        gamma = outcomeCache.get(slug) ?? null;
      }
    }

    cardWould += 1;
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

    console.log(
      `[${apply ? "FIX" : "DRY"}] position_card ${String(doc.id || doc._id).slice(0, 20)}` +
        ` key ${oldKey} → ${nextKey}` +
        (nextStatus !== status ? ` ${status}→${nextStatus}` : ""),
    );

    if (!apply) continue;

    await cardsBackup.replaceOne(
      { _id: doc._id },
      {
        ...doc,
        repairBackupAt: new Date().toISOString(),
        repairReason: "slug-window-mismatch",
      },
      { upsert: true },
    );

    const $set: Record<string, unknown> = {
      windowKey: nextKey,
      series,
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
      uniqueSlugs: outcomeCache.size,
    }),
  );
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
