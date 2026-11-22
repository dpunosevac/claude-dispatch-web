// node tests/command.mjs
import assert from "node:assert/strict";
import { parseCommand, suggest } from "../command.js";

const machines = [
  { machine: "box-1", works: ["alpha", "shared"] },
  { machine: "box-2", works: ["beta", "shared"] },
];

// <laptop> <repo> <anything>
assert.deepEqual(parseCommand("box-1 alpha /ship ABC-123", machines), { target: "box-1", work: "alpha", prompt: "/ship ABC-123" });
assert.deepEqual(parseCommand("@box-2 shared fix it, then @mention people & run tests", machines), {
  target: "box-2",
  work: "shared",
  prompt: "fix it, then @mention people & run tests",
});
assert.equal(parseCommand("box-1 alpha line one\n  line two", machines).prompt, "line one\n  line two");
assert.equal(parseCommand("BOX-1 alpha x", machines).target, "box-1");
assert.match(parseCommand("box-1 beta x", machines).error, /has no repo "beta"\. It has: alpha, shared/);
assert.match(parseCommand("box-1 alpha", machines).error, /what Claude should do/);
assert.match(parseCommand("box-1", machines).error, /Pick a repo/);
assert.match(parseCommand("", machines).error, /laptop repo/);
assert.match(parseCommand("nope alpha x", machines).error, /not a laptop or a repo/);

// shorthand <repo> <anything>
assert.deepEqual(parseCommand("beta deploy now", machines), { target: "box-2", work: "beta", prompt: "deploy now" });
const multi = parseCommand("shared deploy now", machines);
assert.deepEqual(multi.choices, ["box-1", "box-2"]);
assert.equal(multi.prompt, "deploy now");

// no hello yet: trust the format
assert.deepEqual(parseCommand("m1 repo do it", []), { target: "m1", work: "repo", prompt: "do it" });

// suggestions
assert.deepEqual(suggest("", machines), { kind: "machine", items: ["box-1", "box-2"], prefix: "" });
assert.deepEqual(suggest("box-2", machines).items, ["box-2"]);
assert.deepEqual(suggest("box-1 ", machines), { kind: "repo", items: ["alpha", "shared"], prefix: "box-1 " });
assert.deepEqual(suggest("box-1 sh", machines).items, ["shared"]);
assert.equal(suggest("box-1 alpha ", machines).kind, null);
assert.equal(suggest("box-1 alpha do", machines).kind, null);
assert.equal(suggest("beta deploy", machines).kind, null);
assert.equal(suggest("", []).kind, null);
console.log("command parsing: ok");
