# Security policy

## Supported versions

Security fixes go into the latest release on `main`.

## Reporting a vulnerability

Please do not report a vulnerability in a public issue. Use GitHub's private reporting: [https://github.com/nrzz/claude-settings-doctor/security/advisories/new](https://github.com/nrzz/claude-settings-doctor/security/advisories/new), or the contact in the [nrzz security policy](https://github.com/nrzz/.github/blob/master/SECURITY.md). You can expect a first answer within 72 hours, and credit in the release notes if you want it.

## What this tool does, and does not do

It reads the Claude Code settings files that apply to a project (`managed-settings.json` and `managed-settings.d/*.json` in the system folder, the user `settings.json` in `$CLAUDE_CONFIG_DIR` or `~/.claude`, the project's `.claude/settings.json` and `.claude/settings.local.json`) and the `.jsonc` file next to each. It opens no network connection, starts no process and has no telemetry or account. Its one copy of the schema is a file in the package; `scripts/update-schema.mjs`, which downloads a newer one, is run by hand and is not part of the package.

It writes only with `init`, `build`, `absorb`, `watch` and `restore`: a `settings.jsonc` or a `settings.json` that you named with `--user`, `--project` or `--local`, saved next to itself first when it is already there, through a temporary file and a rename, and a small record of the last build in `<config folder>/settings-doctor/`. `build` refuses to overwrite a `settings.json` that changed since the last build. It never edits managed settings, never edits `~/.claude.json`, and leaves a settings file that is not valid JSON alone. `watch` builds in the background on every save of a `settings.jsonc` until you stop it.

The lint is a reading of what Claude Code did when it was put to the binary (the README's "What was verified" says which versions); it is not a guard. A file that passes the lint is not thereby safe, and a permission rule or a hook that guards something is still yours to check: [claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor) and [claude-hook-bench](https://github.com/nrzz/claude-hook-bench) look at those. A setting that Claude Code ignores without a word is the very case this tool exists for, so a rule that quietly does nothing is a finding, but a wrong verdict is a bug and not a vulnerability: report it as an issue.
