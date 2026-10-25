/**
 * The guide to a DeepSeek API key (features/quickStart): a tab of its own, opened by
 * `quickStart.deepSeekKey` (the setup guide's "I don't have one yet"). Numbered steps from
 * signing in on DeepSeek's platform to pasting the key into the setup guide, with screenshots
 * of the platform's pages (resources/deepseek-guide, marked up with numbers the text refers to)
 * and one button, to the platform. The platform's pages as of 2026-10.
 */

import type { IDisposable } from '../../platform/lifecycle';
import { t } from './messages';

const PLATFORM = 'https://platform.deepseek.com';
/** Where the build puts the screenshots, beside the shell's page (scripts/build.mjs). */
const SHOTS = 'images/deepseek-guide/';

export interface DeepSeekGuideViewOptions {
  /** Opens a web page in the browser. */
  readonly openLink: (url: string) => void;
}

interface GuideStep {
  readonly title: string;
  readonly body: string;
  /** Said apart from the text, so that it is not missed. */
  readonly warning?: string;
  /** Screenshots, below the text. */
  readonly shots?: readonly { readonly file: string; readonly alt: string }[];
  readonly buttons: readonly { readonly label: string; readonly run: () => void }[];
}

export class DeepSeekGuideView implements IDisposable {
  private readonly root: HTMLElement;

  constructor(
    container: HTMLElement,
    private readonly options: DeepSeekGuideViewOptions,
  ) {
    const doc = container.ownerDocument;
    this.root = doc.createElement('div');
    this.root.className = 'quick-start deepseek-guide';
    const content = doc.createElement('div');
    content.className = 'quick-start-content';
    const heading = doc.createElement('h1');
    heading.className = 'quick-start-heading';
    heading.textContent = t('deepSeekTitle');
    const intro = doc.createElement('p');
    intro.className = 'quick-start-intro';
    intro.textContent = t('dsIntro');
    content.append(heading, intro, this.steps(doc));
    const note = doc.createElement('p');
    note.className = 'deepseek-note';
    note.textContent = t('dsKeepSafe');
    content.append(note);
    this.root.append(content);
    container.append(this.root);
  }

  private steps(doc: Document): HTMLElement {
    const steps: readonly GuideStep[] = [
      {
        title: t('dsSignInTitle'),
        body: t('dsSignInBody'),
        buttons: [{ label: t('dsOpenPlatform'), run: () => this.options.openLink(PLATFORM) }],
      },
      { title: t('dsVerifyTitle'), body: t('dsVerifyBody'), buttons: [] },
      {
        title: t('dsTopUpTitle'),
        body: t('dsTopUpBody'),
        shots: [{ file: 'top-up.png', alt: t('dsShotTopUp') }],
        buttons: [],
      },
      {
        title: t('dsCreateTitle'),
        body: t('dsCreateBody'),
        warning: t('dsCreateWarning'),
        shots: [
          { file: 'api-keys.png', alt: t('dsShotApiKeys') },
          { file: 'create-key.png', alt: t('dsShotCreateKey') },
        ],
        buttons: [],
      },
      { title: t('dsPasteTitle'), body: t('dsPasteBody'), buttons: [] },
      {
        title: t('dsUsageTitle'),
        body: t('dsUsageBody'),
        shots: [{ file: 'usage.png', alt: t('dsShotUsage') }],
        buttons: [],
      },
    ];

    const list = doc.createElement('ol');
    list.className = 'deepseek-steps';
    for (const step of steps) {
      const item = doc.createElement('li');
      const title = doc.createElement('h2');
      title.className = 'deepseek-step-title';
      title.textContent = step.title;
      const body = doc.createElement('p');
      body.textContent = step.body;
      item.append(title, body);
      if (step.warning !== undefined) {
        const warning = doc.createElement('p');
        warning.className = 'deepseek-warning';
        warning.textContent = step.warning;
        item.append(warning);
      }
      for (const shot of step.shots ?? []) {
        const image = doc.createElement('img');
        image.className = 'deepseek-shot';
        // Against the shell's page, also when the tab is in a window of its own (about:blank).
        image.src = new URL(SHOTS + shot.file, globalThis.location.href).href;
        image.alt = shot.alt;
        image.title = shot.alt;
        item.append(image);
      }
      if (step.buttons.length > 0) {
        const actions = doc.createElement('div');
        actions.className = 'deepseek-actions';
        step.buttons.forEach((spec, index) => {
          const button = doc.createElement('button');
          button.type = 'button';
          button.className = index === 0 ? 'button' : 'button secondary';
          button.textContent = spec.label;
          button.addEventListener('click', spec.run);
          actions.append(button);
        });
        item.append(actions);
      }
      list.append(item);
    }
    return list;
  }

  relocate(container: HTMLElement): void {
    container.append(this.root);
  }

  dispose(): void {
    this.root.remove();
  }
}
