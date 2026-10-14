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

import { costAt, ruleFor, type Prices } from './pricing';
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
  /**
   * The reply's message id: a conversation forked from another starts with a copy of its
   * transcript, the same calls with the same ids, and they cost once.
   */
  readonly id?: string;
  /** When it was recorded (epoch ms). */
  readonly at: number;
  /** The model as the transcript names it. */
  readonly model: string;
  /**
   * The model as Claude Code asked for it (`requestedModel`, from 2.1.296 on): the name its own
   * counts go by, where a gateway may answer with another.
   */
  readonly requested?: string;
  /** The reply thought (some APIs price thinking apart). */
  readonly thinking?: boolean;
  /**
   * Not in the transcript: calls Claude Code made for itself (a title, compacting the
   * conversation, WebFetch's summary of a page), from its own count (`unrecordedCalls`).
   * Possibly several calls added up, so not counted as a call.
   */
  readonly unrecorded?: boolean;
}

/**
 * Claude Code's own count of a session's calls at one point, by model (`modelKey`): the
 * transcript's `cost-state` line, which a Claude process writes as it exits (and at other
 * times). It counts every call the process made, the ones the transcript leaves out too, and
 * goes on from the last count written before the process started, if any.
 */
export interface UsageSnapshot {
  /** When it was written: the time of the last transcript line before it (epoch ms). */
  readonly at: number;
  /**
   * When the first process it counts for started (`startTime`, epoch ms): a process that goes on
   * from a count keeps its start time, so counts with the same `since` go on from one another.
   */
  readonly since?: number;
  readonly models: Readonly<Record<string, TokenCounts>>;
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

/** A model's tokens and calls; what they cost when it has a price, and how many calls each of its rules priced. */
export interface ModelUsage extends TokenCounts {
  /** The calls in the transcripts. */
  readonly calls: number;
  readonly cost?: number;
  readonly rules?: Readonly<Record<string, number>>;
  /** Of the tokens, those of calls the transcripts leave out (`UsageCall.unrecorded`). */
  readonly unrecorded?: TokenCounts;
}

/** The tokens by model (`modelKey`), and how many calls. */
export type ModelTokens = Record<string, ModelUsage>;

export const NO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** The setting that keeps only the window's provider's sessions in the session list. */
export const CURRENT_PROVIDER_ONLY_SETTING = 'vilaus.sessions.currentProviderOnly';

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
  /** The provider's prices: each call priced by its own rule. */
  readonly pricing?: ProviderPricing;
}

/**
 * The tokens of the calls that ran under `query.provider`, by model, in the three scopes. A
 * call in more than one session (copied into a forked conversation) counts once, in the session
 * it is first come to: give the sessions oldest first (the usage index gives each call to its
 * session already).
 */
export function summarizeUsage(
  sessions: Iterable<SessionUsage>,
  tagsOf: (sessionId: string) => readonly SessionTag[],
  providers: readonly AttributedProvider[],
  query: UsageQuery,
): UsageScopes {
  const session: ModelTokens = {};
  const folder: ModelTokens = {};
  const all: ModelTokens = {};
  const seen = new Set<string>();
  for (const usage of sessions) {
    const tags = tagsOf(usage.sessionId);
    const isSession = usage.sessionId === query.sessionId;
    const inFolder = usage.folder !== undefined && query.inFolder?.(usage.folder) === true;
    for (const call of usage.calls) {
      if (call.id !== undefined) {
        if (seen.has(call.id)) {
          continue;
        }
        seen.add(call.id);
      }
      if (attributeCall(call, tags, providers) !== query.provider) {
        continue;
      }
      const priced = priceCall(call, query.pricing);
      addTokens(all, call, priced);
      if (inFolder) {
        addTokens(folder, call, priced);
      }
      if (isSession) {
        addTokens(session, call, priced);
      }
    }
  }
  return { session, folder, all };
}

/**
 * One session's tokens by the provider each call ran under (those that can be told), priced
 * with each provider's prices.
 */
export function sessionUsageByProvider(
  usage: SessionUsage,
  tags: readonly SessionTag[],
  providers: readonly AttributedProvider[],
  pricingOf: (provider: string) => ProviderPricing | undefined,
): Record<string, ModelTokens> {
  const result: Record<string, ModelTokens> = {};
  const own = new Set<string>();
  for (const call of usage.calls) {
    if (call.id !== undefined) {
      if (own.has(call.id)) {
        continue;
      }
      own.add(call.id);
    }
    const provider = attributeCall(call, tags, providers);
    if (provider !== undefined) {
      addTokens((result[provider] ??= {}), call, priceCall(call, pricingOf(provider)));
    }
  }
  return result;
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

/** What a call cost and the label of the rule that priced it; undefined when its model has no price. */
export function priceCall(call: UsageCall, pricing: ProviderPricing | undefined): { cost: number; rule?: string } | undefined {
  const price = pricing?.models[modelKey(call.model)];
  if (!price) {
    return undefined;
  }
  const rule = ruleFor(price, call);
  return { cost: costAt(call, rule ?? price), rule: rule?.label };
}

const plus = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

/** Adds a call's tokens (and what it cost, `priceCall`) to the totals of its model. */
export function addTokens(totals: ModelTokens, call: UsageCall, priced?: { cost: number; rule?: string }): void {
  const model = modelKey(call.model);
  const sum = totals[model] ?? { ...NO_TOKENS, calls: 0 };
  const rules =
    priced?.rule === undefined || call.unrecorded ? sum.rules : { ...sum.rules, [priced.rule]: (sum.rules?.[priced.rule] ?? 0) + 1 };
  const unrecorded = call.unrecorded ? plus(sum.unrecorded ?? NO_TOKENS, call) : sum.unrecorded;
  totals[model] = {
    ...plus(sum, call),
    calls: sum.calls + (call.unrecorded ? 0 : 1),
    ...(priced || sum.cost !== undefined ? { cost: (sum.cost ?? 0) + (priced?.cost ?? 0) } : {}),
    ...(rules ? { rules } : {}),
    ...(unrecorded ? { unrecorded } : {}),
  };
}

const TOKEN_KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

type MutableCounts = { -readonly [K in keyof TokenCounts]: number };

/** In the id of a call `unrecordedCalls` makes up: `<session id>:unrecorded:<snapshot>:<model>`. */
export const UNRECORDED_ID = ':unrecorded:';

/** Snapshots that go on from one another (the same `since`), and the calls compared with them so far. */
interface CountRun {
  /** The next of the calls (by time) to compare. */
  next: number;
  /** The calls compared, by the model Claude Code counts them under. */
  readonly recorded: Record<string, TokenCounts>;
  recordedAll: TokenCounts;
  /** Every call compared has the name it was asked for by (`UsageCall.requested`). */
  named: boolean;
  /** What the run's snapshots have added so far. */
  readonly added: Record<string, TokenCounts>;
}

/**
 * The calls a session's transcripts leave out, from Claude Code's own counts (its snapshots,
 * in the order written). A process goes on from the last count written before it started,
 * keeping its `since`, so the snapshots with the same `since` are one run, each counting what
 * the ones before it did and more. A process that exits without writing its count (killed with
 * the app) is in no run: its calls are in the transcript, and the next process starts a run
 * of its own or goes on from an older count. So a snapshot is compared with the session's
 * calls from its `since` up to its time: what it has beyond them, by model and kind of token,
 * as far as that is more than the run's earlier snapshots had.
 *
 * Calls are compared under the name Claude Code asked for (`requested`); transcripts before
 * 2.1.296 have only the name the API answered with, and a gateway may answer with another
 * (OpenRouter). With such calls in the comparison, a snapshot adds no more than it has beyond
 * the calls in all. A snapshot that counts less of a model than the calls (another process's
 * calls in its time) adds none of it. So this can count too little, never twice.
 */
export function unrecordedCalls(sessionId: string, snapshots: readonly UsageSnapshot[], calls: readonly UsageCall[]): UsageCall[] {
  const sorted = calls.filter((call) => !call.unrecorded).sort((a, b) => a.at - b.at);
  const runs = new Map<number | undefined, CountRun>();
  const result: UsageCall[] = [];
  snapshots.forEach((snapshot, index) => {
    const since = snapshot.since;
    let run = runs.get(since);
    if (!run) {
      const first = since === undefined ? 0 : sorted.findIndex((call) => call.at >= since);
      run = { next: first < 0 ? sorted.length : first, recorded: {}, recordedAll: NO_TOKENS, named: true, added: {} };
      runs.set(since, run);
    }
    for (; run.next < sorted.length && (sorted[run.next]?.at ?? Infinity) <= snapshot.at; run.next++) {
      const call = sorted[run.next];
      if (call) {
        const model = modelKey(call.requested ?? call.model);
        run.recorded[model] = plus(run.recorded[model] ?? NO_TOKENS, call);
        run.recordedAll = plus(run.recordedAll, call);
        run.named &&= call.requested !== undefined;
      }
    }
    const { recorded, recordedAll, added } = run;
    const models = Object.entries(snapshot.models);
    const beyond = new Map<string, MutableCounts>(
      models.map(([model, tokens]) => [
        model,
        {
          input: Math.max(0, tokens.input - (recorded[model]?.input ?? 0)),
          output: Math.max(0, tokens.output - (recorded[model]?.output ?? 0)),
          cacheRead: Math.max(0, tokens.cacheRead - (recorded[model]?.cacheRead ?? 0)),
          cacheWrite: Math.max(0, tokens.cacheWrite - (recorded[model]?.cacheWrite ?? 0)),
        },
      ]),
    );
    if (!run.named) {
      const counted = models.reduce<TokenCounts>((sum, [, tokens]) => plus(sum, tokens), NO_TOKENS);
      for (const kind of TOKEN_KINDS) {
        const room = Math.max(0, counted[kind] - recordedAll[kind]);
        const wanted = [...beyond.values()].reduce((sum, tokens) => sum + tokens[kind], 0);
        if (wanted > room) {
          for (const tokens of beyond.values()) {
            tokens[kind] = Math.floor((tokens[kind] * room) / wanted);
          }
        }
      }
    }
    // The last line before a run's first count may be from long before its process started.
    const at = since === undefined ? snapshot.at : Math.max(snapshot.at, since);
    for (const [model, tokens] of beyond) {
      const before = added[model] ?? NO_TOKENS;
      const extra = {
        input: Math.max(0, tokens.input - before.input),
        output: Math.max(0, tokens.output - before.output),
        cacheRead: Math.max(0, tokens.cacheRead - before.cacheRead),
        cacheWrite: Math.max(0, tokens.cacheWrite - before.cacheWrite),
      };
      if (TOKEN_KINDS.some((kind) => extra[kind] > 0)) {
        added[model] = plus(before, extra);
        result.push({ id: `${sessionId}${UNRECORDED_ID}${index}:${model}`, at, model, ...extra, unrecorded: true });
      }
    }
  });
  return result;
}

/** What tokens cost at a model's own prices (per million tokens); the cache prices default to the input price. */
export function costOf(tokens: TokenCounts, price: Prices): number {
  return costAt(tokens, price);
}

/**
 * What a model's tokens cost: as `summarizeUsage` priced its calls (by their rules), else at
 * the model's own prices; undefined when it has none.
 */
export function modelCost(model: string, tokens: ModelUsage, pricing: ProviderPricing | undefined): number | undefined {
  const price: ModelPrice | undefined = pricing?.models[model];
  if (!price) {
    return undefined;
  }
  return tokens.cost ?? costOf(tokens, price);
}

/** What the models' tokens cost, and the models that have no price (their tokens cost nothing here). */
export function totalCost(models: ModelTokens, pricing: ProviderPricing | undefined): { cost: number; unpriced: string[] } {
  let cost = 0;
  const unpriced: string[] = [];
  for (const [model, tokens] of Object.entries(models)) {
    const priced = modelCost(model, tokens, pricing);
    if (priced === undefined) {
      unpriced.push(model);
    } else {
      cost += priced;
    }
  }
  return { cost, unpriced: unpriced.sort() };
}
