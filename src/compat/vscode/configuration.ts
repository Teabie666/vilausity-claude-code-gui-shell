/**
 * `workspace.getConfiguration` and `onDidChangeConfiguration`.
 *
 * Effective value = user setting if present, else the default. Defaults come from the
 * extension's package.json plus a few core VS Code settings the extension reads.
 * There are no workspace-level settings in vilaus: every update goes to the user file.
 */

import type * as vscode from 'vscode';
import { Emitter, type Event } from '../../platform/event';
import type { IDisposable } from '../../platform/lifecycle';
import type { SettingsBackend } from './host';

/** Core VS Code settings the extension reads, with VS Code's defaults (or vilaus's choice). */
const CORE_DEFAULTS: Readonly<Record<string, unknown>> = {
  // VS Code's default, and the shell's (features/editor/autoSave.ts declares it). Off, the
  // extension takes saving the right side of a proposed change as accepting it.
  'files.autoSave': 'off',
  'files.exclude': {
    '**/.git': true,
    '**/.svn': true,
    '**/.hg': true,
    '**/CVS': true,
    '**/.DS_Store': true,
    '**/Thumbs.db': true,
  },
  'search.exclude': { '**/node_modules': true, '**/bower_components': true, '**/*.code-search': true },
  'search.useIgnoreFiles': true,
  'workbench.editor.openSideBySideDirection': 'right',
};

export function defaultsFromPackageJson(packageJson: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const contributes = packageJson.contributes as { configuration?: unknown } | undefined;
  const raw = contributes?.configuration;
  const sections = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const defaults: Record<string, unknown> = {};
  for (const section of sections) {
    const properties = (section as { properties?: Record<string, { default?: unknown }> }).properties;
    for (const [key, schema] of Object.entries(properties ?? {})) {
      if (schema && 'default' in schema) {
        defaults[key] = schema.default;
      }
    }
  }
  return defaults;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Builds a nested tree from flat dotted keys, merging objects where keys overlap. */
function toTree(flat: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      if (!isPlainObject(next)) {
        node[part] = {};
      }
      node = node[part] as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1]!;
    const existing = node[leaf];
    node[leaf] = isPlainObject(existing) && isPlainObject(value) ? { ...existing, ...value } : value;
  }
  return root;
}

function lookup(tree: Record<string, unknown>, path: string): unknown {
  if (!path) {
    return tree;
  }
  let node: unknown = tree;
  for (const part of path.split('.')) {
    if (!isPlainObject(node)) {
      return undefined;
    }
    node = node[part];
  }
  return node;
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export class ConfigurationService implements IDisposable {
  private readonly defaults: Record<string, unknown>;
  private defaultTree: Record<string, unknown>;
  private userTree: Record<string, unknown>;
  private readonly changeEmitter = new Emitter<vscode.ConfigurationChangeEvent>();
  readonly onDidChangeConfiguration: Event<vscode.ConfigurationChangeEvent> = this.changeEmitter.event;
  private readonly subscription: IDisposable;

  constructor(
    private readonly backend: SettingsBackend,
    extensionDefaults: Readonly<Record<string, unknown>>,
  ) {
    this.defaults = { ...CORE_DEFAULTS, ...extensionDefaults };
    this.defaultTree = toTree(this.defaults);
    this.userTree = toTree(backend.values);
    this.subscription = backend.onDidChange(({ keys }) => {
      this.userTree = toTree(backend.values);
      this.changeEmitter.fire({ affectsConfiguration: (section) => affects(keys, section) });
    });
  }

  getConfiguration(section?: string): vscode.WorkspaceConfiguration {
    // `getConfiguration('a').get('b')` reads `a.b`; an empty key means the section itself.
    const fullKey = (key: string): string => [section, key].filter((part) => part).join('.');
    const effective = (key: string): unknown => {
      const user = lookup(this.userTree, fullKey(key));
      const fallback = lookup(this.defaultTree, fullKey(key));
      if (isPlainObject(user) && isPlainObject(fallback)) {
        return { ...fallback, ...user };
      }
      return user !== undefined ? user : fallback;
    };

    // VS Code's configuration object also exposes the section's values as properties.
    const snapshot = clone(effective('') ?? {});
    const configuration = (isPlainObject(snapshot) ? snapshot : {}) as Record<string, unknown>;
    const methods: Pick<vscode.WorkspaceConfiguration, 'get' | 'has' | 'inspect' | 'update'> = {
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        const value = effective(key);
        return value === undefined ? defaultValue : (clone(value) as T);
      },
      has: (key: string): boolean => effective(key) !== undefined,
      inspect: <T>(key: string) => ({
        key: fullKey(key),
        defaultValue: clone(lookup(this.defaultTree, fullKey(key))) as T | undefined,
        globalValue: clone(lookup(this.userTree, fullKey(key))) as T | undefined,
        workspaceValue: undefined,
        workspaceFolderValue: undefined,
      }),
      update: async (key: string, value: unknown): Promise<void> => {
        await this.backend.update(fullKey(key), clone(value));
      },
    };
    for (const [name, fn] of Object.entries(methods)) {
      Object.defineProperty(configuration, name, { value: fn, enumerable: false });
    }
    return configuration as unknown as vscode.WorkspaceConfiguration;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }
}

/** VS Code semantics: a change to `a.b` affects `a`, `a.b` and `a.b.c`. */
export function affects(changedKeys: readonly string[], section: string): boolean {
  return changedKeys.some((key) => key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`));
}
