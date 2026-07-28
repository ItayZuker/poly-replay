/**
 * Create or promote the first Admin CRM user (shared Mongo users collection).
 *
 * Usage:
 *   npx tsx src/scripts/bootstrap-admin.ts <email> <password> [name]
 *
 * Or env (same as server first-boot):
 *   BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD
 *
 * Safe to re-run: sets password and admin=true on the email.
 * There is no open "register as admin" path — use this script or env bootstrap.
 */
import "dotenv/config";
import {
  bootstrapAdminUser,
  ensureDefaultUser,
  ensureUserIndexes,
} from "../db/user-repository.js";
import { closeMongoClient } from "../db/mongo-client.js";

async function main(): Promise<void> {
  const email = (process.argv[2] || process.env.BOOTSTRAP_ADMIN_EMAIL || "").trim();
  const password = process.argv[3] ?? process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
  const name = process.argv[4]?.trim();
  if (!email || password === "") {
    console.error(
      "Usage: npx tsx src/scripts/bootstrap-admin.ts <email> <password> [name]\n" +
        "   or: BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD",
    );
    process.exit(1);
  }
  if (password.length < 6) {
    console.error("Password must be at least 6 characters");
    process.exit(1);
  }

  await ensureUserIndexes();
  await ensureDefaultUser();
  const user = await bootstrapAdminUser({ email, password, name });
  console.log(
    `Admin ready: email=${user.email} id=${user.id} slug=${user.slug} admin=${user.admin}`,
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await closeMongoClient().catch(() => {});
  });
