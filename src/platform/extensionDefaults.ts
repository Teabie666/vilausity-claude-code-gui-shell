/**
 * The Claude Code extension's settings whose default vilaus changes, over its package.json's
 * (anthropic.claude-code 2.1.310): what the extension reads (compat/vscode/configuration.ts)
 * and what the settings editor shows (features/settings/extensionSettings.ts).
 */
export const EXTENSION_DEFAULT_OVERRIDES: Readonly<Record<string, unknown>> = {
  // Its onboarding checklist teaches VS Code's way in (the icon at the top right, Ctrl+Esc);
  // the shell's quick start covers the same ground. Only its home page shows.
  'claudeCode.hideOnboarding': true,
};
