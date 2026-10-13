import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISABLE_LOGIN_SETTING,
  ENVIRONMENT_SETTING,
  parseProviderConfig,
  providerEnvironment,
  providerIdFor,
  providerSettingsOverlay,
  SUBSCRIPTION_PROVIDER,
  type ProviderConfig,
} from '../../../src/platform/providers';

const compatible: ProviderConfig = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'compatible',
  baseUrl: 'https://api.deepseek.com/anthropic',
  models: { main: 'deepseek-flash[1m]', haiku: 'deepseek-flash', subagent: 'deepseek-flash' },
  timeoutMs: 600000,
  disableNonessentialTraffic: true,
};

describe('providerEnvironment', () => {
  test('the subscription sets nothing', () => {
    assert.deepEqual(providerEnvironment(SUBSCRIPTION_PROVIDER, undefined), {});
  });

  test('a compatible API: base URL, the key as a bearer token, models, limits, no login', () => {
    assert.deepEqual(providerEnvironment(compatible, 'sk-1'), {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: 'sk-1',
      ANTHROPIC_MODEL: 'deepseek-flash[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
      API_TIMEOUT_MS: '600000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_SKIP_AUTH_LOGIN: '1',
    });
  });

  test("Anthropic's API sends the key as x-api-key and empties the bearer token", () => {
    const env = providerEnvironment({ id: 'anthropic', name: 'Anthropic', type: 'anthropic-api' }, 'sk-ant');
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, '');
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  });

  test('headers become ANTHROPIC_CUSTOM_HEADERS; extra variables come last and win', () => {
    const env = providerEnvironment(
      { ...compatible, headers: { 'X-A': '1', 'X-B': 'two' }, env: { API_TIMEOUT_MS: '5', FOO: 'bar' } },
      'k',
    );
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, 'X-A: 1\nX-B: two');
    assert.equal(env.API_TIMEOUT_MS, '5');
    assert.equal(env.FOO, 'bar');
  });

  test('cloud providers switch the CLI to them and leave the keys alone', () => {
    const env = providerEnvironment({ id: 'aws', name: 'Bedrock', type: 'bedrock', env: { AWS_REGION: 'us-east-1' } }, undefined);
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1');
    assert.equal(env.AWS_REGION, 'us-east-1');
    assert.equal('ANTHROPIC_API_KEY' in env, false);
  });
});

describe('providerSettingsOverlay', () => {
  test("lays the provider's variables over the user's own, whose other variables stay", () => {
    const overlay = providerSettingsOverlay(compatible, 'sk-1', {
      [ENVIRONMENT_SETTING]: [
        { name: 'anthropic_base_url', value: 'https://old' },
        { name: 'HTTPS_PROXY', value: 'http://proxy:8080' },
        'not an entry',
      ],
    });
    const entries = overlay[ENVIRONMENT_SETTING] as { name: string; value: string }[];
    assert.deepEqual(entries[0], { name: 'HTTPS_PROXY', value: 'http://proxy:8080' });
    assert.equal(entries.filter((entry) => entry.name.toUpperCase() === 'ANTHROPIC_BASE_URL').length, 1);
    assert.ok(entries.some((entry) => entry.name === 'ANTHROPIC_AUTH_TOKEN' && entry.value === 'sk-1'));
    assert.equal(overlay[DISABLE_LOGIN_SETTING], true);
  });

  test('the subscription changes no setting', () => {
    assert.deepEqual(providerSettingsOverlay(SUBSCRIPTION_PROVIDER, undefined, {}), {});
  });
});

describe('parseProviderConfig', () => {
  test('keeps valid fields and drops the rest', () => {
    const parsed = parseProviderConfig({
      id: 'kimi',
      name: ' Kimi ',
      type: 'compatible',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      auth: 'nonsense',
      models: { main: 'kimi-k3[1m]', opus: '', sonnet: 3 },
      headers: { 'X-Ok': 'v', 'bad header': 'x' },
      timeoutMs: -1,
      env: { GOOD_NAME: 'v', '1BAD': 'x', ALSO_BAD: 7 },
      color: '#ABCDEF',
      extra: 'dropped',
    });
    assert.deepEqual(parsed, {
      id: 'kimi',
      name: 'Kimi',
      type: 'compatible',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      auth: undefined,
      models: { main: 'kimi-k3[1m]', opus: undefined, sonnet: undefined, haiku: undefined, fable: undefined, subagent: undefined },
      headers: { 'X-Ok': 'v' },
      timeoutMs: undefined,
      maxOutputTokens: undefined,
      disableNonessentialTraffic: undefined,
      env: { GOOD_NAME: 'v' },
      color: '#abcdef',
      preset: undefined,
      pricing: undefined,
    });
  });

  test('rejects a bad id or type', () => {
    assert.equal(parseProviderConfig({ id: 'Has Space', name: '', type: 'compatible' }), undefined);
    assert.equal(parseProviderConfig({ id: 'ok', name: '', type: 'magic' }), undefined);
    assert.equal(parseProviderConfig('nope'), undefined);
  });
});

describe('providerIdFor', () => {
  test('slugs the name and avoids ids in use', () => {
    assert.equal(providerIdFor('Kimi (moonshot.ai)', []), 'kimi-moonshot-ai');
    assert.equal(providerIdFor('DeepSeek', ['deepseek', 'deepseek-2']), 'deepseek-3');
    assert.equal(providerIdFor('通义千问', []), 'provider');
  });
});
