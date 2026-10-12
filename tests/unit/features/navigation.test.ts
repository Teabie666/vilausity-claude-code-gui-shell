import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { NavigationHistory } from '../../../src/features/navigation/history';

const same = (a: string, b: string) => a === b;

describe('NavigationHistory', () => {
  test('push records the latest entry as current', () => {
    const history = new NavigationHistory<string>(same);
    history.push('a');
    history.push('b');
    history.push('c');
    assert.equal(history.current, 'c');
  });

  test('pushing the entry that is already current changes nothing', () => {
    const history = new NavigationHistory<string>(same);
    history.push('a');
    history.push('b');
    history.push('c');
    history.push('c');
    assert.equal(history.current, 'c');
    assert.equal(
      history.back(() => true),
      'b',
    );
  });

  test('back and forward walk the entries; past either end they return undefined without moving', () => {
    const history = new NavigationHistory<string>(same);
    history.push('a');
    history.push('b');
    history.push('c');
    assert.equal(
      history.back(() => true),
      'b',
    );
    assert.equal(
      history.back(() => true),
      'a',
    );
    assert.equal(
      history.back(() => true),
      undefined,
    );
    assert.equal(history.current, 'a');
    assert.equal(
      history.forward(() => true),
      'b',
    );
    assert.equal(
      history.forward(() => true),
      'c',
    );
    assert.equal(
      history.forward(() => true),
      undefined,
    );
  });

  test('back skips entries usable rejects and stops at the nearest accepted one', () => {
    const history = new NavigationHistory<string>(same);
    history.push('a');
    history.push('b');
    history.push('c');
    assert.equal(
      history.back((entry) => entry !== 'b'),
      'a',
    );
    assert.equal(history.current, 'a');
  });

  test('back returns undefined and stays put when nothing back is usable', () => {
    const history = new NavigationHistory<string>(same);
    history.push('a');
    history.push('b');
    history.push('c');
    assert.equal(
      history.back(() => false),
      undefined,
    );
    assert.equal(history.current, 'c');
  });

  test('pushing after going back drops the entries that were ahead', () => {
    const history = new NavigationHistory<string>(same);
    history.push('a');
    history.push('b');
    history.push('c');
    assert.equal(
      history.back(() => true),
      'b',
    );
    history.push('d');
    assert.equal(
      history.forward(() => true),
      undefined,
    );
    assert.equal(
      history.back(() => true),
      'b',
    );
    assert.equal(
      history.back(() => true),
      'a',
    );
  });

  test('pushing the entry reached by back changes nothing and forward still reaches the old tail', () => {
    const history = new NavigationHistory<string>(same);
    history.push('a');
    history.push('b');
    history.push('c');
    assert.equal(
      history.back(() => true),
      'b',
    );
    history.push('b');
    assert.equal(
      history.forward(() => true),
      'c',
    );
  });

  test('the limit drops the oldest entry as new ones are pushed', () => {
    const history = new NavigationHistory<string>(same, 3);
    history.push('a');
    history.push('b');
    history.push('c');
    history.push('d');
    assert.equal(
      history.back(() => true),
      'c',
    );
    assert.equal(
      history.back(() => true),
      'b',
    );
    assert.equal(
      history.back(() => true),
      undefined,
    );
  });

  describe('remove', () => {
    test('removing another entry keeps the position on the entry it pointed at', () => {
      const history = new NavigationHistory<string>(same);
      history.push('a');
      history.push('b');
      history.push('c');
      history.remove((entry) => entry === 'a');
      assert.equal(history.current, 'c');
      assert.equal(
        history.back(() => true),
        'b',
      );
    });

    test('removing the current entry falls back to the entry before it', () => {
      const history = new NavigationHistory<string>(same);
      history.push('a');
      history.push('b');
      history.push('c');
      history.remove((entry) => entry === 'c');
      assert.equal(history.current, 'b');
    });

    test('entries that end up adjacent and equal are merged into one', () => {
      const history = new NavigationHistory<string>(same);
      history.push('a');
      history.push('b');
      history.push('a');
      history.push('c');
      history.remove((entry) => entry === 'b');
      assert.equal(history.current, 'c');
      assert.equal(
        history.back(() => true),
        'a',
      );
      assert.equal(
        history.back(() => true),
        undefined,
      );
    });

    test('removing everything leaves an empty history that still works after a push', () => {
      const history = new NavigationHistory<string>(same);
      history.push('a');
      history.push('b');
      history.push('c');
      history.remove(() => true);
      assert.equal(history.current, undefined);
      assert.equal(
        history.back(() => true),
        undefined,
      );
      assert.equal(
        history.forward(() => true),
        undefined,
      );
      history.push('x');
      assert.equal(history.current, 'x');
    });
  });

  test('previous returns the nearest usable entry at or before the position without moving', () => {
    const history = new NavigationHistory<string>(same);
    history.push('a');
    history.push('b');
    history.push('c');
    assert.equal(
      history.previous((entry) => entry === 'a'),
      'a',
    );
    assert.equal(history.current, 'c');
    assert.equal(
      history.back(() => true),
      'b',
    );
  });

  test('previous includes the current entry and returns undefined when nothing is usable', () => {
    const history = new NavigationHistory<string>(same);
    history.push('a');
    history.push('b');
    assert.equal(
      history.previous(() => true),
      'b',
    );
    assert.equal(
      history.previous(() => false),
      undefined,
    );
  });
});
