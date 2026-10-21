import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { fileLinkMenu } from '../../../src/features/fileLinks';
import { FILE_LINKS } from '../../../src/host/exthost/bridge';
import { linkPathCandidates, pathInFolder } from '../../../src/platform/fileLinks';

const folder = 'C:\\work\\site';

describe('linked file paths', () => {
  test('relative ones are in the workspace; absolute, file: URLs and Git Bash drives stay where they are', () => {
    assert.deepEqual(linkPathCandidates('src/app.ts', folder), ['C:\\work\\site\\src\\app.ts']);
    assert.deepEqual(linkPathCandidates('./docs/../README.md', folder), ['C:\\work\\site\\README.md']);
    assert.deepEqual(linkPathCandidates('D:/other/x.txt', folder), ['D:\\other\\x.txt']);
    assert.deepEqual(linkPathCandidates('file:///C:/work/a%20b.md', folder), ['C:\\work\\a b.md']);
    assert.deepEqual(linkPathCandidates('/c/Users/me/notes.md', folder), ['C:\\Users\\me\\notes.md']);
    assert.deepEqual(linkPathCandidates('\\\\server\\share\\f.txt', folder), ['\\\\server\\share\\f.txt']);
    assert.deepEqual(linkPathCandidates('C:\\..\\x', folder), ['C:\\x'], 'not above the drive');
  });

  test('a line after the path: the path with it first, then without', () => {
    assert.deepEqual(linkPathCandidates('src/app.ts:12', folder), ['C:\\work\\site\\src\\app.ts:12', 'C:\\work\\site\\src\\app.ts']);
    assert.deepEqual(linkPathCandidates('src/app.ts:12:5', folder).at(-1), 'C:\\work\\site\\src\\app.ts');
    assert.deepEqual(linkPathCandidates('src/app.ts#L3-L9', folder).at(-1), 'C:\\work\\site\\src\\app.ts');
  });

  test('without a workspace, a relative path leads nowhere', () => {
    assert.deepEqual(linkPathCandidates('src/app.ts', undefined), []);
    assert.deepEqual(linkPathCandidates('C:/a.txt', undefined), ['C:\\a.txt']);
  });

  test('relative to the workspace when inside it, whatever the case', () => {
    assert.equal(pathInFolder('C:\\work\\site\\src\\app.ts', folder), 'src\\app.ts');
    assert.equal(pathInFolder('c:/WORK/site/x.md', 'C:\\work\\site\\'), 'x.md');
    assert.equal(pathInFolder('C:\\work\\sitemap.xml', folder), undefined, 'a sibling that starts the same');
    assert.equal(pathInFolder('C:\\work\\site', folder), undefined, 'the folder itself');
    assert.equal(pathInFolder('C:\\x', undefined), undefined);
  });
});

describe('the menu of a linked file', () => {
  const ids = (items: ReturnType<typeof fileLinkMenu>) => items.map((item) => item.id ?? '---').join(',');

  test('a file in the workspace: editor, its program, File Explorer, both paths', () => {
    const items = fileLinkMenu({ path: 'C:\\work\\site\\a.ts', kind: 'file' }, undefined, folder);
    assert.equal(ids(items), 'editor,system,reveal,---,copyPath,copyRelativePath');
  });

  test('a Markdown link adds Copy Link; outside the workspace there is no relative path', () => {
    const items = fileLinkMenu({ path: 'D:\\a.ts', kind: 'file' }, 'D:/a.ts', folder);
    assert.equal(ids(items), 'editor,system,reveal,---,copyPath,---,copyLink');
  });

  test('a folder opens in File Explorer; a file the shell cannot find goes to the extension', () => {
    assert.equal(
      ids(fileLinkMenu({ path: 'C:\\work\\site\\docs', kind: 'folder' }, undefined, folder)),
      'system,---,copyPath,copyRelativePath',
    );
    assert.equal(ids(fileLinkMenu(undefined, 'gone.md', folder)), 'editor,---,copyLink');
  });
});

describe('the conversation page hints for file links', () => {
  test("match the extension's request to open a file, and say where its path is", () => {
    const message = { type: 'request', channelId: 'c', requestId: 'r', request: { type: 'open_file', filePath: 'a.ts', location: {} } };
    assert.ok(
      FILE_LINKS.request.every(
        ([path, value]) => path.reduce<unknown>((at, key) => (at as Record<string, unknown>)[key], message) === value,
      ),
    );
    assert.deepEqual(FILE_LINKS.path, ['request', 'filePath']);
  });
});
