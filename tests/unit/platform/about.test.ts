import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { compareVersions, isNewerVersion, latestPublishedRelease, releaseVersion, RELEASES_URL } from '../../../src/platform/about';

describe('releaseVersion', () => {
  test('drops the v of a tag', () => {
    assert.equal(releaseVersion('v0.9.5'), '0.9.5');
    assert.equal(releaseVersion(' V1.0.0 '), '1.0.0');
    assert.equal(releaseVersion('0.9.4'), '0.9.4');
  });
});

describe('compareVersions', () => {
  test('numeric parts compare as numbers, missing parts count as zero', () => {
    assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(compareVersions('0.9.4', '0.9.10'), -1);
    assert.equal(compareVersions('1.0', '1.0.0'), 0);
    assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
    assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  });

  test('a pre-release is below its release, and pre-release parts order as semver says', () => {
    assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
    assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
    assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.9'), 1);
    assert.equal(compareVersions('1.0.0-beta.1', '1.0.0-beta'), 1);
    assert.equal(compareVersions('1.0.0-alpha.beta', '1.0.0-alpha.1'), 1);
    assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-beta.2'), 1);
  });

  test('build metadata is ignored', () => {
    assert.equal(compareVersions('1.0.0+build.2', '1.0.0+build.9'), 0);
    assert.equal(compareVersions('1.0.0-rc.1+build.2', '1.0.0-rc.1'), 0);
  });

  test('isNewerVersion only for a later version', () => {
    assert.equal(isNewerVersion('0.9.5-beta.1', '0.9.4'), true);
    assert.equal(isNewerVersion('0.9.4', '0.9.4'), false);
    assert.equal(isNewerVersion('0.9.4-beta.1', '0.9.4'), false);
    assert.equal(isNewerVersion('0.9.3', '0.9.4'), false);
  });
});

describe('latestPublishedRelease', () => {
  test('the newest published non-draft release: pre-releases count, drafts do not', () => {
    const releases = [
      { tag_name: 'v9.9.9', draft: true, published_at: '2026-10-25T00:00:00Z', html_url: 'https://example.invalid/draft' },
      { tag_name: 'v0.9.4', draft: false, published_at: '2026-10-21T00:00:00Z', html_url: 'https://example.invalid/0.9.4' },
      {
        tag_name: 'v0.9.5-beta.1',
        draft: false,
        prerelease: true,
        published_at: '2026-10-23T00:00:00Z',
        html_url: 'https://example.invalid/0.9.5-beta.1',
      },
    ];
    assert.deepEqual(latestPublishedRelease(releases), {
      version: '0.9.5-beta.1',
      url: 'https://example.invalid/0.9.5-beta.1',
      publishedAt: '2026-10-23T00:00:00Z',
    });
  });

  test('publish time decides, even when an older version came out later', () => {
    const releases = [
      { tag_name: 'v0.9.4', published_at: '2026-10-21T00:00:00Z', html_url: 'https://example.invalid/0.9.4' },
      { tag_name: 'v0.9.3', published_at: '2026-10-23T00:00:00Z', html_url: 'https://example.invalid/0.9.3' },
    ];
    assert.equal(latestPublishedRelease(releases)?.version, '0.9.3');
  });

  test('the same publish time goes to the later version', () => {
    const releases = [
      { tag_name: 'v0.9.4', published_at: '2026-10-23T00:00:00Z' },
      { tag_name: 'v0.9.5', published_at: '2026-10-23T00:00:00Z' },
    ];
    assert.equal(latestPublishedRelease(releases)?.version, '0.9.5');
  });

  test('malformed entries are skipped; the release page is the fallback link', () => {
    assert.deepEqual(
      latestPublishedRelease([
        null,
        'nope',
        { draft: false },
        { tag_name: '', published_at: '2026-10-23T00:00:00Z' },
        { tag_name: 'v1.0.0', published_at: 'not a date' },
      ]),
      { version: '1.0.0', url: RELEASES_URL },
    );
    assert.equal(latestPublishedRelease([]), undefined);
    assert.equal(latestPublishedRelease({ tag_name: 'v1.0.0' }), undefined);
    assert.equal(latestPublishedRelease(undefined), undefined);
  });
});
