import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ReleaseChecker, RELEASE_CACHE_MS, type Fetch } from '../../../src/host/main/releaseChecker';
import { NullLogger } from '../../../src/platform/log';

const RELEASES = [{ tag_name: 'v0.9.5', draft: false, published_at: '2026-10-23T00:00:00Z', html_url: 'https://example.invalid/0.9.5' }];

const response = (body: unknown, ok = true, status = 200): Response => ({ ok, status, json: async () => body }) as unknown as Response;

describe('ReleaseChecker', () => {
  test('a successful answer is reused for an hour; force asks again', async () => {
    let now = 1_000;
    let calls = 0;
    const fetch: Fetch = async () => {
      calls++;
      return response(RELEASES);
    };
    const checker = new ReleaseChecker({ fetch, url: 'https://example.invalid', logger: NullLogger, now: () => now });

    const first = await checker.latest();
    assert.deepEqual(first, {
      ok: true,
      release: { version: '0.9.5', url: 'https://example.invalid/0.9.5', publishedAt: '2026-10-23T00:00:00Z' },
    });
    assert.equal(calls, 1);

    now += RELEASE_CACHE_MS - 1;
    await checker.latest();
    assert.equal(calls, 1);

    now += 1;
    await checker.latest();
    assert.equal(calls, 2);

    await checker.latest(true);
    assert.equal(calls, 3);
  });

  test('a failed request is not remembered, so Retry asks again', async () => {
    let calls = 0;
    let fail = true;
    const fetch: Fetch = async () => {
      calls++;
      if (fail) {
        throw new Error('offline');
      }
      return response(RELEASES);
    };
    const checker = new ReleaseChecker({ fetch, url: 'https://example.invalid', logger: NullLogger });

    assert.deepEqual(await checker.latest(), { ok: false });
    assert.deepEqual(await checker.latest(), { ok: false });
    assert.equal(calls, 2);

    fail = false;
    assert.equal((await checker.latest()).ok, true);
    assert.equal(calls, 3);
  });

  test('an HTTP error or an answer without a published release fails', async () => {
    let body: unknown = RELEASES;
    let ok = true;
    const fetch: Fetch = async () => response(body, ok, ok ? 200 : 503);
    const checker = new ReleaseChecker({ fetch, url: 'https://example.invalid', logger: NullLogger });

    ok = false;
    assert.deepEqual(await checker.latest(), { ok: false });

    ok = true;
    body = [];
    assert.deepEqual(await checker.latest(true), { ok: false });
  });

  test('requests in flight at the same time share one call', async () => {
    let calls = 0;
    let finish: ((value: Response) => void) | undefined;
    const fetch: Fetch = () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const checker = new ReleaseChecker({ fetch, url: 'https://example.invalid', logger: NullLogger });

    const first = checker.latest();
    const second = checker.latest();
    finish?.(response(RELEASES));
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal(a.ok, true);
    assert.deepEqual(a, b);
  });
});
