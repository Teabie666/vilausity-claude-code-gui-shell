/**
 * The parts of the extension's `contributes` (package.json) that the shell shows itself:
 * command titles and menus. The manifest is not ours, so entries are checked one by one
 * and malformed ones are skipped instead of failing the whole read.
 */

import type { CommandContribution, ExtensionContributions, MenuItemContribution, SettingContribution } from '../../platform/protocol';

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function readContributions(packageJson: Readonly<Record<string, unknown>>): ExtensionContributions {
  const contributes = asRecord(packageJson.contributes);

  const commands = asArray(contributes?.commands).flatMap((entry): CommandContribution[] => {
    const command = asRecord(entry);
    if (typeof command?.command !== 'string' || typeof command.title !== 'string') {
      return [];
    }
    return [{ command: command.command, title: command.title, category: optionalString(command.category) }];
  });

  const menus: Record<string, MenuItemContribution[]> = {};
  for (const [menuId, items] of Object.entries(asRecord(contributes?.menus) ?? {})) {
    menus[menuId] = asArray(items).flatMap((entry): MenuItemContribution[] => {
      const item = asRecord(entry);
      // Submenu entries carry `submenu` instead of `command`; the shell has no submenus yet.
      if (typeof item?.command !== 'string') {
        return [];
      }
      return [{ command: item.command, when: optionalString(item.when), group: optionalString(item.group) }];
    });
  }

  // `configuration` is one `{ title, properties }` or a list of them.
  const displayName = optionalString(packageJson.displayName) ?? optionalString(packageJson.name) ?? '';
  const configurations = Array.isArray(contributes?.configuration) ? contributes.configuration : [contributes?.configuration];
  const configuration = configurations.flatMap((entry): SettingContribution[] => {
    const group = asRecord(entry);
    const section = optionalString(group?.title) ?? displayName;
    return Object.entries(asRecord(group?.properties) ?? {}).flatMap(([key, value]): SettingContribution[] => {
      const schema = asRecord(value);
      return schema ? [{ key, schema, section }] : [];
    });
  });

  return { commands, menus, configuration };
}

/** Texts of a setting's schema the settings editor shows. */
const SCHEMA_TEXTS = ['description', 'markdownDescription', 'deprecationMessage', 'markdownDeprecationMessage'];
const SCHEMA_TEXT_LISTS = ['enumDescriptions', 'markdownEnumDescriptions', 'enumItemLabels'];

/** The contributions with their settings' texts (descriptions, value labels) passed through `translate`. */
export function translateContributions(contributions: ExtensionContributions, translate: (text: string) => string): ExtensionContributions {
  const configuration = contributions.configuration.map((setting) => {
    const schema: Record<string, unknown> = { ...setting.schema };
    for (const field of SCHEMA_TEXTS) {
      const text = schema[field];
      if (typeof text === 'string') {
        schema[field] = translate(text);
      }
    }
    for (const field of SCHEMA_TEXT_LISTS) {
      const texts = schema[field];
      if (Array.isArray(texts)) {
        schema[field] = texts.map((text: unknown) => (typeof text === 'string' ? translate(text) : text));
      }
    }
    return { ...setting, schema };
  });
  return { ...contributions, configuration };
}
