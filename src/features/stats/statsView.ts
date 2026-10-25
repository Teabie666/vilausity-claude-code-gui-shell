/**
 * The statistics tab's view (features/stats): draws a StatsDto as plain DOM, no framework.
 * Everything that only turns numbers into text or a level is a pure function, exported at
 * the top so tests can call it without a document. The class itself builds elements with
 * `document.createElement`, as the settings editor does, and reports back to the pane through
 * the callbacks in StatsViewOptions (scope, refresh, opening a session, revealing a folder).
 */

import { formatBytes, formatInteger } from '../../platform/format';
import { getUiLanguage, htmlLang } from '../../platform/nls';
import type { ActivityGrid, CountedName, ProviderCost, StatsDto, StorageItem, StorageItemId, TranscriptStats } from '../../platform/stats';
import type { TokenCounts } from '../../platform/usage';
import { t } from './messages';

/** The scope the page is about: the calling window's folder, or every folder. */
export type StatsScope = 'all' | 'folder';

export interface StatsViewState {
  readonly loading: boolean;
  /** A failed load's message (raw), undefined when it worked. */
  readonly error: string | undefined;
  readonly data: StatsDto | undefined;
  readonly scope: StatsScope;
}

export interface StatsViewOptions {
  /** Whether the window has a folder, so "This folder" can be offered. */
  readonly hasFolder: boolean;
  readonly onScope: (scope: StatsScope) => void;
  readonly onRefresh: () => void;
  readonly onOpenSession: (sessionId: string, folder: string | undefined) => void;
  readonly onReveal: (path: string) => void;
}

/* ---- pure helpers (exported for tests) ------------------------------------ */

const INTEGER_FORMAT = new Intl.NumberFormat('en-US');
/** A book's length in characters, for "you typed about N books": The Great Gatsby, or the Three-Body trilogy. */
const GATSBY_CHARS = 270_000;
const SAN_TI_CHARS = 880_000;
const PAGE_TOKENS = 1_000;
const CODE_PAGE_LINES = 50;
const DRINK_PRICE: Readonly<Record<'CNY' | 'USD', number>> = { CNY: 15, USD: 5 };

/** A fun-conversion count: an integer, or one decimal below 100, thousands above 1000. */
export function formatFactor(value: number): string {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  if (value >= 1000) {
    return INTEGER_FORMAT.format(rounded);
  }
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** A price: two decimals, the symbol is the caller's (CNY ¥, USD $). */
export function formatCost(value: number): string {
  return value.toFixed(2);
}

/** The heatmap's five steps for one cell, 0 = nothing, 4 = the busiest. */
export function heatLevel(count: number, max: number): number {
  if (count <= 0 || max <= 0) {
    return 0;
  }
  return Math.max(1, Math.min(4, Math.round((count / max) * 4)));
}

export function totalTokens(tokens: TokenCounts): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/** The formatted count for a fun conversion, or undefined below 0.1 ("don't show it"). */
function factorOf(value: number): string | undefined {
  return value < 0.1 ? undefined : formatFactor(value);
}

export function funTypedChars(chars: number, language: 'en' | 'zh-cn'): string | undefined {
  return factorOf(chars / (language === 'zh-cn' ? SAN_TI_CHARS : GATSBY_CHARS));
}

export function funOutputPages(tokens: number): string | undefined {
  return factorOf(tokens / PAGE_TOKENS);
}

export function funLinesPages(lines: number): string | undefined {
  return factorOf(lines / CODE_PAGE_LINES);
}

export function funCostDrinks(cost: number, currency: 'CNY' | 'USD'): string | undefined {
  return factorOf(cost / DRINK_PRICE[currency]);
}

/* ---- localized date helpers ------------------------------------------------ */

function dayFormat(): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(htmlLang(getUiLanguage()), { dateStyle: 'medium' });
}

function formatDate(time: number): string {
  return dayFormat().format(time);
}

function formatDay(date: string): string {
  return dayFormat().format(new Date(`${date}T00:00:00`));
}

function formatDateTime(time: number): string {
  return new Intl.DateTimeFormat(htmlLang(getUiLanguage()), { dateStyle: 'medium', timeStyle: 'short' }).format(time);
}

function messageCount(count: number): string {
  return count === 1 ? t('oneMessage') : t('messages', formatInteger(count));
}

function weekdayLabels(): readonly string[] {
  const format = new Intl.DateTimeFormat(htmlLang(getUiLanguage()), { weekday: 'short' });
  // 2024-01-01 was a Monday, the activity grid's row 0.
  return Array.from({ length: 7 }, (_, day) => format.format(new Date(2024, 0, 1 + day)));
}

/* ---- the view -------------------------------------------------------------- */

export class StatsView {
  private readonly doc: Document;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly scopeAll: HTMLButtonElement;
  private readonly scopeFolder: HTMLButtonElement;

  constructor(
    container: HTMLElement,
    private readonly options: StatsViewOptions,
  ) {
    this.doc = container.ownerDocument;
    this.root = this.doc.createElement('div');
    this.root.className = 'stats';

    const header = this.doc.createElement('div');
    header.className = 'stats-header';

    const scopes = this.doc.createElement('div');
    scopes.className = 'stats-scope';
    this.scopeAll = this.scopeButton(scopes, t('scopeAll'), () => options.onScope('all'));
    this.scopeFolder = this.scopeButton(scopes, t('scopeFolder'), () => options.onScope('folder'));

    const refresh = this.doc.createElement('button');
    refresh.className = 'button secondary';
    refresh.textContent = t('refresh');
    refresh.addEventListener('click', () => options.onRefresh());

    header.append(scopes, refresh);

    this.body = this.doc.createElement('div');
    this.body.className = 'stats-body';

    this.root.append(header, this.body);
    container.append(this.root);
  }

  render(state: StatsViewState): void {
    this.scopeAll.classList.toggle('active', state.scope === 'all');
    this.scopeFolder.classList.toggle('active', state.scope === 'folder');
    this.scopeFolder.hidden = !this.options.hasFolder;
    this.body.replaceChildren();

    if (state.loading) {
      this.body.append(this.stateBlock(t('loading')));
      return;
    }
    if (state.error !== undefined || state.data === undefined) {
      this.body.append(this.errorBlock(state.error));
      return;
    }
    this.body.append(...this.sections(state.data));
  }

  relocate(container: HTMLElement): void {
    container.appendChild(this.root);
  }

  dispose(): void {
    this.root.remove();
  }

  /* -- building blocks -- */

  private scopeButton(parent: HTMLElement, text: string, onClick: () => void): HTMLButtonElement {
    const button = this.doc.createElement('button');
    button.className = 'stats-scope-button';
    button.textContent = text;
    button.addEventListener('click', onClick);
    parent.append(button);
    return button;
  }

  private stateBlock(text: string): HTMLElement {
    const block = this.doc.createElement('div');
    block.className = 'stats-state';
    block.textContent = text;
    return block;
  }

  private errorBlock(message: string | undefined): HTMLElement {
    const block = this.doc.createElement('div');
    block.className = 'stats-state';
    const text = this.doc.createElement('div');
    text.textContent = t('failed', message ?? '');
    const retry = this.doc.createElement('button');
    retry.className = 'button secondary';
    retry.textContent = t('retry');
    retry.addEventListener('click', () => this.options.onRefresh());
    block.append(text, retry);
    return block;
  }

  private note(text: string): HTMLElement {
    const note = this.doc.createElement('span');
    note.className = 'stats-fun';
    note.textContent = text;
    return note;
  }

  /** A section with a heading, an optional note beside it, and its rows. */
  private section(title: string, note: string | undefined, ...rows: HTMLElement[]): HTMLElement {
    const section = this.doc.createElement('section');
    section.className = 'stats-section';
    const heading = this.doc.createElement('h2');
    heading.className = 'stats-section-title';
    const titleSpan = this.doc.createElement('span');
    titleSpan.textContent = title;
    heading.append(titleSpan);
    if (note !== undefined) {
      const noteSpan = this.doc.createElement('span');
      noteSpan.className = 'stats-section-note';
      noteSpan.textContent = note;
      heading.append(noteSpan);
    }
    section.append(heading, ...rows);
    return section;
  }

  private rowShell(label: string): { row: HTMLElement; value: HTMLElement } {
    const row = this.doc.createElement('div');
    row.className = 'stats-row';
    const name = this.doc.createElement('span');
    name.className = 'stats-name';
    name.textContent = label;
    const value = this.doc.createElement('span');
    value.className = 'stats-value';
    row.append(name, value);
    return { row, value };
  }

  /** A "label — value" row, with an optional gray fun conversion after the value. */
  private row(label: string, text: string, fun?: string): HTMLElement {
    const { row, value } = this.rowShell(label);
    value.textContent = text;
    if (fun !== undefined) {
      value.append(' ', this.note(fun));
    }
    return row;
  }

  private bar(value: number, max: number): HTMLElement {
    const track = this.doc.createElement('span');
    track.className = 'stats-bar-track';
    const fill = this.doc.createElement('span');
    fill.className = 'stats-bar-fill';
    fill.style.width = `${max <= 0 ? 0 : Math.min(100, (value / max) * 100)}%`;
    track.append(fill);
    return track;
  }

  private ranked(items: readonly CountedName[]): HTMLElement {
    const list = this.doc.createElement('div');
    list.className = 'stats-ranked';
    const max = items.reduce((biggest, item) => Math.max(biggest, item.count), 0);
    for (const item of items) {
      const row = this.doc.createElement('div');
      row.className = 'stats-ranked-row';
      const name = this.doc.createElement('span');
      name.className = 'stats-ranked-name';
      name.textContent = item.name;
      name.title = item.name;
      const count = this.doc.createElement('span');
      count.className = 'stats-ranked-count';
      count.textContent = formatInteger(item.count);
      row.append(name, this.bar(item.count, max), count);
      list.append(row);
    }
    return list;
  }

  private heatmap(grid: ActivityGrid): HTMLElement {
    const wrap = this.doc.createElement('div');
    wrap.className = 'stats-heat';
    const table = this.doc.createElement('div');
    table.className = 'stats-heat-table';
    const weekdays = weekdayLabels();
    const max = grid.reduce((biggest, row) => row.reduce((m, count) => Math.max(m, count), biggest), 0);

    table.append(this.doc.createElement('span'));
    for (const hour of [0, 6, 12, 18]) {
      const label = this.doc.createElement('span');
      label.className = 'stats-heat-label';
      label.textContent = String(hour);
      label.style.gridColumn = 'span 6';
      table.append(label);
    }
    for (let day = 0; day < 7; day++) {
      const name = this.doc.createElement('span');
      name.className = 'stats-heat-day';
      name.textContent = weekdays[day];
      table.append(name);
      for (let hour = 0; hour < 24; hour++) {
        const count = grid[day][hour];
        const cell = this.doc.createElement('span');
        cell.className = 'stats-heat-cell';
        cell.dataset.level = String(heatLevel(count, max));
        cell.title = t('heatCell', weekdays[day], hour, formatInteger(count));
        table.append(cell);
      }
    }
    wrap.append(table);
    return wrap;
  }

  private longestRow(longest: TranscriptStats['longest']): HTMLElement {
    const { row, value } = this.rowShell(t('longest'));
    if (longest === undefined) {
      value.textContent = '—';
      return row;
    }
    const link = this.doc.createElement('button');
    link.className = 'link-button';
    link.textContent = longest.title ?? t('longestNoTitle', longest.sessionId.slice(0, 8));
    link.addEventListener('click', () => this.options.onOpenSession(longest.sessionId, longest.folder));
    value.append(link, this.doc.createTextNode(` · ${messageCount(longest.userMessages)}`));
    return row;
  }

  private costRow(cost: ProviderCost): HTMLElement {
    const { row, value } = this.rowShell(cost.name);
    const parts = [
      cost.calls === 1 ? t('oneCall') : t('calls', formatInteger(cost.calls)),
      t('tokens', formatInteger(totalTokens(cost.tokens))),
    ];
    parts.push(cost.cost === undefined ? `— ${t('noPrice')}` : `${cost.currency === 'USD' ? '$' : '¥'}${formatCost(cost.cost)}`);
    value.textContent = parts.join(' · ');
    const notes: string[] = [];
    if (cost.cost !== undefined && cost.currency !== undefined) {
      const drinks = funCostDrinks(cost.cost, cost.currency);
      if (drinks !== undefined) {
        notes.push(t(cost.currency === 'CNY' ? 'costAsDrinksCny' : 'costAsDrinksUsd', drinks));
      }
    }
    if (cost.estimated) {
      notes.push(t('estimated'));
    }
    if (notes.length > 0) {
      value.append(' ', this.note(notes.join(' ')));
    }
    return row;
  }

  private storageRow(item: StorageItem, maxBytes: number): HTMLElement {
    const row = this.doc.createElement('div');
    row.className = 'stats-row stats-storage-row';
    const name = this.doc.createElement('span');
    name.className = 'stats-name';
    name.textContent = this.storageLabel(item.id);
    const meta = this.doc.createElement('span');
    meta.className = 'stats-storage-meta';
    meta.textContent = `${formatBytes(item.bytes)} · ${item.files === 1 ? t('oneFile') : t('files', formatInteger(item.files))}`;
    const reveal = this.doc.createElement('button');
    reveal.className = 'icon-button';
    reveal.style.setProperty('--icon', 'var(--icon-folder-opened)');
    reveal.title = t('reveal');
    reveal.addEventListener('click', () => this.options.onReveal(item.path));
    row.append(name, this.bar(item.bytes, maxBytes), meta, reveal);
    return row;
  }

  private storageLabel(id: StorageItemId): string {
    switch (id) {
      case 'transcripts':
        return t('storageTranscripts');
      case 'fileHistory':
        return t('storageFileHistory');
      case 'extensions':
        return t('storageExtensions');
      case 'fullTranscripts':
        return t('storageFullTranscripts');
      case 'logs':
        return t('storageLogs');
      case 'cache':
        return t('storageCache');
      case 'shellData':
        return t('storageShellData');
      case 'attachments':
        return t('storageAttachments');
    }
  }

  private sections(data: StatsDto): HTMLElement[] {
    const s = data.transcripts;
    const sections: HTMLElement[] = [];

    const typed = funTypedChars(s.typedChars, getUiLanguage());
    sections.push(
      this.section(
        t('overview'),
        undefined,
        this.row(t('sessions'), formatInteger(s.sessions)),
        this.row(t('folders'), formatInteger(s.folders)),
        this.row(t('userMessages'), formatInteger(s.userMessages)),
        this.row(t('replies'), formatInteger(s.replies)),
        this.row(t('firstUse'), s.first === undefined ? '—' : formatDate(s.first)),
        this.row(t('activeDays'), formatInteger(s.activeDays)),
      ),
    );

    sections.push(
      this.section(
        t('conversations'),
        undefined,
        this.row(t('typedChars'), formatInteger(s.typedChars), typed === undefined ? undefined : t('typedAsBooks', typed)),
        this.row(t('replyChars'), formatInteger(s.replyChars)),
        this.row(t('thinking'), formatInteger(s.thinking)),
        this.row(t('subagents'), formatInteger(s.subagents)),
        this.longestRow(s.longest),
      ),
    );

    sections.push(
      this.section(t('tools'), undefined, this.row(t('toolCalls'), formatInteger(s.toolCalls)), this.ranked(s.tools.slice(0, 15))),
    );

    const lines = funLinesPages(s.linesAdded);
    sections.push(
      this.section(
        t('code'),
        undefined,
        this.row(t('linesAdded'), formatInteger(s.linesAdded), lines === undefined ? undefined : t('linesAsPages', lines)),
        this.row(t('linesRemoved'), formatInteger(s.linesRemoved)),
        this.row(t('filesEdited'), formatInteger(s.filesEdited)),
      ),
    );

    const pages = funOutputPages(s.tokens.output);
    sections.push(
      this.section(
        t('models'),
        undefined,
        this.ranked(s.models.slice(0, 15)),
        this.row(t('input'), formatInteger(s.tokens.input)),
        this.row(t('output'), formatInteger(s.tokens.output), pages === undefined ? undefined : t('outputAsPages', pages)),
        this.row(t('cacheRead'), formatInteger(s.tokens.cacheRead)),
        this.row(t('cacheWrite'), formatInteger(s.tokens.cacheWrite)),
      ),
    );

    sections.push(this.section(t('cost'), undefined, ...data.costs.map((cost) => this.costRow(cost))));

    const time: HTMLElement[] = [this.heatmap(s.activity)];
    if (s.busiestDay !== undefined) {
      time.push(this.row(t('busiestDay'), `${formatDay(s.busiestDay.date)} · ${messageCount(s.busiestDay.userMessages)}`));
    }
    time.push(
      this.row(t('longestStreak'), s.longestStreak === 1 ? t('oneDay') : t('days', formatInteger(s.longestStreak))),
      this.row(t('currentStreak'), s.currentStreak === 1 ? t('oneDay') : t('days', formatInteger(s.currentStreak))),
      this.row(t('latest'), s.latest === undefined ? '—' : formatDateTime(s.latest)),
    );
    sections.push(this.section(t('time'), undefined, ...time));

    const maxBytes = data.storage.reduce((biggest, item) => Math.max(biggest, item.bytes), 0);
    sections.push(this.section(t('storage'), undefined, ...data.storage.map((item) => this.storageRow(item, maxBytes))));

    const c = data.counters;
    sections.push(
      this.section(
        t('vilaus'),
        t('countedSince', formatDate(c.since)),
        this.row(t('launches'), formatInteger(c.launches)),
        this.row(t('foldersOpened'), formatInteger(c.foldersOpened), t('distinct', formatInteger(c.distinctFolders))),
        this.row(t('filesOpened'), formatInteger(c.filesOpened)),
        this.row(t('comments'), formatInteger(c.comments)),
        this.row(t('filesDropped'), formatInteger(c.filesDropped)),
        this.row(t('searches'), formatInteger(c.searches)),
        this.row(t('fullTranscripts'), formatInteger(c.fullTranscripts)),
        this.row(t('localApiCalls'), formatInteger(c.localApiCalls)),
      ),
    );

    return sections;
  }
}
