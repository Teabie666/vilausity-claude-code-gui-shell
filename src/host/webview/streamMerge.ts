/**
 * Merges what the extension streams to a conversation page a token at a time before the page
 * gets it (see StreamMergeHints in platform/protocol.ts: the page renders the whole
 * conversation again for every message, and fast APIs stream hundreds a second).
 *
 * The bootstrap installs this before the page's own scripts run. On window, 'message'
 * listeners run in the order they were added, capture or not, so this one sees every message
 * first: it keeps the streamed ones from the page and hands it each run as one message.
 */

import type { MessagePath, StreamMergeHints, StreamMergeRule } from '../../platform/protocol';

/** The longest a run is held, however slowly the page renders (ms). */
const MAX_WAIT_MS = 1000;

export function valueAt(data: unknown, path: MessagePath): unknown {
  let value = data;
  for (const name of path) {
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[name];
  }
  return value;
}

function setAt(data: unknown, path: MessagePath, value: unknown): void {
  const parent = valueAt(data, path.slice(0, -1));
  const name = path[path.length - 1];
  if (typeof parent === 'object' && parent !== null && name !== undefined) {
    (parent as Record<string, unknown>)[name] = value;
  }
}

/** The rule a message is of and the key it merges by; undefined when no rule takes it. */
export function classify(
  data: unknown,
  rules: readonly StreamMergeRule[],
): { readonly rule: StreamMergeRule; readonly key: string } | undefined {
  for (const [index, rule] of rules.entries()) {
    if (!rule.match.every(([path, value]) => valueAt(data, path) === value)) {
      continue;
    }
    // Only what the rule can merge: the text to join, numbers to add up.
    if (rule.append && typeof valueAt(data, rule.append) !== 'string') {
      return undefined;
    }
    if (rule.sum?.some((path) => typeof valueAt(data, path) !== 'number')) {
      return undefined;
    }
    return { rule, key: JSON.stringify([index, ...rule.key.map((path) => valueAt(data, path) ?? null)]) };
  }
  return undefined;
}

/** `next` merged into `held`, both messages of `rule` with one key; the result may be either object. */
export function merge(held: unknown, next: unknown, rule: StreamMergeRule): unknown {
  if (rule.append) {
    setAt(held, rule.append, `${valueAt(held, rule.append) as string}${valueAt(next, rule.append) as string}`);
    return held;
  }
  for (const path of rule.sum ?? []) {
    setAt(next, path, (valueAt(held, path) as number) + (valueAt(next, path) as number));
  }
  return next;
}

export interface StreamMergerHost<E> {
  /** Hands the page a message: `data` in place of what `event` carried. */
  deliver(event: E, data: unknown): void;
  /** After a run of deliveries. */
  delivered(): void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

export class StreamMerger<E> {
  /** By key, in the order each first came. */
  private readonly held = new Map<string, { readonly event: E; data: unknown }>();
  private timer: unknown;
  /** How long the page took over what it was last handed (ms). */
  private renderMs = 0;

  constructor(
    private readonly hints: StreamMergeHints,
    private readonly host: StreamMergerHost<E>,
  ) {}

  /** Whether the message is held (to go to the page later, merged); if not, it goes on now. */
  take(event: E, data: unknown): boolean {
    const kind = classify(data, this.hints.rules);
    if (!kind) {
      // What came before goes to the page first.
      this.flush();
      return false;
    }
    const held = this.held.get(kind.key);
    if (held) {
      held.data = merge(held.data, data, kind.rule);
    } else {
      this.held.set(kind.key, { event, data });
    }
    // A page that renders slowly waits as long again: rendering never takes more than half its time.
    this.timer ??= this.host.setTimer(
      () => {
        this.timer = undefined;
        this.flush();
      },
      Math.min(MAX_WAIT_MS, Math.max(this.hints.intervalMs, this.renderMs)),
    );
    return true;
  }

  flush(): void {
    if (this.timer !== undefined) {
      this.host.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (this.held.size === 0) {
      return;
    }
    const held = [...this.held.values()];
    this.held.clear();
    for (const { event, data } of held) {
      this.host.deliver(event, data);
    }
    this.host.delivered();
  }

  /** How long the page took over the last run it was handed. */
  rendered(ms: number): void {
    this.renderMs = ms;
  }
}

export function installStreamMerging(hints: StreamMergeHints): void {
  const ours = new WeakSet<Event>();
  // The page renders what it is handed right away (a microtask): the next task tells how long that took.
  const clock = new MessageChannel();
  let handedAt: number | undefined;
  const merger = new StreamMerger<MessageEvent>(hints, {
    deliver(event, data) {
      handedAt ??= performance.now();
      const merged = new MessageEvent('message', { data, origin: event.origin, source: event.source, lastEventId: event.lastEventId });
      ours.add(merged);
      window.dispatchEvent(merged);
    },
    delivered() {
      clock.port2.postMessage(handedAt);
      handedAt = undefined;
    },
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  });
  clock.port1.onmessage = (event: MessageEvent<number>) => merger.rendered(performance.now() - event.data);
  window.addEventListener(
    'message',
    (event) => {
      if (!ours.has(event) && merger.take(event, event.data)) {
        event.stopImmediatePropagation();
      }
    },
    true,
  );
}
