/**
 * The local API: what programs on this computer can ask of Vilausity over HTTP on 127.0.0.1
 * (host/main/localApiServer.ts). Operations are called by name; each declares what it may do
 * (`ApiAccess`), and main refuses what the switches (or the administrator instance) do not allow.
 * Shared by main, which serves the operations, and the renderer, whose modules add their own.
 */

/** Serve the API at all (off by default). */
export const API_ENABLED_SETTING = 'vilaus.api.enabled';
/** Let callers send messages to Claude, not only put them in the input (off by default). */
export const API_ALLOW_SEND_SETTING = 'vilaus.api.allowSend';
/** The port; 0 lets the system pick a free one (api.json says which). */
export const API_PORT_SETTING = 'vilaus.api.port';

/** The path every operation is under: `/v1/<name>`. */
export const API_PREFIX = '/v1';
/** The event stream (server-sent events). */
export const API_EVENTS_PATH = `${API_PREFIX}/events`;
/** Where the address and the key are, in the instance's folder. */
export const API_DISCOVERY_FILE = 'api.json';
/** What the API is and how to use it. */
export const API_DOCS_URL = 'https://github.com/Teabie666/vilausity-claude-code-gui-shell/blob/main/docs/local-api.md';

/**
 * What an operation may do. `read`: only looks. `write`: opens and changes things in the shell
 * (folders, files, a conversation with a prompt filled in, commands). `send`: has Claude act,
 * with no one at the computer to press Enter (needs `vilaus.api.allowSend` as well).
 */
export type ApiAccess = 'read' | 'write' | 'send';

export const API_ACCESS: readonly ApiAccess[] = ['read', 'write', 'send'];

/** An operation as `GET /v1` lists it. */
export interface ApiOperationInfo {
  /** `namespace.verb`, e.g. `windows.list`. */
  readonly name: string;
  readonly access: ApiAccess;
  /** One English sentence for the listing. */
  readonly description: string;
  /** The parameters it takes, by name: what each is (`string, optional`...). For the listing only. */
  readonly params?: Readonly<Record<string, string>>;
}

/** An operation's parameters: the JSON body of a POST, or the query string of a GET. */
export type ApiParams = Readonly<Record<string, unknown>>;

/** `api.json`: how to reach this instance's API. */
export interface ApiDiscovery {
  /** `http://127.0.0.1:<port>/v1` */
  readonly url: string;
  readonly port: number;
  /** Goes in every request: `Authorization: Bearer <token>`. */
  readonly token: string;
  readonly pid: number;
  readonly version: string;
  /** The administrator instance: read-only. */
  readonly elevated: boolean;
}

/** What the settings editor shows about the API. */
export interface ApiStatusDto {
  /** The address while it serves (`http://127.0.0.1:<port>/v1`). */
  readonly url?: string;
  /** Where api.json is (with the key). */
  readonly file: string;
  /** Why it is not serving although it is on (the port is taken, say). */
  readonly error?: string;
  /** The administrator instance: read-only. */
  readonly elevated: boolean;
}

/** A failure to report to the caller: an HTTP status and a short code for programs. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, 'bad_request', message);
}

/** A query string carries text only: `"true"`, `"12"` are taken for a boolean, a number. */
export function stringParam(params: ApiParams, name: string): string | undefined {
  const value = params[name];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw badRequest(`${name} must be a string`);
  }
  return value;
}

export function requiredString(params: ApiParams, name: string): string {
  const value = stringParam(params, name);
  if (value === undefined) {
    throw badRequest(`${name} is required`);
  }
  return value;
}

export function numberParam(params: ApiParams, name: string): number | undefined {
  const value = params[name];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw badRequest(`${name} must be a number`);
  }
  return number;
}

export function booleanParam(params: ApiParams, name: string): boolean | undefined {
  const value = params[name];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  throw badRequest(`${name} must be true or false`);
}

/** A positive whole number (a window's id, a line). */
export function positiveIntegerParam(params: ApiParams, name: string): number | undefined {
  const value = numberParam(params, name);
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw badRequest(`${name} must be a whole number from 1`);
  }
  return value;
}
