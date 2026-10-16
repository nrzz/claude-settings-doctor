// facts: what the real binary was seen to do, as tables the lint reads. test/e2e-claude.test.mjs puts these to the
// binary; here they are held against the vendored schema, so a table cannot name a key the schema does not have, or
// an exception to a rule that the schema does not break.
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { BOUNDS_ENFORCED, ENUM_EXTRA, ENUM_REJECTED, FIELD_LEVEL, HOOK_EVENTS, HOOK_TYPES, NULL_OK, TYPE_EXTRA, UNCHECKED, WHOLE_FILE_EVENTS, isUnchecked } from "../src/facts.mjs";
import { vendored } from "../src/schema.mjs";

const schema = vendored();
const top = schema.root.properties;
const typesOf = (node) => { const n = schema.resolve(node); return n && n.type ? [].concat(n.type) : null; };

test("the hook events: each once, named the way Claude Code names them, the two that guard permissions among them", () => {
  assert.equal(new Set(HOOK_EVENTS).size, HOOK_EVENTS.length);
  for (const e of HOOK_EVENTS) assert.match(e, /^[A-Z][A-Za-z]+$/, e);
  for (const e of ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "Notification", "PreCompact"]) assert.ok(HOOK_EVENTS.includes(e), e);
  assert.deepEqual([...WHOLE_FILE_EVENTS].sort(), ["PermissionRequest", "PreToolUse"]);
  for (const e of WHOLE_FILE_EVENTS) assert.ok(HOOK_EVENTS.includes(e), e);
});

test("every hook event the schema lists is one the binary list has, or the lint knows it from the schema alone", () => {
  const schemaEvents = Object.keys(schema.nodeAt(["hooks"]).node.properties || {});
  assert.ok(schemaEvents.length > 10);
  const missing = schemaEvents.filter((e) => !HOOK_EVENTS.includes(e));
  assert.ok(missing.length <= 3, `the schema has events that the table lacks: ${missing.join(", ")} (they are still accepted, from the schema)`);
});

test("the hook types: command first, and the types the schema's hook forms name are there", () => {
  assert.equal(HOOK_TYPES[0], "command");
  const hookCommand = schema.resolve({ $ref: "#/$defs/hookCommand" });
  const fromSchema = (hookCommand.anyOf || []).map((a) => schema.resolve(a)).map((a) => a && a.properties && a.properties.type && a.properties.type.const).filter(Boolean);
  assert.ok(fromSchema.length >= 3);
  for (const t of fromSchema) assert.ok(HOOK_TYPES.includes(t), `${t} is a hook type in the schema but not in the table`);
});

test("FIELD_LEVEL names top-level keys of the schema", () => {
  for (const k of FIELD_LEVEL) assert.ok(Object.hasOwn(top, k), k);
});

test("UNCHECKED names keys of the schema, and isUnchecked matches the key and what is inside it, never a key that merely starts alike", () => {
  for (const dotted of UNCHECKED) assert.ok(schema.nodeAt(dotted.split(".")), `${dotted} is not in the schema`);
  assert.equal(isUnchecked(["effortLevel"]), true);
  assert.equal(isUnchecked(["sandbox", "bwrapPath"]), true);
  assert.equal(isUnchecked(["worktree", "bgIsolation"]), true);
  assert.equal(isUnchecked(["spinnerTipsOverride", "tips", 0]), true, "inside an unchecked key; a list index does not count");
  assert.equal(isUnchecked(["effortLevelX"]), false);
  assert.equal(isUnchecked(["model"]), false);
  assert.equal(isUnchecked(["sandbox", "enabled"]), false);
  assert.equal(isUnchecked([]), false);
});

test("BOUNDS_ENFORCED names top-level keys that have a minimum or a maximum in the schema", () => {
  for (const k of BOUNDS_ENFORCED) {
    const node = schema.resolve(top[k]);
    assert.ok(node && (node.minimum !== undefined || node.maximum !== undefined || node.exclusiveMinimum !== undefined), `${k} has no bound in the schema`);
  }
});

test("TYPE_EXTRA, ENUM_EXTRA and ENUM_REJECTED: each exception is to something the schema does say", () => {
  for (const [dotted, extra] of Object.entries(TYPE_EXTRA)) {
    const types = typesOf(schema.nodeAt(dotted.split(".")).node) || [];
    for (const t of extra) assert.ok(!types.includes(t), `${dotted} already allows ${t} in the schema`);
  }
  for (const [dotted, values] of Object.entries(ENUM_EXTRA)) {
    const node = schema.nodeAt(dotted.split(".")).node;
    for (const v of values) assert.ok(!(node.enum || []).includes(v), `${dotted} already lists ${v}`);
  }
  for (const [dotted, values] of Object.entries(ENUM_REJECTED)) {
    const node = schema.nodeAt(dotted.split(".")).node;
    for (const v of values) assert.ok((node.enum || []).includes(v), `${dotted} does not list ${v} in the schema, so there is nothing to reject`);
  }
});

test("NULL_OK names top-level keys of the schema whose type is not null", () => {
  for (const k of NULL_OK) {
    assert.ok(Object.hasOwn(top, k), `${k} is not in the schema`);
    assert.ok(!(typesOf(top[k]) || []).includes("null"), `${k} already allows null in the schema`);
  }
});
