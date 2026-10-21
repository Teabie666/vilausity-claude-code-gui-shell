/**
 * Shows the Claude Code extension's own UI text in the display language (M3.5). Text nodes,
 * and the title / placeholder / data-placeholder attributes, whose text the table has are
 * replaced, and kept replaced while React re-renders (MutationObserver). Left alone: the
 * parts of the page that show content (the page hint `untranslated`, from the bridge),
 * anything editable, code, and the shell's own elements. aria-label stays English: nothing
 * shows it, and the shell and tests find elements by it. Turned off, every replaced text goes
 * back to what the page had put there.
 */

import { ExtensionTranslator } from '../../platform/extensionStrings';
import type { ExtensionTranslations } from '../../platform/protocol';

const ATTRIBUTES = ['title', 'placeholder', 'data-placeholder'];
/** Never translated: code, the head, and the shell's own elements. */
const ALWAYS_LEFT_ALONE = 'head, script, style, pre, code, .vilaus-comments, .vilaus-markers';
/** What a person types in; the element's own attributes (its placeholder) still are UI. */
const EDITABLE = 'textarea, [contenteditable]:not([contenteditable="false"])';

interface Replacement {
  readonly original: string;
  readonly shown: string;
}

export class PageTranslator {
  private translator: ExtensionTranslator | undefined;
  private observer: MutationObserver | undefined;
  private readonly texts = new WeakMap<Text, Replacement>();
  private readonly attributes = new WeakMap<Element, Map<string, Replacement>>();
  /** Elements whose text and attributes are left alone, with everything inside them. */
  private readonly leftAlone: string;

  constructor(content: string) {
    this.leftAlone = content.trim() ? `${content}, ${ALWAYS_LEFT_ALONE}` : ALWAYS_LEFT_ALONE;
  }

  /** Translates the page with `table` from now on; undefined puts back what it had. */
  set(table: ExtensionTranslations | undefined): void {
    this.stop();
    if (!table) {
      return;
    }
    this.translator = new ExtensionTranslator(table);
    this.observer = new MutationObserver((records) => this.onMutations(records));
    // From <head> on: the page renders into <body> after this runs.
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRIBUTES,
    });
    this.translateTree(document.documentElement);
  }

  private stop(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    if (!this.translator) {
      return;
    }
    this.translator = undefined;
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node: Node | null = walker.currentNode; node; node = walker.nextNode()) {
      if (node instanceof Text) {
        const replaced = this.texts.get(node);
        if (replaced && node.data === replaced.shown) {
          node.data = replaced.original;
        }
        this.texts.delete(node);
      } else if (node instanceof Element) {
        for (const [name, replaced] of this.attributes.get(node) ?? []) {
          if (node.getAttribute(name) === replaced.shown) {
            node.setAttribute(name, replaced.original);
          }
        }
        this.attributes.delete(node);
      }
    }
  }

  /** An element's text as the page wrote it, before any translation. */
  originalText(element: Element): string {
    let text = '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const replaced = this.texts.get(node as Text);
      const data = (node as Text).data;
      text += replaced?.shown === data ? replaced.original : data;
    }
    return text;
  }

  private onMutations(records: readonly MutationRecord[]): void {
    for (const record of records) {
      const target = record.target;
      if (record.type === 'childList') {
        for (const added of record.addedNodes) {
          const parent = added.parentElement;
          if (parent && !this.isLeftAlone(parent)) {
            this.translateTree(added);
          }
        }
      } else if (record.type === 'characterData') {
        const parent = target.parentElement;
        if (target instanceof Text && parent && !this.isLeftAlone(parent)) {
          this.translateText(target);
        }
      } else if (record.type === 'attributes' && target instanceof Element && record.attributeName) {
        if (!this.attributesLeftAlone(target)) {
          this.translateAttribute(target, record.attributeName);
        }
      }
    }
  }

  /** Whether text in this element stays as it is. */
  private isLeftAlone(element: Element): boolean {
    return element.closest(this.leftAlone) !== null || element.closest(EDITABLE) !== null;
  }

  /** Whether this element's own attributes stay as they are (an input's placeholder does not). */
  private attributesLeftAlone(element: Element): boolean {
    return element.closest(this.leftAlone) !== null || (element.parentElement?.closest(EDITABLE) ?? null) !== null;
  }

  private translateTree(root: Node): void {
    if (root instanceof Text) {
      this.translateText(root);
      return;
    }
    if (!(root instanceof Element) || root.matches(this.leftAlone)) {
      return;
    }
    this.translateAttributes(root);
    if (root.matches(EDITABLE)) {
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (node instanceof Element) {
          if (node.matches(this.leftAlone)) {
            return NodeFilter.FILTER_REJECT;
          }
          this.translateAttributes(node);
          return node.matches(EDITABLE) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        this.translateText(node as Text);
        return NodeFilter.FILTER_SKIP;
      },
    });
    // The filter does the work; nothing is ever accepted.
    walker.nextNode();
  }

  private translateText(node: Text): void {
    const translator = this.translator;
    const current = node.data;
    const replaced = this.texts.get(node);
    if (!translator || replaced?.shown === current) {
      return;
    }
    const shown = translator.translate(current);
    if (shown === undefined) {
      this.texts.delete(node);
      return;
    }
    this.texts.set(node, { original: current, shown });
    node.data = shown;
  }

  private translateAttributes(element: Element): void {
    for (const name of ATTRIBUTES) {
      if (element.hasAttribute(name)) {
        this.translateAttribute(element, name);
      }
    }
  }

  private translateAttribute(element: Element, name: string): void {
    const translator = this.translator;
    const current = element.getAttribute(name);
    if (!translator || current === null) {
      return;
    }
    let replacements = this.attributes.get(element);
    if (replacements?.get(name)?.shown === current) {
      return;
    }
    const shown = translator.translate(current);
    if (shown === undefined) {
      replacements?.delete(name);
      return;
    }
    if (!replacements) {
      replacements = new Map();
      this.attributes.set(element, replacements);
    }
    replacements.set(name, { original: current, shown });
    element.setAttribute(name, shown);
  }
}
