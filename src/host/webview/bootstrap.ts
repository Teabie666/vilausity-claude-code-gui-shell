/**
 * Runs inside every webview iframe, injected by main ahead of the extension's own scripts
 * (see host/main/webviewDocuments.ts). It recreates what VS Code's webview host page
 * provides: `acquireVsCodeApi`, theme variables and body classes, default styles, and
 * routing of link clicks and keyboard shortcuts to the shell.
 */

import type {
  KeyEventDto,
  ProviderNoticeDto,
  SessionProvidersDto,
  ShellToWebviewControl,
  ThemeData,
  UsageViewDto,
  WebviewBootstrapData,
  WebviewToShellMessage,
} from '../../platform/protocol';
import { CommentsHost } from './comments';
import { DEFAULT_WEBVIEW_STYLES } from './defaultStyles';
import { FileLinks } from './fileLinks';
import { InPageFinder } from './find';
import { MessageMarkers } from './messageMarkers';
import { ProviderNotice } from './providerNotice';
import { filterButtonOnly, SessionProviderMarks } from './sessionProviders';
import { watchSessionRows } from './sessionRows';
import { StatusFilter } from './statusFilter';
import { installStreamMerging } from './streamMerge';
import { installScrollKeeper } from './scrollKeeper';
import { PageTranslator } from './translate';
import { UsageBlock } from './usageBlock';
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

type OutgoingMessage = WebviewToShellMessage extends infer M ? (M extends { ccw: string } ? Omit<M, 'ccw'> : never) : never;

const THEME_CLASSES = ['vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light'];

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

  // The files a conversation links to: Shift+click and the right-click menu are the shell's.
  const fileLinkHints = data.hints?.fileLinks;
  const fileLinks = fileLinkHints
    ? new FileLinks(
        fileLinkHints,
        (request) => post({ kind: 'fileLink', ...request }),
        (message) => post({ kind: 'message', message }),
      )
    : undefined;

  let state = data.state;
  const api: VsCodeApi = Object.freeze({
    postMessage(message: unknown): void {
      if (!fileLinks?.intercept(message)) {
        post({ kind: 'message', message });
      }
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
  const filterHints = data.hints?.statusFilter;
  const statusFilterHints = filterHints && { ...filterHints, menuButton: filterButtonOnly(filterHints.menuButton) };
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

  // A session list shows the shell's usage block when the window's API is priced by the shell.
  const usageBlockHints = data.hints?.usageBlock;
  let usageBlock: UsageBlock | undefined;
  let pendingUsage: UsageViewDto | null = null;
  if (usageBlockHints) {
    onDomReady(() => {
      usageBlock = new UsageBlock(usageBlockHints, () => post({ kind: 'editPrices' }));
      usageBlock.set(pendingUsage);
    });
  }

  // A session list marks each session with its API provider and can keep only the window's.
  let marks: SessionProviderMarks | undefined;
  let pendingMarks: SessionProvidersDto | null = null;
  if (sessionRows && statusFilterHints) {
    onDomReady(() => {
      marks = new SessionProviderMarks(sessionRows, statusFilterHints.menuButton, () => post({ kind: 'toggleProviderFilter' }));
      marks.set(pendingMarks);
    });
  }
  // A thinking block's summary stays where it was clicked while every thinking block opens.
  const keepInPlace = data.hints?.keepInPlace;
  if (keepInPlace) {
    installScrollKeeper(keepInPlace);
  }
  // Markers by a conversation's scrollbar; the shell may turn them off before the body is there.
  const markerHints = data.hints?.messageMarkers;
  let markers: MessageMarkers | undefined;
  let markersEnabled = true;
  if (markerHints) {
    onDomReady(() => {
      markers = new MessageMarkers(markerHints);
      markers.setEnabled(markersEnabled);
    });
  }

  // A conversation says when it last ran under another provider than the window's.
  let notice: ProviderNotice | undefined;
  let pendingNotice: ProviderNoticeDto | null = null;
  if (anchor) {
    onDomReady(() => {
      notice = new ProviderNotice(anchor, ({ switchTo, sessionId }) => {
        if (switchTo) {
          post({ kind: 'switchProvider', providerId: switchTo, sessionId });
        }
      });
      notice.set(pendingNotice);
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
        case 'escape':
          playEscape(control.action);
          break;
        case 'usageView':
          if (usageBlock) {
            usageBlock.set(control.view);
          } else {
            pendingUsage = control.view;
          }
          break;
        case 'sessionProviders':
          if (marks) {
            marks.set(control.view);
          } else {
            pendingMarks = control.view;
          }
          break;
        case 'providerNotice':
          if (notice) {
            notice.set(control.notice);
          } else {
            pendingNotice = control.notice;
          }
          break;
        case 'fileLink':
          fileLinks?.answer(control.id, control.release);
          break;
        case 'messageMarkers':
          markersEnabled = control.enabled;
          markers?.setEnabled(control.enabled);
          break;
        case 'jumpToMessage':
          markers?.jump(control.direction);
          break;
      }
    },
    true,
  );
  // Ahead of the page's own listeners, which its scripts add later.
  const streamMerge = data.hints?.streamMerge;
  if (streamMerge) {
    installStreamMerging(streamMerge);
  }

  window.addEventListener('click', (event) => {
    if (fileLinks?.playing) {
      // A click played to learn a link's file: it must not follow the link either.
      event.preventDefault();
      return;
    }
    handleClick(event, post);
  });
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
  // A plain Escape. The conversation page's own uses of it that the shell took over (see the
  // hints) are kept from the page: the Escape is prevented, which keeps the page from
  // interrupting Claude, and one that would be the second in the empty input does not reach
  // it (no rewind picker). Played by the shell, they do reach it. An Escape the page did not use
  // otherwise may close the tab (the shell decides). From the capture phase on: the page's
  // handlers may change the page before a bubble listener here runs.
  const escapes = data.hints?.conversationEscapes;
  const played = new WeakMap<Event, 'interrupt' | 'rewind'>();
  // When the page last had an Escape in the empty input.
  let inputEscapeAt = Number.NEGATIVE_INFINITY;
  window.addEventListener(
    'keydown',
    (event) => {
      const play = played.get(event);
      if (play !== undefined) {
        // The rewind's Escapes must not interrupt Claude as well.
        if (play === 'rewind') {
          event.preventDefault();
        }
        return;
      }
      if (!isPlainEscape(event)) {
        return;
      }
      if (escapes) {
        event.preventDefault();
        const input = event.target instanceof Element ? event.target.closest(escapes.input) : null;
        if (input && (input.textContent ?? '').trim() === '') {
          const now = Date.now();
          if (now - inputEscapeAt <= escapes.doubleMs) {
            event.stopImmediatePropagation();
            return;
          }
          inputEscapeAt = now;
        }
      }
      whenUnused(event, escapes !== undefined, () => post({ kind: 'keydown', event: toKeyEventDto(event) }));
    },
    true,
  );
  const playEscape = (action: 'interrupt' | 'rewind'): void => {
    // The rewind picker: two Escapes in the empty input; interrupting: one that reaches the body.
    const target = action === 'rewind' ? document.querySelector<HTMLElement>(escapes?.input ?? '') : document.body;
    if (!escapes || !target) {
      return;
    }
    if (action === 'rewind') {
      target.focus();
    }
    for (let count = action === 'rewind' ? 2 : 1; count > 0; count--) {
      const escape = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
      played.set(escape, action);
      target.dispatchEvent(escape);
    }
  };
  // The mouse's back and forward buttons go to the shell, which moves between the tabs used.
  window.addEventListener(
    'mouseup',
    (event) => {
      if (event.button === 3 || event.button === 4) {
        event.preventDefault();
        post({ kind: 'navigate', direction: event.button === 3 ? 'back' : 'forward' });
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
    const target = document.getElementById(fragment) ?? document.getElementById(decodeURIComponent(fragment));
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
 * its default (unless this script did itself: then only the rest tells) or stopped it before
 * it bubbled back to the window, and it changed nothing on the page (some menus close on
 * Escape without either).
 */
function whenUnused(event: KeyboardEvent, preventedHere: boolean, unused: () => void): void {
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
    if (bubbled && !changed && (preventedHere || !event.defaultPrevented)) {
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
