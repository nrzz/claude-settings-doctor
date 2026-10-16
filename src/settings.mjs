// Find and read every settings file that applies to a project. The paths and their order come from
// claude-permission-doctor's loader (which checked them against Claude Code); this one keeps the text and a
// reading of it, so the lint can say where a comma is wrong and the merge can say where a key came from.
//
// Files, from the highest precedence down (docs: "Settings files and who they affect"; the order of user,
// project and local was put to the real binary, see the README):
//   managed   managed-settings.json (+ managed-settings.d/*.json) in the system folder. Server-managed
//             settings, macOS profiles and the Windows registry are not files and are not read.
//   local     <project>/.claude/settings.local.json (in a git repository Claude Code keeps it at the
//             repository root, except on Windows and in a few other cases)
//   project   <project>/.claude/settings.json
//   user      <config folder>/settings.json, where the config folder is $CLAUDE_CONFIG_DIR or ~/.claude
//
// Nothing here writes. Claude Code ignores a file that is not strict JSON (a comment or a trailing comma
// is enough); such a file is kept in the list, marked ignored, and left out of the merge.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsonc, positionAt } from "./jsonc.mjs";

export const SCOPES = ["managed", "local", "project", "user"];

/** The folder Claude Code keeps its user settings, transcripts and plugins in. */
export function configDir(env = process.env, home = os.homedir()) {
  if (env.CLAUDE_CONFIG_DIR) return { dir: path.resolve(env.CLAUDE_CONFIG_DIR), source: "CLAUDE_CONFIG_DIR" };
  return { dir: path.join(home, ".claude"), source: "default" };
}

/** Where a machine-wide managed-settings.json lives on this system. */
export function managedDir(platform = process.platform) {
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  return "/etc/claude-code";
}

/** The git repository root above `dir` (a worktree resolves to its main checkout), or null. */
export function gitRoot(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    const dotgit = path.join(d, ".git");
    let st = null;
    try { st = fs.statSync(dotgit); } catch { /* not here */ }
    if (st) {
      if (st.isFile()) {
        try {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, "utf8"));
          if (m) {
            const gd = path.resolve(d, m[1].trim());
            const w = gd.split(path.sep).lastIndexOf("worktrees");
            if (w > 0) return path.dirname(gd.split(path.sep).slice(0, w).join(path.sep));
          }
        } catch { /* use d */ }
      }
      return d;
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/**
 * Where the local settings file is, for a session started in `project`: the repository root in a git
 * repository, else the folder itself. Not at the root on Windows, when the root is the home folder, or when
 * the folder's owner is someone else. Claude Code also still reads a file older versions left in the folder.
 */
export function localSettingsPaths(project, { home = os.homedir(), platform = process.platform } = {}) {
  const own = path.join(project, ".claude", "settings.local.json");
  if (platform === "win32") return [own];
  const root = gitRoot(project);
  if (!root || path.resolve(root) === path.resolve(home)) return [own];
  try {
    const me = typeof process.getuid === "function" ? process.getuid() : null;
    if (me !== null && fs.statSync(root).uid !== me) return [own];
  } catch { /* cannot tell: use the root */ }
  const atRoot = path.join(root, ".claude", "settings.local.json");
  return atRoot === own ? [own] : [atRoot, own];
}

/** Display form of a settings file path: ~/... under the home folder, project-relative inside the project. */
export function shortPath(file, { home, project }) {
  const f = path.resolve(file);
  const within = (base) => {
    const rel = path.relative(base, f);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
  };
  const posix = (p) => p.split(path.sep).join("/");
  const p = project ? within(project) : null;
  if (p) return posix(p);
  const h = home ? within(home) : null;
  if (h) return `~/${posix(h)}`;
  return posix(f);
}

/** settings.json -> settings.jsonc, settings.local.json -> settings.local.jsonc: the commented source of a file. */
export const jsoncPath = (settingsFile) => (settingsFile.endsWith(".json") ? `${settingsFile}c` : `${settingsFile}.jsonc`);

const stripBom = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

/**
 * Read a settings text the way Claude Code does, and say what is wrong with it.
 * Returns { empty, bom, parse, data, problems, ignored }:
 *   data      the settings object when Claude Code would load the text, else null
 *   problems  [{ kind: "syntax" | "comment" | "trailing-comma" | "not-object", message, offset, line, column, ... }]
 *   ignored   true when there are problems: Claude Code skips the whole file
 * A byte-order mark is fine (Claude Code loads such a file); an empty file is an empty object.
 */
export function analyzeText(text) {
  const parse = parseJsonc(text);
  const bom = parse.bom;
  const out = { empty: false, bom, parse, data: null, problems: [], ignored: false };
  const at = (offset) => positionAt(text, offset);
  if (stripBom(text).trim() === "") { out.empty = true; out.data = {}; return out; }
  if (!parse.ok) {
    out.problems.push({ kind: "syntax", message: parse.error.message, offset: parse.error.offset, ...at(parse.error.offset) });
  } else {
    if (parse.comments.length) {
      const lines = [...new Set(parse.comments.map((c) => at(c.start).line))];
      const first = parse.comments[0];
      out.problems.push({ kind: "comment", message: `${parse.comments.length === 1 ? "a comment" : `${parse.comments.length} comments`} (${parse.comments.some((c) => c.kind === "line") ? "//" : "/* */"}), which JSON does not have`, offset: first.start, ...at(first.start), lines, count: parse.comments.length });
    }
    if (parse.trailingCommas.length) {
      const lines = [...new Set(parse.trailingCommas.map((o) => at(o).line))];
      const first = parse.trailingCommas[0];
      out.problems.push({ kind: "trailing-comma", message: `${parse.trailingCommas.length === 1 ? "a trailing comma" : `${parse.trailingCommas.length} trailing commas`}, which JSON does not allow`, offset: first, ...at(first), lines, count: parse.trailingCommas.length });
    }
  }
  if (out.problems.length === 0) {
    let data;
    try { data = JSON.parse(stripBom(text)); } catch (e) {
      out.problems.push({ kind: "syntax", message: String(e.message).replace(/\s+/g, " ").slice(0, 140), offset: 0, line: 1, column: 1 });
    }
    if (out.problems.length === 0) {
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        const what = data === null ? "null" : Array.isArray(data) ? "an array" : `${typeof data === "string" ? "a string" : typeof data === "number" ? "a number" : "a boolean"}`;
        const root = parse.root;
        out.problems.push({ kind: "not-object", message: `the file holds ${what}, and Claude Code wants an object ({ ... })`, offset: root.start, ...at(root.start) });
      } else out.data = data;
    }
  }
  out.ignored = out.problems.length > 0;
  return out;
}

function readText(file) {
  try {
    return { exists: true, text: fs.readFileSync(file, "utf8") };
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return { exists: false };
    return { exists: true, readError: `cannot be read (${e.code || e.message})` };
  }
}

/**
 * Read all settings files that apply.
 *   project   the folder Claude Code starts in
 *   env, home, platform   injectable so tests never touch the real machine
 *   managed   override the folder searched for managed settings (tests)
 * Returns { configDir, configSource, project, home, files }, files highest precedence first; each file is
 *   { scope, label, path, display, rank, exists, readError, text, analysis, jsonc: { path, exists } }
 * rank is the order of precedence: a higher rank wins.
 */
export function loadSettings({ project, env = process.env, home = os.homedir(), platform = process.platform, managed } = {}) {
  const cfg = configDir(env, home);
  const proj = path.resolve(project || process.cwd());
  const files = [];
  const add = (scope, label, file, rank) => {
    const r = readText(file);
    const f = { scope, label, path: file, display: shortPath(file, { home, project: proj }), rank, exists: r.exists, readError: r.readError || null, text: r.text, analysis: null, jsonc: { path: jsoncPath(file), exists: false } };
    if (r.exists && r.text !== undefined) f.analysis = analyzeText(r.text);
    f.jsonc.exists = fs.existsSync(f.jsonc.path);
    files.push(f);
    return f;
  };

  const mdir = managed || env.CLAUDE_SETTINGS_DOCTOR_MANAGED_DIR || managedDir(platform);
  add("managed", "managed settings", path.join(mdir, "managed-settings.json"), 40);
  try {
    const drop = path.join(mdir, "managed-settings.d");
    const names = fs.readdirSync(drop).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
    names.forEach((name, i) => add("managed", `managed settings (${name})`, path.join(drop, name), 41 + i));
  } catch { /* no drop-in folder */ }
  const locals = localSettingsPaths(proj, { home, platform });
  locals.forEach((p, i) => add("local", "local settings", p, 30 - i));
  add("project", "project settings", path.join(proj, ".claude", "settings.json"), 20);
  add("user", "user settings", path.join(cfg.dir, "settings.json"), 10);
  files.sort((a, b) => b.rank - a.rank);
  return { configDir: cfg.dir, configSource: cfg.source, project: proj, home, files };
}

/** The settings file a target flag names: { scope, path } for --user, --project <dir> or --local. */
export function targetFile({ target, project, env = process.env, home = os.homedir(), platform = process.platform }) {
  const proj = path.resolve(project || process.cwd());
  if (target === "user") return { scope: "user", path: path.join(configDir(env, home).dir, "settings.json"), project: proj };
  if (target === "project") return { scope: "project", path: path.join(proj, ".claude", "settings.json"), project: proj };
  // the file Claude Code writes is the first one listed
  return { scope: "local", path: localSettingsPaths(proj, { home, platform })[0], project: proj };
}
