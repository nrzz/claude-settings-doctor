---
name: check
description: Check settings files.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/claude-settings-doctor.mjs" *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/claude-settings-doctor.mjs *) PowerShell(node "${CLAUDE_PLUGIN_ROOT}/bin/claude-settings-doctor.mjs" *) PowerShell(node ${CLAUDE_PLUGIN_ROOT}/bin/claude-settings-doctor.mjs *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-settings-doctor.mjs" lint --project "${CLAUDE_PROJECT_DIR}" --markdown`

In at most 10 lines: each problem with its settings file and line, and the fix. If there are no findings, say so in one line. The schema can lag a Claude Code release, so an unknown key may be new rather than wrong. Edit nothing until the user agrees.
