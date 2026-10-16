// Plain-text, markdown and JSON reports. Text goes to a terminal (coloured when it is one), markdown is what the
// skill hands to Claude, JSON is for other tools.
import { VERSION } from "./version.mjs";

export const palette = (on) => {
  const c = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { red: c(31), green: c(32), yellow: c(33), blue: c(36), dim: c(2), bold: c(1) };
};

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pad = (s, n) => String(s).padEnd(n);
const clip = (s, n) => { const t = String(s).replace(/\s+/g, " "); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };
const BT = "`";
const where = (f) => `${f.display}${f.line ? `:${f.line}` : ""}`;
const json = (v) => { const t = JSON.stringify(v); return t === undefined ? String(v) : t; };

const SEVERITY_TONE = { error: "red", warning: "yellow", note: "dim" };

// ------------------------------------------------------------------------------------------------------------
// show
// ------------------------------------------------------------------------------------------------------------

export function renderShow(m, { color = false } = {}) {
  const p = palette(color);
  const out = [];
  out.push(`${p.bold(`claude-settings-doctor ${VERSION}`)}  the settings Claude Code merges`);
  out.push(`project   ${m.project}`);
  out.push(`config    ${m.configDir}  ${m.configSource === "CLAUDE_CONFIG_DIR" ? "(from CLAUDE_CONFIG_DIR)" : "(the default; CLAUDE_CONFIG_DIR is not set)"}`);
  out.push(`schema    SchemaStore's claude-code-settings.json, downloaded ${m.schema.downloaded}`);
  out.push("");
  out.push("Settings files, highest precedence first");
  const w = Math.max(...m.files.map((f) => f.display.length));
  for (const f of m.files) {
    const state = f.state === "not found" ? p.dim("not found")
      : f.state === "read" ? `read, ${plural(f.topLevelKeys, "key")}${f.detail ? `; ${f.detail}` : ""}`
        : f.state === "empty" ? p.dim("empty")
          : p.red(`${f.state}${f.detail ? `: ${f.detail}` : ""}`);
    out.push(`  ${pad(f.scope, 8)} ${pad(f.display, w)}  ${state}`);
  }
  out.push("");
  const live = m.files.filter((f) => f.state === "read" || f.state === "empty").length;
  out.push(`${p.bold("Merged settings")} (${plural(m.entries.length, "value")} from ${plural(live, "file")}; a higher file wins a key, objects merge key by key, lists are joined)`);
  if (!m.entries.length) out.push(p.dim("  nothing is set"));
  const kw = Math.min(46, Math.max(10, ...m.entries.map((e) => e.path.length)));
  for (const e of m.entries) {
    if (e.items) {
      out.push(`  ${pad(e.path, kw)}  ${plural(e.items.length, "item")}${p.dim(`  (${[...countBy(e.items.map((i) => i.source && i.source.scope))].map(([k, n]) => `${k} ${n}`).join(", ")})`)}`);
      for (const i of e.items.slice(0, 40)) out.push(`      ${pad(clip(json(i.value), 64), 64)}  ${i.source ? i.source.scope : ""}${i.also.length ? p.dim(` (also ${i.also.map((s) => s.scope).join(", ")})`) : ""}`);
      if (e.items.length > 40) out.push(p.dim(`      ... and ${e.items.length - 40} more`));
    } else {
      out.push(`  ${pad(e.path, kw)}  ${pad(clip(json(e.value), 40), 40)}  ${e.source ? e.source.scope : ""}${e.inSchema ? "" : p.dim("  (not in the schema)")}`);
    }
    for (const s of e.shadowed) out.push(p.yellow(`      shadowed: ${clip(json(s.value), 50)} in ${s.source.scope} settings (${s.source.display})`));
  }
  out.push("");
  out.push(`${plural(m.counts.shadowed, "key")} shadowed. Findings: ${plural(m.counts.findings.error, "error")}, ${plural(m.counts.findings.warning, "warning")} (run lint).`);
  out.push("");
  out.push("Not read by this tool:");
  for (const n of m.notRead) out.push(`  - ${n}`);
  return `${out.join("\n")}\n`;
}

function countBy(list) {
  const m = new Map();
  for (const x of list) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

// ------------------------------------------------------------------------------------------------------------
// lint
// ------------------------------------------------------------------------------------------------------------

export function renderLint(m, { color = false } = {}) {
  const p = palette(color);
  const out = [];
  out.push(`${p.bold(`claude-settings-doctor ${VERSION}`)}  lint`);
  if (m.file) out.push(`file      ${m.file}`);
  else {
    out.push(`project   ${m.project}`);
    out.push(`config    ${m.configDir}  ${m.configSource === "CLAUDE_CONFIG_DIR" ? "(from CLAUDE_CONFIG_DIR)" : "(the default)"}`);
  }
  out.push(`schema    SchemaStore's claude-code-settings.json, downloaded ${m.schema.downloaded}`);
  out.push("");
  if (m.error) { out.push(p.red(`${m.file} ${m.error}`)); return `${out.join("\n")}\n`; }
  const read = m.files.filter((f) => f.exists);
  if (!read.length) out.push("No settings file was found, so there is nothing to check.");
  for (const f of read) {
    out.push(`${p.bold(f.display)}  ${p.dim(f.scope === "file" ? "" : f.label)}`);
    if (!f.findings.length) out.push(`  ${p.green("no findings")}`);
    for (const x of f.findings) {
      out.push(`  ${p[SEVERITY_TONE[x.severity]](pad(x.severity, 7))} ${pad(x.id, 17)} ${x.line ? `line ${x.line}` : ""}${x.path && x.path !== "(the whole file)" ? `  ${x.path}` : ""}`);
      out.push(`      ${x.message}`);
      if (x.fix) out.push(`      ${p.dim(`fix: ${x.fix}`)}`);
    }
    out.push("");
  }
  const c = m.counts;
  out.push(`${plural(c.error, "error")}, ${plural(c.warning, "warning")}, ${plural(c.note, "note")} in ${plural(read.length, "file")}`);
  return `${out.join("\n")}\n`;
}

// The words that say what `claude doctor` prints for the same mistake help a person; the model has no use for them.
const withoutDoctor = (s) => String(s).replace(/\s*\(claude doctor[^)]*\)/g, "");

/**
 * lint as markdown, for the skill: warnings and errors only, at most `max` of them, each line at most `width`
 * characters, so the report cannot grow past about 18 lines and 4,500 characters whatever the files hold.
 */
export function markdownLint(m, { max = 12, width = 300 } = {}) {
  const out = [];
  const read = m.files.filter((f) => f.exists);
  out.push(`## settings-doctor lint: ${m.project}`);
  const c = m.counts;
  out.push(`${plural(read.length, "settings file")} read, ${plural(c.error, "error")}, ${plural(c.warning, "warning")}, ${plural(c.note, "note")}. Schema: SchemaStore, downloaded ${m.schema.downloaded}.`);
  if (m.error) { out.push(`- ERROR ${clip(`${m.file} ${m.error}`, width)}`); return `${out.join("\n")}\n`; }
  const important = m.findings.filter((f) => f.severity !== "note");
  if (!important.length) out.push("No findings.");
  const shown = important.slice(0, max);
  for (const f of shown) {
    const at = f.display ? ` ${f.display}${f.line ? `:${f.line}` : ""}` : "";
    out.push(clip(`- ${f.severity.toUpperCase()} ${BT}${f.id}${BT}${at}${f.path && f.path !== "(the whole file)" ? ` ${BT}${f.path}${BT}` : ""}: ${withoutDoctor(f.message)}${f.fix ? ` Fix: ${f.fix}` : ""}`, width));
  }
  if (important.length > shown.length) out.push(`- ... and ${important.length - shown.length} more (run ${BT}claude-settings-doctor lint${BT})`);
  return `${out.join("\n")}\n`;
}

// ------------------------------------------------------------------------------------------------------------
// explain
// ------------------------------------------------------------------------------------------------------------

export function renderExplain(m, { color = false } = {}) {
  const p = palette(color);
  const out = [];
  if (m.error) return `${m.error}\n`;
  if (!m.found) {
    out.push(`${p.bold(m.path)} is not in the schema (SchemaStore, downloaded ${m.schema.downloaded}).`);
    if (m.unknownAt !== undefined && m.unknownAt < m.keyPath.length - 1) out.push(`The first part the schema does not know is "${m.unknown}".`);
    if (m.suggestions && m.suggestions.length) out.push(`Did you mean ${m.suggestions.map((s) => `"${s}"`).join(" or ")}?`);
    else out.push("Claude Code ignores keys it does not know, without a word. If this one is new, the schema may lag a release.");
    return `${out.join("\n")}\n`;
  }
  out.push(`${p.bold(m.path)}   ${m.type}${m.hasDefault ? `, default ${json(m.default)}` : ""}`);
  if (m.deprecated) out.push(p.yellow(`deprecated: ${m.deprecated}`));
  if (m.description) { out.push(""); out.push(m.description); }
  if (m.enum) { out.push(""); out.push(`Allowed: ${m.enum.map(json).join(", ")}`); }
  if (m.examples.length) { out.push(""); out.push(`Example${m.examples.length === 1 ? "" : "s"}: ${m.examples.map((e) => clip(json(e), 100)).join("  ")}`); }
  if (m.children.length) { out.push(""); out.push(`Keys: ${m.children.join(", ")}${m.moreChildren ? `, and ${m.moreChildren} more` : ""}`); }
  out.push("");
  if (!m.setBy.length) {
    out.push(`Set in no settings file${m.hasDefault ? `, so Claude Code uses its default (${json(m.default)})` : ""}.`);
  } else {
    out.push("Set now in:");
    for (const s of m.setBy) {
      const isWinner = m.winner && s.path === m.winner.path;
      const several = m.setBy.filter((x) => !x.ignored).length > 1;
      const tag = s.ignored ? p.red(`  (Claude Code ignores this file: ${s.ignored})`)
        : m.combine === "join" ? (several ? p.dim("  (joined with the others)") : "")
          : m.combine === "merge" ? (several ? p.dim("  (merged key by key with the others)") : "")
            : isWinner ? p.green("  <- wins") : p.dim("  (shadowed)");
      out.push(`  ${pad(s.scope, 8)} ${pad(s.display, 28)} ${clip(json(s.value), 60)}${tag}`);
    }
    if (m.combine === "join" && m.merged && m.merged.items && m.setBy.filter((x) => !x.ignored).length > 1) out.push(p.dim(`Claude Code joins the items of all the files: ${m.merged.items.length} in all.`));
  }
  out.push("");
  out.push(p.dim(`From SchemaStore's schema, downloaded ${m.schema.downloaded}; Claude Code can know more or less.`));
  return `${out.join("\n")}\n`;
}

// ------------------------------------------------------------------------------------------------------------
// the commands that write
// ------------------------------------------------------------------------------------------------------------

/** One line per thing a writing command did, from the result objects of src/write.mjs and friends. */
export function renderWrite(r, { color = false } = {}) {
  const p = palette(color);
  const out = [];
  const tag = r.dryRun ? p.dim("(dry run) ") : "";
  for (const line of r.lines || []) out.push(`${tag}${line}`);
  if (r.refused) out.push(p.red(`Refused: ${r.refused}`));
  for (const n of r.notes || []) out.push(p.dim(n));
  if (r.dryRun) out.push(p.dim("Nothing was written (--dry-run)."));
  return `${out.join("\n")}\n`;
}

/** Drop the loaded settings (a large object holding every file's text) before a model is written as JSON. */
export function strip(model) {
  const { settings, ...rest } = model;
  void settings;
  return rest;
}
