import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WebviewDocumentStore,
  allowShellFonts,
  findNonce,
  injectBootstrap,
  serializeForScript,
} from '../../../src/host/main/webviewDocuments';
import type { ThemeData, WebviewBootstrapData, WebviewDocument } from '../../../src/platform/protocol';

const theme: ThemeData = {
  id: 'dark-modern',
  label: 'Dark Modern',
  kind: 'vscode-dark',
  variables: {},
};

describe('findNonce', () => {
  test('prefers the CSP nonce over a script tag nonce and returns undefined when there is none', () => {
    assert.equal(findNonce(`<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-abc123'">`), 'abc123');
    assert.equal(
      findNonce(
        `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-csp'"><script nonce="scriptNonce"></script>`,
      ),
      'csp',
    );
    assert.equal(findNonce(`<script nonce="scriptNonce"></script>`), 'scriptNonce');
    assert.equal(findNonce('<html><head></head></html>'), undefined);
  });
});

describe('injectBootstrap', () => {
  test('inserts the script as the first child of <head> and copies the nonce', () => {
    const html = `<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-abc123'"></head><body></body></html>`;
    const out = injectBootstrap(html, 'const boot = 1;', { webviewId: 'w1', state: undefined, theme });
    assert.ok(out.startsWith('<html><head><script nonce="abc123">window.__ccwBootstrap='));
    assert.ok(out.includes('const boot = 1;</script><meta http-equiv='));
  });

  test('prepends the script when the document has no <head>', () => {
    const html = '<html><body>hi</body></html>';
    const out = injectBootstrap(html, 'BOOT', { webviewId: 'w', state: undefined, theme });
    assert.ok(out.startsWith('<script>window.__ccwBootstrap='));
    assert.ok(out.includes('BOOT</script><html><body>hi</body></html>'));
  });

  test('escapes </script> and < inside the serialized data', () => {
    const data: WebviewBootstrapData = { webviewId: 'w1', state: { dangerous: '</script><' }, theme };
    const out = injectBootstrap('<html><head></head></html>', 'BOOT', data);
    const start = out.indexOf('window.__ccwBootstrap=') + 'window.__ccwBootstrap='.length;
    const payload = out.slice(start, out.indexOf(';\n', start));
    assert.equal(payload.includes('<'), false);
    assert.equal(payload.includes('</script>'), false);
    assert.ok(payload.includes('\\u003c'));
  });

  test('escapes </script appearing in the bootstrap source', () => {
    const out = injectBootstrap('<html><head></head></html>', 'document.write("</script>");', {
      webviewId: 'w',
      state: undefined,
      theme,
    });
    assert.ok(out.includes('document.write("<\\/script>");'));
  });
});

describe('serializeForScript', () => {
  test('escapes U+2028 and U+2029 and serializes undefined and null as null', () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    assert.equal(serializeForScript(`a${ls}b${ps}c`), '"a\\u2028b\\u2029c"');
    assert.equal(serializeForScript('</script>'), '"\\u003c/script>"');
    assert.equal(serializeForScript(undefined), 'null');
    assert.equal(serializeForScript(null), 'null');
  });
});

describe('allowShellFonts', () => {
  test('adds data: to font-src and leaves every other directive unchanged', () => {
    const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-x'; style-src ccw:; font-src ccw:; img-src ccw: data:">`;
    const out = allowShellFonts(html);
    assert.ok(out.includes('font-src ccw: data:;'));
    assert.ok(out.includes('style-src ccw:;'));
    assert.ok(out.includes("script-src 'nonce-x'"));
    assert.ok(out.includes("default-src 'none'"));
    assert.ok(out.includes('img-src ccw: data:'));
  });

  test("adds ccw: for the shell's fonts and keeps quoted sources such as self intact", () => {
    const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src 'self'; img-src data:">`;
    const out = allowShellFonts(html);
    assert.ok(out.includes("font-src 'self' data: ccw:;"), out);
    assert.ok(out.includes("default-src 'none'"));
  });

  test('adds nothing when font-src has both already', () => {
    const html = `<meta http-equiv="Content-Security-Policy" content="font-src ccw: data:">`;
    assert.equal(allowShellFonts(html), html);
  });

  test('adds a font-src when default-src would block fonts', () => {
    const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">`;
    assert.equal(
      allowShellFonts(html),
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data: ccw:">`,
    );
  });

  test('leaves a CSP without font-src and default-src alone: nothing blocks fonts there', () => {
    const html = `<meta http-equiv="Content-Security-Policy" content="style-src ccw:">`;
    assert.equal(allowShellFonts(html), html);
  });

  test('leaves the document unchanged when there is no CSP meta', () => {
    const html = `<meta name="viewport" content="width=device-width"><script>1</script>`;
    assert.equal(allowShellFonts(html), html);
  });
});

describe('WebviewDocumentStore', () => {
  function makeDoc(webviewId: string, html: string, resourceRoots: string[], state?: unknown): WebviewDocument {
    return { webviewId, html, resourceRoots, state };
  }

  test('renders undefined for an unknown id and injects the bootstrap for a known one', () => {
    const store = new WebviewDocumentStore('BOOT', () => theme);
    assert.equal(store.render('missing'), undefined);
    store.set(makeDoc('a', '<html><head></head></html>', []));
    assert.ok(store.render('a')!.includes('BOOT'));
  });

  test("passes the shell's @font-face rules to every page", () => {
    const store = new WebviewDocumentStore('BOOT', () => theme, () => undefined, "@font-face { font-family: 'Noto Sans SC'; }");
    store.set(makeDoc('a', '<html><head></head></html>', []));
    assert.ok(store.render('a')!.includes(`"fontFaces":"@font-face { font-family: 'Noto Sans SC'; }"`));
    const without = new WebviewDocumentStore('BOOT', () => theme);
    without.set(makeDoc('a', '<html><head></head></html>', []));
    assert.ok(!without.render('a')!.includes('fontFaces'));
  });

  test('a page with session rows gets the text of the button the shell adds to them', () => {
    const store = new WebviewDocumentStore('BOOT', () => theme);
    const sessionRows = { row: 'button', idPrefix: 'row-', name: '.name', actions: '.actions', buttonClass: 'b', iconClass: 'i' };
    store.set({ ...makeDoc('list', '<html><head></head></html>', []), hints: { sessionRows } });
    store.set(makeDoc('other', '<html><head></head></html>', []));
    assert.ok(store.render('list')!.includes('"labels":{"deleteSession":"Delete session","resetsAt":"Resets {0}","needsInput":"Needs input · {0}","locale":"en"}'));
    assert.ok(!store.render('other')!.includes('labels'));
  });

  test('resourceRoots returns the deduplicated union of live documents', () => {
    const store = new WebviewDocumentStore('BOOT', () => theme);
    store.set(makeDoc('a', '<html></html>', ['/root1', '/root2']));
    store.set(makeDoc('b', '<html></html>', ['/root2', '/root3']));
    assert.deepEqual(store.resourceRoots().sort(), ['/root1', '/root2', '/root3']);
  });

  test('no longer renders a released document', () => {
    const store = new WebviewDocumentStore('BOOT', () => theme);
    store.set(makeDoc('a', '<html><head></head></html>', ['/root1']));
    assert.ok(store.render('a'));
    store.release('a');
    assert.equal(store.render('a'), undefined);
    assert.deepEqual(store.resourceRoots(), []);
  });

  test("releaseOwner drops one window's documents and keeps the others'", () => {
    const store = new WebviewDocumentStore('BOOT', () => theme);
    store.set(makeDoc('a', '<html></html>', ['/a']), 'window1');
    store.set(makeDoc('b', '<html></html>', ['/b']), 'window2');
    store.set(makeDoc('c', '<html></html>', ['/c']), 'window1');
    store.releaseOwner('window1');
    assert.equal(store.render('a'), undefined);
    assert.equal(store.render('c'), undefined);
    assert.ok(store.render('b'));
    assert.deepEqual(store.resourceRoots(), ['/b']);
  });
});
