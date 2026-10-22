/**
 * Extension host entry point (an Electron utility process). Waits for `init` from main,
 * which carries the renderer's MessagePort, then hands over to ExtensionHost.
 */

import * as path from 'node:path';
import type { MessagePortMain } from 'electron';
import { setUnexpectedErrorHandler } from '../../platform/event';
import { RpcEndpoint, type MessageTransport } from '../../platform/ipc';
import { toDisposable } from '../../platform/lifecycle';
import { Logger, LogLevel, type LogSink } from '../../platform/log';
import type { ExtHostApiForMain, MainApiForExtHost } from '../../platform/protocol';
import { FileLogSink } from '../node/fileLogSink';
import { ExtensionHost } from './extensionHost';

/** Writes to stderr (captured by main) until init tells us where the log file lives. */
class SwitchableSink implements LogSink {
  target: LogSink = {
    write: (_level, scope, message) => process.stderr.write(`[${scope}] ${message}\n`),
  };

  write(level: LogLevel, scope: string, message: string): void {
    this.target.write(level, scope, message);
  }
}

const sink = new SwitchableSink();
let level = LogLevel.Info;
const logger = new Logger(sink, 'exthost', () => level);
let fileSink: FileLogSink | undefined;

setUnexpectedErrorHandler((error) => logger.error('unexpected error in listener', error));
// The extension's own failures must not take the host down.
process.on('uncaughtException', (error) => logger.error('uncaught exception', error));
process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', reason));

const parentPort = process.parentPort;
const mainTransport: MessageTransport<MessagePortMain> = {
  send: (message) => parentPort.postMessage(message),
  listen: (handler) => {
    const listener = (event: Electron.MessageEvent): void => handler(event.data, event.ports);
    parentPort.on('message', listener);
    return toDisposable(() => parentPort.off('message', listener));
  },
};
const main = new RpcEndpoint<ExtHostApiForMain, MainApiForExtHost, MessagePortMain>(mainTransport, 'exthost<->main', logger.child('rpc'));

let host: ExtensionHost | undefined;

main.handle('init', (init, ports) => {
  level = init.logLevel as LogLevel;
  fileSink = new FileLogSink(path.join(init.paths.logs, 'exthost.log'));
  sink.target = fileSink;
  const port = ports[0];
  if (!port) {
    throw new Error('init arrived without the renderer port');
  }
  logger.info(`extension host up: node ${process.versions.node}, extension at ${init.extensionPath}`);
  host = new ExtensionHost(main, logger);
  host.initialize(init, port);
});

main.handle('settings.didChange', ({ settings, keys }) => host?.settingsChanged(settings, keys));
main.handle('settings.overlay', ({ values }) => host?.settingsOverlayChanged(values));
main.handle('storage.didChange', ({ scope, key, value }) => host?.storageChanged(scope, key, value));
main.handle('conversation.open', (request) => host?.openConversation(request));
main.handle('conversation.send', (request) => host?.sendPrompt(request) ?? { outcome: 'noInput' });
main.handle('documents.show', (params) => host?.showDocument(params) ?? false);
main.handle('uri.handle', ({ uri }) => host?.handleUri(uri));
main.handle('sessions.storeChanged', () => host?.sessionStoreChanged());
main.handle('usage.changed', ({ provider, shellPricing }) => host?.usageChanged(provider, shellPricing));

main.handle('shutdown', async () => {
  logger.info('shutdown requested');
  await host?.shutdown();
  await fileSink?.flush();
  // Let the reply reach main before exiting.
  setTimeout(() => process.exit(0), 50);
});
