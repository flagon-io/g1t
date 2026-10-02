// Creates a user (or resets their password) in the remote D1 database and
// writes the generated password to the gitignored .credentials directory.
//
//   node scripts/create-user.mjs <username> [email]
import { execSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [username, email] = process.argv.slice(2);
if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(username ?? "")) {
  console.error("usage: node scripts/create-user.mjs <username> [email]");
  process.exit(1);
}
if (email && !/^[^\s'@]+@[^\s'@]+$/.test(email)) {
  console.error("invalid email");
  process.exit(1);
}

// Must match hashPassword in src/crypto.ts.
const iterations = 100_000;
const password = randomBytes(18).toString("base64url");
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
const stored = `pbkdf2$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}`;

const sqlFile = join(tmpdir(), `g1t-create-user-${process.pid}.sql`);
writeFileSync(
  sqlFile,
  `INSERT INTO users (id, username, email, password_hash)
   VALUES ('usr_' || lower(hex(randomblob(13))), '${username}', ${email ? `'${email}'` : "NULL"}, '${stored}')
   ON CONFLICT (username) DO UPDATE SET password_hash = excluded.password_hash;`,
);
try {
  execSync(`npx wrangler d1 execute g1t --remote --yes --file "${sqlFile}"`, {
    cwd: join(import.meta.dirname, ".."),
    stdio: ["ignore", "ignore", "inherit"],
  });
} finally {
  rmSync(sqlFile, { force: true });
}

const directory = join(import.meta.dirname, "../../../.credentials");
mkdirSync(directory, { recursive: true });
const file = join(directory, `${username}.txt`);
writeFileSync(file, `username: ${username}\npassword: ${password}\n`);
console.log(`Password for ${username} written to ${file}`);
