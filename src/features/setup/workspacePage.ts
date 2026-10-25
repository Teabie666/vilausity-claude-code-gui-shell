/**
 * The setup guide's third page (M6.7): the folder this window has open, which Claude reads
 * and writes files and runs commands in. Finish switches the window to another folder,
 * which loads the page again; when the guide was automatic, the quick start is deferred to
 * main first so it follows the reload.
 */

import type { NativeApi } from '../../core/native';
import { INative, IKeybindings } from '../../core/serviceIds';
import { t } from './messages';
import type { GuideContext, GuidePage, GuidePageFactory } from './page';

/** Windows accepts both separators, and a trailing one does not make another folder. */
function normalize(folder: string): string {
  return folder.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

class WorkspacePage implements GuidePage {
  readonly element: HTMLElement;
  readonly title: string = t('wsTitle');
  readonly canSkip = true;
  readonly canGoOn = true;

  private readonly context: GuideContext;
  private readonly native: NativeApi;
  private readonly input: HTMLInputElement;
  private readonly hint: HTMLElement;
  private readonly status: HTMLElement;
  /** The window's folder now, and the user's home folder: normalised, '' until main answers. */
  private current = '';
  private home = '';
  private edited = false;
  private readonly ready: Promise<void>;

  constructor(context: GuideContext) {
    this.context = context;
    this.native = context.services.get(INative);
    const doc = context.doc;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] => {
      const node = doc.createElement(tag);
      node.className = className;
      node.textContent = text;
      return node;
    };

    // The title bar's search box shows the workspace; Ctrl+R (or the user's key) changes it.
    const recent = context.services.tryGet(IKeybindings)?.labelFor('workspace.openRecent') ?? 'Ctrl+R';

    this.element = element('div', 'setup-page-body setup-workspace');
    this.element.append(
      element('h2', 'setup-page-title', t('wsTitle')),
      element('p', 'setup-text', t('wsIntro')),
      element('p', 'setup-text', t('wsChange', recent)),
    );

    const row = element('div', 'setup-folder-row');
    this.input = element('input', 'setting-input setup-folder');
    this.input.type = 'text';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', t('wsFolder'));
    this.input.addEventListener('input', () => {
      this.edited = true;
      this.status.textContent = '';
      this.updateHint();
    });
    const browse = element('button', 'button secondary setup-browse', t('wsBrowse'));
    browse.type = 'button';
    browse.addEventListener('click', () => void this.browse());
    row.append(this.input, browse);

    this.hint = element('div', 'setup-hint', t('wsHomeHint'));
    this.hint.hidden = true;
    this.status = element('div', 'setup-status');
    this.status.setAttribute('role', 'status');
    this.element.append(row, this.hint, this.status);

    this.ready = this.native.call('app.getInitData', undefined).then(
      (init) => {
        const folder = init.workspaceFolders[0] ?? init.homeFolder;
        this.current = normalize(folder);
        this.home = normalize(init.homeFolder);
        // A page shown earlier may already have typed in it.
        if (!this.edited) {
          this.input.value = folder;
        }
        this.updateHint();
      },
      (error: unknown) => context.logger.error('reading the workspace folder failed', error),
    );
  }

  async goOn(): Promise<boolean> {
    await this.ready;
    const folder = this.input.value.trim();
    if (normalize(folder) === this.current) {
      return true;
    }
    if (!folder) {
      this.status.textContent = t('wsNotFound');
      return false;
    }
    const shown = await this.native.call('window.shownFolders', undefined);
    if (shown.some((candidate) => normalize(candidate) === normalize(folder))) {
      this.status.textContent = t('wsOpenedElsewhere');
      return false;
    }
    if (this.context.automatic) {
      // The window loads again below: the quick start waits for the page after it.
      await this.native.call('onboarding.defer', { step: 'quickStart' });
    }
    const opened = await this.native.call('window.openFolder', { folder, newWindow: false });
    this.status.textContent = opened ? '' : t('wsNotFound');
    return false;
  }

  show(): void {
    // The window's folder cannot change while this page is up.
  }

  focus(): void {
    this.input.focus();
  }

  dispose(): void {
    this.element.remove();
  }

  private updateHint(): void {
    const folder = normalize(this.input.value);
    this.hint.hidden = folder === '' || folder !== this.home;
  }

  private async browse(): Promise<void> {
    try {
      const picked = await this.native.call('window.pickFolder', undefined);
      if (picked) {
        this.edited = true;
        this.input.value = picked;
        this.status.textContent = '';
        this.updateHint();
      }
    } catch (error) {
      this.context.logger.error('picking a folder failed', error);
    }
  }
}

export const workspacePage: GuidePageFactory = (context) => new WorkspacePage(context);
