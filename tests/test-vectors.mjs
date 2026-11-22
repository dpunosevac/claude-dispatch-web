// node tests/test-vectors.mjs
// Checks crypto.js against the canonical vectors shared with the Rust listener.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { importKey, seal, openText, open, gunzip, b64decode, AAD, request } from "../crypto.js";

const vectors = JSON.parse(await readFile(new URL("./test-vectors.json", import.meta.url), "utf8"));
const key = await importKey(vectors.key);
let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`ok   ${name}`);
};

for (const c of vectors.vectors) {
  assert.equal(c.aad, AAD[c.dir], `${c.name}: aad`);
  const pt = await openText(key, c.dir, JSON.stringify(c.envelope));
  assert.equal(pt, c.plaintext, `${c.name}: open`);
  const gz = new TextDecoder().decode(await gunzip(b64decode(c.gzip_b64)));
  assert.equal(gz, c.plaintext, `${c.name}: gunzip`);
  ok(`open ${c.name} (${c.source})`);
}

for (const c of vectors.negative) {
  const k = c.key ? await importKey(c.key) : key;
  assert.equal(await openText(k, c.open_as, JSON.stringify(c.envelope)), null, c.name);
  ok(`reject ${c.name}`);
}

for (const dir of ["req", "res"]) {
  const msg = request("run", { job: "abcd1234", work: "demo", prompt: "x".repeat(200_000) + " ✓" });
  const env = await seal(key, dir, msg);
  assert.deepEqual(await open(key, dir, env), msg);
  assert.equal(await open(key, dir === "req" ? "res" : "req", env), null);
  ok(`round trip ${dir} (200 KB)`);
}

assert.equal(await open(key, "res", "not json"), null);
assert.equal(await open(key, "res", '{"v":1,"d":"res","iv":"AAAA","ct":"AAAA"}'), null);
ok("garbage is dropped");

// Prints a JS-sealed vector to append to protocol/test-vectors.json in the private repo.
if (process.argv.includes("--emit")) {
  const plaintext = '{"id":"5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a","ts":1767225700,"type":"reply","from":"phone","job":"a1b2c3d4","text":"Use staging — ok?"}';
  const iv = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i);
  const { gzip, b64encode } = await import("../crypto.js");
  const envelope = JSON.parse(await seal(key, "req", plaintext, iv));
  const gzip_b64 = b64encode(await gzip(new TextEncoder().encode(plaintext)));
  console.log(JSON.stringify({ name: "req_reply_js", source: "js", dir: "req", aad: AAD.req, iv_b64: b64encode(iv), plaintext, gzip_b64, envelope }, null, 2));
}

console.log(`\n${passed} passed`);
