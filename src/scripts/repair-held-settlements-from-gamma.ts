/**
 * Repair held win/loss trading_stat_events against Gamma payout (~1/~0) by slug.
 * Flips false wins → losses and false losses → wins; recomputes fee-aware held P/L.
 * Does not invent data — skips when Gamma is unresolved.
 *
 * Usage:
 *   npx tsx src/scripts/repair-held-settlements-from-gamma.ts           # dry-run
 *   npx tsx src/scripts/repair-held-settlements-from-gamma.ts --apply   # write
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
  const backup = db.collection(
    `trading_stat_events_gamma_repair_backup_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
  );

  const rows = await events
    .find({ status: { $in: ["win", "loss"] } })
    .toArray();
  console.log(`Loaded ${rows.length} held win/loss event(s)`);
  console.log(apply ? "MODE: APPLY" : "MODE: dry-run (pass --apply to write)");

  const outcomeCache = new Map<string, "up" | "down" | null>();
  let wouldFix = 0;
  let fixed = 0;
  let skippedNoSlug = 0;
  let skippedUnresolved = 0;
  let skippedOk = 0;
  let skippedBadCard = 0;
  let pnlDelta = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const e = rows[i]!;
    const card = (e.card ?? {}) as Record<string, unknown>;
    if (card.confirmed === false) {
      skippedBadCard += 1;
      continue;
    }
    const slug = typeof card.slug === "string" ? card.slug.trim() : "";
    const side = card.side === "up" || card.side === "down" ? card.side : null;
    if (!slug || !side) {
      skippedNoSlug += 1;
      continue;
    }

    let gamma = outcomeCache.get(slug);
    if (gamma === undefined) {
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
    }
    if (!gamma) {
      skippedUnresolved += 1;
      continue;
    }

    const shouldWin = side === gamma;
    const nextStatus = shouldWin ? "win" : "loss";
    const nextPl = heldPl(card, shouldWin);
    if (nextPl == null) {
      skippedBadCard += 1;
      continue;
    }

    const oldStatus = String(e.status);
    const oldPl = Number(e.pnl);
    const statusSame = oldStatus === nextStatus;
    const plSame = Number.isFinite(oldPl) && Math.abs(oldPl - nextPl) < 1e-6;
    const outcomeSame = String(card.outcome || "") === gamma;
    const dotsOk =
      shouldWin
        ? Number(e.blue) === 1 && Number(e.red) === 0 && Number(e.green) === 0
        : Number(e.red) === 1 && Number(e.blue) === 0 && Number(e.green) === 0;

    if (statusSame && plSame && outcomeSame && dotsOk) {
      skippedOk += 1;
      continue;
    }

    wouldFix += 1;
    const delta = nextPl - (Number.isFinite(oldPl) ? oldPl : 0);
    pnlDelta += delta;
    console.log(
      `[${apply ? "FIX" : "DRY"}] ${String(e.cardId || e._id).slice(0, 18)}…` +
        ` ${oldStatus}/${Number.isFinite(oldPl) ? oldPl.toFixed(2) : "?"} → ${nextStatus}/${nextPl.toFixed(2)}` +
        ` side=${side} gamma=${gamma} slug=${slug}`,
    );

    if (!apply) continue;

    await backup.replaceOne(
      { _id: e._id },
      {
        ...e,
        repairBackupAt: new Date().toISOString(),
        repairReason: "held-settlement-gamma-mismatch",
      },
      { upsert: true },
    );

    await events.updateOne(
      { _id: e._id },
      {
        $set: {
          status: nextStatus,
          green: 0,
          red: shouldWin ? 0 : 1,
          blue: shouldWin ? 1 : 0,
          pnl: nextPl,
          "card.status": nextStatus,
          "card.pl": nextPl,
          "card.outcome": gamma,
          "card.confirmed": true,
          updatedAt: new Date().toISOString(),
        },
      },
    );
    fixed += 1;
  }

  console.log(
    JSON.stringify({
      apply,
      wouldFix,
      fixed,
      skippedOk,
      skippedNoSlug,
      skippedUnresolved,
      skippedBadCard,
      pnlDelta: +pnlDelta.toFixed(4),
      uniqueSlugs: outcomeCache.size,
    }),
  );
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
