// Findings about settings files. Each has an id, a severity, the file, line and key path, a message that says
// what is wrong and what Claude Code does about it, and sometimes a fix. What Claude Code does is what the real
// binary was seen to do (src/facts.mjs, the README's "What was verified"); where nothing was observed the
// message says what the schema says and no more.
//
//   invalid-json       the file is not strict JSON (a comment, a trailing comma, any other mistake): Claude Code ignores it
//   not-an-object      valid JSON, but not an object: ignored
//   duplicate-key      a key written twice in one object: Claude Code keeps the last
//   unknown-key        a key the schema does not list: ignored without a word (a typo, or newer than the schema)
//   wrong-type         a value of the wrong type: ignored (the whole file, for most keys)
//   bad-value          a value outside the schema's list, range or pattern
//   deprecated         a key the schema marks deprecated
//   env-not-string     an env value that is not a string: Claude Code turns it into one
//   hook-event         a hook event name Claude Code does not know: ignored
//   hook-shape         a hook group or entry of the wrong shape: ignored, and for PreToolUse and PermissionRequest the whole file
//   hook-matcher       a hook matcher that is not a valid regular expression: it never matches
//   jsonc-out-of-date  settings.jsonc and settings.json disagree
//   unreadable         the file cannot be read
//   not-checked        something the checker cannot judge, said once per file
import fs from "node:fs";
import { buildFromJsonc } from "./build.mjs";
import { BOUNDS_ENFORCED, ENUM_EXTRA, ENUM_REJECTED, FIELD_LEVEL, HOOK_EVENTS, HOOK_TYPES, NULL_OK, TYPE_EXTRA, WHOLE_FILE_EVENTS, isUnchecked } from "./facts.mjs";
import { findMember, positionAt, setOwn, toValue } from "./jsonc.mjs";
import { article, deprecation, firstSentence, jsonType, loadSchema, nearest, vendored } from "./schema.mjs";

export const SEVERITY_ORDER = { error: 0, warning: 1, note: 2 };

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A key path written for people: hooks.SessionStart[0].hooks[0].timeout, or ["odd.key"] for a key with a dot. */
export function formatPath(keyPath) {
  let out = "";
  for (const seg of keyPath) {
    if (typeof seg === "number") out += `[${seg}]`;
    else if (/^[A-Za-z_$@][\w$@-]*$/.test(seg)) out += out ? `.${seg}` : seg;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out || "(the whole file)";
}

/** The reverse, for `explain`: "hooks.PreToolUse[0].matcher" or "hooks.PreToolUse.0.matcher" -> segments. */
export function parsePath(text) {
  const out = [];
  const re = /\[(?:"((?:[^"\\]|\\.)*)"|(\d+)|\*)\]|\.?([^.[\]]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) out.push(JSON.parse(`"${m[1]}"`));
    else if (m[2] !== undefined) out.push(Number(m[2]));
    else if (m[0] === "[*]") out.push("*");
    else out.push(m[3]);
  }
  return out;
}

/** Offset in the text of the value (or the key) at a key path, as far down as the text goes. */
export function locate(root, keyPath, at = "value") {
  let node = root;
  let offset = root ? root.start : 0;
  for (let i = 0; i < keyPath.length && node; i++) {
    const seg = keyPath[i];
    const last = i === keyPath.length - 1;
    if (node.type === "object") {
      const m = findMember(node, seg);
      if (!m) break;
      offset = last && at === "key" ? m.keyStart : m.value.start;
      node = m.value;
    } else if (node.type === "array" && typeof seg === "number" && node.items[seg]) {
      node = node.items[seg];
      offset = node.start;
    } else break;
  }
  return offset;
}

const quote = (s) => JSON.stringify(s);
const valueText = (v) => { const t = JSON.stringify(v); return t === undefined ? String(v) : t.length > 40 ? `${t.slice(0, 37)}...` : t; };

/**
 * Lint one loaded settings file (see settings.mjs loadSettings) or, with jsonc: true, a settings.jsonc source,
 * where comments and trailing commas are fine.
 * Returns { findings, notChecked, effective } where effective is what Claude Code would use of the file:
 *   { data, ignored: null | { reason }, removed: [{ path, effect, why }] }
 */
export function lintFile(file, { schema = vendored(), meta = loadSchema().meta, jsonc = false } = {}) {
  const findings = [];
  const text = file.text || "";
  const effective = { data: null, ignored: null, removed: [], coerced: [] };
  const base = { scope: file.scope, file: file.path, display: file.display };
  const place = (offset) => (text ? positionAt(text, offset) : { line: null, column: null });
  const add = (id, severity, effect, keyPath, message, extra = {}) => {
    const offset = extra.offset !== undefined ? extra.offset : analysis && analysis.parse.root ? locate(analysis.parse.root, keyPath, extra.at || "value") : 0;
    const { line, column } = place(offset);
    const f = { id, severity, effect, ...base, line, column, path: formatPath(keyPath), keyPath, message, ...extra };
    delete f.offset;
    delete f.at;
    findings.push(f);
    return f;
  };
  const schemaNote = `the schema is SchemaStore's, downloaded ${meta.downloaded}`;

  if (file.readError) {
    add("unreadable", "error", "file", [], `The file ${file.readError}, so Claude Code cannot use it either.`, { offset: 0 });
    effective.ignored = { reason: file.readError };
    return { findings, notChecked: [], effective };
  }
  const analysis = file.analysis;
  if (!analysis) return { findings, notChecked: [], effective };

  // --- syntax: what makes Claude Code ignore the whole file -------------------------------------------------
  let data = null;
  if (jsonc) {
    if (analysis.empty) data = {};
    else if (!analysis.parse.ok) add("invalid-json", "error", "none", [], `Not valid JSON, even for a .jsonc file, at line ${place(analysis.parse.error.offset).line}, column ${place(analysis.parse.error.offset).column}: ${analysis.parse.error.message}.`, { offset: analysis.parse.error.offset });
    else if (analysis.parse.root.type !== "object") add("not-an-object", "error", "none", [], "The file does not hold an object ({ ... }).", { offset: analysis.parse.root.start });
    else data = toValue(analysis.parse.root);
  } else {
    for (const p of analysis.problems) {
      const lines = p.lines ? ` (${p.lines.length === 1 ? "line" : "lines"} ${p.lines.slice(0, 6).join(", ")}${p.lines.length > 6 ? ", ..." : ""})` : "";
      if (p.kind === "syntax") {
        add("invalid-json", "error", "file", [], `Not valid JSON, at line ${p.line}, column ${p.column}: ${p.message}. Claude Code ignores the whole file: none of its settings apply (claude doctor says "Invalid or malformed JSON").`, { offset: p.offset });
      } else if (p.kind === "comment") {
        add("invalid-json", "error", "file", [], `The file has ${p.message}${lines}. Claude Code ignores the whole file: none of its settings apply (claude doctor says "Invalid or malformed JSON").`, { offset: p.offset, fix: "Keep the notes in a settings.jsonc and write settings.json with claude-settings-doctor build, or delete the comments." });
      } else if (p.kind === "trailing-comma") {
        add("invalid-json", "error", "file", [], `The file has ${p.message}${lines}. Claude Code ignores the whole file: none of its settings apply (claude doctor says "Invalid or malformed JSON").`, { offset: p.offset, fix: "Delete the comma before the closing bracket." });
      } else {
        add("not-an-object", "error", "file", [], `${p.message[0].toUpperCase()}${p.message.slice(1)}. Claude Code ignores the file (claude doctor says "Expected object").`, { offset: p.offset });
      }
    }
    if (analysis.ignored) {
      effective.ignored = { reason: analysis.problems[0].kind === "comment" ? "it has a comment" : analysis.problems[0].kind === "trailing-comma" ? "it has a trailing comma" : analysis.problems[0].kind === "not-object" ? "it is not an object" : "it is not valid JSON" };
      // a file with only comments or commas wrong can still be read for its other mistakes
      data = analysis.parse.ok && analysis.parse.root.type === "object" ? toValue(analysis.parse.root) : null;
    } else data = analysis.data;
  }
  if (analysis.empty && !jsonc) add("empty-file", "note", "none", [], "The file is empty, so it sets nothing.", { offset: 0 });

  const notChecked = [];
  if (data === null) {
    effective.ignored = effective.ignored || { reason: "it cannot be read as an object" };
    return { findings, notChecked, effective };
  }

  // --- duplicate keys: JSON.parse keeps the last -------------------------------------------------------------
  const root = analysis.parse.root;
  for (const d of analysis.parse.duplicates) {
    const first = place(d.firstStart).line;
    const second = place(d.start).line;
    const keyPath = [...d.path, d.key];
    add("duplicate-key", "warning", "key", keyPath, `${quote(d.key)} is written twice (lines ${first} and ${second}). Claude Code keeps the last one and loses everything in the first, without a word.`, { offset: d.start, fix: "Merge the two into one, or delete the one you do not mean." });
  }

  // --- the schema -------------------------------------------------------------------------------------------
  const checked = schema.check(data, schema.root, { unknown: true });
  notChecked.push(...checked.notChecked);
  const valueAt = (keyPath) => keyPath.reduce((v, k) => (v === undefined || v === null ? undefined : v[k]), data);
  // where the binary and the schema disagree about a list of values, the binary wins
  const issues = checked.issues.filter((i) => !(i.kind === "enum" && (ENUM_EXTRA[i.path.join(".")] || []).includes(valueAt(i.path))) && !(i.kind === "type" && (TYPE_EXTRA[i.path.join(".")] || []).includes(i.found)) && !(i.kind === "type" && i.found === "null" && i.path.length === 1 && NULL_OK.has(i.path[0])));
  for (const [dotted, values] of Object.entries(ENUM_REJECTED)) {
    const keyPath = dotted.split(".");
    const v = valueAt(keyPath);
    if (typeof v === "string" && values.includes(v)) issues.push({ path: keyPath, kind: "enum", message: `${JSON.stringify(v)} is allowed by the schema but not by Claude Code 2.1.295` });
  }
  const removed = effective.removed;
  for (const issue of issues) {
    const keyPath = issue.path;
    if (keyPath[0] === "hooks") continue; // judged below, in the words Claude Code uses
    const name = quote(keyPath.filter((p) => typeof p === "string").slice(-1)[0] ?? "");
    const here = formatPath(keyPath);
    const top = keyPath[0];
    const unchecked = isUnchecked(keyPath);
    const value = keyPath.reduce((v, k) => (v === undefined || v === null ? undefined : v[k]), data);

    if (issue.kind === "unknown-key") {
      const parent = keyPath.slice(0, -1);
      const key = keyPath[keyPath.length - 1];
      const names = schema.namesAt(parent);
      const near = nearest(String(key), names);
      const where = parent.length ? ` in ${formatPath(parent)}` : "";
      const hint = near.length ? ` Did you mean ${near.map(quote).join(" or ")}?` : " If it is new, the schema may lag a release: check the name in the docs.";
      add("unknown-key", "warning", "key", keyPath, `${quote(key)} is not in the schema${where} (${schemaNote}). Claude Code ignores keys it does not know, without a word.${hint}`, { at: "key", suggestions: near });
      continue;
    }
    if (issue.kind === "deprecated") {
      add("deprecated", "warning", "none", keyPath, `${quote(keyPath[keyPath.length - 1])} is deprecated: ${deprecationAdvice(issue.node)}`, { at: "key" });
      continue;
    }
    if (issue.kind === "unique") {
      add("duplicate-item", "note", "none", keyPath, `${here} repeats item ${issue.of}; the list needs it only once.`);
      continue;
    }
    if (top === "env" && keyPath.length === 2) {
      if (issue.kind === "type" && value !== undefined) {
        const as = String(value);
        add("env-not-string", "warning", "coerced", keyPath, `${name} is ${article(jsonType(value))}; Claude Code turns it into the string ${quote(as)}${isPlain(value) || Array.isArray(value) ? ", which is probably not what you meant" : ""}. Write it as a string.`);
        effective.coerced.push({ path: keyPath, from: value, to: as });
        continue;
      }
      if (issue.kind === "pattern") {
        add("env-name", "note", "none", keyPath, `${name} is not an upper-case name (the schema asks for ^[A-Z_][A-Z0-9_]*$). Claude Code passes it on all the same.`, { at: "key" });
        continue;
      }
    }
    if (top === "permissions" && keyPath.length === 3 && ["allow", "ask", "deny"].includes(keyPath[1])) {
      if (issue.kind === "type") {
        add("wrong-type", "error", "entry", keyPath, `${here} should be a string, found ${article(issue.found)}. Claude Code removes it from the list (claude doctor: "Non-string value in ${keyPath[1]} array was removed").`);
        removed.push({ path: keyPath, effect: "entry", why: "not a string" });
        continue;
      }
      if (issue.kind === "pattern") {
        add("bad-value", "warning", "entry", keyPath, `${here} is ${valueText(value)}, which does not fit the schema's pattern for a permission rule (a tool name, then optional parentheses). Claude Code may skip it; claude-permission-doctor checks rules the way Claude Code does.`);
        continue;
      }
    }

    // everything else: a value that is not what the schema wants
    const kind = issue.kind === "type" || issue.kind === "required" || issue.kind === "any" ? "wrong-type" : "bad-value";
    const field = FIELD_LEVEL.has(top);
    const mine = issue.kind === "required" ? `${here === "(the whole file)" ? "the file" : here} ${issue.message}` : `${here} ${issue.message}`;
    if (issue.kind === "pattern" && !field) {
      add("bad-value", "warning", "none", keyPath, `${mine}. The schema asks for this; Claude Code may not mind (claude doctor says whether it does).`);
    } else if (unchecked || (["range", "items", "length"].includes(issue.kind) && !(keyPath.length === 1 && BOUNDS_ENFORCED.has(top)))) {
      add(kind, "warning", "none", keyPath, `${mine}. The schema asks for this, but Claude Code 2.1.295 accepts it without a word.`);
    } else if (field && top === "extraKnownMarketplaces" && keyPath.length >= 2) {
      // a marketplace that is wrong costs that marketplace only (claude doctor: "Invalid marketplace entry was ignored")
      add(kind, "error", "entry", keyPath, `${mine}. Claude Code ignores this entry and applies the rest of the file (claude doctor: "Invalid marketplace entry was ignored").`);
      removed.push({ path: keyPath.slice(0, 2), effect: "entry", why: issue.message });
    } else if (field) {
      add(kind, "error", "field", keyPath, `${mine}. Claude Code ignores this field and applies the rest of the file (claude doctor: "This field was ignored").`);
      removed.push({ path: keyPath.slice(0, 1), effect: "field", why: issue.message });
    } else {
      add(kind, "error", "file", keyPath, `${mine}. Claude Code ignores the whole file for this: none of its settings apply (claude doctor lists it under "Invalid settings").`);
      if (!effective.ignored) effective.ignored = { reason: `${here} ${issue.message}` };
    }
  }

  // --- hooks ------------------------------------------------------------------------------------------------
  if (data.hooks !== undefined) lintHooks(data.hooks, { add, removed, effective, schema, schemaNote });

  // --- settings.jsonc beside settings.json ------------------------------------------------------------------
  if (!jsonc && file.jsonc && file.jsonc.exists) {
    let source = null;
    try { source = fs.readFileSync(file.jsonc.path, "utf8"); } catch { /* unreadable: nothing to say */ }
    if (source !== null) {
      const built = buildFromJsonc(source);
      const name = file.jsonc.path.split(/[\\/]/).pop();
      if (!built.ok) {
        add("jsonc-out-of-date", "warning", "none", [], `${name} cannot be built (${built.problems[0].message}), so it does not reach settings.json.`, { offset: 0 });
      } else if (built.text !== text) {
        let same = false;
        try { same = JSON.stringify(sortKeys(JSON.parse(built.text))) === JSON.stringify(sortKeys(data)); } catch { /* differs */ }
        if (same) add("jsonc-out-of-date", "note", "none", [], `${name} and settings.json hold the same settings but are laid out differently; claude-settings-doctor build makes them identical.`, { offset: 0 });
        else add("jsonc-out-of-date", "warning", "none", [], `${name} and settings.json disagree. Claude Code reads settings.json only. Run claude-settings-doctor absorb if Claude Code changed settings.json, or build if you edited ${name}.`, { offset: 0 });
      }
    }
  }

  if (!effective.ignored) {
    effective.data = applyEffects(data, removed, effective.coerced);
  }
  if (notChecked.length) {
    const kw = [...new Set(notChecked.map((n) => n.keyword))].sort();
    add("not-checked", "note", "none", [], `Not checked: ${plural(notChecked.length, "place")} where the schema uses ${kw.map((k) => `"${k}"`).join(", ")}, which this checker does not judge.`, { offset: 0, notChecked: notChecked.length });
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));
  return { findings, notChecked, effective };
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isPlain(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// What the schema's description says to do instead: "DEPRECATED. Use 'attribution' instead. ..." gives
// "Use 'attribution' instead.", and "DEPRECATED (prefer X). ..." gives "prefer X.".
export function deprecationAdvice(node) {
  const strip = (s) => String(s).replace(/^deprecated[.:]?\s*/i, "").trim();
  let rest = strip(deprecation(node) || "");
  const paren = /^\((.*)\)\.?$/.exec(rest);
  if (paren) rest = `${paren[1]}.`;
  if (rest) return rest;
  return firstSentence(strip((node && node.description) || "")) || "the schema marks it deprecated.";
}

// A copy of the data as Claude Code uses it: without what it drops (whole fields, hook groups and entries,
// rules) and with env values turned into strings.
function applyEffects(data, removed, coerced) {
  const copy = structuredClone(data);
  for (const c of coerced) {
    let parent = copy;
    for (let i = 0; i < c.path.length - 1 && parent; i++) parent = parent[c.path[i]];
    if (parent && typeof parent === "object") setOwn(parent, c.path[c.path.length - 1], c.to);
  }
  const drops = [...removed].sort((a, b) => b.path.length - a.path.length || (typeof b.path[b.path.length - 1] === "number" ? b.path[b.path.length - 1] : 0) - (typeof a.path[a.path.length - 1] === "number" ? a.path[a.path.length - 1] : 0));
  for (const r of drops) {
    let parent = copy;
    for (let i = 0; i < r.path.length - 1 && parent !== undefined && parent !== null; i++) parent = parent[r.path[i]];
    const last = r.path[r.path.length - 1];
    if (parent === undefined || parent === null) continue;
    if (Array.isArray(parent) && typeof last === "number") parent.splice(last, 1);
    else if (typeof parent === "object") delete parent[last];
  }
  return copy;
}

// ------------------------------------------------------------------------------------------------------------
// hooks
// ------------------------------------------------------------------------------------------------------------

function lintHooks(hooks, ctx) {
  const { add, removed, effective, schema, schemaNote } = ctx;
  const hookCommand = schema.resolve({ $ref: "#/$defs/hookCommand" });
  const alternatives = hookCommand && Array.isArray(hookCommand.anyOf) ? hookCommand.anyOf.map((a) => schema.resolve(a)) : [];
  const schemaEvents = Object.keys((schema.nodeAt(["hooks"]) || { node: {} }).node.properties || {});
  const known = new Set([...HOOK_EVENTS, ...schemaEvents]);
  const schemaTypes = alternatives.map((a) => a && a.properties && a.properties.type && a.properties.type.const).filter(Boolean);
  const validTypes = [...new Set([...HOOK_TYPES, ...schemaTypes])];

  if (!isPlain(hooks)) {
    add("hook-shape", "error", "field", ["hooks"], `hooks should be an object that maps event names to lists, found ${article(jsonType(hooks))}. Claude Code ignores this field and applies the rest of the file (claude doctor: "This field was ignored").`);
    removed.push({ path: ["hooks"], effect: "field", why: "not an object" });
    return;
  }

  // Reports one problem in an event, a group or an entry, and says what Claude Code does about it. In
  // PreToolUse and PermissionRequest it drops the whole file; elsewhere only the part named.
  const report = (level, event, keyPath, problem, { hint = "", what = problem, at = "value", suggestions } = {}) => {
    let effect = level;
    let tail;
    if (WHOLE_FILE_EVENTS.has(event)) {
      effect = "file";
      tail = `Claude Code ignores the whole file: a ${event} hook that cannot be loaded may be what guards your permissions, so nothing in the file is applied (claude doctor says so).`;
      if (!effective.ignored) effective.ignored = { reason: `${formatPath(keyPath)} ${what}` };
    } else if (level === "entry") tail = "Claude Code ignores this entry: it never runs (claude doctor: \"entry ignored\").";
    else if (level === "group") tail = "Claude Code ignores this group: its hooks never run (claude doctor: \"matcher ignored\").";
    else tail = "Claude Code ignores this event's hooks and applies the rest of the file (claude doctor: \"This entry was ignored\").";
    add("hook-shape", "error", effect, keyPath, `${problem}.${hint ? ` ${hint}` : ""} ${tail}`, { at, suggestions });
    return effect !== "file";
  };

  for (const [event, groups] of Object.entries(hooks)) {
    const evPath = ["hooks", event];
    if (!known.has(event)) {
      const near = nearest(event, [...known]);
      add("hook-event", "error", "key", evPath, `${quote(event)} is not a hook event. Claude Code ignores it, so its hooks never run (claude doctor: "Unknown hook event").${near.length ? ` Did you mean ${near.map(quote).join(" or ")}?` : ""}`, { at: "key", suggestions: near });
      removed.push({ path: evPath, effect: "field", why: "unknown event" });
      continue;
    }
    if (!Array.isArray(groups)) {
      if (report("event", event, evPath, `${quote(event)} should be a list of matcher groups, found ${article(jsonType(groups))}`)) removed.push({ path: evPath, effect: "field", why: "not a list" });
      continue;
    }
    groups.forEach((group, gi) => {
      const gp = [...evPath, gi];
      if (!isPlain(group)) {
        if (report("group", event, gp, `${formatPath(gp)} should be an object with a "hooks" list, found ${article(jsonType(group))}`)) removed.push({ path: gp, effect: "group", why: "not an object" });
        return;
      }
      let dropped = false;
      if (group.matcher !== undefined && typeof group.matcher !== "string") {
        if (report("group", event, [...gp, "matcher"], `matcher should be a string, found ${article(jsonType(group.matcher))}`)) { removed.push({ path: gp, effect: "group", why: "matcher is not a string" }); dropped = true; }
      } else if (typeof group.matcher === "string" && group.matcher !== "*" && group.matcher !== "") {
        let bad = null;
        try { new RegExp(group.matcher); } catch (e) { bad = String(e.message).replace(/^Invalid regular expression: /, ""); }
        if (bad) add("hook-matcher", "warning", "none", [...gp, "matcher"], `matcher ${quote(group.matcher)} is not a valid regular expression (${bad}). Claude Code never matches it, so the hooks in this group never run, and says nothing.`);
      }
      if (!Array.isArray(group.hooks)) {
        if (report("group", event, gp, `${formatPath(gp)} should have a "hooks" list of entries, found ${group.hooks === undefined ? "none" : article(jsonType(group.hooks))}`) && !dropped) removed.push({ path: gp, effect: "group", why: "no hooks list" });
        return;
      }
      for (const k of Object.keys(group)) {
        if (k !== "matcher" && k !== "hooks") add("unknown-key", "warning", "key", [...gp, k], `${quote(k)} is not in the schema for a hook group (${schemaNote}). Claude Code ignores it, without a word.`, { at: "key" });
      }
      if (dropped) return;
      group.hooks.forEach((entry, hi) => {
        const ep = [...gp, "hooks", hi];
        let dropIt = false;
        for (const p of entryProblems(entry, ep, { alternatives, validTypes, schema })) {
          if (p.fatal) {
            if (report("entry", event, p.path, p.problem, { hint: p.hint, what: p.what, at: p.at, suggestions: p.suggestions })) dropIt = true;
          } else add(p.id, "warning", "key", p.path, p.problem, { at: p.at });
        }
        if (dropIt) removed.push({ path: ep, effect: "entry", why: "the entry is invalid" });
      });
    });
  }
}

// What is wrong with one hook entry: [{ path, problem, hint, what, fatal, at, suggestions, id }]. fatal means
// that Claude Code ignores the entry.
function entryProblems(entry, ep, { alternatives, validTypes, schema }) {
  const out = [];
  const fatal = (path, problem, what, extra = {}) => out.push({ path, problem, what, fatal: true, ...extra });
  if (!isPlain(entry)) { fatal(ep, `${formatPath(ep)} should be an object, found ${article(jsonType(entry))}`, "is not an object"); return out; }
  if (entry.type === undefined) { fatal([...ep, "type"], `${formatPath(ep)} has no "type"`, "has no type", { hint: `The type is one of ${validTypes.join(", ")}.` }); return out; }
  if (typeof entry.type !== "string" || !validTypes.includes(entry.type)) {
    const near = typeof entry.type === "string" ? nearest(entry.type, validTypes) : [];
    fatal([...ep, "type"], `type is ${valueText(entry.type)}, which is not a hook type`, "has an unknown type", { hint: near.length ? `Did you mean ${near.map(quote).join(" or ")}? The types are ${validTypes.join(", ")}.` : `The types are ${validTypes.join(", ")}.`, suggestions: near });
    return out;
  }
  const alt = alternatives.find((a) => a && a.properties && a.properties.type && a.properties.type.const === entry.type);
  if (!alt) return out;
  const { issues } = schema.check(entry, alt, { at: ep, unknown: true });
  for (const issue of issues) {
    const sub = issue.path.slice(ep.length);
    const field = sub.length ? formatPath(sub) : "the entry";
    if (issue.kind === "unknown-key") {
      const key = issue.path[issue.path.length - 1];
      out.push({ path: issue.path, id: "unknown-key", problem: `${quote(key)} is not a field of a ${entry.type} hook in the schema. Claude Code ignores it, without a word.`, at: "key", fatal: false });
    } else if (issue.kind === "required") {
      fatal([...ep, issue.key], `${formatPath(ep)} needs "${issue.key}" (it is a ${entry.type} hook)`, `has no ${issue.key}`);
    } else if (issue.kind === "length" && sub.length === 1) {
      out.push({ path: issue.path, id: "hook-shape", problem: `${field} ${issue.message}, so nothing runs.`, fatal: false });
    } else if (issue.kind === "deprecated" || issue.kind === "unique") {
      continue;
    } else {
      fatal(issue.path, `${field} ${issue.message}`, `has a bad ${sub[0] ?? "field"}`);
    }
  }
  return out;
}


// ------------------------------------------------------------------------------------------------------------
// all files
// ------------------------------------------------------------------------------------------------------------

/**
 * Lint every file of loaded settings. Returns
 *   { findings (all files, errors first), files: [{ ...file summary, findings, effective }], counts, notChecked }
 */
export function lintSettings(settings, opts = {}) {
  const schema = opts.schema || vendored();
  const meta = opts.meta || loadSchema().meta;
  const files = [];
  const all = [];
  for (const f of settings.files) {
    if (!f.exists) {
      // a commented source with nothing built from it yet
      if (f.jsonc && f.jsonc.exists && f.scope !== "managed") {
        const name = f.jsonc.path.split(/[\\/]/).pop();
        const finding = { id: "jsonc-out-of-date", severity: "warning", effect: "none", scope: f.scope, file: f.path, display: f.display, line: null, column: null, path: formatPath([]), keyPath: [], message: `${name} exists but settings.json does not. Claude Code reads settings.json only: run claude-settings-doctor build.` };
        files.push({ scope: f.scope, label: f.label, path: f.path, display: f.display, rank: f.rank, exists: false, findings: [finding], effective: { data: null, ignored: null, removed: [] } });
        all.push(finding);
      } else files.push({ scope: f.scope, label: f.label, path: f.path, display: f.display, rank: f.rank, exists: false, findings: [], effective: { data: null, ignored: null, removed: [] } });
      continue;
    }
    const r = lintFile(f, { schema, meta });
    files.push({ scope: f.scope, label: f.label, path: f.path, display: f.display, rank: f.rank, exists: true, findings: r.findings, effective: r.effective, notChecked: r.notChecked });
    all.push(...r.findings);
  }
  all.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const counts = { error: 0, warning: 0, note: 0 };
  for (const f of all) counts[f.severity]++;
  return { findings: all, files, counts, schema: meta };
}
