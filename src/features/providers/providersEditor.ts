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
import { getUiLanguage } from '../../platform/nls';
import {
  pricingJson,
  pricingPrompt,
  readPricingAnswer,
  type PriceRule,
  type PricingAnswer,
  type PricingProblem,
  type PricingSource,
  type ProviderPricing,
} from '../../platform/pricing';
import type { ProvidersState } from '../../platform/protocol';
import {
  modelKey,
  providerAccentColor,
  providerIdFor,
  SUBSCRIPTION_ID,
  type Currency,
  type ModelPrice,
  type ProviderConfig,
  type ProviderModels,
  type ProviderSummary,
  type ProviderType,
} from '../../platform/providers';
import { t } from './messages';
import { presetById, presetPricing, URL_PLACEHOLDER } from './presets';
import { pricesText, problemText, ruleText } from './pricingText';

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
export async function addFromPreset(presetId: string, model: ProvidersModel, native: NativeApi): Promise<ProviderSummary | undefined> {
  const preset = presetById(presetId);
  if (!preset) {
    return undefined;
  }
  const name = preset.name();
  const id = providerIdFor(
    preset.id,
    model.state.providers.map((provider) => provider.id),
  );
  // It starts with the prices the preset ships, when it has some.
  return native.call('providers.save', { provider: { ...preset.config, id, name, preset: preset.id, pricing: presetPricing(preset.id) } });
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
  currency: Currency;
  /** By model (`modelKey`). */
  prices: Record<string, PriceDraft>;
  /** The price rules of the models, as a pasted answer had them; kept while a model has prices. */
  rules: Record<string, readonly PriceRule[]>;
  /** Where the pasted prices were read, and what they leave out. */
  sources: readonly PricingSource[];
  notes: readonly string[];
}

/** A model's prices as typed (per million tokens). */
export interface PriceDraft {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

const PRICE_FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output'] as const;

function priceText(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function priceDraft(price: ModelPrice): PriceDraft {
  return {
    input: priceText(price.input),
    output: priceText(price.output),
    cacheRead: priceText(price.cacheRead),
    cacheWrite: priceText(price.cacheWrite),
  };
}

/** The prices to save: the typed ones, each with its model's rules, and where they came from. */
export function draftPricing(
  draft: Pick<Draft, 'currency' | 'rules' | 'sources' | 'notes'>,
  models: Readonly<Record<string, ModelPrice>>,
): ProviderPricing {
  return {
    currency: draft.currency,
    models: Object.fromEntries(
      Object.entries(models).map(([model, price]) => {
        const rules = draft.rules[model];
        return [model, rules && rules.length > 0 ? { ...price, rules } : price];
      }),
    ),
    ...(draft.sources.length > 0 ? { sources: draft.sources } : {}),
    ...(draft.notes.length > 0 ? { notes: draft.notes } : {}),
  };
}

/**
 * The prices typed for each model; a model whose fields are all empty has none. `bad` names
 * the models whose prices do not parse (input and output are needed, numbers of 0 or more).
 */
export function parsePrices(prices: Readonly<Record<string, PriceDraft>>): { models: Record<string, ModelPrice>; bad: string[] } {
  const models: Record<string, ModelPrice> = {};
  const bad: string[] = [];
  const number = (text: string): number | undefined => {
    const value = text.trim() === '' ? Number.NaN : Number(text.trim());
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  for (const [model, draft] of Object.entries(prices)) {
    if (PRICE_FIELDS.every((field) => draft[field].trim() === '')) {
      continue;
    }
    const input = number(draft.input);
    const output = number(draft.output);
    const cacheRead = draft.cacheRead.trim() === '' ? undefined : number(draft.cacheRead);
    const cacheWrite = draft.cacheWrite.trim() === '' ? undefined : number(draft.cacheWrite);
    const cacheBad =
      (draft.cacheRead.trim() !== '' && cacheRead === undefined) || (draft.cacheWrite.trim() !== '' && cacheWrite === undefined);
    if (input === undefined || output === undefined || cacheBad) {
      bad.push(model);
      continue;
    }
    models[model] = { input, output, cacheRead, cacheWrite };
  }
  return { models, bad };
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
    currency: provider.pricing?.currency ?? presetById(provider.preset)?.currency ?? 'USD',
    prices: Object.fromEntries(Object.entries(provider.pricing?.models ?? {}).map(([model, price]) => [model, priceDraft(price)])),
    rules: rulesOf(provider.pricing),
    sources: provider.pricing?.sources ?? [],
    notes: provider.pricing?.notes ?? [],
  };
}

function rulesOf(pricing: ProviderPricing | undefined): Record<string, readonly PriceRule[]> {
  return Object.fromEntries(Object.entries(pricing?.models ?? {}).flatMap(([model, price]) => (price.rules ? [[model, price.rules]] : [])));
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
  /** A form: Escape in a field must not close it. */
  readonly closesOnEscape = false;
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly form: HTMLElement;
  private readonly disposables = new DisposableStore();
  private selectedId: string;
  private draft: Draft | undefined;
  private dirty = false;
  /** The models each provider's conversations used, as main last said (`usage.models`). */
  private readonly usedModels = new Map<string, readonly string[]>();

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

  /** Brings the selected provider's prices into view (the session list's usage links here). */
  revealPrices(): void {
    const prices = this.form.querySelector<HTMLElement>('.providers-prices');
    prices?.scrollIntoView({ block: 'center' });
    prices?.querySelector<HTMLInputElement>('.providers-price')?.focus();
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
      this.row(
        t('name'),
        this.input(draft.name, (value) => ((draft.name = value), changed())),
        id,
      ),
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
          this.input(
            draft.baseUrl,
            (value) => {
              draft.baseUrl = value;
              hint.hidden = !URL_PLACEHOLDER.test(value);
              changed();
            },
            'ANTHROPIC_BASE_URL',
          ),
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

    let prices: { sync(): void } | undefined;
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
        this.input(
          draft.models[field.key],
          (value) => {
            draft.models[field.key] = value;
            changed();
            prices?.sync();
          },
          field.variable,
        ),
      );
      models.append(label);
    }
    this.form.append(this.row(t('models'), models, this.description(t('modelsHint'))));
    if (draft.type === 'compatible') {
      const table = this.pricesRow(provider, draft, changed);
      prices = table;
      this.form.append(table.row);
    }

    this.form.append(
      this.textareaRow(t('headers'), t('headersHint'), draft.headers, ':', HEADER_NAME, (value) => {
        draft.headers = value;
        changed();
      }),
      this.row(
        t('timeout'),
        this.input(draft.timeoutMs, (value) => ((draft.timeoutMs = value), changed()), 'API_TIMEOUT_MS'),
      ),
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
    const prices = parsePrices(draft.prices);
    if (draft.type === 'compatible' && prices.bad.length > 0) {
      this.toast('error', t('badPrices', prices.bad.join(', ')));
      return false;
    }
    const config: ProviderConfig = {
      id: provider.id,
      name: draft.name.trim() || provider.id,
      type: draft.type,
      baseUrl: usesKey ? draft.baseUrl.trim() || undefined : undefined,
      auth: usesKey ? draft.auth : undefined,
      models: Object.fromEntries(
        Object.entries(draft.models)
          .filter(([, value]) => value.trim() !== '')
          .map(([key, value]) => [key, value.trim()]),
      ),
      headers: headers.values,
      timeoutMs: positiveInteger(draft.timeoutMs),
      maxOutputTokens: positiveInteger(draft.maxOutputTokens),
      disableNonessentialTraffic: draft.disableNonessentialTraffic || undefined,
      env: env.values,
      // The vendor's own color is no pick: the provider keeps following its vendor.
      color:
        draft.color && draft.color !== providerAccentColor({ ...provider, type: draft.type, color: undefined }) ? draft.color : undefined,
      preset: provider.preset,
      pricing: draft.type === 'compatible' ? draftPricing(draft, prices.models) : provider.pricing,
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

  /**
   * A compatible API's prices: a row for each model its fields name, it has prices for, or
   * its conversations used (main reads those from the transcripts, a moment later). `sync`
   * adds the rows models now need, and drops the empty rows of models no longer named.
   */
  private pricesRow(provider: ProviderSummary, draft: Draft, changed: () => void): { row: HTMLElement; sync(): void } {
    const doc = this.root.ownerDocument;
    const control = doc.createElement('div');
    control.className = 'providers-prices';
    const bar = doc.createElement('div');
    bar.className = 'providers-prices-bar';
    bar.append(
      this.dropdown(
        [
          { value: 'CNY', label: t('currencyCny') },
          { value: 'USD', label: t('currencyUsd') },
        ],
        draft.currency,
        (value) => {
          draft.currency = value === 'CNY' ? 'CNY' : 'USD';
          changed();
        },
      ),
    );
    const url = presetById(provider.preset)?.prices;
    if (url) {
      bar.append(this.button(t('officialPrices'), 'secondary', () => this.context.native.call('os.openExternal', { url })));
    }
    // Prices that change by the call (the time of day, the input's length...) come from an AI
    // chat: the prompt asks for them in the format a paste is read in.
    const copyPrompt = this.button(t('pricesCopyPrompt'), 'secondary', () =>
      this.copy(this.promptFor(provider, draft, wanted()), t('pricesPromptCopied')),
    );
    copyPrompt.title = t('pricesCopyPromptTitle');
    copyPrompt.classList.add('providers-prices-prompt');
    const pasteButton = this.button(t('pricesPaste'), 'secondary', () => {
      paste.hidden = !paste.hidden;
      if (!paste.hidden) {
        pasted.focus();
      }
    });
    pasteButton.classList.add('providers-prices-paste');
    const exportButton = this.button(t('pricesExport'), 'secondary', () =>
      this.copy(pricingJson(draftPricing(draft, parsePrices(draft.prices).models)), t('pricesExported')),
    );
    exportButton.title = t('pricesExportTitle');
    bar.append(copyPrompt, pasteButton, exportButton);
    // The prices the preset ships, through the same preview as a paste.
    const defaults = presetPricing(provider.preset);
    if (defaults) {
      const checked = defaults.sources?.find((source) => source.checked)?.checked ?? '';
      const defaultsButton = this.button(t('pricesDefaults'), 'secondary', () => {
        paste.hidden = false;
        pasted.value = pricingJson(defaults);
        pasted.dispatchEvent(new globalThis.Event('input'));
        pasted.focus();
      });
      defaultsButton.title = t('pricesDefaultsTitle', checked);
      defaultsButton.classList.add('providers-prices-defaults');
      bar.append(defaultsButton);
    }
    const table = doc.createElement('div');
    table.className = 'providers-prices-table';
    table.setAttribute('role', 'table');
    const header = doc.createElement('div');
    header.className = 'providers-price-row providers-price-header';
    header.setAttribute('role', 'row');
    for (const label of [t('priceModel'), t('priceInput'), t('priceCacheRead'), t('priceCacheWrite'), t('priceOutput')]) {
      const cell = doc.createElement('span');
      cell.setAttribute('role', 'columnheader');
      cell.textContent = label;
      cell.title = label;
      header.append(cell);
    }
    const empty = this.description(t('pricesNone'));
    table.append(header);
    // What the API cost in all, by the prices saved (the ledger keeps deleted conversations).
    const total = this.description('');
    total.classList.add('providers-prices-total');
    total.hidden = true;
    this.context.native.call('usage.total', { providerId: provider.id }).then(
      (shown) => {
        if (shown) {
          total.textContent = t('pricesTotal', shown.value);
          total.title = [t('pricesTotalTitle'), '', shown.detail].join('\n');
          total.hidden = false;
        }
      },
      (error: unknown) => this.context.logger.warn('cannot add up what a provider cost', error),
    );
    const { panel: paste, text: pasted } = this.pastePanel(draft, () => {
      changed();
      this.renderForm();
      this.revealPrices();
    });
    const accuracy = this.description(t('pricesAccuracy'));
    accuracy.classList.add('providers-prices-accuracy');
    control.append(bar, table, empty, total, accuracy, this.pricingInfo(draft, changed), paste);

    // The models its fields name, it has prices for, or its conversations used.
    const wanted = (): string[] => [
      ...new Set(
        [...Object.values(draft.models).map(modelKey), ...Object.keys(draft.prices), ...(this.usedModels.get(provider.id) ?? [])].filter(
          (model) => model !== '',
        ),
      ),
    ];
    const rows = new Map<string, HTMLElement>();
    const sync = (): void => {
      const models = wanted();
      for (const [model, row] of rows) {
        const price = draft.prices[model];
        if (!models.includes(model) && (!price || PRICE_FIELDS.every((field) => price[field].trim() === ''))) {
          row.remove();
          rows.delete(model);
        }
      }
      for (const model of models) {
        if (!rows.has(model)) {
          const row = this.priceRow(model, draft, changed);
          rows.set(model, row);
          table.append(row);
        }
      }
      header.hidden = rows.size === 0;
      empty.hidden = rows.size > 0;
    };
    sync();
    this.context.native.call('usage.models', { providerId: provider.id }).then(
      (used) => {
        this.usedModels.set(provider.id, used);
        sync();
      },
      (error: unknown) => this.context.logger.warn('cannot list the models a provider used', error),
    );
    return { row: this.row(t('prices'), control, this.description(t('pricesHint'))), sync };
  }

  private priceRow(model: string, draft: Draft, changed: () => void): HTMLElement {
    const doc = this.root.ownerDocument;
    const row = doc.createElement('div');
    row.className = 'providers-price-row';
    row.setAttribute('role', 'row');
    row.dataset.model = model;
    const name = doc.createElement('span');
    name.className = 'providers-price-model';
    name.setAttribute('role', 'cell');
    name.textContent = model;
    name.title = model;
    const rules = draft.rules[model] ?? [];
    if (rules.length > 0) {
      // Its prices change by the call: the rules on hover, as pasted.
      const badge = doc.createElement('span');
      badge.className = 'providers-price-rules';
      badge.textContent = `+${rules.length}`;
      badge.title = [t('pricesRulesTitle'), ...rules.map((rule) => ruleText(rule, draft.currency))].join('\n');
      name.title = `${model}\n${badge.title}`;
      name.append(badge);
    }
    row.append(name);
    for (const field of PRICE_FIELDS) {
      const placeholder = field === 'cacheRead' || field === 'cacheWrite' ? t('priceAsInput') : '';
      const input = this.input(
        draft.prices[model]?.[field] ?? '',
        (value) => {
          const price = draft.prices[model] ?? { input: '', output: '', cacheRead: '', cacheWrite: '' };
          draft.prices[model] = { ...price, [field]: value };
          changed();
        },
        placeholder,
      );
      input.classList.add('providers-price');
      input.inputMode = 'decimal';
      input.dataset.field = field;
      input.setAttribute('role', 'cell');
      row.append(input);
    }
    return row;
  }

  /** What to ask an AI chat for the provider's prices (`pricingPrompt`). */
  private promptFor(provider: ProviderSummary, draft: Draft, models: readonly string[]): string {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return pricingPrompt({
      provider: draft.name.trim() || providerLabel(provider),
      baseUrl: draft.baseUrl.trim() || undefined,
      pricesUrl: presetById(provider.preset)?.prices,
      currency: draft.currency,
      models,
      language: getUiLanguage() === 'zh-cn' ? 'Simplified Chinese' : 'English',
      today,
    });
  }

  private copy(text: string, done: string): void {
    this.root.ownerDocument.defaultView?.navigator.clipboard.writeText(text).then(
      () => this.toast('info', done),
      (error: unknown) => this.context.logger.error('cannot copy to the clipboard', error),
    );
  }

  /** Where the pasted prices were read and what they leave out; a way to drop their rules. */
  private pricingInfo(draft: Draft, changed: () => void): HTMLElement {
    const doc = this.root.ownerDocument;
    const info = doc.createElement('div');
    info.className = 'providers-pricing-info';
    const ruled = Object.values(draft.rules).some((rules) => rules.length > 0);
    info.hidden = !ruled && draft.sources.length === 0 && draft.notes.length === 0;
    if (draft.sources.length > 0) {
      const sources = draft.sources.map((source) => (source.checked ? `${source.url} (${source.checked})` : source.url));
      info.append(this.description(t('pricesSources', sources.join(', '))));
    }
    for (const note of draft.notes) {
      info.append(this.description(note));
    }
    if (ruled) {
      const remove = this.button(t('pricesRemoveRules'), 'secondary', () => {
        draft.rules = {};
        draft.sources = [];
        draft.notes = [];
        changed();
        this.renderForm();
        this.revealPrices();
      });
      remove.classList.add('providers-prices-remove-rules');
      info.append(remove);
    }
    return info;
  }

  /**
   * The box an AI chat's answer is pasted into: read as it is typed (`readPricingAnswer`), its
   * problems or a preview below, and only "Use These Prices" puts it into the form (which is
   * then saved as any edit). It replaces the prices of every model.
   */
  private pastePanel(draft: Draft, applied: () => void): { panel: HTMLElement; text: HTMLTextAreaElement } {
    const doc = this.root.ownerDocument;
    const panel = doc.createElement('div');
    panel.className = 'providers-pricing-paste';
    panel.hidden = true;
    const text = doc.createElement('textarea');
    text.className = 'setting-input providers-textarea providers-pricing-text';
    text.rows = 8;
    text.spellcheck = false;
    text.placeholder = t('pricesPasteHint');
    const result = doc.createElement('div');
    result.className = 'providers-pricing-result';
    let answer: PricingAnswer | undefined;
    const use = this.button(t('pricesApply'), 'primary', () => {
      if (!answer) {
        return;
      }
      const { pricing } = answer;
      draft.currency = pricing.currency;
      draft.prices = Object.fromEntries(Object.entries(pricing.models).map(([model, price]) => [model, priceDraft(price)]));
      draft.rules = rulesOf(pricing);
      draft.sources = pricing.sources ?? [];
      draft.notes = pricing.notes ?? [];
      applied();
    });
    use.classList.add('providers-pricing-apply');
    const cancel = this.button(t('pricesCancel'), 'secondary', () => {
      text.value = '';
      check();
      panel.hidden = true;
    });
    const actions = doc.createElement('div');
    actions.className = 'providers-prices-bar';
    actions.append(use, cancel);
    const check = (): void => {
      const read = text.value.trim() === '' ? undefined : readPricingAnswer(text.value);
      answer = read?.answer;
      use.disabled = !answer;
      result.replaceChildren(...(read ? this.pastePreview(read, draft) : []));
    };
    text.addEventListener('input', check);
    check();
    panel.append(text, result, actions);
    return { panel, text };
  }

  private pastePreview(read: { answer: PricingAnswer | undefined; problems: PricingProblem[] }, draft: Draft): HTMLElement[] {
    const doc = this.root.ownerDocument;
    const line = (className: string, content: string, title?: string): HTMLElement => {
      const element = doc.createElement('div');
      element.className = className;
      element.textContent = content;
      if (title) {
        element.title = title;
      }
      return element;
    };
    const { answer } = read;
    if (!answer) {
      const shown = read.problems.slice(0, 12).map((problem) => line('providers-pricing-problem', problemText(problem)));
      const more = read.problems.length - shown.length;
      return [
        line('setting-validation', t('pricesProblems')),
        ...shown,
        ...(more > 0 ? [line('providers-pricing-problem', t('pricesMoreProblems', String(more)))] : []),
      ];
    }
    const { pricing } = answer;
    const elements = [line('setting-description', t('pricesPreviewOrder'))];
    for (const [model, price] of Object.entries(pricing.models)) {
      elements.push(line('providers-pricing-model', `${model}: ${pricesText(price, pricing.currency)}`, answer.evidence[model]));
      for (const rule of price.rules ?? []) {
        elements.push(line('providers-pricing-rule', ruleText(rule, pricing.currency)));
      }
    }
    for (const [model, reason] of Object.entries(answer.missing)) {
      elements.push(line('providers-pricing-problem', t('pricesMissing', model, reason)));
    }
    const dropped = Object.keys(parsePrices(draft.prices).models).filter((model) => !(model in pricing.models));
    if (dropped.length > 0) {
      elements.push(line('providers-pricing-problem', t('pricesDropped', dropped.join(', '))));
    }
    if (pricing.sources) {
      const sources = pricing.sources.map((source) => (source.checked ? `${source.url} (${source.checked})` : source.url));
      elements.push(line('setting-description', t('pricesSources', sources.join(', '))));
    }
    for (const note of pricing.notes ?? []) {
      elements.push(line('setting-description', note));
    }
    return elements;
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
