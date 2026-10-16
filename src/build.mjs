// settings.jsonc -> settings.json, as text. The commented source is read with src/jsonc.mjs; the output has
// no comments and no trailing commas, the keys in the order they were written, two-space indentation, one
// array item or key per line, and a final newline. Numbers and strings are written as they were written, so
// nothing but the layout changes. This is the one definition of "what build would write": `build` writes it,
// `check` compares with it, and the lint says when settings.json is behind it.
import { parseJsonc, positionAt } from "./jsonc.mjs";

const indent = (level) => "  ".repeat(level);

/** The plain JSON text of a tree: two-space layout, raw scalars, no comments. */
export function emitJson(node, level = 0) {
  if (node.type === "object") {
    if (node.members.length === 0) return "{}";
    const lines = node.members.map((m) => `${indent(level + 1)}${m.keyRaw}: ${emitJson(m.value, level + 1)}`);
    return `{\n${lines.join(",\n")}\n${indent(level)}}`;
  }
  if (node.type === "array") {
    if (node.items.length === 0) return "[]";
    const lines = node.items.map((item) => `${indent(level + 1)}${emitJson(item, level + 1)}`);
    return `[\n${lines.join(",\n")}\n${indent(level)}]`;
  }
  return node.raw;
}

/**
 * What build writes for this settings.jsonc text.
 * { ok: true, text, parse } or { ok: false, problems: [{ kind, message, line, column }], parse }.
 * It refuses (ok: false) a text that is not JSON with comments, that is not an object, or that repeats a key:
 * Claude Code keeps only the last of a repeated key, so a build would quietly drop the first.
 */
export function buildFromJsonc(text) {
  const parse = parseJsonc(text);
  const problems = [];
  const at = (offset) => positionAt(text, offset);
  if (!parse.ok) {
    problems.push({ kind: "syntax", message: parse.error.message, offset: parse.error.offset, ...at(parse.error.offset) });
    return { ok: false, problems, parse };
  }
  if (parse.root.type !== "object") {
    problems.push({ kind: "not-object", message: "the file does not hold an object ({ ... })", offset: parse.root.start, ...at(parse.root.start) });
    return { ok: false, problems, parse };
  }
  for (const d of parse.duplicates) {
    const where = [...d.path, d.key].map((p) => (typeof p === "number" ? `[${p}]` : p)).join(".").replace(/\.\[/g, "[");
    problems.push({ kind: "duplicate-key", message: `"${where}" is written twice (lines ${at(d.firstStart).line} and ${at(d.start).line}); Claude Code keeps only the last, so build will not choose for you`, offset: d.start, ...at(d.start), key: d.key });
  }
  if (problems.length) return { ok: false, problems, parse };
  return { ok: true, text: `${emitJson(parse.root)}\n`, parse };
}
