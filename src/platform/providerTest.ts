/**
 * Testing an API provider: the minimal request to send it and what its answer means. Plain
 * functions, no network — main sends the request with Electron's net.fetch
 * (host/main/providerTest.ts), the tests with a fake fetch.
 */

import type { ProviderConfig } from './providers';

export type ProviderTestFailure =
  | 'noUrl' // a compatible API with no base URL
  | 'noKey' // an API type with no key stored
  | 'noModel' // a compatible API with no model at all
  | 'auth' // 401 / 403
  | 'balance' // 402, or the answer says the balance or the quota ran out
  | 'notFound' // 404
  | 'model' // 400 and the answer mentions the model
  | 'rateLimit' // 429
  | 'network' // no connection at all (DNS, refused, certificate...)
  | 'timeout'
  | 'other'; // any other status

export type ProviderTestResult =
  | { readonly ok: true; readonly ms: number; readonly model?: string; readonly proxy?: string }
  | {
      readonly ok: false;
      readonly failure: ProviderTestFailure;
      readonly status?: number;
      readonly message?: string;
      /** The system proxy the test went through, while Claude Code would not use it. */
      readonly proxy?: string;
    };

export interface ProviderTestRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** The model asked, as sent (no `[1m]`). */
  readonly model?: string;
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
/** A tier suffix like `[1m]` is the CLI's, not the API's. */
const TIER_SUFFIX = /\[[^\]]*\]$/;
const BALANCE = /insufficient.?balance|insufficient_quota|余额不足/i;

/** The model a test asks for: the same one conversations would start with (providerEnvironment). */
function requestModel(models: ProviderConfig['models']): string | undefined {
  const names = [models?.main, models?.sonnet, models?.opus, models?.haiku, models?.fable];
  for (const name of names) {
    const model = name?.replace(TIER_SUFFIX, '').trim();
    if (model !== undefined && model !== '') {
      return model;
    }
  }
  return undefined;
}

/** The request that tests a provider with its key; a failure when it cannot be made. */
export function providerTestRequest(
  provider: ProviderConfig,
  key: string | undefined,
): ProviderTestRequest | { readonly failure: 'noKey' | 'noUrl' | 'noModel' } {
  // Only the two API types are tested (the editor offers the button for those); the subscription
  // and the cloud platforms have no single endpoint to ask.
  if (provider.type !== 'compatible' && provider.type !== 'anthropic-api') {
    return { failure: 'noKey' };
  }
  const compatible = provider.type === 'compatible';
  const baseUrl = (provider.baseUrl ?? '').trim().replace(/\/+$/, '') || (compatible ? undefined : ANTHROPIC_API_URL);
  if (baseUrl === undefined) {
    return { failure: 'noUrl' };
  }
  if (key === undefined || key === '') {
    return { failure: 'noKey' };
  }
  const model = requestModel(provider.models);
  if (model === undefined && compatible) {
    return { failure: 'noModel' };
  }

  const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION };
  if (model !== undefined) {
    headers['content-type'] = 'application/json';
  }
  // As providerEnvironment sends it: ANTHROPIC_AUTH_TOKEN is the bearer, ANTHROPIC_API_KEY the
  // x-api-key; a compatible API gets x-api-key too (Claude Code sends its key there either way).
  const bearer = (provider.auth ?? (compatible ? 'bearer' : 'apiKey')) === 'bearer';
  if (bearer) {
    headers.authorization = `Bearer ${key}`;
  } else {
    headers['x-api-key'] = key;
  }
  if (compatible) {
    headers['x-api-key'] = key;
  }
  // The user's own headers win over any above; names compare case-insensitively, as on Windows.
  for (const [name, value] of Object.entries(provider.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }

  if (model === undefined) {
    // anthropic-api: the model list is free and only tells whether the key works.
    return { url: `${baseUrl}/v1/models?limit=1`, method: 'GET', headers };
  }
  return {
    url: `${baseUrl}/v1/messages`,
    method: 'POST',
    headers,
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] }),
    model,
  };
}

/** What an HTTP answer means (`body` as text, possibly JSON). The duration (`ms`) is the caller's. */
export function classifyTestResponse(status: number, body: string): ProviderTestResult {
  if (status >= 200 && status < 300) {
    const model = answeredModel(body);
    return model === undefined ? { ok: true, ms: 0 } : { ok: true, ms: 0, model };
  }
  const message = errorMessage(body);
  // The account's own answer, whatever the status — except an auth failure, which says more.
  if (status !== 401 && status !== 403 && message !== undefined && BALANCE.test(message)) {
    return failed('balance', status, message);
  }
  if (status === 401 || status === 403) {
    return failed('auth', status, message);
  }
  if (status === 402) {
    return failed('balance', status, message);
  }
  if (status === 429) {
    return failed('rateLimit', status, message);
  }
  if (status === 404) {
    return failed('notFound', status, message);
  }
  if (status === 400 && message !== undefined && /model/i.test(message)) {
    return failed('model', status, message);
  }
  return failed('other', status, message);
}

function failed(failure: ProviderTestFailure, status: number, message: string | undefined): ProviderTestResult {
  return message === undefined ? { ok: false, failure, status } : { ok: false, failure, status, message };
}

/** The model a successful answer names, if any. */
function answeredModel(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const model = (parsed as Record<string, unknown>).model;
      if (typeof model === 'string' && model !== '') {
        return model;
      }
    }
  } catch {
    // Not JSON: no model named.
  }
  return undefined;
}

/** The message of an error body: Anthropic's `{error:{message}}`, `{message}`, `{error:"..."}`, else the text; at most 300 characters. */
export function errorMessage(body: string): string | undefined {
  const text = body.trim();
  if (text === '') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const message = messageIn(parsed);
    if (message !== undefined) {
      return message.slice(0, 300);
    }
  } catch {
    // Not JSON: the text itself.
  }
  return text.slice(0, 300);
}

function messageIn(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const error = record.error;
  if (typeof error === 'string') {
    return textOrUndefined(error);
  }
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') {
      return textOrUndefined(message);
    }
  }
  return typeof record.message === 'string' ? textOrUndefined(record.message) : undefined;
}

function textOrUndefined(value: string): string | undefined {
  const text = value.trim();
  return text === '' ? undefined : text;
}
