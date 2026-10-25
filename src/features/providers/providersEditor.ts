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
import { providerAccentColor, providerIdFor, SUBSCRIPTION_ID, type ProviderSummary } from '../../platform/providers';
import { t } from './messages';
import { ProviderForm, providerLabel } from './providerForm';
import { presetById, presetPricing } from './presets';

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

export class ProvidersEditorPane implements EditorPane {
  /** A form: Escape in a field must not close it. */
  readonly closesOnEscape = false;
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly form: HTMLElement;
  private readonly disposables = new DisposableStore();
  private selectedId: string;
  /** The selected provider's form, while it is shown (kept through re-renders, so through its edits). */
  private providerForm: ProviderForm | undefined;
  /** The models each provider's conversations used, as main last said (`usage.models`). */
  private readonly usedModels = new Map<string, readonly string[]>();

  private get dirty(): boolean {
    return this.providerForm?.dirty ?? false;
  }

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
          this.providerForm = undefined;
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
    this.providerForm = undefined;
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
      return this.providerForm?.save() ?? Promise.resolve(true);
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
      this.form.append(this.description(t('subscriptionDetail')), this.actions(provider, undefined));
      return;
    }
    this.providerForm ??= new ProviderForm(doc, { ...this.context, usedModels: this.usedModels }, provider, {
      edited: () => {
        this.form.querySelector('.providers-save')?.removeAttribute('disabled');
        this.form.querySelector('.providers-revert')?.removeAttribute('disabled');
      },
      rerender: (revealPrices) => {
        this.renderForm();
        if (revealPrices) {
          this.revealPrices();
        }
      },
    });
    const form = this.providerForm;
    this.form.append(
      ...form.rows(provider, ['name', 'connection', 'key', 'models', 'prices', 'advanced', 'color']),
      this.actions(provider, form),
    );
  }

  /** Save, Revert and Test Connection when it has a form; then the shortcut, the guide, Remove. */
  private actions(provider: ProviderSummary, form: ProviderForm | undefined): HTMLElement {
    const doc = this.root.ownerDocument;
    const bar = doc.createElement('div');
    bar.className = 'providers-actions';
    if (form) {
      const save = this.button(t('save'), 'primary', () => form.save());
      save.classList.add('providers-save');
      const revert = this.button(t('revert'), 'secondary', () => {
        this.providerForm = undefined;
        this.renderForm();
      });
      revert.classList.add('providers-revert');
      if (!form.dirty) {
        save.setAttribute('disabled', '');
        revert.setAttribute('disabled', '');
      }
      bar.append(save, revert);
      bar.append(...form.testControls());
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
    if (form) {
      const remove = this.button(t('remove'), 'secondary', async () => {
        const choice = await this.context.dialogs.showMessage({
          severity: 'warning',
          modal: true,
          message: t('removeConfirm', providerLabel(provider)),
          items: [t('remove')],
        });
        if (choice === 0) {
          form.dirty = false;
          await this.call(() => this.context.native.call('providers.remove', { id: provider.id }));
        }
      });
      remove.classList.add('providers-remove');
      bar.append(remove);
    }
    return bar;
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

  private description(text: string): HTMLElement {
    const description = this.root.ownerDocument.createElement('div');
    description.className = 'setting-description';
    description.textContent = text;
    return description;
  }

  private button(label: string, kind: 'primary' | 'secondary', run: () => unknown): HTMLButtonElement {
    const button = this.root.ownerDocument.createElement('button');
    button.className = kind === 'primary' ? 'button' : 'button secondary';
    button.textContent = label;
    button.addEventListener('click', () => void run());
    return button;
  }
}
