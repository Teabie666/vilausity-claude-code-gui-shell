/**
 * The `ccw:` scheme serves everything the renderer loads:
 *
 *   ccw://app/<file>          the shell UI (dist/renderer), and the fonts webviews share
 *   ccw://wv<id>/index.html   one webview's document, bootstrap injected
 *   ccw://res/<abs path>      files a webview may load (only under its resource roots)
 *
 * Each webview gets its own host, hence its own origin, isolated from the shell and from
 * other webviews. `res` replies carry CORS headers because webview scripts are modules.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { protocol, type Session } from 'electron';
import type { ILogger } from '../../platform/log';
import { CCW_SCHEME, WEBVIEW_ID_PATTERN } from '../../platform/webviewUrls';
import { isSubPath } from '../node/paths';
import type { WebviewDocumentStore } from './webviewDocuments';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Must run before `app.ready`. */
export function registerCcwSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CCW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
}

export interface CcwProtocolOptions {
  /** Directory with the built renderer (index.html, main.js, ...). */
  readonly appDir: string;
  readonly documents: WebviewDocumentStore;
  /** Folders whose images the shell's own views may show (`ccw://img/...`). */
  readonly imageRoots: () => readonly string[];
  readonly logger: ILogger;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp']);
const FONT_EXTENSIONS = new Set(['.woff', '.woff2', '.ttf']);

const APP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // https: for images in Markdown previews, as VS Code's preview allows by default.
  `img-src 'self' ${CCW_SCHEME}: data: https:`,
  `font-src 'self' ${CCW_SCHEME}: data:`,
  `frame-src ${CCW_SCHEME}:`,
  "connect-src 'self'",
].join('; ');

export function installCcwProtocol(session: Session, options: CcwProtocolOptions): void {
  session.protocol.handle(CCW_SCHEME, async (request) => {
    try {
      return await route(new URL(request.url), options);
    } catch (error) {
      options.logger.error(`ccw request failed: ${request.url}`, error);
      return new Response('Internal error', { status: 500 });
    }
  });
}

async function route(url: URL, options: CcwProtocolOptions): Promise<Response> {
  const host = url.hostname;
  if (host === 'app') {
    const file = safeJoin(options.appDir, decodeURIComponent(url.pathname));
    if (!file) {
      return notFound();
    }
    // Webviews use the shell's fonts too (webviewDocuments.ts), and fonts load with CORS.
    const extra: Record<string, string> = file.endsWith('.html')
      ? { 'Content-Security-Policy': APP_CSP }
      : FONT_EXTENSIONS.has(path.extname(file).toLowerCase())
        ? { 'Access-Control-Allow-Origin': '*' }
        : {};
    return serveFile(file, extra);
  }
  if (host === 'res') {
    const file = resourcePathFromUrl(url);
    const allowed = file && options.documents.resourceRoots().some((root) => isSubPath(file, root));
    if (!file || !allowed) {
      options.logger.warn(`blocked resource outside webview roots: ${url.href}`);
      return notFound();
    }
    return serveFile(file, { 'Access-Control-Allow-Origin': '*' });
  }
  if (host === 'img') {
    // Images only, and only from the workspace: what a Markdown file there may show.
    const file = resourcePathFromUrl(url);
    const allowed =
      file !== undefined &&
      IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()) &&
      options.imageRoots().some((root) => isSubPath(file, root));
    if (!allowed) {
      options.logger.warn(`blocked image outside the workspace: ${url.href}`);
      return notFound();
    }
    // An SVG must not run script in the shell: served with a CSP of its own.
    return serveFile(file, { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  }
  if (WEBVIEW_ID_PATTERN.test(host)) {
    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      return notFound();
    }
    const html = options.documents.render(host);
    if (html === undefined) {
      return notFound();
    }
    return new Response(html, {
      headers: { 'Content-Type': MIME_TYPES['.html']!, 'Cache-Control': 'no-store' },
    });
  }
  return notFound();
}

/** Inverse of `resourceUrlForFsPath`: `ccw://res/C%3A/Program%20Files/x.js` -> `C:\Program Files\x.js` */
export function resourcePathFromUrl(url: URL): string | undefined {
  let p = decodeURIComponent(url.pathname);
  if (/^\/[a-zA-Z]:/.test(p)) {
    p = p.slice(1);
  }
  return path.isAbsolute(p) ? path.normalize(p) : undefined;
}

function safeJoin(root: string, requestPath: string): string | undefined {
  const target = path.normalize(path.join(root, requestPath === '/' ? 'index.html' : requestPath));
  return isSubPath(target, root) ? target : undefined;
}

async function serveFile(file: string, extraHeaders: Record<string, string>): Promise<Response> {
  let data: Buffer;
  try {
    data = await fs.promises.readFile(file);
  } catch {
    return notFound();
  }
  const type = MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  return new Response(new Uint8Array(data), {
    headers: { 'Content-Type': type, 'Cache-Control': 'no-cache', ...extraHeaders },
  });
}

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}
