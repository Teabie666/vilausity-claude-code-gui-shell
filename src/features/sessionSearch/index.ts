/**
 * Conversations in the search: Claude Code sessions found by their title, by what was said
 * in them, or by the files Claude read or changed (main reads the transcripts). With nothing
 * typed, this folder's latest. The last row widens a search to every folder's sessions; a
 * session of another folder opens in that folder's window.
 */

import type { ShellModule } from '../../core/module';
import type { Highlight, QuickAccessItem } from '../../core/quickAccess';
import { IDialogs, INative, IQuickAccess, IWorkspace } from '../../core/serviceIds';
import { getUiLanguage, htmlLang } from '../../platform/nls';
import type { SessionSearchResult } from '../../platform/protocol';
import { folderName } from '../workspace';
import { t } from './messages';

const RECENT_ROWS = 8;
const MATCH_ROWS = 30;

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
    const folder = services.get(IWorkspace).folders[0];
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
        label: result.title,
        labelHighlights: match?.kind === 'title' ? match.highlights : undefined,
        description: [showFolder ? folderName(result.folder) : undefined, timeAgo(result.updatedAt, now)]
          .filter((part) => part !== undefined)
          .join(' · '),
        detail,
        detailHighlights,
        icon: 'conversation',
        accept: () => open(result),
      };
    };

    const scope = (): string | undefined => (allFolders || !folder ? undefined : folder);
    subscriptions.add(
      quickAccess.registerSearchContributor({
        id: 'conversations',
        order: 10,
        onDidOpen: () => {
          allFolders = widenNext;
          widenNext = false;
        },
        provide: async (query) => {
          const where = scope();
          const results = await native.call('sessions.search', { query, folder: where, limit: query ? MATCH_ROWS : RECENT_ROWS });
          if (results.length === 0) {
            return undefined;
          }
          const now = Date.now();
          const label = where === undefined ? t('allFoldersConversations') : query ? t('conversations') : t('recentConversations');
          return { label, items: results.map((result) => toItem(result, where === undefined, now)) };
        },
      }),
    );
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
