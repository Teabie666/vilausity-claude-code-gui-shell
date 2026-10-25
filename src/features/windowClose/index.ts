/**
 * Asks about unsaved files when a window closes or the app quits. Main cannot reach the
 * page directly: it emits `windowBeforeClose`, and this module answers `window.closeConfirmed`
 * once the files are saved (auto-save on) or the user picks Save All / Don't Save / Cancel.
 * A Windows shutdown or logoff (`reason: 'sessionEnd'`) saves without asking and never blocks.
 */

import { URI } from 'vscode-uri';
import type { ShellModule } from '../../core/module';
import { IDialogs, INative, ISettings } from '../../core/serviceIds';
import type { CloseReason } from '../../platform/protocol';
import { ITextEditors } from '../editor';
import { autoSaveMode, savable } from '../editor/autoSave';
import type { ModelEntry } from '../editor/textModels';
import { t } from './messages';

/** A file's label for the dialog's list: its path (drive letter as Windows writes it), or the URI of a user-edited proposal. */
function fileLabel(uri: string): string {
  if (!uri.startsWith('file:')) {
    return decodeURIComponent(uri);
  }
  return URI.parse(uri).fsPath.replace(/^[a-z](?=:)/, (drive) => drive.toUpperCase());
}

export const windowCloseModule: ShellModule = {
  id: 'windowClose',
  dependsOn: ['editor'],
  activate({ services, subscriptions, logger }) {
    const native = services.get(INative);
    const dialogs = services.get(IDialogs);
    const settings = services.get(ISettings);
    const editors = services.get(ITextEditors);

    /** Whether the window may close: files saved (or the user agreed); false keeps it open. */
    const confirmClose = async (reason: CloseReason): Promise<boolean> => {
      const models = editors.modelService;
      if (!models || models.dirty.length === 0) {
        return true;
      }

      const saveAll = async (entries: readonly ModelEntry[]): Promise<boolean> => {
        let failed = false;
        for (const entry of entries) {
          if (!(await models.save(entry.uri).catch(() => false))) {
            failed = true;
          }
        }
        return !failed;
      };

      // Windows shutdown/logoff: save what can be saved, never block, never ask. A proposal
      // (a diff's right side) is deliberately not auto-accepted here: the process is ending.
      if (reason === 'sessionEnd') {
        await saveAll(models.dirty.filter(savable));
        return true;
      }

      // Auto-save on: file-based documents save themselves first. A proposal or an untitled
      // document cannot, so anything still dirty is asked about below.
      if (autoSaveMode(settings.get('files.autoSave', 'off')) !== 'off') {
        await saveAll(models.dirty.filter(savable));
        if (models.dirty.length === 0) {
          return true;
        }
      }

      const dirty = models.dirty;
      const choice = await dialogs.showMessage({
        severity: 'warning',
        modal: true,
        message:
          dirty.length === 1
            ? t('saveChangesQuestionOne', URI.parse(dirty[0].uri).path.replace(/^.*\//, ''))
            : t('saveChangesQuestion', dirty.length),
        detail: dirty.map((entry) => fileLabel(entry.uri)).join('\n'),
        items: [t('saveAll'), t('dontSave')],
      });
      if (choice === 1) {
        return true; // Don't Save
      }
      if (choice !== 0) {
        return false; // Cancel (or Esc / backdrop)
      }
      if (await saveAll(dirty)) {
        return true;
      }
      // Saving failed (e.g. read-only): keep the window open and say so.
      await dialogs.showMessage({ severity: 'error', modal: true, message: t('saveFailed'), detail: t('saveFailedDetail'), items: [] });
      return false;
    };

    subscriptions.add(
      native.on('windowBeforeClose', ({ id, reason }) => {
        void native.call('window.closeAcknowledged', { id });
        // A failure while saving or asking must not keep the window open for good.
        void confirmClose(reason)
          .catch((error: unknown) => {
            logger.error('asking about unsaved files failed', error);
            return true;
          })
          .then((proceed) => void native.call('window.closeConfirmed', { id, proceed }));
      }),
    );
  },
};
