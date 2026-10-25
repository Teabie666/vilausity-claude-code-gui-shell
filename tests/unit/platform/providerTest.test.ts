import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyTestResponse, errorMessage, providerTestRequest, type ProviderTestRequest } from '../../../src/platform/providerTest';
import type { ProviderConfig } from '../../../src/platform/providers';

/** The DeepSeek preset (presets.ts), as a provider. */
const deepseek: ProviderConfig = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'compatible',
  baseUrl: 'https://api.deepseek.com/anthropic',
  auth: 'bearer',
  models: {
    main: 'deepseek-flash[1m]',
    opus: 'deepseek-v4-pro[1m]',
    sonnet: 'deepseek-flash[1m]',
    haiku: 'deepseek-flash',
    fable: 'deepseek-v4-pro[1m]',
    subagent: 'deepseek-flash[1m]',
  },
  env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432', CLAUDE_CODE_EFFORT_LEVEL: 'max' },
};

const anthropic: ProviderConfig = {
  id: 'anthropic',
  name: 'Anthropic API',
  type: 'anthropic-api',
  auth: 'apiKey',
};

describe('providerTestRequest', () => {
  test('a compatible API like DeepSeek: POST /v1/messages, bearer and x-api-key, no [1m]', () => {
    assert.deepEqual(providerTestRequest(deepseek, 'sk-1'), {
      url: 'https://api.deepseek.com/anthropic/v1/messages',
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        authorization: 'Bearer sk-1',
        'x-api-key': 'sk-1',
      },
      body: '{"model":"deepseek-flash","max_tokens":1,"messages":[{"role":"user","content":"Hi"}]}',
      model: 'deepseek-flash',
    });
  });

  test('the base URL loses a trailing slash', () => {
    const request = providerTestRequest({ ...deepseek, baseUrl: 'https://api.deepseek.com/anthropic/' }, 'sk-1') as ProviderTestRequest;
    assert.equal(request.url, 'https://api.deepseek.com/anthropic/v1/messages');
  });

  test("the user's own headers win, names compared case-insensitively", () => {
    const request = providerTestRequest(
      {
        ...deepseek,
        headers: { Authorization: 'Bearer other', 'X-Api-Key': 'other', 'X-Extra': 'yes' },
      },
      'sk-1',
    ) as ProviderTestRequest;
    assert.equal(request.headers.authorization, 'Bearer other');
    assert.equal(request.headers['x-api-key'], 'other');
    assert.equal(request.headers['x-extra'], 'yes');
  });

  test('a model from a lower tier is asked when there is no main one', () => {
    const request = providerTestRequest({ ...deepseek, models: { sonnet: 'deepseek-flash[1m]' } }, 'sk-1') as ProviderTestRequest;
    assert.equal(request.model, 'deepseek-flash');
  });

  test('anthropic-api with no model: GET /v1/models?limit=1, the key as x-api-key', () => {
    assert.deepEqual(providerTestRequest(anthropic, 'sk-ant'), {
      url: 'https://api.anthropic.com/v1/models?limit=1',
      method: 'GET',
      headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-ant' },
    });
  });

  test('anthropic-api as a bearer: only authorization', () => {
    assert.deepEqual(providerTestRequest({ ...anthropic, auth: 'bearer' }, 'sk-ant'), {
      url: 'https://api.anthropic.com/v1/models?limit=1',
      method: 'GET',
      headers: { 'anthropic-version': '2023-06-01', authorization: 'Bearer sk-ant' },
    });
  });

  test('failures: no URL, no key, no model (in that order)', () => {
    const noUrl = { ...deepseek, baseUrl: undefined };
    assert.deepEqual(providerTestRequest(noUrl, undefined), { failure: 'noUrl' });
    assert.deepEqual(providerTestRequest(deepseek, undefined), { failure: 'noKey' });
    assert.deepEqual(providerTestRequest({ ...deepseek, models: {} }, 'sk-1'), { failure: 'noModel' });
  });
});

describe('classifyTestResponse', () => {
  test('2xx: ok, the model the answer names when it names one', () => {
    assert.deepEqual(classifyTestResponse(200, '{"id":"msg_1","model":"deepseek-flash"}'), {
      ok: true,
      ms: 0,
      model: 'deepseek-flash',
    });
    assert.deepEqual(classifyTestResponse(200, ''), { ok: true, ms: 0 });
    assert.deepEqual(classifyTestResponse(204, 'not json'), { ok: true, ms: 0 });
  });

  test('401 and 403: auth', () => {
    assert.deepEqual(classifyTestResponse(401, '{"error":{"message":"invalid x-api-key"}}'), {
      ok: false,
      failure: 'auth',
      status: 401,
      message: 'invalid x-api-key',
    });
    assert.equal((classifyTestResponse(403, '') as { failure: string }).failure, 'auth');
  });

  test('402: balance', () => {
    assert.deepEqual(classifyTestResponse(402, '{"error":{"message":"Payment required"}}'), {
      ok: false,
      failure: 'balance',
      status: 402,
      message: 'Payment required',
    });
  });

  test('a balance message beats the status: 400 with "Insufficient Balance"', () => {
    assert.deepEqual(classifyTestResponse(400, '{"error":{"message":"Insufficient Balance"}}'), {
      ok: false,
      failure: 'balance',
      status: 400,
      message: 'Insufficient Balance',
    });
  });

  test('but a 401 stays auth even when it mentions the quota', () => {
    assert.equal((classifyTestResponse(401, '{"error":{"message":"insufficient_quota"}}') as { failure: string }).failure, 'auth');
  });

  test('404: notFound', () => {
    assert.deepEqual(classifyTestResponse(404, '{"error":{"message":"Not Found"}}'), {
      ok: false,
      failure: 'notFound',
      status: 404,
      message: 'Not Found',
    });
  });

  test('400 that mentions the model: model', () => {
    assert.deepEqual(classifyTestResponse(400, '{"error":{"message":"model deepseek-flash not found"}}'), {
      ok: false,
      failure: 'model',
      status: 400,
      message: 'model deepseek-flash not found',
    });
    assert.equal((classifyTestResponse(400, '{"error":{"message":"bad request"}}') as { failure: string }).failure, 'other');
  });

  test('429: rateLimit; 500: other', () => {
    assert.equal((classifyTestResponse(429, '{"error":{"message":"slow down"}}') as { failure: string }).failure, 'rateLimit');
    assert.deepEqual(classifyTestResponse(500, ''), { ok: false, failure: 'other', status: 500 });
  });
});

describe('errorMessage', () => {
  test("Anthropic's {error:{message}}", () => {
    assert.equal(errorMessage('{"type":"error","error":{"type":"authentication_error","message":"invalid key"}}'), 'invalid key');
  });

  test('{message} and {error:"..."}', () => {
    assert.equal(errorMessage('{"message":"nope"}'), 'nope');
    assert.equal(errorMessage('{"error":"boom"}'), 'boom');
  });

  test('plain text, as is', () => {
    assert.equal(errorMessage('  Bad Gateway  '), 'Bad Gateway');
  });

  test('nothing to say: undefined', () => {
    assert.equal(errorMessage(''), undefined);
    assert.equal(errorMessage('   '), undefined);
  });

  test('JSON without a message: the body itself, which still says something', () => {
    assert.equal(errorMessage('{"error":{}}'), '{"error":{}}');
  });

  test('at most 300 characters', () => {
    assert.equal(errorMessage('x'.repeat(400))?.length, 300);
  });
});
