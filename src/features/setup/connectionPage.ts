/**
 * The setup guide's second page (M6.7): the connection to Claude. The choices come first —
 * an API key (a provider from a preset, then its key, models, prices and a test here), a
 * guide to getting a key, or a Claude account — and the provider's form fills the page after
 * that; its sections are the providers editor's (ProviderForm), with a line of their own
 * above each.
 */

import type { CommandService } from '../../core/commands';
import type { Dialogs } from '../../core/dialogs';
import type { NativeApi } from '../../core/native';
import { ICommands, IDialogs, INative, ISettings } from '../../core/serviceIds';
import type { SettingsService } from '../../core/settings';
import { DisposableStore } from '../../platform/lifecycle';
import { DEFAULT_PROVIDER_SETTING, SUBSCRIPTION_ID, type ProviderSummary } from '../../platform/providers';
import { IProviders } from '../providers';
import { ProviderForm, providerLabel, type ProviderFormSection } from '../providers/providerForm';
import { addFromPreset, type ProvidersModel } from '../providers/providersEditor';
import { presetById, presetPricing, PROVIDER_PRESETS, URL_PLACEHOLDER } from '../providers/presets';
import { t } from './messages';
import type { GuideContext, GuidePage, GuidePageFactory } from './page';

/** The provider chosen at first. */
const DEEPSEEK_PRESET = 'deepseek';
const DEEPSEEK_KEYS_URL = 'https://platform.deepseek.com/api_keys';
/** The quick start on getting a DeepSeek key; there may be none (then the page opens in a browser). */
const DEEPSEEK_KEY_COMMAND = 'quickStart.deepSeekKey';

/** Whether a provider can be used as it is: the ones that take a key need theirs. */
function usable(provider: ProviderSummary | undefined): boolean {
  if (provider === undefined) {
    return false;
  }
  return provider.type === 'compatible' || provider.type === 'anthropic-api' ? provider.hasKey : true;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const connectionPage: GuidePageFactory = (context) => new ConnectionPage(context);

/** The page. */
class ConnectionPage implements GuidePage {
  readonly element: HTMLElement;
  readonly title = t('connPageTitle');
  readonly canSkip = true;

  private readonly context: GuideContext;
  private readonly doc: Document;
  private readonly native: NativeApi;
  private readonly providers: ProvidersModel;
  private readonly settings: SettingsService;
  private readonly commands: CommandService;
  private readonly dialogs: Dialogs;
  private readonly store = new DisposableStore();
  private readonly currentLine: HTMLElement;
  private readonly currentActions: HTMLElement;
  private readonly choiceView: HTMLElement;
  private readonly configView: HTMLElement;
  private readonly configBody: HTMLElement;
  /** The choices, or a provider's form. */
  private view: 'choices' | 'config' = 'choices';
  /** Set Up Another was pressed: the choices show beside the provider this window already uses. */
  private revealed = false;
  /** The preset chosen in the list, until OK adds a provider from it. */
  private presetChoice = DEEPSEEK_PRESET;
  /** The provider this page added; undefined while its preset is being chosen. */
  private summary: ProviderSummary | undefined;
  private form: ProviderForm | undefined;
  /** The provider the form was made from (it keeps its draft while it stays the same one). */
  private formFor: string | undefined;
  /** The checkbox at the end: the default provider, which new folders use too. */
  private defaultForNew = true;
  /** The prices table is shown (it is long, and a preset fills it in). */
  private pricesOpen = false;

  constructor(context: GuideContext) {
    this.context = context;
    this.doc = context.doc;
    this.native = context.services.get(INative);
    this.providers = context.services.get(IProviders);
    this.settings = context.services.get(ISettings);
    this.commands = context.services.get(ICommands);
    this.dialogs = context.services.get(IDialogs);

    this.element = this.make('div', 'setup-page-body setup-connection');
    this.element.append(this.make('h2', 'setup-page-title', t('connTitle')), this.make('p', 'setup-text', t('connText')));

    // The window already has a provider that works: say which, and go on.
    this.currentLine = this.make('p', 'setup-text setup-current');
    this.currentLine.hidden = true;
    this.element.appendChild(this.currentLine);

    this.currentActions = this.make('div', 'setup-actions setup-current-actions');
    const next = this.make('button', 'button setup-connection-next', t('connNext'));
    next.type = 'button';
    next.addEventListener('click', () => context.next());
    const another = this.make('button', 'button secondary setup-set-up-another', t('connSetUpAnother'));
    another.type = 'button';
    another.addEventListener('click', () => {
      this.revealed = true;
      this.render();
    });
    this.currentActions.append(next, another);
    this.currentActions.hidden = true;
    this.element.appendChild(this.currentActions);

    this.choiceView = this.make('div', 'setup-choices');
    this.choiceView.append(
      this.choice(t('connChoiceKey'), t('connChoiceKeyText'), false, () => this.toConfig()),
      this.choice(t('connChoiceNoKey'), t('connChoiceNoKeyText'), false, () => this.openKeyGuide()),
      this.choice(t('connChoiceAccount'), t('connChoiceAccountText'), true, () => void this.useAccount()),
    );
    this.element.appendChild(this.choiceView);

    this.configView = this.make('div', 'setup-config');
    this.configBody = this.make('div', 'setup-config-body');
    this.configView.appendChild(this.configBody);
    this.configView.hidden = true;
    this.element.appendChild(this.configView);

    this.store.add(this.providers.onDidChange(() => this.refresh()));
    this.render();
  }

  get canGoOn(): boolean | undefined {
    // On the choices the page's own buttons move on; with a provider, Next waits for a usable one.
    return this.view === 'config' ? usable(this.summary) : undefined;
  }

  /** Saves the form, then switches the window to the provider. */
  async goOn(): Promise<boolean> {
    const summary = this.summary;
    if (summary === undefined) {
      return false;
    }
    try {
      if (this.form !== undefined && this.form.dirty && !(await this.form.save())) {
        return false;
      }
      await this.native.call('providers.select', { id: summary.id });
      if (this.defaultForNew) {
        await this.settings.update(DEFAULT_PROVIDER_SETTING, summary.id);
      }
      return true;
    } catch (error) {
      this.context.logger.error('connecting this window to the provider failed', error);
      return false;
    }
  }

  show(): void {
    // The title bar may have switched the window's provider meanwhile.
    this.render();
  }

  focus(): void {
    const scope = !this.configView.hidden ? this.configView : !this.choiceView.hidden ? this.choiceView : this.currentActions;
    scope.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  dispose(): void {
    this.store.dispose();
    this.element.remove();
  }

  private make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  private link(text: string, onClick: () => void): HTMLAnchorElement {
    const node = this.make('a', 'setup-link', text);
    node.href = '#';
    node.addEventListener('click', (event) => {
      event.preventDefault();
      onClick();
    });
    return node;
  }

  private choice(title: string, text: string, small: boolean, onClick: () => void): HTMLButtonElement {
    const button = this.make('button', `setup-choice${small ? ' small' : ''}`);
    button.type = 'button';
    button.append(this.make('span', 'setup-choice-title', title), this.make('span', 'setup-choice-text', text));
    button.addEventListener('click', onClick);
    return button;
  }

  /** The providers changed: here, in the title bar, or in the providers editor. */
  private refresh(): void {
    const summary = this.summary;
    if (summary !== undefined) {
      const next = this.providers.state.providers.find((provider) => provider.id === summary.id);
      if (next === undefined) {
        // Removed elsewhere: back to choosing a provider.
        this.summary = undefined;
        this.form = undefined;
        this.formFor = undefined;
      } else {
        this.summary = next;
        if (this.form?.dirty === false) {
          // Nothing typed here: the form starts again from what was saved (as the providers editor does).
          this.form = undefined;
          this.formFor = undefined;
        }
      }
    }
    this.render();
  }

  private render(): void {
    const active = this.providers.active;
    const uses = active !== undefined && active.type !== 'subscription' && usable(active);
    const inConfig = this.view === 'config';
    this.currentLine.hidden = inConfig || !uses;
    if (active !== undefined && uses) {
      this.currentLine.textContent = t('connUses', providerLabel(active));
    }
    this.currentActions.hidden = inConfig || !uses;
    this.choiceView.hidden = inConfig || (uses && !this.revealed);
    this.configView.hidden = !inConfig;
    if (inConfig) {
      this.renderConfig();
    }
    this.context.changed();
  }

  private renderConfig(): void {
    const summary = this.summary;
    const parts: HTMLElement[] = [this.backLink(), this.providerSection(summary)];
    if (summary !== undefined) {
      const form = this.ensureForm(summary);
      parts.push(...this.formSections(form, summary));
    }
    this.configBody.replaceChildren(...parts);
  }

  private backLink(): HTMLElement {
    return this.link(t('connBack'), () => {
      // The provider made here stays; only Change removes it.
      this.view = 'choices';
      this.render();
    });
  }

  private providerSection(summary: ProviderSummary | undefined): HTMLElement {
    const section = this.make('section', 'setup-section setup-provider');
    section.appendChild(this.make('h3', 'setup-section-title', t('connProvider')));
    if (summary !== undefined) {
      const line = this.make('div', 'setup-provider-current');
      line.append(
        this.make('span', 'setup-provider-name', providerLabel(summary)),
        this.link(t('connChange'), () => void this.changeProvider()),
      );
      section.appendChild(line);
      return section;
    }

    section.appendChild(this.make('p', 'setup-text', t('connProviderText')));
    const actions = this.make('div', 'setup-actions');
    const select = this.make('select', 'setting-select setup-provider-select');
    select.setAttribute('aria-label', t('connProvider'));
    // DeepSeek first: the one the key guide is about.
    const presets = [...PROVIDER_PRESETS].sort((a, b) => Number(b.id === DEEPSEEK_PRESET) - Number(a.id === DEEPSEEK_PRESET));
    for (const preset of presets) {
      const option = this.make('option', '', preset.name());
      option.value = preset.id;
      select.appendChild(option);
    }
    select.value = this.presetChoice;
    select.addEventListener('change', () => {
      this.presetChoice = select.value;
    });
    const ok = this.make('button', 'button setup-provider-ok', t('connProviderOk'));
    ok.type = 'button';
    ok.addEventListener('click', () => void this.addProvider(select.value));
    actions.append(select, ok);
    section.appendChild(actions);
    return section;
  }

  private ensureForm(summary: ProviderSummary): ProviderForm {
    if (this.form !== undefined && this.formFor === summary.id) {
      return this.form;
    }
    const form = new ProviderForm(
      this.doc,
      {
        native: this.native,
        dialogs: this.dialogs,
        logger: this.context.logger,
        usedModels: new Map<string, readonly string[]>(),
      },
      summary,
      {
        edited: () => this.context.changed(),
        rerender: (revealPrices) => {
          this.pricesOpen ||= revealPrices;
          this.render();
          if (revealPrices) {
            this.revealPrices();
          }
        },
      },
    );
    this.form = form;
    this.formFor = summary.id;
    return form;
  }

  /** The key, the models, the prices and the test, each in a section of its own. */
  private formSections(form: ProviderForm, summary: ProviderSummary): HTMLElement[] {
    const sections: HTMLElement[] = [];
    // The Alibaba Cloud endpoints take a workspace id: it goes in front of the key.
    const withConnection = form.usesKey && URL_PLACEHOLDER.test(form.draft.baseUrl);
    const withPrices = form.type === 'compatible';
    const wanted: ProviderFormSection[] = [];
    if (withConnection) {
      wanted.push('connection');
    }
    wanted.push('key', 'models');
    if (withPrices) {
      wanted.push('prices');
    }
    // One call, so the price rows follow the models typed above them.
    const rows = form.rows(summary, wanted);
    let at = 0;
    const connectionRows: HTMLElement[] = [];
    if (withConnection) {
      connectionRows.push(...rows.slice(at, at + 2));
      at += 2;
    }
    const keyRows: HTMLElement[] = [];
    if (form.usesKey) {
      keyRows.push(...rows.slice(at, at + 1));
      at += 1;
    }
    const modelsRow = rows[at];
    at += 1;
    const pricesRow = withPrices ? rows[at] : undefined;
    const preset = presetById(summary.preset);

    if (form.usesKey) {
      const section = this.make('section', 'setup-section setup-key');
      const text = this.make('p', 'setup-text', t('connKeyText'));
      const docs = preset?.docs;
      if (docs !== undefined) {
        text.append(
          ' ',
          this.link(t('connSetupGuide'), () => void this.native.call('os.openExternal', { url: docs })),
        );
      }
      section.append(this.make('h3', 'setup-section-title', t('connKey')), text, ...connectionRows, ...keyRows);
      sections.push(section);
    }

    if (modelsRow !== undefined) {
      const section = this.make('section', 'setup-section setup-models');
      section.append(this.make('h3', 'setup-section-title', t('connModels')), this.make('p', 'setup-text', t('connModelsText')), modelsRow);
      sections.push(section);
    }

    if (pricesRow !== undefined) {
      const section = this.make('section', 'setup-section setup-prices');
      section.append(this.make('h3', 'setup-section-title', t('connPrices')), this.make('p', 'setup-text', t('connPricesText')));
      // Prices change too often for a preset's to be trusted: asking an AI chat comes first,
      // above the table (closed, the preset's prices in it).
      const assist = form.takePriceAssist();
      if (assist !== undefined) {
        const shipped = preset === undefined ? undefined : presetPricing(preset.id);
        const checked = shipped?.sources?.find((source) => source.checked !== undefined)?.checked;
        const actions = this.make('div', 'setup-actions setup-prices-ai');
        actions.append(...assist.buttons);
        const hint = this.make(
          'p',
          'setup-hint',
          preset !== undefined && checked !== undefined ? t('connPricesAiDated', preset.name(), checked) : t('connPricesAi'),
        );
        section.append(actions, hint, assist.panel);
      }
      const toggle = this.make('button', 'button secondary setup-prices-toggle');
      toggle.type = 'button';
      const shown = (): void => {
        pricesRow.hidden = !this.pricesOpen;
        toggle.textContent = this.pricesOpen ? t('connPricesHide') : t('connPricesShow');
      };
      toggle.addEventListener('click', () => {
        this.pricesOpen = !this.pricesOpen;
        shown();
      });
      shown();
      section.append(toggle, pricesRow);
      sections.push(section);
    }

    const testControls = form.testControls();
    if (testControls.length > 0) {
      const section = this.make('section', 'setup-section setup-test');
      const actions = this.make('div', 'setup-actions');
      actions.append(...testControls);
      section.append(this.make('h3', 'setup-section-title', t('connTest')), this.make('p', 'setup-text', t('connTestText')), actions);
      sections.push(section);
    }

    sections.push(this.defaultProviderRow());
    return sections;
  }

  private defaultProviderRow(): HTMLElement {
    const row = this.make('div', 'setting-item setup-default-provider');
    const label = this.make('label', 'setting-checkbox-row');
    const box = this.make('input', 'setting-checkbox');
    box.type = 'checkbox';
    box.checked = this.defaultForNew;
    box.addEventListener('change', () => {
      this.defaultForNew = box.checked;
    });
    label.append(box, this.make('span', 'setting-description', t('connDefaultProvider')));
    row.appendChild(label);
    return row;
  }

  private revealPrices(): void {
    this.configBody.querySelector<HTMLElement>('.providers-prices')?.scrollIntoView({ block: 'center' });
  }

  private toConfig(): void {
    this.view = 'config';
    this.render();
  }

  /** Adds a provider from a preset, then shows its form. */
  private async addProvider(presetId: string): Promise<void> {
    try {
      const summary = await addFromPreset(presetId, this.providers, this.native);
      if (summary === undefined) {
        return;
      }
      this.summary = summary;
      this.form = undefined;
      this.formFor = undefined;
      this.render();
    } catch (error) {
      this.context.logger.error('adding a provider failed', error);
      void this.dialogs.showMessage({ severity: 'error', modal: false, message: t('connAddFailed', reason(error)), items: [] });
    }
  }

  /** Removes the provider this page made and goes back to the presets. */
  private async changeProvider(): Promise<void> {
    const summary = this.summary;
    if (summary === undefined) {
      return;
    }
    try {
      await this.native.call('providers.remove', { id: summary.id });
    } catch (error) {
      this.context.logger.error('removing the provider failed', error);
      void this.dialogs.showMessage({ severity: 'error', modal: false, message: t('connRemoveFailed', reason(error)), items: [] });
      return;
    }
    this.summary = undefined;
    this.form = undefined;
    this.formFor = undefined;
    this.render();
  }

  /** The key guide opens beside this window; the guide stays on this page. */
  private openKeyGuide(): void {
    if (this.commands.has(DEEPSEEK_KEY_COMMAND)) {
      void this.commands
        .execute(DEEPSEEK_KEY_COMMAND)
        .catch((error: unknown) => this.context.logger.error('opening the API key guide failed', error));
      return;
    }
    void this.native
      .call('os.openExternal', { url: DEEPSEEK_KEYS_URL })
      .catch((error: unknown) => this.context.logger.error('opening the API key page failed', error));
  }

  private async useAccount(): Promise<void> {
    try {
      if (this.providers.state.current !== SUBSCRIPTION_ID) {
        await this.native.call('providers.select', { id: SUBSCRIPTION_ID });
      }
    } catch (error) {
      this.context.logger.error('switching to the Claude account failed', error);
      void this.dialogs.showMessage({ severity: 'error', modal: false, message: t('connSwitchFailed', reason(error)), items: [] });
      return;
    }
    this.context.next();
  }
}
