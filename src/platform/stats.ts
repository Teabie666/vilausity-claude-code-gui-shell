/**
 * The statistics page (features/stats): how Claude Code was used, from its transcripts
 * (host/main/sessionStats.ts, in the sessions worker), what it cost by provider, the room it
 * all takes on disk, and Vilausity's own counts (host/main/shellCounters.ts).
 */

import type { TokenCounts } from './usage';

/** A name and how many times, e.g. a tool and its calls. */
export interface CountedName {
  readonly name: string;
  readonly count: number;
}

/** User messages by local weekday (row 0 = Monday … 6 = Sunday) and hour (24 columns). */
export type ActivityGrid = readonly (readonly number[])[];

/** What the transcripts tell, summed over the sessions in scope. */
export interface TranscriptStats {
  /** Conversations with at least one message the user typed. */
  readonly sessions: number;
  /** The folders they ran in (distinct `cwd`). */
  readonly folders: number;
  /** Messages the user typed: not tool results, not the context the IDE and the CLI add. */
  readonly userMessages: number;
  /** Characters in them (code points), the added context left out. */
  readonly typedChars: number;
  /** Claude's replies with text (by message id; subagents' left out). */
  readonly replies: number;
  readonly replyChars: number;
  /** Thinking blocks, subagents' included. */
  readonly thinking: number;
  /** Tool calls, subagents' included; `tools` by count, most first. */
  readonly toolCalls: number;
  readonly tools: readonly CountedName[];
  /** Subagents started (Task / Agent tool calls). */
  readonly subagents: number;
  /** Lines Claude's edits added and removed, and the distinct files it changed. */
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly filesEdited: number;
  /** API calls by model (by message id, subagents' included, made-up replies left out), most first. */
  readonly models: readonly CountedName[];
  /** The tokens of those calls. */
  readonly tokens: TokenCounts;
  /** The conversation with the most messages the user typed. */
  readonly longest:
    { readonly sessionId: string; readonly title?: string; readonly folder?: string; readonly userMessages: number } | undefined;
  /** The local day with the most messages the user typed (`YYYY-MM-DD`). */
  readonly busiestDay: { readonly date: string; readonly userMessages: number } | undefined;
  readonly activity: ActivityGrid;
  /** Local days with a message the user typed; the longest run of them in a row, and the one up to today. */
  readonly activeDays: number;
  readonly longestStreak: number;
  /** Ends today or yesterday, 0 otherwise. */
  readonly currentStreak: number;
  /**
   * The message typed latest in the night (epoch ms): a day is taken to start at 05:00 local,
   * so 03:47 is later than 23:10.
   */
  readonly latest: number | undefined;
  /** The first and last message typed (epoch ms). */
  readonly first: number | undefined;
  readonly last: number | undefined;
}

/** The hour a "day" starts at for `TranscriptStats.latest`. */
export const NIGHT_ENDS_HOUR = 5;

/** What one provider's calls came to. */
export interface ProviderCost {
  readonly provider: string;
  readonly name: string;
  readonly tokens: TokenCounts;
  readonly calls: number;
  /** In `currency`; undefined when nothing prices the calls. */
  readonly cost?: number;
  readonly currency?: 'CNY' | 'USD';
  /**
   * The cost is Claude Code's own figure at Anthropic's API prices (a subscription, the
   * Anthropic API...), not what was charged.
   */
  readonly estimated?: boolean;
}

export type StorageItemId =
  'transcripts' | 'fileHistory' | 'extensions' | 'fullTranscripts' | 'logs' | 'cache' | 'shellData' | 'attachments';

/** Room a kind of file takes on disk. */
export interface StorageItem {
  readonly id: StorageItemId;
  readonly path: string;
  readonly bytes: number;
  readonly files: number;
}

/** Counts Vilausity keeps itself (`<data dir>\state\counters.json`), from `since` on. */
export interface ShellCounters {
  /** When counting began (epoch ms). */
  readonly since: number;
  readonly launches: number;
  /** Folders opened in a window, and how many distinct ones. */
  readonly foldersOpened: number;
  readonly distinctFolders: number;
  readonly filesOpened: number;
  readonly comments: number;
  readonly filesDropped: number;
  readonly searches: number;
  readonly fullTranscripts: number;
  readonly localApiCalls: number;
}

export type ShellCounterName = Exclude<keyof ShellCounters, 'since' | 'distinctFolders'>;

export interface StatsDto {
  /** Whether it is about the calling window's folder only. */
  readonly folder?: string;
  readonly transcripts: TranscriptStats;
  readonly costs: readonly ProviderCost[];
  readonly storage: readonly StorageItem[];
  readonly counters: ShellCounters;
}
