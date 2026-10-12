import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RpcEndpoint, RemoteError, type MessageTransport } from '../../../src/platform/ipc';

type TestApi = {
  add: (p: { a: number; b: number }) => number;
  slow: (p: { value: string }) => Promise<string>;
  fail: (p: { message: string }) => string;
  portEcho: (p: { n: number }) => number;
  unhandled: (p: void) => void;
};

interface TransportPair {
  readonly left: MessageTransport;
  readonly right: MessageTransport;
  readonly leftSent: unknown[];
  readonly rightSent: unknown[];
}

/** Two transports wired back to back; delivery is async and crosses structuredClone. */
function createTransportPair(): TransportPair {
  const leftSent: unknown[] = [];
  const rightSent: unknown[] = [];
  let leftHandler: ((message: unknown, ports: readonly unknown[]) => void) | undefined;
  let rightHandler: ((message: unknown, ports: readonly unknown[]) => void) | undefined;

  const deliver = (
    target: ((message: unknown, ports: readonly unknown[]) => void) | undefined,
    message: unknown,
    ports: readonly unknown[],
  ) => {
    setTimeout(() => target?.(structuredClone(message), ports), 0);
  };

  const left: MessageTransport = {
    send(message, transfer) {
      leftSent.push(message);
      deliver(rightHandler, message, transfer ?? []);
    },
    listen(handler) {
      leftHandler = handler;
      return {
        dispose: () => {
          leftHandler = undefined;
        },
      };
    },
  };

  const right: MessageTransport = {
    send(message, transfer) {
      rightSent.push(message);
      deliver(leftHandler, message, transfer ?? []);
    },
    listen(handler) {
      rightHandler = handler;
      return {
        dispose: () => {
          rightHandler = undefined;
        },
      };
    },
  };

  return { left, right, leftSent, rightSent };
}

/** Awaits the promise and returns the rejection reason, or throws if it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('RpcEndpoint', () => {
  test('call resolves with the value returned by the remote handler', async () => {
    const pair = createTransportPair();
    const caller = new RpcEndpoint<TestApi, TestApi>(pair.left, 'caller');
    const callee = new RpcEndpoint<TestApi, TestApi>(pair.right, 'callee');
    callee.handle('add', ({ a, b }) => a + b);

    assert.equal(await caller.call('add', { a: 2, b: 3 }), 5);
  });

  test('a handler that returns a Promise is awaited before the call resolves', async () => {
    const pair = createTransportPair();
    const caller = new RpcEndpoint<TestApi, TestApi>(pair.left, 'caller');
    const callee = new RpcEndpoint<TestApi, TestApi>(pair.right, 'callee');
    callee.handle('slow', ({ value }) => Promise.resolve(`${value}!`));

    assert.equal(await caller.call('slow', { value: 'hi' }), 'hi!');
  });

  test('a throwing handler surfaces a RemoteError with method, remoteName and message', async () => {
    const pair = createTransportPair();
    const caller = new RpcEndpoint<TestApi, TestApi>(pair.left, 'caller');
    const callee = new RpcEndpoint<TestApi, TestApi>(pair.right, 'callee');
    callee.handle('fail', ({ message }) => {
      throw new Error(message);
    });

    const error = await rejectionOf(caller.call('fail', { message: 'boom' }));
    assert.ok(error instanceof RemoteError);
    assert.equal(error.method, 'fail');
    assert.equal(error.remoteName, 'Error');
    assert.equal(error.message, 'boom');
    assert.equal(typeof error.remoteStack, 'string');
    assert.match(error.remoteStack ?? '', /boom/);
  });

  test('notify delivers params and produces no response', async () => {
    const pair = createTransportPair();
    const caller = new RpcEndpoint<TestApi, TestApi>(pair.left, 'caller');
    const callee = new RpcEndpoint<TestApi, TestApi>(pair.right, 'callee');
    let received: { a: number; b: number } | undefined;
    callee.handle('add', (params) => {
      received = params;
      return params.a + params.b;
    });

    caller.notify('add', { a: 7, b: 8 });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(received, { a: 7, b: 8 });
    assert.equal(pair.rightSent.length, 0);
  });

  test('calling a method the other side never registered rejects', async () => {
    const pair = createTransportPair();
    const caller = new RpcEndpoint<TestApi, TestApi>(pair.left, 'caller');
    const callee = new RpcEndpoint<TestApi, TestApi>(pair.right, 'callee');
    callee.handle('add', ({ a, b }) => a + b);

    const error = await rejectionOf(caller.call('unhandled', undefined));
    assert.ok(error instanceof RemoteError);
    assert.equal(error.remoteName, 'Error');
    assert.equal(error.message, 'No handler for unhandled');
  });

  test('registering the same method twice throws', () => {
    const pair = createTransportPair();
    const callee = new RpcEndpoint<TestApi, TestApi>(pair.right, 'callee');
    callee.handle('add', ({ a, b }) => a + b);

    assert.throws(() => callee.handle('add', ({ a, b }) => a * b), /registered twice/);
  });

  test('the disposable returned by handle unregisters the handler', async () => {
    const pair = createTransportPair();
    const caller = new RpcEndpoint<TestApi, TestApi>(pair.left, 'caller');
    const callee = new RpcEndpoint<TestApi, TestApi>(pair.right, 'callee');
    const registration = callee.handle('add', ({ a, b }) => a + b);

    assert.equal(await caller.call('add', { a: 1, b: 2 }), 3);
    registration.dispose();

    const error = await rejectionOf(caller.call('add', { a: 1, b: 2 }));
    assert.ok(error instanceof RemoteError);
    assert.equal(error.message, 'No handler for add');
  });

  test('dispose rejects a pending call and any later call', async () => {
    const pair = createTransportPair();
    const caller = new RpcEndpoint<TestApi, TestApi>(pair.left, 'caller');

    const pending = caller.call('add', { a: 1, b: 2 });
    caller.dispose();

    const pendingError = await rejectionOf(pending);
    assert.ok(pendingError instanceof Error);
    assert.match(pendingError.message, /endpoint disposed/);

    const laterError = await rejectionOf(caller.call('add', { a: 1, b: 2 }));
    assert.ok(laterError instanceof Error);
    assert.match(laterError.message, /cannot call/);
  });

  test('a call that cannot be sent rejects with the local error, not a RemoteError', async () => {
    const sendError = new Error('could not be cloned');
    const failing: MessageTransport = {
      send() {
        throw sendError;
      },
      listen: () => ({ dispose: () => {} }),
    };
    const caller = new RpcEndpoint<TestApi, TestApi>(failing, 'caller');

    const error = await rejectionOf(caller.call('add', { a: 1, b: 2 }));
    assert.equal(error, sendError);
    assert.equal(error instanceof RemoteError, false);
  });

  test('malformed messages are ignored and the endpoint keeps working', async () => {
    const pair = createTransportPair();
    const caller = new RpcEndpoint<TestApi, TestApi>(pair.left, 'caller');
    const callee = new RpcEndpoint<TestApi, TestApi>(pair.right, 'callee');
    callee.handle('add', ({ a, b }) => a + b);

    pair.right.send(null);
    pair.right.send('garbage');
    pair.right.send({ t: 'q', m: 42 });
    pair.right.send({ t: 's', id: 'not-a-number' });

    assert.equal(await caller.call('add', { a: 40, b: 2 }), 42);
  });

  test('transfer ports reach the handler second argument', async () => {
    const pair = createTransportPair();
    const caller = new RpcEndpoint<TestApi, TestApi>(pair.left, 'caller');
    const callee = new RpcEndpoint<TestApi, TestApi>(pair.right, 'callee');
    const port = { id: 'port-1' };
    let receivedPorts: readonly unknown[] | undefined;
    callee.handle('portEcho', (params, ports) => {
      receivedPorts = ports;
      return params.n;
    });

    assert.equal(await caller.call('portEcho', { n: 5 }, [port]), 5);
    assert.equal(receivedPorts?.[0], port);
  });
});
