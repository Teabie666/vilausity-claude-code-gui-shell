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
import { PageTranslator } from './translate';

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
