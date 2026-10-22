/**
 * The local API in the renderer: modules offer operations to programs on this computer and
 * send events to its stream (platform/localApi.ts). Main serves them over HTTP; a call that names
 * this window (or one that names none, while this window is the active one) arrives here as
 * `apiRequest`, and the answer goes back with `api.respond`.
 */

import { ApiError, type ApiOperationInfo, type ApiParams } from '../platform/localApi';
import type { IDisposable } from '../platform/lifecycle';
import type { ILogger } from '../platform/log';
import type { ApiErrorDto } from '../platform/protocol';
import type { NativeApi } from './native';

export interface LocalApiOperation extends ApiOperationInfo {
  /**
   * Runs the operation: `params` are what the caller sent (check them with `stringParam` and
   * its kin, which answer a bad one with 400). What it returns goes back as JSON; an `ApiError`
   * it throws goes back with its status.
   */
  handle(params: ApiParams): unknown;
}

export class LocalApiService {
  private readonly operations = new Map<string, LocalApiOperation>();
  private reportScheduled = false;

  constructor(
    private readonly native: NativeApi,
    private readonly logger: ILogger,
  ) {
    native.on('apiRequest', ({ id, name, params }) => void this.answer(id, name, params));
  }

  /** Offers an operation; its name is `<module>.<verb>` and must not be taken. */
  register(operation: LocalApiOperation): IDisposable {
    if (this.operations.has(operation.name)) {
      throw new Error(`local API operation ${operation.name} registered twice`);
    }
    this.operations.set(operation.name, operation);
    this.scheduleReport();
    return {
      dispose: () => {
        if (this.operations.get(operation.name) === operation) {
          this.operations.delete(operation.name);
          this.scheduleReport();
        }
      },
    };
  }

  /** Sends an event to the stream (`GET /v1/events`): `{window, data}` under `name` (`<module>.<what>`). */
  emit(name: string, data: unknown): void {
    this.native.call('api.emit', { name, data }).catch((error: unknown) => this.logger.warn(`local API event ${name} failed`, error));
  }

  /** Main is told the whole list once registrations settle. */
  private scheduleReport(): void {
    if (this.reportScheduled) {
      return;
    }
    this.reportScheduled = true;
    queueMicrotask(() => {
      this.reportScheduled = false;
      const operations = [...this.operations.values()].map(({ name, access, description, params }) => ({
        name,
        access,
        description,
        params,
      }));
      this.native
        .call('api.operations', { operations })
        .catch((error: unknown) => this.logger.warn('reporting the local API operations failed', error));
    });
  }

  private async answer(id: number, name: string, params: ApiParams): Promise<void> {
    try {
      const operation = this.operations.get(name);
      if (!operation) {
        throw new ApiError(404, 'unknown_operation', `this window does not offer ${name}`);
      }
      const result: unknown = await operation.handle(params);
      await this.native.call('api.respond', { id, result: result ?? null });
    } catch (error) {
      if (!(error instanceof ApiError)) {
        this.logger.error(`local API operation ${name} failed`, error);
      }
      const failure: ApiErrorDto =
        error instanceof ApiError
          ? { status: error.status, code: error.code, message: error.message }
          : { status: 500, code: 'internal', message: error instanceof Error ? error.message : String(error) };
      await this.native.call('api.respond', { id, error: failure }).catch(() => undefined);
    }
  }
}
