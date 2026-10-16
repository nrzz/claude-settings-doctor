// Changing a settings.jsonc by editing its text, so that nothing else in it moves: the comments, the blank
// lines, the indentation, the line endings and the order of the keys stay as they are. (Parse, change,
// stringify would throw the comments away, which is the one thing a settings.jsonc is for.)
//
// The edit functions take the text and a node of that text (from parseJsonc in src/jsonc.mjs) and return the
// new text. After an edit the old nodes are out of date: parse again before the next one.
//
// A member or an item is removed together with the comments that belong to it: the comment lines right above it
// (with no blank line between) and a comment after it on its own line.
import { findMember } from "./jsonc.mjs";

/** { eol, unit }: "\r\n" when most line breaks are, and one level of indentation (a tab, or the smallest indentation). */
export function styleOf(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  let tabs = false;
  let least = Infinity;
  for (const m of text.matchAll(/^([ \t]+)\S/gm)) {
    if (m[1].includes("\t")) tabs = true;
    else least = Math.min(least, m[1].length);
  }
  return { eol: crlf > lf ? "\r\n" : "\n", unit: tabs ? "\t" : " ".repeat(Number.isFinite(least) ? Math.min(least, 8) : 2) };
}

const lineStart = (text, pos) => text.lastIndexOf("\n", pos - 1) + 1;
const lineEnd = (text, pos) => { const i = text.indexOf("\n", pos); return i === -1 ? text.length : i + 1; };
const indentOf = (text, pos) => /^[ \t]*/.exec(text.slice(lineStart(text, pos)))[0];
const startsLine = (text, pos) => /^[ \t]*$/.test(text.slice(lineStart(text, pos), pos));
const restOfLineBlank = (text, pos) => /^[ \t]*(\r?\n|$)/.test(text.slice(pos));

/** A JSON value written in the file's style, its continuation lines starting with `indent`. */
const pretty = (value, indent, st) => JSON.stringify(value, null, st.unit).replace(/\n/g, st.eol + indent);

const elementsOf = (node) => (node.type === "object" ? node.members : node.items);
const afterComma = (el) => (el.comma !== null ? el.comma + 1 : el.end);
const trailingEnd = (el) => (el.trailing.length ? Math.max(afterComma(el), el.trailing[el.trailing.length - 1].end) : afterComma(el));

/** Where the line of an element ends: after its comma and its trailing comments, past the line break. */
const elementLineEnd = (text, el) => lineEnd(text, trailingEnd(el));

// text.slice(0, at) + insert + text.slice(at), for several inserts, the later ones first so offsets hold
function insertAll(text, inserts) {
  let out = text;
  for (const { at, text: t } of [...inserts].sort((a, b) => b.at - a.at)) out = out.slice(0, at) + t + out.slice(at);
  return out;
}

/**
 * Add an element (`key` and `value` for an object, `value` alone for an array) after the last one.
 * The new element follows the style of the container: on its own line in a container written over several
 * lines, after a comma in one written on a line; and a container whose last element had a trailing comma gets
 * its new element with one too.
 */
function insertElement(text, container, render, st) {
  const els = elementsOf(container);
  const open = container.type === "object" ? "{" : "[";
  const close = container.type === "object" ? "}" : "]";
  const closeAt = container.end - 1;
  const parentIndent = indentOf(text, container.start);
  if (els.length === 0) {
    const inner = text.slice(container.start + 1, closeAt);
    const indent = parentIndent + st.unit;
    if (inner.trim() === "") return `${text.slice(0, container.start)}${open}${st.eol}${indent}${render(indent)}${st.eol}${parentIndent}${close}${text.slice(container.end)}`;
    // only comments inside: the new element goes after them
    if (startsLine(text, closeAt)) return `${text.slice(0, lineStart(text, closeAt))}${indent}${render(indent)}${st.eol}${text.slice(lineStart(text, closeAt))}`;
    return `${text.slice(0, closeAt)}${st.eol}${indent}${render(indent)}${st.eol}${parentIndent}${text.slice(closeAt)}`;
  }
  const last = els[els.length - 1];
  const multiline = text.slice(container.start + 1, els[0].start).includes("\n");
  if (!multiline) {
    // a container on one line: ", value" after the last element (before a trailing comma, if there is one), the value on one line too
    return insertAll(text, [{ at: last.end, text: `, ${render("", true)}` }]);
  }
  const indent = startsLine(text, last.start) ? indentOf(text, last.start) : indentOf(text, els[0].start);
  const eolAt = elementLineEnd(text, last);
  const body = `${indent}${render(indent)}`;
  const inserts = [];
  // the line break after the last element's line is part of that line; the new line ends with its own break
  const lastLineHasBreak = text.slice(0, eolAt).endsWith("\n");
  const newLine = last.comma !== null ? `${body},` : body;
  if (last.comma === null) inserts.push({ at: last.end, text: "," });
  if (lastLineHasBreak) inserts.push({ at: eolAt, text: `${newLine}${st.eol}` });
  else inserts.push({ at: eolAt, text: `${st.eol}${newLine}` });
  return insertAll(text, inserts);
}

/** Add `"key": value` to an object node (after its last member, in the layout of the others). */
export function insertMember(text, obj, key, value, st = styleOf(text)) {
  return insertElement(text, obj, (indent, compact) => `${JSON.stringify(key)}: ${compact ? JSON.stringify(value) : pretty(value, indent, st)}`, st);
}

/** Add a value to an array node. */
export function insertItem(text, arr, value, st = styleOf(text)) {
  return insertElement(text, arr, (indent, compact) => (compact ? JSON.stringify(value) : pretty(value, indent, st)), st);
}

/** Replace the value of a node with a new JSON value (the comments around it stay). */
export function replaceValue(text, node, value, st = styleOf(text)) {
  const indent = indentOf(text, node.start);
  return `${text.slice(0, node.start)}${pretty(value, indent, st)}${text.slice(node.end)}`;
}

/**
 * Take the k-th element out of an object or array node. The comments right above it and after it on its line
 * go with it. Taking out the last element that had no comma also takes the previous element's comma, so no
 * comma is left dangling.
 */
export function removeElement(text, container, k) {
  const els = elementsOf(container);
  const el = els[k];
  const prev = els[k - 1];
  const next = els[k + 1];
  const alone = startsLine(text, el.start) && restOfLineBlank(text, trailingEnd(el));
  if (alone) {
    let from = lineStart(text, el.start);
    // the comments above it that belong to it: each on its own line, with no blank line in between
    const own = el.leading.filter((c) => startsLine(text, c.start));
    let cursor = el.start;
    const attached = [];
    for (let i = own.length - 1; i >= 0; i--) {
      if (/^[ \t]*\r?\n[ \t]*$/.test(text.slice(own[i].end, cursor))) { attached.unshift(own[i]); cursor = own[i].start; } else break;
    }
    if (attached.length) from = lineStart(text, attached[0].start);
    const to = lineEnd(text, trailingEnd(el));
    let out = text.slice(0, from) + text.slice(to);
    if (!next && el.comma === null && prev && prev.comma !== null) out = out.slice(0, prev.comma) + out.slice(prev.comma + 1);
    return out;
  }
  // an element sharing its line with others
  if (els.length === 1) return text.slice(0, container.start + 1) + text.slice(container.end - 1);
  if (next) return text.slice(0, el.start) + text.slice(next.start);
  return text.slice(0, prev.end) + text.slice(el.end);
}

/**
 * The node at a key path of a tree, and the member that holds it: { node, member, parent } or null. A number in the
 * path is the index of an item of a list; the member and the parent then stay those of the last object passed.
 */
export function nodeAtPath(root, keyPath) {
  let node = root;
  let member = null;
  let parent = null;
  for (const seg of keyPath) {
    if (!node) return null;
    if (node.type === "object") {
      const m = findMember(node, seg);
      if (!m) return null;
      parent = node;
      member = m;
      node = m.value;
    } else if (node.type === "array" && Number.isInteger(seg) && node.items[seg]) {
      node = node.items[seg];
    } else return null;
  }
  return { node, member, parent };
}
