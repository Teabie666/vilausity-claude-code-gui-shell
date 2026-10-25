/**
 * The quick start tab's view (features/quickStart): the safety notes and the groups of steps,
 * drawn as plain DOM, no framework. It remembers each step's tick box, count and shortcut rows,
 * so that ticking one off or the shortcuts changing updates them in place: rebuilding the page
 * would lose its scroll position and the focused button. Running a step's button is the pane's
 * business (onTry); this class only draws, reports, and keeps which step is open.
 */

import type { IDisposable } from '../../platform/lifecycle';
import { t } from './messages';
import type { QuickStartGroup, QuickStartStep } from './steps';

export interface QuickStartViewOptions {
  readonly groups: readonly QuickStartGroup[];
  /** The command's current shortcut ("Ctrl+P"); undefined when it has none. */
  readonly keyFor: (command: string) => string | undefined;
  /** The command's title as the palette shows it ("View: Show Statistics"); undefined when unknown. */
  readonly commandTitle: (command: string) => string | undefined;
  /** The step's button was pressed (the pane runs the action and ticks the step off). */
  readonly onTry: (step: QuickStartStep) => void;
  /** Ticked off or cleared by hand. */
  readonly onToggle: (step: QuickStartStep, done: boolean) => void;
}

/** One step's elements that change after it is drawn (setDone, refreshKeys). */
interface StepView {
  readonly step: QuickStartStep;
  readonly item: HTMLLIElement;
  readonly check: HTMLButtonElement;
  readonly title: HTMLButtonElement;
  readonly body: HTMLElement;
  /** The `<kbd>` of each command in `step.keys`, in the same order. */
  readonly kbd: readonly HTMLElement[];
}

interface GroupView {
  readonly group: QuickStartGroup;
  readonly count: HTMLElement;
  readonly steps: readonly StepView[];
}

export class QuickStartView implements IDisposable {
  private readonly options: QuickStartViewOptions;
  private readonly doc: Document;
  private readonly root: HTMLElement;
  private readonly groups: GroupView[] = [];
  private done: ReadonlySet<string> = new Set();
  private expanded: StepView | undefined;
  /** The first setDone picked the step to open; later ones leave it open. */
  private picked = false;

  constructor(container: HTMLElement, options: QuickStartViewOptions) {
    this.options = options;
    this.doc = container.ownerDocument;
    this.root = this.el('div', 'quick-start');
    const content = this.el('div', 'quick-start-content');

    const heading = this.el('h1', 'quick-start-heading');
    heading.textContent = t('heading');
    const intro = this.el('p', 'quick-start-intro');
    intro.textContent = t('intro');

    content.append(heading, intro, this.safety(), ...options.groups.map((group) => this.groupElement(group)));
    this.root.append(content);
    container.append(this.root);
  }

  /** The steps ticked off: their marks and the groups' counts follow. */
  setDone(done: ReadonlySet<string>): void {
    this.done = done;
    for (const group of this.groups) {
      for (const view of group.steps) {
        this.markStep(view);
      }
      this.updateCount(group);
    }
    if (!this.picked) {
      this.picked = true;
      // The first step of the first group not closed, that is not ticked off yet.
      this.expand(
        this.groups
          .filter((group) => group.group.collapsed !== true)
          .flatMap((group) => group.steps)
          .find((view) => !done.has(view.step.id)),
      );
    }
  }

  /** The shortcuts changed: the rows of every step show the new ones. */
  refreshKeys(): void {
    for (const group of this.groups) {
      for (const view of group.steps) {
        this.refreshKeysOf(view);
      }
    }
  }

  relocate(container: HTMLElement): void {
    container.append(this.root);
  }

  dispose(): void {
    this.root.remove();
  }

  /* -- building blocks -- */

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
    const element = this.doc.createElement(tag);
    if (className !== undefined) {
      element.className = className;
    }
    return element;
  }

  private button(className: string): HTMLButtonElement {
    const button = this.el('button', className);
    button.type = 'button';
    return button;
  }

  private safety(): HTMLElement {
    const section = this.el('section', 'quick-start-safety');
    section.setAttribute('role', 'note');
    const title = this.el('h2', 'quick-start-safety-title');
    title.textContent = t('safetyTitle');
    const list = this.el('ul');
    for (const key of ['safety1', 'safety2', 'safety3', 'safety4'] as const) {
      const item = this.el('li');
      item.textContent = t(key);
      list.append(item);
    }
    section.append(title, list);
    return section;
  }

  private groupElement(group: QuickStartGroup): HTMLElement {
    const section = this.el('section', 'quick-start-group');
    const header = this.el('h2', 'quick-start-group-header');
    const name = this.el('span', 'quick-start-group-title');
    name.textContent = group.title();
    const count = this.el('span', 'quick-start-count');
    const list = this.el('ol', 'quick-start-steps');
    const steps = group.steps.map((step) => this.stepElement(step, list));

    if (group.collapsed === true) {
      // The whole header row is the button. Where a group stands is not saved.
      const toggle = this.button('quick-start-group-toggle');
      toggle.append(name, count);
      toggle.title = t('showGroup');
      toggle.setAttribute('aria-expanded', 'false');
      list.hidden = true;
      toggle.addEventListener('click', () => {
        list.hidden = !list.hidden;
        toggle.setAttribute('aria-expanded', String(!list.hidden));
        toggle.title = list.hidden ? t('showGroup') : t('hideGroup');
      });
      header.append(toggle);
    } else {
      header.append(name, count);
    }

    const description = this.el('p', 'quick-start-group-description');
    description.textContent = group.description();
    section.append(header, description, list);

    const view: GroupView = { group, count, steps };
    this.groups.push(view);
    this.updateCount(view);
    return section;
  }

  private stepElement(step: QuickStartStep, list: HTMLElement): StepView {
    const item = this.el('li', 'quick-start-step');
    item.dataset.step = step.id;
    const header = this.el('div', 'quick-start-step-header');

    const check = this.button('quick-start-check');
    const title = this.button('quick-start-step-title');
    title.setAttribute('aria-expanded', 'false');
    const titleText = this.el('span', 'quick-start-step-title-text');
    titleText.textContent = step.title();
    title.append(titleText);
    header.append(check, title);

    const body = this.el('div', 'quick-start-step-body');
    for (const paragraph of step.body().split('\n\n')) {
      // A single newline inside a paragraph is just a space between its words.
      const text = paragraph
        .split('\n')
        .map((line) => line.trim())
        .join(' ')
        .trim();
      if (text !== '') {
        const line = this.el('p');
        line.textContent = text;
        body.append(line);
      }
    }

    const kbd: HTMLElement[] = [];
    if (step.keys !== undefined && step.keys.length > 0) {
      const keys = this.el('div', 'quick-start-keys');
      for (const command of step.keys) {
        const row = this.el('div', 'quick-start-key-row');
        const name = this.el('span', 'quick-start-key-command');
        name.textContent = this.options.commandTitle(command) ?? command;
        const key = this.el('kbd', 'quick-start-kbd');
        row.append(name, key);
        keys.append(row);
        kbd.push(key);
      }
      body.append(keys);
    }

    if (step.action !== undefined) {
      const tryButton = this.button('button quick-start-try');
      tryButton.textContent = step.action.label();
      tryButton.addEventListener('click', () => this.options.onTry(step));
      body.append(tryButton);
    }

    const view: StepView = { step, item, check, title, body, kbd };
    body.hidden = true;
    item.append(header, body);
    list.append(item);

    // Ticking is its own button: it does not open or close the step.
    check.addEventListener('click', () => this.options.onToggle(step, !this.done.has(step.id)));
    title.addEventListener('click', () => this.expand(this.expanded === view ? undefined : view));

    this.markStep(view);
    this.refreshKeysOf(view);
    return view;
  }

  private expand(target: StepView | undefined): void {
    this.expanded = target;
    for (const group of this.groups) {
      for (const view of group.steps) {
        const open = view === target;
        view.item.classList.toggle('expanded', open);
        view.body.hidden = !open;
        view.title.setAttribute('aria-expanded', String(open));
      }
    }
  }

  private markStep(view: StepView): void {
    const done = this.done.has(view.step.id);
    view.item.classList.toggle('done', done);
    view.check.setAttribute('aria-pressed', String(done));
    // The button has no text of its own: the tick is drawn by its background mask.
    const label = done ? t('markNotDone') : t('markDone');
    view.check.title = label;
    view.check.setAttribute('aria-label', label);
  }

  private refreshKeysOf(view: StepView): void {
    const commands = view.step.keys ?? [];
    commands.forEach((command, index) => {
      const key = view.kbd[index];
      if (key === undefined) {
        return;
      }
      const label = this.options.keyFor(command);
      key.textContent = label ?? t('noShortcut');
      key.classList.toggle('missing', label === undefined);
    });
  }

  private updateCount(group: GroupView): void {
    const done = group.steps.filter((view) => this.done.has(view.step.id)).length;
    group.count.textContent = t('progress', done, group.steps.length);
  }
}
