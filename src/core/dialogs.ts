/**
 * Implements the extension's `window.showXxxMessage`, `showQuickPick` and `showInputBox`
 * with shell-drawn UI in VS Code's visual language (theme colors and corners).
 */

import type { InputBoxRequest, MessageRequest, QuickPickItemDto, QuickPickRequest } from '../platform/protocol';
import { t } from './messages';

const TOAST_TIMEOUT_MS = 10_000;

/** Shell-side options of a quick pick (the extension's pickers use the defaults). */
export interface QuickPickOptions {
  /**
   * Scores an item against the typed text; higher sorts first, undefined hides the item.
   * Default: case-insensitive substring match in list order.
   */
  readonly score?: (item: QuickPickItemDto, query: string) => number | undefined;
  /** Renders at most this many items. */
  readonly limit?: number;
  /**
   * The item's other action (Ctrl+Enter, Ctrl+click), e.g. "open in a new window". The
   * picker then closes with no selection.
   */
  readonly alternate?: (index: number) => void;
}

export class Dialogs {
  private readonly toasts: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    /** The left of a quick input box `width` wide (core/layout.ts); centered in the window without it. */
    private readonly quickInputLeft?: (width: number) => number,
  ) {
    this.toasts = document.createElement('div');
    this.toasts.className = 'toasts';
    root.appendChild(this.toasts);
  }

  showMessage(request: MessageRequest): Promise<number | undefined> {
    return request.modal ? this.showModal(request) : this.showToast(request);
  }

  showQuickPick(request: QuickPickRequest, options: QuickPickOptions = {}): Promise<number[] | undefined> {
    return new Promise((resolve) => {
      const { box, finish } = this.openOverlay<number[] | undefined>(resolve, undefined, { quickInput: true });
      const input = document.createElement('input');
      input.className = 'quick-input-filter';
      input.placeholder = request.placeHolder ?? request.title ?? '';
      const list = document.createElement('div');
      list.className = 'quick-input-list';
      list.setAttribute('role', 'listbox');
      box.append(input, list);

      const picked = new Set<number>(request.items.flatMap((item, index) => (item.picked ? [index] : [])));
      let visible: number[] = [];
      let cursor = 0;

      const render = (): void => {
        const filter = input.value.trim().toLowerCase();
        const score = options.score;
        if (score && filter) {
          visible = request.items
            .flatMap((item, index) => {
              const value = item.separator ? undefined : score(item, filter);
              return value === undefined ? [] : [{ index, value }];
            })
            .sort((a, b) => b.value - a.value)
            .map(({ index }) => index);
        } else {
          visible = request.items.flatMap((item, index) => {
            if (item.separator) {
              return filter ? [] : [index];
            }
            const text = `${item.label} ${item.description ?? ''} ${item.detail ?? ''}`.toLowerCase();
            return !filter || text.includes(filter) ? [index] : [];
          });
        }
        if (options.limit !== undefined) {
          visible = visible.slice(0, options.limit);
        }
        cursor = Math.max(0, Math.min(cursor, visible.length - 1));
        list.replaceChildren(
          ...visible.map((index, position) => {
            const item = request.items[index]!;
            const row = document.createElement('div');
            if (item.separator) {
              row.className = 'quick-input-separator';
              row.textContent = item.label;
              return row;
            }
            row.className = 'quick-input-item';
            row.setAttribute('role', 'option');
            row.classList.toggle('focused', position === cursor);
            if (request.canPickMany) {
              const check = document.createElement('input');
              check.type = 'checkbox';
              check.checked = picked.has(index);
              check.tabIndex = -1;
              row.appendChild(check);
            }
            const label = document.createElement('span');
            label.className = 'quick-input-label';
            label.textContent = item.label;
            row.appendChild(label);
            if (item.description) {
              const description = document.createElement('span');
              description.className = 'quick-input-description';
              description.textContent = item.description;
              row.appendChild(description);
            }
            if (item.detail) {
              const detail = document.createElement('div');
              detail.className = 'quick-input-detail';
              detail.textContent = item.detail;
              row.appendChild(detail);
            }
            row.addEventListener('mousedown', (event) => {
              event.preventDefault();
              cursor = position;
              choose(event.ctrlKey);
            });
            return row;
          }),
        );
      };

      const choose = (alternate = false): void => {
        const index = visible[cursor];
        if (index === undefined || request.items[index]?.separator) {
          return;
        }
        if (alternate && options.alternate && !request.canPickMany) {
          finish(undefined);
          options.alternate(index);
          return;
        }
        if (request.canPickMany) {
          if (picked.has(index)) {
            picked.delete(index);
          } else {
            picked.add(index);
          }
          render();
        } else {
          finish([index]);
        }
      };

      input.addEventListener('input', () => {
        cursor = 0;
        render();
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
          cursor = Math.min(cursor + 1, visible.length - 1);
          render();
          event.preventDefault();
        } else if (event.key === 'ArrowUp') {
          cursor = Math.max(cursor - 1, 0);
          render();
          event.preventDefault();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          if (request.canPickMany) {
            finish([...picked].sort((a, b) => a - b));
          } else {
            choose(event.ctrlKey);
          }
        }
      });
      render();
      input.focus();
    });
  }

  showInputBox(request: InputBoxRequest): Promise<string | undefined> {
    return new Promise((resolve) => {
      const { box, finish } = this.openOverlay<string | undefined>(resolve, undefined, { quickInput: true });
      if (request.title) {
        const title = document.createElement('div');
        title.className = 'quick-input-title';
        title.textContent = request.title;
        box.appendChild(title);
      }
      const input = document.createElement('input');
      input.className = 'quick-input-filter';
      input.type = request.password ? 'password' : 'text';
      input.value = request.value ?? '';
      input.placeholder = request.placeHolder ?? '';
      box.appendChild(input);
      if (request.validationMessage) {
        input.classList.add('invalid');
        const validation = document.createElement('div');
        validation.className = 'quick-input-validation';
        validation.setAttribute('role', 'alert');
        validation.textContent = request.validationMessage;
        box.appendChild(validation);
      }
      if (request.prompt) {
        const prompt = document.createElement('div');
        prompt.className = 'quick-input-message';
        prompt.textContent = t('inputBoxHint', request.prompt);
        box.appendChild(prompt);
      }
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(input.value);
        }
      });
      input.focus();
      input.select();
    });
  }

  private showToast(request: MessageRequest): Promise<number | undefined> {
    return new Promise((resolve) => {
      const toast = document.createElement('div');
      toast.className = `toast toast-${request.severity}`;
      toast.setAttribute('role', request.severity === 'error' ? 'alert' : 'status');
      let settled = false;
      const finish = (value: number | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        toast.remove();
        resolve(value);
      };
      const text = document.createElement('div');
      text.className = 'toast-message';
      text.textContent = request.message;
      const close = document.createElement('button');
      close.className = 'toast-close icon-button';
      close.title = t('close');
      close.addEventListener('click', () => finish(undefined));
      toast.append(text, close);
      if (request.items.length > 0) {
        const actions = document.createElement('div');
        actions.className = 'toast-actions';
        request.items.forEach((item, index) => {
          const button = document.createElement('button');
          button.className = 'button';
          button.textContent = item;
          button.addEventListener('click', () => finish(index));
          actions.appendChild(button);
        });
        toast.appendChild(actions);
      }
      this.toasts.appendChild(toast);
      // Messages with actions stay until answered, like VS Code notifications.
      const timer = request.items.length === 0 ? setTimeout(() => finish(undefined), TOAST_TIMEOUT_MS) : undefined;
    });
  }

  private showModal(request: MessageRequest): Promise<number | undefined> {
    return new Promise((resolve) => {
      const { box, finish } = this.openOverlay<number | undefined>(resolve, undefined);
      box.classList.add('modal');
      const message = document.createElement('div');
      message.className = 'modal-message';
      message.textContent = request.message;
      box.appendChild(message);
      if (request.detail) {
        const detail = document.createElement('div');
        detail.className = 'modal-detail';
        detail.textContent = request.detail;
        box.appendChild(detail);
      }
      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const items = request.items.length > 0 ? request.items : [t('ok')];
      items.forEach((item, index) => {
        const button = document.createElement('button');
        button.className = index === 0 ? 'button' : 'button secondary';
        button.textContent = item;
        button.addEventListener('click', () => finish(request.items.length > 0 ? index : undefined));
        actions.appendChild(button);
      });
      const cancel = document.createElement('button');
      cancel.className = 'button secondary';
      cancel.textContent = t('cancel');
      cancel.addEventListener('click', () => finish(undefined));
      if (request.items.length > 0) {
        actions.appendChild(cancel);
      }
      box.appendChild(actions);
      (actions.querySelector('button') as HTMLButtonElement | null)?.focus();
    });
  }

  /**
   * A box at the top of the window over a backdrop; Escape or a backdrop click resolves
   * `cancelValue`. Quick access draws its picker in one too. A quick input box sits over the
   * title bar's search box (`quickInputLeft`), following it as the window resizes.
   */
  openOverlay<T>(
    resolve: (value: T) => void,
    cancelValue: T,
    options: { readonly quickInput?: boolean } = {},
  ): { box: HTMLElement; finish: (value: T) => void } {
    const backdrop = document.createElement('div');
    backdrop.className = 'overlay-backdrop';
    const box = document.createElement('div');
    box.className = 'overlay-box';
    backdrop.appendChild(box);
    const quickInputLeft = options.quickInput ? this.quickInputLeft : undefined;
    const place = (): void => {
      if (quickInputLeft) {
        backdrop.style.justifyContent = 'flex-start';
        box.style.marginLeft = `${quickInputLeft(box.offsetWidth)}px`;
      }
    };
    if (options.quickInput) {
      box.classList.add('quick-input');
      window.addEventListener('resize', place);
    }
    let settled = false;
    const finish = (value: T): void => {
      if (settled) {
        return;
      }
      settled = true;
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
      resolve(value);
    };
    const onKey = (event: KeyboardEvent): void => {
      // Only the top one: an overlay can open over another (a question over the settings).
      const top = [...this.root.children].findLast((child) => child.classList.contains('overlay-backdrop'));
      if (event.key === 'Escape' && !event.defaultPrevented && top === backdrop) {
        event.preventDefault();
        finish(cancelValue);
      }
    };
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) {
        finish(cancelValue);
      }
    });
    this.root.appendChild(backdrop);
    place();
    return { box, finish };
  }
}
