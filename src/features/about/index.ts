/**
 * About: a section of the settings editor (M6.6) with the app's and the Claude Code
 * extension's versions, and whether GitHub has a newer release. It is not a setting: one
 * block, the logo beside the versions, with links and Copy Version Information (which adds
 * what the app runs on). The latest release is asked for when the section is first shown;
 * main keeps a successful answer for an hour, and a failed one can be retried by hand
 * (GitHub is often unreachable). The buttons open the Setup Guide too; the statistics tab
 * adds its entry here later.
 */

import type { ShellModule } from '../../core/module';
import { ICommands, INative, ISettings } from '../../core/serviceIds';
import { isNewerVersion, RELEASES_URL, REPOSITORY_URL } from '../../platform/about';
import { Emitter } from '../../platform/event';
import { LOGO_CURSOR, LOGO_STROKES, LOGO_VIEW_BOX } from '../../platform/logoMark';
import type { ExtensionStatus, RendererInitData } from '../../platform/protocol';
import { t } from './messages';
import { versionInfoText } from './versionInfo';

type ReleaseState =
  { readonly kind: 'loading' } | { readonly kind: 'failed' } | { readonly kind: 'ready'; readonly version: string; readonly url: string };

interface AboutViewOptions {
  readonly copy: () => Promise<void>;
  readonly openUrl: (url: string) => void;
  readonly retry: () => void;
  readonly setupGuide: () => void;
  readonly statistics: () => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The app's mark, as the title bar draws it (still: no activity here). */
function logo(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'about-logo');
  svg.setAttribute('viewBox', LOGO_VIEW_BOX.join(' '));
  svg.setAttribute('aria-hidden', 'true');
  for (const points of [...LOGO_STROKES, LOGO_CURSOR]) {
    const shape = doc.createElementNS(SVG_NS, 'polygon');
    shape.setAttribute('points', points.join(' '));
    svg.append(shape);
  }
  return svg;
}

class AboutView {
  private readonly appVersion: HTMLElement;
  private readonly extension: HTMLElement;
  private readonly release: HTMLElement;
  private readonly releaseText: HTMLElement;
  private readonly newer: HTMLButtonElement;
  private readonly retry: HTMLButtonElement;
  private readonly status: HTMLElement;
  private copiedTimer: number | undefined;
  /** The newer release's page, which its link opens. */
  private newerUrl = RELEASES_URL;

  constructor(
    container: HTMLElement,
    private readonly options: AboutViewOptions,
  ) {
    const doc = container.ownerDocument;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, about?: string): HTMLElementTagNameMap[K] => {
      const created = doc.createElement(tag);
      created.className = className;
      if (about) {
        created.dataset.about = about;
      }
      return created;
    };
    container.classList.add('about');

    const name = element('div', 'about-name');
    const product = element('span', 'about-product');
    product.textContent = 'Vilausity';
    this.appVersion = element('span', 'about-version', 'app');
    name.append(product, this.appVersion);
    this.extension = element('div', 'about-line', 'extension');
    this.release = element('div', 'about-line', 'release');
    this.releaseText = element('span', '');
    this.newer = element('button', 'link-button', 'newer');
    this.newer.addEventListener('click', () => this.options.openUrl(this.newerUrl));
    this.retry = element('button', 'link-button about-retry', 'retry');
    this.retry.textContent = t('retry');
    this.retry.addEventListener('click', () => this.options.retry());
    this.release.append(this.releaseText, this.newer, this.retry);

    const actions = element('div', 'about-actions');
    const button = (text: string, about: string, onClick: () => void): HTMLButtonElement => {
      const created = element('button', 'button secondary', about);
      created.textContent = text;
      created.addEventListener('click', onClick);
      return created;
    };
    this.status = element('span', 'about-status');
    this.status.setAttribute('role', 'status');
    actions.append(
      button(t('repository'), 'repository', () => this.options.openUrl(REPOSITORY_URL)),
      button(t('releases'), 'releases', () => this.options.openUrl(RELEASES_URL)),
      button(t('copy'), 'copy', () => {
        void this.options.copy().then(
          () => this.showCopied(),
          () => undefined,
        );
      }),
      button(t('setupGuide'), 'setup-guide', () => this.options.setupGuide()),
      button(t('statistics'), 'statistics', () => this.options.statistics()),
      this.status,
    );

    const text = element('div', 'about-text');
    text.append(name, this.extension, this.release, actions);
    container.append(logo(doc), text);
  }

  render(init: RendererInitData, extension: ExtensionStatus, release: ReleaseState): void {
    this.appVersion.textContent = init.appVersion;
    const extensionVersion = extension.running?.version;
    this.extension.textContent = extensionVersion === undefined ? t('noExtension') : t('extension', extensionVersion);

    // A newer release is a link to its page; no update button, the user downloads it there.
    const newer = release.kind === 'ready' && isNewerVersion(release.version, init.appVersion);
    this.release.dataset.state = release.kind;
    this.releaseText.textContent =
      release.kind === 'loading' ? t('checking') : release.kind === 'failed' ? t('fetchFailed') : newer ? '' : t('upToDate');
    this.releaseText.hidden = newer;
    this.newer.hidden = !newer;
    if (release.kind === 'ready') {
      this.newer.textContent = t('newer', release.version);
      this.newerUrl = release.url;
    }
    this.retry.hidden = release.kind !== 'failed';
  }

  dispose(): void {
    if (this.copiedTimer !== undefined) {
      clearTimeout(this.copiedTimer);
      this.copiedTimer = undefined;
    }
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
    const commands = services.get(ICommands);
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
          release = result.ok ? { kind: 'ready', version: result.release.version, url: result.release.url } : { kind: 'failed' };
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
      versionInfoText({ app: init.appVersion, extension: extensionStatus.running?.version, ...init.runtimeVersions });

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
            // The guide covers the main area, under the settings dialog: close the dialog first.
            setupGuide: () => void commands.execute('settings.close').then(() => commands.execute('setup.open')),
            statistics: () => void commands.execute('stats.show'),
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
