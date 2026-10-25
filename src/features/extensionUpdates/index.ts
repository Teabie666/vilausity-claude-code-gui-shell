/**
 * The Claude Code extension's version (M4): the settings for its updates, and a block at the
 * top of their section in the settings editor with the version in use and where it came
 * from, Check for Updates, Install from VSIX..., going back to the version before, and a
 * restart when a new one is ready (versionView.ts; the setup guide shows it too). Main does
 * the work (host/main/extensionUpdater.ts); an automatic update says so once it is downloaded.
 */

import { CommandCategory } from '../../core/messages';
import type { ShellModule } from '../../core/module';
import { ICommands, IDialogs, INative, ISettings } from '../../core/serviceIds';
import { Emitter } from '../../platform/event';
import { AUTO_UPDATE_SETTING, DEFAULT_OPEN_VSX_URL, OPEN_VSX_URL_SETTING, PINNED_VERSION_SETTING } from '../../platform/extensionUpdates';
import type { ExtensionInstallResult, ExtensionStatus } from '../../platform/protocol';
import { t } from './messages';
import { resultText, rollBackFailedText, VersionView } from './versionView';

export { activityText, progressText, resultText, rollBackFailedText } from './versionView';

export const extensionUpdatesModule: ShellModule = {
  id: 'extensionUpdates',
  dependsOn: ['settings'],
  async activate({ services, subscriptions, logger }) {
    const native = services.get(INative);
    const settings = services.get(ISettings);
    const dialogs = services.get(IDialogs);
    const commands = services.get(ICommands);

    let status: ExtensionStatus = await native.call('extension.status', undefined);
    /** The last outcome of an action taken here (a check's also arrives in the status). */
    let note: string | undefined;
    const changed = subscriptions.add(new Emitter<void>());
    subscriptions.add(
      native.on('extensionStatus', (next) => {
        if (next.lastCheck?.at !== status.lastCheck?.at) {
          // A newer check (an automatic one, say) says more than an older action.
          note = undefined;
        }
        status = next;
        changed.fire();
      }),
    );
    const setNote = (text: string | undefined): void => {
      note = text;
      changed.fire();
    };

    const section = t('section');
    subscriptions.add(
      settings.register([
        {
          key: AUTO_UPDATE_SETTING,
          section,
          order: 1,
          schema: { type: 'boolean', default: true, description: t('autoUpdateSetting') },
        },
        {
          key: PINNED_VERSION_SETTING,
          section,
          order: 2,
          showDescription: true,
          schema: { type: 'string', default: '', pattern: '^(\\d+(\\.\\d+)*(-[0-9A-Za-z.]+)?)?$', description: t('versionSetting') },
        },
        {
          key: OPEN_VSX_URL_SETTING,
          section,
          order: 3,
          schema: { type: 'string', default: DEFAULT_OPEN_VSX_URL, format: 'uri', description: t('openVsxSetting') },
        },
      ]),
    );

    const relaunch = (): void => void native.call('app.relaunch', undefined);
    const check = async (): Promise<ExtensionInstallResult> => {
      setNote(undefined);
      const result = await native.call('extension.check', undefined);
      setNote(resultText(result));
      return result;
    };
    const installFile = async (): Promise<ExtensionInstallResult> => {
      setNote(undefined);
      const result = await native.call('extension.installFile', undefined);
      setNote(resultText(result));
      return result;
    };
    /** One click: back to the version before, then a restart to use it (windows and conversations come back). */
    const rollBack = async (): Promise<ExtensionInstallResult> => {
      setNote(undefined);
      const result = await native.call('extension.rollBack', undefined);
      if (result.outcome === 'installed') {
        relaunch();
      } else {
        setNote(rollBackFailedText(result));
      }
      return result;
    };
    const logged =
      <T>(action: () => Promise<T>) =>
      (): void => {
        action().catch((error: unknown) => logger.error('extension action failed', error));
      };

    subscriptions.add(
      settings.registerWidget({
        id: 'extensionUpdates.version',
        section,
        keywords: t('keywords'),
        create: (container) => {
          const view = new VersionView(container, {
            relaunch,
            check: logged(check),
            installFile: logged(installFile),
            rollBack: logged(rollBack),
          });
          const render = (): void => view.render(status, note);
          render();
          return changed.event(render);
        },
      }),
    );

    // From the command palette the outcome comes as a notification.
    const notify = (text: string | undefined, failed: boolean): void => {
      if (text) {
        void dialogs.showMessage({ severity: failed ? 'error' : 'info', message: text, modal: false, items: [] });
      }
    };
    const category = CommandCategory.preferences;
    subscriptions.add(
      commands.register(
        'extension.checkForUpdates',
        async () => {
          const result = await check();
          notify(resultText(result), result.outcome === 'failed');
        },
        { title: t('checkCommand'), category },
      ),
    );
    subscriptions.add(
      commands.register(
        'extension.installFromVsix',
        async () => {
          const result = await installFile();
          notify(resultText(result), result.outcome === 'failed');
        },
        { title: t('installFileCommand'), category },
      ),
    );
    subscriptions.add(
      commands.register(
        'extension.rollBack',
        async () => {
          const result = await rollBack();
          notify(rollBackFailedText(result), true);
        },
        { title: t('rollBackCommand'), category },
      ),
    );

    // An automatic update is ready: say so once, in the window that was used last.
    subscriptions.add(
      native.on('extensionUpdated', ({ version }) => {
        void dialogs
          .showMessage({ severity: 'info', message: t('updated', version), modal: false, items: [t('restartNow')] })
          .then((picked) => {
            if (picked === 0) {
              relaunch();
            }
          });
      }),
    );

    // The extension running uses an API Vilausity lacks that the version before did not: offer
    // to go back to that one (as the settings' button does), or not to hear of this version again.
    const showUnimplemented = async (): Promise<void> => {
      const warning = await native.call('extension.takeUnimplementedWarning', undefined);
      if (warning === undefined) {
        return; // none, or another window took it
      }
      const { version, rollback } = warning;
      const items = rollback === undefined ? [t('notAgain')] : [t('rollBackAndRestart', rollback), t('notAgain')];
      const picked = await dialogs.showMessage({ severity: 'warning', message: t('unimplemented', version), modal: false, items });
      if (picked === undefined) {
        return;
      }
      if (rollback !== undefined && picked === 0) {
        const result = await native.call('extension.rollBack', undefined);
        if (result.outcome === 'installed') {
          relaunch();
        }
      } else {
        await native.call('extension.unimplementedMute', { version });
      }
    };
    const showFailed = (error: unknown): void => logger.error('showing the unimplemented-API warning failed', error);
    subscriptions.add(native.on('extensionUnimplemented', () => void showUnimplemented().catch(showFailed)));
    // It may have come before this page listened.
    void showUnimplemented().catch(showFailed);
  },
};
