/** Shell commands: what keybindings, menus and the command palette invoke. */

import { Emitter, type Event } from '../platform/event';
import type { IDisposable } from '../platform/lifecycle';
import type { ILogger } from '../platform/log';
import type { ContextKeyService } from './contextKeys';

export type CommandHandler = (...args: unknown[]) => unknown;

export interface CommandOptions {
  /** Shown in the command palette. Commands without a title are hidden from it. */
  readonly title?: string;
  readonly category?: string;
  /** The command is only enabled (palette, keybindings) while this clause holds. */
  readonly when?: string;
  /** False: titled for the keyboard shortcuts only, not listed in the palette. */
  readonly palette?: boolean;
}

export interface CommandInfo extends CommandOptions {
  readonly id: string;
}

export class CommandService {
  private readonly commands = new Map<string, { handler: CommandHandler; info: CommandInfo }>();
  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange: Event<void> = this.changeEmitter.event;

  constructor(
    private readonly contextKeys: ContextKeyService,
    private readonly logger: ILogger,
  ) {}

  register(id: string, handler: CommandHandler, options: CommandOptions = {}): IDisposable {
    if (this.commands.has(id)) {
      throw new Error(`command ${id} registered twice`);
    }
    const entry = { handler, info: { id, ...options } };
    this.commands.set(id, entry);
    this.changeEmitter.fire();
    return {
      dispose: () => {
        if (this.commands.get(id) === entry) {
          this.commands.delete(id);
          this.changeEmitter.fire();
        }
      },
    };
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  /** How the command was registered (its title and category), enabled or not. */
  info(id: string): CommandInfo | undefined {
    return this.commands.get(id)?.info;
  }

  /** Every registered command. */
  get all(): CommandInfo[] {
    return [...this.commands.values()].map((entry) => entry.info);
  }

  isEnabled(id: string): boolean {
    const entry = this.commands.get(id);
    return entry !== undefined && this.contextKeys.evaluate(entry.info.when);
  }

  async execute(id: string, ...args: unknown[]): Promise<unknown> {
    const entry = this.commands.get(id);
    if (!entry) {
      throw new Error(`unknown command ${id}`);
    }
    try {
      return await entry.handler(...args);
    } catch (error) {
      this.logger.error(`command ${id} failed`, error);
      throw error;
    }
  }

  /** Commands for the palette: titled and currently enabled. */
  list(): CommandInfo[] {
    return [...this.commands.values()]
      .map((entry) => entry.info)
      .filter((info) => info.title !== undefined && info.palette !== false && this.contextKeys.evaluate(info.when));
  }
}
