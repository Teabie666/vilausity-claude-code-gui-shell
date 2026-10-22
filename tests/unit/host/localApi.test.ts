import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalApiServer, type LocalApiServerOptions } from '../../../src/host/main/localApiServer';
import { LocalApi, portSetting, type ApiWindowTarget, type LocalApiOptions } from '../../../src/host/main/localApi';
import {
  builtInOperations,
  conversationEvents,
  usageScope,
  type ConversationTarget,
  type OperationsHost,
} from '../../../src/host/main/localApiOperations';
import { API_ALLOW_SEND_SETTING, API_ENABLED_SETTING, API_PORT_SETTING, ApiError } from '../../../src/platform/localApi';
import { NullLogger } from '../../../src/platform/log';
import type { ConversationRequest, ConversationStateDto, SessionSearchRequest } from '../../../src/platform/protocol';
import type { ProviderPricing } from '../../../src/platform/pricing';
import type { ModelTokens } from '../../../src/platform/usage';

const TOKEN = 'test-token';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vilaus-localapi-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

interface RawResponse {
  status: number;
  json: Record<string, unknown> | null;
  text: string;
}

/** A bare request over node:http, so Host and Origin can be set freely. */
function raw(port: number, method: string, requestPath: string, headers: Record<string, string>, body?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });
      response.on('end', () => {
        let json: Record<string, unknown> | null;
        try {
          json = JSON.parse(text) as Record<string, unknown> | null;
        } catch {
          json = null;
        }
        resolve({ status: response.statusCode ?? 0, json, text });
      });
    });
    request.on('error', reject);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

function defaultServer(options: Partial<LocalApiServerOptions>): LocalApiServer {
  return new LocalApiServer({
    token: TOKEN,
    operation: () => undefined,
    listing: () => ({ hello: 'world' }),
    refusal: () => undefined,
    greeting: () => [],
    logger: NullLogger,
    ...options,
  });
}

async function withServer(
  options: Partial<LocalApiServerOptions>,
  run: (port: number, server: LocalApiServer) => Promise<void>,
): Promise<void> {
  const server = defaultServer(options);
  const port = await server.listen(0);
  try {
    await run(port, server);
  } finally {
    await server.close();
  }
}

interface EventStream {
  text(): string;
  waitFor(fragment: string): Promise<void>;
  end: Promise<void>;
}

function eventStream(port: number): Promise<EventStream> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/v1/events', headers: auth(TOKEN) }, (response) => {
      let text = '';
      let finished = false;
      let finishEnd: (() => void) | undefined;
      const end = new Promise<void>((r) => {
        finishEnd = r;
      });
      const waiters = new Set<{ fragment: string; resolve: () => void }>();
      const settle = (): void => {
        for (const waiter of waiters) {
          waiter.resolve();
        }
        waiters.clear();
      };
      const done = (): void => {
        if (finished) {
          return;
        }
        finished = true;
        settle();
        finishEnd?.();
      };
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
        for (const waiter of [...waiters]) {
          if (text.includes(waiter.fragment)) {
            waiters.delete(waiter);
            waiter.resolve();
          }
        }
      });
      response.on('end', done);
      response.on('close', done);
      response.on('error', done);
      resolve({
        text: () => text,
        waitFor: (fragment) => {
          if (text.includes(fragment)) {
            return Promise.resolve();
          }
          return new Promise<void>((r) => {
            const waiter = { fragment, resolve: r };
            waiters.add(waiter);
            setTimeout(() => {
              if (waiters.delete(waiter)) {
                r();
              }
            }, 5_000).unref();
          });
        },
        end,
      });
    });
    request.on('error', reject);
    request.end();
  });
}

describe('LocalApiServer', () => {
  test('refuses a missing or wrong token with 401 unauthorized', async () => {
    await withServer({}, async (port) => {
      const none = await raw(port, 'GET', '/v1', {}, undefined);
      assert.equal(none.status, 401);
      assert.equal(none.json?.error, 'unauthorized');

      const wrong = await raw(port, 'GET', '/v1', auth('wrong-token'), undefined);
      assert.equal(wrong.status, 401);
      assert.equal(wrong.json?.error, 'unauthorized');
    });
  });

  test('refuses a request with an Origin header even with the token', async () => {
    await withServer({}, async (port) => {
      const res = await raw(port, 'GET', '/v1', { ...auth(TOKEN), Origin: 'https://evil.example' }, undefined);
      assert.equal(res.status, 403);
      assert.equal(res.json?.error, 'forbidden');
    });
  });

  test('refuses a Host header that is not this address', async () => {
    await withServer({}, async (port) => {
      const res = await raw(port, 'GET', '/v1', { ...auth(TOKEN), Host: 'evil.example:9999' }, undefined);
      assert.equal(res.status, 403);
      assert.equal(res.json?.error, 'forbidden');
    });
  });

  test('GET /v1 answers the listing', async () => {
    await withServer({ listing: () => ({ hello: 'world', n: 42 }) }, async (port) => {
      const res = await raw(port, 'GET', '/v1', auth(TOKEN), undefined);
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { hello: 'world', n: 42 });
    });
  });

  test('a read operation gets query params as strings and a POST body as an object', async () => {
    await withServer(
      {
        operation: (name) => (name === 'read' ? { name, access: 'read', description: '', handle: (params) => params } : undefined),
      },
      async (port) => {
        const get = await raw(port, 'GET', '/v1/read?a=1&b=true', auth(TOKEN), undefined);
        assert.equal(get.status, 200);
        assert.deepEqual(get.json, { a: '1', b: 'true' });

        const post = await raw(port, 'POST', '/v1/read', { ...auth(TOKEN), 'Content-Type': 'application/json' }, '{"a":1}');
        assert.equal(post.status, 200);
        assert.deepEqual(post.json, { a: 1 });
      },
    );
  });

  test('a write operation refuses GET, and POST takes no body, a JSON object, or errors', async () => {
    await withServer(
      {
        operation: (name) => (name === 'write' ? { name, access: 'write', description: '', handle: (params) => params } : undefined),
      },
      async (port) => {
        const get = await raw(port, 'GET', '/v1/write', auth(TOKEN), undefined);
        assert.equal(get.status, 405);
        assert.equal(get.json?.error, 'method_not_allowed');

        const empty = await raw(port, 'POST', '/v1/write', auth(TOKEN), '');
        assert.equal(empty.status, 200);
        assert.deepEqual(empty.json, {});

        const bad = await raw(port, 'POST', '/v1/write', auth(TOKEN), 'not json');
        assert.equal(bad.status, 400);
        assert.equal(bad.json?.error, 'bad_request');

        const array = await raw(port, 'POST', '/v1/write', auth(TOKEN), '[1,2]');
        assert.equal(array.status, 400);
        assert.equal(array.json?.error, 'bad_request');
      },
    );
  });

  test('an unknown operation or a path outside /v1 answers 404', async () => {
    await withServer({}, async (port) => {
      const unknown = await raw(port, 'GET', '/v1/nope', auth(TOKEN), undefined);
      assert.equal(unknown.status, 404);
      assert.equal(unknown.json?.error, 'unknown_operation');

      const other = await raw(port, 'GET', '/other', auth(TOKEN), undefined);
      assert.equal(other.status, 404);
      assert.equal(other.json?.error, 'not_found');

      const garbled = await raw(port, 'GET', '/v1/%E0%A4%A', auth(TOKEN), undefined);
      assert.equal(garbled.status, 400);
    });
  });

  test('a refused operation answers 403 without calling its handle', async () => {
    let called = false;
    await withServer(
      {
        operation: (name) =>
          name === 'write'
            ? {
                name,
                access: 'write',
                description: '',
                handle: () => {
                  called = true;
                },
              }
            : undefined,
        refusal: (access) => (access === 'write' ? 'nope' : undefined),
      },
      async (port) => {
        const res = await raw(port, 'POST', '/v1/write', auth(TOKEN), '{}');
        assert.equal(res.status, 403);
        assert.equal(res.json?.error, 'forbidden');
        assert.equal(res.json?.message, 'nope');
        assert.equal(called, false);
      },
    );
  });

  test('maps an ApiError to its status and another error to 500 internal', async () => {
    await withServer(
      {
        operation: (name) =>
          name === 'conflict'
            ? {
                name,
                access: 'read',
                description: '',
                handle: () => {
                  throw new ApiError(409, 'conflict', 'gone');
                },
              }
            : name === 'boom'
              ? {
                  name,
                  access: 'read',
                  description: '',
                  handle: () => {
                    throw new Error('boom');
                  },
                }
              : undefined,
      },
      async (port) => {
        const conflict = await raw(port, 'GET', '/v1/conflict', auth(TOKEN), undefined);
        assert.equal(conflict.status, 409);
        assert.deepEqual(conflict.json, { error: 'conflict', message: 'gone' });

        const internal = await raw(port, 'GET', '/v1/boom', auth(TOKEN), undefined);
        assert.equal(internal.status, 500);
        assert.equal(internal.json?.error, 'internal');
      },
    );
  });

  test('a handle that returns undefined answers null', async () => {
    await withServer({ operation: (name) => ({ name, access: 'read', description: '', handle: () => undefined }) }, async (port) => {
      const res = await raw(port, 'GET', '/v1/x', auth(TOKEN), undefined);
      assert.equal(res.status, 200);
      assert.equal(res.json, null);
    });
  });

  test('the event stream sends connected, the greeting and later events, and ends on close', async () => {
    const server = defaultServer({ greeting: () => [{ name: 'hello', data: { a: 1 } }] });
    const port = await server.listen(0);
    const stream = await eventStream(port);
    try {
      await stream.waitFor(': connected');
      await stream.waitFor('event: hello\ndata: {"a":1}\n\n');
      assert.ok(stream.text().indexOf(': connected') < stream.text().indexOf('event: hello'));

      server.emit({ name: 'later', data: 'x' });
      await stream.waitFor('event: later\ndata: "x"\n\n');
    } finally {
      await server.close();
    }
    await stream.end;
  });
});

interface LocalApiFixture {
  api: LocalApi;
  settings: Record<string, unknown>;
  windows: Map<number, ApiWindowTarget>;
}

function makeApi(overrides: Partial<LocalApiOptions> = {}): LocalApiFixture {
  const settings: Record<string, unknown> = {};
  const windows = new Map<number, ApiWindowTarget>();
  const api = new LocalApi({
    discoveryFile: path.join(fs.mkdtempSync(path.join(root, 'api-')), 'api.json'),
    elevated: false,
    version: '1.2.3',
    settings: () => settings,
    window: (id) => (id === undefined ? undefined : windows.get(id)),
    greeting: () => [],
    info: () => ({ app: 'vilaus' }),
    logger: NullLogger,
    ...overrides,
  });
  return { api, settings, windows };
}

describe('LocalApi', () => {
  test('does not listen while disabled', async () => {
    const { api, settings } = makeApi();
    settings[API_ENABLED_SETTING] = false;
    await api.apply();
    assert.equal(api.status.url, undefined);
    api.dispose();
  });

  test('serves once enabled, writing api.json and answering GET /v1', async () => {
    const { api, settings } = makeApi();
    settings[API_ENABLED_SETTING] = true;
    await api.apply();

    const status = api.status;
    assert.ok(status.url);
    const discovery = JSON.parse(fs.readFileSync(status.file, 'utf8')) as Record<string, unknown>;
    const token = discovery.token as string;
    const port = discovery.port as number;

    assert.equal(discovery.url, status.url);
    assert.equal(port, Number(new URL(status.url).port));
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(discovery.pid, process.pid);
    assert.equal(discovery.version, '1.2.3');
    assert.equal(discovery.elevated, false);

    const res = await raw(port, 'GET', '/v1', auth(token), undefined);
    assert.equal(res.status, 200);
    assert.equal(res.json?.app, 'vilaus');
    assert.ok(Array.isArray(res.json?.operations));

    settings[API_ENABLED_SETTING] = false;
    await api.apply();
    api.dispose();
  });

  test('keeps the token and api.json across a stop and a restart', async () => {
    const { api, settings } = makeApi();
    settings[API_ENABLED_SETTING] = true;
    await api.apply();
    const first = JSON.parse(fs.readFileSync(api.status.file, 'utf8')) as Record<string, unknown>;
    const firstToken = first.token as string;
    const firstPort = first.port as number;

    settings[API_ENABLED_SETTING] = false;
    await api.apply();
    assert.equal(api.status.url, undefined);
    await assert.rejects(async () => raw(firstPort, 'GET', '/v1', auth(firstToken), undefined));
    assert.ok(fs.existsSync(api.status.file));

    settings[API_ENABLED_SETTING] = true;
    await api.apply();
    const second = JSON.parse(fs.readFileSync(api.status.file, 'utf8')) as Record<string, unknown>;
    assert.equal(second.token, firstToken);

    settings[API_ENABLED_SETTING] = false;
    await api.apply();
    api.dispose();
  });

  test('serves on another port when the configured one is taken', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as AddressInfo).port;

    const { api, settings } = makeApi();
    settings[API_ENABLED_SETTING] = true;
    settings[API_PORT_SETTING] = taken;
    await api.apply();

    const status = api.status;
    assert.ok(status.url);
    assert.notEqual(Number(new URL(status.url).port), taken);

    const discovery = JSON.parse(fs.readFileSync(status.file, 'utf8')) as Record<string, unknown>;
    const res = await raw(discovery.port as number, 'GET', '/v1', auth(discovery.token as string), undefined);
    assert.equal(res.status, 200);

    settings[API_ENABLED_SETTING] = false;
    await api.apply();
    api.dispose();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  test('refusal allows reads, blocks send unless allowed, and blocks writes when elevated', () => {
    const { api, settings } = makeApi();
    assert.equal(api.refusal('read'), undefined);
    assert.equal(api.refusal('write'), undefined);
    assert.ok(api.refusal('send'));

    settings[API_ALLOW_SEND_SETTING] = true;
    assert.equal(api.refusal('send'), undefined);
    api.dispose();

    const elevated = new LocalApi({
      discoveryFile: path.join(fs.mkdtempSync(path.join(root, 'api-')), 'api.json'),
      elevated: true,
      version: '1.2.3',
      settings: () => ({}),
      window: () => undefined,
      greeting: () => [],
      info: () => ({}),
      logger: NullLogger,
    });
    assert.equal(elevated.refusal('read'), undefined);
    assert.ok(elevated.refusal('write'));
    assert.ok(elevated.refusal('send'));
    elevated.dispose();
  });

  test('operation serves main operations and synthesizes page operations', async () => {
    const { api, windows } = makeApi();
    api.registerOperations([{ name: 'main.op', access: 'read', description: '', handle: () => 1 }]);
    const targetOne: ApiWindowTarget = { id: 1, call: async (name, params) => ({ name, params }) };
    const targetTwo: ApiWindowTarget = {
      id: 2,
      call: async () => {
        throw new Error('unexpected');
      },
    };
    windows.set(1, targetOne);
    windows.set(2, targetTwo);
    api.setPageOperations(1, [{ name: 'page.op', access: 'write', description: '' }]);

    assert.equal(api.operation('main.op')?.handle({}), 1);

    const page = api.operation('page.op');
    assert.ok(page);
    await assert.rejects(
      async () => page.handle({}),
      (error) => error instanceof ApiError && error.status === 404 && error.code === 'no_window',
    );
    await assert.rejects(
      async () => page.handle({ window: 0 }),
      (error) => error instanceof ApiError && error.status === 400,
    );
    await assert.rejects(
      async () => page.handle({ window: 2 }),
      (error) => error instanceof ApiError && error.code === 'unknown_operation',
    );
    assert.deepEqual(await page.handle({ window: 1 }), { name: 'page.op', params: { window: 1 } });

    api.windowClosed(1);
    assert.equal(api.operation('page.op'), undefined);

    api.dispose();
  });

  test('listing merges main and page operations, sorted, each once, with availability', () => {
    const { api } = makeApi();
    api.registerOperations([
      { name: 'z.main', access: 'write', description: 'z', handle: () => undefined },
      { name: 'a.main', access: 'read', description: 'a', handle: () => undefined },
    ]);
    api.setPageOperations(1, [{ name: 'a.main', access: 'write', description: 'page' }]);
    api.setPageOperations(2, [{ name: 'b.page', access: 'send', description: 'b' }]);

    const listing = api.listing();
    assert.equal(listing.app, 'vilaus');
    const operations = listing.operations as Array<{ name: string; access: string; available: boolean }>;
    assert.deepEqual(
      operations.map((operation) => operation.name),
      ['a.main', 'b.page', 'z.main'],
    );

    assert.equal(operations[0]?.access, 'read');
    assert.equal(operations[0]?.available, true);
    assert.equal(operations[1]?.access, 'send');
    assert.equal(operations[1]?.available, false);
    assert.equal(operations[2]?.access, 'write');
    assert.equal(operations[2]?.available, true);

    api.dispose();
  });

  test('registerOperations throws on a duplicate name', () => {
    const { api } = makeApi();
    api.registerOperations([{ name: 'x', access: 'read', description: '', handle: () => undefined }]);
    assert.throws(
      () => api.registerOperations([{ name: 'x', access: 'read', description: '', handle: () => undefined }]),
      /registered twice/,
    );
    api.dispose();
  });
});

describe('portSetting', () => {
  test('keeps a valid port and maps everything else to 0', () => {
    assert.equal(portSetting(8080), 8080);
    assert.equal(portSetting(0), 0);
    assert.equal(portSetting(-1), 0);
    assert.equal(portSetting(8080.5), 0);
    assert.equal(portSetting('8080'), 0);
    assert.equal(portSetting(70000), 0);
  });
});

describe('builtInOperations', () => {
  interface HostCalls {
    openFolder: string[];
    openFile: Array<{ file: string; line: number | undefined; column: number | undefined }>;
    openConversation: Array<{ target: ConversationTarget; request: ConversationRequest }>;
    sendPrompt: Array<{ target: ConversationTarget; request: { sessionId?: string; prompt: string } }>;
    searchSessions: SessionSearchRequest[];
    focusWindow: number[];
    usage: Array<number | undefined>;
  }

  function fakeHost(overrides: Partial<OperationsHost> = {}): { host: OperationsHost; calls: HostCalls } {
    const calls: HostCalls = {
      openFolder: [],
      openFile: [],
      openConversation: [],
      sendPrompt: [],
      searchSessions: [],
      focusWindow: [],
      usage: [],
    };
    const host: OperationsHost = {
      windows: () => [],
      focusWindow: (id) => {
        calls.focusWindow.push(id);
        return true;
      },
      openFolder: async (folder) => {
        calls.openFolder.push(folder);
        return 3;
      },
      openFile: (file, line, column) => {
        calls.openFile.push({ file, line, column });
        return 5;
      },
      openConversation: async (target, request) => {
        calls.openConversation.push({ target, request });
        return 7;
      },
      searchSessions: async (request) => {
        calls.searchSessions.push(request);
        return [];
      },
      usage: async (window) => {
        calls.usage.push(window);
        return null;
      },
      sendPrompt: async (target, request) => {
        calls.sendPrompt.push({ target, request });
        return { window: 7, result: { outcome: 'sent', sessionId: 'S' } };
      },
      ...overrides,
    };
    return { host, calls };
  }

  function op(host: OperationsHost, name: string) {
    const found = builtInOperations(host).find((candidate) => candidate.name === name);
    assert.ok(found, `no operation ${name}`);
    return found;
  }

  test('folders.open requires an absolute folder and reports the window', async () => {
    const { host, calls } = fakeHost();
    const open = op(host, 'folders.open');
    await assert.rejects(
      async () => open.handle({}),
      (error) => error instanceof ApiError && error.status === 400,
    );
    await assert.rejects(
      async () => open.handle({ folder: 'rel' }),
      (error) => error instanceof ApiError && error.status === 400,
    );

    const missing = fakeHost({ openFolder: async () => undefined });
    await assert.rejects(
      async () => op(missing.host, 'folders.open').handle({ folder: 'C:\\missing' }),
      (error) => error instanceof ApiError && error.status === 404 && error.code === 'not_found',
    );

    assert.deepEqual(await open.handle({ folder: 'C:\\a\\..\\b' }), { window: 3 });
    assert.deepEqual(calls.openFolder, [path.normalize('C:\\a\\..\\b')]);
  });

  test('files.open parses line and column as positive integers', () => {
    const { host, calls } = fakeHost();
    const open = op(host, 'files.open');
    assert.deepEqual(open.handle({ path: 'C:\\f.ts', line: '12', column: '3' }), { window: 5 });
    assert.deepEqual(calls.openFile, [{ file: path.normalize('C:\\f.ts'), line: 12, column: 3 }]);

    assert.throws(
      () => open.handle({ path: 'C:\\f.ts', line: '0' }),
      (error) => error instanceof ApiError && error.status === 400,
    );
    assert.throws(
      () => open.handle({ path: 'C:\\f.ts', line: 'x' }),
      (error) => error instanceof ApiError && error.status === 400,
    );
  });

  test('conversations.open checks the session id, target and prompt, then opens', async () => {
    const { host, calls } = fakeHost();
    const open = op(host, 'conversations.open');
    const uuid = '123e4567-e89b-12d3-a456-426614174000';

    await assert.rejects(
      async () => open.handle({ sessionId: 'nope' }),
      (error) => error instanceof ApiError && error.status === 400,
    );
    await assert.rejects(
      async () => open.handle({ folder: 'C:\\w', window: 1 }),
      (error) => error instanceof ApiError && error.status === 400,
    );
    await assert.rejects(
      async () => open.handle({ prompt: 'x'.repeat(100_001) }),
      (error) => error instanceof ApiError && error.status === 400,
    );

    assert.deepEqual(await open.handle({ folder: 'C:\\w', sessionId: uuid, prompt: 'hi' }), { window: 7 });
    assert.deepEqual(calls.openConversation, [
      { target: { folder: path.normalize('C:\\w'), window: undefined }, request: { sessionId: uuid, prompt: 'hi' } },
    ]);

    const missing = fakeHost({ openConversation: async () => undefined });
    await assert.rejects(
      async () => op(missing.host, 'conversations.open').handle({ folder: 'C:\\w' }),
      (error) => error instanceof ApiError && error.code === 'not_found',
    );
    await assert.rejects(
      async () => op(missing.host, 'conversations.open').handle({}),
      (error) => error instanceof ApiError && error.code === 'no_window',
    );
  });

  test('sessions.search defaults and clamps the limit and requires an absolute folder', async () => {
    const { host, calls } = fakeHost();
    const search = op(host, 'sessions.search');

    await search.handle({});
    assert.deepEqual(calls.searchSessions, [{ query: '', folder: undefined, limit: 20 }]);

    await search.handle({ query: 'hi', limit: '250' });
    assert.deepEqual(calls.searchSessions[1], { query: 'hi', folder: undefined, limit: 100 });

    assert.throws(
      () => search.handle({ folder: 'rel' }),
      (error) => error instanceof ApiError && error.status === 400,
    );
  });

  test('windows.focus requires a window and reports a missing one', () => {
    const { host, calls } = fakeHost();
    const focus = op(host, 'windows.focus');

    assert.throws(
      () => focus.handle({}),
      (error) => error instanceof ApiError && error.status === 400,
    );

    const missing = fakeHost({ focusWindow: () => false });
    assert.throws(
      () => op(missing.host, 'windows.focus').handle({ window: 9 }),
      (error) => error instanceof ApiError && error.status === 404,
    );

    assert.deepEqual(focus.handle({ window: 4 }), { window: 4 });
    assert.deepEqual(calls.focusWindow, [4]);
  });

  test('usage.get answers 404 without a window and null for a null usage', async () => {
    const { host, calls } = fakeHost();
    const usage = op(host, 'usage.get');

    const missing = fakeHost({ usage: async () => undefined });
    await assert.rejects(
      async () => op(missing.host, 'usage.get').handle({}),
      (error) => error instanceof ApiError && error.status === 404,
    );

    assert.equal(await usage.handle({}), null);
    assert.deepEqual(calls.usage, [undefined]);
  });

  test('conversations.send needs a prompt and answers each outcome with its own status', async () => {
    const { host, calls } = fakeHost();
    const send = op(host, 'conversations.send');
    await assert.rejects(
      async () => send.handle({}),
      (error) => error instanceof ApiError && error.status === 400,
    );
    await assert.rejects(
      async () => send.handle({ prompt: '  ' }),
      (error) => error instanceof ApiError && error.status === 400,
    );
    assert.deepEqual(await send.handle({ prompt: 'go', window: 2 }), { window: 7, sessionId: 'S' });
    assert.deepEqual(calls.sendPrompt, [{ target: { folder: undefined, window: 2 }, request: { sessionId: undefined, prompt: 'go' } }]);

    const failing = (outcome: 'notEmpty' | 'notSent' | 'busyElsewhere' | 'noInput') =>
      op(fakeHost({ sendPrompt: async () => ({ window: 1, result: { outcome } }) }).host, 'conversations.send').handle({ prompt: 'go' });
    const expected = [
      ['notEmpty', 409, 'input_not_empty'],
      ['notSent', 409, 'not_sent'],
      ['busyElsewhere', 409, 'busy_elsewhere'],
      ['noInput', 504, 'no_input'],
    ] as const;
    for (const [outcome, status, code] of expected) {
      await assert.rejects(
        async () => failing(outcome),
        (error) => error instanceof ApiError && error.status === status && error.code === code,
      );
    }
    const nowhere = op(fakeHost({ sendPrompt: async () => undefined }).host, 'conversations.send');
    await assert.rejects(
      async () => nowhere.handle({ prompt: 'go', folder: 'C:\\w' }),
      (error) => error instanceof ApiError && error.code === 'not_found',
    );
  });

  test('each operation declares its access', () => {
    const accesses = new Map(builtInOperations(fakeHost().host).map((operation) => [operation.name, operation.access]));
    assert.equal(accesses.get('windows.list'), 'read');
    assert.equal(accesses.get('windows.focus'), 'write');
    assert.equal(accesses.get('folders.open'), 'write');
    assert.equal(accesses.get('files.open'), 'write');
    assert.equal(accesses.get('conversations.open'), 'write');
    assert.equal(accesses.get('sessions.search'), 'read');
    assert.equal(accesses.get('usage.get'), 'read');
    assert.equal(accesses.get('conversations.send'), 'send');
  });
});

describe('conversationEvents', () => {
  const WINDOW = { id: 1, folder: 'C:\\w' };

  test('reports added, changed and closed conversations as conversation.state events', () => {
    const before: ConversationStateDto[] = [
      { sessionId: 'a', title: 'A', state: 'idle' },
      { sessionId: 'b', title: 'B', state: 'running' },
    ];
    const after: ConversationStateDto[] = [
      { sessionId: 'a', title: 'A', state: 'idle' },
      { sessionId: 'b', title: 'B', state: 'waiting' },
      { sessionId: 'c', title: 'C', state: 'idle' },
    ];
    const events = conversationEvents(WINDOW, before, after);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.name, 'conversation.state');
    assert.deepEqual(events[0]?.data, { window: 1, folder: 'C:\\w', sessionId: 'b', title: 'B', state: 'waiting', previous: 'running' });
    assert.deepEqual(events[1]?.data, { window: 1, folder: 'C:\\w', sessionId: 'c', title: 'C', state: 'idle', previous: undefined });

    const closed = conversationEvents(WINDOW, [{ sessionId: 'a', title: 'A', state: 'idle' }], []);
    assert.equal(closed.length, 1);
    assert.deepEqual(closed[0]?.data, { window: 1, folder: 'C:\\w', sessionId: 'a', title: 'A', state: 'closed', previous: 'idle' });
  });
});

describe('usageScope', () => {
  test('prices the models that have a price and lists the rest', () => {
    const pricing: ProviderPricing = {
      currency: 'USD',
      models: {
        'model-a': { input: 4, output: 16 },
        'model-b': { input: 1, output: 4 },
      },
    };
    const models: ModelTokens = {
      'model-a': { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0, calls: 2 },
      'model-b': { input: 2_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, calls: 3 },
      'model-c': { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, calls: 1 },
    };
    const scope = usageScope(models, pricing);

    // model-a: 1M in @4 + 0.5M out @16 per 1M = 4 + 8 = 12; model-b: 2M @1 + 1M @4 = 2 + 4 = 6.
    assert.equal(scope.cost, 18);
    assert.equal(scope.calls, 6);
    assert.deepEqual(scope.unpricedModels, ['model-c']);
    assert.equal(scope.models['model-a']?.cost, 12);
    assert.equal(scope.models['model-b']?.cost, 6);
    assert.equal(scope.models['model-c']?.cost, null);
  });
});
