// The schema checker: each keyword it judges, what it says it cannot judge, the lookups, and the vendored schema.
import "./helpers.mjs";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { createSchema, deprecation, distance, firstSentence, jsonType, loadSchema, nearest, vendored } from "../src/schema.mjs";

const check = (schema, value, opts) => createSchema(schema).check(value, schema, opts);
const kinds = (r) => r.issues.map((i) => `${i.path.join(".")}:${i.kind}`);

test("type: one type, a list of types, integer against number", () => {
  assert.deepEqual(kinds(check({ type: "string" }, "x")), []);
  assert.deepEqual(kinds(check({ type: "string" }, 5)), [":type"]);
  assert.deepEqual(kinds(check({ type: ["string", "null"] }, null)), []);
  assert.deepEqual(kinds(check({ type: ["string", "null"] }, 5)), [":type"]);
  assert.deepEqual(kinds(check({ type: "integer" }, 5)), []);
  assert.deepEqual(kinds(check({ type: "integer" }, 5.5)), [":type"]);
  assert.deepEqual(kinds(check({ type: "number" }, 5.5)), []);
  assert.deepEqual(kinds(check({ type: "boolean" }, "true")), [":type"]);
  assert.deepEqual(kinds(check({ type: "array" }, {})), [":type"]);
  assert.deepEqual(kinds(check({ type: "object" }, [])), [":type"]);
  assert.equal(check({ type: "string" }, 5).issues[0].message, "should be a string, found a number");
});

test("enum and const", () => {
  assert.deepEqual(kinds(check({ enum: ["a", "b"] }, "a")), []);
  const bad = check({ enum: ["a", "b"] }, "c");
  assert.deepEqual(kinds(bad), [":enum"]);
  assert.match(bad.issues[0].message, /"c" is not one of "a", "b"/);
  assert.deepEqual(kinds(check({ const: "command" }, "comand")), [":const"]);
  assert.deepEqual(kinds(check({ enum: [{ a: 1 }] }, { a: 1 })), []);
});

test("properties, required and additionalProperties: false, true and a schema", () => {
  const s = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"], additionalProperties: false };
  assert.deepEqual(kinds(check(s, { a: "x" })), []);
  assert.deepEqual(kinds(check(s, {})), [":required"]);
  assert.deepEqual(kinds(check(s, { a: 1 })), ["a:type"]);
  const unknown = check(s, { a: "x", c: 1 });
  assert.deepEqual(kinds(unknown), ["c:unknown-key"]);
  assert.equal(unknown.issues[0].strict, true);
  assert.deepEqual(unknown.issues[0].known, ["a", "b"]);
  // true: the schema allows it, but it is still not a key the schema lists
  assert.deepEqual(kinds(check({ ...s, additionalProperties: true }, { a: "x", c: 1 })), ["c:unknown-key"]);
  assert.equal(check({ ...s, additionalProperties: true }, { a: "x", c: 1 }).issues[0].strict, false);
  // a schema: the extra keys are checked against it, and are not unknown
  const free = { type: "object", properties: { a: { type: "string" } }, additionalProperties: { type: "string" } };
  assert.deepEqual(kinds(check(free, { a: "x", z: "y" })), []);
  assert.deepEqual(kinds(check(free, { a: "x", z: 1 })), ["z:type"]);
  // asked not to report unknown keys
  assert.deepEqual(kinds(check(s, { a: "x", c: 1 }, { unknown: false })), []);
  // an object with no properties at all lists nothing, so no key is unknown
  assert.deepEqual(kinds(check({ type: "object" }, { anything: 1 })), []);
});

test("patternProperties and propertyNames", () => {
  const s = { type: "object", patternProperties: { "^x-": { type: "number" } }, propertyNames: { pattern: "^[a-z-]+$" } };
  assert.deepEqual(kinds(check(s, { "x-a": 1 })), []);
  assert.deepEqual(kinds(check(s, { "x-a": "s" })), ["x-a:type"]);
  const names = check(s, { Bad: 1 });
  assert.deepEqual(kinds(names), ["Bad:pattern"]);
  assert.equal(names.issues[0].at, "key");
});

test("items, minItems, maxItems and uniqueItems", () => {
  const s = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2, uniqueItems: true };
  assert.deepEqual(kinds(check(s, ["a"])), []);
  assert.deepEqual(kinds(check(s, [])), [":items"]);
  assert.deepEqual(kinds(check(s, ["a", "b", "c"])), [":items"]);
  assert.deepEqual(kinds(check(s, ["a", 1])), ["1:type"]);
  const dup = check(s, ["a", "a"]);
  assert.deepEqual(kinds(dup), ["1:unique"]);
  assert.equal(dup.issues[0].of, 0);
});

test("minLength, maxLength, pattern", () => {
  assert.deepEqual(kinds(check({ type: "string", minLength: 1 }, "")), [":length"]);
  assert.equal(check({ type: "string", minLength: 1 }, "").issues[0].message, "should not be empty");
  assert.deepEqual(kinds(check({ type: "string", maxLength: 2 }, "abc")), [":length"]);
  assert.deepEqual(kinds(check({ type: "string", pattern: "^a+$" }, "aab")), [":pattern"]);
  assert.deepEqual(kinds(check({ type: "string", pattern: "^a+$" }, "aa")), []);
  // a pattern JavaScript cannot compile is not judged
  const r = check({ type: "string", pattern: "(" }, "x");
  assert.deepEqual(kinds(r), []);
  assert.deepEqual(r.notChecked.map((n) => n.keyword), ["pattern"]);
});

test("minimum, maximum, exclusiveMinimum, exclusiveMaximum", () => {
  const s = { type: "number", minimum: 1, maximum: 10 };
  assert.deepEqual(kinds(check(s, 1)), []);
  assert.deepEqual(kinds(check(s, 0)), [":range"]);
  assert.deepEqual(kinds(check(s, 11)), [":range"]);
  assert.deepEqual(kinds(check({ type: "number", exclusiveMinimum: 0 }, 0)), [":range"]);
  assert.deepEqual(kinds(check({ type: "number", exclusiveMinimum: 0 }, 0.1)), []);
  assert.deepEqual(kinds(check({ type: "number", exclusiveMaximum: 5 }, 5)), [":range"]);
});

test("$ref inside the file, with a description next to it", () => {
  const root = { $defs: { name: { type: "string", description: "a name" } }, type: "object", properties: { a: { $ref: "#/$defs/name", description: "mine" }, b: { $ref: "#/$defs/name" } } };
  const s = createSchema(root);
  assert.deepEqual(kinds(s.check({ a: "x", b: "y" })), []);
  assert.deepEqual(kinds(s.check({ a: 1 })), ["a:type"]);
  assert.equal(s.nodeAt(["a"]).node.description, "mine");
  assert.equal(s.nodeAt(["b"]).node.description, "a name");
  // a $ref that goes nowhere, or outside the file, judges nothing
  assert.deepEqual(kinds(createSchema({ properties: { a: { $ref: "#/$defs/none" } } }).check({ a: 1 }, { properties: { a: { $ref: "#/$defs/none" } } })), []);
  assert.deepEqual(kinds(createSchema({}).check(1, { $ref: "https://example.com/x.json" })), []);
});

test("anyOf: passes when one form fits; otherwise says what is closest", () => {
  const s = { anyOf: [{ type: "string", enum: ["a"] }, { type: "string", pattern: "^custom:" }] };
  assert.deepEqual(kinds(check(s, "a")), []);
  assert.deepEqual(kinds(check(s, "custom:x")), []);
  const bad = check(s, 5);
  assert.deepEqual(kinds(bad), [":any"]);
  assert.match(bad.issues[0].message, /^should be one of "a" or a string/);
  // when the value's type picks one form, that form's problems are reported
  const forms = { anyOf: [{ type: "string" }, { type: "object", properties: { a: { type: "number" } }, additionalProperties: false }] };
  assert.deepEqual(kinds(check(forms, { a: "x" })), ["a:type"]);
  assert.deepEqual(kinds(check(forms, 5)), [":any"]);
});

test("anyOf with a discriminator: the form named by `type` is the one judged", () => {
  const s = { anyOf: [
    { type: "object", required: ["type", "command"], properties: { type: { const: "command" }, command: { type: "string" } } },
    { type: "object", required: ["type", "prompt"], properties: { type: { const: "prompt" }, prompt: { type: "string" } } },
  ] };
  assert.deepEqual(kinds(check(s, { type: "command", command: "x" })), []);
  assert.deepEqual(kinds(check(s, { type: "prompt" })), [":required"]);
  assert.deepEqual(kinds(check(s, { type: "command", command: 5 })), ["command:type"]);
  assert.deepEqual(kinds(check(s, { type: "comand" })), [":any"]);
});

test("oneOf is read as anyOf; allOf checks every form; not fails when the inner schema passes", () => {
  assert.deepEqual(kinds(check({ oneOf: [{ type: "string" }, { type: "array" }] }, ["x"])), []);
  assert.deepEqual(kinds(check({ allOf: [{ type: "object" }, { required: ["a"] }] }, {})), [":required"]);
  assert.deepEqual(kinds(check({ not: { type: "string" } }, "x")), [":not"]);
  assert.deepEqual(kinds(check({ not: { type: "string" } }, 5)), []);
  assert.deepEqual(kinds(check({ not: {} }, 1)), [":not"]);
});

test("deprecated: the keyword and a description that starts with DEPRECATED", () => {
  const s = { type: "object", properties: { a: { type: "boolean", deprecated: true, description: "Use b." }, b: { type: "boolean", description: "DEPRECATED. Use c instead." }, c: { type: "boolean", description: "Not deprecated; it replaces a deprecated one." } } };
  assert.deepEqual(kinds(check(s, { a: true, b: true, c: true })), ["a:deprecated", "b:deprecated"]);
  assert.equal(deprecation(s.properties.a), "Use b.");
  assert.equal(deprecation(s.properties.c), null);
});

test("what it cannot judge is said, once per place", () => {
  const r = check({ type: "object", properties: { u: { type: "string", format: "uri" }, w: { type: "string", if: {}, then: {} } } }, { u: "not a uri", w: "x" });
  assert.deepEqual(kinds(r), []);
  assert.deepEqual(r.notChecked.map((n) => `${n.path.join(".")}:${n.keyword}`).sort(), ["u:format", "w:if", "w:then"]);
  // a format on a value that is not a string is not a place it was asked to judge
  assert.deepEqual(check({ type: "number", format: "uri" }, 1).notChecked, []);
});

test("firstSentence, jsonType, distance and nearest", () => {
  assert.equal(firstSentence("One. Two."), "One.");
  assert.equal(firstSentence("no stop"), "no stop");
  assert.equal(firstSentence("  spaced   out. next"), "spaced out.");
  assert.deepEqual(["x", null, [], {}, 1, true, "s"].map(jsonType), ["string", "null", "array", "object", "number", "boolean", "string"]);
  assert.equal(distance("kitten", "sitting"), 3);
  assert.equal(distance("permisions", "permissions"), 1);
  assert.equal(distance("pemrissions", "permissions"), 1, "a swap counts once");
  assert.deepEqual(nearest("permisions", ["permissions", "model", "env"]), ["permissions"]);
  assert.deepEqual(nearest("Model", ["model", "env"]), ["model"]);
  assert.deepEqual(nearest("zzzzzz", ["permissions", "model"]), []);
  assert.deepEqual(nearest("cleanupPeriodDay", ["cleanupPeriodDays", "claudeMd"]), ["cleanupPeriodDays"]);
  assert.deepEqual(nearest("model", ["model"]), [], "the same name is not a suggestion");
});

test("nodeAt follows properties, items, additionalProperties and dotted keys", () => {
  const s = vendored();
  assert.equal(s.nodeAt(["permissions", "defaultMode"]).node.type, "string");
  assert.ok(s.nodeAt(["hooks", "PreToolUse", 0, "matcher"]));
  assert.ok(s.nodeAt(["hooks", "PreToolUse", "0", "hooks", "0", "timeout"]));
  assert.ok(s.nodeAt(["hooks", "PreToolUse", "*", "hooks"]));
  assert.ok(s.nodeAt(["env", "ANTHROPIC_MODEL"]));
  assert.ok(s.nodeAt(["env", "MY_OWN_VARIABLE"]), "a free-form name falls back to additionalProperties");
  assert.ok(s.nodeAt(["enabledPlugins", "my-plugin@my.market"]));
  assert.equal(s.nodeAt(["notAKey"]), null);
  assert.equal(s.nodeAt(["permissions", "nope"]), null);
  assert.ok(s.nodeAt(["permissions.defaultMode".split(".")[0], "defaultMode"]));
  // a key that holds a dot is taken as one key
  const dotted = createSchema({ type: "object", properties: { "a.b": { type: "string", description: "dotted" } } });
  assert.equal(dotted.nodeAt(["a", "b"]).node.description, "dotted");
  assert.equal(dotted.nodeAt(["a.b"]).node.description, "dotted");
});

test("namesAt lists the keys an object has, also through anyOf", () => {
  const s = vendored();
  assert.ok(s.namesAt([]).includes("permissions"));
  assert.deepEqual(s.namesAt(["permissions"]).sort(), ["additionalDirectories", "allow", "ask", "defaultMode", "deny", "disableAutoMode", "disableBypassPermissionsMode"]);
  assert.ok(s.namesAt(["hooks", "PreToolUse", 0, "hooks", 0]).includes("command"), "the forms of a hook entry");
  assert.deepEqual(s.namesAt(["model"]), []);
});

test("label and typeText say what a node accepts", () => {
  const s = vendored();
  const at = (...p) => s.nodeAt(p).node;
  assert.equal(s.label(at("cleanupPeriodDays")), "an integer");
  assert.equal(s.typeText(at("cleanupPeriodDays")), "integer");
  assert.equal(s.typeText(at("permissions", "allow")), "array of strings");
  assert.equal(s.typeText(at("env")), "object");
  assert.match(s.typeText(at("permissions", "defaultMode")), /^one of "acceptEdits"/);
  assert.match(s.label(at("theme")), /^one of "auto".* or a string$/);
  assert.equal(s.label(at("enabledPlugins", "formatter@anthropic-tools")), "an array of strings or a boolean", "the schema's `not {}` accepts nothing and is not named");
});

// ---- the vendored schema ----------------------------------------------------------------------------------

test("the vendored schema and its record: where it came from, when, and its licence", () => {
  const { schema, meta } = loadSchema();
  assert.equal(meta.source, "https://json.schemastore.org/claude-code-settings.json");
  assert.match(meta.downloaded, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(meta.licence, "Apache-2.0");
  assert.equal(meta.properties, Object.keys(schema.properties).length);
  const text = fs.readFileSync(new URL("../src/schema/claude-code-settings.json", import.meta.url), "utf8");
  assert.equal(meta.bytes, Buffer.byteLength(text.replace(/\r\n/g, "\n")), "the size of the file as downloaded (a checkout may turn line feeds into CRLF)");
  const licence = fs.readFileSync(new URL("../src/schema/LICENSE", import.meta.url), "utf8");
  assert.match(licence, /Apache License\s+Version 2\.0/);
  assert.equal(schema.type, "object");
  assert.ok(Object.keys(schema.properties).length > 100);
});

test("every $ref in the vendored schema resolves, and every property can be looked up", () => {
  const s = vendored();
  const walk = (node, where) => {
    if (Array.isArray(node)) node.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (node && typeof node === "object") {
      if (typeof node.$ref === "string") assert.ok(s.resolve(node), `${where} ${node.$ref}`);
      for (const [k, v] of Object.entries(node)) if (k !== "examples" && k !== "default") walk(v, `${where}.${k}`);
    }
  };
  walk(s.root, "#");
  for (const key of Object.keys(s.root.properties)) assert.ok(s.nodeAt([key]), key);
});

test("what the schema itself offers as examples is accepted by the checker", () => {
  const s = vendored();
  const bad = [];
  for (const [key, def] of Object.entries(s.root.properties)) {
    for (const example of Array.isArray(def.examples) ? def.examples : []) {
      const r = s.check({ [key]: example });
      for (const i of r.issues) if (i.kind !== "deprecated" && i.kind !== "pattern") bad.push(`${key}: ${i.path.join(".")} ${i.kind} ${i.message}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("an empty settings object and the schema's own defaults have no issues", () => {
  const s = vendored();
  assert.deepEqual(s.check({}).issues, []);
  const defaults = {};
  for (const [key, def] of Object.entries(s.root.properties)) if (def.default !== undefined && !key.startsWith("$")) defaults[key] = def.default;
  const r = s.check(defaults);
  assert.deepEqual(r.issues.filter((i) => i.kind !== "deprecated").map((i) => `${i.path.join(".")}:${i.kind}`), []);
});

test("a settings file that names its own schema is fine", () => {
  assert.deepEqual(vendored().check({ $schema: "https://json.schemastore.org/claude-code-settings.json" }).issues, []);
});
