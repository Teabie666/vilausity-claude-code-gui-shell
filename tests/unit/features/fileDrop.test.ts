import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { mentionText, splitOpenStrip, zoneAt, type DropZone } from '../../../src/features/fileDrop/zones';

describe('zoneAt', () => {
  const zones: DropZone[] = [
    { action: 'mention', rect: { left: 0, top: 35, right: 280, bottom: 800 } },
    { action: 'attach', rect: { left: 280, top: 35, right: 900, bottom: 800 } },
    { action: 'open', rect: { left: 900, top: 35, right: 1400, bottom: 800 } },
  ];

  test('finds the zone a point is in, the right and bottom edges belonging to the next', () => {
    assert.equal(zoneAt(zones, 10, 100)?.action, 'mention');
    assert.equal(zoneAt(zones, 280, 100)?.action, 'attach');
    assert.equal(zoneAt(zones, 1399, 799)?.action, 'open');
  });

  test('finds none outside them (the title bar)', () => {
    assert.equal(zoneAt(zones, 500, 10), undefined);
    assert.equal(zoneAt(zones, 1400, 100), undefined);
  });
});

describe('splitOpenStrip', () => {
  const main = { left: 280, top: 35, right: 1280, bottom: 800 };

  test("cuts a fifth of the window's width from the conversation's right", () => {
    assert.deepEqual(splitOpenStrip(main, 1280), {
      attach: { left: 280, top: 35, right: 1024, bottom: 800 },
      open: { left: 1024, top: 35, right: 1280, bottom: 800 },
    });
  });

  test('takes at least 160 px, and at most 40 % of the conversation', () => {
    assert.equal(splitOpenStrip(main, 600).open.left, 1280 - 160);
    const narrow = { left: 280, top: 35, right: 680, bottom: 800 };
    assert.equal(splitOpenStrip(narrow, 1920).open.left, 680 - 160);
  });
});

describe('mentionText', () => {
  test('writes @ and the path with forward slashes', () => {
    assert.equal(mentionText('src\\a.ts'), '@src/a.ts');
    assert.equal(mentionText('attachments/notes.txt'), '@attachments/notes.txt');
  });

  test('quotes a path with white space, as the extension does', () => {
    assert.equal(mentionText('attachments\\notes (1).txt'), '@"attachments/notes (1).txt"');
  });
});
