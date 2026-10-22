/**
 * The local API in main: it serves while `vilaus.api.enabled` is on (localApiServer.ts), keeps
 * api.json (the address and the key) in the instance's folder, and knows the operations: main's
 * own (localApiOperations.ts) and those the windows' pages offer (core/localApi.ts), which it
 * hands to the window a call names.
 *
 * The administrator instance only reads: any program of the same Windows user can read its
 * api.json, elevated or not, and must not get to do things through an elevated Vilausity.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { Emitter, type Event } from '../../platform/event';
import { Disposable } from '../../platform/lifecycle';
import {
  API_ALLOW_SEND_SETTING,
  API_ENABLED_SETTING,
  API_PORT_SETTING,
  API_PREFIX,
  ApiError,
  positiveIntegerParam,
  type ApiAccess,
  type ApiDiscovery,
  type ApiOperationInfo,
  type ApiParams,
  type ApiStatusDto,
} from '../../platform/localApi';
import type { ILogger } from '../../platform/log';
import { writeFileAtomic } from '../node/jsonFile';
import { LocalApiServer, type ApiEvent, type ApiOperation } from './localApiServer';

/** A window, for the operations its page offers. */
export interface ApiWindowTarget {
  readonly id: number;
  /** Runs one of the page's operations. */
  call(name: string, params: ApiParams): Promise<unknown>;
}

export interface LocalApiOptions {
  readonly discoveryFile: string;
  readonly elevated: boolean;
  readonly version: string;
  readonly settings: () => Readonly<Record<string, unknown>>;
  /** The window `id` names, the active one when there is no id; undefined when there is none. */
  readonly window: (id: number | undefined) => ApiWindowTarget | undefined;
  /** What a stream is sent as it connects. */
  readonly greeting: () => readonly ApiEvent[];
  /** What `GET /v1` says about the app, besides the operations. */
  readonly info: () => Record<string, unknown>;
  readonly logger: ILogger;
}

export class LocalApi extends Disposable {
  /** Main's own operations. */
  private readonly own = new Map<string, ApiOperation>();
  /** What each window's page offers, by window id. */
  private readonly pages = new Map<number, readonly ApiOperationInfo[]>();
  private server: LocalApiServer | undefined;
  /** The port setting the server was started for (it may listen elsewhere when that was taken). */
  private requestedPort = 0;
  private failure: string | undefined;
  /** Starts and stops one after another. */
  private applying: Promise<void> = Promise.resolve();
  private readonly statusEmitter = this.register(new Emitter<ApiStatusDto>());
  readonly onDidChangeStatus: Event<ApiStatusDto> = this.statusEmitter.event;

  constructor(private readonly options: LocalApiOptions) {
    super();
  }

  get status(): ApiStatusDto {
    const port = this.server?.port;
    return {
      url: port ? apiUrl(port) : undefined,
      file: this.options.discoveryFile,
      error: this.failure,
      elevated: this.options.elevated,
    };
  }

  /** Adds main's own operations. */
  registerOperations(operations: readonly ApiOperation[]): void {
    for (const operation of operations) {
      if (this.own.has(operation.name)) {
        throw new Error(`local API operation ${operation.name} registered twice`);
      }
      this.own.set(operation.name, operation);
    }
  }

  /** What a window's page offers now (all of it). */
  setPageOperations(windowId: number, operations: readonly ApiOperationInfo[]): void {
    this.pages.set(windowId, operations);
  }

  windowClosed(windowId: number): void {
    this.pages.delete(windowId);
  }

  emit(name: string, data: unknown): void {
    this.server?.emit({ name, data });
  }

  /** Starts, stops or moves the server as the settings say: at the start and when they change. */
  apply(): Promise<void> {
    this.applying = this.applying.then(() => this.applyNow()).catch((error: unknown) => this.options.logger.error('local API', error));
    return this.applying;
  }

  override dispose(): void {
    void this.server?.close();
    this.server = undefined;
    super.dispose();
  }

  /** Why an operation of this kind may not run now; undefined when it may. */
  refusal(access: ApiAccess): string | undefined {
    if (access === 'read') {
      return undefined;
    }
    if (this.options.elevated) {
      return 'the administrator instance only reads';
    }
    if (access === 'send' && this.options.settings()[API_ALLOW_SEND_SETTING] !== true) {
      return `sending is off: turn on ${API_ALLOW_SEND_SETTING} in the settings`;
    }
    return undefined;
  }

  /** The operation called `name`: main's own, else one a window's page offers. */
  operation(name: string): ApiOperation | undefined {
    const own = this.own.get(name);
    if (own) {
      return own;
    }
    const info = [...this.pages.values()].flat().find((candidate) => candidate.name === name);
    if (!info) {
      return undefined;
    }
    return {
      ...info,
      handle: (params) => {
        const id = positiveIntegerParam(params, 'window');
        const target = this.options.window(id);
        if (!target) {
          throw new ApiError(404, 'no_window', id === undefined ? 'no window is open' : `no window ${id}`);
        }
        if (!this.pages.get(target.id)?.some((candidate) => candidate.name === name)) {
          throw new ApiError(404, 'unknown_operation', `window ${target.id} does not offer ${name}`);
        }
        return target.call(name, params);
      },
    };
  }

  /** Every operation, main's first, each with whether it may run now. */
  listing(): Record<string, unknown> {
    const infos = new Map<string, ApiOperationInfo>();
    for (const info of [...this.own.values(), ...[...this.pages.values()].flat()]) {
      if (!infos.has(info.name)) {
        infos.set(info.name, info);
      }
    }
    const operations = [...infos.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, access, description, params }) => ({
        name,
        access,
        description,
        params,
        available: this.refusal(access) === undefined,
      }));
    return { ...this.options.info(), operations };
  }

  private async applyNow(): Promise<void> {
    const settings = this.options.settings();
    const enabled = settings[API_ENABLED_SETTING] === true;
    const port = portSetting(settings[API_PORT_SETTING]);
    if (enabled && this.server && port === this.requestedPort) {
      return;
    }
    const wasServing = this.server !== undefined || this.failure !== undefined;
    await this.stop();
    if (enabled) {
      await this.start(port);
    }
    if (enabled || wasServing) {
      this.statusEmitter.fire(this.status);
    }
  }

  private async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.failure = undefined;
    if (server) {
      await server.close();
      this.options.logger.info('local API stopped');
    }
  }

  private async start(port: number): Promise<void> {
    const token = this.savedToken() ?? crypto.randomBytes(32).toString('hex');
    const server = new LocalApiServer({
      token,
      operation: (name) => this.operation(name),
      listing: () => this.listing(),
      refusal: (access) => this.refusal(access),
      greeting: () => this.options.greeting(),
      logger: this.options.logger,
    });
    let listening: number;
    try {
      listening = await server.listen(port).catch((error: unknown) => {
        if (port === 0 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
          throw error;
        }
        // Its own port is taken: another free one rather than none (api.json says which).
        this.options.logger.warn(`local API: port ${port} is taken, listening on another`);
        return server.listen(0);
      });
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.options.logger.error('the local API cannot listen', error);
      return;
    }
    this.server = server;
    this.requestedPort = port;
    const discovery: ApiDiscovery = {
      url: apiUrl(listening),
      port: listening,
      token,
      pid: process.pid,
      version: this.options.version,
      elevated: this.options.elevated,
    };
    await writeFileAtomic(this.options.discoveryFile, `${JSON.stringify(discovery, null, 2)}\n`);
    this.options.logger.info(
      `local API at ${discovery.url}${this.options.elevated ? ' (read-only)' : ''}; key in ${this.options.discoveryFile}`,
    );
  }

  /** The key from api.json: it stays the same for as long as the file is there. */
  private savedToken(): string | undefined {
    try {
      const saved = JSON.parse(fs.readFileSync(this.options.discoveryFile, 'utf8')) as Partial<ApiDiscovery>;
      return typeof saved.token === 'string' && /^[0-9a-f]{64}$/.test(saved.token) ? saved.token : undefined;
    } catch {
      return undefined;
    }
  }
}

export function apiUrl(port: number): string {
  return `http://127.0.0.1:${port}${API_PREFIX}`;
}

/** `vilaus.api.port`: a port number, 0 (any free one) for anything else. */
export function portSetting(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535 ? value : 0;
}
