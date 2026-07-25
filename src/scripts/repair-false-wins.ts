/**
 * Flip confirmed "win" rows that Polymarket still shows as worthless redeemable
 * holdings (curPrice ~ 0) into correct losses, and recompute Market totals.
 *
 * Usage: npx tsx src/scripts/repair-false-wins.ts
 */
import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI?.trim();
if (!uri) {
  console.error("MONGODB_URI missing");
  process.exit(1);
}
const dbName = process.env.MONGODB_DB?.trim() || "poly_recorder";

async function fetchPositions(user: string) {
  const out: Array<Record<string, unknown>> = [];
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({
      user,
      limit: "50",
      offset: String(offset),
      sizeThreshold: "0",
    });
    const res = await fetch(`https://data-api.polymarket.com/positions?${params}`);
    if (!res.ok) throw new Error(`positions ${res.status}`);
    const batch = (await res.json()) as unknown;
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...(batch as Array<Record<string, unknown>>));
    if (batch.length < 50) break;
    offset += batch.length;
  }
  return out;
}

async function main(): Promise<void> {
  const client = new MongoClient(uri!);
  await client.connect();
  const db = client.db(dbName);
  const users = db.collection("users");
  const events = db.collection("trading_stat_events");
  const backup = db.collection("trading_stat_events_false_win_backup");

  const user = await users.findOne({});
  const funder =
    String(user?.wallet?.funderAddress || process.env.FUNDER_ADDRESS || "").trim();
  if (!funder) {
    console.error("No funder address");
    process.exit(1);
  }

  const positions = await fetchPositions(funder);
  const lossByCondition = new Map<string, { cashPnl: number; size: number; curPrice: number }>();
  for (const p of positions) {
    const ck = String(p.conditionId || "");
    const cur = Number(p.curPrice);
    const size = Number(p.size);
    if (!ck || !Number.isFinite(cur) || !Number.isFinite(size)) continue;
    // Worthless resolved token still sitting as redeemable = loss.
    if (p.redeemable === true && cur <= 0.02 && size > 0) {
      lossByCondition.set(ck, {
        cashPnl: Number(p.cashPnl) || 0,
        size,
        curPrice: cur,
      });
    }
  }
  console.log("loss-like redeemable conditions:", lossByCondition.size);

  const rows = await events.find({ status: "win" }).toArray();
  let fixed = 0;
  let pnlDelta = 0;

  for (const e of rows) {
    const card = (e.card ?? {}) as Record<string, unknown>;
    if (card.confirmed === false) continue;
    const ck = String(card.conditionId || "");
    const pm = lossByCondition.get(ck);
    if (!pm) continue;

    const buyCost = Number(card.buyCost);
    const buyFees = Number(card.buyFees ?? 0);
    const shares = Number(card.shares);
    const oldPl = Number(e.pnl);
    if (!Number.isFinite(buyCost) || !Number.isFinite(shares) || !Number.isFinite(oldPl)) continue;

    const nextPl = 0 - buyCost - (Number.isFinite(buyFees) ? buyFees : 0);
    const side = String(card.side || "");
    const outcome = side === "up" ? "down" : side === "down" ? "up" : side;

    await backup.replaceOne(
      { _id: e._id },
      {
        ...e,
        repairBackupAt: new Date().toISOString(),
        repairReason: "false-win-redeemable-loss",
      },
      { upsert: true },
    );

    await events.updateOne(
      { _id: e._id },
      {
        $set: {
          status: "loss",
          green: 0,
          red: 1,
          blue: 0,
          pnl: nextPl,
          "card.status": "loss",
          "card.pl": nextPl,
          "card.outcome": outcome,
          "card.confirmed": true,
          updatedAt: new Date().toISOString(),
        },
      },
    );

    fixed += 1;
    pnlDelta += nextPl - oldPl;
    console.log(
      `fixed ${String(e.cardId).slice(0, 12)}… ${oldPl.toFixed(2)} → ${nextPl.toFixed(2)} (pm cur=${pm.curPrice})`,
    );
  }

  const after = await events.find({}).toArray();
  const ids = new Set<string>();
  let marketPnl = 0;
  for (const e of after) {
    const card = (e.card ?? {}) as Record<string, unknown>;
    if (card.confirmed === false) continue;
    const key =
      card.conditionId && card.asset && Number.isFinite(Number(card.buyAt))
        ? `${card.conditionId}|${card.asset}|${card.buyAt}`
        : `id:${e.cardId}`;
    if (ids.has(key)) continue;
    ids.add(key);
    const pl = Number(e.pnl);
    if (!Number.isFinite(pl)) continue;
    if (e.status === "sold" || e.status === "win" || e.status === "loss") marketPnl += pl;
  }

  console.log(JSON.stringify({ fixed, pnlDelta: +pnlDelta.toFixed(4), marketPnl: +marketPnl.toFixed(4) }));
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
