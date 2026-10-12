/**
 * The title bar's logo: the app's mark (platform/logoMark.ts) in the window's logo color,
 * `--vilaus-logo`, which main puts in the theme (platform/accent.ts). It doubles as a status
 * light for the window's conversations: the cursor, the "_" of "v_", blinks while Claude
 * works in any of them, and stays on in amber while one needs the user's input (that wins:
 * the user has something to do).
 */

import { LOGO_CURSOR, LOGO_STROKES, LOGO_VIEW_BOX } from '../../platform/logoMark';
import type { SessionActivity } from '../../platform/protocol';
import { t } from './messages';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface TitleBarLogo {
  readonly element: HTMLElement;
  setActivity(activity: SessionActivity): void;
}

function polygon(points: readonly number[], className?: string): SVGPolygonElement {
  const shape = document.createElementNS(SVG_NS, 'polygon');
  shape.setAttribute('points', points.join(' '));
  if (className) {
    shape.setAttribute('class', className);
  }
  return shape;
}

/** What the logo says on hover (and to screen readers). */
export function logoLabel({ running, waiting }: SessionActivity): string {
  const lines: string[] = [];
  if (waiting > 0) {
    lines.push(waiting === 1 ? t('logoWaiting') : t('logoWaitingIn', waiting));
  }
  if (running > 0) {
    lines.push(running === 1 ? t('logoWorking') : t('logoWorkingIn', running));
  }
  return lines.length > 0 ? lines.join('\n') : 'Vilausity';
}

export function createTitleBarLogo(): TitleBarLogo {
  const element = document.createElement('div');
  element.className = 'titlebar-logo';
  element.setAttribute('role', 'img');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', LOGO_VIEW_BOX.join(' '));
  svg.setAttribute('aria-hidden', 'true');
  svg.append(...LOGO_STROKES.map((points) => polygon(points)), polygon(LOGO_CURSOR, 'titlebar-logo-cursor'));
  element.append(svg);
  const setActivity = (activity: SessionActivity): void => {
    element.dataset.activity = activity.waiting > 0 ? 'waiting' : activity.running > 0 ? 'running' : 'idle';
    const label = logoLabel(activity);
    element.title = label;
    element.setAttribute('aria-label', label);
  };
  setActivity({ running: 0, waiting: 0 });
  return { element, setActivity };
}
