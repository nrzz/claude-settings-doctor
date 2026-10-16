// Shared test helpers: throwaway worlds (a Claude config folder, a home folder, project folders) and ways to
// run the CLI.
//
// SAFETY: nothing here reads or writes the real Claude folder. Importing this file points HOME, USERPROFILE,
// CLAUDE_CONFIG_DIR and the managed-settings folder of the test process at an empty temporary folder, so even
// a test that forgets to pass its own environment cannot reach ~/.claude. Every child process gets a world's
// environment, and runCli refuses to run with a config or home folder outside the OS temp folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "bin", "claude-settings-doctor.mjs");
export const NOW = Date.parse("2026-10-16T12:00:00.000Z");

const made = [];
export function tmpDir(prefix = "csd-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
process.on("exit", () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* the OS cleans the temp folder eventually */ } } });

// The guard: an empty home, config folder and managed-settings folder for this process.
const guard = tmpDir("csd-guard-");
process.env.HOME = guard;
process.env.USERPROFILE = guard;
process.env.CLAUDE_CONFIG_DIR = path.join(guard, ".claude");
process.env.CLAUDE_SETTINGS_DOCTOR_MANAGED_DIR = path.join(guard, "no-managed-settings");
process.env.NO_COLOR = "1";
for (const k of Object.keys(process.env)) if (/^(CLAUDE_CODE_|ANTHROPIC_)/.test(k)) delete process.env[k];
delete process.env.CLAUDE_PROJECT_DIR;

const underTmp = (p) => path.resolve(p).toLowerCase().startsWith(fs.realpathSync(os.tmpdir()).toLowerCase());
const configDirOf = (e) => e.CLAUDE_CONFIG_DIR || path.join((process.platform === "win32" ? e.USERPROFILE || e.HOME : e.HOME) || "", ".claude");

const asText = (v) => (typeof v === "string" ? v : `${JSON.stringify(v, null, 2)}\n`);
const put = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, asText(v)); return file; };

// A throwaway world: base/home/.claude is the config folder, base/work/<name> are project folders, base/managed
// is the managed-settings folder. Settings files are written from objects (as JSON) or from text.
export function world(name = "w", { user, project, local, managed } = {}) {
  const base = tmpDir(`csd-${name}-`);
  const home = path.join(base, "home");
  const claude = path.join(home, ".claude");
  const work = path.join(base, "work", "proj");
  const managedDir = path.join(base, "managed");
  for (const d of [claude, work]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claude, CLAUDE_SETTINGS_DOCTOR_MANAGED_DIR: managedDir, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  const w = {
    base, home, claude, work, managedDir, env,
    userFile: path.join(claude, "settings.json"),
    projectFile: path.join(work, ".claude", "settings.json"),
    localFile: path.join(work, ".claude", "settings.local.json"),
    managedFile: path.join(managedDir, "managed-settings.json"),
    write: (file, v) => put(file, v),
    read: (file) => fs.readFileSync(file, "utf8"),
    exists: (file) => fs.existsSync(file),
    user: (v) => put(w.userFile, v),
    project: (v) => put(w.projectFile, v),
    local: (v) => put(w.localFile, v),
    managedSettings: (v) => put(w.managedFile, v),
    // names of the backups of a file made by this tool
    backups: (file) => { try { return fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file)}.bak-settings-doctor-`)).sort(); } catch { return []; } },
  };
  if (user !== undefined) w.user(user);
  if (project !== undefined) w.project(project);
  if (local !== undefined) w.local(local);
  if (managed !== undefined) w.managedSettings(managed);
  return w;
}

// Runs the real CLI in a child process.
export function runCli(args, { cwd, env, input, timeout = 120000 } = {}) {
  const e = { ...process.env, ...env };
  if (!underTmp(configDirOf(e)) || !underTmp(e.HOME || "") || !underTmp(e.USERPROFILE || "")) {
    throw new Error("runCli needs an environment from world(): the Claude config and home folders must be temporary");
  }
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: e, input, encoding: "utf8", windowsHide: true, timeout });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", all: `${r.stdout || ""}${r.stderr || ""}` };
}

// Runs main() in this process and captures what it prints.
export async function run(args, w, { cwd, env = {}, now = NOW, platform, tty = false, stdin } = {}) {
  let out = "";
  let err = "";
  const code = await main(args, {
    cwd: cwd || w.work,
    env: { ...w.env, ...env },
    home: w.home,
    managed: w.managedDir,
    platform,
    now,
    stdout: { write: (s) => { out += s; return true; }, isTTY: tty },
    stderr: { write: (s) => { err += s; return true; } },
    stdin,
  });
  return { code, out, err, all: out + err, json: () => JSON.parse(out) };
}

export const fwd = (p) => String(p).split(path.sep).join("/");
