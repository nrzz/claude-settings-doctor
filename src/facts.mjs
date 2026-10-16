// What the real Claude Code binary was seen to do. The schema says what settings should look like; these say
// what Claude Code does when they do not. Each fact was put to Claude Code 2.1.295 by `claude doctor` (which
// lists "Invalid settings") and by hooks that write a file when they run; test/e2e-*.test.mjs repeat that
// against the binary, and the README says how. A newer Claude Code can change any of it.

/** Hook events Claude Code 2.1.295 accepts (the list `claude doctor` prints for an unknown one). */
export const HOOK_EVENTS = [
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification", "UserPromptSubmit", "UserPromptExpansion",
  "SessionStart", "SessionEnd", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
  "PreModelSwitch", "PostModelSwitch", "PermissionRequest", "PermissionDenied", "Setup", "TeammateIdle", "TaskCreated",
  "TaskCompleted", "Elicitation", "ElicitationResult", "ConfigChange", "WorktreeCreate", "WorktreeRemove", "InstructionsLoaded",
  "CwdChanged", "FileChanged", "DirectoryAdded", "MessageDisplay",
];

/** An invalid hook entry in one of these events makes Claude Code ignore the whole file it is in. In every
 *  other event only the entry goes. (claude doctor: "a PreToolUse/PermissionRequest hook that cannot be loaded
 *  may be what guards the permissions declared beside it, so nothing it sits in is applied".) */
export const WHOLE_FILE_EVENTS = new Set(["PreToolUse", "PermissionRequest"]);

/** The hook types Claude Code lists as valid. */
export const HOOK_TYPES = ["command", "prompt", "agent", "http", "mcp_tool"];

/** A wrong type in these top-level keys drops only the key ("This field was ignored"); in any other key Claude
 *  Code ignores the whole file. */
export const FIELD_LEVEL = new Set(["hooks", "allowedMcpServers", "deniedMcpServers", "extraKnownMarketplaces", "managedMcpServers"]);

/** Keys (and nested keys) where Claude Code 2.1.295 said nothing about a wrong type or a value outside the
 *  schema's list: keys it keeps elsewhere or does not know yet. The schema is newer than that binary here. A
 *  path matches when it is one of these or inside one. */
export const UNCHECKED = [
  "effortLevel", "skippedMarketplaces", "skippedPlugins", "forceLoginMethod", "spinnerTipsOverride", "teammateMode", "viewMode",
  "editorMode", "preferredNotifChannel", "sshHostAllowlist", "footerLinksRegexes", "policyHelper", "askUserQuestionTimeout",
  "teammateDefaultModel", "permissionExplainerEnabled", "diffTool", "externalEditorContext", "autoConnectIde",
  "autoInstallIdeExtension", "vimInsertModeRemaps", "forceLoginGatewayUrl", "browserExternalPageTools",
  "disableBrowserExternalNavigation", "disableMobileSimulatorTools", "requireCoworkFullVmSandbox",
  "sandbox.bwrapPath", "sandbox.socatPath", "sandbox.enabledPlatforms", "worktree.bgIsolation", "theme", "strictPluginOnlyCustomization",
];

/** Top-level keys whose numeric range Claude Code 2.1.295 checks ("Number must be ..."). Every other minimum,
 *  maximum, length and item count of the schema was accepted without a word. */
export const BOUNDS_ENFORCED = new Set(["cleanupPeriodDays", "feedbackSurveyRate", "skillListingMaxDescChars", "skillListingBudgetFraction"]);

/** Types Claude Code 2.1.295 takes in a key although the schema lists only others (by dotted key path). */
export const TYPE_EXTRA = { attribution: ["boolean"] };

/** Whether a key path (a list of keys) is one Claude Code 2.1.295 did not check. */
export function isUnchecked(path) {
  const dotted = path.filter((p) => typeof p === "string").join(".");
  return UNCHECKED.some((u) => dotted === u || dotted.startsWith(`${u}.`));
}

/** Values Claude Code 2.1.295 takes that the schema's list lacks (by dotted key path). */
export const ENUM_EXTRA = { autoUpdatesChannel: ["rc"] };

/** Values the schema lists that Claude Code 2.1.295 rejects ("Invalid value. Expected one of ..."). */
export const ENUM_REJECTED = { "permissions.defaultMode": ["delegate"] };

/** Top-level keys where Claude Code 2.1.295 took null although the schema asks for another type: a key set to
 *  null is the same as a key left out. Every other key it checks rejected null like any wrong type. */
export const NULL_OK = new Set([
  "fastModePerSessionOptIn", "enableAllProjectMcpServers", "allowManagedHooksOnly", "allowManagedPermissionRulesOnly", "strictKnownMarketplaces",
  "skipWebFetchPreflight", "allowManagedMcpServersOnly", "blockedMarketplaces", "channelsEnabled", "disableDeepLinkRegistration",
  "disableSkillShellExecution", "skipDangerousModePermissionPrompt", "useAutoModeDuringPlan", "disableAgentView", "enforceAvailableModels",
  "disableBundledSkills", "disableArtifact", "disableAutoMode", "disableClaudeAiConnectors", "disableRemoteControl", "disableWorkflows",
  "remoteControlAtStartup", "enableArtifact", "disableSideloadFlags",
]);
