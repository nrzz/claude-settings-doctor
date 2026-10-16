// The command line: parse the arguments, run one command, print, return the exit code.
// Exit codes: 0 ok; 1 findings, a difference or a refusal (nothing was changed); 2 a usage error, or something
// that went wrong that the tool did not expect.
import os from "node:os";
import path from "node:path";
import { runAbsorb, runBuild, runCheck, runInit, runRestore } from "./actions.mjs";
import { buildExplain, buildLint, buildShow } from "./commands.mjs";
import { markdownLint, palette, renderExplain, renderLint, renderShow, renderWrite, strip } from "./report.mjs";
import { VERSION } from "./version.mjs";
import { watchBuild } from "./watch.mjs";

const HELP = `claude-settings-doctor ${VERSION}
Comments for your Claude Code settings, and the merged settings nobody shows you.

Usage: claude-settings-doctor <command> [options]

Read (they change nothing):
  show     [--project <dir>]
           the settings Claude Code merges: every value, the file it came from, which file wins,
           and the values a higher file shadows
  lint     [--project <dir>] [--file <path>] [--markdown]
           mistakes in the settings files that apply: a comment or a trailing comma (Claude Code
           ignores the whole file), keys the schema does not know, wrong types, bad values,
           deprecated keys, env values that are not strings, hook entries of the wrong shape,
           repeated keys, managedMcpServers outside managed settings. --file checks one file (a
           .jsonc too). Exit 1 on an error or a warning. --markdown is the short report the
           /settings-doctor:check skill hands to Claude (at most 12 findings); it always exits
           0, because Claude Code drops a skill whose command fails
  explain  <key> [--project <dir>]
           what the schema says about a key (permissions.defaultMode, hooks.PreToolUse): its type,
           default and description, and which file sets it now

The commented source (each takes --user, --project <dir> or --local to name the settings file):
  init     [--force] [--dry-run]
           write settings.jsonc next to settings.json, with a comment above each key the schema
           describes
  build    [--force] [--dry-run]
           write settings.json from settings.jsonc: comments and trailing commas gone, keys in
           order, two-space indentation; the old file is saved first; refuses when settings.json
           changed since the last build (--force overrides)
  check
           exit 1 when settings.json holds other settings than build would write from
           settings.jsonc, or does not exist (for CI and pre-commit); a different layout alone is
           fine. Writes nothing
  absorb   [--dry-run]
           take what Claude Code changed in settings.json (an "Always allow" rule, a /config
           change) into settings.jsonc, comments kept; the old settings.jsonc is saved first
  watch    [--poll <ms>] [--dry-run]
           build now, and again on every save of settings.jsonc; --poll looks at the file every
           <ms> milliseconds (50 or more), for a place where folder events do not arrive
  restore  [--jsonc] [--list] [--dry-run]
           put the newest backup back (of settings.jsonc with --jsonc); --list names the backups

Files: --user is <config folder>/settings.json (CLAUDE_CONFIG_DIR, else ~/.claude);
--project <dir> is <dir>/.claude/settings.json; --local is <dir>/.claude/settings.local.json
(<dir> is the folder --project names, else the folder you are in; on Linux and macOS in a git
repository --local is at the root of the repository). The commented source sits next to
each, with the extension .jsonc. Claude Code reads settings.json only.

Options for every command:
  --json         one JSON document on stdout
  --no-color     no colour on a terminal (NO_COLOR does the same)
  -h, --help     this text
  -v, --version  the version

Exit codes: 0 ok; 1 findings, a difference or a refusal; 2 a usage error or an unexpected error.
Environment: CLAUDE_CONFIG_DIR (Claude's config folder), NO_COLOR, and
CLAUDE_SETTINGS_DOCTOR_MANAGED_DIR (the folder to read managed-settings.json from, instead of the
system folder; the tests use it).
It reads settings files, writes only with init, build, absorb, watch and restore (a settings
file they replace is saved next to itself first), and never uses the network.
`;

class UsageError extends Error {}

const COMMANDS = new Set(["show", "lint", "explain", "init", "build", "check", "absorb", "watch", "restore"]);
const WRITES = new Set(["init", "build", "check", "absorb", "watch", "restore"]);
const FLAGS_WITH_VALUE = new Set(["--project", "--file", "--poll"]);
const FLAGS = new Set([...FLAGS_WITH_VALUE, "--user", "--local", "--json", "--markdown", "--dry-run", "--force", "--jsonc", "--list", "--no-color", "-h", "--help", "-v", "--version"]);

/** Parse argv into { command, positional, project, file, poll, user, local, json, ... }. */
export function parseArgs(argv) {
  const o = { command: null, positional: [], project: null, file: null, poll: 0, user: false, local: false, json: false, markdown: false, dryRun: false, force: false, jsonc: false, list: false, help: false, version: false, noColor: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    if (a.startsWith("--") && a.includes("=")) { inline = a.slice(a.indexOf("=") + 1); a = a.slice(0, a.indexOf("=")); }
    if (a.startsWith("-") && a !== "-") {
      if (!FLAGS.has(a)) throw new UsageError(`unknown option ${a}`);
      let value = null;
      if (FLAGS_WITH_VALUE.has(a)) {
        value = inline !== null ? inline : argv[++i];
        if (value === undefined || (inline === null && value.startsWith("-") && value.length > 1)) {
          throw new UsageError(a === "--project" ? "--project needs a folder (use --project . for the current folder)" : `${a} needs a value`);
        }
      } else if (inline !== null) throw new UsageError(`${a} does not take a value`);
      switch (a) {
        case "--project": o.project = value; break;
        case "--file": o.file = value; break;
        case "--poll":
          if (!/^\d+$/.test(value) || Number(value) < 50) throw new UsageError("--poll needs a number of milliseconds, 50 or more, such as --poll 500");
          o.poll = Number(value);
          break;
        case "--user": o.user = true; break;
        case "--local": o.local = true; break;
        case "--json": o.json = true; break;
        case "--markdown": o.markdown = true; break;
        case "--dry-run": o.dryRun = true; break;
        case "--force": o.force = true; break;
        case "--jsonc": o.jsonc = true; break;
        case "--list": o.list = true; break;
        case "--no-color": o.noColor = true; break;
        case "-h": case "--help": o.help = true; break;
        case "-v": case "--version": o.version = true; break;
        default:
      }
      continue;
    }
    if (o.command === null && COMMANDS.has(a)) o.command = a;
    else o.positional.push(a);
  }
  if (o.json && o.markdown) throw new UsageError("--json and --markdown cannot be combined");
  return o;
}

// Which settings file a writing command is about: { target, project, flag }.
function targetOf(o, cwd) {
  if (o.user && o.local) throw new UsageError("choose one settings file: --user or --local, not both");
  if (o.user && o.project !== null) throw new UsageError("--user is the user's file in the Claude config folder; it does not take --project");
  if (o.user) return { target: "user", project: cwd, flag: "--user" };
  if (o.local) return { target: "local", project: path.resolve(cwd, o.project || "."), flag: "--local" };
  // the flag as it is suggested to the person: a folder with a space in its name is quoted
  if (o.project !== null) return { target: "project", project: path.resolve(cwd, o.project), flag: `--project ${/\s/.test(o.project) ? `"${o.project.replace(/"/g, '\\"')}"` : o.project}` };
  throw new UsageError(`${o.command} needs the settings file: --user, --project <dir> or --local`);
}

/**
 * Run the tool. `io` lets tests capture output and fake the machine:
 * { stdout, stderr, env, cwd, home, platform, managed, now, signal }.
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;
  const home = io.home || os.homedir();
  const cwd = io.cwd || process.cwd();
  const platform = io.platform || process.platform;
  const now = io.now ?? Date.now();
  const wantsJson = argv.includes("--json");

  const fail = (message, code) => {
    if (wantsJson) stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    else stderr.write(`claude-settings-doctor: ${message}${code === 2 ? "\nTry: claude-settings-doctor --help" : ""}\n`);
    return code;
  };

  let o;
  try {
    o = parseArgs(argv);
    if (!o.help && !o.version && o.command === null) throw new UsageError(o.positional.length ? `unknown command ${o.positional[0]}` : "a command is needed");
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    return fail(e.message, 2);
  }
  if (o.help) { stdout.write(HELP); return 0; }
  if (o.version) { stdout.write(`${VERSION}\n`); return 0; }

  const color = !!stdout.isTTY && !env.NO_COLOR && !o.noColor;
  const p = palette(color);
  const common = { env, home, platform, managed: io.managed };
  const emit = (model, text) => stdout.write(o.json ? `${JSON.stringify(strip(model), null, 2)}\n` : text);

  try {
    const wrongFlags = (allowed, what) => {
      for (const [flag, on] of [["--user", o.user], ["--local", o.local], ["--markdown", o.markdown], ["--dry-run", o.dryRun], ["--force", o.force], ["--jsonc", o.jsonc], ["--list", o.list], ["--file", o.file !== null], ["--poll", o.poll > 0]]) {
        if (on && !allowed.includes(flag)) throw new UsageError(`${flag} does not belong to ${what}`);
      }
    };
    wrongFlags({ show: [], lint: ["--markdown", "--file"], explain: [], init: ["--user", "--local", "--dry-run", "--force"], build: ["--user", "--local", "--dry-run", "--force"], check: ["--user", "--local"], absorb: ["--user", "--local", "--dry-run"], watch: ["--user", "--local", "--dry-run", "--poll"], restore: ["--user", "--local", "--dry-run", "--jsonc", "--list"] }[o.command], o.command);
    if (o.markdown && o.command !== "lint") throw new UsageError("--markdown is for lint");
    const projectDir = path.resolve(cwd, o.project || ".");

    switch (o.command) {
      case "show": {
        if (o.positional.length) throw new UsageError(`show takes no arguments (got "${o.positional[0]}")`);
        const m = buildShow({ ...common, project: projectDir });
        emit(m, renderShow(m, { color }));
        return 0;
      }
      case "lint": {
        if (o.positional.length) throw new UsageError(`lint takes no arguments (got "${o.positional[0]}")`);
        const m = buildLint({ ...common, project: projectDir, file: o.file ? path.resolve(cwd, o.file) : null });
        if (o.json) stdout.write(`${JSON.stringify(m, null, 2)}\n`);
        else if (o.markdown) stdout.write(markdownLint(m));
        else stdout.write(renderLint(m, { color }));
        // --markdown is what the /settings-doctor:check skill runs, and Claude Code drops a skill whose command
        // exits with anything but 0 (seen on 2.1.295: no request reaches the model), so it reports and exits 0.
        if (o.markdown) return 0;
        return m.counts.error + m.counts.warning > 0 ? 1 : 0;
      }
      case "explain": {
        if (o.positional.length !== 1) throw new UsageError("explain needs one key, as in: explain permissions.defaultMode");
        const m = buildExplain({ ...common, project: projectDir, key: o.positional[0] });
        emit(m, renderExplain(m, { color }));
        return m.found ? 0 : 1;
      }
      default:
    }

    // the commands that write take a settings file
    if (!WRITES.has(o.command)) throw new UsageError(`unknown command ${o.command}`);
    if (o.command === "restore" && o.positional.length) throw new UsageError("restore takes no arguments; name the file with --user, --project <dir> or --local");
    if (o.positional.length) throw new UsageError(`${o.command} takes no arguments (got "${o.positional[0]}")`);
    const t = targetOf(o, cwd);
    const opts = { ...common, target: t.target, project: t.project, dryRun: o.dryRun, force: o.force, now, targetFlag: t.flag, jsonc: o.jsonc, list: o.list };
    const show = (r) => emit(r, renderWrite(r, { color }));

    switch (o.command) {
      case "init": { const r = runInit(opts); show(r); return r.ok ? 0 : 1; }
      case "build": { const r = runBuild(opts); show(r); return r.ok ? 0 : 1; }
      case "check": { const r = runCheck(opts); show(r); return r.ok && !r.differs ? 0 : 1; }
      case "absorb": { const r = runAbsorb(opts); show(r); return r.ok ? 0 : 1; }
      case "restore": { const r = runRestore(opts); show(r); return r.ok ? 0 : 1; }
      case "watch": {
        const controller = new AbortController();
        const signal = io.signal || controller.signal;
        const stop = () => controller.abort();
        if (!io.signal) { process.once("SIGINT", stop); process.once("SIGTERM", stop); }
        let failed = false;
        const clock = () => new Date(io.now ?? Date.now()).toTimeString().slice(0, 8);
        stdout.write(o.json ? "" : `Watching the source of ${o.user ? "the user's settings" : "the settings"}: ${o.poll ? `looking every ${o.poll} ms` : "waiting for saves"}. Ctrl+C stops.\n`);
        try {
          await watchBuild(opts, {
            signal,
            poll: o.poll,
            onResult: (r, why) => {
              if (o.json) stdout.write(`${JSON.stringify({ event: why, ...r })}\n`);
              else stdout.write(`${p.dim(`[${clock()}]`)} ${why === "start" ? "built at start" : "saved"}: ${r.refused ? p.red(`refused: ${r.refused}`) : r.lines[0] || "ok"}\n`);
              if (r.refused && why === "start") failed = true;
            },
          });
        } catch (e) { return fail(e.message, 1); }
        return failed ? 1 : 0;
      }
      default:
        throw new UsageError(`unknown command ${o.command}`);
    }
  } catch (e) {
    if (e instanceof UsageError) return fail(e.message, 2);
    return fail(e && e.message ? e.message : String(e), 2);
  }
}


