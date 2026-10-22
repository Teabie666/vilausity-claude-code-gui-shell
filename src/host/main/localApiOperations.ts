/**
 * Main's operations of the local API, and the events it sends (localApi.ts serves them). Each
 * checks its parameters and leaves the work to the host (ShellApp), which owns the windows.
 */

import * as path from 'node:path';
import { ApiError, badRequest, positiveIntegerParam, requiredString, stringParam, type ApiParams } from '../../platform/localApi';
import type {
  ConversationRequest,
  ConversationState,
  ConversationStateDto,
  SessionSearchRequest,
  SessionSearchResult,
} from '../../platform/protocol';
import type { Currency, ProviderPricing, ProviderType } from '../../platform/providers';
import { modelCost, totalCost, type ModelTokens } from '../../platform/usage';
import type { ApiEvent, ApiOperation } from './localApiServer';

/** A window as `windows.list` and the `windows` event show it. */
export interface ApiWindow {
  /** 1, 2... in the order windows opened since Vilausity started. */
  readonly id: number;
  readonly folder: string;
  /** The window used last: calls that name no window go to it. */
  readonly active: boolean;
  readonly provider: { readonly id: string; readonly name: string; readonly type: ProviderType };
  /** The conversation in front. */
  readonly activeSessionId?: string;
  readonly conversations: readonly ConversationStateDto[];
}

/** What a provider's calls cost in one scope (`usage.get`). */
export interface ApiUsageScope {
  /** In the provider's currency; models without a price count nothing. */
  readonly cost: number;
  readonly calls: number;
  readonly unpricedModels: readonly string[];
  readonly models: Readonly<
    Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; calls: number; cost: number | null }>
  >;
}

export interface ApiUsage {
  readonly provider: { readonly id: string; readonly name: string };
  readonly currency: Currency;
  /** The conversation in front; null when there is none. */
  readonly conversation: ApiUsageScope | null;
  readonly workspace: ApiUsageScope;
  /** Every Claude Code session on this computer. */
  readonly all: ApiUsageScope;
}

/** Where a conversation opens: a window, or a folder's window (opened when there is none). */
export interface ConversationTarget {
  readonly window?: number;
  readonly folder?: string;
}

export interface OperationsHost {
  windows(): ApiWindow[];
  /** False when there is no such window. */
  focusWindow(id: number): boolean;
  /** The id of the folder's window (brought forward, or opened); undefined when it is no folder. */
  openFolder(folder: string): Promise<number | undefined>;
  /** The id of the window that shows the file; undefined when it is no file or no window is open. */
  openFile(file: string, line: number | undefined, column: number | undefined): number | undefined;
  /** The id of the window the conversation opens in; undefined when there is no such window or folder. */
  openConversation(target: ConversationTarget, request: ConversationRequest): Promise<number | undefined>;
  searchSessions(request: SessionSearchRequest): Promise<SessionSearchResult[]>;
  /** What a window's provider cost (null: the shell does not work that out for it); undefined: no such window. */
  usage(window: number | undefined): Promise<ApiUsage | null | undefined>;
}

const SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const MAX_PROMPT_LENGTH = 100_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WINDOW_PARAM = 'number, optional: a window id from windows.list; the active window by default';

export function builtInOperations(host: OperationsHost): ApiOperation[] {
  return [
    {
      name: 'windows.list',
      access: 'read',
      description: 'The open windows: folder, API provider, and each conversation with what it is doing.',
      handle: () => host.windows(),
    },
    {
      name: 'windows.focus',
      access: 'write',
      description: 'Brings a window to the front.',
      params: { window: 'number' },
      handle: (params) => {
        const id = positiveIntegerParam(params, 'window');
        if (id === undefined) {
          throw badRequest('window is required');
        }
        if (!host.focusWindow(id)) {
          throw noWindow(id);
        }
        return { window: id };
      },
    },
    {
      name: 'folders.open',
      access: 'write',
      description: 'Opens a folder in a window of its own, or brings forward the window that shows it.',
      params: { folder: 'string: an absolute path' },
      handle: async (params) => {
        const folder = absolutePath(params, 'folder');
        const window = await host.openFolder(folder);
        if (window === undefined) {
          throw new ApiError(404, 'not_found', `${folder} is not a folder`);
        }
        return { window };
      },
    },
    {
      name: 'files.open',
      access: 'write',
      description: "Opens a file in the editor of the window whose folder holds it (else the active window's).",
      params: { path: 'string: an absolute path', line: 'number, optional', column: 'number, optional' },
      handle: (params) => {
        const file = absolutePath(params, 'path');
        const window = host.openFile(file, positiveIntegerParam(params, 'line'), positiveIntegerParam(params, 'column'));
        if (window === undefined) {
          throw new ApiError(404, 'not_found', `${file} is not a file, or no window is open`);
        }
        return { window };
      },
    },
    {
      name: 'conversations.open',
      access: 'write',
      description: 'Opens a conversation: a session to go on with, or a new one; with a prompt, it is put in the input (not sent).',
      params: {
        sessionId: 'string, optional: a session to open (from windows.list or sessions.search)',
        prompt: 'string, optional: text for the input',
        folder: "string, optional: the folder whose window it opens in (opened if need be); a session's own folder",
        window: WINDOW_PARAM,
      },
      handle: async (params) => {
        const target = conversationTarget(params);
        const request = conversationRequest(params);
        const window = await host.openConversation(target, request);
        if (window === undefined) {
          throw target.folder !== undefined ? new ApiError(404, 'not_found', `${target.folder} is not a folder`) : noWindow(target.window);
        }
        return { window };
      },
    },
    {
      name: 'sessions.search',
      access: 'read',
      description: "Claude Code's sessions whose title, conversation or files match; the latest without a query.",
      params: {
        query: 'string, optional',
        folder: 'string, optional: only sessions that ran in this folder',
        limit: `number, optional: at most this many (${SEARCH_LIMIT} by default, up to ${MAX_SEARCH_LIMIT})`,
      },
      handle: (params) => {
        const folder = stringParam(params, 'folder');
        if (folder !== undefined && !path.isAbsolute(folder)) {
          throw badRequest('folder must be an absolute path');
        }
        const limit = Math.min(positiveIntegerParam(params, 'limit') ?? SEARCH_LIMIT, MAX_SEARCH_LIMIT);
        return host.searchSessions({ query: stringParam(params, 'query') ?? '', folder, limit });
      },
    },
    {
      name: 'usage.get',
      access: 'read',
      description:
        "What a window's API provider cost, as the session list shows it: the conversation in front, the workspace, all sessions. Null for providers whose costs the extension shows itself (the subscription, Claude's APIs).",
      params: { window: WINDOW_PARAM },
      handle: async (params) => {
        const id = positiveIntegerParam(params, 'window');
        const usage = await host.usage(id);
        if (usage === undefined) {
          throw noWindow(id);
        }
        return usage;
      },
    },
  ];
}

/** One scope of `usage.get`: the models' tokens priced with the provider's prices. */
export function usageScope(models: ModelTokens, pricing: ProviderPricing | undefined): ApiUsageScope {
  const { cost, unpriced } = totalCost(models, pricing);
  return {
    cost,
    calls: Object.values(models).reduce((sum, tokens) => sum + tokens.calls, 0),
    unpricedModels: unpriced,
    models: Object.fromEntries(
      Object.entries(models).map(([model, tokens]) => [
        model,
        {
          input: tokens.input,
          output: tokens.output,
          cacheRead: tokens.cacheRead,
          cacheWrite: tokens.cacheWrite,
          calls: tokens.calls,
          cost: modelCost(model, tokens, pricing) ?? null,
        },
      ]),
    ),
  };
}

/** A conversation's change as the event stream tells it; `closed`: it is gone (its tab, or its window). */
export interface ConversationEvent {
  readonly window: number;
  readonly folder: string;
  readonly sessionId: string;
  readonly title: string;
  readonly state: ConversationState | 'closed';
  /** What it did before; none for a conversation that just came. */
  readonly previous?: ConversationState;
}

/** The `conversation.state` events between a window's conversations before and after. */
export function conversationEvents(
  window: { readonly id: number; readonly folder: string },
  before: readonly ConversationStateDto[],
  after: readonly ConversationStateDto[],
): ApiEvent[] {
  const events: ConversationEvent[] = [];
  const earlier = new Map(before.map((conversation) => [conversation.sessionId, conversation]));
  for (const conversation of after) {
    const previous = earlier.get(conversation.sessionId);
    earlier.delete(conversation.sessionId);
    if (previous?.state !== conversation.state) {
      events.push({ window: window.id, folder: window.folder, ...conversation, previous: previous?.state });
    }
  }
  for (const gone of earlier.values()) {
    events.push({ window: window.id, folder: window.folder, ...gone, state: 'closed', previous: gone.state });
  }
  return events.map((data) => ({ name: 'conversation.state', data }));
}

function noWindow(id: number | undefined): ApiError {
  return new ApiError(404, 'no_window', id === undefined ? 'no window is open' : `no window ${id}`);
}

function absolutePath(params: ApiParams, name: string): string {
  const value = requiredString(params, name);
  if (!path.isAbsolute(value)) {
    throw badRequest(`${name} must be an absolute path`);
  }
  return path.normalize(value);
}

function conversationTarget(params: ApiParams): ConversationTarget {
  const folder = stringParam(params, 'folder');
  if (folder !== undefined && !path.isAbsolute(folder)) {
    throw badRequest('folder must be an absolute path');
  }
  const window = positiveIntegerParam(params, 'window');
  if (folder !== undefined && window !== undefined) {
    throw badRequest('give folder or window, not both');
  }
  return { folder: folder === undefined ? undefined : path.normalize(folder), window };
}

function conversationRequest(params: ApiParams): ConversationRequest {
  const sessionId = stringParam(params, 'sessionId');
  if (sessionId !== undefined && !SESSION_ID.test(sessionId)) {
    throw badRequest('sessionId must be a session id (a UUID)');
  }
  const prompt = stringParam(params, 'prompt');
  if (prompt !== undefined && prompt.length > MAX_PROMPT_LENGTH) {
    throw badRequest(`prompt may be at most ${MAX_PROMPT_LENGTH} characters`);
  }
  return { sessionId, prompt };
}
