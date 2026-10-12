import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CancellationToken, CancellationTokenSource } from '../../../src/platform/cancellation';

describe('CancellationTokenSource', () => {
  test('cancelling after taking the token flips the flag and fires the listener once', () => {
    const source = new CancellationTokenSource();
    const token = source.token;
    assert.equal(token.isCancellationRequested, false);

    let fired = 0;
    token.onCancellationRequested(() => {
      fired++;
    });

    source.cancel();
    assert.equal(token.isCancellationRequested, true);
    assert.equal(fired, 1);

    source.cancel();
    assert.equal(fired, 1);
  });

  test('cancelling before taking the token yields the Cancelled token', () => {
    const source = new CancellationTokenSource();
    source.cancel();
    const token = source.token;
    assert.equal(token, CancellationToken.Cancelled);
    assert.equal(token.isCancellationRequested, true);
  });

  test('dispose(true) cancels the token', () => {
    const source = new CancellationTokenSource();
    const token = source.token;
    let fired = 0;
    token.onCancellationRequested(() => {
      fired++;
    });

    source.dispose(true);
    assert.equal(token.isCancellationRequested, true);
    assert.equal(fired, 1);
  });

  test('a listener added after cancellation is called once, asynchronously', async () => {
    const source = new CancellationTokenSource();
    const token = source.token;
    source.cancel();
    let fired = 0;
    token.onCancellationRequested(() => {
      fired++;
    });
    assert.equal(fired, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fired, 1);
  });

  test('dispose() without cancel leaves the token active', () => {
    const source = new CancellationTokenSource();
    const token = source.token;
    source.dispose();
    assert.equal(token.isCancellationRequested, false);
  });
});

describe('CancellationToken', () => {
  test('CancellationToken.None never fires', async () => {
    let fired = false;
    const sub = CancellationToken.None.onCancellationRequested(() => {
      fired = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fired, false);
    sub.dispose();
  });

  test('CancellationToken.Cancelled fires its listener asynchronously', async () => {
    let fired = false;
    const sub = CancellationToken.Cancelled.onCancellationRequested(() => {
      fired = true;
    });
    assert.equal(fired, false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fired, true);
    sub.dispose();
  });
});
