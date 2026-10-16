// The commands that write: init, build, check, absorb, restore. Each takes the target (user, project or local),
// the machine it runs on (env, home, platform, now: injectable for tests) and --dry-run, and returns a plain
// object: { ok, refused, dryRun, lines, notes, ... }. Nothing is written to a file that cannot be backed up,
// and a refusal writes nothing.
import fs from "node:fs";
import path from "node:path";
import { absorb as absorbText } from "./absorb.mjs";
import { buildFromJsonc } from "./build.mjs";
import { describeOp, diffValues, sameSettings } from "./diff.mjs";
import { annotate } from "./init.mjs";
import { formatPath } from "./lint.mjs";
import { analyzeText, configDir, jsoncPath, targetFile } from "./settings.mjs";
import { backupFile, listBackups, readBaseline, restoreBackup, writeAtomic, writeBaseline } from "./write.mjs";

const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return null; throw e; } };
const stripBom = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
const tryParse = (t) => { try { return JSON.parse(stripBom(t)); } catch { return null; } };
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const base = (p) => path.basename(p);
/** "claude-settings-doctor build --user": a command to suggest, with the flag that names the settings file. */
const cmd = (opts, name) => `claude-settings-doctor ${name} ${opts.targetFlag || "--user"}`;

function setup(opts) {
  const t = targetFile(opts);
  return { json: t.path, jsonc: jsoncPath(t.path), cfg: configDir(opts.env, opts.home).dir, scope: t.scope, now: new Date(opts.now ?? Date.now()), dryRun: !!opts.dryRun, display: opts.display || ((p) => p) };
}

const fresh = (action, p, extra = {}) => ({ action, ok: false, refused: null, dryRun: p.dryRun, scope: p.scope, file: p.json, source: p.jsonc, lines: [], notes: [], ...extra });
const refuse = (r, why) => { r.refused = why; r.ok = false; return r; };

/**
 * Whether settings.json (`text`) holds other settings than the record of the last build, absorb or init: then a
 * build would throw something away. Returns null when there is no record or nothing changed, else
 * { changes, unusable } where unusable says why Claude Code cannot read settings.json now (a comment, a typo), if so.
 */
function changedSinceBuild(text, baselineText) {
  if (text === null || baselineText === null || text === baselineText) return null;
  const was = tryParse(baselineText);
  const now = tryParse(text);
  if (isObject(was) && isObject(now) && sameSettings(was, now)) return null;
  if (isObject(was) && isObject(now)) return { changes: diffValues(was, now), unusable: null };
  const a = analyzeText(text);
  return { changes: [], unusable: a.problems.length ? a.problems[0].message : "it does not hold a JSON object" };
}

function problemText(b) {
  const first = b.problems[0];
  return `line ${first.line}: ${first.message}${b.problems.length > 1 ? ` (and ${b.problems.length - 1} more)` : ""}`;
}

function changeLines(changes, max = 12) {
  const lines = changes.slice(0, max).map((c) => `  ${describeOp(c, formatPath)}`);
  if (changes.length > max) lines.push(`  ... and ${changes.length - max} more`);
  return lines;
}

// ------------------------------------------------------------------------------------------------------------
// build and check
// ------------------------------------------------------------------------------------------------------------

/** What build would write, and how settings.json compares: the shared first half of build and check. */
function prepare(p) {
  const srcText = readText(p.jsonc);
  if (srcText === null) return { error: `there is no ${base(p.jsonc)} next to ${base(p.json)}; run init first` };
  const built = buildFromJsonc(srcText);
  if (!built.ok) return { error: `${base(p.jsonc)} cannot be built, ${problemText(built)}`, problems: built.problems };
  const cur = readText(p.json);
  const curData = cur === null ? null : tryParse(cur);
  const newData = JSON.parse(built.text);
  const changes = isObject(curData) ? diffValues(curData, newData) : cur === null ? diffValues({}, newData) : [];
  return { srcText, built, cur, curData, newData, changes };
}

/**
 * check: does settings.json hold the settings that build would write? The settings are compared, not the bytes: a
 * settings.json laid out another way (line endings after a checkout, a formatter, a missing final newline) is not
 * drift, because Claude Code reads the same settings from it.
 */
export function runCheck(opts) {
  const p = setup(opts);
  const r = fresh("check", p, { differs: false, layoutOnly: false, changes: [] });
  const q = prepare(p);
  if (q.error) { r.problems = q.problems; return refuse(r, q.error); }
  r.changes = q.changes;
  if (q.cur === q.built.text) { r.ok = true; r.lines.push(`${base(p.json)} is what build writes from ${base(p.jsonc)}.`); return r; }
  if (isObject(q.curData) && sameSettings(q.curData, q.newData)) {
    r.ok = true;
    r.layoutOnly = true;
    r.lines.push(`${base(p.json)} holds the same settings as ${base(p.jsonc)}, laid out differently. That is not drift: Claude Code reads the same settings.`);
    r.notes.push(`${cmd(opts, "build")} would write the layout build uses (two-space indentation, comments gone, a final newline).`);
    return r;
  }
  r.differs = true;
  if (q.cur === null) r.lines.push(`${base(p.json)} does not exist; build would write it.`);
  else if (!isObject(q.curData)) {
    const a = analyzeText(q.cur);
    r.lines.push(`${base(p.json)} is not usable: ${a.problems.length ? a.problems[0].message : "it does not hold a JSON object"}. Claude Code ignores it; build would replace it.`);
  } else { r.lines.push(`${base(p.json)} differs from what build writes from ${base(p.jsonc)}. Build would change:`); r.lines.push(...changeLines(q.changes)); }
  r.notes.push(`Run ${cmd(opts, "build")} to write it, or ${cmd(opts, "absorb")} to take the changes in ${base(p.json)} into ${base(p.jsonc)}.`);
  return r;
}

/** build: write settings.json from settings.jsonc, after a backup. */
export function runBuild(opts) {
  const p = setup(opts);
  const r = fresh("build", p, { changed: false, backup: null, changes: [] });
  const q = prepare(p);
  if (q.error) { r.problems = q.problems; return refuse(r, q.error); }
  r.changes = q.changes;
  const baseline = readBaseline(p.cfg, p.json);
  if (q.cur === q.built.text) {
    r.ok = true;
    r.lines.push(`${base(p.json)} is already what build writes from ${base(p.jsonc)}.`);
    if (baseline !== q.cur && !p.dryRun) writeBaseline(p.cfg, p.json, q.cur, p.now);
    return r;
  }
  const moved = opts.force ? null : changedSinceBuild(q.cur, baseline);
  if (moved) {
    // settings.json changed since the last build, absorb or init: building would throw that away
    if (moved.unusable) r.lines.push(`${base(p.json)} has changed since it was last built from ${base(p.jsonc)}, and Claude Code cannot read it now: ${moved.unusable}.`);
    else {
      r.lines.push(`${base(p.json)} has changed since it was last built from ${base(p.jsonc)} (Claude Code, or you, edited it):`);
      r.lines.push(...changeLines(moved.changes));
    }
    r.notes.push(`Run ${cmd(opts, "absorb")} to keep those changes in ${base(p.jsonc)}, or ${cmd(opts, "build")} --force to overwrite them (a backup is made either way).`);
    return refuse(r, `building now would drop the changes made in ${base(p.json)}`);
  }
  if (q.cur !== null && baseline === null) r.notes.push(`There is no record of the last build, so it could not check whether ${base(p.json)} held changes of its own; the backup keeps them.`);
  r.changed = true;
  if (p.dryRun) {
    r.ok = true;
    r.lines.push(q.cur === null ? `Would write ${p.json}.` : `Would write ${p.json} (${q.changes.length ? `${q.changes.length} ${q.changes.length === 1 ? "change" : "changes"}` : "layout only"}):`);
    if (q.changes.length) r.lines.push(...changeLines(q.changes));
    return r;
  }
  if (q.cur !== null) r.backup = backupFile(p.json, p.now);
  writeAtomic(p.json, q.built.text);
  writeBaseline(p.cfg, p.json, q.built.text, p.now);
  r.ok = true;
  r.lines.push(`Wrote ${p.json}${q.cur === null ? "" : ` (${q.changes.length ? `${q.changes.length} ${q.changes.length === 1 ? "change" : "changes"}` : "layout only"})`}.`);
  if (q.changes.length) r.lines.push(...changeLines(q.changes));
  if (r.backup) r.lines.push(`The old file is saved as ${r.backup}. Undo with: ${cmd(opts, "restore")}.`);
  return r;
}

// ------------------------------------------------------------------------------------------------------------
// init
// ------------------------------------------------------------------------------------------------------------

/** init: write settings.jsonc next to settings.json, every key annotated from the schema. */
export function runInit(opts) {
  const p = setup(opts);
  const r = fresh("init", p, { backup: null, annotated: 0, unknown: 0 });
  const had = readText(p.jsonc);
  if (had !== null && !opts.force) return refuse(r, `${base(p.jsonc)} already exists (init --force replaces it after a backup)`);
  const cur = readText(p.json);
  let jsonText = "{}\n";
  if (cur !== null && stripBom(cur).trim() !== "") {
    const a = analyzeText(cur);
    if (a.ignored) return refuse(r, `${base(p.json)} is not valid JSON (${a.problems[0].message}, line ${a.problems[0].line}); Claude Code ignores it too. Fix it first`);
    jsonText = stripBom(cur);
  }
  const out = annotate(jsonText, { fileName: base(p.json), sourceName: base(p.jsonc), buildHint: cmd(opts, "build") });
  r.annotated = out.annotated;
  r.unknown = out.unknown;
  r.text = out.text;
  r.lines.push(`${p.dryRun ? "Would write" : "Wrote"} ${p.jsonc}: ${out.annotated} keys annotated${out.unknown ? `, ${out.unknown} not in the schema` : ""}.`);
  if (cur === null) r.notes.push(`${base(p.json)} does not exist yet, so ${base(p.jsonc)} starts empty. Add settings to it, then run ${cmd(opts, "build")}.`);
  r.notes.push(`Edit ${base(p.jsonc)}, then run ${cmd(opts, "build")}; Claude Code reads ${base(p.json)} only.`);
  r.ok = true;
  if (p.dryRun) return r;
  if (had !== null) { r.backup = backupFile(p.jsonc, p.now); r.lines.push(`The old file is saved as ${r.backup}.`); }
  writeAtomic(p.jsonc, out.text);
  if (cur !== null) writeBaseline(p.cfg, p.json, jsonText, p.now);
  else writeBaseline(p.cfg, p.json, "{}\n", p.now);
  return r;
}

// ------------------------------------------------------------------------------------------------------------
// absorb
// ------------------------------------------------------------------------------------------------------------

/** absorb: put what changed in settings.json into settings.jsonc, comments kept. */
export function runAbsorb(opts) {
  const p = setup(opts);
  const r = fresh("absorb", p, { backup: null, applied: [], skipped: [], conflicts: [], unabsorbed: [], pending: 0 });
  const jsoncText = readText(p.jsonc);
  if (jsoncText === null) return refuse(r, `there is no ${base(p.jsonc)} next to ${base(p.json)}; run init first`);
  const jsonText = readText(p.json);
  if (jsonText === null) return refuse(r, `there is no ${base(p.json)} to take changes from`);
  const baseline = readBaseline(p.cfg, p.json);
  const res = absorbText({ jsoncText, jsonText, baselineText: baseline });
  if (res.refused) return refuse(r, res.refused);
  if (res.internal) return refuse(r, res.internal);
  r.baseline = res.baseline;
  r.applied = res.applied.map((a) => a.op);
  r.skipped = res.skipped.map((s) => ({ op: s.op, reason: s.reason }));
  r.conflicts = res.conflicts.map((c) => ({ op: c.op, reason: c.reason }));
  r.unabsorbed = res.unabsorbed.map((c) => ({ op: c.op, reason: c.reason }));
  r.pending = res.pending;
  if (!res.baseline) r.notes.push(`There is no record of the last build, so only additions to ${base(p.json)} are taken; other differences could be edits of yours in ${base(p.jsonc)}.`);
  if (res.applied.length) {
    r.lines.push(`${p.dryRun ? "Would take" : "Took"} ${res.applied.length} ${res.applied.length === 1 ? "change" : "changes"} from ${base(p.json)} into ${base(p.jsonc)}:`);
    r.lines.push(...changeLines(r.applied));
  } else r.lines.push(`Nothing to take from ${base(p.json)}: ${base(p.jsonc)} already has it all.`);
  if (r.conflicts.length) {
    r.lines.push(`Not taken, because ${base(p.jsonc)} says something else there (yours wins until you decide):`);
    for (const c of r.conflicts.slice(0, 12)) r.lines.push(`  ${describeOp(c.op, formatPath)}  -- ${c.reason}`);
  }
  if (r.unabsorbed.length) {
    r.lines.push("Left alone (they may be your own edits):");
    for (const c of r.unabsorbed.slice(0, 12)) r.lines.push(`  ${describeOp(c.op, formatPath)}`);
  }
  if (r.pending) r.notes.push(`${base(p.jsonc)} still differs from ${base(p.json)} in ${r.pending} ${r.pending === 1 ? "place" : "places"}: those are your own edits. Run ${cmd(opts, "build")} to write them.`);
  r.ok = r.conflicts.length === 0;
  if (p.dryRun) return r;
  if (res.applied.length) {
    r.backup = backupFile(p.jsonc, p.now);
    writeAtomic(p.jsonc, res.text);
    r.lines.push(`The old ${base(p.jsonc)} is saved as ${r.backup}. Undo with: ${cmd(opts, "restore")} --jsonc.`);
  }
  // the record moves on, unless something was left for the person to decide
  if (!r.conflicts.length) writeBaseline(p.cfg, p.json, jsonText, p.now);
  return r;
}

// ------------------------------------------------------------------------------------------------------------
// restore
// ------------------------------------------------------------------------------------------------------------

/** restore: put the newest backup of settings.json (or settings.jsonc with --jsonc) back. */
export function runRestore(opts) {
  const p = setup(opts);
  const file = opts.jsonc ? p.jsonc : p.json;
  const r = fresh("restore", p, { restored: false, from: null, savedCurrent: null, backups: [] });
  r.file = file;
  r.backups = listBackups(file);
  if (opts.list) {
    r.ok = true;
    r.lines.push(r.backups.length ? `${r.backups.length} ${r.backups.length === 1 ? "backup" : "backups"} of ${file}, oldest first:` : `There is no backup of ${file}.`);
    for (const b of r.backups) r.lines.push(`  ${b}`);
    return r;
  }
  const res = restoreBackup(file, { now: p.now, dryRun: p.dryRun });
  if (!res.from) return refuse(r, `${file}: ${res.reason}`);
  r.from = res.from;
  r.savedCurrent = res.savedCurrent;
  r.restored = res.restored;
  r.ok = true;
  r.lines.push(`${p.dryRun ? "Would restore" : "Restored"} ${file} from ${res.from}.`);
  if (res.savedCurrent) r.lines.push(`The file as it was is saved as ${res.savedCurrent}; run ${cmd(opts, "restore")}${opts.jsonc ? " --jsonc" : ""} again to switch back.`);
  if (!opts.jsonc) {
    // build would throw the restored settings away, so it refuses (the same test it makes) unless they match its last build
    const refuses = changedSinceBuild(readText(res.from), readBaseline(p.cfg, p.json)) !== null;
    r.notes.push(refuses
      ? `${base(p.jsonc)} was not changed. Run ${cmd(opts, "absorb")} to carry the restored settings into it. ${cmd(opts, "build")} refuses until then, because ${base(p.json)} differs from the last build; ${cmd(opts, "build")} --force would write ${base(p.jsonc)} over the restore.`
      : `${base(p.jsonc)} was not changed.`);
  } else r.notes.push(`${base(p.json)} was not changed. Run ${cmd(opts, "build")} to write it from the restored ${base(p.jsonc)}.`);
  return r;
}
