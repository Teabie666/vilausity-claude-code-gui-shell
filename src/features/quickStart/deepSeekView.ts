/**
 * The guide to a DeepSeek API key (features/quickStart): a tab of its own, opened by
 * `quickStart.deepSeekKey` (the setup guide's "I don't have one yet"). Numbered steps from
 * signing in on DeepSeek's platform to pasting the key into the setup guide, with buttons to
 * the platform's pages. The platform's pages as of 2026-10.
 */

import type { IDisposable } from '../../platform/lifecycle';
import { t } from './messages';

const PLATFORM = 'https://platform.deepseek.com';

export interface DeepSeekGuideViewOptions {
  /** Opens a web page in the browser. */
  readonly openLink: (url: string) => void;
  /** Opens the setup guide (or brings the open one forward). */
  readonly openSetup: () => void;
}

interface GuideStep {
  readonly title: string;
  readonly body: string;
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
    const link = (label: string, path: string) => ({ label, run: () => this.options.openLink(`${PLATFORM}${path}`) });
    const steps: readonly GuideStep[] = [
      { title: t('dsSignInTitle'), body: t('dsSignInBody'), buttons: [link(t('dsOpenPlatform'), '/')] },
      { title: t('dsVerifyTitle'), body: t('dsVerifyBody'), buttons: [] },
      {
        title: t('dsTopUpTitle'),
        body: t('dsTopUpBody'),
        buttons: [
          link(t('dsTopUp'), '/top_up'),
          { label: t('dsPricing'), run: () => this.options.openLink('https://api-docs.deepseek.com/quick_start/pricing') },
        ],
      },
      { title: t('dsCreateTitle'), body: t('dsCreateBody'), buttons: [link(t('dsApiKeys'), '/api_keys')] },
      { title: t('dsPasteTitle'), body: t('dsPasteBody'), buttons: [{ label: t('dsOpenSetup'), run: () => this.options.openSetup() }] },
      { title: t('dsUsageTitle'), body: t('dsUsageBody'), buttons: [link(t('dsUsage'), '/usage')] },
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
