// node tests/command.mjs
import assert from "node:assert/strict";
import { parseCommand } from "../command.js";

const machines = [
  { machine: "box-1", works: ["alpha", "shared"] },
  { machine: "box-2", works: ["beta", "shared"] },
];

assert.deepEqual(parseCommand("/ship ABC-123 alpha", machines), { prompt: "/ship ABC-123", work: "alpha", target: "" });
assert.deepEqual(parseCommand("/ship ABC-123 alpha @box-1", machines), { prompt: "/ship ABC-123", work: "alpha", target: "box-1" });
assert.deepEqual(parseCommand("  fix  the   bug  beta ", machines), { prompt: "fix the bug", work: "beta", target: "" });
assert.match(parseCommand("alpha", machines).error, /Format/);
assert.match(parseCommand("/ship X nope", machines).error, /No machine/);
assert.match(parseCommand("/ship X alpha @box-2", machines).error, /does not have/);
assert.match(parseCommand("/ship X alpha @zzz", machines).error, /Unknown machine/);
const multi = parseCommand("/ship X shared", machines);
assert.deepEqual(multi.choices, ["box-1", "box-2"]);
assert.equal(parseCommand("/ship X shared @box-2", machines).error, undefined);
assert.equal(parseCommand("/ship X anything", []).error, undefined);
console.log("command parsing: ok");
