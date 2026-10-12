/**
 * Preload for the shell window (sandboxed, context-isolated). It exposes exactly one
 * function to the page, `invoke` for MainApiForRenderer, and forwards two kinds of
 * main-to-page traffic with window.postMessage: the extension host's MessagePort (ports
 * cannot cross the context bridge) and MainEventsForRenderer events.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IpcChannel } from '../../platform/protocol';

ipcRenderer.on(IpcChannel.ExtHostPort, (event) => {
  window.postMessage({ type: IpcChannel.ExtHostPort }, window.location.origin, [...event.ports]);
});

ipcRenderer.on(IpcChannel.Event, (_event, name: unknown, payload: unknown) => {
  window.postMessage({ type: IpcChannel.Event, name, payload }, window.location.origin);
});

contextBridge.exposeInMainWorld('vilausNative', {
  invoke: (method: string, params: unknown): Promise<unknown> => ipcRenderer.invoke(IpcChannel.Rpc, method, params),
  platform: process.platform,
  /** The disk path of a file dropped onto the window ('' for non-file items). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
});
