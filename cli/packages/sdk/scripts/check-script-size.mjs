// Fails when dist/script.js is over 2,000 bytes gzipped.
// Customers compare it with Umami's script, about 2 KB.
// Run `npm run build` first.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

const LIMIT = 2000;

const here = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(join(here, "..", "dist", "script.js"));
const gzipped = gzipSync(bytes, { level: 9 }).length;

console.log(`[dif] dist/script.js: ${bytes.length} bytes, ${gzipped} gzipped (limit ${LIMIT})`);
if (gzipped > LIMIT) {
  console.error(`[dif] dist/script.js is ${gzipped - LIMIT} bytes over the ${LIMIT}-byte gzipped limit`);
  process.exit(1);
}
