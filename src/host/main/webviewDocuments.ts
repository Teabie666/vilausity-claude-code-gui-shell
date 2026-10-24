/**
 * Holds the HTML each webview should show and renders it with the vilaus bootstrap
 * injected. The bootstrap (src/host/webview/bootstrap.ts) provides `acquireVsCodeApi`,
 * theme variables and VS Code's default webview styles before the extension's own
 * scripts run, mirroring what VS Code's `pre/index.html` does. It also brings the shell's
 * fonts (their @font-face rules), so pages can use them like system fonts.
 */

import type { ExtensionTranslations, ScriptRewrite, ThemeData, WebviewBootstrapData, WebviewDocument } from '../../platform/protocol';
import { getUiLanguage, htmlLang } from '../../platform/nls';
import { WEBVIEW_CSP_SOURCE } from '../../platform/webviewUrls';
import { t } from './messages';

export class WebviewDocumentStore {
  /** Webview ids are random, so the documents of every window share one map. */
  private readonly documents = new Map<string, { readonly document: WebviewDocument; readonly owner?: string }>();

  constructor(
    private readonly bootstrapSource: string,
    /** The theme of a document's owner (`set`), or the shared one. */
    private readonly getTheme: (owner: string | undefined) => ThemeData,
    /** The table that translates the extension's UI, when that is on. */
    private readonly getTranslations: () => ExtensionTranslations | undefined = () => undefined,
    /** The shell's @font-face rules (dist/renderer/fonts/fonts.css, absolute ccw://app URLs). */
    private readonly fontFaces = '',
    /** Whether a boolean setting is on (the page hints' script rewrites go by one each). */
    private readonly settingOn: (key: string) => boolean = () => false,
  ) {}

  /** The script rewrites of a webview's page that are on, for the script at `file` (all of them without). */
  rewritesFor(webviewId: string, file?: string): ScriptRewrite[] {
    const rewrites = this.documents.get(webviewId)?.document.hints?.scriptRewrites ?? [];
    return rewrites.filter((rewrite) => this.settingOn(rewrite.setting) && (file === undefined || endsWithFile(file, rewrite.file)));
  }

  /** `owner`: whose webview it is (a window), so its documents can go when it does. */
  set(document: WebviewDocument, owner?: string): void {
    this.documents.set(document.webviewId, { document, owner });
  }

  release(webviewId: string): void {
    this.documents.delete(webviewId);
  }

  /** Forgets every document of one owner (its extension host restarted, or the window closed). */
  releaseOwner(owner: string): void {
    for (const [webviewId, entry] of this.documents) {
      if (entry.owner === owner) {
        this.documents.delete(webviewId);
      }
    }
  }

  /** Union of every live webview's resource roots; `ccw://res/` serves only files under these. */
  resourceRoots(): string[] {
    const roots = new Set<string>();
    for (const { document } of this.documents.values()) {
      for (const root of document.resourceRoots) {
        roots.add(root);
      }
    }
    return [...roots];
  }

  render(webviewId: string): string | undefined {
    const entry = this.documents.get(webviewId);
    if (!entry) {
      return undefined;
    }
    const document = entry.document;
    const data: WebviewBootstrapData = {
      webviewId,
      state: document.state,
      theme: this.getTheme(entry.owner),
      hints: document.hints,
      // Only pages whose content the bridge knows are translated.
      translations: document.hints?.untranslated !== undefined ? this.getTranslations() : undefined,
      fontFaces: this.fontFaces || undefined,
      labels:
        document.hints?.sessionRows || document.hints?.usageBars || document.hints?.statusFilter || document.hints?.conversationComments
          ? {
              deleteSession: t('deleteSession'),
              resetsAt: t('resetsAt'),
              needsInput: t('needsInput'),
              comment: t('comment'),
              omittedRows: t('omittedRows'),
              fullTranscript: t('fullTranscript'),
              locale: htmlLang(getUiLanguage()),
            }
          : undefined,
    };
    const rewrites = this.rewritesFor(webviewId);
    const html = rewrites.length > 0 ? markRewrittenScripts(document.html, webviewId, rewrites) : document.html;
    return injectBootstrap(allowShellFonts(html), this.bootstrapSource, data);
  }
}

/** The query parameter a rewritten script is asked for with: the webview's id. */
export const REWRITE_PARAMETER = 'vilaus-wv';

function endsWithFile(file: string, end: string): boolean {
  return `/${file.replace(/\\/g, '/')}`.toLowerCase().endsWith(`/${end.replace(/^\/+/, '')}`.toLowerCase());
}

/**
 * `html` with the scripts that get a rewrite asked for with the webview's id (the
 * `REWRITE_PARAMETER`): main knows by it whose page asks, and the browser keeps the changed
 * script apart from the one other pages get.
 */
export function markRewrittenScripts(html: string, webviewId: string, rewrites: readonly ScriptRewrite[]): string {
  return html.replace(/(<script\b[^>]*?\ssrc=")([^"]+)(")/gi, (tag, start: string, src: string, end: string) => {
    const filePath = src.replace(/[?#].*$/, '');
    let decoded = filePath;
    try {
      decoded = decodeURIComponent(filePath);
    } catch {
      // As it is.
    }
    if (!rewrites.some((rewrite) => endsWithFile(decoded, rewrite.file))) {
      return tag;
    }
    const hash = src.indexOf('#');
    const [base, fragment] = hash < 0 ? [src, ''] : [src.slice(0, hash), src.slice(hash)];
    const parameter = `${REWRITE_PARAMETER}=${encodeURIComponent(webviewId)}`;
    return `${start}${base}${base.includes('?') ? '&' : '?'}${parameter}${fragment}${end}`;
  });
}

/** `text` with each rewrite made (its first match), and the rewrites that found nothing. */
export function applyRewrites(text: string, rewrites: readonly ScriptRewrite[]): { text: string; missed: ScriptRewrite[] } {
  const missed: ScriptRewrite[] = [];
  let result = text;
  for (const rewrite of rewrites) {
    const find = new RegExp(rewrite.find);
    if (find.test(result)) {
      result = result.replace(find, rewrite.replace);
    } else {
      missed.push(rewrite);
    }
  }
  return { text: result, missed };
}

/** Font sources every webview needs: inline fonts, and the shell's own (ccw://app/fonts). */
const FONT_SOURCES = ['data:', WEBVIEW_CSP_SOURCE];

/**
 * Lets a page's CSP load the fonts webviews need, changing font-src only; every other
 * directive stays exactly as the extension wrote it:
 * - the Claude Code webview embeds its icon font (codicon) as a `data:` URL but declares
 *   `font-src <cspSource>`, which blocks it, so icons render as empty boxes;
 * - the shell's fonts (the conversation's Noto Sans SC) come from `ccw:`; a page without
 *   font-src whose default-src blocks fonts (the plan preview's `default-src 'none'`) gets one.
 */
export function allowShellFonts(html: string): string {
  return html.replace(/(<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>)/i, (meta) => {
    if (/font-src/i.test(meta)) {
      // Sources run to the next `;` or the end of the (double-quoted) content attribute;
      // single quotes are part of sources like 'self'.
      return meta.replace(/font-src([^;"]*)/i, (directive, sources: string) => {
        const present = new Set(sources.trim().toLowerCase().split(/\s+/));
        const missing = FONT_SOURCES.filter((source) => !present.has(source));
        return missing.length > 0 ? `font-src${sources.trimEnd()} ${missing.join(' ')}` : directive;
      });
    }
    // Without default-src nothing blocks fonts, and a font-src would.
    if (!/default-src/i.test(meta)) {
      return meta;
    }
    return meta.replace(
      /content="([^"]*)"/i,
      (_attribute, content: string) => `content="${content.replace(/[\s;]*$/, '')}; font-src ${FONT_SOURCES.join(' ')}"`,
    );
  });
}

/**
 * Inserts the bootstrap script as the first child of <head>. That puts it ahead of the
 * page's CSP <meta> (a meta CSP only governs content after it), and we still copy the
 * page's nonce onto it so it stays valid if a page puts its CSP first.
 */
export function injectBootstrap(html: string, bootstrapSource: string, data: WebviewBootstrapData): string {
  const nonce = findNonce(html);
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  // An inline script ends at the first "</script", wherever it appears.
  const safeSource = bootstrapSource.replace(/<\/script/gi, '<\\/script');
  const script = `<script${nonceAttr}>window.__ccwBootstrap=${serializeForScript(data)};\n` + `${safeSource}</script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + script + html.slice(at);
  }
  return script + html;
}

export function findNonce(html: string): string | undefined {
  const fromCsp = /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(html);
  if (fromCsp) {
    return fromCsp[1];
  }
  const fromScript = /<script[^>]*\snonce="([^"]+)"/i.exec(html);
  return fromScript?.[1];
}

/** JSON that is safe inside a <script> element. */
export function serializeForScript(value: unknown): string {
  // U+2028/U+2029 are line terminators inside <script>; built with fromCharCode so the
  // source file itself never contains the invisible characters.
  const lineSeparator = String.fromCharCode(0x2028);
  const paragraphSeparator = String.fromCharCode(0x2029);
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replaceAll(lineSeparator, '\\u2028')
    .replaceAll(paragraphSeparator, '\\u2029');
}
