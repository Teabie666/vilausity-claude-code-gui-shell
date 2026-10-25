/**
 * The Claude Code extension's version (M4): the settings for its updates, and a block at the
 * top of their section in the settings editor with the version in use and where it came
 * from, Check for Updates, Install from VSIX..., going back to the version before, and a
 * restart when a new one is ready. Main does the work (host/main/extensionUpdater.ts); an
 * automatic update says so once it is downloaded.
 */

import { CommandCategory } from '../../core/messages';
import type { ShellModule } from '../../core/module';
import { ICommands, IDialogs, INative, ISettings } from '../../core/serviceIds';
import { Emitter } from '../../platform/event';
import {
  AUTO_UPDATE_SETTING,
  DEFAULT_OPEN_VSX_URL,
  OPEN_VSX_URL_SETTING,
  PINNED_VERSION_SETTING,
  type ExtensionErrorCode,
} from '../../platform/extensionUpdates';
import type { ExtensionActivity, ExtensionInstallResult, ExtensionStatus } from '../../platform/protocol';
import { t } from './messages';

const ERROR_TEXT: Record<ExtensionErrorCode, () => string> = {
  network: () => t('errorNetwork'),
  notFound: () => t('errorNotFound'),
  checksum: () => t('errorChecksum'),
  notClaudeCode: () => t('errorNotClaudeCode'),
  wrongPlatform: () => t('errorWrongPlatform'),
  badPackage: () => t('errorBadPackage'),
  extract: () => t('errorExtract'),
  busy: () => t('errorBusy'),
  noPrevious: () => t('errorNoPrevious'),
};

/** What a check or an install ended with, for the status line; undefined says nothing. */
export function resultText(result: ExtensionInstallResult): string | undefined {
  switch (result.outcome) {
    case 'upToDate':
      return t('upToDate');
    case 'installed':
      return t('installed', result.version);
    case 'failed':
      return t('failed', ERROR_TEXT[result.code]());
    default:
      return undefined;
  }
}

/** Why going back did not happen; undefined when it did. */
export function rollBackFailedText(result: ExtensionInstallResult): string | undefined {
  return result.outcome === 'failed' ? t('rollBackFailed', ERROR_TEXT[result.code]()) : undefined;
}

/** What the updater is doing, for a status line; undefined when idle. */
export function activityText(activity: ExtensionActivity): string | undefined {
  switch (activity.kind) {
    case 'checking':
      return t('checking');
    case 'downloading':
      return t('downloading', activity.version, progressText(activity.received, activity.total));
    case 'installing':
      return t('installing', activity.label);
    case 'backingUp':
      return t('backingUp', activity.version);
    default:
      return undefined;
  }
}

/** `12.3 / 120.5 MB (10%)`, or just the megabytes when the size is unknown. */
export function progressText(received: number, total?: number): string {
  const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);
  return total ? `${mb(received)} / ${mb(total)} MB (${Math.floor((received / total) * 100)}%)` : `${mb(received)} MB`;
}

export const extensionUpdatesModule: ShellModule = {
  id: 'extensionUpdates',
  dependsOn: ['settings'],
  async activate({ services, subscriptions, logger }) {
    const native = services.get(INative);
    const settings = services.get(ISettings);
    const dialogs = services.get(IDialogs);
    const commands = services.get(ICommands);

    let status: ExtensionStatus = await native.call('extension.status', undefined);
    /** The last outcome of an action taken here (a check's also arrives in the status). */
    let note: string | undefined;
    const changed = subscriptions.add(new Emitter<void>());
    subscriptions.add(
      native.on('extensionStatus', (next) => {
        if (next.lastCheck?.at !== status.lastCheck?.at) {
          // A newer check (an automatic one, say) says more than an older action.
          note = undefined;
        }
        status = next;
        changed.fire();
      }),
    );
    const setNote = (text: string | undefined): void => {
      note = text;
      changed.fire();
    };

    const section = t('section');
    subscriptions.add(
      settings.register([
        {
          key: AUTO_UPDATE_SETTING,
          section,
          order: 1,
          schema: { type: 'boolean', default: true, description: t('autoUpdateSetting') },
        },
        {
          key: PINNED_VERSION_SETTING,
          section,
          order: 2,
          showDescription: true,
          schema: { type: 'string', default: '', pattern: '^(\\d+(\\.\\d+)*(-[0-9A-Za-z.]+)?)?$', description: t('versionSetting') },
        },
        {
          key: OPEN_VSX_URL_SETTING,
          section,
          order: 3,
          schema: { type: 'string', default: DEFAULT_OPEN_VSX_URL, format: 'uri', description: t('openVsxSetting') },
        },
      ]),
    );

    const relaunch = (): void => void native.call('app.relaunch', undefined);
    const check = async (): Promise<ExtensionInstallResult> => {
      setNote(undefined);
      const result = await native.call('extension.check', undefined);
      setNote(resultText(result));
      return result;
    };
    const installFile = async (): Promise<ExtensionInstallResult> => {
      setNote(undefined);
      const result = await native.call('extension.installFile', undefined);
      setNote(resultText(result));
      return result;
    };
    /** One click: back to the version before, then a restart to use it (windows and conversations come back). */
    const rollBack = async (): Promise<ExtensionInstallResult> => {
      setNote(undefined);
      const result = await native.call('extension.rollBack', undefined);
      if (result.outcome === 'installed') {
        relaunch();
      } else {
        setNote(rollBackFailedText(result));
      }
      return result;
    };
    const logged =
      <T>(action: () => Promise<T>) =>
      (): void => {
        action().catch((error: unknown) => logger.error('extension action failed', error));
      };

    subscriptions.add(
      settings.registerWidget({
        id: 'extensionUpdates.version',
        section,
        keywords: t('keywords'),
        create: (container) => {
          const view = new VersionView(container, {
            relaunch,
            check: logged(check),
            installFile: logged(installFile),
            rollBack: logged(rollBack),
          });
          const render = (): void => view.render(status, note);
          render();
          return changed.event(render);
        },
      }),
    );

    // From the command palette the outcome comes as a notification.
    const notify = (text: string | undefined, failed: boolean): void => {
      if (text) {
        void dialogs.showMessage({ severity: failed ? 'error' : 'info', message: text, modal: false, items: [] });
      }
    };
    const category = CommandCategory.preferences;
    subscriptions.add(
      commands.register(
        'extension.checkForUpdates',
        async () => {
          const result = await check();
          notify(resultText(result), result.outcome === 'failed');
        },
        { title: t('checkCommand'), category },
      ),
    );
    subscriptions.add(
      commands.register(
        'extension.installFromVsix',
        async () => {
          const result = await installFile();
          notify(resultText(result), result.outcome === 'failed');
        },
        { title: t('installFileCommand'), category },
      ),
    );
    subscriptions.add(
      commands.register(
        'extension.rollBack',
        async () => {
          const result = await rollBack();
          notify(rollBackFailedText(result), true);
        },
        { title: t('rollBackCommand'), category },
      ),
    );

    // An automatic update is ready: say so once, in the window that was used last.
    subscriptions.add(
      native.on('extensionUpdated', ({ version }) => {
        void dialogs
          .showMessage({ severity: 'info', message: t('updated', version), modal: false, items: [t('restartNow')] })
          .then((picked) => {
            if (picked === 0) {
              relaunch();
            }
          });
      }),
    );

    // The extension running uses an API Vilausity lacks that the version before did not: offer
    // to go back to that one (as the settings' button does), or not to hear of this version again.
    const showUnimplemented = async (): Promise<void> => {
      const warning = await native.call('extension.takeUnimplementedWarning', undefined);
      if (warning === undefined) {
        return; // none, or another window took it
      }
      const { version, rollback } = warning;
      const items = rollback === undefined ? [t('notAgain')] : [t('rollBackAndRestart', rollback), t('notAgain')];
      const picked = await dialogs.showMessage({ severity: 'warning', message: t('unimplemented', version), modal: false, items });
      if (picked === undefined) {
        return;
      }
      if (rollback !== undefined && picked === 0) {
        const result = await native.call('extension.rollBack', undefined);
        if (result.outcome === 'installed') {
          relaunch();
        }
      } else {
        await native.call('extension.unimplementedMute', { version });
      }
    };
    const showFailed = (error: unknown): void => logger.error('showing the unimplemented-API warning failed', error);
    subscriptions.add(native.on('extensionUnimplemented', () => void showUnimplemented().catch(showFailed)));
    // It may have come before this page listened.
    void showUnimplemented().catch(showFailed);
  },
};

/** The buttons' handlers (handed to them as they are, so not methods). */
interface VersionActions {
  readonly relaunch: () => void;
  readonly check: () => void;
  readonly installFile: () => void;
  readonly rollBack: () => void;
}

/** The block in the settings editor. */
class VersionView {
  private readonly current: HTMLElement;
  private readonly source: HTMLElement;
  private readonly pendingRow: HTMLElement;
  private readonly pendingText: HTMLElement;
  private readonly previousRow: HTMLElement;
  private readonly previousText: HTMLElement;
  private readonly rollBackButton: HTMLButtonElement;
  private readonly checkButton: HTMLButtonElement;
  private readonly installButton: HTMLButtonElement;
  private readonly statusText: HTMLElement;

  constructor(container: HTMLElement, actions: VersionActions) {
    const doc = container.ownerDocument;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] => {
      const node = doc.createElement(tag);
      node.className = className;
      node.textContent = text;
      return node;
    };
    const button = (text: string, onClick: () => void, secondary = true): HTMLButtonElement => {
      const node = element('button', secondary ? 'button secondary' : 'button', text);
      node.addEventListener('click', onClick);
      return node;
    };
    const row = (...children: HTMLElement[]): HTMLElement => {
      const node = element('div', 'extension-version-row');
      node.append(...children);
      return node;
    };

    container.classList.add('extension-version');
    this.current = element('div', 'extension-version-current');
    this.source = element('div', 'extension-version-source');
    this.pendingText = element('span', 'extension-version-text');
    this.pendingRow = row(this.pendingText, button(t('restartNow'), actions.relaunch, false));
    this.pendingRow.classList.add('extension-version-pending');
    this.previousText = element('span', 'extension-version-text');
    this.rollBackButton = button('', actions.rollBack);
    this.rollBackButton.classList.add('extension-version-rollback');
    this.rollBackButton.title = t('rollBackTooltip');
    this.previousRow = row(this.previousText, this.rollBackButton);
    this.previousRow.classList.add('extension-version-previous');
    this.checkButton = button(t('check'), actions.check);
    this.checkButton.classList.add('extension-version-check');
    this.installButton = button(t('installFile'), actions.installFile);
    this.installButton.title = t('installFileTooltip');
    this.installButton.classList.add('extension-version-install');
    this.statusText = element('span', 'extension-version-status');
    this.statusText.setAttribute('role', 'status');
    container.append(
      this.current,
      this.source,
      this.pendingRow,
      this.previousRow,
      row(this.checkButton, this.installButton, this.statusText),
    );
  }

  render(status: ExtensionStatus, note: string | undefined): void {
    const { running, managed, activity } = status;
    this.current.textContent = running ? t('inUse', running.version) : t('notFound');
    this.source.textContent = running?.path ?? '';
    this.source.hidden = !running;

    const pending = managed.pending;
    this.pendingRow.hidden = pending === undefined;
    this.pendingText.textContent = pending === undefined ? '' : t('pending', pending);

    // Shown even when there is nothing to go back to, so the way back is easy to find.
    const target = status.rollback;
    // With a switch pending, what the next start keeps as the version before (see switchToPending).
    const keptForLater = pending !== undefined ? (managed.current ?? managed.previous) : undefined;
    this.previousRow.hidden = !running || running.kind === 'cli';
    const previous = target?.version ?? (keptForLater !== undefined && keptForLater !== pending ? keptForLater : undefined);
    this.previousText.textContent = previous !== undefined ? t('previous', previous) : t('noPrevious');
    // Another editor's copy (backed up into Vilausity when going back to it): where it is.
    this.previousText.title = target?.from === 'external' ? target.path : '';
    this.rollBackButton.textContent = target ? t('rollBackAndRestart', target.version) : t('rollBackUnavailable');

    const idle = activity.kind === 'idle';
    for (const button of [this.checkButton, this.installButton]) {
      button.disabled = !idle || !status.updatesApply;
    }
    this.rollBackButton.disabled = !idle || !status.updatesApply || !target;
    this.statusText.textContent = activityText(activity) ?? note ?? (status.lastCheck ? (resultText(status.lastCheck) ?? '') : '');
  }
}
