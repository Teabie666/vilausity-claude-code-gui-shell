/**
 * Keeps what the user clicked where it is on screen while the page changes around it. In a
 * conversation, a thinking block's summary opens or closes every thinking block at once (one
 * state for all of them), so the blocks above it grow or shrink, the browser's scroll anchoring
 * picks some other element to keep still, and the page may scroll to its new bottom: the
 * clicked block ends up elsewhere. For a moment after the click, each change moves the scroll
 * position by however much the clicked element moved, before the change is painted. The user's
 * own scrolling (wheel, keys, the scrollbar) ends it.
 */

/** How long after the click changes are made up for (ms): the page renders the blocks in a few frames. */
const KEEP_MS = 1500;
/** What the user does to scroll; any of them ends the keeping. */
const USER_SCROLLING = ['wheel', 'keydown', 'touchstart', 'pointerdown'] as const;

/** Keeps the elements `selector` matches in place when clicked. */
export function installScrollKeeper(selector: string): void {
  window.addEventListener(
    'click',
    (event) => {
      const target = event.isTrusted && event.target instanceof Element ? event.target.closest(selector) : null;
      if (target) {
        keepInPlace(target);
      }
    },
    true,
  );
}

function keepInPlace(element: Element): void {
  const scroller = scrollerOf(element);
  if (!scroller) {
    return;
  }
  const top = element.getBoundingClientRect().top;
  const end = performance.now() + KEEP_MS;
  let frame = 0;
  const restore = (): void => {
    if (!element.isConnected) {
      stop();
      return;
    }
    const moved = element.getBoundingClientRect().top - top;
    if (Math.abs(moved) >= 0.5) {
      scroller.scrollTop += moved;
    }
  };
  // After layout and before paint, after the page's own observers (created before this one):
  // a change is made up for in the frame that shows it.
  const observer = new ResizeObserver(restore);
  for (const child of scroller.children) {
    observer.observe(child);
  }
  const tick = (): void => {
    restore();
    if (performance.now() < end) {
      frame = requestAnimationFrame(tick);
    } else {
      stop();
    }
  };
  frame = requestAnimationFrame(tick);
  function stop(): void {
    observer.disconnect();
    cancelAnimationFrame(frame);
    for (const type of USER_SCROLLING) {
      window.removeEventListener(type, stop, true);
    }
  }
  for (const type of USER_SCROLLING) {
    window.addEventListener(type, stop, { capture: true, passive: true });
  }
}

/** The nearest ancestor that scrolls vertically. */
export function scrollerOf(element: Element): HTMLElement | undefined {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return undefined;
}
