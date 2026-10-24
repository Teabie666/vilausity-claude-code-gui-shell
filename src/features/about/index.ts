/**
 * About: a section of the settings editor (M6.6) with the versions of the app, the Claude
 * Code extension and what runs it, plus the latest release on GitHub. It is not a setting:
 * one block, with links and Copy Version Information. The latest release is asked for when
 * the section is first shown; main keeps a successful answer for an hour, and a failed one
 * can be retried by hand (GitHub is often unreachable). The statistics tab adds its entry
 * here later.
 */

import type { ShellModule } from '../../core/module';
import { INative, ISettings } from '../../core/serviceIds';
import { isNewerVersion, RELEASES_URL, REPOSITORY_URL } from '../../platform/about';
import { Emitter } from '../../platform/event';
import type { ExtensionStatus, RendererInitData } from '../../platform/protocol';
import { t } from './messages';
import { versionInfoText } from './versionInfo';

type ReleaseState = { readonly kind: 'loading' } | { readonly kind: 'failed' } | { readonly kind: 'ready'; readonly version: string };

interface AboutViewOptions {
  readonly copy: () => Promise<void>;
  readonly openUrl: (url: string) => void;
  readonly retry: () => void;
}

class AboutView {
  private readonly values: Record<'app' | 'extension' | 'electron' | 'chromium' | 'node', HTMLElement>;
  private readonly release: HTMLElement;
  private readonly releaseText: HTMLElement;
  private readonly newer: HTMLElement;
  private readonly retry: HTMLButtonElement;
  private readonly status: HTMLElement;
  private copiedTimer: number | undefined;

  constructor(
    container: HTMLElement,
    private readonly options: AboutViewOptions,
  ) {
    const doc = container.ownerDocument;
    container.classList.add('about');
    const versions = doc.createElement('div');
    versions.className = 'about-versions';
    const row = (key: string, label: string): HTMLElement => {
      const labelElement = doc.createElement('span');
      labelElement.className = 'about-label';
      labelElement.textContent = label;
      const value = doc.createElement('span');
      value.className = 'about-value';
      value.dataset.about = key;
      versions.append(labelElement, value);
      return value;
    };
    this.values = {
      app: row('app', t('vilausity')),
      extension: row('extension', t('extension')),
      electron: row('electron', t('electron')),
      chromium: row('chromium', t('chromium')),
      node: row('node', t('node')),
    };

    this.release = row('release', t('latestRelease'));
    this.release.classList.add('about-release');
    this.releaseText = doc.createElement('span');
    this.release.append(this.releaseText);
    this.newer = doc.createElement('span');
    this.newer.className = 'about-newer';
    this.newer.textContent = t('newer');
    this.newer.hidden = true;
    this.retry = this.button(t('retry'), () => this.options.retry());
    this.retry.dataset.about = 'retry';
    this.retry.hidden = true;
    this.release.append(this.newer, this.retry);

    const actions = doc.createElement('div');
    actions.className = 'about-actions';
    const repository = this.button(t('repository'), () => this.options.openUrl(REPOSITORY_URL));
    repository.dataset.about = 'repository';
    const releases = this.button(t('releases'), () => this.options.openUrl(RELEASES_URL));
    releases.dataset.about = 'releases';
    const copy = this.button(t('copy'), () => {
      void this.options.copy().then(
        () => this.showCopied(),
        () => undefined,
      );
    });
    copy.dataset.about = 'copy';
    this.status = doc.createElement('span');
    this.status.className = 'about-status';
    this.status.setAttribute('role', 'status');
    actions.append(repository, releases, copy, this.status);
    container.append(versions, actions);
  }

  render(init: RendererInitData, extension: ExtensionStatus, release: ReleaseState): void {
    this.values.app.textContent = init.appVersion;
    this.values.extension.textContent = extension.running?.version ?? t('notInstalled');
    this.values.electron.textContent = init.runtimeVersions.electron;
    this.values.chromium.textContent = init.runtimeVersions.chromium;
    this.values.node.textContent = init.runtimeVersions.node;

    this.release.dataset.state = release.kind;
    this.releaseText.textContent =
      release.kind === 'loading' ? t('checking') : release.kind === 'failed' ? t('fetchFailed') : release.version;
    this.newer.hidden = release.kind !== 'ready' || !isNewerVersion(release.version, init.appVersion);
    this.retry.hidden = release.kind !== 'failed';
  }

  dispose(): void {
    if (this.copiedTimer !== undefined) {
      clearTimeout(this.copiedTimer);
      this.copiedTimer = undefined;
    }
  }

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const button = this.release.ownerDocument.createElement('button');
    button.className = 'button secondary';
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
  }

  private showCopied(): void {
    this.status.textContent = t('copied');
    if (this.copiedTimer !== undefined) {
      clearTimeout(this.copiedTimer);
    }
    this.copiedTimer = window.setTimeout(() => {
      this.status.textContent = '';
      this.copiedTimer = undefined;
    }, 2000);
  }
}

export const aboutModule: ShellModule = {
  id: 'about',
  dependsOn: ['settings'],
  async activate({ services, subscriptions, logger }) {
    const native = services.get(INative);
    const settings = services.get(ISettings);
    const init = await native.call('app.getInitData', undefined);
    let extensionStatus: ExtensionStatus = await native.call('extension.status', undefined);
    let release: ReleaseState = { kind: 'loading' };
    const changed = subscriptions.add(new Emitter<void>());

    const loadRelease = (force: boolean): void => {
      // While asking again, what is on screen stays; opening the section after an hour
      // refreshes it without flashing "Checking...". Retry starts from its own state.
      if (force) {
        release = { kind: 'loading' };
        changed.fire();
      }
      native.call('app.latestRelease', { force }).then(
        (result) => {
          release = result.ok ? { kind: 'ready', version: result.release.version } : { kind: 'failed' };
          changed.fire();
        },
        (error: unknown) => {
          logger.error('checking the latest release failed', error);
          release = { kind: 'failed' };
          changed.fire();
        },
      );
    };

    subscriptions.add(
      native.on('extensionStatus', (next) => {
        extensionStatus = next;
        changed.fire();
      }),
    );

    const openUrl = (url: string): void => {
      native.call('os.openExternal', { url }).catch((error: unknown) => logger.warn('opening a link failed', error));
    };
    const copyText = (): string =>
      versionInfoText(
        {
          app: init.appVersion,
          extension: extensionStatus.running?.version,
          electron: init.runtimeVersions.electron,
          chromium: init.runtimeVersions.chromium,
          node: init.runtimeVersions.node,
        },
        {
          app: t('vilausity'),
          extension: t('extension'),
          electron: t('electron'),
          chromium: t('chromium'),
          node: t('node'),
          notInstalled: t('notInstalled'),
        },
      );

    subscriptions.add(
      settings.registerWidget({
        id: 'about.info',
        section: t('section'),
        keywords: t('keywords'),
        create: (container) => {
          // Shown: ask once. Main answers from its hour-long cache most of the time.
          loadRelease(false);
          const view = new AboutView(container, {
            copy: () => native.call('os.clipboardWrite', { text: copyText() }),
            openUrl,
            retry: () => loadRelease(true),
          });
          const render = (): void => view.render(init, extensionStatus, release);
          render();
          const subscription = changed.event(render);
          return {
            dispose: () => {
              subscription.dispose();
              view.dispose();
            },
          };
        },
      }),
    );
  },
};
