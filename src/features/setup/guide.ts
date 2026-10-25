/**
 * The setup guide (M6.7): a new version's first run, over the main area. The steps above
 * say where the user is (earlier pages can be returned to); the pages are all made in
 * order when the guide opens, one shows at a time, and Back / Skip This Page / Next
 * (Finish on the last page) walk through them. A page's Next saves what it set (goOn);
 * Skip moves on without asking.
 */

import type { ServiceRegistry } from '../../core/services';
import type { IDisposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import { t } from './messages';
import type { GuideContext, GuidePage, GuidePageFactory } from './page';

/** How the guide is opened, and what it hands its pages. */
export interface SetupGuideOptions {
  readonly services: ServiceRegistry;
  readonly logger: ILogger;
  /** Opened by a new version (main's onboarding); handed to the pages. */
  readonly automatic: boolean;
  readonly pages: readonly GuidePageFactory[];
  /** The guide closed: finished, skipped to the end, or exited. */
  readonly onClose: () => void;
}

/** The shell around the pages: the steps, the page, the buttons. */
export class SetupGuide implements IDisposable {
  private readonly options: SetupGuideOptions;
  private readonly pages: GuidePage[];
  private readonly root: HTMLElement;
  private readonly content: HTMLElement;
  private readonly steps: HTMLButtonElement[] = [];
  private readonly back: HTMLButtonElement;
  private readonly skip: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly exit: HTMLAnchorElement;
  private index = 0;
  /** The page reached furthest: the steps before it can be returned to. */
  private furthest = 0;
  /** Next is running a page's goOn: the bottom buttons wait. */
  private busy = false;
  private closed = false;
  /** The DOM is in place: a page made before that can ask for its buttons to be updated. */
  private built = false;

  constructor(container: HTMLElement, options: SetupGuideOptions) {
    this.options = options;
    const doc = container.ownerDocument;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] => {
      const node = doc.createElement(tag);
      node.className = className;
      node.textContent = text;
      return node;
    };
    const context: GuideContext = {
      services: options.services,
      logger: options.logger,
      doc,
      automatic: options.automatic,
      changed: () => this.updateButtons(),
      next: () => this.advance(),
    };
    this.pages = options.pages.map((make) => make(context));

    this.root = element('div', 'setup-guide');
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', t('guideLabel'));

    const header = element('header', 'setup-guide-header');
    const list = element('ol', 'setup-steps');
    this.pages.forEach((page, position) => {
      const item = element('li', 'setup-steps-item');
      const button = element('button', 'setup-step');
      button.type = 'button';
      button.append(element('span', 'setup-step-number', String(position + 1)), element('span', 'setup-step-title', page.title));
      button.setAttribute('aria-label', t('guideStep', position + 1, this.pages.length, page.title));
      button.addEventListener('click', () => this.goTo(position));
      this.steps.push(button);
      item.appendChild(button);
      list.appendChild(item);
    });
    this.exit = element('a', 'setup-link setup-exit', t('guideExit'));
    this.exit.href = '#';
    this.exit.addEventListener('click', (event) => {
      event.preventDefault();
      this.close();
    });
    header.append(list, this.exit);

    const body = element('div', 'setup-guide-body');
    this.content = element('div', 'setup-guide-content');
    body.appendChild(this.content);

    const footer = element('footer', 'setup-guide-footer');
    this.back = element('button', 'button secondary setup-back', t('guideBack'));
    this.back.type = 'button';
    this.back.addEventListener('click', () => this.goTo(this.index - 1));
    this.skip = element('button', 'button secondary setup-skip', t('guideSkip'));
    this.skip.type = 'button';
    this.skip.addEventListener('click', () => this.advance());
    this.next = element('button', 'button setup-next', t('guideNext'));
    this.next.type = 'button';
    this.next.addEventListener('click', () => void this.onNext());
    footer.append(this.back, element('span', 'setup-footer-spacer'), this.skip, this.next);

    this.root.append(header, body, footer);
    container.appendChild(this.root);
    this.built = true;
    this.goTo(0);
  }

  focus(): void {
    if (this.closed) {
      return;
    }
    this.pages[this.index].focus();
  }

  dispose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const page of this.pages) {
      page.dispose();
    }
    this.root.remove();
  }

  /** Next: the page saves what it set; true moves on (the last page closes the guide). */
  private async onNext(): Promise<void> {
    const page = this.pages[this.index];
    if (this.closed || this.busy || page.canGoOn !== true) {
      return;
    }
    this.busy = true;
    this.updateButtons();
    let go = false;
    try {
      go = await page.goOn();
    } catch (error) {
      this.options.logger.error('a setup guide page failed to save', error);
    }
    this.busy = false;
    if (this.closed) {
      return;
    }
    if (go) {
      this.advance();
    } else {
      this.updateButtons();
    }
  }

  /** The page after this one; the last page closes the guide. */
  private advance(): void {
    if (this.closed) {
      return;
    }
    if (this.index + 1 < this.pages.length) {
      this.goTo(this.index + 1);
    } else {
      this.close();
    }
  }

  private goTo(index: number): void {
    if (this.closed || this.busy || index < 0 || index >= this.pages.length) {
      return;
    }
    this.index = index;
    this.furthest = Math.max(this.furthest, index);
    const page = this.pages[index];
    this.content.replaceChildren(page.element);
    page.show();
    page.focus();
    this.updateButtons();
  }

  private updateButtons(): void {
    if (!this.built || this.closed) {
      return;
    }
    const page = this.pages[this.index];
    const last = this.index === this.pages.length - 1;
    this.back.hidden = this.index === 0;
    this.skip.hidden = !page.canSkip;
    this.exit.hidden = !page.canSkip;
    this.next.hidden = page.canGoOn === undefined;
    this.next.textContent = last ? t('guideFinish') : t('guideNext');
    this.back.disabled = this.busy;
    this.skip.disabled = this.busy;
    this.next.disabled = this.busy || page.canGoOn === false;
    this.steps.forEach((button, position) => {
      const current = position === this.index;
      button.classList.toggle('current', current);
      button.classList.toggle('done', !current && position <= this.furthest);
      button.setAttribute('aria-current', current ? 'step' : 'false');
      // Only pages already visited can be gone back to.
      button.disabled = !current && position > this.furthest;
    });
  }

  private close(): void {
    if (this.closed) {
      return;
    }
    this.dispose();
    this.options.onClose();
  }
}
