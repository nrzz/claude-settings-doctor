// init: settings.json -> settings.jsonc, every key annotated with what the schema says about it.
//
// The values, the key order and the layout of the values are those of settings.json (written the way build
// writes them, two spaces); above each key that the schema describes there is a comment with its description,
// its type, its default and the values it allows. A key the schema does not list gets a comment that says so.
// Inside a list, only the first item's keys are annotated: the others repeat it.
import { parseJsonc, toValue } from "./jsonc.mjs";
import { deprecation, firstSentence, loadSchema, nearest, vendored } from "./schema.mjs";
import { deprecationAdvice } from "./lint.mjs";

const WIDTH = 100;
const indent = (level) => "  ".repeat(level);

function wrap(text, width) {
  const lines = [];
  for (const para of String(text).replace(/\r/g, "").split(/\n+/)) {
    let line = "";
    for (const word of para.trim().split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** At most `max` characters of a description, cut after a sentence. */
function shorten(text, max = 480) {
  const t = String(text).replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  let out = "";
  for (const s of t.split(/(?<=[.!?])\s+/)) {
    if (out && (out + s).length > max) break;
    out = out ? `${out} ${s}` : s;
  }
  return out.length > max ? `${out.slice(0, max - 3)}...` : out;
}

/**
 * The annotated text for a settings.json text (valid JSON, an object).
 * Returns { text, annotated, unknown } with the number of keys that got a description and that were not in the schema.
 */
export function annotate(jsonText, { schema = vendored(), meta = loadSchema().meta, fileName = "settings.json", sourceName = "settings.jsonc", buildHint = "claude-settings-doctor build" } = {}) {
  const parse = parseJsonc(jsonText);
  const header = [
    `${sourceName} is the commented source of ${fileName}. Claude Code reads ${fileName} only, and a comment in that file makes Claude Code ignore all of it.`,
    `Edit this file, then run: ${buildHint}`,
    `The comments are SchemaStore's descriptions (Apache-2.0), downloaded ${meta.downloaded}; Claude Code can know more keys than the schema does, or fewer.`,
  ].flatMap((paragraph) => wrap(paragraph, WIDTH - 3)).map((l) => `// ${l}`).join("\n");
  if (!parse.ok || parse.root.type !== "object") return { text: `${header}\n{}\n`, annotated: 0, unknown: 0 };

  const data = toValue(parse.root);
  const unknownPaths = new Set(schema.check(data, schema.root, { unknown: true }).issues.filter((i) => i.kind === "unknown-key").map((i) => i.path.map(String).join("\u0000")));
  let annotated = 0;
  let unknown = 0;

  const noteLines = (keyPath, parentPath) => {
    const key = keyPath[keyPath.length - 1];
    if (unknownPaths.has(keyPath.map(String).join("\u0000"))) {
      unknown++;
      const near = nearest(String(key), schema.namesAt(parentPath));
      return wrap(`Not in the schema (downloaded ${meta.downloaded}). Claude Code ignores keys it does not know, without a word.${near.length ? ` Did you mean ${near.map((n) => `"${n}"`).join(" or ")}?` : ""}`, WIDTH - 3);
    }
    const named = schema.namesAt(parentPath).includes(String(key));
    if (!named) return null;
    const hit = schema.nodeAt(keyPath);
    if (!hit) return null;
    const node = hit.node;
    const alt = [...(node.anyOf || []), ...(node.oneOf || [])].map((a) => schema.resolve(a)).find((a) => a && a.description);
    const description = typeof node.description === "string" ? node.description : alt ? alt.description : "";
    const lines = [];
    const dep = deprecation(node);
    if (dep) lines.push(...wrap(`DEPRECATED: ${deprecationAdvice(node)}`, WIDTH - 3));
    let body = dep ? String(description).replace(/^deprecated[.:]?\s*/i, "") : description;
    // the advice is already the first line ("Use 'attribution' instead."): do not say it twice
    if (dep) { const advice = deprecationAdvice(node); if (body.startsWith(advice)) body = body.slice(advice.length).trim(); }
    if (body) lines.push(...wrap(shorten(body), WIDTH - 3));
    const kind = schema.typeText(node);
    const facts = [kind.startsWith("one of") ? `${kind.replace("one of", "allowed:")}` : `type: ${kind}`];
    if (node.default !== undefined) facts.push(`default: ${JSON.stringify(node.default)}`);
    lines.push(...wrap(facts.join("; "), WIDTH - 3));
    annotated++;
    return lines;
  };

  const emit = (node, level, keyPath, notes) => {
    if (node.type === "object") {
      if (node.members.length === 0) return "{}";
      const pad = indent(level + 1);
      const blocks = node.members.map((m, i) => {
        const childPath = [...keyPath, m.key];
        const lines = notes ? noteLines(childPath, keyPath) : null;
        let block = "";
        if (lines && lines.length) block += `${i > 0 ? "\n" : ""}${lines.map((l) => `${pad}// ${l}`).join("\n")}\n`;
        return `${block}${pad}${m.keyRaw}: ${emit(m.value, level + 1, childPath, notes)}`;
      });
      return `{\n${blocks.join(",\n")}\n${indent(level)}}`;
    }
    if (node.type === "array") {
      if (node.items.length === 0) return "[]";
      const pad = indent(level + 1);
      return `[\n${node.items.map((item, i) => `${pad}${emit(item, level + 1, [...keyPath, i], notes && i === 0)}`).join(",\n")}\n${indent(level)}]`;
    }
    return node.raw;
  };

  return { text: `${header}\n${emit(parse.root, 0, [], true)}\n`, annotated, unknown };
}
