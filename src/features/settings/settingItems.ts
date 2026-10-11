/**
 * How the settings editor presents a setting, from its key and JSON schema: the title
 * (as VS Code derives it), the description as plain text, the kind of control, search
 * matching and value checks. Pure functions.
 */

import type { SettingDefinition, SettingSchema } from '../../core/settings';

/** `fontSize` -> `Font Size`, `claudeCode` -> `Claude Code`. */
export function wordify(segment: string): string {
  const spaced = segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * VS Code's display form of a key: `editor.minimap.enabled` -> category `Editor › Minimap`,
 * name `Enabled`.
 */
export function settingTitle(key: string): { category: string; name: string } {
  const segments = key.split('.');
  const name = wordify(segments.pop() ?? key);
  return { category: segments.map(wordify).join(' › '), name };
}

/** A description for plain text: Markdown code spans, links, emphasis and `#setting.key#` references unwrapped. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/`#([\w.-]+)#`/g, (_match, key: string) => titleText(key))
    .replace(/#([\w-]+(?:\.[\w-]+)+)#/g, (_match, key: string) => titleText(key))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\s+\n/g, '\n')
    .trim();
}

function titleText(key: string): string {
  const { category, name } = settingTitle(key);
  return category ? `${category}: ${name}` : name;
}

export function descriptionOf(schema: SettingSchema): string {
  const text = schema.markdownDescription ?? schema.description ?? '';
  return plainText(text);
}

export function deprecationOf(schema: SettingSchema): string | undefined {
  const text = schema.markdownDeprecationMessage ?? schema.deprecationMessage;
  return text ? plainText(text) : undefined;
}

export type ControlKind = 'boolean' | 'enum' | 'string' | 'number' | 'complex';

/** The type of a schema, ignoring `null` in a list of types. */
function mainType(schema: SettingSchema): string | undefined {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.find((type): type is string => typeof type === 'string' && type !== 'null');
}

export function controlKind(schema: SettingSchema): ControlKind {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return 'enum';
  }
  switch (mainType(schema)) {
    case 'boolean':
      return 'boolean';
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    default:
      return 'complex';
  }
}

/**
 * Every word of the query appears in the key, the title (`shown`, and the English one derived
 * from the key) or the description.
 */
export function matchesQuery(
  definition: SettingDefinition,
  query: string,
  shown: { category: string; name: string } = settingTitle(definition.key),
): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return true;
  }
  const { category, name } = settingTitle(definition.key);
  const haystack =
    `${definition.key} ${category} ${name} ${shown.category} ${shown.name} ${descriptionOf(definition.schema)} ${definition.section}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Parses a number field: the value, or why it is not acceptable (`minimum` / `maximum` / an integer). */
export function parseNumber(schema: SettingSchema, text: string): { value: number } | { error: 'notNumber' | 'tooSmall' | 'tooLarge' | 'notInteger' } {
  const trimmed = text.trim();
  const value = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(value)) {
    return { error: 'notNumber' };
  }
  if (mainType(schema) === 'integer' && !Number.isInteger(value)) {
    return { error: 'notInteger' };
  }
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    return { error: 'tooSmall' };
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    return { error: 'tooLarge' };
  }
  return { value };
}

/** Structural equality of JSON values (a value equal to the default is not written). */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The JSON schema of settings.json from the declared settings: what completion, hovers and
 * validation in the JSON editor use. Unknown keys stay allowed.
 */
export function settingsJsonSchema(definitions: readonly SettingDefinition[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const definition of definitions) {
    properties[definition.key] = definition.schema;
  }
  return { type: 'object', properties, additionalProperties: true };
}

/**
 * Every declared setting with its default as JSON with comments, like VS Code's default
 * settings: by section, each with its description, allowed values and any deprecation as
 * comments. A read-only reference to copy from into settings.json.
 */
export function defaultSettingsText(
  definitions: readonly SettingDefinition[],
  labels: { readonly header: string; readonly deprecated: string },
): string {
  const lines = [...labels.header.split('\n').map((line) => `// ${line}`), '{'];
  let lastValueLine = -1;
  for (const { section, settings } of groupBySection(definitions)) {
    lines.push('', `  // ---- ${section} ----`);
    for (const { key, schema } of settings) {
      lines.push('');
      const description = descriptionOf(schema);
      for (const line of description ? description.split('\n') : []) {
        lines.push(`  // ${line}`);
      }
      const deprecation = deprecationOf(schema);
      if (deprecation) {
        lines.push(`  // ${labels.deprecated}: ${deprecation}`);
      }
      // As in VS Code, the values are listed only when some are described (completion offers them anyway).
      const descriptions = schema.markdownEnumDescriptions ?? schema.enumDescriptions;
      if (descriptions?.some((text) => text)) {
        (schema.enum ?? []).forEach((value, index) => {
          const text = descriptions[index];
          lines.push(`  //  - ${JSON.stringify(value)}${text ? `: ${plainText(text)}` : ''}`);
        });
      }
      const value = JSON.stringify(schema.default ?? null, null, 2).replace(/\n/g, '\n  ');
      lines.push(`  ${JSON.stringify(key)}: ${value},`);
      lastValueLine = lines.length - 1;
    }
  }
  if (lastValueLine >= 0) {
    lines[lastValueLine] = lines[lastValueLine]!.replace(/,$/, '');
  }
  lines.push('}', '');
  return lines.join('\n');
}

/** Sections in the order modules registered them; settings in a section by order, then key. */
export function groupBySection(definitions: readonly SettingDefinition[]): { section: string; settings: SettingDefinition[] }[] {
  const groups: { section: string; settings: SettingDefinition[] }[] = [];
  for (const definition of definitions) {
    let group = groups.find((candidate) => candidate.section === definition.section);
    if (!group) {
      group = { section: definition.section, settings: [] };
      groups.push(group);
    }
    group.settings.push(definition);
  }
  for (const group of groups) {
    group.settings.sort(
      (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.key.localeCompare(b.key),
    );
  }
  return groups;
}
