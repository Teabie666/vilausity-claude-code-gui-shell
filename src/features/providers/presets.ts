/**
 * Starting points for new providers, from each provider's own Claude Code setup page
 * (checked 2026-10-10; Volcano Engine Ark, MiniMax and OpenRouter 2026-10-12). Model names
 * change often, so a preset is only where a provider starts: everything can be edited, and
 * `docs` links to the current instructions. Only APIs that speak Anthropic's Messages API are
 * here (Claude Code speaks nothing else): OpenAI's and Google's do not, xAI's Anthropic
 * compatibility is deprecated; OpenRouter reaches their models. Each preset's accent color
 * is in platform/providers.ts (PRESET_ACCENTS).
 *
 * Prices are not here: they change too often to ship. A preset billed per token links to its
 * price list (checked 2026-10-13) and says the currency it bills in; the coding plans are flat
 * fees.
 */

import type { Currency, ProviderConfig } from '../../platform/providers';
import { t } from './messages';

export interface ProviderPreset {
  readonly id: string;
  /** Brand names stay as they are; descriptive ones are translated. */
  readonly name: () => string;
  /** The provider's setup page for Claude Code. */
  readonly docs?: string;
  /** Where the provider lists its models' prices per token, and the currency it bills in. */
  readonly prices?: string;
  readonly currency?: Currency;
  readonly config: Omit<ProviderConfig, 'id' | 'name' | 'preset'>;
}

/** The part of a base URL the user has to fill in (Alibaba Cloud's pay-as-you-go endpoints). */
export const URL_PLACEHOLDER = /\{[A-Za-z]+\}/;

const DEEPSEEK_DOCS = 'https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/';
const KIMI_DOCS = 'https://platform.kimi.com/docs/guide/claude-code-kimi';
const QWEN_DOCS = 'https://help.aliyun.com/zh/model-studio/claude-code';
const QWEN_INTL_DOCS = 'https://www.alibabacloud.com/help/en/model-studio/claude-code';

const kimiModels = {
  main: 'kimi-k3[1m]',
  opus: 'kimi-k3[1m]',
  sonnet: 'kimi-k3[1m]',
  haiku: 'kimi-k2.7-code',
  fable: 'kimi-k3[1m]',
  subagent: 'kimi-k3[1m]',
};
const kimiEnv = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000', CLAUDE_CODE_EFFORT_LEVEL: 'max' };
const qwenCodingModels = { main: 'qwen3.7-plus', opus: 'qwen3.7-plus', sonnet: 'qwen3.7-plus', haiku: 'qwen3.7-plus' };
/** Ark's Coding Plan: the model chosen in the Ark console. */
const arkModels = { main: 'ark-code-latest', opus: 'ark-code-latest', sonnet: 'ark-code-latest', haiku: 'ark-code-latest' };
const minimaxModel = 'MiniMax-M3.1-Flash-Preview';
const minimaxModels = { main: minimaxModel, opus: minimaxModel, sonnet: minimaxModel, haiku: minimaxModel };
const minimaxEnv = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '524288' };
const qwenModels = {
  main: 'qwen3.7-max',
  opus: 'qwen3.7-max',
  sonnet: 'qwen3.7-max',
  haiku: 'qwen3.6-flash',
  subagent: 'qwen3.7-max',
};

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'anthropic',
    name: () => 'Anthropic API',
    docs: 'https://code.claude.com/docs/en/settings#environment-variables',
    config: { type: 'anthropic-api', auth: 'apiKey' },
  },
  {
    id: 'deepseek',
    name: () => 'DeepSeek',
    docs: DEEPSEEK_DOCS,
    prices: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    currency: 'CNY',
    config: {
      type: 'compatible',
      baseUrl: 'https://api.deepseek.com/anthropic',
      auth: 'bearer',
      models: {
        main: 'deepseek-flash[1m]',
        opus: 'deepseek-flash[1m]',
        sonnet: 'deepseek-flash[1m]',
        haiku: 'deepseek-flash',
        subagent: 'deepseek-flash',
      },
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432', CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    },
  },
  {
    id: 'kimi',
    name: () => 'Kimi',
    docs: KIMI_DOCS,
    prices: 'https://platform.kimi.com/docs/pricing/chat',
    currency: 'CNY',
    config: {
      type: 'compatible',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      auth: 'bearer',
      models: kimiModels,
      env: kimiEnv,
    },
  },
  {
    id: 'kimi-intl',
    name: () => 'Kimi (moonshot.ai)',
    docs: KIMI_DOCS,
    prices: 'https://platform.kimi.ai/docs/pricing/chat',
    currency: 'USD',
    config: {
      type: 'compatible',
      baseUrl: 'https://api.moonshot.ai/anthropic',
      auth: 'bearer',
      models: kimiModels,
      env: kimiEnv,
    },
  },
  {
    id: 'glm',
    name: () => t('presetGlm'),
    docs: 'https://docs.bigmodel.cn/cn/guide/develop/claude',
    prices: 'https://docs.bigmodel.cn/cn/guide/start/pricing',
    currency: 'CNY',
    config: {
      type: 'compatible',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      auth: 'bearer',
      models: { opus: 'glm-5.2[1m]', sonnet: 'glm-5.2[1m]', haiku: 'glm-4.7' },
      timeoutMs: 3000000,
      disableNonessentialTraffic: true,
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' },
    },
  },
  {
    id: 'zai',
    name: () => 'Z.ai GLM',
    docs: 'https://docs.z.ai/scenario-example/develop-tools/claude',
    prices: 'https://docs.z.ai/guides/overview/pricing',
    currency: 'USD',
    config: {
      type: 'compatible',
      baseUrl: 'https://api.z.ai/api/anthropic',
      auth: 'bearer',
      models: { opus: 'GLM-4.7', sonnet: 'GLM-4.7', haiku: 'GLM-4.5-Air' },
      timeoutMs: 3000000,
    },
  },
  {
    id: 'qwen-coding',
    name: () => t('presetQwenCoding'),
    docs: QWEN_DOCS,
    currency: 'CNY',
    config: {
      type: 'compatible',
      baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      auth: 'bearer',
      models: qwenCodingModels,
    },
  },
  {
    id: 'qwen',
    name: () => t('presetQwen'),
    docs: QWEN_DOCS,
    prices: 'https://help.aliyun.com/zh/model-studio/model-pricing',
    currency: 'CNY',
    config: {
      type: 'compatible',
      baseUrl: 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/apps/anthropic',
      auth: 'bearer',
      models: qwenModels,
    },
  },
  {
    id: 'qwen-coding-intl',
    name: () => t('presetQwenCodingIntl'),
    docs: QWEN_INTL_DOCS,
    currency: 'USD',
    config: {
      type: 'compatible',
      baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',
      auth: 'bearer',
      models: qwenCodingModels,
    },
  },
  {
    id: 'qwen-intl',
    name: () => t('presetQwenIntl'),
    docs: QWEN_INTL_DOCS,
    prices: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
    currency: 'USD',
    config: {
      type: 'compatible',
      baseUrl: 'https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
      auth: 'bearer',
      models: qwenModels,
    },
  },
  {
    id: 'seed',
    name: () => t('presetSeed'),
    docs: 'https://www.volcengine.com/docs/82379/1956278',
    currency: 'CNY',
    config: {
      type: 'compatible',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
      auth: 'bearer',
      models: arkModels,
    },
  },
  {
    id: 'minimax',
    name: () => 'MiniMax',
    docs: 'https://platform.minimax.cn/docs/coding-plan/claude-code',
    currency: 'CNY',
    config: {
      type: 'compatible',
      baseUrl: 'https://api.minimax.cn/anthropic',
      auth: 'bearer',
      models: minimaxModels,
      env: minimaxEnv,
    },
  },
  {
    id: 'minimax-intl',
    name: () => 'MiniMax (minimax.io)',
    docs: 'https://platform.minimax.io/docs/token-plan/claude-code',
    currency: 'USD',
    config: {
      type: 'compatible',
      baseUrl: 'https://api.minimax.io/anthropic',
      auth: 'bearer',
      models: minimaxModels,
      env: minimaxEnv,
    },
  },
  {
    // Many vendors' models behind one key, OpenAI's, Google's and xAI's among them (the model
    // picker lists them); Claude Code is built for Anthropic's, so the tiers start there.
    id: 'openrouter',
    name: () => 'OpenRouter',
    docs: 'https://openrouter.ai/docs/guides/coding-agents/claude-code-integration',
    prices: 'https://openrouter.ai/models',
    currency: 'USD',
    config: {
      type: 'compatible',
      baseUrl: 'https://openrouter.ai/api',
      auth: 'bearer',
      models: {
        opus: '~anthropic/claude-opus-latest[1m]',
        sonnet: '~anthropic/claude-sonnet-latest[1m]',
        haiku: '~anthropic/claude-haiku-latest',
        fable: '~anthropic/claude-fable-latest[1m]',
        subagent: '~anthropic/claude-opus-latest[1m]',
      },
      env: { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' },
    },
  },
  {
    id: 'custom',
    name: () => t('presetCustom'),
    config: { type: 'compatible', auth: 'bearer' },
  },
];

export function presetById(id: string | undefined): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}
