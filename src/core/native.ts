/**
 * The renderer's access to main: typed calls (MainApiForRenderer) through the preload
 * bridge, and events (MainEventsForRenderer) that the preload forwards as window messages.
 */

import type { ParamsOf, ResultOf } from '../platform/ipc';
import { toDisposable, type IDisposable } from '../platform/lifecycle';
import {
  IpcChannel,
  type MainApiForRenderer,
  type MainEventMessage,
  type MainEventsForRenderer,
} from '../platform/protocol';

interface PreloadBridge {
  invoke(method: string, params: unknown): Promise<unknown>;
  readonly platform: string;
  pathForFile(file: File): string;
}

declare global {
  interface Window {
    readonly vilausNative: PreloadBridge;
  }
}

function isFromPreload(event: MessageEvent): boolean {
  return event.source === window && event.origin === window.location.origin;
}

export class NativeApi {
  call<M extends keyof MainApiForRenderer>(
    method: M,
    params: ParamsOf<MainApiForRenderer, M>,
  ): Promise<ResultOf<MainApiForRenderer, M>> {
    return window.vilausNative.invoke(method, params) as Promise<ResultOf<MainApiForRenderer, M>>;
  }

  get platform(): string {
    return window.vilausNative.platform;
  }

  /** The disk path of a dropped file, or '' when it has none. */
  pathForFile(file: File): string {
    return window.vilausNative.pathForFile(file);
  }

  on<K extends keyof MainEventsForRenderer>(name: K, listener: (payload: MainEventsForRenderer[K]) => void): IDisposable {
    const handler = (event: MessageEvent): void => {
      const data = event.data as Partial<MainEventMessage> | null;
      if (isFromPreload(event) && data?.type === IpcChannel.Event && data.name === name) {
        listener(data.payload as MainEventsForRenderer[K]);
      }
    };
    window.addEventListener('message', handler);
    return toDisposable(() => window.removeEventListener('message', handler));
  }

  /** Main sends a fresh extension host port at startup and after every restart. */
  onExtensionHostPort(listener: (port: MessagePort) => void): IDisposable {
    const handler = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown } | null;
      const port = event.ports[0];
      if (isFromPreload(event) && data?.type === IpcChannel.ExtHostPort && port) {
        listener(port);
      }
    };
    window.addEventListener('message', handler);
    return toDisposable(() => window.removeEventListener('message', handler));
  }
}

export const native = new NativeApi();
