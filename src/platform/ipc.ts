/**
 * A small typed RPC layer used on every process boundary (main <-> extension host,
 * extension host <-> renderer, renderer <-> main).
 *
 * Each side declares the methods it serves as an object type in protocol.ts. `call`
 * waits for a result, `notify` is fire-and-forget; both are checked against the remote
 * side's declared shape. Transports are injected, so this file has no Electron or DOM
 * dependency and can be unit-tested with an in-memory pair.
 */

import type { ILogger } from './log';
import { NullLogger } from './log';
import type { IDisposable } from './lifecycle';
import { toDisposable } from './lifecycle';

/**
 * The method map one side serves. Must be declared with `type`, not `interface`:
 * only object type aliases are assignable to an index signature.
 */
export type ApiShape = { [method: string]: (params: never, ports: never) => unknown };

export type ParamsOf<A extends ApiShape, M extends keyof A> = Parameters<A[M]>[0];
export type ResultOf<A extends ApiShape, M extends keyof A> = Awaited<ReturnType<A[M]>>;

export type Handler<A extends ApiShape, M extends keyof A, TPort> = (
  params: ParamsOf<A, M>,
  ports: readonly TPort[],
) => ResultOf<A, M> | Promise<ResultOf<A, M>>;

/** Anything that can carry structured-clone messages, optionally with transferred ports. */
export interface MessageTransport<TPort = unknown> {
  send(message: unknown, transfer?: TPort[]): void;
  listen(handler: (message: unknown, ports: readonly TPort[]) => void): IDisposable;
}

interface WireRequest {
  readonly t: 'q';
  /** Absent for notifications. */
  readonly id?: number;
  readonly m: string;
  readonly p?: unknown;
}

interface WireResponse {
  readonly t: 's';
  readonly id: number;
  readonly r?: unknown;
  readonly e?: WireError;
}

interface WireError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

/** An error thrown on the other side of a call. `remoteStack` keeps its original stack. */
export class RemoteError extends Error {
  constructor(
    readonly method: string,
    readonly remoteName: string,
    message: string,
    readonly remoteStack: string | undefined,
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

interface PendingCall {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export class RpcEndpoint<Local extends ApiShape, Remote extends ApiShape, TPort = unknown> implements IDisposable {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly handlers = new Map<string, (params: unknown, ports: readonly TPort[]) => unknown>();
  private readonly subscription: IDisposable;
  private disposed = false;

  constructor(
    private readonly transport: MessageTransport<TPort>,
    private readonly name: string,
    private readonly logger: ILogger = NullLogger,
  ) {
    this.subscription = transport.listen((message, ports) => this.onMessage(message, ports));
  }

  call<M extends keyof Remote & string>(method: M, params: ParamsOf<Remote, M>, transfer?: TPort[]): Promise<ResultOf<Remote, M>> {
    if (this.disposed) {
      return Promise.reject(new Error(`[${this.name}] endpoint disposed; cannot call ${method}`));
    }
    const id = this.nextId++;
    return new Promise<ResultOf<Remote, M>>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.send({ t: 'q', id, m: method, p: params }, transfer);
    });
  }

  notify<M extends keyof Remote & string>(method: M, params: ParamsOf<Remote, M>, transfer?: TPort[]): void {
    if (this.disposed) {
      this.logger.debug(`[${this.name}] dropped notification ${method} after dispose`);
      return;
    }
    this.send({ t: 'q', m: method, p: params }, transfer);
  }

  handle<M extends keyof Local & string>(method: M, handler: Handler<Local, M, TPort>): IDisposable {
    if (this.handlers.has(method)) {
      throw new Error(`[${this.name}] handler for ${method} registered twice`);
    }
    this.handlers.set(method, handler as (params: unknown, ports: readonly TPort[]) => unknown);
    return toDisposable(() => this.handlers.delete(method));
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.subscription.dispose();
    const error = new Error(`[${this.name}] endpoint disposed`);
    for (const call of this.pending.values()) {
      call.reject(error);
    }
    this.pending.clear();
    this.handlers.clear();
  }

  private send(message: WireRequest | WireResponse, transfer?: TPort[]): void {
    try {
      this.transport.send(message, transfer);
    } catch (error) {
      this.logger.error(`[${this.name}] failed to send ${describe(message)}`, error);
      if (message.t === 'q' && message.id !== undefined) {
        // The request never left this process (e.g. params that cannot be cloned): reject
        // with the local error itself, not a RemoteError that blames the other side.
        const call = this.pending.get(message.id);
        this.pending.delete(message.id);
        call?.reject(error);
      }
    }
  }

  private onMessage(message: unknown, ports: readonly TPort[]): void {
    if (!isWireMessage(message)) {
      this.logger.warn(`[${this.name}] ignored malformed message`, message);
      return;
    }
    if (message.t === 's') {
      this.settle(message.id, message.r, message.e);
      return;
    }
    const handler = this.handlers.get(message.m);
    const id = message.id;
    if (!handler) {
      this.logger.warn(`[${this.name}] no handler for ${message.m}`);
      if (id !== undefined) {
        this.send({ t: 's', id, e: { name: 'Error', message: `No handler for ${message.m}` } });
      }
      return;
    }
    let result: unknown;
    try {
      result = handler(message.p, ports);
    } catch (error) {
      this.reply(message.m, id, undefined, error);
      return;
    }
    if (isPromiseLike(result)) {
      result.then(
        (value) => this.reply(message.m, id, value, undefined),
        (error: unknown) => this.reply(message.m, id, undefined, error ?? new Error('rejected')),
      );
    } else {
      this.reply(message.m, id, result, undefined);
    }
  }

  private reply(method: string, id: number | undefined, value: unknown, error: unknown): void {
    if (id === undefined) {
      if (error !== undefined) {
        this.logger.error(`[${this.name}] notification ${method} failed`, error);
      }
      return;
    }
    if (this.disposed) {
      return;
    }
    if (error !== undefined) {
      this.send({ t: 's', id, e: toWireError(error) });
    } else {
      this.send({ t: 's', id, r: value });
    }
  }

  private settle(id: number, value: unknown, error: WireError | undefined): void {
    const call = this.pending.get(id);
    if (!call) {
      this.logger.warn(`[${this.name}] response for unknown call #${id}`);
      return;
    }
    this.pending.delete(id);
    if (error) {
      call.reject(new RemoteError(call.method, error.name, error.message, error.stack));
    } else {
      call.resolve(value);
    }
  }
}

function isWireMessage(value: unknown): value is WireRequest | WireResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { t?: unknown; m?: unknown; id?: unknown };
  if (candidate.t === 'q') {
    return typeof candidate.m === 'string';
  }
  return candidate.t === 's' && typeof candidate.id === 'number';
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

function toWireError(error: unknown): WireError {
  if (error instanceof Error) {
    return error.stack === undefined
      ? { name: error.name, message: error.message }
      : { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'Error', message: String(error) };
}

function describe(message: WireRequest | WireResponse): string {
  return message.t === 'q' ? `request ${message.m}` : `response #${message.id}`;
}
