// absorb: what Claude Code (or you) changed in settings.json, put back into settings.jsonc with its comments.
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { absorb } from "../src/absorb.mjs";
import { buildFromJsonc } from "../src/build.mjs";
import { diffValues, same } from "../src/diff.mjs";
import { parseJsonc, toValue } from "../src/jsonc.mjs";
import { mutate, pick, randomValue, render, rng } from "./gen.mjs";

const J = (v) => `${JSON.stringify(v, null, 2)}\n`;
const run = (jsonc, now, base) => absorb({ jsoncText: jsonc, jsonText: typeof now === "string" ? now : J(now), baselineText: base === null ? null : typeof base === "string" ? base : J(base) });
const ops = (list) => list.map((x) => `${x.op.op} ${x.op.path.join(".")}`);

const JSONC = '{\n  // my model\n  "model": "opus", // pick\n  "permissions": {\n    // what I allow\n    "allow": [\n      "Bash(ls)", // list\n      "Bash(pwd)"\n    ]\n  },\n  "env": {\n    "A": "1"\n  }\n}\n';
const BASE = { model: "opus", permissions: { allow: ["Bash(ls)", "Bash(pwd)"] }, env: { A: "1" } };

test("what Claude Code added goes in: a rule on a list, a key in an object, a new key; every comment stays", () => {
  const now = { model: "opus", permissions: { allow: ["Bash(ls)", "Bash(pwd)", "Bash(git status)"] }, env: { A: "1", B: "2" }, theme: "dark" };
  const r = run(JSONC, now, BASE);
  assert.equal(r.ok, true);
  assert.deepEqual(ops(r.applied).sort(), ["add env.B", "add theme", "item-add permissions.allow"]);
  assert.equal(r.text, '{\n  // my model\n  "model": "opus", // pick\n  "permissions": {\n    // what I allow\n    "allow": [\n      "Bash(ls)", // list\n      "Bash(pwd)",\n      "Bash(git status)"\n    ]\n  },\n  "env": {\n    "A": "1",\n    "B": "2"\n  },\n  "theme": "dark"\n}\n');
  assert.equal(r.pending, 0);
  assert.deepEqual(r.conflicts, []);
});

test("a list that is not there yet is made, next to the one that is", () => {
  const r = run(JSONC, { ...BASE, permissions: { allow: ["Bash(ls)", "Bash(pwd)"], deny: ["Read(./.env)"] } }, BASE);
  assert.deepEqual(ops(r.applied), ["add permissions.deny"]);
  assert.equal(r.text, '{\n  // my model\n  "model": "opus", // pick\n  "permissions": {\n    // what I allow\n    "allow": [\n      "Bash(ls)", // list\n      "Bash(pwd)"\n    ],\n    "deny": [\n      "Read(./.env)"\n    ]\n  },\n  "env": {\n    "A": "1"\n  }\n}\n');
});

test("a value that /config changed is changed, and the comment after it stays", () => {
  const r = run(JSONC, { ...BASE, model: "sonnet" }, BASE);
  assert.deepEqual(ops(r.applied), ["change model"]);
  assert.match(r.text, /"model": "sonnet", \/\/ pick\n/);
  assert.match(r.text, /^\{\n  \/\/ my model\n/);
});

test("a key and a rule that were taken out of settings.json are taken out, with the comments above them", () => {
  const now = { model: "opus", permissions: { allow: ["Bash(pwd)"] } };
  const r = run(JSONC, now, BASE);
  assert.deepEqual(ops(r.applied).sort(), ["item-remove permissions.allow", "remove env"]);
  assert.equal(r.text, '{\n  // my model\n  "model": "opus", // pick\n  "permissions": {\n    // what I allow\n    "allow": [\n      "Bash(pwd)"\n    ]\n  }\n}\n');
  const gone = run('{\n  // about a\n  "a": 1,\n  "b": 2\n}\n', { b: 2 }, { a: 1, b: 2 });
  assert.equal(gone.text, '{\n  "b": 2\n}\n', "the comment that belonged to a goes with it");
});

test("your own edit is yours: a different value in settings.jsonc is a conflict, and nothing is overwritten", () => {
  const mine = JSONC.replace('"opus"', '"haiku"');
  const r = run(mine, { ...BASE, model: "sonnet" }, BASE);
  assert.equal(r.text, mine);
  assert.deepEqual(r.applied, []);
  assert.equal(r.conflicts.length, 1);
  assert.match(r.conflicts[0].reason, /settings\.jsonc has "haiku" there, not the "opus" settings\.json had/);
  assert.equal(r.pending, 1);
  // a scalar where a key with an object should go
  const clash = run('{\n  "p": 5\n}\n', { p: { q: 1 } }, {});
  assert.match(clash.conflicts[0].reason, /has 5 there/);
  assert.equal(clash.text, '{\n  "p": 5\n}\n');
});

test("a change that settings.jsonc already has is skipped, and an edit of yours that is not in settings.json is pending", () => {
  const same1 = run(JSONC, BASE, BASE);
  assert.deepEqual(same1.applied, []);
  assert.equal(same1.text, JSONC);
  const already = run(JSONC.replace('"opus"', '"sonnet"'), { ...BASE, model: "sonnet" }, BASE);
  assert.deepEqual(ops(already.skipped), ["change model"]);
  assert.equal(already.text, JSONC.replace('"opus"', '"sonnet"'));
  const pending = run('{\n  "model": "mine"\n}\n', { model: "opus", theme: "dark" }, { model: "opus" });
  assert.deepEqual(ops(pending.applied), ["add theme"]);
  assert.equal(pending.pending, 1, "the model you changed is still to be built");
});

test("with no record of the last build only additions are taken; the rest might be your own edits", () => {
  const now = { model: "sonnet", permissions: { allow: ["Bash(ls)", "Bash(pwd)", "Bash(new)"] }, env: { A: "1" }, theme: "dark" };
  const r = run(JSONC, now, null);
  assert.equal(r.baseline, false);
  assert.deepEqual(ops(r.applied).sort(), ["add theme", "item-add permissions.allow"]);
  assert.deepEqual(r.unabsorbed.map((u) => u.op.op), ["change"]);
  assert.match(r.unabsorbed[0].reason, /no record of the last build/);
  assert.match(r.text, /"model": "opus"/, "the model was not touched");
  // a record that is not usable is no record
  const junk = run(JSONC, now, "not json");
  assert.equal(junk.baseline, false);
});

test("refused, with the reason and the text untouched: settings.jsonc that is not JSON, repeats a key or is not an object; settings.json that is not JSON or not an object", () => {
  for (const [jsonc, now, why] of [
    ['{\n  "model": \n}\n', {}, /not valid JSON with comments/],
    ['{"a": 1, "a": 2}', {}, /repeats the key "a"/],
    ["[1]", {}, /does not hold an object/],
    ['{"a": 1}', "{ nope", /settings\.json is not valid JSON/],
    ['{"a": 1}', "[]", /settings\.json does not hold an object/],
    ['{"a": 1}', "null", /settings\.json does not hold an object/],
  ]) {
    const r = run(jsonc, now, {});
    assert.equal(r.ok, false, jsonc);
    assert.match(r.refused, why);
    assert.equal(r.text, jsonc);
    assert.deepEqual(r.applied, []);
  }
});

test("tabs and CRLF in settings.jsonc are kept in what is added; a byte-order mark in settings.json is fine", () => {
  const r = run('{\r\n\t"model": "opus"\r\n}\r\n', { model: "opus", theme: "dark" }, { model: "opus" });
  assert.equal(r.text, '{\r\n\t"model": "opus",\r\n\t"theme": "dark"\r\n}\r\n');
  const bom = absorb({ jsoncText: "{}", jsonText: `﻿${J({ a: 1 })}`, baselineText: J({}) });
  assert.deepEqual(ops(bom.applied), ["add a"]);
});

test("a key called __proto__ in settings.json is taken in as a key", () => {
  const r = absorb({ jsoncText: "{}\n", jsonText: '{"__proto__": {"x": 1}}', baselineText: "{}" });
  assert.deepEqual(ops(r.applied), ["add __proto__"]);
  assert.equal(Object.getOwnPropertyDescriptor(toValue(parseJsonc(r.text).root), "__proto__").value.x, 1);
  assert.equal(({}).x, undefined);
});

test("absorbing the same thing twice changes nothing the second time", () => {
  const now = { ...BASE, theme: "dark", permissions: { allow: ["Bash(ls)", "Bash(pwd)", "Bash(new)"] } };
  const first = run(JSONC, now, BASE);
  const second = run(first.text, now, now);
  assert.deepEqual(second.applied, []);
  assert.equal(second.text, first.text);
});

// ---- random documents ------------------------------------------------------------------------------------------

// Settings the way Claude Code has them: lists are sets (no repeated item), and no setting is a list of lists
// (none is in the schema), so a list inside a list becomes an object that holds it.
const dedupe = (v) => {
  if (Array.isArray(v)) return v.map((x) => dedupe(Array.isArray(x) ? { list: x } : x)).filter((x, i, all) => all.findIndex((y) => same(x, y)) === i);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dedupe(x)]));
  return v;
};
// The value with every list sorted, since lists are sets, also inside the items of a list
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const setForm = (v) => {
  if (Array.isArray(v)) return v.map(setForm).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, setForm(v[k])]));
  return v;
};
const layouts = (r) => ({ eol: r() < 0.3 ? "\r\n" : "\n", unit: r() < 0.2 ? "\t" : pick(r, ["  ", "    ", " "]) });
const has = (text, note) => new RegExp(`\\b${note}\\b`).test(text);

test("1,500 random settings.json changes (nothing removed) go into a random settings.jsonc: the same settings, every comment kept, and building it gives settings.json's settings", () => {
  const r = rng(808);
  for (let n = 0; n < 1500; n++) {
    const value = dedupe({ model: "m", ...randomValue(r) });
    const { text, notes } = render(value, r, layouts(r));
    const next = mutate(value, r, { removals: false });
    const res = run(text, next, value);
    assert.equal(res.refused, null, JSON.stringify(text));
    assert.equal(res.internal, null, JSON.stringify(text));
    assert.deepEqual(res.conflicts, [], JSON.stringify(text));
    const got = toValue(parseJsonc(res.text).root);
    assert.deepEqual(setForm(got), setForm(next), `${JSON.stringify(text)} + ${JSON.stringify(next)} -> ${JSON.stringify(res.text)}`);
    assert.equal(res.pending, 0);
    for (const note of notes) assert.ok(has(res.text, note), `${note} was lost: ${JSON.stringify(text)} -> ${JSON.stringify(res.text)}`);
    const built = buildFromJsonc(res.text);
    assert.equal(built.ok, true);
    assert.deepEqual(setForm(JSON.parse(built.text)), setForm(next));
    if (text.includes("\r\n")) assert.ok(!/[^\r]\n/.test(res.text), "CRLF stays");
  }
});

test("1,500 random settings.json changes with removals: the same settings, a text that still parses", () => {
  const r = rng(909);
  for (let n = 0; n < 1500; n++) {
    const value = dedupe({ model: "m", ...randomValue(r) });
    const { text } = render(value, r, layouts(r));
    const next = mutate(value, r, { steps: 1 + Math.floor(r() * 6) });
    const res = run(text, next, value);
    assert.equal(res.refused, null, JSON.stringify(text));
    assert.equal(res.internal, null, `${JSON.stringify(text)} + ${JSON.stringify(next)}: ${res.internal}`);
    const got = toValue(parseJsonc(res.text).root);
    assert.deepEqual(setForm(got), setForm(next), `${JSON.stringify(text)} + ${JSON.stringify(next)} -> ${JSON.stringify(res.text)}`);
    assert.equal(res.pending, 0);
  }
});

test("1,000 random changes with no record of the last build: additions only, nothing else touched", () => {
  const r = rng(1010);
  for (let n = 0; n < 1000; n++) {
    const value = dedupe({ model: "m", ...randomValue(r) });
    const { text } = render(value, r, layouts(r));
    const next = mutate(value, r, { steps: 1 + Math.floor(r() * 4) });
    const res = absorb({ jsoncText: text, jsonText: J(next), baselineText: null });
    assert.equal(res.internal, null);
    assert.ok(res.applied.every((a) => a.op.op === "add" || a.op.op === "item-add"), "only additions");
    // what is in the new text is what was there, plus the additions
    const got = toValue(parseJsonc(res.text).root);
    assert.ok(diffValues(value, got).every((o) => o.op === "add" || o.op === "item-add"), "only additions to the old value");
  }
});

// ---- hook groups: lists of objects, with lists of objects inside them ----------------------------------------------

test("a change inside a hook group is made in the group, where it is: its comments stay and it does not move", () => {
  const jsonc = '{\n  "hooks": {\n    "PreToolUse": [\n      // the guard\n      {\n        "matcher": "Bash", // shell only\n        "hooks": [\n          // checks the command\n          { "type": "command", "command": "guard.sh" }\n        ]\n      },\n      // the logger\n      {\n        "matcher": "Edit",\n        "hooks": [{ "type": "command", "command": "log.sh" }]\n      }\n    ]\n  }\n}\n';
  const before = JSON.parse(jsonc.replace(/\/\/.*$/gm, ""));
  const after = structuredClone(before);
  after.hooks.PreToolUse[0].matcher = "Bash|PowerShell";
  after.hooks.PreToolUse[0].hooks.push({ type: "command", command: "second.sh" });
  after.hooks.PreToolUse[1].hooks[0].timeout = 5;
  const r = run(jsonc, after, before);
  assert.equal(r.internal, null);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(ops(r.applied).sort(), ["add hooks.PreToolUse.1.hooks.0.timeout", "change hooks.PreToolUse.0.matcher", "item-add hooks.PreToolUse.0.hooks"]);
  for (const note of ["the guard", "shell only", "checks the command", "the logger"]) assert.ok(r.text.includes(note), note);
  const got = JSON.parse(r.text.replace(/\/\/.*$/gm, ""));
  assert.deepEqual(got, after, "the groups are where they were");
  assert.ok(r.text.indexOf("guard.sh") < r.text.indexOf("second.sh") && r.text.indexOf("second.sh") < r.text.indexOf("log.sh"));
});

test("a group that was taken out and another put in, with nothing in common, are not mistaken for one that changed", () => {
  const jsonc = '{\n  "hooks": {\n    "Stop": [\n      // old\n      { "hooks": [{ "type": "command", "command": "old.sh" }] }\n    ]\n  }\n}\n';
  const before = JSON.parse(jsonc.replace(/\/\/.*$/gm, ""));
  const after = { hooks: { Stop: [{ matcher: "x", other: 1 }] } };
  const r = run(jsonc, after, before);
  assert.deepEqual(ops(r.applied).sort(), ["item-add hooks.Stop", "item-remove hooks.Stop"]);
  assert.ok(!r.text.includes("// old"), "the comment above the old group goes with it");
});

// A settings object with hook groups, and the changes a person or a tool makes to them
const hookEntry = (r, i) => ({ type: "command", command: `run-${i}.sh`, ...(r() < 0.5 ? { timeout: 5 + i } : {}) });
const hookGroups = (r, base, n) => Array.from({ length: n }, (_, i) => ({ ...(r() < 0.7 ? { matcher: `${pick(r, ["Bash", "Edit|Write", "Read"])}${base + i}` } : {}), hooks: Array.from({ length: 1 + Math.floor(r() * 3) }, (_, j) => hookEntry(r, (base + i) * 10 + j)) }));
function changeHooks(r, value, removals) {
  const next = structuredClone(value);
  for (let step = 1 + Math.floor(r() * 3); step > 0; step--) {
    const event = pick(r, Object.keys(next.hooks));
    const groups = next.hooks[event];
    const g = groups[Math.floor(r() * groups.length)];
    const x = r();
    if (x < 0.25) g.matcher = `changed-${step}`;
    else if (x < 0.5) g.hooks.push({ type: "command", command: `added-${step}.sh` });
    else if (x < 0.7) g.hooks[Math.floor(r() * g.hooks.length)].command = `edited-${step}.sh`;
    else if (x < 0.8) g.hooks[Math.floor(r() * g.hooks.length)].timeout = 100 + step;
    else if (x < 0.9) groups.push({ matcher: `new-${step}`, hooks: [{ type: "command", command: `new-${step}.sh` }] });
    else if (removals && g.hooks.length > 1) g.hooks.splice(Math.floor(r() * g.hooks.length), 1);
    else if (removals && groups.length > 1) groups.splice(groups.indexOf(g), 1);
  }
  return next;
}

test("1,000 random changes to hook groups (nothing taken out): every comment stays, the groups keep their places", () => {
  const r = rng(2468);
  for (let n = 0; n < 1000; n++) {
    const value = { model: "m", hooks: { PreToolUse: hookGroups(r, 0, 1 + Math.floor(r() * 3)), SessionStart: hookGroups(r, 5, 1 + Math.floor(r() * 2)) } };
    const { text, notes } = render(value, r, layouts(r));
    const next = changeHooks(r, value, false);
    const res = run(text, next, value);
    assert.equal(res.refused, null);
    assert.equal(res.internal, null, JSON.stringify(text));
    assert.deepEqual(res.conflicts, []);
    assert.deepEqual(setForm(toValue(parseJsonc(res.text).root)), setForm(next), `${JSON.stringify(text)} + ${JSON.stringify(next)} -> ${JSON.stringify(res.text)}`);
    for (const note of notes) assert.ok(has(res.text, note), `${note} was lost: ${JSON.stringify(text)} + ${JSON.stringify(next)} -> ${JSON.stringify(res.text)}`);
    // a group that was there stays where it was, a group that came is last: the groups are in the order of settings.json
    const out = toValue(parseJsonc(res.text).root);
    for (const event of ["PreToolUse", "SessionStart"]) assert.deepEqual(out.hooks[event].map(setForm), next.hooks[event].map(setForm), `${event}: ${JSON.stringify(text)} + ${JSON.stringify(next)} -> ${JSON.stringify(res.text)}`);
  }
});

test("1,000 random changes to hook groups with removals: the same settings, a text that parses", () => {
  const r = rng(1357);
  for (let n = 0; n < 1000; n++) {
    const value = { model: "m", hooks: { PreToolUse: hookGroups(r, 0, 1 + Math.floor(r() * 3)), SessionStart: hookGroups(r, 5, 1 + Math.floor(r() * 2)) } };
    const { text } = render(value, r, layouts(r));
    const next = changeHooks(r, value, true);
    const res = run(text, next, value);
    assert.equal(res.internal, null, `${JSON.stringify(text)} + ${JSON.stringify(next)}: ${res.internal}`);
    assert.deepEqual(setForm(toValue(parseJsonc(res.text).root)), setForm(next), `${JSON.stringify(text)} + ${JSON.stringify(next)} -> ${JSON.stringify(res.text)}`);
    assert.equal(res.pending, 0);
  }
});
