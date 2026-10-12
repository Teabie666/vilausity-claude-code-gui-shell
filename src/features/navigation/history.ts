/**
 * The tabs used, in order, for going back and forward like a browser: a tab that becomes
 * active is pushed (dropping what was ahead of the position), going back or forward moves
 * the position without pushing.
 */

export class NavigationHistory<T> {
  private entries: T[] = [];
  private position = -1;

  constructor(
    private readonly same: (a: T, b: T) => boolean,
    private readonly limit = 50,
  ) {}

  get current(): T | undefined {
    return this.entries[this.position];
  }

  /** A tab became active. Its own activation, after going back or forward to it, changes nothing. */
  push(entry: T): void {
    const current = this.current;
    if (current !== undefined && this.same(current, entry)) {
      return;
    }
    this.entries.splice(this.position + 1);
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.shift();
    }
    this.position = this.entries.length - 1;
  }

  /**
   * Moves to the nearest entry back that `usable` accepts (a tab that still exists and is
   * not on screen already) and returns it; undefined, and no move, when there is none.
   */
  back(usable: (entry: T) => boolean): T | undefined {
    return this.go(-1, usable);
  }

  forward(usable: (entry: T) => boolean): T | undefined {
    return this.go(1, usable);
  }

  /** The nearest entry `usable` accepts from the position back, the current one included; no move. */
  previous(usable: (entry: T) => boolean): T | undefined {
    for (let index = this.position; index >= 0; index--) {
      const entry = this.entries[index]!;
      if (usable(entry)) {
        return entry;
      }
    }
    return undefined;
  }

  /** Forgets a closed tab; entries left next to each other that are the same become one. */
  remove(closed: (entry: T) => boolean): void {
    const kept: T[] = [];
    let position = -1;
    this.entries.forEach((entry, index) => {
      if (!closed(entry) && !(kept.length > 0 && this.same(kept[kept.length - 1]!, entry))) {
        kept.push(entry);
      }
      if (index === this.position) {
        position = kept.length - 1;
      }
    });
    this.entries = kept;
    this.position = Math.min(Math.max(position, kept.length > 0 ? 0 : -1), kept.length - 1);
  }

  private go(step: -1 | 1, usable: (entry: T) => boolean): T | undefined {
    for (let index = this.position + step; index >= 0 && index < this.entries.length; index += step) {
      const entry = this.entries[index]!;
      if (usable(entry)) {
        this.position = index;
        return entry;
      }
    }
    return undefined;
  }
}
