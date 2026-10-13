/**
 * A bar above a conversation's message input when the conversation last ran under another
 * API provider than the window uses now (going on with another provider can fail: one
 * provider's replies are not always what another takes back). It offers to switch the window
 * to that provider and open the conversation again; "Ignore" hides it for this page.
 */

import type { ProviderNoticeDto } from '../../platform/protocol';

const NOTICE_CLASS = 'vilaus-provider-notice';

export class ProviderNotice {
  private notice: ProviderNoticeDto | null = null;
  private dismissed = false;
  private readonly root: HTMLElement;
  private readonly text: HTMLElement;
  private readonly switchButton: HTMLButtonElement;
  private readonly ignoreButton: HTMLButtonElement;
  /** Watches the page while the bar shows, to keep it in place as the page renders. */
  private observer: MutationObserver | undefined;

  constructor(
    /** CSS selector of the message input's form: the bar goes right before what is before it. */
    private readonly anchor: string,
    onSwitch: (notice: ProviderNoticeDto) => void,
  ) {
    this.root = document.createElement('div');
    this.root.className = NOTICE_CLASS;
    this.root.setAttribute('role', 'status');
    this.text = document.createElement('span');
    this.text.className = `${NOTICE_CLASS}-text`;
    this.switchButton = document.createElement('button');
    this.switchButton.type = 'button';
    this.switchButton.className = `${NOTICE_CLASS}-switch`;
    this.switchButton.addEventListener('click', () => {
      if (this.notice?.switchTo) {
        onSwitch(this.notice);
      }
    });
    this.ignoreButton = document.createElement('button');
    this.ignoreButton.type = 'button';
    this.ignoreButton.className = `${NOTICE_CLASS}-ignore`;
    this.ignoreButton.addEventListener('click', () => {
      this.dismissed = true;
      this.place();
    });
    this.root.append(this.text, this.switchButton, this.ignoreButton);
    // Clicks and keys here are the shell's, not the conversation's.
    for (const type of ['click', 'mousedown', 'keydown']) {
      this.root.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  set(notice: ProviderNoticeDto | null): void {
    this.notice = notice;
    this.dismissed = false;
    if (notice) {
      this.text.textContent = notice.text;
      this.switchButton.textContent = notice.switchLabel ?? '';
      this.switchButton.hidden = !notice.switchTo;
      this.ignoreButton.textContent = notice.ignoreLabel;
    }
    this.place();
  }

  /**
   * Above the comment blocks, which sit right before the input's form; out of the page while
   * there is no notice or no input.
   */
  private place(): void {
    if (!this.notice || this.dismissed) {
      this.root.remove();
      this.observer?.disconnect();
      this.observer = undefined;
      return;
    }
    if (!this.observer) {
      this.observer = new MutationObserver(() => this.place());
      this.observer.observe(document.body, { subtree: true, childList: true });
    }
    const form = document.querySelector(this.anchor);
    if (!form?.parentElement) {
      this.root.remove();
      return;
    }
    let before: Element = form;
    while (before.previousElementSibling?.classList.contains('vilaus-comments')) {
      before = before.previousElementSibling;
    }
    if (before.previousElementSibling !== this.root) {
      form.parentElement.insertBefore(this.root, before);
    }
  }
}
