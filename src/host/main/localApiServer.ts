/**
 * The local API's HTTP server: 127.0.0.1 only, one key (a bearer token), operations by name
 * (`GET /v1/<name>` for those that only read, `POST /v1/<name>` with a JSON body for any) and an
 * event stream (`GET /v1/events`, server-sent events). What the operations are and whether one
 * may run now is up to the caller (localApi.ts); this file knows HTTP only.
 *
 * Web pages are kept out twice over: a request with an `Origin` header (every cross-origin
 * request a browser makes has one) is refused, and so is one whose `Host` is not this address
 * (a DNS rebinding page would name its own host).
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  API_EVENTS_PATH,
  API_PREFIX,
  ApiError,
  badRequest,
  type ApiAccess,
  type ApiOperationInfo,
  type ApiParams,
} from '../../platform/localApi';
import type { ILogger } from '../../platform/log';

export interface ApiOperation extends ApiOperationInfo {
  handle(params: ApiParams): unknown;
}

export interface ApiEvent {
  readonly name: string;
  readonly data: unknown;
}

export interface LocalApiServerOptions {
  readonly token: string;
  /** The operation called `name`; undefined when there is none. */
  readonly operation: (name: string) => ApiOperation | undefined;
  /** What `GET /v1` answers. */
  readonly listing: () => unknown;
  /** Why an operation of this kind may not run now; undefined when it may. */
  readonly refusal: (access: ApiAccess) => string | undefined;
  /** What a stream is sent as it connects (the state as it is now). */
  readonly greeting: () => readonly ApiEvent[];
  readonly logger: ILogger;
}

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
/** A comment line now and then keeps idle streams from being dropped along the way. */
const KEEP_ALIVE_MS = 25_000;

export class LocalApiServer {
  private server: http.Server | undefined;
  private listeningPort = 0;
  private readonly streams = new Set<http.ServerResponse>();
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private readonly token: Buffer;

  constructor(private readonly options: LocalApiServerOptions) {
    this.token = Buffer.from(options.token, 'utf8');
  }

  /** The port it listens on; 0 before `listen`. */
  get port(): number {
    return this.listeningPort;
  }

  /** Listens on 127.0.0.1 at `port` (0: a free one); resolves to the port. */
  listen(port: number): Promise<number> {
    const server = http.createServer((request, response) => void this.serve(request, response));
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, HOST, () => {
        server.off('error', reject);
        server.on('error', (error) => this.options.logger.error('local API server error', error));
        this.server = server;
        this.listeningPort = (server.address() as AddressInfo).port;
        this.keepAlive = setInterval(() => this.writeAll(': ping\n\n'), KEEP_ALIVE_MS);
        this.keepAlive.unref();
        resolve(this.listeningPort);
      });
    });
  }

  async close(): Promise<void> {
    clearInterval(this.keepAlive);
    for (const stream of this.streams) {
      stream.end();
    }
    this.streams.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }

  /** Sends an event to every open stream. */
  emit(event: ApiEvent): void {
    if (this.streams.size > 0) {
      this.writeAll(eventText(event));
    }
  }

  private writeAll(text: string): void {
    for (const stream of this.streams) {
      stream.write(text);
    }
  }

  private async serve(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      this.admit(request);
      const url = new URL(request.url ?? '/', `http://${HOST}`);
      const route = url.pathname.replace(/\/+$/, '');
      if (route === API_PREFIX) {
        this.allowMethods(request, ['GET']);
        send(response, 200, this.options.listing());
        return;
      }
      if (route === API_EVENTS_PATH) {
        this.allowMethods(request, ['GET']);
        this.openStream(request, response);
        return;
      }
      if (!route.startsWith(`${API_PREFIX}/`)) {
        throw new ApiError(404, 'not_found', `nothing at ${url.pathname}; the API is under ${API_PREFIX}`);
      }
      const name = decodedName(route.slice(API_PREFIX.length + 1));
      const operation = this.options.operation(name);
      if (!operation) {
        throw new ApiError(404, 'unknown_operation', `no operation ${name}; GET ${API_PREFIX} lists them`);
      }
      this.allowMethods(request, operation.access === 'read' ? ['GET', 'POST'] : ['POST']);
      const params = request.method === 'GET' ? Object.fromEntries(url.searchParams) : await readJsonBody(request);
      const refusal = this.options.refusal(operation.access);
      if (refusal !== undefined) {
        throw new ApiError(403, 'forbidden', refusal);
      }
      const result = await operation.handle(params);
      send(response, 200, result ?? null);
    } catch (error) {
      if (error instanceof ApiError) {
        send(response, error.status, { error: error.code, message: error.message });
        return;
      }
      this.options.logger.error(`local API: ${request.method ?? ''} ${request.url ?? ''} failed`, error);
      send(response, 500, { error: 'internal', message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Only programs on this computer that have the key, never a web page. */
  private admit(request: http.IncomingMessage): void {
    if (request.headers.origin !== undefined) {
      throw new ApiError(403, 'forbidden', 'requests from web pages are refused');
    }
    const host = (request.headers.host ?? '').toLowerCase();
    if (host !== `${HOST}:${this.listeningPort}` && host !== `localhost:${this.listeningPort}`) {
      throw new ApiError(403, 'forbidden', 'the Host header must be this address');
    }
    const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? '');
    const given = Buffer.from(match?.[1] ?? '', 'utf8');
    if (given.length !== this.token.length || !crypto.timingSafeEqual(given, this.token)) {
      throw new ApiError(401, 'unauthorized', 'send the token from api.json: Authorization: Bearer <token>');
    }
  }

  private allowMethods(request: http.IncomingMessage, methods: readonly string[]): void {
    if (!methods.includes(request.method ?? '')) {
      throw new ApiError(405, 'method_not_allowed', `use ${methods.join(' or ')}`);
    }
  }

  private openStream(request: http.IncomingMessage, response: http.ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    response.write(': connected\n\n');
    for (const event of this.options.greeting()) {
      response.write(eventText(event));
    }
    this.streams.add(response);
    request.on('close', () => this.streams.delete(response));
  }
}

function decodedName(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw badRequest('the operation name is not valid percent-encoding');
  }
}

function eventText(event: ApiEvent): string {
  // JSON escapes line breaks, so the data is one line.
  return `event: ${event.name}\ndata: ${JSON.stringify(event.data ?? null)}\n\n`;
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  response.end(text);
}

/** A POST's parameters: a JSON object, or nothing at all. */
async function readJsonBody(request: http.IncomingMessage): Promise<ApiParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(413, 'too_large', `the body may be at most ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw badRequest('the body is not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('the body must be a JSON object of parameters');
  }
  return value as ApiParams;
}
