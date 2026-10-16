// A table of settings with one thing wrong in each, what the lint says, and what `claude doctor` (Claude Code
// 2.1.295) listed under "Invalid settings" for the same file. test/lint.test.mjs checks the lint column;
// test/e2e-claude.test.mjs puts every row to the real binary (`claude doctor`, and whether the file applies at all)
// and checks that the doctor column and the lint agree with what it does.
//
// file     the settings file as an object, or as text when the text itself is the point
// expect   what lint reports: "severity id effect key.path" (the effect is what Claude Code does about it)
// doctor   the key paths `claude doctor` lists for the file ("(file)" for the whole file); [] when it lists none
//
// The lint "complains" in the sense of the doctor when the effect is file, field, entry or group. The effect `file`
// means Claude Code ignores the whole file; the e2e test checks that with a `model` added to the file, which arrives
// in the request to the API when the file applies and does not when the file is ignored.

const cmd = { type: "command", command: "echo hi" };
const ss = (entry, group = {}) => ({ hooks: { SessionStart: [{ ...group, hooks: [entry] }] } });
const stop = (entry) => ({ hooks: { Stop: [{ hooks: [entry] }] } });
const pre = (entry, group = {}) => ({ hooks: { PreToolUse: [{ ...group, hooks: [entry] }] } });

const FILE = "error invalid-json file (the whole file)";

export const ROWS = [
  // --- the text is not JSON ---------------------------------------------------------------------------------
  { name: "a // comment", file: '{\n  // a note\n  "model": "m"\n}\n', expect: [FILE], doctor: ["(file)"] },
  { name: "a /* */ comment", file: '{\n  /* a note */\n  "model": "m"\n}\n', expect: [FILE], doctor: ["(file)"] },
  { name: "a trailing comma in an object", file: '{\n  "model": "m",\n}\n', expect: [FILE], doctor: ["(file)"] },
  { name: "a trailing comma in an array", file: '{"permissions": {"allow": ["Bash(ls)",]}}', expect: [FILE], doctor: ["(file)"] },
  { name: "single quotes", file: "{'model': 'm'}", expect: [FILE], doctor: ["(file)"] },
  { name: "an unquoted key", file: "{model: 'm'}", expect: [FILE], doctor: ["(file)"] },
  { name: "a file cut short", file: '{"model": ', expect: [FILE], doctor: ["(file)"] },
  { name: "NaN", file: '{"cleanupPeriodDays": NaN}', expect: [FILE], doctor: ["(file)"] },
  { name: "an array at the top", file: "[]", expect: ["error not-an-object file (the whole file)"], doctor: ["(file)"] },
  { name: "a string at the top", file: '"x"', expect: ["error not-an-object file (the whole file)"], doctor: ["(file)"] },
  { name: "null at the top", file: "null", expect: ["error not-an-object file (the whole file)"], doctor: ["(file)"] },
  { name: "a byte-order mark is fine", file: '﻿{"model": "m"}', expect: [], doctor: [] },
  { name: "an empty file", file: "", expect: ["note empty-file none (the whole file)"], doctor: [] },
  { name: "an empty object", file: {}, expect: [], doctor: [] },

  // --- keys written twice, keys that are not in the schema ---------------------------------------------------
  { name: "a repeated env key", file: '{"env": {"A": "1"}, "env": {"B": "2"}}', expect: ["warning duplicate-key key env"], doctor: [] },
  { name: "a repeated value inside env", file: '{"env": {"A": "1", "A": "2"}}', expect: ["warning duplicate-key key env.A"], doctor: [] },
  { name: "an unknown key", file: { notARealKey: true }, expect: ["warning unknown-key key notARealKey"], doctor: [] },
  { name: "a typo", file: { permisions: { allow: ["Bash(ls)"] } }, expect: ["warning unknown-key key permisions"], doctor: [] },
  { name: "an unknown key inside permissions", file: { permissions: { zzz: 1 } }, expect: ["warning unknown-key key permissions.zzz"], doctor: [] },
  { name: "an unknown key inside statusLine", file: { statusLine: { type: "command", command: "x", zzz: 1 } }, expect: ["warning unknown-key key statusLine.zzz"], doctor: [] },
  { name: "a deprecated key", file: { includeCoAuthoredBy: true }, expect: ["warning deprecated none includeCoAuthoredBy"], doctor: [] },

  // --- values of the wrong type, outside a list or range -----------------------------------------------------
  { name: "model is a number", file: { model: 5 }, expect: ["error wrong-type file model"], doctor: ["model"] },
  { name: "a number written as a string", file: { cleanupPeriodDays: "30" }, expect: ["error wrong-type file cleanupPeriodDays"], doctor: ["cleanupPeriodDays"] },
  { name: "cleanupPeriodDays 0", file: { cleanupPeriodDays: 0 }, expect: ["error bad-value file cleanupPeriodDays"], doctor: ["cleanupPeriodDays"] },
  { name: "cleanupPeriodDays 1.5", file: { cleanupPeriodDays: 1.5 }, expect: ["error wrong-type file cleanupPeriodDays"], doctor: ["cleanupPeriodDays"] },
  { name: "a boolean written as a string", file: { alwaysThinkingEnabled: "true" }, expect: ["error wrong-type file alwaysThinkingEnabled"], doctor: ["alwaysThinkingEnabled"] },
  { name: "feedbackSurveyRate above 1", file: { feedbackSurveyRate: 5 }, expect: ["error bad-value file feedbackSurveyRate"], doctor: ["feedbackSurveyRate"] },
  { name: "a nested boolean as a string", file: { sandbox: { enabled: "yes" } }, expect: ["error wrong-type file sandbox.enabled"], doctor: ["sandbox.enabled"] },
  { name: "permissions is an array", file: { permissions: [] }, expect: ["error wrong-type file permissions"], doctor: ["permissions"] },
  { name: "permissions.allow is a string", file: { permissions: { allow: "Bash(ls)" } }, expect: ["error wrong-type file permissions.allow"], doctor: ["permissions.allow"] },
  { name: "a number among the rules", file: { permissions: { allow: [5] } }, expect: ["error wrong-type entry permissions.allow[0]"], doctor: ["permissions.allow"] },
  { name: "a rule with a lower-case tool", file: { permissions: { allow: ["bash(ls)"] } }, expect: ["warning bad-value entry permissions.allow[0]"], doctor: ["permissions.allow"] },
  { name: "a rule twice", file: { permissions: { allow: ["Bash(ls)", "Bash(ls)"] } }, expect: ["note duplicate-item none permissions.allow[1]"], doctor: [] },
  { name: "defaultMode not in the list", file: { permissions: { defaultMode: "bogus" } }, expect: ["error bad-value file permissions.defaultMode"], doctor: ["permissions.defaultMode"] },
  { name: "defaultMode delegate: the schema allows it, the binary does not", file: { permissions: { defaultMode: "delegate" } }, expect: ["error bad-value file permissions.defaultMode"], doctor: ["permissions.defaultMode"] },
  { name: "defaultMode manual: the binary takes it", file: { permissions: { defaultMode: "manual" } }, expect: [], doctor: [] },
  { name: "autoUpdatesChannel rc: the binary takes it, the schema lacks it", file: { autoUpdatesChannel: "rc" }, expect: [], doctor: [] },
  { name: "autoUpdatesChannel beta", file: { autoUpdatesChannel: "beta" }, expect: ["error bad-value file autoUpdatesChannel"], doctor: ["autoUpdatesChannel"] },
  { name: "env is an array", file: { env: [] }, expect: ["error wrong-type file env"], doctor: ["env"] },
  { name: "env values that are not strings", file: { env: { NUM: 1, BOOL: true, NIL: null } }, expect: ["warning env-not-string coerced env.NUM", "warning env-not-string coerced env.BOOL", "warning env-not-string coerced env.NIL"], doctor: [] },
  { name: "an env name in lower case", file: { env: { zzz_lower: "x" } }, expect: ["note env-name none env.zzz_lower"], doctor: [] },
  { name: "hooks is an array", file: { hooks: [] }, expect: ["error hook-shape field hooks"], doctor: ["hooks"] },
  { name: "allowedMcpServers is a string", file: { allowedMcpServers: "x" }, expect: ["error wrong-type field allowedMcpServers"], doctor: ["allowedMcpServers"] },
  { name: "deniedMcpServers is a string", file: { deniedMcpServers: "x" }, expect: ["error wrong-type field deniedMcpServers"], doctor: ["deniedMcpServers"] },
  { name: "extraKnownMarketplaces is a string", file: { extraKnownMarketplaces: "x" }, expect: ["error wrong-type field extraKnownMarketplaces"], doctor: ["extraKnownMarketplaces"] },
  { name: "managedMcpServers is a string", file: { managedMcpServers: "x" }, expect: ["error wrong-type field managedMcpServers"], doctor: ["managedMcpServers"] },
  { name: "statusLine without a command", file: { statusLine: { type: "command" } }, expect: ["error wrong-type file statusLine"], doctor: ["statusLine.command"] },
  { name: "statusLine is a string", file: { statusLine: "x" }, expect: ["error wrong-type file statusLine"], doctor: ["statusLine"] },
  { name: "attribution as a boolean: the binary takes it", file: { attribution: true }, expect: [], doctor: [] },
  { name: "attribution.commit is a number", file: { attribution: { commit: 5 } }, expect: ["error wrong-type file attribution.commit"], doctor: ["attribution.commit"] },
  { name: "null where the schema wants a boolean: the binary takes it for these keys", file: { disableWorkflows: null, channelsEnabled: null }, expect: [], doctor: [] },
  { name: "null where the binary wants a boolean", file: { verbose: null }, expect: ["error wrong-type file verbose"], doctor: ["verbose"] },
  { name: "a key the binary does not check (effortLevel)", file: { effortLevel: "extreme" }, expect: ["warning bad-value none effortLevel"], doctor: [] },
  { name: "a key the binary does not check (theme)", file: { theme: 5 }, expect: ["warning wrong-type none theme"], doctor: [] },
  { name: "a limit the binary does not check", file: { statusLine: { type: "command", command: "x", refreshInterval: 0 } }, expect: ["warning bad-value none statusLine.refreshInterval"], doctor: [] },

  // --- hooks: the entry, the group, the event ---------------------------------------------------------------
  { name: "a hook that is fine", file: ss(cmd), expect: [], doctor: [] },
  { name: "hook timeout is a string", file: ss({ ...cmd, timeout: "10" }), expect: ["error hook-shape entry hooks.SessionStart[0].hooks[0].timeout"], doctor: ["hooks.SessionStart.0.hooks.0"] },
  { name: "hook timeout is negative", file: ss({ ...cmd, timeout: -5 }), expect: ["error hook-shape entry hooks.SessionStart[0].hooks[0].timeout"], doctor: ["hooks.SessionStart.0.hooks.0"] },
  { name: "hook timeout is zero", file: ss({ ...cmd, timeout: 0 }), expect: ["error hook-shape entry hooks.SessionStart[0].hooks[0].timeout"], doctor: ["hooks.SessionStart.0.hooks.0"] },
  { name: "hook timeout 1.5 is fine", file: ss({ ...cmd, timeout: 1.5 }), expect: [], doctor: [] },
  { name: "hook type misspelt", file: ss({ ...cmd, type: "comand" }), expect: ["error hook-shape entry hooks.SessionStart[0].hooks[0].type"], doctor: ["hooks.SessionStart.0.hooks.0.type"] },
  { name: "hook type in the wrong case", file: ss({ ...cmd, type: "Command" }), expect: ["error hook-shape entry hooks.SessionStart[0].hooks[0].type"], doctor: ["hooks.SessionStart.0.hooks.0.type"] },
  { name: "hook with no type", file: ss({ command: "echo" }), expect: ["error hook-shape entry hooks.SessionStart[0].hooks[0].type"], doctor: ["hooks.SessionStart.0.hooks.0.type"] },
  { name: "hook command is a number", file: ss({ type: "command", command: 5 }), expect: ["error hook-shape entry hooks.SessionStart[0].hooks[0].command"], doctor: ["hooks.SessionStart.0.hooks.0"] },
  { name: "hook command is missing", file: ss({ type: "command" }), expect: ["error hook-shape entry hooks.SessionStart[0].hooks[0].command"], doctor: ["hooks.SessionStart.0.hooks.0"] },
  { name: "hook command is empty", file: ss({ type: "command", command: "" }), expect: ["warning hook-shape key hooks.SessionStart[0].hooks[0].command"], doctor: [] },
  { name: "hook async is a string", file: ss({ ...cmd, async: "yes" }), expect: ["error hook-shape entry hooks.SessionStart[0].hooks[0].async"], doctor: ["hooks.SessionStart.0.hooks.0"] },
  { name: "hook shell is not bash or powershell", file: ss({ ...cmd, shell: "zsh" }), expect: ["error hook-shape entry hooks.SessionStart[0].hooks[0].shell"], doctor: ["hooks.SessionStart.0.hooks.0"] },
  { name: "hook statusMessage is a number", file: ss({ ...cmd, statusMessage: 5 }), expect: ["error hook-shape entry hooks.SessionStart[0].hooks[0].statusMessage"], doctor: ["hooks.SessionStart.0.hooks.0"] },
  { name: "hook args is a string", file: ss({ ...cmd, args: "x" }), expect: ["error hook-shape entry hooks.SessionStart[0].hooks[0].args"], doctor: ["hooks.SessionStart.0.hooks.0"] },
  { name: "a prompt hook without a prompt", file: ss({ type: "prompt" }), expect: ["error hook-shape entry hooks.SessionStart[0].hooks[0].prompt"], doctor: ["hooks.SessionStart.0.hooks.0"] },
  { name: "an http hook without a url", file: ss({ type: "http" }), expect: ["error hook-shape entry hooks.SessionStart[0].hooks[0].url"], doctor: ["hooks.SessionStart.0.hooks.0"] },
  { name: "an unknown field in a hook entry", file: ss({ ...cmd, retries: 3 }), expect: ["warning unknown-key key hooks.SessionStart[0].hooks[0].retries"], doctor: [] },
  { name: "a hook entry that is a string", file: { hooks: { SessionStart: [{ hooks: ["x"] }] } }, expect: ["error hook-shape entry hooks.SessionStart[0].hooks[0]"], doctor: ["hooks.SessionStart.0.hooks.0"] },
  { name: "a hook group that is a string", file: { hooks: { SessionStart: ["x"] } }, expect: ["error hook-shape group hooks.SessionStart[0]"], doctor: ["hooks.SessionStart.0"] },
  { name: "a hook group without hooks", file: { hooks: { SessionStart: [{ matcher: "x" }] } }, expect: ["error hook-shape group hooks.SessionStart[0]"], doctor: ["hooks.SessionStart.0"] },
  { name: "a hook group with an empty list", file: { hooks: { SessionStart: [{ hooks: [] }] } }, expect: [], doctor: [] },
  { name: "a hook group with an extra key", file: ss(cmd, { foo: 1 }), expect: ["warning unknown-key key hooks.SessionStart[0].foo"], doctor: [] },
  { name: "a matcher that is a number", file: ss(cmd, { matcher: 5 }), expect: ["error hook-shape group hooks.SessionStart[0].matcher"], doctor: ["hooks.SessionStart.0"] },
  { name: "a matcher that is not a regular expression", file: ss(cmd, { matcher: "(" }), expect: ["warning hook-matcher none hooks.SessionStart[0].matcher"], doctor: [] },
  { name: "a matcher of *", file: ss(cmd, { matcher: "*" }), expect: [], doctor: [] },
  { name: "an event written in lower case", file: { hooks: { sessionstart: [{ hooks: [cmd] }] } }, expect: ["error hook-event key hooks.sessionstart"], doctor: ["hooks.sessionstart"] },
  { name: "an event that does not exist", file: { hooks: { SessionStarts: [{ hooks: [cmd] }] } }, expect: ["error hook-event key hooks.SessionStarts"], doctor: ["hooks.SessionStarts"] },
  { name: "an event the schema lacks and the binary has", file: { hooks: { PreModelSwitch: [{ hooks: [cmd] }] } }, expect: [], doctor: [] },
  { name: "an event that is an object", file: { hooks: { Stop: {} } }, expect: ["error hook-shape event hooks.Stop"], doctor: ["hooks.Stop"] },
  { name: "an event that is a string", file: { hooks: { Notification: "x" } }, expect: ["error hook-shape event hooks.Notification"], doctor: ["hooks.Notification"] },
  { name: "a bad entry in Stop only costs the entry", file: stop({ ...cmd, timeout: "10" }), expect: ["error hook-shape entry hooks.Stop[0].hooks[0].timeout"], doctor: ["hooks.Stop.0.hooks.0"] },
  { name: "a bad PreToolUse entry costs the whole file", file: pre({ ...cmd, timeout: "10" }), expect: ["error hook-shape file hooks.PreToolUse[0].hooks[0].timeout"], doctor: ["hooks.PreToolUse.0.hooks.0", "hooks.PreToolUse.0.hooks.0.timeout"] },
  { name: "a bad PreToolUse matcher costs the whole file", file: pre(cmd, { matcher: 5 }), expect: ["error hook-shape file hooks.PreToolUse[0].matcher"], doctor: ["hooks.PreToolUse.0", "hooks.PreToolUse.0.matcher"] },
  { name: "PreToolUse that is an object costs the whole file", file: { hooks: { PreToolUse: {} } }, expect: ["error hook-shape file hooks.PreToolUse"], doctor: ["hooks.PreToolUse"] },
  { name: "a bad PermissionRequest entry costs the whole file", file: { hooks: { PermissionRequest: [{ hooks: [{ type: "command" }] }] } }, expect: ["error hook-shape file hooks.PermissionRequest[0].hooks[0].command"], doctor: ["hooks.PermissionRequest.0.hooks.0", "hooks.PermissionRequest.0.hooks.0.command"] },
];
