/**
 * Sends a message in a conversation's page as the user does: the text goes into the input, then
 * Enter (the local API's `conversations.send`; the bridge asks with a `submitPrompt` control).
 * Where the input is comes from the page hints. Text already in the input is the user's: it is
 * not replaced, and nothing is sent, unless it is the very text to send.
 */

import type { PromptSubmitHints, PromptSubmitOutcome } from '../../platform/protocol';

/** A page that just opened (a session still loading) may take this long to show its input. */
const INPUT_TIMEOUT_MS = 20_000;
/** The page empties its input once it has taken the message. */
const SEND_TIMEOUT_MS = 3000;
const POLL_MS = 100;

export async function submitPrompt(hints: PromptSubmitHints, text: string): Promise<PromptSubmitOutcome> {
  const input = await poll(() => document.querySelector<HTMLElement>(hints.input) ?? undefined, INPUT_TIMEOUT_MS);
  if (!input) {
    return 'noInput';
  }
  const wanted = normalize(text);
  const current = normalize(input.innerText);
  if (current !== '' && current !== wanted) {
    return 'notEmpty';
  }
  input.focus();
  if (current === '') {
    // As typing does: the page's editor takes it like any other input.
    document.execCommand('selectAll');
    document.execCommand('insertText', false, text);
    if (normalize(input.innerText) !== wanted) {
      return 'notSent';
    }
  }
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }),
  );
  const taken = await poll(() => !input.isConnected || normalize(input.innerText) === '' || undefined, SEND_TIMEOUT_MS);
  return taken ? 'sent' : 'notSent';
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `probe` until it gives something, or `undefined` after `timeout` ms. Timers, not frames: the page may be hidden. */
function poll<T>(probe: () => T | undefined, timeout: number): Promise<T | undefined> {
  const deadline = Date.now() + timeout;
  return new Promise((resolve) => {
    const check = (): void => {
      const value = probe();
      if (value !== undefined || Date.now() >= deadline) {
        resolve(value);
      } else {
        setTimeout(check, POLL_MS);
      }
    };
    check();
  });
}
