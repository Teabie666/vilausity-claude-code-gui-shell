/**
 * The API providers editor, a content pane tab laid out like the settings editor: the
 * providers on the left (and "Add" from a preset), a form for the selected one on the
 * right. A key typed here goes straight to main, which stores it encrypted; it never
 * comes back to the page.
 */

import type { Dialogs } from '../../core/dialogs';
import type { EditorPane } from '../../core/editors';
import type { NativeApi } from '../../core/native';
import { Emitter, type Event } from '../../platform/event';
import { DisposableStore } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import type { ProvidersState } from '../../platform/protocol';
import {
  providerAccentColor,
  providerIdFor,
  SUBSCRIPTION_ID,
  type ProviderConfig,
  type ProviderModels,
  type ProviderSummary,
  type ProviderType,
} from '../../platform/providers';
import { t } from './messages';
import { presetById, URL_PLACEHOLDER } from './presets';

/** The providers as main last reported them, for every view of this window. */
export class ProvidersModel {
  private readonly changeEmitter = new Emitter<ProvidersState>();
  readonly onDidChange: Event<ProvidersState> = this.changeEmitter.event;

  constructor(private current: ProvidersState) {}

  get state(): ProvidersState {
    return this.current;
  }

  get active(): ProviderSummary | undefined {
    return this.current.providers.find((provider) => provider.id === this.current.current);
  }

  update(state: ProvidersState): void {
    this.current = state;
    this.changeEmitter.fire(state);
  }
}

export function providerLabel(provider: ProviderConfig): string {
  return provider.type === 'subscription' ? t('subscription') : provider.name || provider.id;
}

export function typeLabel(type: ProviderType): string {
  switch (type) {
    case 'subscription':
      return t('typeSubscription');
    case 'anthropic-api':
      return t('typeAnthropic');
    case 'compatible':
      return t('typeCompatible');
    case 'bedrock':
      return t('typeBedrock');
    case 'vertex':
      return t('typeVertex');
    case 'foundry':
      return t('typeFoundry');
  }
}

/** Adds a provider from a preset, with an id of its own; resolves to it. */
export async function addFromPreset(
  presetId: string,
  model: ProvidersModel,
  native: NativeApi,
): Promise<ProviderSummary | undefined> {
  const preset = presetById(presetId);
  if (!preset) {
    return undefined;
  }
  const name = preset.name();
  const id = providerIdFor(preset.id, model.state.providers.map((provider) => provider.id));
  return native.call('providers.save', { provider: { ...preset.config, id, name, preset: preset.id } });
}

interface ProvidersEditorContext {
  readonly model: ProvidersModel;
  readonly native: NativeApi;
  readonly dialogs: Dialogs;
  readonly logger: ILogger;
  /** Asks for a preset and adds a provider from it. */
  readonly add: () => Promise<ProviderSummary | undefined>;
}

/** The form's fields; text fields hold what is typed, parsed on save. */
interface Draft {
  name: string;
  type: ProviderType;
  baseUrl: string;
  auth: 'apiKey' | 'bearer';
  models: Record<keyof ProviderModels, string>;
  headers: string;
  timeoutMs: string;
  maxOutputTokens: string;
  disableNonessentialTraffic: boolean;
  env: string;
  /** Empty: the vendor's accent (`providerAccentColor`). */
  color: string;
}

const MODEL_FIELDS: readonly { key: keyof ProviderModels; label: () => string; variable: string }[] = [
  { key: 'main', label: () => t('modelMain'), variable: 'ANTHROPIC_MODEL' },
  { key: 'opus', label: () => 'Opus', variable: 'ANTHROPIC_DEFAULT_OPUS_MODEL' },
  { key: 'sonnet', label: () => 'Sonnet', variable: 'ANTHROPIC_DEFAULT_SONNET_MODEL' },
  { key: 'haiku', label: () => 'Haiku', variable: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' },
  { key: 'fable', label: () => 'Fable', variable: 'ANTHROPIC_DEFAULT_FABLE_MODEL' },
  { key: 'subagent', label: () => t('modelSubagent'), variable: 'CLAUDE_CODE_SUBAGENT_MODEL' },
];

const TYPES: readonly ProviderType[] = ['compatible', 'anthropic-api', 'bedrock', 'vertex', 'foundry'];

function draftOf(provider: ProviderConfig): Draft {
  const models = provider.models ?? {};
  return {
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl ?? '',
    auth: provider.auth ?? (provider.type === 'compatible' ? 'bearer' : 'apiKey'),
    models: {
      main: models.main ?? '',
      opus: models.opus ?? '',
      sonnet: models.sonnet ?? '',
      haiku: models.haiku ?? '',
      fable: models.fable ?? '',
      subagent: models.subagent ?? '',
    },
    headers: Object.entries(provider.headers ?? {})
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n'),
    timeoutMs: provider.timeoutMs?.toString() ?? '',
    maxOutputTokens: provider.maxOutputTokens?.toString() ?? '',
    disableNonessentialTraffic: provider.disableNonessentialTraffic === true,
    env: Object.entries(provider.env ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join('\n'),
    color: provider.color ?? '',
  };
}

/** `Name: value` or `NAME=value` lines; the lines that do not parse are reported. */
export function parseLines(
  text: string,
  separator: ':' | '=',
  validName: (name: string) => boolean,
): { values: Record<string, string>; bad: string[] } {
  const values: Record<string, string> = {};
  const bad: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') {
      continue;
    }
    const at = line.indexOf(separator);
    const name = at > 0 ? line.slice(0, at).trim() : '';
    if (!name || !validName(name)) {
      bad.push(line.trim());
      continue;
    }
    values[name] = line.slice(at + 1).trim();
  }
  return { values, bad };
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function positiveInteger(text: string): number | undefined {
  const value = Number(text.trim());
  return text.trim() !== '' && Number.isInteger(value) && value > 0 ? value : undefined;
}

export class ProvidersEditorPane implements EditorPane {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly form: HTMLElement;
  private readonly disposables = new DisposableStore();
  private selectedId: string;
  private draft: Draft | undefined;
  private dirty = false;

  constructor(
    container: HTMLElement,
    private readonly context: ProvidersEditorContext,
  ) {
    const doc = container.ownerDocument;
    this.root = doc.createElement('div');
    this.root.className = 'providers-editor';
    this.list = doc.createElement('nav');
    this.list.className = 'providers-list';
    this.list.setAttribute('aria-label', t('editorTitle'));
    this.form = doc.createElement('div');
    this.form.className = 'providers-form';
    this.root.append(this.list, this.form);
    container.appendChild(this.root);

    this.selectedId = context.model.state.current;
    this.render();
    this.disposables.add(
      context.model.onDidChange(() => {
        if (!context.model.state.providers.some((provider) => provider.id === this.selectedId)) {
          this.select(SUBSCRIPTION_ID, true);
        } else if (!this.dirty) {
          this.draft = undefined;
        }
        this.render();
      }),
    );
  }

  /** Shows a provider's form; `force` drops unsaved changes. */
  select(id: string, force = false): void {
    if (id === this.selectedId) {
      return;
    }
    if (this.dirty && !force) {
      void this.confirmDiscard().then((discard) => {
        if (discard) {
          this.select(id, true);
        }
      });
      return;
    }
    this.selectedId = id;
    this.draft = undefined;
    this.dirty = false;
    this.render();
  }

  layout(): void {}

  setVisible(): void {}

  focus(): void {
    this.form.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
  }

  relocate(container: HTMLElement): void {
    container.appendChild(this.root);
  }

  async confirmClose(): Promise<boolean> {
    return !this.dirty || this.confirmDiscard();
  }

  dispose(): void {
    this.disposables.dispose();
    this.root.remove();
  }

  private get selected(): ProviderSummary | undefined {
    return this.context.model.state.providers.find((provider) => provider.id === this.selectedId);
  }

  private async confirmDiscard(): Promise<boolean> {
    const choice = await this.context.dialogs.showMessage({
      severity: 'warning',
      modal: true,
      message: t('unsavedChanges', providerLabel(this.selected ?? { id: this.selectedId, name: '', type: 'compatible' })),
      items: [t('save'), t('dontSave')],
    });
    if (choice === 0) {
      return this.save();
    }
    return choice === 1;
  }

  private render(): void {
    this.renderList();
    this.renderForm();
  }

  private renderList(): void {
    const doc = this.root.ownerDocument;
    const { providers, current } = this.context.model.state;
    const items = providers.map((provider) => {
      const item = doc.createElement('button');
      item.className = 'providers-list-item';
      item.classList.toggle('selected', provider.id === this.selectedId);
      item.dataset.provider = provider.id;
      const swatch = doc.createElement('span');
      swatch.className = 'provider-swatch';
      const color = providerAccentColor(provider);
      if (color) {
        swatch.style.backgroundColor = color;
      }
      const label = doc.createElement('span');
      label.className = 'providers-list-label';
      label.textContent = providerLabel(provider);
      item.append(swatch, label);
      if (provider.id === current) {
        const mark = doc.createElement('span');
        mark.className = 'providers-list-current';
        mark.textContent = t('current');
        item.append(mark);
      }
      item.addEventListener('click', () => this.select(provider.id));
      return item;
    });
    const add = doc.createElement('button');
    add.className = 'button secondary providers-add';
    add.textContent = t('addProvider');
    add.addEventListener('click', () => {
      void this.context.add().then((added) => {
        if (added) {
          this.select(added.id, true);
        }
      });
    });
    this.list.replaceChildren(...items, add);
  }

  private renderForm(): void {
    const doc = this.root.ownerDocument;
    const provider = this.selected;
    this.form.replaceChildren();
    if (!provider) {
      return;
    }
    const title = doc.createElement('div');
    title.className = 'settings-section-title providers-title';
    title.textContent = providerLabel(provider);
    this.form.append(title);

    if (provider.type === 'subscription') {
      this.form.append(this.description(t('subscriptionDetail')), this.actions(provider, false));
      return;
    }
    this.draft ??= draftOf(provider);
    const draft = this.draft;
    const changed = (): void => {
      this.dirty = true;
      this.form.querySelector('.providers-save')?.removeAttribute('disabled');
      this.form.querySelector('.providers-revert')?.removeAttribute('disabled');
    };

    const id = this.description(t('id', provider.id));
    this.form.append(
      this.row(t('name'), this.input(draft.name, (value) => ((draft.name = value), changed())), id),
      this.row(
        t('type'),
        this.dropdown(
          TYPES.map((type) => ({ value: type, label: typeLabel(type) })),
          draft.type,
          (value) => {
            draft.type = value as ProviderType;
            changed();
            this.renderForm();
          },
        ),
      ),
    );

    const usesKey = draft.type === 'compatible' || draft.type === 'anthropic-api';
    if (usesKey) {
      const hint = this.description(t('workspaceIdHint'));
      hint.hidden = !URL_PLACEHOLDER.test(draft.baseUrl);
      this.form.append(
        this.row(
          t('baseUrl'),
          this.input(draft.baseUrl, (value) => {
            draft.baseUrl = value;
            hint.hidden = !URL_PLACEHOLDER.test(value);
            changed();
          }, 'ANTHROPIC_BASE_URL'),
          hint,
        ),
        this.row(
          t('auth'),
          this.dropdown(
            [
              { value: 'bearer', label: t('authBearer') },
              { value: 'apiKey', label: t('authApiKey') },
            ],
            draft.auth,
            (value) => ((draft.auth = value === 'apiKey' ? 'apiKey' : 'bearer'), changed()),
          ),
        ),
        this.keyRow(provider),
      );
    }

    const models = doc.createElement('div');
    models.className = 'providers-models';
    for (const field of MODEL_FIELDS) {
      const label = doc.createElement('label');
      label.className = 'providers-model';
      const name = doc.createElement('span');
      name.textContent = field.label();
      name.title = field.variable;
      label.append(
        name,
        this.input(draft.models[field.key], (value) => ((draft.models[field.key] = value), changed()), field.variable),
      );
      models.append(label);
    }
    this.form.append(this.row(t('models'), models, this.description(t('modelsHint'))));

    this.form.append(
      this.textareaRow(t('headers'), t('headersHint'), draft.headers, ':', HEADER_NAME, (value) => {
        draft.headers = value;
        changed();
      }),
      this.row(t('timeout'), this.input(draft.timeoutMs, (value) => ((draft.timeoutMs = value), changed()), 'API_TIMEOUT_MS')),
      this.row(
        t('maxOutput'),
        this.input(draft.maxOutputTokens, (value) => ((draft.maxOutputTokens = value), changed()), 'CLAUDE_CODE_MAX_OUTPUT_TOKENS'),
      ),
      this.checkboxRow(t('nonessential'), draft.disableNonessentialTraffic, (checked) => {
        draft.disableNonessentialTraffic = checked;
        changed();
      }),
      this.textareaRow(t('env'), t('envHint'), draft.env, '=', ENV_NAME, (value) => {
        draft.env = value;
        changed();
      }),
      this.colorRow(provider, draft, changed),
      this.actions(provider, true),
    );
  }

  private keyRow(provider: ProviderSummary): HTMLElement {
    const doc = this.root.ownerDocument;
    const status = this.description(provider.hasKey ? t('keyStored') : t('keyMissing'));
    const input = doc.createElement('input');
    input.type = 'password';
    input.className = 'setting-input providers-key';
    input.placeholder = t('keyPlaceholder');
    input.autocomplete = 'off';
    const save = this.button(t('saveKey'), 'secondary', async () => {
      const key = input.value.trim();
      if (!key) {
        return;
      }
      await this.call(() => this.context.native.call('providers.setKey', { id: provider.id, key }));
      input.value = '';
    });
    const remove = this.button(t('removeKey'), 'secondary', () =>
      this.call(() => this.context.native.call('providers.setKey', { id: provider.id })),
    );
    remove.hidden = !provider.hasKey;
    const line = doc.createElement('div');
    line.className = 'providers-inline';
    line.append(input, save, remove);
    return this.row(t('key'), line, status);
  }

  private actions(provider: ProviderSummary, editable: boolean): HTMLElement {
    const doc = this.root.ownerDocument;
    const bar = doc.createElement('div');
    bar.className = 'providers-actions';
    if (editable) {
      const save = this.button(t('save'), 'primary', () => this.save());
      save.classList.add('providers-save');
      const revert = this.button(t('revert'), 'secondary', () => {
        this.draft = undefined;
        this.dirty = false;
        this.renderForm();
      });
      revert.classList.add('providers-revert');
      if (!this.dirty) {
        save.setAttribute('disabled', '');
        revert.setAttribute('disabled', '');
      }
      bar.append(save, revert);
    }
    bar.append(
      this.button(t('createShortcut', providerLabel(provider)), 'secondary', async () => {
        try {
          const file = await this.context.native.call('providers.createShortcut', { id: provider.id });
          this.toast('info', t('shortcutCreated', file));
        } catch (error) {
          this.toast('error', t('shortcutFailed', String(error)));
        }
      }),
    );
    const docs = presetById(provider.preset)?.docs;
    if (docs) {
      const link = doc.createElement('a');
      link.className = 'providers-docs';
      link.textContent = t('setupGuide');
      link.href = docs;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        void this.context.native.call('os.openExternal', { url: docs });
      });
      bar.append(link);
    }
    if (editable) {
      const remove = this.button(t('remove'), 'secondary', async () => {
        const choice = await this.context.dialogs.showMessage({
          severity: 'warning',
          modal: true,
          message: t('removeConfirm', providerLabel(provider)),
          items: [t('remove')],
        });
        if (choice === 0) {
          this.dirty = false;
          await this.call(() => this.context.native.call('providers.remove', { id: provider.id }));
        }
      });
      remove.classList.add('providers-remove');
      bar.append(remove);
    }
    return bar;
  }

  /** Saves the form; false when it cannot (lines that do not parse, or main refused). */
  private async save(): Promise<boolean> {
    const provider = this.selected;
    const draft = this.draft;
    if (!provider || !draft) {
      return false;
    }
    const headers = parseLines(draft.headers, ':', (name) => HEADER_NAME.test(name));
    const env = parseLines(draft.env, '=', (name) => ENV_NAME.test(name));
    if (headers.bad.length > 0 || env.bad.length > 0) {
      this.toast('error', t('badLines', [...headers.bad, ...env.bad].join(', ')));
      return false;
    }
    const usesKey = draft.type === 'compatible' || draft.type === 'anthropic-api';
    const config: ProviderConfig = {
      id: provider.id,
      name: draft.name.trim() || provider.id,
      type: draft.type,
      baseUrl: usesKey ? draft.baseUrl.trim() || undefined : undefined,
      auth: usesKey ? draft.auth : undefined,
      models: Object.fromEntries(
        Object.entries(draft.models).filter(([, value]) => value.trim() !== '').map(([key, value]) => [key, value.trim()]),
      ),
      headers: headers.values,
      timeoutMs: positiveInteger(draft.timeoutMs),
      maxOutputTokens: positiveInteger(draft.maxOutputTokens),
      disableNonessentialTraffic: draft.disableNonessentialTraffic || undefined,
      env: env.values,
      // The vendor's own color is no pick: the provider keeps following its vendor.
      color: draft.color && draft.color !== providerAccentColor({ ...provider, type: draft.type, color: undefined }) ? draft.color : undefined,
      preset: provider.preset,
    };
    const saved = await this.call(() => this.context.native.call('providers.save', { provider: config }));
    if (saved) {
      this.dirty = false;
      this.toast('info', t('saved'));
    }
    return saved;
  }

  /** Runs a call to main; a failure shows as a notification. Resolves to whether it worked. */
  private async call(run: () => Promise<unknown>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (error) {
      this.context.logger.error('a providers request failed', error);
      this.toast('error', t('saveFailed', error instanceof Error ? error.message : String(error)));
      return false;
    }
  }

  private toast(severity: 'info' | 'error', message: string): void {
    void this.context.dialogs.showMessage({ severity, modal: false, message, items: [] });
  }

  private row(label: string, control: HTMLElement, ...extra: HTMLElement[]): HTMLElement {
    const doc = this.root.ownerDocument;
    const row = doc.createElement('div');
    row.className = 'setting-item providers-row';
    const title = doc.createElement('div');
    title.className = 'setting-title';
    const name = doc.createElement('span');
    name.className = 'setting-name';
    name.textContent = label;
    title.append(name);
    row.append(title, ...extra, control);
    return row;
  }

  private description(text: string): HTMLElement {
    const description = this.root.ownerDocument.createElement('div');
    description.className = 'setting-description';
    description.textContent = text;
    return description;
  }

  private input(value: string, onInput: (value: string) => void, placeholder = ''): HTMLInputElement {
    const input = this.root.ownerDocument.createElement('input');
    input.type = 'text';
    input.className = 'setting-input';
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.addEventListener('input', () => onInput(input.value));
    return input;
  }

  private dropdown(
    options: readonly { value: string; label: string }[],
    value: string,
    onChange: (value: string) => void,
  ): HTMLSelectElement {
    const doc = this.root.ownerDocument;
    const select = doc.createElement('select');
    select.className = 'setting-select';
    for (const option of options) {
      const element = doc.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      element.selected = option.value === value;
      select.append(element);
    }
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  private textareaRow(
    label: string,
    hint: string,
    value: string,
    separator: ':' | '=',
    validName: RegExp,
    onInput: (value: string) => void,
  ): HTMLElement {
    const doc = this.root.ownerDocument;
    const textarea = doc.createElement('textarea');
    textarea.className = 'setting-input providers-textarea';
    textarea.value = value;
    textarea.rows = 3;
    textarea.spellcheck = false;
    const problem = doc.createElement('div');
    problem.className = 'setting-validation';
    const check = (): void => {
      const { bad } = parseLines(textarea.value, separator, (name) => validName.test(name));
      problem.textContent = bad.length > 0 ? t('badLines', bad.join(', ')) : '';
      textarea.classList.toggle('invalid', bad.length > 0);
    };
    textarea.addEventListener('input', () => {
      check();
      onInput(textarea.value);
    });
    check();
    const row = this.row(label, textarea, this.description(hint));
    row.append(problem);
    return row;
  }

  private checkboxRow(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
    const doc = this.root.ownerDocument;
    const row = doc.createElement('div');
    row.className = 'setting-item providers-row';
    const wrapper = doc.createElement('label');
    wrapper.className = 'setting-checkbox-row';
    const box = doc.createElement('input');
    box.type = 'checkbox';
    box.className = 'setting-checkbox';
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    const text = this.description(label);
    wrapper.append(box, text);
    row.append(wrapper);
    return row;
  }

  /** The accent: picked, or the vendor's (or none: the theme's own) until one is. */
  private colorRow(provider: ProviderSummary, draft: Draft, changed: () => void): HTMLElement {
    const doc = this.root.ownerDocument;
    const vendor = providerAccentColor({ ...provider, type: draft.type, color: undefined });
    const control = doc.createElement('div');
    control.className = 'providers-color-row';
    const input = doc.createElement('input');
    input.type = 'color';
    input.className = 'providers-color';
    const note = doc.createElement('span');
    note.className = 'setting-description';
    const reset = this.button(t('colorReset'), 'secondary', () => {
      draft.color = '';
      render();
      changed();
    });
    const render = (): void => {
      input.value = draft.color || vendor || '#808080';
      note.textContent = draft.color ? '' : vendor ? t('colorVendor') : t('colorTheme');
      reset.hidden = draft.color === '' || draft.color === vendor;
    };
    input.addEventListener('input', () => {
      draft.color = input.value;
      render();
      changed();
    });
    render();
    control.append(input, note, reset);
    return this.row(t('color'), control);
  }

  private button(label: string, kind: 'primary' | 'secondary', run: () => unknown): HTMLButtonElement {
    const button = this.root.ownerDocument.createElement('button');
    button.className = kind === 'primary' ? 'button' : 'button secondary';
    button.textContent = label;
    button.addEventListener('click', () => void run());
    return button;
  }
}

