# Roadmap

What could come next. None of it is promised; all of it is open to contributors. Comment on an issue or start a [discussion](https://github.com/nrzz/claude-settings-doctor/discussions) before a large change.

- `show --from <scope>`: only the entries a given file decides (`managed`, `local`, `project` or `user`), the list of what that file does. This is the open [good first issue](https://github.com/nrzz/claude-settings-doctor/issues/5).
- Flags in `show`: read the file that `claude --settings <file>` names, and `--setting-sources`, and put them where Claude Code does, so the merged view matches a session started that way. Today `show` says that flags are not read.
- Plugin settings in `show`: an enabled plugin's `settings.json` supplies defaults (an agent, a status line) below every other file. Today `show` says that they are not read.
- `lint --fix` for a key that has one near name in the schema (`cleanupPeriodDay`): rename it in `settings.jsonc` after a backup, and leave every comment as it is.
- Managed settings from a macOS profile and from the Windows registry. They are not files, so reading them means starting `defaults` or `reg`, which the tool does not do; it would be an option that is off by default.
