/**
 * Settings in the renderer: the user's values (main owns settings.json; changes made here
 * or by hand arrive as `settingsChanged`) and the settings contribution point, where
 * modules declare their settings: key, the JSON schema of the value, and where the settings
 * editor lists them. The same declarations make the schema of settings.json.
 */

import { Emitter, type Event } from '../platform/event';
import type { IDisposable } from '../platform/lifecycle';
import type { NativeApi } from './native';

/** The JSON schema of a setting's value, with the parts VS Code's settings editor uses. */
export interface SettingSchema {
  readonly type?: string | readonly string[];
  readonly default?: unknown;
  readonly description?: string;
  readonly markdownDescription?: string;
  readonly enum?: readonly unknown[];
  readonly enumDescriptions?: readonly string[];
  readonly markdownEnumDescriptions?: readonly string[];
  /** Shown in the dropdown instead of the raw enum values. */
  readonly enumItemLabels?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly deprecationMessage?: string;
  readonly markdownDeprecationMessage?: string;
  readonly [key: string]: unknown;
}

export interface SettingDefinition {
  readonly key: string;
  readonly schema: SettingSchema;
  /** The section of the settings editor that lists it, e.g. `Text Editor` (localized). */
  readonly section: string;
  /** Within its section, lower comes first; then by key. */
  readonly order?: number;
  /** In the schema of settings.json, but not listed in the settings editor. */
  readonly hidden?: boolean;
  /**
   * The settings editor shows the description under the title: for settings whose title does
   * not say enough. Otherwise the description is only searched (and shown in settings.json).
   */
  readonly showDescription?: boolean;
}

/**
 * A block the settings editor shows at the top of a section, above its settings: state and
 * actions that are not settings themselves (the extension's version and its updates, say).
 */
export interface SettingsWidget {
  readonly id: string;
  /** The section it heads; the section is listed even with no settings of its own. */
  readonly section: string;
  /** What the search finds it by, besides the section's name. */
  readonly keywords: string;
  /** Builds the block in `container`. Called each time the editor renders; disposed before the next. */
  create(container: HTMLElement): SettingsWidgetHandle;
}

export interface SettingsWidgetHandle extends IDisposable {
  /**
   * A block with items of its own (the keyboard shortcuts) searches them: it shows those
   * that have every word and returns how many (none: the block is hidden). Without this, the
   * keywords decide.
   */
  readonly search?: (words: readonly string[]) => number;
}

export class SettingsService {
  private valueMap: Readonly<Record<string, unknown>> = {};
  private readonly widgetList: SettingsWidget[] = [];
  private filePathValue = '';
  private readonly definitionList: SettingDefinition[] = [];
  private readonly changeEmitter = new Emitter<readonly string[]>();
  /** Fires with the keys whose value changed. */
  readonly onDidChange: Event<readonly string[]> = this.changeEmitter.event;
  private readonly definitionsEmitter = new Emitter<void>();
  readonly onDidChangeDefinitions: Event<void> = this.definitionsEmitter.event;

  constructor(private readonly native: NativeApi) {
    native.on('settingsChanged', ({ values, keys }) => {
      this.valueMap = values;
      this.changeEmitter.fire(keys);
    });
  }

  /** Reads the values once at startup; later changes are pushed. */
  async load(): Promise<void> {
    const { values, filePath } = await this.native.call('settings.read', undefined);
    this.valueMap = values;
    this.filePathValue = filePath;
  }

  /** settings.json on disk. */
  get filePath(): string {
    return this.filePathValue;
  }

  /** What the user set, by key. */
  get values(): Readonly<Record<string, unknown>> {
    return this.valueMap;
  }

  /** Whether settings.json sets `key`. */
  isSet(key: string): boolean {
    return Object.hasOwn(this.valueMap, key);
  }

  /** The user's value, else the declared default, else `fallback`. */
  get<T>(key: string, fallback: T): T {
    if (this.isSet(key)) {
      return this.valueMap[key] as T;
    }
    const declared = this.definition(key)?.schema.default;
    return declared === undefined ? fallback : (declared as T);
  }

  /** Writes `key` to settings.json; `undefined` removes it, back to the default. */
  update(key: string, value: unknown): Promise<void> {
    return this.native.call('settings.update', { key, value });
  }

  get definitions(): readonly SettingDefinition[] {
    return this.definitionList;
  }

  definition(key: string): SettingDefinition | undefined {
    return this.definitionList.find((definition) => definition.key === key);
  }

  get widgets(): readonly SettingsWidget[] {
    return this.widgetList;
  }

  /** Adds a block at the top of a section of the settings editor. */
  registerWidget(widget: SettingsWidget): IDisposable {
    this.widgetList.push(widget);
    this.definitionsEmitter.fire();
    return {
      dispose: () => {
        const index = this.widgetList.indexOf(widget);
        if (index >= 0) {
          this.widgetList.splice(index, 1);
          this.definitionsEmitter.fire();
        }
      },
    };
  }

  /** Declares settings; a key declared again replaces the earlier declaration. */
  register(definitions: readonly SettingDefinition[]): IDisposable {
    for (const definition of definitions) {
      const index = this.definitionList.findIndex((existing) => existing.key === definition.key);
      if (index >= 0) {
        this.definitionList.splice(index, 1);
      }
      this.definitionList.push(definition);
    }
    this.definitionsEmitter.fire();
    return {
      dispose: () => {
        for (const definition of definitions) {
          const index = this.definitionList.indexOf(definition);
          if (index >= 0) {
            this.definitionList.splice(index, 1);
          }
        }
        this.definitionsEmitter.fire();
      },
    };
  }
}
