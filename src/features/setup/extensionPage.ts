/**
 * The setup guide's first page (M6.7): the Claude Code extension. The copy in use, where it
 * came from and the settings for its updates; or, when there is none, the way to install one
 * (downloaded from Open VSX with progress, or a .vsix). The block itself is the settings
 * editor's (extensionUpdates/versionView.ts), without the way back.
 */

import type { ExtensionHostConnection } from '../../core/extensionHost';
import type { NativeApi } from '../../core/native';
import { IExtensionHost, INative, ISettings } from '../../core/serviceIds';
import type { SettingsService } from '../../core/settings';
import { AUTO_UPDATE_SETTING, DEFAULT_OPEN_VSX_URL, OPEN_VSX_URL_SETTING, PINNED_VERSION_SETTING } from '../../platform/extensionUpdates';
import { DisposableStore } from '../../platform/lifecycle';
import type { ExtensionInstallResult, ExtensionStatus } from '../../platform/protocol';
import { activityText, resultText } from '../extensionUpdates';
import { editorNameOf, VersionView } from '../extensionUpdates/versionView';
import { t } from './messages';
import type { GuideContext, GuidePage, GuidePageFactory } from './page';

/** The extension's page on Open VSX: download a .vsix by hand when the download keeps failing. */
const OPEN_VSX_PAGE_URL = 'https://open-vsx.org/extension/Anthropic/claude-code';

/** A version to stay on, by the pinned version setting's schema (`isVersion` in main is stricter). */
const PINNED_PATTERN = /^(\d+(\.\d+)*(-[0-9A-Za-z.]+)?)?$/;

/** What the download server's dropdown holds for an address of one's own. */
const CUSTOM_ADDRESS = 'custom';

export const extensionPage: GuidePageFactory = (context) => new ExtensionPage(context);

/** The page. */
class ExtensionPage implements GuidePage {
  readonly element: HTMLElement;
  readonly title = t('extPageTitle');
  private readonly context: GuideContext;
  private readonly doc: Document;
  private readonly native: NativeApi;
  private readonly settings: SettingsService;
  private readonly host: ExtensionHostConnection;
  private readonly store = new DisposableStore();
  private readonly versionBlock: HTMLElement;
  private readonly version: VersionView;
  private readonly installBlock: HTMLElement;
  private readonly downloadButton: HTMLButtonElement;
  private readonly fileButton: HTMLButtonElement;
  private readonly progress: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly failedHint: HTMLElement;
  private readonly copySourceHint: HTMLElement;
  private readonly cliHint: HTMLElement;
  private readonly autoUpdate: HTMLInputElement;
  private readonly pinnedVersion: HTMLInputElement;
  private readonly serverSelect: HTMLSelectElement;
  private readonly serverAddress: HTMLInputElement;
  /** Undefined until the first read (the constructor asks). */
  private status: ExtensionStatus | undefined;
  /** What the last action here said, for the status line. */
  private note: string | undefined;
  /** The last action failed: the hint under the status line offers another server and the Open VSX page. */
  private failed = false;

  constructor(context: GuideContext) {
    this.context = context;
    this.doc = context.doc;
    this.native = context.services.get(INative);
    this.settings = context.services.get(ISettings);
    this.host = context.services.get(IExtensionHost);

    const doc = this.doc;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] => {
      const node = doc.createElement(tag);
      node.className = className;
      node.textContent = text;
      return node;
    };
    const hint = (className: string): HTMLElement => element('p', `setup-hint ${className}`);
    const setting = (): HTMLElement => element('div', 'setting-item');
    const settingTitle = (name: string): HTMLElement => {
      const title = element('div', 'setting-title');
      title.append(element('span', 'setting-name', name));
      return title;
    };
    const description = (text: string): HTMLElement => element('div', 'setting-description', text);

    this.element = element('div', 'setup-page-body setup-extension');
    this.element.append(element('h2', 'setup-page-title', t('extTitle')), element('p', 'setup-text', t('extText')));

    // The copy in use: the settings editor's block, without going back to an earlier version.
    this.versionBlock = element('div', 'setup-version');
    this.version = new VersionView(this.versionBlock, {
      relaunch: () => void this.native.call('app.relaunch', undefined),
      check: () => void this.run(() => this.native.call('extension.check', undefined)),
      installFile: () => void this.run(() => this.native.call('extension.installFile', undefined)),
    });
    this.versionBlock.hidden = true;
    this.element.appendChild(this.versionBlock);

    // No copy: install one, with the updater's progress.
    this.installBlock = element('div', 'setup-install');
    const installActions = element('div', 'setup-actions');
    this.downloadButton = element('button', 'button setup-download', t('extDownload'));
    this.downloadButton.addEventListener('click', () => void this.run(() => this.native.call('extension.check', undefined)));
    this.fileButton = element('button', 'button secondary setup-file', t('extInstallFile'));
    this.fileButton.addEventListener('click', () => void this.run(() => this.native.call('extension.installFile', undefined)));
    installActions.append(this.downloadButton, this.fileButton);
    this.progress = element('div', 'setup-progress');
    this.progressBar = element('div', 'setup-progress-bar');
    this.progress.append(this.progressBar);
    this.statusLine = element('div', 'setup-status');
    this.statusLine.setAttribute('role', 'status');
    this.installBlock.append(installActions, this.progress, this.statusLine);
    this.installBlock.hidden = true;
    this.element.appendChild(this.installBlock);

    // A failed download: another server, or the .vsix from the extension's page by hand.
    this.failedHint = hint('setup-failed-help');
    const openVsx = element('a', 'setup-link', t('extOpenVsxPage'));
    openVsx.href = '#';
    openVsx.addEventListener('click', (event) => {
      event.preventDefault();
      void this.native.call('os.openExternal', { url: OPEN_VSX_PAGE_URL });
    });
    this.failedHint.append(doc.createTextNode(`${t('extFailedHelp')} `), openVsx);
    this.failedHint.hidden = true;
    this.element.appendChild(this.failedHint);

    this.copySourceHint = hint('setup-copy-source');
    this.copySourceHint.hidden = true;
    this.element.appendChild(this.copySourceHint);

    this.cliHint = hint('setup-extension-dir');
    this.cliHint.textContent = t('extCli');
    this.cliHint.hidden = true;
    this.element.appendChild(this.cliHint);

    // The update settings, laid out as the settings editor lays them out.
    const updates = element('section', 'setup-section setup-updates');
    updates.append(element('h3', 'setup-section-title', t('extUpdates')));

    const autoRow = setting();
    this.autoUpdate = element('input', 'setting-checkbox');
    this.autoUpdate.type = 'checkbox';
    this.autoUpdate.addEventListener('change', () => this.write(AUTO_UPDATE_SETTING, this.autoUpdate.checked, true));
    const autoText = element('label', 'setting-checkbox-row');
    autoText.append(this.autoUpdate, description(t('extAutoUpdateText')));
    autoRow.append(settingTitle(t('extAutoUpdate')), autoText);

    const pinnedRow = setting();
    this.pinnedVersion = element('input', 'setting-input');
    this.pinnedVersion.type = 'text';
    this.pinnedVersion.spellcheck = false;
    this.pinnedVersion.addEventListener('change', () => {
      const value = this.pinnedVersion.value.trim();
      const valid = PINNED_PATTERN.test(value);
      this.pinnedVersion.classList.toggle('invalid', !valid);
      if (valid) {
        this.write(PINNED_VERSION_SETTING, value, '');
      }
    });
    pinnedRow.append(settingTitle(t('extPinned')), description(t('extPinnedText')), this.pinnedVersion);

    const serverRow = setting();
    const serverControls = element('div', 'setup-server-row');
    this.serverSelect = element('select', 'setting-select');
    const option = (value: string, label: string): HTMLOptionElement => {
      const node = element('option', '', label);
      node.value = value;
      return node;
    };
    this.serverSelect.append(option(DEFAULT_OPEN_VSX_URL, t('extServerOfficial')));
    this.serverSelect.append(option(CUSTOM_ADDRESS, t('extServerCustom')));
    this.serverAddress = element('input', 'setting-input');
    this.serverAddress.type = 'text';
    this.serverAddress.spellcheck = false;
    this.serverSelect.addEventListener('change', () => {
      if (this.serverSelect.value !== CUSTOM_ADDRESS) {
        this.serverAddress.hidden = true;
        this.serverAddress.classList.remove('invalid');
        this.write(OPEN_VSX_URL_SETTING, DEFAULT_OPEN_VSX_URL, DEFAULT_OPEN_VSX_URL);
        return;
      }
      const url = this.settings.get(OPEN_VSX_URL_SETTING, DEFAULT_OPEN_VSX_URL);
      this.serverAddress.value = url === DEFAULT_OPEN_VSX_URL ? '' : url;
      this.serverAddress.hidden = false;
      this.serverAddress.focus();
    });
    this.serverAddress.addEventListener('change', () => {
      const value = this.serverAddress.value.trim();
      const valid = /^https?:\/\/\S+$/i.test(value);
      this.serverAddress.classList.toggle('invalid', !valid);
      if (valid) {
        this.write(OPEN_VSX_URL_SETTING, value, DEFAULT_OPEN_VSX_URL);
      }
    });
    serverControls.append(this.serverSelect, this.serverAddress);
    serverRow.append(settingTitle(t('extServer')), description(t('extServerText')), serverControls);

    updates.append(autoRow, pinnedRow, serverRow);
    this.element.appendChild(updates);

    this.refreshSettings();
    this.store.add(
      this.native.on('extensionStatus', (next) => {
        this.status = next;
        this.render();
        this.context.changed();
      }),
    );
    this.store.add(
      this.host.onDidConnect(() => {
        this.render();
        this.context.changed();
      }),
    );
    this.store.add(this.settings.onDidChange(() => this.refreshSettings()));
    // The guide may ask canSkip and canGoOn before it shows the page; have the status by then.
    void this.refresh();
  }

  get canSkip(): boolean {
    // Without a copy the window would be empty.
    return this.status?.running !== undefined;
  }

  get canGoOn(): boolean {
    return this.status?.running !== undefined && this.host.isConnected;
  }

  goOn(): Promise<boolean> {
    // The controls write as they change; nothing waits to be saved.
    return Promise.resolve(true);
  }

  show(): void {
    this.refreshSettings();
    void this.refresh();
  }

  focus(): void {
    // The first button that can be pressed: Check for Updates or Download and Install.
    this.element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  dispose(): void {
    this.store.dispose();
    this.element.remove();
  }

  /** Reads the extension's status again (it may have changed while another page was shown). */
  private async refresh(): Promise<void> {
    let status: ExtensionStatus;
    try {
      status = await this.native.call('extension.status', undefined);
    } catch (error) {
      this.context.logger.error('reading the extension status failed', error);
      return;
    }
    if (this.store.isDisposed) {
      return;
    }
    this.status = status;
    this.render();
    this.context.changed();
  }

  /** Runs an action here and keeps what it said for the status line. */
  private async run(action: () => Promise<ExtensionInstallResult>): Promise<void> {
    this.note = undefined;
    this.failed = false;
    this.render();
    try {
      const result = await action();
      this.failed = result.outcome === 'failed';
      // An installed copy is started in every window as main finishes, so the status line
      // goes back to what is running.
      this.note = result.outcome === 'installed' ? undefined : resultText(result);
    } catch (error) {
      this.context.logger.error('installing the extension failed', error);
    }
    if (this.store.isDisposed) {
      return;
    }
    this.render();
  }

  /** Writes a setting; the default value removes the entry instead, as the settings editor does. */
  private write(key: string, value: unknown, defaultValue: unknown): void {
    const stored = value === defaultValue ? undefined : value;
    void this.settings.update(key, stored).catch((error: unknown) => this.context.logger.error(`writing ${key} failed`, error));
  }

  /** Fills the three controls from the settings; one being typed in keeps what was typed. */
  private refreshSettings(): void {
    const { activeElement } = this.doc;
    this.autoUpdate.checked = this.settings.get(AUTO_UPDATE_SETTING, true) === true;
    if (activeElement !== this.pinnedVersion) {
      this.pinnedVersion.value = this.settings.get(PINNED_VERSION_SETTING, '');
      this.pinnedVersion.classList.remove('invalid');
    }
    if (activeElement !== this.serverAddress) {
      const url = this.settings.get(OPEN_VSX_URL_SETTING, DEFAULT_OPEN_VSX_URL);
      const custom = url !== DEFAULT_OPEN_VSX_URL;
      this.serverSelect.value = custom ? CUSTOM_ADDRESS : DEFAULT_OPEN_VSX_URL;
      this.serverAddress.value = custom ? url : '';
      this.serverAddress.hidden = !custom;
      this.serverAddress.classList.remove('invalid');
    }
  }

  /** What the status line says: what is happening, else what the last action said. */
  private statusLineText(): string {
    const status = this.status;
    if (status === undefined) {
      return '';
    }
    const activity = activityText(status.activity);
    if (activity !== undefined) {
      return activity;
    }
    if (this.note !== undefined) {
      return this.note;
    }
    const running = status.running;
    if (running !== undefined) {
      return this.host.isConnected ? t('extInstalled', running.version) : t('extStarting', running.version);
    }
    return status.lastCheck ? (resultText(status.lastCheck) ?? '') : '';
  }

  private render(): void {
    const status = this.status;
    if (status === undefined) {
      return; // nothing to say yet
    }
    const { running, activity } = status;
    const installed = running !== undefined;
    this.versionBlock.hidden = !installed;
    this.installBlock.hidden = installed;
    this.copySourceHint.hidden = running?.kind !== 'external';
    this.copySourceHint.textContent = running?.kind === 'external' ? t('extExternal', editorNameOf(running.path)) : '';
    this.cliHint.hidden = status.updatesApply;
    this.failedHint.hidden = !this.failed;

    const busy = activity.kind !== 'idle';
    this.downloadButton.disabled = busy;
    this.fileButton.disabled = busy;
    this.progress.hidden = activity.kind !== 'downloading';
    if (activity.kind === 'downloading') {
      const fraction = activity.total ? activity.received / activity.total : 0;
      this.progressBar.style.width = `${Math.round(fraction * 100)}%`;
    }

    const text = this.statusLineText();
    this.statusLine.textContent = text;
    this.statusLine.classList.toggle('failed', this.failed);
    if (installed) {
      // The block has a status line of its own, under its buttons.
      this.version.render(status, text);
    }
  }
}
