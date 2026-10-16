// Running the real claude binary at zero cost, for the checks that need it (test/e2e-claude.test.mjs).
//
// A check runs only when E2E_CLAUDE names a Claude Code binary ("claude" on a CI machine after
// `npm install -g @anthropic-ai/claude-code`, or the full path to claude.exe). Otherwise it is skipped, and
// `npm test` needs nothing but Node. The binary runs in a throwaway folder with its own config folder and home,
// with an environment scrubbed of every CLAUDE_* and ANTHROPIC_* variable of the machine, and with
// ANTHROPIC_BASE_URL pointing at a tiny server on 127.0.0.1 that answers from a script (text, or a tool call
// and then text). No request leaves the machine, no token is spent, no login is needed.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./helpers.mjs";

export const CLAUDE = process.env.E2E_CLAUDE || "";
export const RECORD = fileURLToPath(new URL("./record-hook.mjs", import.meta.url));
const IS_WIN = process.platform === "win32";
const USAGE = { input_tokens: 1, output_tokens: 1 };
const viaShell = () => IS_WIN && !/\.exe$/i.test(CLAUDE);

/** A scrubbed environment: none of the machine's CLAUDE_* and ANTHROPIC_* variables, no updates, no telemetry. */
export function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC|CLAUDECODE|AI_AGENT)/i.test(k)) env[k] = v;
  return { ...env, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_COLOR: "1", ...bashEnv(), ...extra };
}

let info;
/** { ok, version, reason }: whether E2E_CLAUDE names a binary that runs, and the version it prints. */
export function claudeInfo() {
  if (info) return info;
  if (!CLAUDE) return (info = { ok: false, version: "", reason: "E2E_CLAUDE is not set (point it at a claude binary to run the checks against the real thing)" });
  const home = tmpDir("csd-e2e-probe-");
  const r = spawnSync(CLAUDE, ["--version"], { encoding: "utf8", timeout: 60000, windowsHide: true, shell: viaShell(), env: baseEnv({ CLAUDE_CONFIG_DIR: path.join(home, ".claude"), HOME: home, USERPROFILE: home }) });
  const version = (r.stdout || "").trim();
  info = r.status === 0 && version ? { ok: true, version, reason: "" } : { ok: false, version: "", reason: `E2E_CLAUDE (${CLAUDE}) did not run: ${(r.error && r.error.message) || (r.stderr || "").trim().slice(0, 120)}` };
  return info;
}
/** The value for node:test's `skip` option: false when the binary is there, else the reason. */
export const skip = () => (claudeInfo().ok ? false : claudeInfo().reason);

/** Git Bash on Windows, so the Bash tool exists; nothing on the other systems. */
function bashEnv() {
  if (!IS_WIN) return {};
  const candidates = [];
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  const where = spawnSync("where", ["git"], { encoding: "utf8", windowsHide: true });
  for (const line of (where.stdout || "").split(/\r?\n/).filter(Boolean)) candidates.push(path.join(path.dirname(line), "..", "bin", "bash.exe"));
  candidates.push("C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe");
  for (const c of candidates) if (c && fs.existsSync(c)) return { CLAUDE_CODE_USE_POWERSHELL_TOOL: "0", CLAUDE_CODE_GIT_BASH_PATH: path.resolve(c).replace(/\\/g, "/") };
  return {};
}

/**
 * A throwaway world for the binary: home, a config folder and a project folder that Claude Code already trusts.
 *   cfg/settings.json                 the user's file
 *   work/.claude/settings.json        the project's file
 *   work/.claude/settings.local.json  the local file
 */
export function sandbox(label) {
  const root = tmpDir(`csd-e2e-${label}-`);
  const home = path.join(root, "home");
  const cfg = path.join(root, "cfg");
  const work = path.join(root, "work");
  for (const d of [home, cfg, work]) fs.mkdirSync(d, { recursive: true });
  const trusted = { hasTrustDialogAccepted: true, allowedTools: [] };
  fs.writeFileSync(path.join(cfg, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: { [work]: trusted, [work.replace(/\\/g, "/")]: trusted } }));
  return {
    root, home, cfg, work,
    log: path.join(root, "events.jsonl"),
    user: path.join(cfg, "settings.json"),
    project: path.join(work, ".claude", "settings.json"),
    local: path.join(work, ".claude", "settings.local.json"),
    managed: path.join(root, "managed"),
  };
}

/** Write a settings file: an object as JSON, a string as it is. */
export function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

const msgStart = (id, model) => ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: model || "x", content: [], stop_reason: null, usage: USAGE } }];

/** SSE events for an assistant message with the given blocks: { text } or { tool, input, id }. */
export function message(id, model, blocks) {
  const ev = [msgStart(id, model)];
  blocks.forEach((b, i) => {
    if (b.text !== undefined) {
      ev.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }]);
      ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } }]);
    } else {
      ev.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id || `toolu_${id}_${i}`, name: b.tool, input: {} } }]);
      ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }]);
    }
    ev.push(["content_block_stop", { type: "content_block_stop", index: i }]);
  });
  ev.push(["message_delta", { type: "message_delta", delta: { stop_reason: blocks.some((b) => b.tool) ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }]);
  ev.push(["message_stop", { type: "message_stop" }]);
  return ev;
}

/** All the text the user side of a request holds (the prompt, expanded skills, tool results). */
export const userText = (j) => (j.messages || []).filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : (m.content || []).map((b) => b.text || "").join(""))).join("\n");
/** Every text block of a request's messages. */
export const textBlocks = (request) => (request.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content])).map((b) => (typeof b === "string" ? b : (b && b.text) || ""));

/**
 * The fake Messages API. Every request is recorded in `requests`, whole. A request is answered with the text
 * "PROBE-DONE", or, for the first request of the main conversation (its prompt holds PROBE-MAIN), with the one
 * tool call `call` when one is given.
 */
export function fakeApi(call) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (!req.url.includes("/v1/messages")) { res.writeHead(404); res.end("{}"); return; }
      let j = {};
      try { j = JSON.parse(body); } catch { /* empty */ }
      requests.push(j);
      const n = requests.length;
      if (j.stream === false) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `msg_${n}`, type: "message", role: "assistant", model: j.model || "x", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: USAGE }));
        return;
      }
      const asked = (j.messages || []).some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use"));
      const main = userText(j).includes("PROBE-MAIN");
      const events = main && call && !asked ? message(`msg_${n}`, j.model, [{ tool: call.tool, id: "toolu_probe", input: call.input }]) : message(`msg_${n}`, j.model, [{ text: "PROBE-DONE" }]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { server.unref(); resolve({ port: server.address().port, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) }); }));
}

function killTree(child) {
  try {
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-child.pid, "SIGKILL");
  } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
}

/**
 * Run claude in the sandbox's project folder. Resolves { code, out, err, result } (result: the --output-format json
 * document). `api` is the fake API the binary talks to; null for a command that needs none (claude doctor).
 */
export function runClaude(sb, api, args, { timeout = 120000, env = {}, cwd } = {}) {
  return new Promise((resolve) => {
    const childEnv = baseEnv({ CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, USERPROFILE: sb.home, ...(api ? { ANTHROPIC_API_KEY: "sk-ant-probe", ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}` } : {}), CSD_LOG: sb.log, ...env });
    const quoted = [CLAUDE, ...args].map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
    const where = cwd || sb.work;
    const child = viaShell() ? spawn(quoted, [], { cwd: where, env: childEnv, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) : spawn(CLAUDE, args, { cwd: where, env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: !IS_WIN });
    let out = "";
    let err = "";
    child.on("error", (e) => { err += String(e); });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => killTree(child), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      let result = null;
      try { result = JSON.parse(out); } catch { /* not json */ }
      resolve({ code, out, err, result });
    });
  });
}

/** Run claude with no model involved (`claude doctor`, `claude plugin ...`), in the sandbox's world. Resolves { status, out, err, all }. */
export function claudeSync(sb, args, { timeout = 100000, env = {} } = {}) {
  const childEnv = baseEnv({ CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, USERPROFILE: sb.home, ...env });
  const r = spawnSync(CLAUDE, args, { encoding: "utf8", timeout, env: childEnv, cwd: sb.work, windowsHide: true, shell: viaShell(), input: "" });
  return { status: r.status, out: r.stdout || "", err: r.stderr || "", all: `${r.stdout || ""}${r.stderr || ""}` };
}

/** What the recording hook wrote: one object per run, with { label, input, env, cwd }. */
export function readLog(sb) {
  if (!fs.existsSync(sb.log)) return [];
  return fs.readFileSync(sb.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * A command hook entry that records one line in the sandbox's log when it runs (exec form, node): the label,
 * the event's JSON and the CLAUDE_* and CSD_* environment it got.
 */
export function recorder(label) {
  return { type: "command", command: process.execPath, args: [RECORD, label] };
}

/** A settings hooks object with the recorder on a SessionStart group, labelled. */
export function sessionStartHook(label) {
  return { SessionStart: [{ hooks: [recorder(label)] }] };
}
