/** The extension's own settings (its `contributes.configuration`) in the settings editor. */

import { SettingsSection } from '../../core/messages';
import type { SettingDefinition, SettingSchema } from '../../core/settings';
import { EXTENSION_DEFAULT_OVERRIDES } from '../../platform/extensionDefaults';
import type { ExtensionContributions } from '../../platform/protocol';

/**
 * Settings of anthropic.claude-code 2.1.282 for VS Code integration vilaus does not have
 * (a terminal mode, the sidebar / panel placement, editor groups, VS Code keybindings it
 * binds itself). They stay in the settings.json schema but are not listed.
 */
const NOT_APPLICABLE = new Set([
  'claudeCode.useTerminal',
  'claudeCode.preferredLocation',
  'claudeCode.lockEditorGroups',
  'claudeCode.enableNewConversationShortcut',
  'claudeCode.enableReopenClosedSessionShortcut',
]);

/**
 * Settings of the extension listed in a section of the shell's, by the shell's settings of the
 * same subject, with their order there (anthropic.claude-code 2.1.310).
 */
const MOVED: ReadonlyMap<string, { readonly section: () => string; readonly order: number }> = new Map([
  // Archiving sessions left alone: next to deleting them (features/sessionManagement).
  ['claudeCode.archiveInactiveSessions', { section: () => SettingsSection.sessions, order: 2 }],
]);

export function extensionSettingDefinitions(contributions: ExtensionContributions): SettingDefinition[] {
  return contributions.configuration.map((setting, index) => {
    const declared = setting.schema as SettingSchema;
    // The default the extension runs with (compat applies the same overrides).
    const schema =
      setting.key in EXTENSION_DEFAULT_OVERRIDES ? { ...declared, default: EXTENSION_DEFAULT_OVERRIDES[setting.key] } : declared;
    const moved = MOVED.get(setting.key);
    return {
      key: setting.key,
      schema,
      section: moved?.section() ?? setting.section,
      // The manifest's `order`, else the order of declaration.
      order: moved?.order ?? (typeof schema.order === 'number' ? schema.order : 1000 + index),
      hidden: NOT_APPLICABLE.has(setting.key),
      // Their titles say little without it.
      showDescription: true,
    };
  });
}
