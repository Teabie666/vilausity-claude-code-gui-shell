/**
 * Conversations in the search: Claude Code sessions found by their title, by what was said
 * in them, or by the files Claude read or changed (main reads the transcripts). With nothing
 * typed, this folder's latest: last time's show at once while main looks again, and soon
 * after the window opens they are asked for once, which reads the transcripts in the
 * background (the first read of them all takes a second or two). The last row widens a
 * search to every folder's sessions; a session of another folder opens in that folder's window.
 */

import type { ShellModule } from '../../core/module';
import type { Highlight, QuickAccessItem, QuickAccessResult } from '../../core/quickAccess';
import { IDialogs, INative, IQuickAccess, IWorkspace } from '../../core/serviceIds';
import { getUiLanguage, htmlLang } from '../../platform/nls';
import type { SessionSearchResult } from '../../platform/protocol';
import { folderLabel } from '../workspace';
import { t } from './messages';

const RECENT_ROWS = 8;
const MATCH_ROWS = 30;
/** How long after the window opens the transcripts are read ahead of the first search (ms). */
const PREFETCH_DELAY_MS = 2000;

/** "3 days ago" in the display language. */
function timeAgo(time: number, now: number): string {
  const format = new Intl.RelativeTimeFormat(htmlLang(getUiLanguage()), { numeric: 'auto' });
  const seconds = Math.round((time - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 86400],
    ['month', 30 * 86400],
    ['week', 7 * 86400],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return format.format(Math.round(seconds / size), unit);
    }
  }
  return format.format(0, 'second');
}

function shifted(highlights: readonly Highlight[], by: number): Highlight[] {
  return highlights.map(([start, end]) => [start + by, end + by]);
}

export const sessionSearchModule: ShellModule = {
  id: 'sessionSearch',
  activate({ services, subscriptions }) {
    const native = services.get(INative);
    const dialogs = services.get(IDialogs);
    const quickAccess = services.get(IQuickAccess);
    const workspace = services.get(IWorkspace);
    const folder = workspace.folders[0];
    /** This opening of the picker searches every folder ("Search ... in All Folders" reopened it). */
    let allFolders = false;
    let widenNext = false;

    const open = async (result: SessionSearchResult): Promise<void> => {
      if (!(await native.call('sessions.open', { folder: result.folder, sessionId: result.sessionId }))) {
        await dialogs.showMessage({ severity: 'error', message: t('folderMissing', result.folder), modal: false, items: [] });
      }
    };

    const toItem = (result: SessionSearchResult, showFolder: boolean, now: number): QuickAccessItem => {
      const match = result.match;
      let detail: string | undefined;
      let detailHighlights: Highlight[] | undefined;
      if (match && match.kind !== 'title') {
        const lead =
          match.kind === 'content'
            ? match.role === 'user'
              ? t('youSaid')
              : t('claudeSaid')
            : match.edited
              ? t('changedFile')
              : t('readFile');
        detail = lead + match.text;
        detailHighlights = shifted(match.highlights, lead.length);
      }
      return {
        id: result.sessionId,
        label: result.title,
        labelHighlights: match?.kind === 'title' ? match.highlights : undefined,
        description: [showFolder ? folderLabel(result.folder, workspace.homeFolder) : undefined, timeAgo(result.updatedAt, now)]
          .filter((part) => part !== undefined)
          .join(' · '),
        detail,
        detailHighlights,
        icon: 'conversation',
        accept: () => open(result),
      };
    };

    const toGroup = (results: readonly SessionSearchResult[], where: string | undefined, query: string): QuickAccessResult => {
      if (results.length === 0) {
        return undefined;
      }
      const now = Date.now();
      const label = where === undefined ? t('allFoldersConversations') : query ? t('conversations') : t('recentConversations');
      return { label, items: results.map((result) => toItem(result, where === undefined, now)) };
    };

    const scope = (): string | undefined => (allFolders || !folder ? undefined : folder);
    /** The latest answer for nothing typed, by where it searched (every folder: ''). */
    const latest = new Map<string, readonly SessionSearchResult[]>();
    const searchRecent = async (where: string | undefined): Promise<readonly SessionSearchResult[]> => {
      const results = await native.call('sessions.search', { query: '', folder: where, limit: RECENT_ROWS });
      latest.set(where ?? '', results);
      return results;
    };
    subscriptions.add(
      quickAccess.registerSearchContributor({
        id: 'conversations',
        order: 10,
        onDidOpen: () => {
          allFolders = widenNext;
          widenNext = false;
          void native.call('counters.increment', { name: 'searches' });
        },
        initial: (query) => {
          const where = scope();
          const results = query ? undefined : latest.get(where ?? '');
          return results && toGroup(results, where, query);
        },
        provide: async (query) => {
          const where = scope();
          const results = query
            ? await native.call('sessions.search', { query, folder: where, limit: MATCH_ROWS })
            : await searchRecent(where);
          return toGroup(results, where, query);
        },
      }),
    );
    const prefetch = setTimeout(() => void searchRecent(scope()).catch(() => undefined), PREFETCH_DELAY_MS);
    subscriptions.add({ dispose: () => clearTimeout(prefetch) });
    // The last row, so that Enter on the first one still opens what matched.
    subscriptions.add(
      quickAccess.registerSearchContributor({
        id: 'searchAllFolders',
        order: 90,
        provide: (query) =>
          query && scope() !== undefined
            ? {
                items: [
                  {
                    label: t('searchAllFolders'),
                    icon: 'search',
                    accept: () => {
                      widenNext = true;
                      quickAccess.show(query);
                    },
                  },
                ],
              }
            : undefined,
      }),
    );
  },
};
