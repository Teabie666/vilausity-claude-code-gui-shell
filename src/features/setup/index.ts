/**
 * The first run (M4). When the Claude Code extension is not installed, the main area shows a
 * page with two steps: install the extension (download it from Open VSX, with progress, or
 * pick a .vsix), then connect to Claude: a Claude account (the extension shows its own
 * sign-in) or an API provider (added from a preset, and switched to once it has its key).
 * Main starts the extension in every window as soon as it is installed; no restart.
 * Also the notices shown once: Git for Windows missing.
 */

import type { ShellModule } from '../../core/module';
import { ICommands, IDialogs, IExtensionHost, ILayout, INative, ISettings } from '../../core/serviceIds';
import { Emitter } from '../../platform/event';
import { DEFAULT_OPEN_VSX_URL, OPEN_VSX_URL_SETTING } from '../../platform/extensionUpdates';
import { DisposableStore, type IDisposable } from '../../platform/lifecycle';
import type { ExtensionInstallResult, ExtensionStatus, ProvidersState } from '../../platform/protocol';
import { IConversations } from '../conversations';
import { activityText, resultText } from '../extensionUpdates';
import { t } from './messages';

const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads/win';

/** Whether a provider can be used as it is: the ones that take a key need theirs. */
function usable(state: ProvidersState, id: string): boolean {
  const provider = state.providers.find((candidate) => candidate.id === id);
  if (!provider) {
    return false;
  }
  return provider.type === 'compatible' || provider.type === 'anthropic-api' ? provider.hasKey : true;
}

export const setupModule: ShellModule = {
  id: 'setup',
  dependsOn: ['conversations', 'providers', 'extensionUpdates', 'settings'],
  async activate({ services, subscriptions, logger }) {
    const native = services.get(INative);
    const dialogs = services.get(IDialogs);
    const commands = services.get(ICommands);
    const settings = services.get(ISettings);
    const connection = services.get(IExtensionHost);

    void native.call('app.startupNotices', undefined).then(
      async ({ gitMissing }) => {
        if (!gitMissing) {
          return;
        }
        const choice = await dialogs.showMessage({
          severity: 'info',
          // (A notification shows no detail, as in VS Code: the message says it all.)
          message: t('gitMissing'),
          modal: false,
          items: [t('downloadGit'), t('dontShowAgain')],
        });
        if (choice === 0) {
          await native.call('os.openExternal', { url: GIT_DOWNLOAD_URL });
        }
      },
      (error: unknown) => logger.error('reading the startup notices failed', error),
    );

    let status = await native.call('extension.status', undefined);
    if (status.running) {
      return;
    }

    const page = subscriptions.add(new DisposableStore());
    let note: string | undefined;
    const changed = page.add(new Emitter<void>());
    const view = new SetupView(services.get(ILayout).main, {
      download: () => install(() => native.call('extension.check', undefined)),
      installFile: () => install(() => native.call('extension.installFile', undefined)),
      changeServer: () => void commands.execute('settings.open', 'extension version'),
      account: () => {
        page.dispose();
        // The extension shows its sign-in in a conversation, if it needs one.
        if ((services.tryGet(IConversations)?.count ?? 0) === 0) {
          void commands.execute('conversations.new');
        }
      },
      provider: () => void addProvider(),
      later: () => page.dispose(),
    });
    page.add(view);
    const render = (): void => view.render(status, connection.isConnected, note, settings.get(OPEN_VSX_URL_SETTING, DEFAULT_OPEN_VSX_URL));
    page.add(changed.event(render));
    page.add(
      native.on('extensionStatus', (next) => {
        status = next;
        changed.fire();
      }),
    );
    page.add(connection.onDidConnect(() => changed.fire()));
    page.add(settings.onDidChange((keys) => keys.includes(OPEN_VSX_URL_SETTING) && changed.fire()));
    render();

    async function install(run: () => Promise<ExtensionInstallResult>): Promise<void> {
      note = undefined;
      changed.fire();
      try {
        const result = await run();
        note = result.outcome === 'installed' ? undefined : resultText(result);
      } catch (error) {
        logger.error('installing the extension failed', error);
      }
      changed.fire();
    }

    /** Adds a provider from a preset; once it has its key (if it takes one), the window uses it. */
    async function addProvider(): Promise<void> {
      const id = (await commands.execute('providers.add')) as string | undefined;
      if (!id) {
        return;
      }
      page.dispose();
      const watch = subscriptions.add(new DisposableStore());
      const select = (state: ProvidersState): void => {
        if (usable(state, id)) {
          watch.dispose();
          native.call('providers.select', { id }).catch((error: unknown) => logger.error('switching provider failed', error));
        }
      };
      watch.add(native.on('providersChanged', select));
    }
  },
};

/** The page's handlers (handed to its buttons as they are, so not methods). */
interface SetupActions {
  readonly download: () => void;
  readonly installFile: () => void;
  readonly changeServer: () => void;
  readonly account: () => void;
  readonly provider: () => void;
  readonly later: () => void;
}

/** The page, over the main area. */
class SetupView implements IDisposable {
  private readonly root: HTMLElement;
  private readonly installStep: HTMLElement;
  private readonly installText: HTMLElement;
  private readonly downloadButton: HTMLButtonElement;
  private readonly fileButton: HTMLButtonElement;
  private readonly progress: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly connectStep: HTMLElement;
  private readonly choices: HTMLButtonElement[];
  private readonly laterLink: HTMLElement;

  constructor(container: HTMLElement, actions: SetupActions) {
    const doc = container.ownerDocument;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] => {
      const node = doc.createElement(tag);
      node.className = className;
      node.textContent = text;
      return node;
    };
    const link = (text: string, className: string, onClick: () => void): HTMLAnchorElement => {
      const node = element('a', `setup-link ${className}`, text);
      node.href = '#';
      node.addEventListener('click', (event) => {
        event.preventDefault();
        onClick();
      });
      return node;
    };
    const stepTitle = (number: string, text: string): HTMLElement => {
      const title = element('h2', 'setup-step-title');
      title.append(element('span', 'setup-step-number', number), element('span', '', text));
      return title;
    };

    this.root = element('div', 'setup-page');
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', t('pageLabel'));
    const content = element('div', 'setup-content');

    this.installStep = element('section', 'setup-step setup-install');
    this.installText = element('p', 'setup-text');
    this.downloadButton = element('button', 'button setup-download', t('download'));
    this.downloadButton.addEventListener('click', actions.download);
    this.fileButton = element('button', 'button secondary setup-file', t('installFile'));
    this.fileButton.addEventListener('click', actions.installFile);
    const buttons = element('div', 'setup-actions');
    buttons.append(this.downloadButton, this.fileButton, link(t('changeServer'), 'setup-server', actions.changeServer));
    this.progress = element('div', 'setup-progress');
    this.progressBar = element('div', 'setup-progress-bar');
    this.progress.appendChild(this.progressBar);
    this.statusText = element('div', 'setup-status');
    this.statusText.setAttribute('role', 'status');
    this.installStep.append(stepTitle('1', t('installStep')), this.installText, buttons, this.progress, this.statusText);

    this.connectStep = element('section', 'setup-step setup-connect');
    const choice = (title: string, text: string, className: string, onClick: () => void): HTMLButtonElement => {
      const node = element('button', `setup-choice ${className}`);
      node.append(element('span', 'setup-choice-title', title), element('span', 'setup-choice-text', text));
      node.addEventListener('click', onClick);
      return node;
    };
    this.choices = [
      choice(t('account'), t('accountText'), 'setup-account', actions.account),
      choice(t('provider'), t('providerText'), 'setup-provider', actions.provider),
    ];
    const choices = element('div', 'setup-choices');
    choices.append(...this.choices);
    this.laterLink = link(t('later'), 'setup-later', actions.later);
    this.connectStep.append(stepTitle('2', t('connectStep')), choices, this.laterLink);

    content.append(element('h1', 'setup-title', t('welcome')), element('p', 'setup-intro', t('intro')), this.installStep, this.connectStep);
    this.root.appendChild(content);
    container.appendChild(this.root);
  }

  render(status: ExtensionStatus, connected: boolean, note: string | undefined, openVsxUrl: string): void {
    const { activity, running } = status;
    const busy = activity.kind !== 'idle';
    this.installText.textContent = t('installText', openVsxUrl);
    this.downloadButton.disabled = busy || running !== undefined;
    this.fileButton.disabled = busy || running !== undefined;
    this.progress.hidden = activity.kind !== 'downloading';
    if (activity.kind === 'downloading') {
      const fraction = activity.total ? activity.received / activity.total : 0;
      this.progressBar.style.width = `${Math.round(fraction * 100)}%`;
    }
    this.statusText.textContent = running
      ? connected
        ? t('installed', running.version)
        : t('starting', running.version)
      : (activityText(activity) ?? note ?? '');
    this.installStep.classList.toggle('done', running !== undefined);

    // Connecting needs the extension running in this window.
    const ready = running !== undefined && connected;
    this.connectStep.setAttribute('aria-disabled', String(!ready));
    for (const button of this.choices) {
      button.disabled = !ready;
    }
    // Closing the page before the extension is installed would leave an empty window.
    this.laterLink.hidden = !ready;
  }

  dispose(): void {
    this.root.remove();
  }
}
