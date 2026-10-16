// The three questions about settings, as plain objects: what Claude Code merges (show), what is wrong in the
// files (lint) and what a key is (explain). src/report.mjs turns them into text, markdown and JSON.
import fs from "node:fs";
import path from "node:path";
import { analyzeText, loadSettings, shortPath } from "./settings.mjs";
import { deprecationAdvice, formatPath, lintFile, lintSettings, parsePath } from "./lint.mjs";
import { toValue } from "./jsonc.mjs";
import { merge, entriesUnder } from "./merge.mjs";
import { deprecation, firstSentence, loadSchema, nearest, vendored } from "./schema.mjs";

// Things that can change what Claude Code uses and that this tool does not read; printed with every `show`.
export const NOT_READ = [
  "server-managed settings, macOS profiles and the Windows registry (only managed-settings.json and managed-settings.d are read)",
  "the --settings, --setting-sources and --add-dir flags, and what Claude Code writes to its own state during a session",
  "environment variables Claude Code reads itself (ANTHROPIC_MODEL, CLAUDE_CODE_*), and ~/.claude.json",
  "plugin settings: a plugin supplies its own agent and statusLine defaults, which come below all of these",
];

const sourceOf = (f) => ({ scope: f.scope, label: f.label, display: f.display, path: f.path, rank: f.rank });

function fileState(f, lint) {
  if (!f.exists) return { state: "not found", detail: null };
  if (f.readError) return { state: "unreadable", detail: f.readError };
  if (f.analysis && f.analysis.empty) return { state: "empty", detail: null };
  const eff = lint.effective;
  if (eff.ignored) return { state: "ignored by Claude Code", detail: eff.ignored.reason };
  const bits = [];
  if (eff.removed.length) bits.push(`${eff.removed.length} ${eff.removed.length === 1 ? "part" : "parts"} dropped by Claude Code`);
  if (eff.coerced.length) bits.push(`${eff.coerced.length} env ${eff.coerced.length === 1 ? "value" : "values"} turned into strings`);
  return { state: "read", detail: bits.length ? bits.join(", ") : null };
}

/** show: the merged settings and where each key came from. */
export function buildShow({ project, env, home, platform, managed }) {
  const settings = loadSettings({ project, env, home, platform, managed });
  const linted = lintSettings(settings);
  const byPath = new Map(linted.files.map((l) => [l.path, l]));
  const files = settings.files.map((f) => {
    const l = byPath.get(f.path);
    const st = fileState(f, l || { effective: { ignored: null, removed: [], coerced: [] } });
    const keys = f.exists && l && l.effective.data ? Object.keys(l.effective.data).length : 0;
    return { scope: f.scope, label: f.label, display: f.display, path: f.path, rank: f.rank, exists: f.exists, state: st.state, detail: st.detail, topLevelKeys: keys, findings: l ? l.findings.filter((x) => x.severity !== "note").length : 0 };
  });
  const merged = merge(settings.files.filter((f) => f.exists).map((f) => ({ source: sourceOf(f), data: (byPath.get(f.path) || {}).effective ? byPath.get(f.path).effective.data : null })));
  const meta = loadSchema().meta;
  const schema = vendored();
  const entries = merged.entries.map((e) => ({
    path: formatPath(e.path),
    keyPath: e.path,
    value: e.value,
    source: e.source || null,
    shadowed: (e.shadowed || []).map((s) => ({ source: s.source, value: s.value })),
    items: e.items ? e.items.map((i) => ({ value: i.value, source: i.source, also: i.also })) : undefined,
    inSchema: schema.nodeAt(e.path.length ? e.path.slice(0, Math.min(e.path.length, 2)) : []) !== null,
  }));
  return {
    project: settings.project, configDir: settings.configDir, configSource: settings.configSource,
    schema: { downloaded: meta.downloaded, source: meta.source },
    files, entries, tree: merged.tree,
    counts: { entries: entries.length, shadowed: entries.filter((e) => e.shadowed.length).length, findings: linted.counts },
    notRead: NOT_READ,
    settings, // for the caller; stripped before JSON
  };
}

/** lint: the findings of every file that applies to a project, or of one file (--file). */
export function buildLint({ project, env, home, platform, managed, file }) {
  const meta = loadSchema().meta;
  if (file) {
    const abs = path.resolve(file);
    let text;
    try { text = fs.readFileSync(abs, "utf8"); } catch (e) { return { project: path.resolve(project || "."), file: abs, error: `cannot be read (${e.code || e.message})`, findings: [], files: [], counts: { error: 1, warning: 0, note: 0 }, schema: meta }; }
    const jsonc = /\.jsonc$/i.test(abs);
    const rec = { scope: "file", label: path.basename(abs), path: abs, display: shortPath(abs, { home, project: path.resolve(project || ".") }), rank: 0, exists: true, readError: null, text, analysis: analyzeText(text), jsonc: { path: "", exists: false } };
    const r = lintFile(rec, { jsonc, meta });
    const counts = { error: 0, warning: 0, note: 0 };
    for (const f of r.findings) counts[f.severity]++;
    return { project: path.resolve(project || "."), file: abs, findings: r.findings, files: [{ scope: "file", label: rec.label, path: abs, display: rec.display, exists: true, findings: r.findings, effective: r.effective }], counts, schema: meta };
  }
  const settings = loadSettings({ project, env, home, platform, managed });
  const linted = lintSettings(settings);
  return {
    project: settings.project, configDir: settings.configDir, configSource: settings.configSource,
    findings: linted.findings, files: linted.files.map(({ effective, ...rest }) => ({ ...rest, ignored: effective.ignored })), counts: linted.counts, schema: meta,
  };
}

function valueSummary(v) {
  const t = JSON.stringify(v);
  return t === undefined ? String(v) : t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

/** explain: what the schema says about a key, and which files set it now. */
export function buildExplain({ project, env, home, platform, managed, key }) {
  const schema = vendored();
  const meta = loadSchema().meta;
  const keyPath = parsePath(key);
  const model = { key, path: formatPath(keyPath), keyPath, schema: { downloaded: meta.downloaded, source: meta.source }, found: false };
  if (!keyPath.length) return { ...model, error: "give a key, such as cleanupPeriodDays or permissions.defaultMode" };
  const hit = schema.nodeAt(keyPath);
  if (!hit) {
    // the first part of the path the schema does not know: the typo is there, not always in the last part
    let at = keyPath.length - 1;
    for (let i = 0; i < keyPath.length; i++) if (!schema.nodeAt(keyPath.slice(0, i + 1))) { at = i; break; }
    const names = schema.namesAt(keyPath.slice(0, at));
    return { ...model, unknownAt: at, unknown: keyPath[at], suggestions: nearest(String(keyPath[at]), names), listed: names.length };
  }
  const node = hit.node;
  const alternatives = [...(node.anyOf || []), ...(node.oneOf || [])].map((a) => schema.resolve(a));
  const enumValues = Array.isArray(node.enum) ? node.enum : alternatives.flatMap((a) => (a && Array.isArray(a.enum) ? a.enum : []));
  const children = [];
  const collect = (nd) => { const r = schema.resolve(nd); if (r && r.properties) for (const k of Object.keys(r.properties)) if (!children.includes(k)) children.push(k); };
  collect(node);
  alternatives.forEach(collect);
  const description = typeof node.description === "string" ? node.description.trim() : (alternatives.find((a) => a && a.description) || {}).description || null;
  Object.assign(model, {
    found: true,
    type: schema.typeText(node),
    description: description ? description.replace(/\r/g, "") : null,
    summary: description ? firstSentence(description) : null,
    default: node.default,
    hasDefault: node.default !== undefined,
    enum: enumValues.length ? enumValues : null,
    examples: Array.isArray(node.examples) ? node.examples.slice(0, 3) : [],
    deprecated: deprecation(node) ? deprecationAdvice(node) : null,
    children: children.slice(0, 60),
    moreChildren: Math.max(0, children.length - 60),
  });

  const settings = loadSettings({ project, env, home, platform, managed });
  const linted = lintSettings(settings);
  const byPath = new Map(linted.files.map((l) => [l.path, l]));
  const setBy = [];
  for (const f of settings.files) {
    if (!f.exists) continue;
    const l = byPath.get(f.path);
    // the value as written, also in a file Claude Code ignores (a comment, a wrong type): that is why it does not apply
    const parse = f.analysis && f.analysis.parse;
    const data = parse && parse.ok && parse.root.type === "object" ? toValue(parse.root) : null;
    const raw = data ? keyPath.reduce((v, k) => (v === undefined || v === null || typeof v !== "object" ? undefined : v[k]), data) : undefined;
    const ignored = l && l.effective.ignored ? l.effective.ignored.reason : null;
    if (raw !== undefined) setBy.push({ ...sourceOf(f), value: raw, ignored });
  }
  const live = setBy.filter((s) => !s.ignored);
  model.setBy = setBy;
  model.winner = live.length ? live[0] : null; // files are highest precedence first
  // how the files that apply combine: a value is replaced by the highest, lists are joined, objects merge key by key
  const kinds = new Set(live.map((s) => (Array.isArray(s.value) ? "list" : s.value !== null && typeof s.value === "object" ? "object" : "value")));
  model.combine = kinds.size === 1 && kinds.has("list") ? "join" : kinds.size === 1 && kinds.has("object") ? "merge" : "replace";
  const merged = merge(settings.files.filter((f) => f.exists).map((f) => ({ source: sourceOf(f), data: (byPath.get(f.path) || {}).effective ? byPath.get(f.path).effective.data : null })));
  const under = entriesUnder(merged.entries, keyPath);
  model.merged = under.length === 1 && under[0].path.length === keyPath.length ? { value: under[0].value, items: under[0].items || null } : null;
  model.mergedCount = under.length;
  return model;
}
