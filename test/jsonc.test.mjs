// The JSONC reader: positions, comments, trailing commas, duplicate keys, the first error, and that on text with
// neither comments nor trailing commas it accepts exactly what JSON.parse accepts.
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { findMember, parseJsonc, positionAt, setOwn, toValue } from "../src/jsonc.mjs";

// A small seeded generator, so a failure can be repeated.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("an object, an array and the scalars: values, raw text and offsets", () => {
  const text = '{"a": 1, "b": [true, null, "x\\ny"], "c": {"d": -2.5e3}}';
  const r = parseJsonc(text);
  assert.equal(r.ok, true);
  assert.deepEqual(toValue(r.root), JSON.parse(text));
  const a = findMember(r.root, "a");
  assert.equal(a.value.raw, "1");
  assert.equal(text.slice(a.value.start, a.value.end), "1");
  assert.equal(text.slice(a.keyStart, a.keyStart + 3), '"a"');
  const b = findMember(r.root, "b").value;
  assert.deepEqual(b.items.map((x) => x.type), ["literal", "literal", "string"]);
  assert.equal(b.items[2].value, "x\ny");
  assert.equal(b.items[2].raw, '"x\\ny"');
  const d = findMember(findMember(r.root, "c").value, "d").value;
  assert.equal(d.raw, "-2.5e3");
  assert.equal(d.value, -2500);
  assert.equal(r.comments.length, 0);
  assert.equal(r.trailingCommas.length, 0);
  assert.equal(r.duplicates.length, 0);
});

test("comments of both kinds are recorded with their offsets", () => {
  const text = '// first\n{\n  /* second */ "a": 1, // third\n  "b": 2\n}\n';
  const r = parseJsonc(text);
  assert.equal(r.ok, true);
  assert.deepEqual(r.comments.map((c) => [c.kind, text.slice(c.start, c.end)]), [["line", "// first"], ["block", "/* second */"], ["line", "// third"]]);
});

test("comments are attached: leading, trailing on the same line, and dangling after the last element", () => {
  const text = [
    "{",
    "  // about a",
    "  // still about a",
    '  "a": 1, // after a',
    "",
    "  /* about b */",
    '  "b": [',
    "    // first item",
    "    1, // one",
    "    2",
    "    // after the items",
    "  ]",
    "  // after b",
    "}",
  ].join("\n");
  const r = parseJsonc(text);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const src = (cs) => cs.map((c) => text.slice(c.start, c.end));
  const [a, b] = r.root.members;
  assert.deepEqual(src(a.leading), ["// about a", "// still about a"]);
  assert.deepEqual(src(a.trailing), ["// after a"]);
  assert.deepEqual(src(b.leading), ["/* about b */"]);
  assert.deepEqual(src(b.trailing), []);
  assert.deepEqual(src(r.root.dangling), ["// after b"]);
  const [one, two] = b.value.items;
  assert.deepEqual(src(one.leading), ["// first item"]);
  assert.deepEqual(src(one.trailing), ["// one"]);
  assert.deepEqual(src(two.trailing), []);
  assert.deepEqual(src(b.value.dangling), ["// after the items"]);
});

test("a comment inside an empty object or array is dangling", () => {
  const r = parseJsonc('{"a": {\n  // nothing yet\n}, "b": [ /* none */ ]}');
  assert.equal(r.ok, true);
  assert.equal(findMember(r.root, "a").value.dangling.length, 1);
  assert.equal(findMember(r.root, "b").value.dangling.length, 1);
});

test("trailing commas are noted, in objects and in arrays, also before a comment", () => {
  const text = '{\n  "a": [1, 2,],\n  "b": {"c": 1, // note\n  },\n}\n';
  const r = parseJsonc(text);
  assert.equal(r.ok, true);
  assert.deepEqual(r.trailingCommas.map((o) => text[o]), [",", ",", ","]);
  assert.deepEqual(r.trailingCommas.map((o) => positionAt(text, o).line), [2, 3, 4]);
});

test("a repeated key is reported with both places and the path of its object; the last one is the value", () => {
  const text = '{"env": {"A": "1", "A": "2"}, "x": 1, "x": 2}';
  const r = parseJsonc(text);
  assert.equal(r.ok, true);
  assert.deepEqual(r.duplicates.map((d) => [d.key, d.path]), [["A", ["env"]], ["x", []]]);
  const d = r.duplicates[0];
  assert.ok(d.firstStart < d.start);
  assert.equal(text.slice(d.start, d.start + 3), '"A"');
  assert.deepEqual(toValue(r.root), JSON.parse(text));
  assert.equal(toValue(r.root).x, 2);
});

test("positionAt gives 1-based lines and columns, counting the BOM as a character", () => {
  const text = "ab\ncd\r\nef";
  assert.deepEqual(positionAt(text, 0), { line: 1, column: 1 });
  assert.deepEqual(positionAt(text, 3), { line: 2, column: 1 });
  assert.deepEqual(positionAt(text, 7), { line: 3, column: 1 });
  const r = parseJsonc("﻿{\n  \"a\": 1,\n}");
  assert.equal(r.bom, true);
  assert.equal(r.ok, true);
  const a = r.root.members[0];
  assert.deepEqual(positionAt(r.text, a.keyStart), { line: 2, column: 3 });
  assert.equal(r.text.slice(a.value.start, a.value.end), "1");
});

const BAD = [
  ["", "the file is empty"],
  ["   \n", "the file is empty"],
  ["// only a comment", "only comments"],
  ["{", "before the object is closed"],
  ['{"a": 1', "before the object is closed"],
  ['{"a" 1}', 'expected ":"'],
  ["{'a': 1}", "single quotes"],
  ["{a: 1}", "double quotes"],
  ['{"a": 1,, "b": 2}', "comma with nothing before"],
  ['{"a": }', "unexpected"],
  ['{"a": 1 "b": 2}', 'expected ","'],
  ["[1, 2", "before the array is closed"],
  ["[,1]", "comma with nothing before"],
  ['{"a": NaN}', "NaN is not JSON"],
  ['{"a": undefined}', "undefined is not JSON"],
  ['{"a": 01}', "start with a zero"],
  ['{"a": 1.}', "digits after the point"],
  ['{"a": +1}', "not a valid number"],
  ['{"a": .5}', "not a valid number"],
  ['{"a": 1e}', "exponent"],
  ['{"a": "x}', "never closed"],
  ['{"a": "line\nbreak"}', "line break"],
  ['{"a": "\\x"}', "not a JSON escape"],
  ['{"a": "\\u12"}', "four hexadecimal"],
  ['{"a": 1} {"b": 2}', "more text"],
  ['{"a": 1} x', "more text"],
  ["/* never closed", "never closed"],
  ['{"a": tru}', "unexpected"],
  ['{"a": nulll}', "expected"],
];
for (const [text, expect] of BAD) {
  test(`not JSON, said in words: ${JSON.stringify(text).slice(0, 40)}`, () => {
    const r = parseJsonc(text);
    assert.equal(r.ok, false);
    assert.equal(r.root, null);
    assert.ok(r.error && Number.isInteger(r.error.offset), "an offset");
    assert.match(r.error.message, new RegExp(expect));
    assert.throws(() => JSON.parse(text), "JSON.parse rejects it too");
  });
}

test("the offset of an error points at the problem", () => {
  const text = '{\n  "a": 1,\n  "b": x\n}';
  const r = parseJsonc(text);
  assert.equal(text[r.error.offset], "x");
  assert.deepEqual(positionAt(text, r.error.offset), { line: 3, column: 8 });
});

test("a key called __proto__ is an ordinary key and pollutes nothing", () => {
  const text = '{"__proto__": {"polluted": true}, "a": 1}';
  const r = parseJsonc(text);
  assert.equal(r.ok, true);
  const v = toValue(r.root);
  assert.equal(Object.getPrototypeOf(v), Object.prototype);
  assert.equal(Object.hasOwn(v, "__proto__"), true);
  assert.equal({}.polluted, undefined);
  assert.equal(setOwn({}, "__proto__", 1).__proto__, 1);
});

test("depth: 500 levels are read, 501 are refused politely, and nothing throws", () => {
  const nest = (d) => `${"[".repeat(d)}${"]".repeat(d)}`;
  assert.equal(parseJsonc(nest(500)).ok, true);
  const deep = parseJsonc(nest(501));
  assert.equal(deep.ok, false);
  assert.match(deep.error.message, /nested/);
  assert.equal(parseJsonc("[".repeat(100000)).ok, false);
  assert.equal(parseJsonc(`{"a":${"{\"a\":".repeat(5000)}1${"}".repeat(5001)}`).ok, false);
});

test("a very long string and a very long file are read", () => {
  const big = "x".repeat(300000);
  const r = parseJsonc(`{"a": "${big}"}`);
  assert.equal(r.ok, true);
  assert.equal(toValue(r.root).a.length, 300000);
  const many = `{\n${Array.from({ length: 20000 }, (_, k) => `"k${k}": ${k}, // c${k}`).join("\n")}\n}`;
  const t0 = Date.now();
  const m = parseJsonc(many);
  assert.equal(m.ok, true);
  assert.equal(m.root.members.length, 20000);
  assert.equal(m.comments.length, 20000);
  assert.ok(Date.now() - t0 < 5000, "comment attachment is not quadratic");
});

// Random JSON: written with different layouts, the reader gives back the same value as JSON.parse.
function randomValue(r, depth = 0) {
  const pick = r();
  if (depth > 3 || pick < 0.35) {
    const kind = Math.floor(r() * 6);
    if (kind === 0) return null;
    if (kind === 1) return r() < 0.5;
    if (kind === 2) return Math.floor((r() - 0.5) * 2000);
    if (kind === 3) return (r() - 0.5) * 1e6;
    if (kind === 4) return ["", "a", "ü€", "line\nbreak", 'quote"slash\\', " "][Math.floor(r() * 6)];
    return `s${Math.floor(r() * 100)}`;
  }
  if (pick < 0.65) return Array.from({ length: Math.floor(r() * 5) }, () => randomValue(r, depth + 1));
  const o = {};
  for (let k = Math.floor(r() * 5); k > 0; k--) o[`k${Math.floor(r() * 20)}`] = randomValue(r, depth + 1);
  return o;
}

test("500 random documents, in four layouts, read the way JSON.parse reads them", () => {
  const r = rng(12345);
  for (let n = 0; n < 500; n++) {
    const v = randomValue(r);
    for (const indent of [undefined, 2, 4, "\t"]) {
      const text = JSON.stringify(v, null, indent);
      const parsed = parseJsonc(text);
      assert.equal(parsed.ok, true, text);
      assert.deepEqual(toValue(parsed.root), JSON.parse(text), text);
      assert.equal(parsed.comments.length + parsed.trailingCommas.length + parsed.duplicates.length, 0, text);
    }
  }
});

// Random damage: with no comment and no trailing comma, the reader accepts what JSON.parse accepts.
test("5000 damaged documents are accepted or refused exactly as JSON.parse does", () => {
  const r = rng(777);
  const pieces = ["{", "}", "[", "]", ",", ":", '"', "'", "/", "*", "\\", " ", "\n", "0", "1", "-", ".", "e", "t", "n", "u", "x", " ", "\t", "\r"];
  let accepted = 0;
  for (let n = 0; n < 5000; n++) {
    let text = JSON.stringify(randomValue(r), null, r() < 0.5 ? 2 : undefined);
    for (let k = Math.floor(r() * 4) + 1; k > 0; k--) {
      const at = Math.floor(r() * (text.length + 1));
      const op = r();
      if (op < 0.4) text = text.slice(0, at) + pieces[Math.floor(r() * pieces.length)] + text.slice(at);
      else if (op < 0.8) text = text.slice(0, at) + text.slice(at + 1 + Math.floor(r() * 3));
      else text = text.slice(0, at);
    }
    const mine = parseJsonc(text);
    const strict = mine.ok && mine.comments.length === 0 && mine.trailingCommas.length === 0;
    let theirs = true;
    try { JSON.parse(text); } catch { theirs = false; }
    assert.equal(strict, theirs, `${JSON.stringify(text)}: this reader says ${strict}, JSON.parse says ${theirs}`);
    if (strict) accepted++;
  }
  assert.ok(accepted > 100 && accepted < 4900, `a useful mix: ${accepted} accepted`);
});
