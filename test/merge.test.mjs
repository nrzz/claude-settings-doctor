// The merge: highest precedence wins a value, objects merge key by key, lists are joined, and every entry says
// where it came from and what it shadows.
import { world } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { entriesUnder, merge } from "../src/merge.mjs";
import { buildShow } from "../src/commands.mjs";

const src = (scope, rank) => ({ scope, rank, display: scope });
const user = src("user", 10);
const project = src("project", 20);
const local = src("local", 30);
const managed = src("managed", 40);

test("a plain value: the highest precedence wins, and the others are listed as shadowed, lowest last", () => {
  const m = merge([{ source: local, data: { model: "l" } }, { source: user, data: { model: "u" } }, { source: project, data: { model: "p" } }]);
  assert.equal(m.tree.model, "l");
  const e = m.entries.find((x) => x.path.join(".") === "model");
  assert.equal(e.source.scope, "local");
  assert.deepEqual(e.shadowed.map((s) => [s.source.scope, s.value]), [["project", "p"], ["user", "u"]]);
});

test("the order the files are given in does not matter, only their rank", () => {
  const a = merge([{ source: user, data: { x: 1 } }, { source: managed, data: { x: 2 } }, { source: project, data: { x: 3 } }]);
  const b = merge([{ source: managed, data: { x: 2 } }, { source: project, data: { x: 3 } }, { source: user, data: { x: 1 } }]);
  assert.equal(a.tree.x, 2);
  assert.deepEqual(a.tree, b.tree);
});

test("objects merge key by key: every file's keys arrive, and the highest wins each one", () => {
  const m = merge([
    { source: user, data: { env: { FOO: "u", ONLYUSER: "1" } } },
    { source: project, data: { env: { FOO: "p", ONLYPROJECT: "2" } } },
    { source: local, data: { env: { FOO: "l", ONLYLOCAL: "3" } } },
  ]);
  assert.deepEqual(m.tree.env, { FOO: "l", ONLYUSER: "1", ONLYPROJECT: "2", ONLYLOCAL: "3" });
  const sourceOf = (k) => m.entries.find((e) => e.path.join(".") === `env.${k}`).source.scope;
  assert.equal(sourceOf("FOO"), "local");
  assert.equal(sourceOf("ONLYUSER"), "user");
  assert.equal(sourceOf("ONLYPROJECT"), "project");
  assert.equal(sourceOf("ONLYLOCAL"), "local");
});

test("lists are joined across files, each item keeps its file, and a repeated item is kept once", () => {
  const m = merge([
    { source: user, data: { permissions: { allow: ["Bash(a)", "Bash(b)"] } } },
    { source: project, data: { permissions: { allow: ["Bash(b)", "Bash(c)"] } } },
  ]);
  assert.deepEqual(m.tree.permissions.allow, ["Bash(a)", "Bash(b)", "Bash(c)"]);
  const e = m.entries.find((x) => x.path.join(".") === "permissions.allow");
  assert.deepEqual(e.items.map((i) => [i.value, i.source.scope]), [["Bash(a)", "user"], ["Bash(b)", "user"], ["Bash(c)", "project"]]);
  assert.deepEqual(e.items[1].also.map((s) => s.scope), ["project"], "the project file has it too");
});

test("the hooks of an event from every file are kept: they are items of a list", () => {
  const g = (c) => ({ hooks: [{ type: "command", command: c }] });
  const m = merge([
    { source: user, data: { hooks: { SessionStart: [g("a")], Stop: [g("s")] } } },
    { source: project, data: { hooks: { SessionStart: [g("b")] } } },
  ]);
  assert.equal(m.tree.hooks.SessionStart.length, 2);
  assert.equal(m.tree.hooks.Stop.length, 1);
  const e = m.entries.find((x) => x.path.join(".") === "hooks.SessionStart");
  assert.deepEqual(e.items.map((i) => i.source.scope), ["user", "project"]);
});

test("a value of another type replaces what was there, and what it replaced is shadowed", () => {
  const m = merge([{ source: user, data: { x: { a: 1 } } }, { source: project, data: { x: "s" } }]);
  assert.equal(m.tree.x, "s");
  const e = m.entries.find((i) => i.path.join(".") === "x");
  assert.equal(e.source.scope, "project");
  assert.equal(e.shadowed.length, 1);
  const n = merge([{ source: user, data: { x: "s" } }, { source: project, data: { x: ["a"] } }]);
  assert.deepEqual(n.tree.x, ["a"]);
  const o = merge([{ source: user, data: { x: [1] } }, { source: project, data: { x: { b: 2 } } }]);
  assert.deepEqual(o.tree.x, { b: 2 });
});

test("empty objects and lists stay as entries; files with no data are skipped", () => {
  const m = merge([{ source: user, data: { a: {}, b: [], c: null } }, { source: project, data: null }]);
  assert.deepEqual(m.tree, { a: {}, b: [], c: null });
  assert.deepEqual(m.entries.map((e) => e.path.join(".")).sort(), ["a", "b", "c"]);
  assert.deepEqual(merge([]).tree, {});
  assert.deepEqual(merge([{ source: user, data: [1] }]).tree, {}, "not an object: not merged");
});

test("a key called __proto__ merges as a key and pollutes nothing", () => {
  const data = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
  const m = merge([{ source: user, data }, { source: project, data: JSON.parse('{"__proto__": {"other": 1}}') }]);
  assert.equal({}.polluted, undefined);
  assert.equal({}.other, undefined);
  assert.equal(Object.getPrototypeOf(m.tree), Object.prototype);
  assert.deepEqual(Object.keys(m.tree).sort(), ["__proto__", "a"]);
  assert.deepEqual(m.tree.__proto__, { polluted: true, other: 1 });
});

test("entriesUnder picks the entries at or below a key path", () => {
  const m = merge([{ source: user, data: { env: { A: "1", B: "2" }, model: "m" } }]);
  assert.deepEqual(entriesUnder(m.entries, ["env"]).map((e) => e.path.join(".")), ["env.A", "env.B"]);
  assert.deepEqual(entriesUnder(m.entries, ["env", "A"]).map((e) => e.path.join(".")), ["env.A"]);
  assert.deepEqual(entriesUnder(m.entries, []).length, 3);
  assert.deepEqual(entriesUnder(m.entries, ["nope"]), []);
});

test("random files: the merge equals a plain deep merge written the obvious way, and keeps every source", () => {
  let seed = 4242;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const value = (d) => {
    const r = rnd();
    if (d > 2 || r < 0.4) return ["a", "b", 1, 2, true, null][Math.floor(rnd() * 6)];
    if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 3) }, () => ["x", "y", "z", 1][Math.floor(rnd() * 4)]);
    const o = {};
    for (let k = Math.floor(rnd() * 3); k > 0; k--) o[`k${Math.floor(rnd() * 4)}`] = value(d + 1);
    return o;
  };
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const dedupe = (list) => { const out = []; for (const x of list) if (!out.some((y) => JSON.stringify(y) === JSON.stringify(x))) out.push(x); return out; };
  // an array never keeps a repeated item, wherever it sits
  const norm = (v) => (Array.isArray(v) ? dedupe(v.map(norm)) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v);
  const plain = (a, b) => {
    if (isObj(a) && isObj(b)) { const out = { ...a }; for (const [k, v] of Object.entries(b)) out[k] = k in a ? plain(a[k], v) : norm(v); return out; }
    if (Array.isArray(a) && Array.isArray(b)) return dedupe([...a, ...b].map(norm));
    return norm(b);
  };
  for (let n = 0; n < 300; n++) {
    const files = [user, project, local].map((s) => ({ source: s, data: { a: value(0), b: value(0), c: value(0) } }));
    const expected = files.reduce((acc, f) => plain(acc, f.data), {});
    assert.deepEqual(merge(files).tree, expected, JSON.stringify(files.map((f) => f.data)));
  }
});

// ---- through show: the same rules, read from real files ---------------------------------------------------------

test("show merges the files it reads, names the winner of each key and skips a file Claude Code ignores", () => {
  const w = world("show");
  w.user({ model: "u", env: { FOO: "u" }, permissions: { allow: ["Bash(a)"] } });
  w.project({ model: "p", env: { FOO: "p", BAR: "p" }, permissions: { allow: ["Bash(b)"] } });
  w.local('{\n// a comment makes Claude Code ignore this file\n"model": "l"}');
  const m = buildShow({ project: w.work, env: w.env, home: w.home, managed: w.managedDir });
  assert.equal(m.tree.model, "p");
  assert.deepEqual(m.tree.env, { FOO: "p", BAR: "p" });
  assert.deepEqual(m.tree.permissions.allow, ["Bash(a)", "Bash(b)"]);
  const local = m.files.find((f) => f.scope === "local");
  assert.equal(local.state, "ignored by Claude Code");
  assert.equal(local.detail, "it has a comment");
  const model = m.entries.find((e) => e.path === "model");
  assert.equal(model.source.scope, "project");
  assert.deepEqual(model.shadowed.map((s) => s.value), ["u"]);
  assert.equal(m.counts.shadowed, 2);
  assert.ok(m.notRead.length >= 3);
  assert.equal(m.schema.downloaded.length, 10);
});

test("show reads env values as Claude Code does: as strings; and without what Claude Code drops", () => {
  const w = world("show2");
  w.user({ env: { N: 1 }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "ok" }, { type: "command", command: "bad", timeout: "10" }] }] } });
  const m = buildShow({ project: w.work, env: w.env, home: w.home, managed: w.managedDir });
  assert.deepEqual(m.tree.env, { N: "1" });
  assert.equal(m.tree.hooks.SessionStart[0].hooks.length, 1);
  assert.equal(m.files.find((f) => f.scope === "user").detail, "1 part dropped by Claude Code, 1 env value turned into strings");
});

test("show with no files at all: nothing is set, nothing fails", () => {
  const w = world("show3");
  const m = buildShow({ project: w.work, env: w.env, home: w.home, managed: w.managedDir });
  assert.deepEqual(m.tree, {});
  assert.deepEqual(m.entries, []);
  assert.ok(m.files.every((f) => f.state === "not found"));
});
