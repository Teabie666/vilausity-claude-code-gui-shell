/**
 * The local API's settings (main serves it: host/main/localApi.ts), a block above them that
 * says whether it runs and where its key is, and the shell's own operations of it in the page:
 * the commands, as the command palette runs them.
 */

import type { ShellModule } from '../../core/module';
import { ICommands, ILocalApi, INative, ISettings } from '../../core/serviceIds';
import {
  API_ALLOW_SEND_SETTING,
  API_DOCS_URL,
  API_ENABLED_SETTING,
  API_PORT_SETTING,
  ApiError,
  badRequest,
  requiredString,
  type ApiStatusDto,
} from '../../platform/localApi';
import { Emitter } from '../../platform/event';
import { t } from './messages';

const WINDOW_PARAM = 'number, optional: a window id from windows.list; the active window by default';

export const localApiModule: ShellModule = {
  id: 'localApi',
  activate({ services, subscriptions, logger }) {
    const native = services.get(INative);
    const commands = services.get(ICommands);
    const api = services.get(ILocalApi);
    const section = t('section');

    subscriptions.add(
      services.get(ISettings).register([
        {
          key: API_ENABLED_SETTING,
          section,
          order: 1,
          showDescription: true,
          schema: { type: 'boolean', default: false, description: t('enabledSetting') },
        },
        {
          key: API_ALLOW_SEND_SETTING,
          section,
          order: 2,
          showDescription: true,
          schema: { type: 'boolean', default: false, description: t('allowSendSetting') },
        },
        {
          key: API_PORT_SETTING,
          section,
          order: 3,
          showDescription: true,
          schema: { type: 'integer', default: 0, minimum: 0, maximum: 65535, description: t('portSetting') },
        },
      ]),
    );

    let status: ApiStatusDto | undefined;
    const changed = subscriptions.add(new Emitter<void>());
    const show = (next: ApiStatusDto): void => {
      status = next;
      changed.fire();
    };
    subscriptions.add(native.on('apiStatus', show));
    native.call('api.status', undefined).then(show, (error: unknown) => logger.error('reading the local API status failed', error));

    subscriptions.add(
      services.get(ISettings).registerWidget({
        id: 'localApi.status',
        section,
        keywords: t('keywords'),
        create: (container) => {
          const doc = container.ownerDocument;
          container.classList.add('local-api');
          const state = doc.createElement('div');
          state.className = 'local-api-state';
          state.setAttribute('role', 'status');
          const file = doc.createElement('div');
          file.className = 'local-api-file';
          const reveal = doc.createElement('button');
          reveal.className = 'button secondary';
          reveal.textContent = t('showKeyFile');
          reveal.addEventListener('click', () => {
            if (status) {
              void native.call('os.revealPath', { path: status.file });
            }
          });
          const docs = doc.createElement('button');
          docs.className = 'button secondary';
          docs.textContent = t('docs');
          docs.title = API_DOCS_URL;
          docs.addEventListener('click', () => void native.call('os.openExternal', { url: API_DOCS_URL }));
          const row = doc.createElement('div');
          row.className = 'local-api-row';
          row.append(reveal, docs);
          container.append(state, file, row);

          const render = (): void => {
            const url = status?.url;
            state.textContent =
              url !== undefined
                ? t(status?.elevated ? 'runningReadOnly' : 'running', url)
                : status?.error !== undefined
                  ? t('failed', status.error)
                  : t('off');
            file.textContent = status ? t('keyFile', status.file) : '';
            reveal.disabled = url === undefined;
          };
          render();
          return changed.event(render);
        },
      }),
    );

    subscriptions.add(
      api.register({
        name: 'commands.list',
        access: 'read',
        description: "The shell's commands that have a title (as the command palette and the keyboard shortcuts list them).",
        params: { window: WINDOW_PARAM },
        handle: () =>
          commands.all
            .filter((info) => info.title !== undefined)
            .map(({ id, title, category }) => ({ id, title, category, enabled: commands.isEnabled(id) })),
      }),
    );
    subscriptions.add(
      api.register({
        name: 'commands.run',
        access: 'write',
        description: "Runs one of the shell's commands (commands.list lists them) in a window.",
        params: { command: 'string: the command id', args: 'array, optional: its arguments', window: WINDOW_PARAM },
        handle: async (params) => {
          const id = requiredString(params, 'command');
          if (commands.info(id)?.title === undefined) {
            throw new ApiError(404, 'unknown_command', `no command ${id}; commands.list lists them`);
          }
          if (!commands.isEnabled(id)) {
            throw new ApiError(409, 'disabled', `${id} cannot run now`);
          }
          const args = params.args ?? [];
          if (!Array.isArray(args)) {
            throw badRequest('args must be an array');
          }
          await commands.execute(id, ...(args as unknown[]));
          return { command: id };
        },
      }),
    );
  },
};
