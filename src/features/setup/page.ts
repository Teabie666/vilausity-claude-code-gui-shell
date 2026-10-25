/**
 * What the setup guide's pages share: the guide (guide.ts) shows one page at a time in its
 * tab, with the steps above it and Back / Skip / Next below it.
 */

import type { ServiceRegistry } from '../../core/services';
import type { IDisposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';

/** What a page can use. */
export interface GuideContext {
  readonly services: ServiceRegistry;
  readonly logger: ILogger;
  readonly doc: Document;
  /**
   * The guide was opened by a new version (main's onboarding), not by hand: the quick start
   * follows it, so a page that reloads the window first defers the quick start to main.
   */
  readonly automatic: boolean;
  /** The page's `canSkip` or `canGoOn` changed: the guide updates its buttons. */
  readonly changed: () => void;
  /** Moves to the next page, as Next does without asking `goOn` (a page's own choice did the work). */
  readonly next: () => void;
}

/** A page of the guide; made when the guide opens, disposed when it closes. */
export interface GuidePage extends IDisposable {
  /** The page's content (the guide places it, and adds the buttons). */
  readonly element: HTMLElement;
  /** Its name in the steps above, short. */
  readonly title: string;
  /** Whether Skip and Exit are offered: false while the window would be left empty (no extension yet). */
  readonly canSkip: boolean;
  /** Whether Next is enabled; undefined hides it (the page's own choices move on). */
  readonly canGoOn: boolean | undefined;
  /**
   * Next was pressed: saves what the page set. False keeps the guide on the page (it said
   * why, or the window is reloading). The last page's Next is Finish.
   */
  goOn(): Promise<boolean>;
  /** The page is shown (the first time, or again by Back): reads what may have changed meanwhile. */
  show(): void;
  focus(): void;
}

/** Makes a page; the guide makes them all, in order, when it opens. */
export type GuidePageFactory = (context: GuideContext) => GuidePage;
