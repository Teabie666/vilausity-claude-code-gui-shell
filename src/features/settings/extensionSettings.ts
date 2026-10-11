/** The extension's own settings (its `contributes.configuration`) in the settings editor. */

import type { SettingDefinition, SettingSchema } from '../../core/settings';
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

export function extensionSettingDefinitions(contributions: ExtensionContributions): SettingDefinition[] {
  return contributions.configuration.map((setting, index) => {
    const schema = setting.schema as SettingSchema;
    return {
      key: setting.key,
      schema,
      section: setting.section,
      // The manifest's `order`, else the order of declaration.
      order: typeof schema.order === 'number' ? schema.order : 1000 + index,
      hidden: NOT_APPLICABLE.has(setting.key),
      // Their titles say little without it.
      showDescription: true,
    };
  });
}
