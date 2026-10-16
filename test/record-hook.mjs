// A hook for the real-binary checks: appends one line to the file named by CSD_LOG when Claude Code runs it: the
// label (its first argument), the event's JSON from stdin, the working folder and the CLAUDE_* and CSD_*
// environment it was given. That a line is there, or is not, shows whether a hook ran.
import fs from "node:fs";

// `node --test` also runs every file under test/: without CSD_LOG this is not a hook run, so do nothing (reading stdin would block)
if (!process.env.CSD_LOG) process.exit(0);

const label = process.argv[2] || "";
let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch { raw = ""; }
let input = null;
try { input = JSON.parse(raw); } catch { input = { unparsed: raw }; }
const env = {};
for (const [k, v] of Object.entries(process.env)) if (/^(CLAUDE|CSD_)/.test(k)) env[k] = v;
fs.appendFileSync(process.env.CSD_LOG, `${JSON.stringify({ label, at: Date.now(), cwd: process.cwd(), env, input })}\n`);
process.exit(0);
