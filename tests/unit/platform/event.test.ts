import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Emitter, Event, setUnexpectedErrorHandler } from '../../../src/platform/event';
import { DisposableStore, type IDisposable } from '../../../src/platform/lifecycle';

describe('Emitter', () => {
  test('fire delivers the value to every listener in subscription order', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    emitter.event((n) => seen.push(n));
    emitter.event((n) => seen.push(n * 10));
    emitter.fire(3);
    assert.deepEqual(seen, [3, 30]);
  });

  test('the subscription disposable removes the listener', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    const sub = emitter.event((n) => seen.push(n));
    emitter.fire(1);
    sub.dispose();
    emitter.fire(2);
    assert.deepEqual(seen, [1]);
  });

  test('the listener runs with the provided thisArgs', () => {
    const emitter = new Emitter<number>();
    const context = { tag: 'ctx' };
    let receivedThis: unknown;
    emitter.event(function (this: unknown) {
      // What the test is about.
      // oxlint-disable-next-line typescript/no-this-alias
      receivedThis = this;
    }, context);
    emitter.fire(1);
    assert.equal(receivedThis, context);
  });

  test('a disposables array collects the subscription', () => {
    const emitter = new Emitter<void>();
    const disposables: IDisposable[] = [];
    let count = 0;
    emitter.event(() => { count++; }, undefined, disposables);
    assert.equal(disposables.length, 1);
    emitter.fire(undefined);
    assert.equal(count, 1);
    disposables[0].dispose();
    emitter.fire(undefined);
    assert.equal(count, 1);
  });

  test('a DisposableStore collects the subscription', () => {
    const emitter = new Emitter<void>();
    const store = new DisposableStore();
    let count = 0;
    emitter.event(() => { count++; }, undefined, store);
    emitter.fire(undefined);
    assert.equal(count, 1);
    store.dispose();
    emitter.fire(undefined);
    assert.equal(count, 1);
  });

  test('a throwing listener does not stop later listeners and reports to onListenerError', () => {
    const reported: unknown[] = [];
    const emitter = new Emitter<void>({ onListenerError: (e) => reported.push(e) });
    const seen: number[] = [];
    emitter.event(() => { throw new Error('first boom'); });
    emitter.event(() => { seen.push(2); });
    emitter.fire(undefined);
    assert.deepEqual(seen, [2]);
    assert.equal(reported.length, 1);
    assert.match((reported[0] as Error).message, /first boom/);
  });

  test('setUnexpectedErrorHandler receives listener errors when no onListenerError is set', () => {
    const reported: unknown[] = [];
    const previous = setUnexpectedErrorHandler((e) => reported.push(e));
    try {
      const emitter = new Emitter<void>();
      emitter.event(() => { throw new Error('global boom'); });
      emitter.fire(undefined);
      assert.equal(reported.length, 1);
      assert.match((reported[0] as Error).message, /global boom/);
    } finally {
      setUnexpectedErrorHandler(previous);
    }
  });

  test('a disposed emitter no longer fires and rejects later listeners', () => {
    const emitter = new Emitter<number>();
    let count = 0;
    emitter.event(() => { count++; });
    emitter.dispose();
    emitter.fire(1);
    assert.equal(count, 0);
    const sub = emitter.event(() => { count++; });
    emitter.fire(1);
    assert.equal(count, 0);
    sub.dispose();
  });

  test('onFirstListenerAdd and onLastListenerRemove fire at the right times', () => {
    const calls: string[] = [];
    const emitter = new Emitter<void>({
      onFirstListenerAdd: () => calls.push('first'),
      onLastListenerRemove: () => calls.push('last'),
    });
    const a = emitter.event(() => {});
    assert.deepEqual(calls, ['first']);
    const b = emitter.event(() => {});
    assert.deepEqual(calls, ['first']);
    a.dispose();
    assert.deepEqual(calls, ['first']);
    b.dispose();
    assert.deepEqual(calls, ['first', 'last']);
  });
});

describe('Event', () => {
  test('Event.once fires the listener only on the first event', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    Event.once(emitter.event)((n) => seen.push(n));
    emitter.fire(1);
    emitter.fire(2);
    assert.deepEqual(seen, [1]);
  });

  test('Event.once copes with an event that fires while it is being subscribed to', () => {
    let disposed = 0;
    const firesOnSubscribe: Event<number> = (listener, thisArgs) => {
      listener.call(thisArgs, 1);
      listener.call(thisArgs, 2);
      return { dispose: () => { disposed++; } };
    };
    const seen: number[] = [];
    Event.once(firesOnSubscribe)((n) => seen.push(n));
    assert.deepEqual(seen, [1]);
    assert.equal(disposed, 1);
  });

  test('Event.toPromise resolves with the first emitted value', async () => {
    const emitter = new Emitter<string>();
    const promise = Event.toPromise(emitter.event);
    emitter.fire('hello');
    assert.equal(await promise, 'hello');
  });
});
