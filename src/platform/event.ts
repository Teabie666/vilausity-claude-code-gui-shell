/**
 * Typed events. `Event<T>` has the same call signature as `vscode.Event<T>`, so the
 * compatibility layer can hand these straight to the Claude Code extension.
 */

import { DisposableStore, toDisposable, type IDisposable } from './lifecycle';

export type Listener<T> = (e: T) => unknown;

export interface Event<T> {
  (listener: Listener<T>, thisArgs?: unknown, disposables?: IDisposable[] | DisposableStore): IDisposable;
}

export interface EmitterOptions {
  onFirstListenerAdd?: () => void;
  onLastListenerRemove?: () => void;
  onListenerError?: (error: unknown) => void;
}

interface ListenerEntry<T> {
  readonly fn: Listener<T>;
  readonly thisArgs: unknown;
}

let unexpectedErrorHandler: (error: unknown) => void = (error) => {
  console.error('[vilaus] event listener threw:', error);
};

/**
 * Lets each process route listener errors to its logger instead of the console.
 * Returns the previous handler, so a caller (e.g. a test) can put it back.
 */
export function setUnexpectedErrorHandler(handler: (error: unknown) => void): (error: unknown) => void {
  const previous = unexpectedErrorHandler;
  unexpectedErrorHandler = handler;
  return previous;
}

export class Emitter<T> implements IDisposable {
  private listeners: ListenerEntry<T>[] | undefined = [];
  private cachedEvent: Event<T> | undefined;

  constructor(private readonly options?: EmitterOptions) {}

  get event(): Event<T> {
    this.cachedEvent ??= (fn, thisArgs, disposables) => {
      const listeners = this.listeners;
      if (!listeners) {
        return toDisposable(() => {});
      }
      const entry: ListenerEntry<T> = { fn, thisArgs };
      if (listeners.length === 0) {
        this.options?.onFirstListenerAdd?.();
      }
      listeners.push(entry);
      const subscription = toDisposable(() => {
        const current = this.listeners;
        if (!current) {
          return;
        }
        const index = current.indexOf(entry);
        if (index >= 0) {
          current.splice(index, 1);
          if (current.length === 0) {
            this.options?.onLastListenerRemove?.();
          }
        }
      });
      if (Array.isArray(disposables)) {
        disposables.push(subscription);
      } else {
        disposables?.add(subscription);
      }
      return subscription;
    };
    return this.cachedEvent;
  }

  get hasListeners(): boolean {
    return (this.listeners?.length ?? 0) > 0;
  }

  fire(value: T): void {
    if (!this.listeners) {
      return;
    }
    // Snapshot so listeners that unsubscribe while firing do not skip their neighbours.
    for (const { fn, thisArgs } of [...this.listeners]) {
      try {
        fn.call(thisArgs, value);
      } catch (error) {
        (this.options?.onListenerError ?? unexpectedErrorHandler)(error);
      }
    }
  }

  dispose(): void {
    this.listeners = undefined;
  }
}

export const Event = {
  /** An event that never fires. */
  None: ((): IDisposable => toDisposable(() => {})) as Event<never>,

  once<T>(event: Event<T>): Event<T> {
    return (listener, thisArgs, disposables) => {
      let fired = false;
      // Unset while `event` is still subscribing: an event may fire synchronously from
      // inside that call (VS Code's Event.once handles the same case).
      let subscription: IDisposable | undefined;
      subscription = event(
        (e) => {
          if (fired) {
            return;
          }
          fired = true;
          subscription?.dispose();
          return listener.call(thisArgs, e);
        },
        undefined,
        disposables,
      );
      if (fired) {
        subscription.dispose();
      }
      return subscription;
    };
  },

  toPromise<T>(event: Event<T>): Promise<T> {
    return new Promise((resolve) => {
      Event.once(event)(resolve);
    });
  },
};
