/**
 * Running a provider's test: the request from platform/providerTest.ts with `fetch` (Electron's
 * net.fetch in the app, which goes through the system proxy; a fake in tests). No Electron here:
 * the environment and the proxy lookup are the caller's.
 */

import type { ProviderConfig } from '../../platform/providers';
import { classifyTestResponse, providerTestRequest, type ProviderTestResult } from '../../platform/providerTest';

/** The test gives up after this long. */
export const TEST_TIMEOUT_MS = 30_000;

/** Runs the test with `fetch` (Electron's net.fetch in the app); 30 s, then 'timeout'. */
export async function testProvider(
  provider: ProviderConfig,
  key: string | undefined,
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  now: () => number = Date.now,
  timeoutMs: number = TEST_TIMEOUT_MS,
): Promise<ProviderTestResult> {
  const request = providerTestRequest(provider, key);
  if ('failure' in request) {
    return { ok: false, failure: request.failure };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = now();
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    const result = classifyTestResponse(response.status, await response.text());
    if (!result.ok) {
      return result;
    }
    const ms = Math.max(0, Math.round(now() - started));
    // The answer's own model name wins; a server that omits it answered the one asked.
    const model = result.model ?? request.model;
    return model === undefined ? { ok: true, ms } : { ok: true, ms, model };
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, failure: 'timeout' };
    }
    return {
      ok: false,
      failure: 'network',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The system proxy a test went through, when Claude Code would not use it: a note for the
 * editor. `resolved` is Electron's session.resolveProxy answer (`PROXY host:port`, `DIRECT`).
 */
export function proxyNote(
  resolved: string,
  env: Readonly<Record<string, string | undefined>>,
  provider: ProviderConfig,
): string | undefined {
  const proxy = resolved.trim();
  if (proxy === '' || proxy.toUpperCase() === 'DIRECT') {
    return undefined;
  }
  // A proxy the user set themselves is in the conversation's environment too: nothing to warn of.
  const set = (value: string | undefined): boolean => value !== undefined && value.trim() !== '';
  if (set(env.HTTPS_PROXY) || set(env.https_proxy) || set(provider.env?.HTTPS_PROXY)) {
    return undefined;
  }
  return proxy;
}
