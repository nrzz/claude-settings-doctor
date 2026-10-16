// jsonedit: changing a settings.jsonc by editing its text, so that the comments, blank lines, indentation, line
// endings and key order around the change stay as they were.
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { parseJsonc, toValue } from "../src/jsonc.mjs";
import { insertItem, insertMember, nodeAtPath, removeElement, replaceValue, styleOf } from "../src/jsonedit.mjs";
import { pick, randomValue, render, rng } from "./gen.mjs";

const root = (t) => parseJsonc(t).root;
const at = (t, ...path) => nodeAtPath(root(t), path);
const remove = (t, ...path) => { const m = at(t, ...path); return removeElement(t, m.parent, m.parent.members.indexOf(m.member)); };

test("styleOf: the line ending that most lines use, a tab or the smallest indent", () => {
  assert.deepEqual(styleOf('{\r\n\t"a": 1\r\n}\r\n'), { eol: "\r\n", unit: "\t" });
  assert.deepEqual(styleOf('{\n    "a": {\n        "b": 1\n    }\n}\n'), { eol: "\n", unit: "    " });
  assert.deepEqual(styleOf('{\n  "a": 1\n}\n'), { eol: "\n", unit: "  " });
  assert.deepEqual(styleOf("{}"), { eol: "\n", unit: "  " }, "nothing to go by: LF and two spaces");
  assert.deepEqual(styleOf('{\r\n  "a": 1\n}\n'), { eol: "\n", unit: "  " }, "the majority wins");
});

const DOC = '{\n  "a": 1, // one\n  // about b\n  "b": [\n    "x", // first\n    "y"\n  ],\n  // dangling\n}\n';

test("insertMember: after the last member, in the style of the others, comments kept", () => {
  assert.equal(insertMember(DOC, root(DOC), "c", { d: 1 }), '{\n  "a": 1, // one\n  // about b\n  "b": [\n    "x", // first\n    "y"\n  ],\n  "c": {\n    "d": 1\n  },\n  // dangling\n}\n');
});

test("insertMember: into an empty object, a one-line object (the value on one line too), and one with only comments", () => {
  assert.equal(insertMember("{}", root("{}"), "k", 1), '{\n  "k": 1\n}');
  assert.equal(insertMember('{"a": 1}', root('{"a": 1}'), "k", [1, 2]), '{"a": 1, "k": [1,2]}');
  assert.equal(insertMember('{"a": 1,}', root('{"a": 1,}'), "k", 2), '{"a": 1, "k": 2,}', "a trailing comma stays a trailing comma");
  assert.equal(insertMember("{\n  // nothing yet\n}\n", root("{\n  // nothing yet\n}\n"), "k", 2), '{\n  // nothing yet\n  "k": 2\n}\n');
});

test("insertMember: tabs and CRLF are kept, and a nested object is indented to its level", () => {
  const crlf = '{\r\n\t"a": 1\r\n}\r\n';
  assert.equal(insertMember(crlf, root(crlf), "b", { c: [1] }), '{\r\n\t"a": 1,\r\n\t"b": {\r\n\t\t"c": [\r\n\t\t\t1\r\n\t\t]\r\n\t}\r\n}\r\n');
  const nested = '{\n  "o": {\n    "p": 1\n  }\n}\n';
  assert.equal(insertMember(nested, at(nested, "o").node, "q", { r: 1 }), '{\n  "o": {\n    "p": 1,\n    "q": {\n      "r": 1\n    }\n  }\n}\n');
});

test("insertItem: a list written over several lines, on one line, and empty", () => {
  assert.equal(insertItem(DOC, at(DOC, "b").node, "z"), '{\n  "a": 1, // one\n  // about b\n  "b": [\n    "x", // first\n    "y",\n    "z"\n  ],\n  // dangling\n}\n');
  const one = '{"l": ["a", "b"]}';
  assert.equal(insertItem(one, at(one, "l").node, "c"), '{"l": ["a", "b", "c"]}');
  const empty = '{\n  "l": []\n}\n';
  assert.equal(insertItem(empty, at(empty, "l").node, "c"), '{\n  "l": [\n    "c"\n  ]\n}\n');
  assert.deepEqual(toValue(root(insertItem(empty, at(empty, "l").node, { x: [1] }))), { l: [{ x: [1] }] });
});

const U = '{\n  // keep a\n  "a": 1,\n\n  // about b\n  // more about b\n  "b": 2, // tail b\n  "c": 3\n}\n';

test("removeElement: a member goes with the comments right above it and the one after it on its line", () => {
  assert.equal(remove(U, "b"), '{\n  // keep a\n  "a": 1,\n\n  "c": 3\n}\n');
  assert.equal(remove(U, "a"), '{\n\n  // about b\n  // more about b\n  "b": 2, // tail b\n  "c": 3\n}\n', "its own comment goes, the blank line stays");
});

test("removeElement: the last member takes the comma of the one before it, so no comma is left dangling", () => {
  assert.equal(remove(U, "c"), '{\n  // keep a\n  "a": 1,\n\n  // about b\n  // more about b\n  "b": 2 // tail b\n}\n');
  const trailing = '{\n  "a": 1,\n  "b": 2,\n}\n';
  assert.equal(remove(trailing, "b"), '{\n  "a": 1,\n}\n', "a trailing comma stays when it was there");
});

test("removeElement: members that share a line, the only member", () => {
  const one = '{"a": 1, "b": 2, "c": 3}';
  assert.equal(remove(one, "b"), '{"a": 1, "c": 3}');
  assert.equal(remove(one, "c"), '{"a": 1, "b": 2}');
  assert.equal(remove(one, "a"), '{"b": 2, "c": 3}');
  assert.equal(remove('{"a": 1}', "a"), "{}");
  assert.equal(remove('{\n  "a": 1\n}\n', "a"), "{\n}\n");
});

test("removeElement: an item of a list", () => {
  const t = '{\n  "l": [\n    "x", // first\n    "y",\n    "z"\n  ]\n}\n';
  const list = at(t, "l").node;
  assert.equal(removeElement(t, list, 0), '{\n  "l": [\n    "y",\n    "z"\n  ]\n}\n');
  assert.equal(removeElement(t, list, 2), '{\n  "l": [\n    "x", // first\n    "y"\n  ]\n}\n');
  const inline = '{"l": ["x", "y", "z"]}';
  assert.equal(removeElement(inline, at(inline, "l").node, 1), '{"l": ["x", "z"]}');
});

test("replaceValue: the value changes, the comment after it and the comma stay", () => {
  const t = '{\n  "a": "old", // note\n  "b": 2\n}\n';
  assert.equal(replaceValue(t, at(t, "a").node, { x: [1] }), '{\n  "a": {\n    "x": [\n      1\n    ]\n  }, // note\n  "b": 2\n}\n');
  assert.equal(replaceValue(t, at(t, "b").node, null), '{\n  "a": "old", // note\n  "b": null\n}\n');
});

test("nodeAtPath: the node, its member and its parent, or null", () => {
  const t = '{"a": {"b": [1, {"c": 2}]}}';
  const hit = at(t, "a", "b");
  assert.equal(hit.node.type, "array");
  assert.equal(hit.member.key, "b");
  assert.equal(hit.parent.type, "object");
  assert.equal(at(t, "a", "zzz"), null);
  assert.equal(at(t, "a", "b", "c"), null, "a list is not walked by key");
  const tree = root(t);
  assert.equal(nodeAtPath(tree, []).node, tree);
});

test("a key called __proto__ can be inserted, replaced and removed", () => {
  let t = "{\n  \"a\": 1\n}\n";
  t = insertMember(t, root(t), "__proto__", { x: 1 });
  assert.equal(Object.getOwnPropertyDescriptor(toValue(root(t)), "__proto__").value.x, 1);
  t = replaceValue(t, at(t, "__proto__").node, 5);
  assert.equal(Object.getOwnPropertyDescriptor(toValue(root(t)), "__proto__").value, 5);
  t = remove(t, "__proto__");
  assert.deepEqual(toValue(root(t)), { a: 1 });
});

// ---- random documents ------------------------------------------------------------------------------------------

// "note 1" must not be found inside "note 10"
const has = (text, note) => new RegExp(`\\b${note}\\b`).test(text);
const offsetOf = (text, note) => new RegExp(`\\b${note}\\b`).exec(text).index;
const layouts = (r) => ({ eol: r() < 0.3 ? "\r\n" : "\n", unit: r() < 0.2 ? "\t" : pick(r, ["  ", "    ", " "]) });
const collect = (node, path, out) => {
  if (node.type === "object") { out.push({ node, path }); for (const m of node.members) collect(m.value, [...path, m.key], out); }
  else if (node.type === "array") { out.push({ node, path }); node.items.forEach((item, i) => collect(item, [...path, i], out)); }
  return out;
};

test("1,500 random documents: an inserted member or item lands in the container, all comments stay, the rest is as it was", () => {
  const r = rng(4242);
  let done = 0;
  for (let n = 0; n < 1500; n++) {
    const value = { model: "m", ...randomValue(r) };
    const { text, notes } = render(value, r, layouts(r));
    const containers = collect(root(text), [], []);
    const { node } = pick(r, containers);
    const before = toValue(root(text));
    const out = node.type === "object" ? insertMember(text, node, "zz_new", { k: [1, "two"] }) : insertItem(text, node, { k: [1, "two"] });
    const parsed = parseJsonc(out);
    assert.equal(parsed.ok, true, `${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
    const path = containers.find((c) => c.node === node).path;
    const expected = structuredClone(before);
    let target = expected;
    for (const k of path) target = target[k];
    if (Array.isArray(target)) target.push({ k: [1, "two"] }); else target.zz_new = { k: [1, "two"] };
    assert.deepEqual(toValue(parsed.root), expected, `${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
    for (const note of notes) assert.ok(has(out, note), `${note} was lost: ${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
    if (text.includes("\r\n")) assert.ok(!/[^\r]\n/.test(out), "every line break is still CRLF");
    else assert.ok(!out.includes("\r"), "no CR appeared");
    done++;
  }
  assert.equal(done, 1500);
});

test("1,500 random documents: a removed member or item is gone, the rest of the value and the other comments stay", () => {
  const r = rng(9001);
  for (let n = 0; n < 1500; n++) {
    const value = { model: "m", ...randomValue(r) };
    const { text, notes } = render(value, r, layouts(r));
    const candidates = collect(root(text), [], []).filter((c) => (c.node.type === "object" ? c.node.members.length : c.node.items.length) > 0);
    if (!candidates.length) continue;
    const { node, path } = pick(r, candidates);
    const els = node.type === "object" ? node.members : node.items;
    const k = Math.floor(r() * els.length);
    const out = removeElement(text, node, k);
    const parsed = parseJsonc(out);
    assert.equal(parsed.ok, true, `${JSON.stringify(text)} (element ${k} of ${JSON.stringify(path)}) -> ${JSON.stringify(out)}`);
    const expected = structuredClone(toValue(root(text)));
    let target = expected;
    for (const key of path) target = target[key];
    if (Array.isArray(target)) target.splice(k, 1); else delete target[els[k].key];
    assert.deepEqual(toValue(parsed.root), expected, `${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
    // a comment may go only when it is inside the removed element, or among the comments around it that belong to it
    const el = els[k];
    const from = Math.min(el.start, ...el.leading.map((c) => c.start));
    const to = Math.max(el.end, el.comma ?? 0, ...el.trailing.map((c) => c.end));
    for (const note of notes.filter((x) => !has(out, x))) {
      const o = offsetOf(text, note);
      assert.ok(o >= from && o < to, `${note} was lost from outside element ${k} of ${JSON.stringify(path)}: ${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
    }
    assert.equal(parsed.trailingCommas.length <= parseJsonc(text).trailingCommas.length, true, "no trailing comma is made by a removal");
  }
});

test("1,000 random documents: a replaced value is the new value and the comments stay", () => {
  const r = rng(31);
  for (let n = 0; n < 1000; n++) {
    const value = { model: "m", ...randomValue(r) };
    const { text, notes } = render(value, r, layouts(r));
    const members = collect(root(text), [], []).filter((c) => c.node.type === "object" && c.node.members.length).flatMap((c) => c.node.members.map((m) => ({ ...c, m })));
    if (!members.length) continue;
    const { m, path } = pick(r, members);
    const out = replaceValue(text, m.value, { replaced: [1, 2], s: "x" });
    const parsed = parseJsonc(out);
    assert.equal(parsed.ok, true, `${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
    const expected = structuredClone(toValue(root(text)));
    let target = expected;
    for (const key of path) target = target[key];
    target[m.key] = { replaced: [1, 2], s: "x" };
    assert.deepEqual(toValue(parsed.root), expected);
    // a note inside the replaced value goes with it; every other one stays
    const lost = notes.filter((note) => !has(out, note));
    const inside = lost.filter((note) => offsetOf(text, note) > m.value.start && offsetOf(text, note) < m.value.end);
    assert.deepEqual(lost, inside, `lost from outside the replaced value: ${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
  }
});
