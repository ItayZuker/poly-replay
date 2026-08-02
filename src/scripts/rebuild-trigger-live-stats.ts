/**
 * Audit + rebuild Market Trigger Trade stats from settled position cards only.
 *
 * Fake client-posted increments (no matching trading_stat_event) are dropped.
 * Real rows: trading_stat_events with card.source === "trigger" and card.triggerId.
 *
 * Usage:
 *   npx tsx src/scripts/rebuild-trigger-live-stats.ts           # dry-run
 *   npx tsx src/scripts/rebuild-trigger-live-stats.ts --apply   # write
 */
import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI?.trim();
if (!uri) {
  console.error("MONGODB_URI missing");
  process.exit(1);
}
const dbName = process.env.MONGODB_DB?.trim() || "poly_recorder";
const apply = process.argv.includes("--apply");

type Stats = {
  success: number;
  fail: number;
  blue: number;
  takeProfit: number;
  stopLoss: number;
  pnlUsd: number;
};

function emptyStats(): Stats {
  return { success: 0, fail: 0, blue: 0, takeProfit: 0, stopLoss: 0, pnlUsd: 0 };
}

function fmt(s: Stats): string {
  return `g${s.success}/b${s.blue}/r${s.fail} tp${s.takeProfit}/sl${s.stopLoss} pnl=${s.pnlUsd.toFixed(2)}`;
}

async function main(): Promise<void> {
  const client = new MongoClient(uri!);
  await client.connect();
  const db = client.db(dbName);
  const triggersCol = db.collection("triggers");
  const statsCol = db.collection("trigger_live_stats");
  const creditsCol = db.collection("trigger_live_stats_credits");
  const eventsCol = db.collection("trading_stat_events");
  const backupCol = db.collection(
    `trigger_live_stats_rebuild_backup_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
  );

  const triggers = await triggersCol.find({}).toArray();
  const statsDocs = await statsCol.find({}).toArray();
  const events = await eventsCol.find({ "card.source": "trigger" }).toArray();

  console.log(
    `Loaded ${triggers.length} trigger(s), ${statsDocs.length} stats doc(s), ${events.length} trigger-source event(s)`,
  );
  console.log(apply ? "MODE: APPLY" : "MODE: dry-run (pass --apply to write)");

  type Rebuild = {
    userId: string;
    triggerId: string;
    name: string;
    before: Stats;
    after: Stats;
    cardIds: string[];
    orphanedEvents: number;
  };

  const byKey = new Map<string, Rebuild>();
  for (const t of triggers) {
    const userId = String(t.userId || "");
    const triggerId = String(t.id || "");
    if (!userId || !triggerId) continue;
    const key = `${userId}:${triggerId}`;
    const existing = statsDocs.find(
      (d) => String(d.userId) === userId && String(d.triggerId) === triggerId,
    );
    byKey.set(key, {
      userId,
      triggerId,
      name: String(t.name || "Untitled"),
      before: {
        success: Number(existing?.success) || 0,
        fail: Number(existing?.fail) || 0,
        blue: Number(existing?.blue) || 0,
        takeProfit: Number(existing?.takeProfit) || 0,
        stopLoss: Number(existing?.stopLoss) || 0,
        pnlUsd: Number(existing?.pnlUsd) || 0,
      },
      after: emptyStats(),
      cardIds: [],
      orphanedEvents: 0,
    });
  }

  // Also include stats docs with no trigger record (deleted cards).
  for (const d of statsDocs) {
    const userId = String(d.userId || "");
    const triggerId = String(d.triggerId || "");
    const key = `${userId}:${triggerId}`;
    if (!userId || !triggerId || byKey.has(key)) continue;
    byKey.set(key, {
      userId,
      triggerId,
      name: "(deleted trigger)",
      before: {
        success: Number(d.success) || 0,
        fail: Number(d.fail) || 0,
        blue: Number(d.blue) || 0,
        takeProfit: Number(d.takeProfit) || 0,
        stopLoss: Number(d.stopLoss) || 0,
        pnlUsd: Number(d.pnlUsd) || 0,
      },
      after: emptyStats(),
      cardIds: [],
      orphanedEvents: 0,
    });
  }

  const triggersByUser = new Map<string, Array<{ id: string; name: string; createdAtMs: number }>>();
  for (const t of triggers) {
    const userId = String(t.userId || "");
    const id = String(t.id || "");
    if (!userId || !id) continue;
    const list = triggersByUser.get(userId) ?? [];
    list.push({
      id,
      name: String(t.name || "Untitled"),
      createdAtMs: Date.parse(String(t.createdAt || "")) || 0,
    });
    triggersByUser.set(userId, list);
  }

  /** Pre-1.37 cards lack triggerId — attribute when unambiguous for that user. */
  function resolveTriggerId(
    userId: string,
    cardTriggerId: string,
    buyAtSec: number,
  ): { triggerId: string; inferred: boolean } | null {
    if (cardTriggerId) return { triggerId: cardTriggerId, inferred: false };
    const list = triggersByUser.get(userId) ?? [];
    if (list.length === 1) return { triggerId: list[0].id, inferred: true };
    // Prefer the only trigger that already had Trade stats (typical single Trade card).
    const withStats = list.filter((t) => {
      const row = byKey.get(`${userId}:${t.id}`);
      if (!row) return false;
      return row.before.success + row.before.fail + row.before.blue > 0;
    });
    if (withStats.length === 1) return { triggerId: withStats[0].id, inferred: true };
    // Else: only triggers created at/before the buy.
    if (Number.isFinite(buyAtSec) && buyAtSec > 0) {
      const buyMs = buyAtSec * 1000;
      const existed = list.filter((t) => !t.createdAtMs || t.createdAtMs <= buyMs + 60_000);
      if (existed.length === 1) return { triggerId: existed[0].id, inferred: true };
    }
    return null;
  }

  let orphansNoTriggerId = 0;
  let inferredCount = 0;
  const creditRows: Array<{
    _id: string;
    userId: string;
    triggerId: string;
    cardId: string;
    result: "success" | "fail" | "blue";
    pnlUsd: number;
    exitReason: string | null;
    createdAt: string;
  }> = [];

  for (const e of events) {
    const userId = String(e.userId || "");
    const card = (e.card ?? {}) as Record<string, unknown>;
    const rawTriggerId = typeof card.triggerId === "string" ? card.triggerId.trim() : "";
    const cardId = String(e.cardId || e._id || "");
    if (!userId || !cardId) continue;

    const buyAtSec = Number(card.buyAt);
    const resolved = resolveTriggerId(userId, rawTriggerId, buyAtSec);
    if (!resolved) {
      orphansNoTriggerId += 1;
      continue;
    }
    const { triggerId } = resolved;
    if (resolved.inferred) inferredCount += 1;

    const key = `${userId}:${triggerId}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        userId,
        triggerId,
        name: "(no trigger doc)",
        before: emptyStats(),
        after: emptyStats(),
        cardIds: [],
        orphanedEvents: 0,
      };
      byKey.set(key, row);
    }

    const green = Number(e.green) || 0;
    const red = Number(e.red) || 0;
    const blue = Number(e.blue) || 0;
    const pnl = Number(e.pnl);
    const exitReason =
      card.triggerExitReason === "tp" || card.triggerExitReason === "sl"
        ? card.triggerExitReason
        : e.status === "win" || e.status === "loss"
          ? "window-end"
          : null;

    let result: "success" | "fail" | "blue";
    if (blue > 0) {
      result = "blue";
      row.after.blue += 1;
    } else if (green > 0) {
      result = "success";
      row.after.success += 1;
    } else {
      result = "fail";
      row.after.fail += 1;
    }
    if (exitReason === "tp") row.after.takeProfit += 1;
    if (exitReason === "sl") row.after.stopLoss += 1;
    if (Number.isFinite(pnl)) row.after.pnlUsd += pnl;
    row.cardIds.push(cardId);

    creditRows.push({
      _id: `${userId}:${cardId}`,
      userId,
      triggerId,
      cardId,
      result,
      pnlUsd: Number.isFinite(pnl) ? pnl : 0,
      exitReason,
      createdAt: new Date().toISOString(),
    });
  }

  console.log(
    `\nAttributed without stored triggerId (inferred): ${inferredCount}; still unattributed: ${orphansNoTriggerId}`,
  );
  console.log("\n=== Audit ===");

  let changed = 0;
  for (const row of [...byKey.values()].sort((a, b) =>
    `${a.name}:${a.triggerId}`.localeCompare(`${b.name}:${b.triggerId}`),
  )) {
    const same =
      row.before.success === row.after.success &&
      row.before.fail === row.after.fail &&
      row.before.blue === row.after.blue &&
      row.before.takeProfit === row.after.takeProfit &&
      row.before.stopLoss === row.after.stopLoss &&
      Math.abs(row.before.pnlUsd - row.after.pnlUsd) < 1e-9;
    const beforeEmpty =
      row.before.success +
        row.before.fail +
        row.before.blue +
        Math.abs(row.before.pnlUsd) <
      1e-9;
    const afterEmpty =
      row.after.success + row.after.fail + row.after.blue + Math.abs(row.after.pnlUsd) < 1e-9;
    if (same && beforeEmpty && afterEmpty) continue;

    const tag = same ? "OK" : "REBUILD";
    if (!same) changed += 1;
    console.log(
      `[${tag}] ${row.name} (${row.triggerId.slice(0, 8)}…) user=${row.userId.slice(0, 8)}…`,
    );
    console.log(`  before: ${fmt(row.before)}`);
    console.log(`  after:  ${fmt(row.after)}  from ${row.cardIds.length} settled card(s)`);
    if (!same) {
      const fakeSuccess = Math.max(0, row.before.success - row.after.success);
      const fakeFail = Math.max(0, row.before.fail - row.after.fail);
      const fakeBlue = Math.max(0, row.before.blue - row.after.blue);
      const fakePnl = row.before.pnlUsd - row.after.pnlUsd;
      if (fakeSuccess || fakeFail || fakeBlue || Math.abs(fakePnl) > 1e-6) {
        console.log(
          `  dropped (no matching card): g${fakeSuccess}/b${fakeBlue}/r${fakeFail} pnlΔ=${(-fakePnl).toFixed(2)} removed`,
        );
      }
    }
  }

  console.log(`\n${changed} trigger(s) would change.`);

  if (!apply) {
    console.log("Dry-run complete. Re-run with --apply to write.");
    await client.close();
    return;
  }

  const now = new Date().toISOString();
  for (const row of byKey.values()) {
    const statsId = `${row.userId}:${row.triggerId}`;
    const existing = await statsCol.findOne({ _id: statsId });
    if (existing) {
      await backupCol.replaceOne(
        { _id: statsId },
        { ...existing, rebuildBackupAt: now },
        { upsert: true },
      );
    }

    const afterEmpty =
      row.after.success + row.after.fail + row.after.blue + Math.abs(row.after.pnlUsd) < 1e-9;
    if (afterEmpty && !existing) continue;

    if (afterEmpty) {
      await statsCol.deleteOne({ _id: statsId, userId: row.userId });
    } else {
      await statsCol.replaceOne(
        { _id: statsId },
        {
          _id: statsId,
          userId: row.userId,
          triggerId: row.triggerId,
          success: row.after.success,
          fail: row.after.fail,
          blue: row.after.blue,
          takeProfit: row.after.takeProfit,
          stopLoss: row.after.stopLoss,
          pnlUsd: row.after.pnlUsd,
          updatedAt: now,
        },
        { upsert: true },
      );
    }
  }

  // Replace credits for rebuilt card ids (keep other users' credits untouched per user rewrite).
  const userIds = new Set([...byKey.values()].map((r) => r.userId));
  for (const userId of userIds) {
    await creditsCol.deleteMany({ userId });
  }
  if (creditRows.length > 0) {
    await creditsCol.insertMany(creditRows, { ordered: false }).catch((err: unknown) => {
      // Ignore duplicate key if re-run
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: number }).code === 11000
      ) {
        return;
      }
      throw err;
    });
  }

  console.log(
    `Applied. Backed up prior stats to ${backupCol.collectionName}; wrote ${creditRows.length} credit(s).`,
  );
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
