/**
 * Quick start (M6.7): a content-pane tab with the safety notes and the steps that show what
 * Claude Code does and what Vilausity adds, plus the guide to a DeepSeek API key (its own tab).
 * The steps are data (steps.ts); this module owns what a window knows about them: which are
 * ticked off (main stores that), the commands they point at, and running a step's button. A
 * step is ticked off by its button, by hand, or by running one of its commands anywhere: the
 * command listener sits here, so it works with no tab open.
 */

import { CommandCategory } from '../../core/messages';
import type { EditorPane } from '../../core/editors';
import type { ShellModule } from '../../core/module';
import { ICommands, IEditors, IExtensionHost, IKeybindings, INative } from '../../core/serviceIds';
import { Emitter, type Event } from '../../platform/event';
import { DisposableStore } from '../../platform/lifecycle';
import { IContentPane } from '../contentPane';
import { DeepSeekGuideView, type DeepSeekGuideViewOptions } from './deepSeekView';
import { t } from './messages';
import { QuickStartView } from './quickStartView';
import { QUICK_START_GROUPS, type QuickStartGroup, type QuickStartStep, type StepAction } from './steps';

const TAB = 'quickStart';
const DEEPSEEK_TAB = 'quickStart.deepSeek';
const OPEN_COMMAND = 'quickStart.open';
const DEEPSEEK_COMMAND = 'quickStart.deepSeekKey';

/** `{ onboarding: true }`: the setup guide just finished, and opening this tab ends the onboarding. */
function isOnboarding(arg: unknown): boolean {
  return typeof arg === 'object' && arg !== null && (arg as { readonly onboarding?: unknown }).onboarding === true;
}

/** What a page of the quick start needs from the module. */
interface QuickStartPaneContext {
  readonly groups: readonly QuickStartGroup[];
  readonly keyFor: (command: string) => string | undefined;
  readonly commandTitle: (command: string) => string | undefined;
  readonly done: () => ReadonlySet<string>;
  /** Asks main again (another window may have ticked steps off since). */
  readonly reload: () => Promise<void>;
  readonly onDidChangeDone: Event<void>;
  readonly onDidChangeKeys: Event<void>;
  readonly onTry: (step: QuickStartStep, action: StepAction) => void;
  readonly onToggle: (step: QuickStartStep, done: boolean) => void;
}

class QuickStartEditorPane implements EditorPane {
  private readonly view: QuickStartView;
  private readonly subscriptions = new DisposableStore();

  constructor(container: HTMLElement, context: QuickStartPaneContext) {
    this.view = new QuickStartView(container, {
      groups: context.groups,
      keyFor: context.keyFor,
      commandTitle: context.commandTitle,
      onTry: context.onTry,
      onToggle: context.onToggle,
    });
    this.view.setDone(context.done());
    this.subscriptions.add(context.onDidChangeDone(() => this.view.setDone(context.done())));
    this.subscriptions.add(context.onDidChangeKeys(() => this.view.refreshKeys()));
    // Another window may have ticked some off since this one read the progress.
    void context.reload();
  }

  layout(): void {}

  setVisible(): void {}

  focus(): void {}

  relocate(container: HTMLElement): void {
    this.view.relocate(container);
  }

  dispose(): void {
    this.subscriptions.dispose();
    this.view.dispose();
  }
}

class DeepSeekEditorPane implements EditorPane {
  private readonly view: DeepSeekGuideView;

  constructor(container: HTMLElement, options: DeepSeekGuideViewOptions) {
    this.view = new DeepSeekGuideView(container, options);
  }

  layout(): void {}

  setVisible(): void {}

  focus(): void {}

  relocate(container: HTMLElement): void {
    this.view.relocate(container);
  }

  dispose(): void {
    this.view.dispose();
  }
}

export const quickStartModule: ShellModule = {
  id: 'quickStart',
  dependsOn: ['contentPane'],
  async activate({ services, subscriptions, logger }) {
    const native = services.get(INative);
    const commands = services.get(ICommands);
    const editors = services.get(IEditors);
    const keybindings = services.get(IKeybindings);
    const contentPane = services.get(IContentPane);
    const connection = services.get(IExtensionHost);

    /** The steps ticked off, as main last answered. */
    let doneIds: ReadonlySet<string> = new Set();
    const doneEmitter = new Emitter<void>();
    subscriptions.add(doneEmitter);

    const reload = async (): Promise<void> => {
      try {
        doneIds = new Set(await native.call('quickStart.progress', undefined));
        doneEmitter.fire();
      } catch (error) {
        logger.error('reading the quick start progress failed', error);
      }
    };

    const mark = (step: string, done: boolean): void => {
      native.call('quickStart.mark', { step, done }).then(
        (ids) => {
          doneIds = new Set(ids);
          doneEmitter.fire();
        },
        (error: unknown) => logger.error(`marking quick start step ${step} failed`, error),
      );
    };

    // A command run anywhere ticks off the steps that name it, even with no tab open.
    subscriptions.add(
      commands.onDidExecute((id) => {
        for (const group of QUICK_START_GROUPS) {
          for (const step of group.steps) {
            if (!doneIds.has(step.id) && step.doneWhen?.includes(id) === true) {
              mark(step.id, true);
            }
          }
        }
      }),
    );

    const commandTitle = (command: string): string | undefined => {
      const info = commands.info(command);
      if (info?.title === undefined) {
        return undefined;
      }
      // A menu title's "..." (it opens a picker) means nothing in a list of shortcuts.
      const title = info.title.replace(/(\.\.\.|…)$/, '');
      return info.category === undefined ? title : `${info.category}: ${title}`;
    };

    const runAction = (step: QuickStartStep, action: StepAction): void => {
      mark(step.id, true);
      if (action.kind === 'command') {
        void commands.execute(action.command, ...(action.args ?? [])).catch((error: unknown) => {
          logger.error(`quick start step ${step.id}: ${action.command} failed`, error);
        });
      } else if (action.kind === 'prompt') {
        // A new conversation with the prompt in its input, not sent: what it costs stays the user's call.
        connection.rpc?.notify('conversation.open', { prompt: action.prompt() });
      } else {
        void native.call('os.openExternal', { url: action.url() }).catch((error: unknown) => {
          logger.error(`quick start step ${step.id}: opening ${action.url()} failed`, error);
        });
      }
    };

    const context: QuickStartPaneContext = {
      groups: QUICK_START_GROUPS,
      keyFor: (command) => keybindings.labelFor(command),
      commandTitle,
      done: () => doneIds,
      reload,
      onDidChangeDone: doneEmitter.event,
      onDidChangeKeys: keybindings.onDidChange,
      onTry: runAction,
      onToggle: (step, done) => mark(step.id, done),
    };

    const openQuickStart = (): void => {
      contentPane.open({ id: TAB, typeId: TAB, label: t('editorTitle') }, { preview: false });
    };
    const openDeepSeek = (): void => {
      contentPane.open({ id: DEEPSEEK_TAB, typeId: DEEPSEEK_TAB, label: t('deepSeekTitle') }, { preview: false });
    };

    const openLink = (url: string): void => {
      void native.call('os.openExternal', { url }).catch((error: unknown) => logger.error(`opening ${url} failed`, error));
    };

    subscriptions.add(
      editors.register({
        id: 'quickStart.editor',
        accepts: (input) => input.typeId === TAB,
        create: (container) => new QuickStartEditorPane(container, context),
      }),
    );
    subscriptions.add(
      editors.register({
        id: 'quickStart.deepSeek.editor',
        accepts: (input) => input.typeId === DEEPSEEK_TAB,
        create: (container) => new DeepSeekEditorPane(container, { openLink }),
      }),
    );

    subscriptions.add(
      commands.register(
        OPEN_COMMAND,
        async (arg?: unknown) => {
          openQuickStart();
          // The setup guide hands over here; opening the tab is the end of the onboarding.
          if (isOnboarding(arg)) {
            try {
              await native.call('onboarding.done', undefined);
            } catch (error) {
              logger.error('finishing the onboarding failed', error);
            }
          }
        },
        { title: t('openQuickStart'), category: CommandCategory.help },
      ),
    );
    subscriptions.add(commands.register(DEEPSEEK_COMMAND, openDeepSeek, { title: t('openDeepSeekGuide'), category: CommandCategory.help }));

    // So a tab opened first thing already knows which steps are ticked off.
    await reload();
  },
};
