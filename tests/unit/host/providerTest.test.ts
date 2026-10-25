import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { proxyNote, testProvider, TEST_TIMEOUT_MS } from '../../../src/host/main/providerTest';
import type { ProviderConfig } from '../../../src/platform/providers';

const deepseek: ProviderConfig = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'compatible',
  baseUrl: 'https://api.deepseek.com/anthropic',
  auth: 'bearer',
  models: { main: 'deepseek-flash[1m]' },
};

describe('testProvider', () => {
  test('the timeout is 30 seconds', () => {
    assert.equal(TEST_TIMEOUT_MS, 30_000);
  });

  test('a successful answer: its duration, and the model it names else the one asked', async () => {
    let time = 1_000;
    const fetch = async (): Promise<Response> => {
      time = 1_245;
      return new Response('{"model":"deepseek-v4"}', { status: 200 });
    };
    assert.deepEqual(await testProvider(deepseek, 'sk-1', fetch, () => time), {
      ok: true,
      ms: 245,
      model: 'deepseek-v4',
    });

    const quiet = async (): Promise<Response> => new Response('', { status: 200 });
    assert.deepEqual(await testProvider(deepseek, 'sk-1', quiet, () => 0), {
      ok: true,
      ms: 0,
      model: 'deepseek-flash',
    });
  });

  test('a failed answer is classified, its duration not needed', async () => {
    const fetch = async (): Promise<Response> => new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 });
    assert.deepEqual(await testProvider(deepseek, 'sk-1', fetch), {
      ok: false,
      failure: 'auth',
      status: 401,
      message: 'invalid x-api-key',
    });
  });

  test('a key it cannot use sends nothing', async () => {
    let asked = false;
    const fetch = async (): Promise<Response> => {
      asked = true;
      return new Response('', { status: 200 });
    };
    assert.deepEqual(await testProvider(deepseek, undefined, fetch), { ok: false, failure: 'noKey' });
    assert.equal(asked, false);
  });

  test('a connection that throws: network, with its message', async () => {
    const fetch = async (): Promise<Response> => {
      throw new Error('getaddrinfo ENOTFOUND api.deepseek.com');
    };
    assert.deepEqual(await testProvider(deepseek, 'sk-1', fetch), {
      ok: false,
      failure: 'network',
      message: 'getaddrinfo ENOTFOUND api.deepseek.com',
    });
  });

  test('no answer in time: timeout, and the request is aborted', async () => {
    let aborted = false;
    const fetch = (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    assert.deepEqual(await testProvider(deepseek, 'sk-1', fetch, Date.now, 20), {
      ok: false,
      failure: 'timeout',
    });
    assert.equal(aborted, true);
  });
});

describe('proxyNote', () => {
  test('a direct connection is no note', () => {
    assert.equal(proxyNote('DIRECT', {}, deepseek), undefined);
  });

  test('a proxy the test went through, with none set: the answer itself', () => {
    assert.equal(proxyNote('PROXY 127.0.0.1:7890', {}, deepseek), 'PROXY 127.0.0.1:7890');
  });

  test('HTTPS_PROXY in the environment or on the provider: no note', () => {
    assert.equal(proxyNote('PROXY 127.0.0.1:7890', { HTTPS_PROXY: 'http://x:1' }, deepseek), undefined);
    assert.equal(proxyNote('PROXY 127.0.0.1:7890', { https_proxy: 'http://x:1' }, deepseek), undefined);
    assert.equal(proxyNote('PROXY 127.0.0.1:7890', {}, { ...deepseek, env: { HTTPS_PROXY: 'http://x:1' } }), undefined);
  });
});
