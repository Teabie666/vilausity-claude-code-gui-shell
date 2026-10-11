/**
 * The user's API providers (providers.json in the data folder). Main is the only writer,
 * and the only process that ever sees a key: keys are kept encrypted (Electron's
 * safeStorage: DPAPI on Windows, readable by this Windows user only) and decrypted only to
 * work out a window's variables for its extension host. The renderer learns whether a
 * provider has a key, never the key. No Electron here: the cipher is passed in.
 */

import { Emitter, type Event } from '../../platform/event';
import { Disposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import {
  parseProviderConfig,
  SUBSCRIPTION_ID,
  SUBSCRIPTION_PROVIDER,
  withoutLegacyColor,
  type ProviderConfig,
  type ProviderSummary,
} from '../../platform/providers';
import { readJsonFile, writeFileAtomic } from '../node/jsonFile';

export interface SecretCipher {
  /** False when the system offers no encryption: keys are then refused, never stored in clear. */
  available(): boolean;
  encrypt(text: string): string;
  decrypt(data: string): string;
}

interface ProvidersFile {
  readonly version: 1;
  readonly providers: readonly ProviderConfig[];
  /** Provider id -> encrypted key. */
  readonly keys: Readonly<Record<string, string>>;
}

export class ProviderStore extends Disposable {
  private providers: ProviderConfig[];
  private keys: Record<string, string>;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly changeEmitter = this.register(new Emitter<{ readonly ids: readonly string[] }>());
  /** Providers added, edited, removed, or given another key. */
  readonly onDidChange: Event<{ readonly ids: readonly string[] }> = this.changeEmitter.event;

  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
    private readonly logger: ILogger,
  ) {
    super();
    const file = readJsonFile<Partial<ProvidersFile> | undefined>(filePath, undefined);
    const parsed = Array.isArray(file?.providers) ? file.providers.map(parseProviderConfig) : [];
    this.providers = parsed
      .filter(
        (provider, index): provider is ProviderConfig =>
          provider !== undefined &&
          provider.type !== 'subscription' &&
          parsed.findIndex((other) => other?.id === provider.id) === index,
      )
      .map(withoutLegacyColor);
    const keys = file?.keys;
    this.keys =
      typeof keys === 'object' && keys !== null
        ? Object.fromEntries(Object.entries(keys).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {};
  }

  /** The subscription first, then the user's providers in the order they were added. */
  list(): ProviderSummary[] {
    return [SUBSCRIPTION_PROVIDER, ...this.providers].map((provider) => ({
      ...provider,
      hasKey: this.keys[provider.id] !== undefined,
    }));
  }

  get(id: string): ProviderConfig | undefined {
    return id === SUBSCRIPTION_ID ? SUBSCRIPTION_PROVIDER : this.providers.find((provider) => provider.id === id);
  }

  /** The decrypted key, if the provider has one and it can be read. */
  key(id: string): string | undefined {
    const data = this.keys[id];
    if (data === undefined) {
      return undefined;
    }
    try {
      return this.cipher.decrypt(data);
    } catch (error) {
      this.logger.error(`cannot decrypt the key of provider ${id}`, error);
      return undefined;
    }
  }

  /** Adds a provider or replaces the one with its id. */
  async save(value: unknown): Promise<ProviderSummary> {
    const provider = parseProviderConfig(value);
    if (!provider || provider.type === 'subscription' || provider.id === SUBSCRIPTION_ID) {
      throw new Error('not a provider that can be saved');
    }
    const index = this.providers.findIndex((candidate) => candidate.id === provider.id);
    this.providers = index >= 0 ? this.providers.with(index, provider) : [...this.providers, provider];
    await this.write([provider.id]);
    return { ...provider, hasKey: this.keys[provider.id] !== undefined };
  }

  async remove(id: string): Promise<void> {
    if (!this.providers.some((provider) => provider.id === id)) {
      return;
    }
    this.providers = this.providers.filter((provider) => provider.id !== id);
    const { [id]: _removed, ...keys } = this.keys;
    this.keys = keys;
    await this.write([id]);
  }

  /** Stores a provider's key encrypted; `undefined` or '' removes it. */
  async setKey(id: string, key: string | undefined): Promise<void> {
    if (!this.providers.some((provider) => provider.id === id)) {
      throw new Error(`no provider ${id}`);
    }
    if (key) {
      if (!this.cipher.available()) {
        throw new Error('the system offers no encryption for the key');
      }
      this.keys = { ...this.keys, [id]: this.cipher.encrypt(key) };
    } else {
      const { [id]: _removed, ...keys } = this.keys;
      this.keys = keys;
    }
    await this.write([id]);
  }

  private write(ids: readonly string[]): Promise<void> {
    const file: ProvidersFile = { version: 1, providers: this.providers, keys: this.keys };
    const contents = `${JSON.stringify(file, null, 2)}\n`;
    const write = this.writeQueue.then(() => writeFileAtomic(this.filePath, contents));
    // A failed write must not fail the ones queued after it.
    this.writeQueue = write.catch(() => undefined);
    this.changeEmitter.fire({ ids });
    return write.catch((error: unknown) => {
      this.logger.error(`failed to write ${this.filePath}`, error);
      throw error;
    });
  }
}
