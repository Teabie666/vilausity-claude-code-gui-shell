/**
 * Runs inside every webview iframe, injected by main ahead of the extension's own scripts
 * (see host/main/webviewDocuments.ts). It recreates what VS Code's webview host page
 * provides: `acquireVsCodeApi`, theme variables and body classes, default styles, and
 * routing of link clicks and keyboard shortcuts to the shell.
 */

import type {
  KeyEventDto,
  ShellToWebviewControl,
  ThemeData,
  WebviewBootstrapData,
  WebviewToShellMessage,
} from '../../platform/protocol';
import { CommentsHost } from './comments';
import { DEFAULT_WEBVIEW_STYLES } from './defaultStyles';
import { InPageFinder } from './find';
import { watchSessionRows } from './sessionRows';
import { StatusFilter } from './statusFilter';
import { PageTranslator } from './translate';
import { UsageResets } from './usageResets';

interface VsCodeApi {
  postMessage(message: unknown): void;
  setState<T>(state: T): T;
  getState(): unknown;
}

declare global {
  interface Window {
    __ccwBootstrap?: WebviewBootstrapData;
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

type OutgoingMessage = WebviewToShellMessage extends infer M
  ? M extends { ccw: string }
    ? Omit<M, 'ccw'>
    : never
  : never;

const THEME_CLASSES = [
  'vscode-light',
  'vscode-dark',
  'vscode-high-contrast',
  'vscode-high-contrast-light',
];

(function bootstrap(): void {
  const data = window.__ccwBootstrap;
  delete window.__ccwBootstrap;
  if (!data) {
    return;
  }
  const shell = window.parent;
  const post = (message: OutgoingMessage): void => {
    shell.postMessage({ ccw: data.webviewId, ...message }, '*');
  };

  installDefaultStyles(data.fontFaces);
  const pageStyles = data.hints?.styles;
  if (pageStyles) {
    onDomReady(() => installPageStyles(pageStyles));
  }
  const meters = data.hints?.meters;
  if (meters) {
    onDomReady(() => watchMeters(meters));
  }
  const sessionRows = data.hints?.sessionRows;
  const labels = data.labels;
  if (sessionRows && labels) {
    onDomReady(() =>
      watchSessionRows(sessionRows, labels.deleteSession, (sessionId, title) => post({ kind: 'deleteSession', sessionId, title })),
    );
  }

  let theme = data.theme;
  applyThemeVariables(theme);
  onDomReady(() => applyBodyTheme(theme));

  let state = data.state;
  const api: VsCodeApi = Object.freeze({
    postMessage(message: unknown): void {
      post({ kind: 'message', message });
    },
    setState<T>(next: T): T {
      state = next;
      post({ kind: 'state', state: next });
      return next;
    },
    getState(): unknown {
      return state;
    },
  });
  // VS Code throws on a second acquire; returning the same object is friendlier and harmless.
  window.acquireVsCodeApi = () => api;

  const finder = new InPageFinder((matches, active) => post({ kind: 'findResult', matches, active }));
  // Pages that have a place for comment blocks (a conversation's input) say where it is.
  const anchor = data.hints?.commentsAnchor;
  const comments = anchor ? new CommentsHost(anchor, (event) => post({ kind: 'comments', event })) : undefined;
  // Pages whose content the bridge knows can show the extension's UI text translated.
  const untranslated = data.hints?.untranslated;
  const translator = untranslated !== undefined ? new PageTranslator(untranslated) : undefined;
  translator?.set(data.translations);
  // The session list's filters as one drop-down; the count may come before the body.
  const statusFilterHints = data.hints?.statusFilter;
  let statusFilter: StatusFilter | undefined;
  let pendingNeedsInput: number | undefined;
  if (statusFilterHints && labels) {
    onDomReady(() => {
      statusFilter = new StatusFilter(statusFilterHints, labels.needsInput);
      if (pendingNeedsInput !== undefined) {
        statusFilter.setNeedsInput(pendingNeedsInput);
      }
    });
  }
  // Pages with usage bars show their reset times to the minute; the times may come before the body.
  const usageBars = data.hints?.usageBars;
  let usageResets: UsageResets | undefined;
  let pendingResets: Readonly<Record<string, number>> | undefined;
  if (usageBars && labels) {
    onDomReady(() => {
      const originalText = (element: Element): string => translator?.originalText(element) ?? element.textContent ?? '';
      usageResets = new UsageResets(usageBars, labels.resetsAt, labels.locale, originalText);
      if (pendingResets) {
        usageResets.set(pendingResets);
      }
    });
  }

  // Control messages from the shell are consumed here and never reach the extension.
  window.addEventListener(
    'message',
    (event) => {
      if (event.source !== shell || !isControl(event.data)) {
        return;
      }
      event.stopImmediatePropagation();
      const control = event.data;
      switch (control.ccwControl) {
        case 'theme':
          theme = control.theme;
          applyThemeVariables(theme);
          applyBodyTheme(theme);
          break;
        case 'find':
          finder.find(control.text, control.matchCase, control.direction);
          break;
        case 'findStop':
          finder.stop();
          break;
        case 'comments': {
          const view = control.view;
          onDomReady(() => comments?.update(view));
          break;
        }
        case 'translations':
          translator?.set(control.translations ?? undefined);
          break;
        case 'usageResets':
          if (usageResets) {
            usageResets.set(control.resets);
          } else {
            pendingResets = control.resets;
          }
          break;
        case 'needsInput':
          if (statusFilter) {
            statusFilter.setNeedsInput(control.count);
          } else {
            pendingNeedsInput = control.count;
          }
          break;
      }
    },
    true,
  );

  window.addEventListener('click', (event) => handleClick(event, post));
  window.addEventListener('auxclick', (event) => {
    // A middle click on a link would try to open it in a new window.
    if (event.button === 1 && findAnchor(event)) {
      event.preventDefault();
    }
  });
  window.addEventListener('keydown', (event) => {
    if (isShellShortcut(event)) {
      post({ kind: 'keydown', event: toKeyEventDto(event) });
    }
  });
  // An Escape the page did not use may close the tab (the shell decides). From the capture
  // phase on: the page's handlers may change the page before a bubble listener here runs.
  window.addEventListener(
    'keydown',
    (event) => {
      if (isPlainEscape(event)) {
        whenUnused(event, () => post({ kind: 'keydown', event: toKeyEventDto(event) }));
      }
    },
    true,
  );
  window.addEventListener('focus', () => post({ kind: 'focus' }));
  window.addEventListener('blur', () => post({ kind: 'blur' }));
})();

function installDefaultStyles(fontFaces: string | undefined): void {
  const parent = document.head ?? document.documentElement;
  if (fontFaces) {
    const fonts = document.createElement('style');
    fonts.id = '_shellFonts';
    fonts.textContent = fontFaces;
    parent.appendChild(fonts);
  }
  const style = document.createElement('style');
  style.id = '_defaultStyles';
  style.textContent = DEFAULT_WEBVIEW_STYLES;
  // We run while <head> is being parsed, so this lands before the page's own stylesheets.
  parent.appendChild(style);
}

/** The bridge's styles for this page; added once the page's own are in, so they win ties. */
function installPageStyles(css: string): void {
  const style = document.createElement('style');
  style.id = '_shellPageStyles';
  style.textContent = css;
  (document.head ?? document.documentElement).appendChild(style);
}

/** Mirrors the inline `width: N%` of the bars `selector` matches into `--vilaus-meter` (0 to 1). */
function watchMeters(selector: string): void {
  const update = (): void => {
    for (const bar of document.querySelectorAll<HTMLElement>(selector)) {
      const width = Number.parseFloat(bar.style.width);
      if (!Number.isFinite(width)) {
        continue;
      }
      const value = String(Math.min(1, Math.max(0, width / 100)));
      // Only on change: setting it is a style mutation itself.
      if (bar.style.getPropertyValue('--vilaus-meter') !== value) {
        bar.style.setProperty('--vilaus-meter', value);
      }
    }
  };
  new MutationObserver(update).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
  update();
}

function applyThemeVariables(theme: ThemeData): void {
  const style = document.documentElement.style;
  for (let i = style.length - 1; i >= 0; i--) {
    const property = style[i];
    if (property?.startsWith('--vscode-')) {
      style.removeProperty(property);
    }
  }
  for (const [name, value] of Object.entries(theme.variables)) {
    style.setProperty(`--${name}`, value);
  }
}

function applyBodyTheme(theme: ThemeData): void {
  const body = document.body;
  if (!body) {
    return;
  }
  body.classList.remove(...THEME_CLASSES);
  body.classList.add(theme.kind);
  if (theme.kind === 'vscode-high-contrast-light') {
    body.classList.add('vscode-high-contrast');
  }
  body.dataset.vscodeThemeKind = theme.kind;
  body.dataset.vscodeThemeName = theme.label;
  body.dataset.vscodeThemeId = theme.id;
}

function onDomReady(callback: () => void): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', callback, { once: true });
  } else {
    callback();
  }
}

function isControl(value: unknown): value is ShellToWebviewControl {
  return typeof value === 'object' && value !== null && 'ccwControl' in value;
}

function findAnchor(event: MouseEvent): HTMLAnchorElement | undefined {
  for (const node of event.composedPath()) {
    if (node instanceof HTMLAnchorElement && node.href) {
      return node;
    }
  }
  return undefined;
}

/** Same rules as VS Code's handleInnerClick, but respects handlers that already acted. */
function handleClick(event: MouseEvent, post: (message: OutgoingMessage) => void): void {
  if (event.defaultPrevented) {
    return;
  }
  const anchor = findAnchor(event);
  if (!anchor) {
    return;
  }
  event.preventDefault();
  const rawHref = anchor.getAttribute('href') ?? '';
  if (rawHref === '#') {
    window.scrollTo(0, 0);
    return;
  }
  if (anchor.hash && rawHref === anchor.hash) {
    const fragment = anchor.hash.slice(1);
    const target =
      document.getElementById(fragment) ?? document.getElementById(decodeURIComponent(fragment));
    target?.scrollIntoView();
    return;
  }
  post({ kind: 'link', href: anchor.href });
}

/** Keys the shell may act on: anything with Ctrl/Alt/Meta, and the function keys. */
function isShellShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.altKey || event.metaKey || /^F\d{1,2}$/.test(event.key);
}

/**
 * Calls `unused` once the event's dispatch is over if nothing used it: no listener prevented
 * its default or stopped it before it bubbled back to the window, and it changed nothing on
 * the page (some menus close on Escape without either).
 */
function whenUnused(event: KeyboardEvent, unused: () => void): void {
  let changed = false;
  const observer = new MutationObserver(() => {
    changed = true;
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  // Added now, it runs after the page's own listeners on window.
  let bubbled = false;
  const onBubble = (candidate: Event): void => {
    bubbled ||= candidate === event;
  };
  window.addEventListener('keydown', onBubble);
  setTimeout(() => {
    window.removeEventListener('keydown', onBubble);
    changed ||= observer.takeRecords().length > 0;
    observer.disconnect();
    if (bubbled && !changed && !event.defaultPrevented) {
      unused();
    }
  });
}

function isPlainEscape(event: KeyboardEvent): boolean {
  return (
    event.key === 'Escape' && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && !event.repeat && !event.isComposing
  );
}

function toKeyEventDto(event: KeyboardEvent): KeyEventDto {
  return {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    repeat: event.repeat,
  };
}
