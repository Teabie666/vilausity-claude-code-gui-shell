/**
 * Choices a click picks (a question's options) whose text the page's styles make selectable,
 * to be copied into an answer of one's own. Dragging over the text selects it, and the click
 * that ends the drag would pick the choice: that click does not reach the page. One that
 * selected nothing picks it as before, also while text selected earlier is still there.
 */

export function installSelectableChoices(selector: string): void {
  /** Text was selected since the mouse button last went down. */
  let selectedWhilePressed = false;
  window.addEventListener('mousedown', () => (selectedWhilePressed = false), true);
  document.addEventListener('selectionchange', () => {
    if (!(getSelection()?.isCollapsed ?? true)) {
      selectedWhilePressed = true;
    }
  });
  window.addEventListener(
    'click',
    (event) => {
      const choice = event.target instanceof Element ? event.target.closest(selector) : null;
      const selection = getSelection();
      if (
        choice &&
        selectedWhilePressed &&
        selection &&
        !selection.isCollapsed &&
        (choice.contains(selection.anchorNode) || choice.contains(selection.focusNode))
      ) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    true,
  );
}
