// node tests/setup.mjs
import assert from "node:assert/strict";
import { parseSetup } from "../setup.js";

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const good = { v: 1, s: "https://ntfy.sh/", q: "cd-req-x", r: "cd-res-y", k: "A".repeat(43) };
const want = { server: "https://ntfy.sh", req: "cd-req-x", res: "cd-res-y", key: "A".repeat(43) };

assert.deepEqual(parseSetup(enc(good)), want);
assert.deepEqual(parseSetup(`https://u.github.io/claude-dispatch-web/#setup=${enc(good)}`), want);
assert.deepEqual(parseSetup(`  https://u.github.io/p/#setup=${enc(good)}\n`), want);
assert.equal(parseSetup(enc({ ...good, v: 2 })), null);
assert.equal(parseSetup(enc({ ...good, s: "http://ntfy.sh" })), null);
assert.equal(parseSetup(enc({ ...good, r: "cd-req-x" })), null);
assert.equal(parseSetup(enc({ ...good, k: "short" })), null);
assert.equal(parseSetup("not a code!"), null);
assert.equal(parseSetup(""), null);
console.log("setup codes: ok");
