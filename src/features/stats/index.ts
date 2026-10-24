/**
 * Statistics (M6.6): a content-pane tab that shows how Claude Code was used, from the
 * transcripts main reads in the sessions worker (StatsDto, platform/stats.ts). The tab's
 * input id is fixed, so opening it again activates the tab already open. Its scope (this
 * window's folder, or every folder) and its errors stay in this pane; StatsView (statsView.ts)
 * just draws whatever it is given.
 */

import { CommandCategory } from '../../core/messages';
import type { EditorPane } from '../../core/editors';
import type { ShellModule } from '../../core/module';
import type { NativeApi } from '../../core/native';
import { ICommands, IEditors, INative, IWorkspace } from '../../core/serviceIds';
import type { ILogger } from '../../platform/log';
import { IContentPane } from '../contentPane';
import { t } from './messages';
import { StatsView, type StatsScope, type StatsViewState } from './statsView';

const INPUT = 'stats';
const COMMAND = 'stats.show';

class StatsEditorPane implements EditorPane {
  private readonly view: StatsView;
  private scope: StatsScope;
  private disposed = false;

  constructor(
    container: HTMLElement,
    private readonly context: {
      readonly native: NativeApi;
      readonly folder: string;
      readonly hasFolder: boolean;
      readonly openSession: (sessionId: string, folder: string | undefined) => Promise<void>;
      readonly logger: ILogger;
    },
  ) {
    this.scope = 'all';
    this.view = new StatsView(container, {
      hasFolder: context.hasFolder,
      onScope: (scope) => {
        this.scope = scope;
        this.load();
      },
      onRefresh: () => this.load(),
      onOpenSession: (sessionId, folder) => void context.openSession(sessionId, folder),
      onReveal: (path) => void context.native.call('os.openFolder', { path }),
    });
    this.load();
  }

  private load(): void {
    this.render({ loading: true, error: undefined, data: undefined, scope: this.scope });
    const folder = this.scope === 'folder' ? this.context.folder : undefined;
    this.context.native.call('stats.get', { folder }).then(
      (data) => {
        if (!this.disposed) {
          this.render({ loading: false, error: undefined, data, scope: this.scope });
        }
      },
      (error: unknown) => {
        this.context.logger.error('loading the statistics failed', error);
        if (!this.disposed) {
          this.render({ loading: false, error: String(error), data: undefined, scope: this.scope });
        }
      },
    );
  }

  private render(state: StatsViewState): void {
    this.view.render(state);
  }

  layout(): void {}

  setVisible(): void {}

  focus(): void {}

  relocate(container: HTMLElement): void {
    this.view.relocate(container);
  }

  dispose(): void {
    this.disposed = true;
    this.view.dispose();
  }
}

export const statsModule: ShellModule = {
  id: 'stats',
  dependsOn: ['contentPane'],
  activate({ services, subscriptions, logger }) {
    const native = services.get(INative);
    const commands = services.get(ICommands);
    const contentPane = services.get(IContentPane);
    const workspace = services.get(IWorkspace);
    const folder = workspace.folders[0] ?? workspace.homeFolder;
    const hasFolder = workspace.folders.length > 0;

    const openEditor = (): void => {
      contentPane.open({ id: INPUT, typeId: INPUT, label: t('editorTitle') }, { preview: false });
    };

    const openSession = async (sessionId: string, sessionFolder: string | undefined): Promise<void> => {
      const opened = await native.call('sessions.open', { folder: sessionFolder ?? folder, sessionId });
      if (!opened) {
        logger.warn(`opening session ${sessionId} failed`);
      }
    };

    subscriptions.add(
      services.get(IEditors).register({
        id: 'stats.editor',
        accepts: (input) => input.typeId === INPUT,
        create: (container) => new StatsEditorPane(container, { native, folder, hasFolder, openSession, logger }),
      }),
    );

    subscriptions.add(commands.register(COMMAND, openEditor, { title: t('showStatistics'), category: CommandCategory.view }));
  },
};
