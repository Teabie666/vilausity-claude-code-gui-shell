/**
 * A settings file beside its defaults, as VS Code can show settings.json: on the left, read
 * only, what applies where the file says nothing (generated text); on the right, the file in
 * the text editor, which this pane embeds. A sash between them sets the widths; the defaults
 * can be hidden. Both are remembered per kind of file.
 */

import type { EditorHost, EditorInput, EditorPane, EditorSelectionContext } from '../../core/editors';
import type { Event } from '../../platform/event';
import { DisposableStore } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import type { RangeDto } from '../../platform/protocol';
import type { TextEditorService, TextViewer } from './index';
import { t } from './messages';
import type { TextEditorPane } from './textEditorPane';

export interface DefaultsSplitOptions {
  /** A URI of its own for the defaults' generated document. */
  readonly defaultsUri: string;
  /** The left side's title, e.g. "Default Settings (read only)". */
  readonly defaultsTitle: string;
  readonly defaultsText: () => string;
  /** The defaults changed (more were declared): the text is asked for again. */
  readonly onDidChangeDefaults?: Event<void>;
  /** Where the width and whether the defaults show are remembered (localStorage). */
  readonly stateKey: string;
}

interface SplitState {
  readonly hidden: boolean;
  /** The defaults' share of the width. */
  readonly ratio: number;
}

interface Skeleton {
  readonly side: HTMLElement;
  readonly sideBody: HTMLElement;
  readonly sash: HTMLElement;
  /** The text editor goes in here, below the header. */
  readonly main: HTMLElement;
  readonly toggle: HTMLButtonElement;
}

export class DefaultsSplitPane implements EditorPane {
  private readonly text: TextEditorPane;
  private viewer: TextViewer | undefined;
  private skeleton: Skeleton;
  private state: SplitState;
  private disposed = false;
  private readonly disposables = new DisposableStore();
  readonly onDidChangeTextEditors: Event<void>;

  constructor(
    private container: HTMLElement,
    private readonly input: EditorInput,
    host: EditorHost,
    editors: TextEditorService,
    private readonly options: DefaultsSplitOptions,
    logger: ILogger,
  ) {
    this.state = readState(options.stateKey);
    this.skeleton = this.build(container);
    this.text = editors.createPane(this.skeleton.main, input, host);
    this.onDidChangeTextEditors = this.text.onDidChangeTextEditors;
    editors.createViewer(this.skeleton.sideBody, options.defaultsUri, options.defaultsText, 'json').then(
      (viewer) => {
        if (this.disposed) {
          viewer.dispose();
        } else {
          this.viewer = viewer;
        }
      },
      (error: unknown) => logger.error(`showing the defaults of ${input.label} failed`, error),
    );
    if (options.onDidChangeDefaults) {
      this.disposables.add(options.onDidChangeDefaults(() => this.viewer?.setText(options.defaultsText())));
    }
  }

  get textEditorIds(): readonly string[] {
    return this.text.textEditorIds;
  }

  layout(): void {
    this.text.layout();
  }

  setVisible(): void {}

  focus(): void {
    this.text.focus();
  }

  confirmClose(): Promise<boolean> {
    return this.text.confirmClose();
  }

  selectionContext(): EditorSelectionContext | undefined {
    return this.text.selectionContext();
  }

  revealSelection(uri: string, range: RangeDto): boolean {
    return this.text.revealSelection(uri, range);
  }

  /** Both sides into `container` (e.g. a tab's own window): new widgets, same documents. */
  relocate(container: HTMLElement): void {
    const previous = this.skeleton;
    this.container.classList.remove('defaults-split');
    this.container = container;
    this.skeleton = this.build(container);
    this.text.relocate(this.skeleton.main);
    this.viewer?.relocate(this.skeleton.sideBody);
    for (const element of [previous.side, previous.sash, previous.main]) {
      element.remove();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.disposables.dispose();
    this.viewer?.dispose();
    this.text.dispose();
  }

  private build(container: HTMLElement): Skeleton {
    const doc = container.ownerDocument;
    const element = (className: string): HTMLElement => {
      const created = doc.createElement('div');
      created.className = className;
      return created;
    };
    container.classList.add('defaults-split');
    const side = element('defaults-split-side');
    const sideHeader = element('editor-toolbar defaults-split-header');
    const sideTitle = doc.createElement('span');
    sideTitle.className = 'editor-toolbar-spacer';
    sideTitle.textContent = this.options.defaultsTitle;
    sideHeader.append(sideTitle);
    const sideBody = element('editor-body');
    side.append(sideHeader, sideBody);

    const sash = element('sash defaults-split-sash');
    this.trackSash(sash, side, container);

    const column = element('defaults-split-column');
    const header = element('editor-toolbar defaults-split-header');
    const title = doc.createElement('span');
    title.className = 'editor-toolbar-spacer';
    title.textContent = this.input.label;
    const toggle = doc.createElement('button');
    toggle.className = 'button secondary';
    toggle.addEventListener('click', () => this.setState({ ...this.state, hidden: !this.state.hidden }));
    header.append(title, toggle);
    const main = element('defaults-split-main');
    column.append(header, main);

    container.append(side, sash, column);
    const skeleton: Skeleton = { side, sideBody, sash, main: main, toggle };
    this.apply(skeleton);
    return skeleton;
  }

  private apply(skeleton: Skeleton = this.skeleton): void {
    skeleton.side.hidden = this.state.hidden;
    skeleton.sash.hidden = this.state.hidden;
    skeleton.side.style.flexBasis = `${(this.state.ratio * 100).toFixed(2)}%`;
    skeleton.toggle.textContent = this.state.hidden ? t('showDefaults') : t('hideDefaults');
  }

  private setState(state: SplitState): void {
    this.state = state;
    this.apply();
    writeState(this.options.stateKey, state);
  }

  /** Dragging sets the defaults' share of the width; a double click halves it again. */
  private trackSash(sash: HTMLElement, side: HTMLElement, container: HTMLElement): void {
    sash.addEventListener('pointerdown', (start) => {
      start.preventDefault();
      sash.setPointerCapture(start.pointerId);
      const doc = sash.ownerDocument;
      doc.body.classList.add('resizing');
      const bounds = container.getBoundingClientRect();
      const startWidth = side.getBoundingClientRect().width;
      const onMove = (event: PointerEvent): void => {
        const width = Math.min(Math.max(startWidth + event.clientX - start.clientX, 120), bounds.width - 120);
        this.state = { ...this.state, ratio: width / bounds.width };
        this.apply();
      };
      const onUp = (): void => {
        sash.removeEventListener('pointermove', onMove);
        sash.removeEventListener('pointerup', onUp);
        doc.body.classList.remove('resizing');
        writeState(this.options.stateKey, this.state);
      };
      sash.addEventListener('pointermove', onMove);
      sash.addEventListener('pointerup', onUp);
    });
    sash.addEventListener('dblclick', () => this.setState({ ...this.state, ratio: 0.5 }));
  }
}

function readState(key: string): SplitState {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<SplitState>;
    const ratio = typeof stored.ratio === 'number' && stored.ratio > 0.1 && stored.ratio < 0.9 ? stored.ratio : 0.5;
    return { hidden: stored.hidden === true, ratio };
  } catch {
    return { hidden: false, ratio: 0.5 };
  }
}

function writeState(key: string, state: SplitState): void {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Not remembered: the next tab starts as the defaults say.
  }
}
