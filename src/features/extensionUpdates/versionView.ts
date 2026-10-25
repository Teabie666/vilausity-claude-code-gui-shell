/**
 * The Claude Code extension's version block: the version in use, where it came from and from
 * which path, a pending update, and the way back. The settings editor (extensionUpdates)
 * shows it with every button; the setup guide's first page without the way back.
 */

import type { ExtensionErrorCode } from '../../platform/extensionUpdates';
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

/** The editor another copy of the extension came from, by its path; VSCodium keeps its elsewhere. */
export function editorNameOf(path: string): string {
  const lower = path.toLowerCase();
  if (lower.includes('vscodium') || lower.includes('.vscode-oss')) {
    return t('editorVscodium');
  }
  if (lower.includes('.vscode\\') || lower.includes('.vscode/')) {
    return t('editorVsCode');
  }
  return t('editorAnother');
}

/** Where the copy in use came from, in one line. */
export function sourceText(running: NonNullable<ExtensionStatus['running']>): string {
  switch (running.kind) {
    case 'managed':
      return t('sourceManaged');
    case 'cli':
      return t('sourceCli');
    default:
      return t('sourceFrom', editorNameOf(running.path));
  }
}

/** The buttons' handlers (handed to them as they are, so not methods). */
export interface VersionActions {
  readonly relaunch: () => void;
  readonly check: () => void;
  readonly installFile: () => void;
  /** Left out where there is no way back (the setup guide). */
  readonly rollBack?: () => void;
}

/** The block in the settings editor, and on the setup guide's first page. */
export class VersionView {
  private readonly current: HTMLElement;
  private readonly source: HTMLElement;
  private readonly path: HTMLElement;
  private readonly pendingRow: HTMLElement;
  private readonly pendingText: HTMLElement;
  private readonly previousRow: HTMLElement | undefined;
  private readonly previousText: HTMLElement | undefined;
  private readonly rollBackButton: HTMLButtonElement | undefined;
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
    this.path = element('div', 'extension-version-path');
    this.pendingText = element('span', 'extension-version-text');
    this.pendingRow = row(this.pendingText, button(t('restartNow'), actions.relaunch, false));
    this.pendingRow.classList.add('extension-version-pending');
    this.checkButton = button(t('check'), actions.check);
    this.checkButton.classList.add('extension-version-check');
    this.installButton = button(t('installFile'), actions.installFile);
    this.installButton.title = t('installFileTooltip');
    this.installButton.classList.add('extension-version-install');
    this.statusText = element('span', 'extension-version-status');
    this.statusText.setAttribute('role', 'status');
    const children: HTMLElement[] = [this.current, this.source, this.path, this.pendingRow];
    if (actions.rollBack !== undefined) {
      const rollBack = actions.rollBack;
      this.previousText = element('span', 'extension-version-text');
      this.rollBackButton = button('', rollBack);
      this.rollBackButton.classList.add('extension-version-rollback');
      this.rollBackButton.title = t('rollBackTooltip');
      const previousRow = row(this.previousText, this.rollBackButton);
      previousRow.classList.add('extension-version-previous');
      this.previousRow = previousRow;
      children.push(previousRow);
    }
    children.push(row(this.checkButton, this.installButton, this.statusText));
    container.append(...children);
  }

  render(status: ExtensionStatus, note: string | undefined): void {
    const { running, managed, activity } = status;
    this.current.textContent = running ? t('inUse', running.version) : t('notFound');
    this.source.textContent = running ? sourceText(running) : '';
    this.source.hidden = !running;
    this.path.textContent = running?.path ?? '';
    this.path.hidden = !running;

    const pending = managed.pending;
    this.pendingRow.hidden = pending === undefined;
    this.pendingText.textContent = pending === undefined ? '' : t('pending', pending);

    const idle = activity.kind === 'idle';
    for (const button of [this.checkButton, this.installButton]) {
      button.disabled = !idle || !status.updatesApply;
    }
    if (this.previousRow !== undefined && this.previousText !== undefined && this.rollBackButton !== undefined) {
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
      this.rollBackButton.disabled = !idle || !status.updatesApply || !target;
    }
    this.statusText.textContent = activityText(activity) ?? note ?? (status.lastCheck ? (resultText(status.lastCheck) ?? '') : '');
  }
}
