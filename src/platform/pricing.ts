/**
 * API prices: what a model costs per million tokens, and the rules that change that by the
 * call (the time of day, the length of its input or output, thinking), the first that holds
 * winning. The user types the plain prices into the providers editor; rules come from an AI
 * chat's answer to `pricingPrompt`, pasted back there. Both, and providers.json, are read by
 * `readPricing`: strictly for a paste (every problem is told, with where it is), leniently for
 * the stored copy (what does not hold is left out).
 */

export type Currency = 'CNY' | 'USD';

/** Per million tokens, in the provider's currency. */
export interface Prices {
  readonly input: number;
  readonly output: number;
  /** Tokens read from the prompt cache; the input price when not given. */
  readonly cacheRead?: number;
  /** Tokens written to the prompt cache; the input price when not given. */
  readonly cacheWrite?: number;
}

/** When a rule holds: every condition given must. */
export interface PriceWhen {
  /** The IANA time zone of `days`, `from`, `to` and the dates. */
  readonly zone?: string;
  /** The call's local day: 1 = Monday ... 7 = Sunday. */
  readonly days?: readonly number[];
  /** Local time of day, "HH:MM", from `from` up to (not including) `to`; past midnight when `to` is earlier. */
  readonly from?: string;
  readonly to?: string;
  /** Local dates, "YYYY-MM-DD", both included. */
  readonly startDate?: string;
  readonly endDate?: string;
  /** The call's input tokens, cache hits and writes included: over `inputOver`, up to `inputUpTo` (included). */
  readonly inputOver?: number;
  readonly inputUpTo?: number;
  readonly outputOver?: number;
  readonly outputUpTo?: number;
  /** Whether the reply thought (had a thinking block). */
  readonly thinking?: boolean;
}

/** Other prices for the calls `when` holds for. */
export interface PriceRule extends Prices {
  readonly label: string;
  readonly when: PriceWhen;
}

/** What a model costs: its prices, unless one of its rules holds for the call. */
export interface ModelPrice extends Prices {
  readonly rules?: readonly PriceRule[];
}

export interface PricingSource {
  readonly url: string;
  /** "YYYY-MM-DD" */
  readonly checked?: string;
}

/** The prices of a provider's models, for working out what its conversations cost. */
export interface ProviderPricing {
  readonly currency: Currency;
  /** By model, named as `modelKey` writes it. */
  readonly models: Readonly<Record<string, ModelPrice>>;
  /** Where the rules were read from. */
  readonly sources?: readonly PricingSource[];
  /** What the prices leave out (holidays, fees by the request, cache storage by the hour...). */
  readonly notes?: readonly string[];
}

/** What a pasted answer has besides the prices, for its preview (not kept). */
export interface PricingAnswer {
  readonly pricing: ProviderPricing;
  /** Models the answer found no price for, and why. */
  readonly missing: Readonly<Record<string, string>>;
  /** By model: the words of the price page the answer read the prices from. */
  readonly evidence: Readonly<Record<string, string>>;
}

export type PricingProblemCode =
  | 'cannotBrowse'
  | 'noJson'
  | 'badJson'
  | 'notObject'
  | 'unknownKey'
  | 'missing'
  | 'notNumber'
  | 'notInteger'
  | 'notString'
  | 'notBoolean'
  | 'badCurrency'
  | 'badZone'
  | 'zoneNeeded'
  | 'badDays'
  | 'badTime'
  | 'timePair'
  | 'badDate'
  | 'badRange'
  | 'emptyWhen'
  | 'noModels';

/** A problem of a pasted answer: `path` says where (`models["x"].rules[0].when.from`). */
export interface PricingProblem {
  readonly path: string;
  readonly code: PricingProblemCode;
  /** What was there, or the key, as the message wants it. */
  readonly detail?: string;
}

/** The version of the pasted format; `vilausPricing` in it. */
export const PRICING_FORMAT = 1;

/**
 * A model's name as prices and usage compare it: `deepseek-flash[1m]` (the 1M-context marker
 * Claude Code strips before it sends the name) and `DeepSeek-Flash` are `deepseek-flash`.
 */
export function modelKey(model: string): string {
  return model
    .trim()
    .replace(/\[[^\]]*\]$/, '')
    .trim()
    .toLowerCase();
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
const WHEN_KEYS = [
  'zone',
  'days',
  'from',
  'to',
  'startDate',
  'endDate',
  'inputOver',
  'inputUpTo',
  'outputOver',
  'outputUpTo',
  'thinking',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function validDate(text: string): boolean {
  if (!DATE.test(text)) {
    return false;
  }
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

/** Collects the problems of one reading; a lenient reading collects them too, and drops what has any. */
class Reader {
  readonly problems: PricingProblem[] = [];

  problem(path: string, code: PricingProblemCode, detail?: string): void {
    this.problems.push({ path, code, detail });
  }

  /** Only the keys given: a misspelled one (`cache_read`) would otherwise go unnoticed. */
  keys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.problem(path, 'unknownKey', key);
      }
    }
  }

  price(value: unknown, path: string, required: boolean): number | undefined {
    if (value === undefined && !required) {
      return undefined;
    }
    if (value === undefined) {
      this.problem(path, 'missing');
    } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      this.problem(path, 'notNumber', JSON.stringify(value));
    } else {
      return value;
    }
    return undefined;
  }

  tokens(value: unknown, path: string): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      this.problem(path, 'notInteger', JSON.stringify(value));
      return undefined;
    }
    return value;
  }

  string(value: unknown, path: string): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      this.problem(path, 'notString', JSON.stringify(value));
      return undefined;
    }
    return value.trim();
  }

  prices(value: Record<string, unknown>, path: string): Prices | undefined {
    const before = this.problems.length;
    const input = this.price(value.input, `${path}.input`, true);
    const output = this.price(value.output, `${path}.output`, true);
    const cacheRead = this.price(value.cacheRead, `${path}.cacheRead`, false);
    const cacheWrite = this.price(value.cacheWrite, `${path}.cacheWrite`, false);
    if (this.problems.length > before || input === undefined || output === undefined) {
      return undefined;
    }
    return { input, output, ...(cacheRead === undefined ? {} : { cacheRead }), ...(cacheWrite === undefined ? {} : { cacheWrite }) };
  }

  when(value: unknown, path: string): PriceWhen | undefined {
    if (!isRecord(value)) {
      this.problem(path, value === undefined ? 'missing' : 'notObject');
      return undefined;
    }
    const before = this.problems.length;
    this.keys(value, path, WHEN_KEYS);
    const when: Record<string, unknown> = {};
    const zone = this.string(value.zone, `${path}.zone`);
    if (zone !== undefined) {
      if (validZone(zone)) {
        when.zone = zone;
      } else {
        this.problem(`${path}.zone`, 'badZone', zone);
      }
    }
    if (value.days !== undefined) {
      const days = value.days;
      if (
        !Array.isArray(days) ||
        days.length === 0 ||
        days.some((day) => !Number.isInteger(day) || (day as number) < 1 || (day as number) > 7) ||
        new Set(days).size !== days.length
      ) {
        this.problem(`${path}.days`, 'badDays', JSON.stringify(days));
      } else {
        when.days = [...(days as number[])].sort((a, b) => a - b);
      }
    }
    for (const key of ['from', 'to'] as const) {
      const text = this.string(value[key], `${path}.${key}`);
      if (text === undefined) {
        continue;
      }
      if (TIME.test(text) || (key === 'to' && text === '24:00')) {
        when[key] = text;
      } else {
        this.problem(`${path}.${key}`, 'badTime', text);
      }
    }
    if ((value.from === undefined) !== (value.to === undefined) || (when.from !== undefined && when.from === when.to)) {
      this.problem(path, 'timePair');
    }
    for (const key of ['startDate', 'endDate'] as const) {
      const text = this.string(value[key], `${path}.${key}`);
      if (text === undefined) {
        continue;
      }
      if (validDate(text)) {
        when[key] = text;
      } else {
        this.problem(`${path}.${key}`, 'badDate', text);
      }
    }
    if (typeof when.startDate === 'string' && typeof when.endDate === 'string' && when.startDate > when.endDate) {
      this.problem(path, 'badRange', `${when.startDate} > ${when.endDate}`);
    }
    for (const side of ['input', 'output'] as const) {
      const over = this.tokens(value[`${side}Over`], `${path}.${side}Over`);
      const upTo = this.tokens(value[`${side}UpTo`], `${path}.${side}UpTo`);
      if (over !== undefined) {
        when[`${side}Over`] = over;
      }
      if (upTo !== undefined) {
        when[`${side}UpTo`] = upTo;
      }
      if (over !== undefined && upTo !== undefined && over >= upTo) {
        this.problem(path, 'badRange', `${side}Over ${over} >= ${side}UpTo ${upTo}`);
      }
    }
    if (value.thinking !== undefined) {
      if (typeof value.thinking === 'boolean') {
        when.thinking = value.thinking;
      } else {
        this.problem(`${path}.thinking`, 'notBoolean', JSON.stringify(value.thinking));
      }
    }
    const timed = ['days', 'from', 'startDate', 'endDate'].some((key) => value[key] !== undefined);
    if (timed && value.zone === undefined) {
      this.problem(path, 'zoneNeeded');
    }
    if (Object.keys(value).length === 0) {
      this.problem(path, 'emptyWhen');
    }
    return this.problems.length > before ? undefined : (when as PriceWhen);
  }

  rule(value: unknown, path: string): PriceRule | undefined {
    if (!isRecord(value)) {
      this.problem(path, 'notObject');
      return undefined;
    }
    const before = this.problems.length;
    this.keys(value, path, ['label', 'when', ...PRICE_KEYS]);
    const label = this.string(value.label, `${path}.label`);
    if (value.label === undefined) {
      this.problem(`${path}.label`, 'missing');
    }
    const when = this.when(value.when, `${path}.when`);
    const prices = this.prices(value, path);
    if (this.problems.length > before || label === undefined || !when || !prices) {
      return undefined;
    }
    return { label, when, ...prices };
  }

  model(value: unknown, path: string): ModelPrice | undefined {
    if (!isRecord(value)) {
      this.problem(path, 'notObject');
      return undefined;
    }
    const before = this.problems.length;
    this.keys(value, path, ['rules', ...PRICE_KEYS]);
    const prices = this.prices(value, path);
    const rules: PriceRule[] = [];
    if (value.rules !== undefined) {
      if (Array.isArray(value.rules)) {
        value.rules.forEach((rule, index) => {
          const read = this.rule(rule, `${path}.rules[${index}]`);
          if (read) {
            rules.push(read);
          }
        });
      } else {
        this.problem(`${path}.rules`, 'notObject');
      }
    }
    // A rule with problems goes alone (a strict reading takes nothing that has problems anyway).
    if (!prices || this.problems.slice(before).some((problem) => !problem.path.startsWith(`${path}.rules`))) {
      return undefined;
    }
    return rules.length > 0 ? { ...prices, rules } : prices;
  }

  /** Model name to text (`missing`, `evidence`). */
  texts(value: unknown, path: string): Record<string, string> {
    const texts: Record<string, string> = {};
    if (value === undefined) {
      return texts;
    }
    if (!isRecord(value)) {
      this.problem(path, 'notObject');
      return texts;
    }
    for (const [name, text] of Object.entries(value)) {
      const read = this.string(text, `${path}[${JSON.stringify(name)}]`);
      if (read !== undefined && modelKey(name)) {
        texts[modelKey(name)] = read;
      }
    }
    return texts;
  }
}

/**
 * Reads prices: `strict` for an answer pasted into the editor (its own keys too, and at least
 * one model), where any problem means it is not taken; else for providers.json, where models
 * and rules with problems are left out and the rest is kept.
 */
export function readPricing(value: unknown, strict: boolean): { answer: PricingAnswer | undefined; problems: PricingProblem[] } {
  const reader = new Reader();
  if (!isRecord(value)) {
    reader.problem('', 'notObject');
    return { answer: undefined, problems: reader.problems };
  }
  if (strict) {
    reader.keys(value, '', ['vilausPricing', 'currency', 'models', 'sources', 'notes', 'missing', 'evidence']);
  }
  let currency: Currency = 'USD';
  if (value.currency === 'CNY' || value.currency === 'USD') {
    currency = value.currency;
  } else if (strict) {
    reader.problem('currency', value.currency === undefined ? 'missing' : 'badCurrency', JSON.stringify(value.currency));
  }
  const models: Record<string, ModelPrice> = {};
  if (isRecord(value.models)) {
    for (const [name, entry] of Object.entries(value.models)) {
      const key = modelKey(name);
      const read = reader.model(entry, `models[${JSON.stringify(name)}]`);
      if (key && read) {
        models[key] = read;
      }
    }
  } else if (strict || value.models !== undefined) {
    reader.problem('models', value.models === undefined ? 'missing' : 'notObject');
  }
  const sources: PricingSource[] = [];
  if (Array.isArray(value.sources)) {
    value.sources.forEach((source, index) => {
      const path = `sources[${index}]`;
      if (!isRecord(source)) {
        reader.problem(path, 'notObject');
        return;
      }
      reader.keys(source, path, ['url', 'checked']);
      const url = reader.string(source.url, `${path}.url`);
      const checked = reader.string(source.checked, `${path}.checked`);
      if (checked !== undefined && !validDate(checked)) {
        reader.problem(`${path}.checked`, 'badDate', checked);
      }
      if (url !== undefined) {
        sources.push({ url, ...(checked !== undefined && validDate(checked) ? { checked } : {}) });
      }
    });
  } else if (value.sources !== undefined) {
    reader.problem('sources', 'notObject');
  }
  const notes: string[] = [];
  if (Array.isArray(value.notes)) {
    value.notes.forEach((note, index) => {
      const read = reader.string(note, `notes[${index}]`);
      if (read !== undefined) {
        notes.push(read);
      }
    });
  } else if (value.notes !== undefined) {
    reader.problem('notes', 'notObject');
  }
  const missing = reader.texts(value.missing, 'missing');
  const evidence = reader.texts(value.evidence, 'evidence');
  if (strict && Object.keys(models).length === 0 && reader.problems.length === 0) {
    reader.problem('models', 'noModels');
  }
  const pricing: ProviderPricing = {
    currency,
    models,
    ...(sources.length > 0 ? { sources } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
  if (strict && reader.problems.length > 0) {
    return { answer: undefined, problems: reader.problems };
  }
  return { answer: { pricing, missing, evidence }, problems: reader.problems };
}

/**
 * Reads what was pasted: the JSON of an answer, also inside a Markdown code block or with words
 * around it (chats add them, asked not to or not).
 */
export function readPricingAnswer(text: string): { answer: PricingAnswer | undefined; problems: PricingProblem[] } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) {
    const code: PricingProblemCode = /CANNOT_BROWSE/.test(text) ? 'cannotBrowse' : 'noJson';
    return { answer: undefined, problems: [{ path: '', code }] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return { answer: undefined, problems: [{ path: '', code: 'badJson', detail: error instanceof Error ? error.message : String(error) }] };
  }
  return readPricing(value, true);
}

/** Prices in the pasted format, to copy out of the editor (and paste back, or into a chat). */
export function pricingJson(pricing: ProviderPricing): string {
  return JSON.stringify({ vilausPricing: PRICING_FORMAT, ...pricing }, null, 2);
}

/** What a call is priced by. */
export interface PricedCall {
  /** Epoch ms. */
  readonly at: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly thinking?: boolean;
}

/** UTC offsets (ms) by zone and hour: a zone's offset changes on the hour, and the calls come in runs. */
const offsets = new Map<string, number>();
const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneOffset(zone: string, at: number): number {
  const hour = Math.floor(at / 3_600_000);
  const key = `${zone} ${hour}`;
  let offset = offsets.get(key);
  if (offset === undefined) {
    let format = formatters.get(zone);
    if (!format) {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      });
      formatters.set(zone, format);
    }
    const parts = Object.fromEntries(format.formatToParts(hour * 3_600_000).map((part) => [part.type, part.value]));
    const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    offset = local - hour * 3_600_000;
    if (offsets.size > 100_000) {
      offsets.clear();
    }
    offsets.set(key, offset);
  }
  return offset;
}

function minutesOf(time: string): number {
  return time === '24:00' ? 1440 : Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function within(value: number, over: number | undefined, upTo: number | undefined): boolean {
  return (over === undefined || value > over) && (upTo === undefined || value <= upTo);
}

/** Whether a rule's conditions all hold for a call. */
export function ruleHolds(when: PriceWhen, call: PricedCall): boolean {
  if (!within(call.input + call.cacheRead + call.cacheWrite, when.inputOver, when.inputUpTo)) {
    return false;
  }
  if (!within(call.output, when.outputOver, when.outputUpTo)) {
    return false;
  }
  if (when.thinking !== undefined && when.thinking !== (call.thinking === true)) {
    return false;
  }
  if (when.zone !== undefined && (when.days || when.from !== undefined || when.startDate || when.endDate)) {
    const local = new Date(call.at + zoneOffset(when.zone, call.at));
    const day = ((local.getUTCDay() + 6) % 7) + 1;
    if (when.days && !when.days.includes(day)) {
      return false;
    }
    if (when.from !== undefined && when.to !== undefined) {
      const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
      const from = minutesOf(when.from);
      const to = minutesOf(when.to);
      if (from < to ? minute < from || minute >= to : minute < from && minute >= to) {
        return false;
      }
    }
    const date = local.toISOString().slice(0, 10);
    if ((when.startDate && date < when.startDate) || (when.endDate && date > when.endDate)) {
      return false;
    }
  }
  return true;
}

/** The rule a call is priced by, if one holds (else the model's own prices). */
export function ruleFor(price: ModelPrice, call: PricedCall): PriceRule | undefined {
  return price.rules?.find((rule) => ruleHolds(rule.when, call));
}

/** What a call (or tokens added up) costs at some prices; the cache prices default to the input price. */
export function costAt(tokens: Omit<PricedCall, 'at'>, prices: Prices): number {
  return (
    (tokens.input * prices.input +
      tokens.output * prices.output +
      tokens.cacheRead * (prices.cacheRead ?? prices.input) +
      tokens.cacheWrite * (prices.cacheWrite ?? prices.input)) /
    1e6
  );
}

export interface PricingPromptInput {
  readonly provider: string;
  readonly baseUrl?: string;
  /** The official price page, when known. */
  readonly pricesUrl?: string;
  readonly currency: Currency;
  /** As `modelKey` writes them. */
  readonly models: readonly string[];
  /** The language the labels and notes are to be in, in English ("Chinese (Simplified)"). */
  readonly language: string;
  /** "YYYY-MM-DD" */
  readonly today: string;
}

const PROMPT_EXAMPLE = {
  vilausPricing: PRICING_FORMAT,
  currency: 'USD',
  models: {
    'model-a': {
      input: 4,
      cacheRead: 0.4,
      output: 16,
      rules: [
        {
          label: 'Off-peak',
          when: { zone: 'Asia/Shanghai', days: [1, 2, 3, 4, 5], from: '00:30', to: '08:30' },
          input: 2,
          cacheRead: 0.2,
          output: 8,
        },
      ],
    },
    'model-b': {
      input: 1,
      output: 4,
      rules: [
        { label: 'Input 32K-128K', when: { inputOver: 32000, inputUpTo: 128000 }, input: 2, output: 8 },
        { label: 'Input over 128K', when: { inputOver: 128000 }, input: 4, output: 16 },
      ],
    },
  },
  sources: [{ url: 'https://example.com/pricing', checked: '2026-01-31' }],
  evidence: { 'model-a': '(a short quote of the page with the prices)', 'model-b': '(...)' },
  missing: { 'model-c': 'not on the price page' },
  notes: ['(anything the prices leave out)'],
};

/**
 * What to ask an AI chat (one that can open web pages) for a provider's prices, rules included,
 * in the format `readPricingAnswer` reads. Not UI text: it is for the AI, so it stays in English;
 * the answer's labels and notes come in the user's language.
 */
export function pricingPrompt(input: PricingPromptInput): string {
  const lines = [
    `I need the current API prices of ${input.provider}, read from its official price page, as JSON for an app that works out what each API call cost from its token counts.`,
    '',
    `Provider: ${input.provider}`,
    ...(input.baseUrl ? [`API base URL in use: ${input.baseUrl} (price the platform this URL belongs to: its region and currency)`] : []),
    `Official price page: ${input.pricesUrl ?? "not known: find the provider's own price page"}`,
    `Models (as the API names them): ${input.models.length > 0 ? input.models.join(', ') : 'all of its chat models'}`,
    `Currency: ${input.currency}, unless the page for this API is in another one (then use the page's and say so in "notes")`,
    `Today: ${input.today}`,
    '',
    'How to do it:',
    "1. Open the price page now and take the prices from it, or from other pages of the provider's own site or documentation. Not from memory, other sites, news or guesses. If you cannot open web pages, answer only CANNOT_BROWSE.",
    '2. A model you find no price for goes into "missing" with the reason; do not price it. If a model name is an alias of another (a dated version, a "latest"), price it as that model and say so in "evidence".',
    '3. Prices are per 1 million tokens. If the page gives them per 1 thousand, multiply by 1000.',
    '4. "input": input tokens that are not cache hits; "cacheRead": cache hits; "cacheWrite": tokens written to the cache, only if the page charges for that apart from input; "output": output tokens, thinking included. Leave out what the page has no price for.',
    '5. Prices that depend on the call go into "rules", in order: the first rule whose conditions all hold prices that whole call (all four prices, written out); with none, the model\'s own prices do. Conditions, all optional:',
    '   - "zone": the IANA time zone the page means ("Asia/Shanghai" for Beijing time), needed with the ones below it;',
    '   - "days": the local days, 1 = Monday ... 7 = Sunday;',
    '   - "from", "to": local time of day "HH:MM", from included, to not; a window past midnight with "days" goes into two rules, one each side of midnight;',
    '   - "startDate", "endDate": local dates "YYYY-MM-DD", both included, for prices that hold only for a while (an offer);',
    '   - "inputOver", "inputUpTo": the call\'s input tokens (cache hits included), over the first and up to and including the second; "outputOver", "outputUpTo" the same for output. Whole numbers: "32K" is 32000 unless the page says 1K = 1024;',
    '   - "thinking": true or false, if thinking mode is priced apart.',
    '   If tiers price only the tokens past a threshold higher (not the whole call), or prices depend on anything else (holidays, a fee per request, cache storage by the hour, free quotas, batch), leave that out and explain it in "notes".',
    `6. Every rule has a short "label"; labels and notes in ${input.language}.`,
    '7. "sources": every page you took prices from, "checked": today. "evidence": for each model you priced, a short quote of the page with its prices, as written there.',
    '',
    'Answer with one JSON code block and nothing else, in this form (the names and numbers are made up):',
    '```json',
    JSON.stringify(PROMPT_EXAMPLE, null, 2),
    '```',
  ];
  return lines.join('\n');
}
