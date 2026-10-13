/**
 * What conversations cost under an API provider: the tokens of each API call, as Claude
 * Code's transcripts record them, priced with the prices the user gave the provider's models.
 * Plain data and functions shared by main (which reads the transcripts) and the tests.
 *
 * Which provider a call ran under comes from the session's tags: main tags a session with its
 * window's provider when a Claude process starts on it and then makes a call. Sessions run
 * before tags existed, or outside Vilausity (the CLI, VS Code), have none; their calls are put
 * down to the one provider whose models include the call's model, when there is exactly one.
 */

import { modelKey, type ModelPrice, type ProviderConfig, type ProviderPricing, type ProviderType } from './providers';

/** The tokens of one API call (or of many, added up). */
export interface TokenCounts {
  readonly input: number;
  readonly output: number;
  /** Prompt cache hits; not part of `input`. */
  readonly cacheRead: number;
  /** Prompt cache writes; not part of `input`. */
  readonly cacheWrite: number;
}

/** One API call of a session. */
export interface UsageCall extends TokenCounts {
  /** When it was recorded (epoch ms). */
  readonly at: number;
  /** The model as the transcript names it. */
  readonly model: string;
}

/** A Claude process of a session ran under `provider` from `at` on (and made calls). */
export interface SessionTag {
  readonly provider: string;
  /** The provider's name then (it may have been renamed or removed since). */
  readonly name: string;
  readonly at: number;
}

/** What attribution needs to know of a provider. */
export interface AttributedProvider {
  readonly id: string;
  readonly type: ProviderType;
  /** Its models as `modelKey` writes them: the model fields' and those it has prices for. */
  readonly models: readonly string[];
}

/** The tokens by model (`modelKey`), and how many calls. */
export type ModelTokens = Record<string, TokenCounts & { readonly calls: number }>;

export const NO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Claude's own model ids, as Claude's APIs answer with them (`claude-opus-5-5`, Bedrock's
 * `us.anthropic.claude-...`); not a gateway's names for them (OpenRouter's `anthropic/claude-...`).
 */
const CLAUDE_MODEL = /^(?:[a-z]+\.)?(?:anthropic\.)?claude-/;

/**
 * The provider a model alone points to: the one compatible API that names it; for a Claude
 * model no compatible API names, Claude's own API when there is one only (the subscription,
 * unless an Anthropic API, Bedrock... is set up too). Undefined when that is not one.
 */
export function inferProvider(model: string, providers: readonly AttributedProvider[]): string | undefined {
  const naming = providers.filter((provider) => provider.type === 'compatible' && provider.models.includes(model));
  if (naming.length > 0) {
    return naming.length === 1 ? naming[0]?.id : undefined;
  }
  if (!CLAUDE_MODEL.test(model)) {
    return undefined;
  }
  const claude = providers.filter((provider) => provider.type !== 'compatible');
  return claude.length === 1 ? claude[0]?.id : undefined;
}

/**
 * The provider (its id) one call of a session ran under, or undefined when that cannot be
 * told. The tag in force when the call was made, unless its provider does not name the
 * call's model and one compatible API does: the session went on outside Vilausity, under
 * that one. Any other model stays with the tag: an alias the API answered with (OpenRouter
 * answers `~anthropic/claude-opus-latest` with the model it stands for). With no tag, the
 * model alone decides (`inferProvider`). `tags` are oldest first.
 */
export function attributeCall(
  call: Pick<UsageCall, 'at' | 'model'>,
  tags: readonly SessionTag[],
  providers: readonly AttributedProvider[],
): string | undefined {
  const model = modelKey(call.model);
  const tag = tags.findLast((candidate) => candidate.at <= call.at);
  if (!tag) {
    return inferProvider(model, providers);
  }
  const provider = providers.find((candidate) => candidate.id === tag.provider);
  // A provider removed since keeps its calls (they count for no provider there is).
  if (!provider || provider.models.includes(model)) {
    return tag.provider;
  }
  const naming = providers.filter((candidate) => candidate.type === 'compatible' && candidate.models.includes(model));
  return naming.length === 1 && naming[0] ? naming[0].id : tag.provider;
}

/** A provider as attribution sees it: the models its model fields name and those it has prices for. */
export function attributedProvider(provider: ProviderConfig): AttributedProvider {
  const named = [...Object.values(provider.models ?? {}), ...Object.keys(provider.pricing?.models ?? {})]
    .flatMap((model) => (model === undefined ? [] : [modelKey(model)]))
    .filter((model) => model !== '');
  return { id: provider.id, type: provider.type, models: [...new Set(named)] };
}

/** One session's calls (its subagents' too), and the folder it ran in. */
export interface SessionUsage {
  readonly sessionId: string;
  readonly folder: string | undefined;
  readonly calls: readonly UsageCall[];
}

export interface UsageScopes {
  /** The session asked about. */
  readonly session: ModelTokens;
  /** The sessions of the folder asked about. */
  readonly folder: ModelTokens;
  /** Every session. */
  readonly all: ModelTokens;
}

export interface UsageQuery {
  readonly provider: string;
  readonly sessionId?: string;
  /** Whether a session's folder is the one asked about. */
  readonly inFolder?: (folder: string) => boolean;
}

/** The tokens of the calls that ran under `query.provider`, by model, in the three scopes. */
export function summarizeUsage(
  sessions: Iterable<SessionUsage>,
  tagsOf: (sessionId: string) => readonly SessionTag[],
  providers: readonly AttributedProvider[],
  query: UsageQuery,
): UsageScopes {
  const session: Record<string, TokenCounts & { calls: number }> = {};
  const folder: Record<string, TokenCounts & { calls: number }> = {};
  const all: Record<string, TokenCounts & { calls: number }> = {};
  for (const usage of sessions) {
    const tags = tagsOf(usage.sessionId);
    const isSession = usage.sessionId === query.sessionId;
    const inFolder = usage.folder !== undefined && query.inFolder?.(usage.folder) === true;
    for (const call of usage.calls) {
      if (attributeCall(call, tags, providers) !== query.provider) {
        continue;
      }
      addTokens(all, call);
      if (inFolder) {
        addTokens(folder, call);
      }
      if (isSession) {
        addTokens(session, call);
      }
    }
  }
  return { session, folder, all };
}

/** The models of the calls that ran under `provider` (`modelKey`), sorted. */
export function modelsUsed(
  sessions: Iterable<SessionUsage>,
  tagsOf: (sessionId: string) => readonly SessionTag[],
  providers: readonly AttributedProvider[],
  provider: string,
): string[] {
  const models = new Set<string>();
  for (const usage of sessions) {
    const tags = tagsOf(usage.sessionId);
    for (const call of usage.calls) {
      if (attributeCall(call, tags, providers) === provider) {
        models.add(modelKey(call.model));
      }
    }
  }
  return [...models].sort();
}

/**
 * The provider a session last ran under: its latest call's, else (no calls yet) its latest
 * tag's; undefined when that cannot be told.
 */
export function lastProvider(
  usage: SessionUsage | undefined,
  tags: readonly SessionTag[],
  providers: readonly AttributedProvider[],
): string | undefined {
  const calls = usage?.calls ?? [];
  const latest = calls.reduce<UsageCall | undefined>((last, call) => (!last || call.at >= last.at ? call : last), undefined);
  return latest ? attributeCall(latest, tags, providers) : tags.at(-1)?.provider;
}

/** Adds a call's tokens to the totals of its model. */
export function addTokens(totals: Record<string, TokenCounts & { calls: number }>, call: UsageCall): void {
  const model = modelKey(call.model);
  const sum = totals[model] ?? { ...NO_TOKENS, calls: 0 };
  totals[model] = {
    input: sum.input + call.input,
    output: sum.output + call.output,
    cacheRead: sum.cacheRead + call.cacheRead,
    cacheWrite: sum.cacheWrite + call.cacheWrite,
    calls: sum.calls + 1,
  };
}

/** What tokens cost at a model's price (per million tokens); the cache prices default to the input price. */
export function costOf(tokens: TokenCounts, price: ModelPrice): number {
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * (price.cacheRead ?? price.input) +
      tokens.cacheWrite * (price.cacheWrite ?? price.input)) /
    1e6
  );
}

/** What the models' tokens cost, and the models that have no price (their tokens cost nothing here). */
export function totalCost(models: ModelTokens, pricing: ProviderPricing | undefined): { cost: number; unpriced: string[] } {
  let cost = 0;
  const unpriced: string[] = [];
  for (const [model, tokens] of Object.entries(models)) {
    const price = pricing?.models[model];
    if (price) {
      cost += costOf(tokens, price);
    } else {
      unpriced.push(model);
    }
  }
  return { cost, unpriced: unpriced.sort() };
}
