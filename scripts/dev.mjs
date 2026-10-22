// Builds and starts this checkout as an instance of its own, next to the Vilausity in use:
//   npm run dev [-- vilaus args...]
// Its data (settings, state, logs, API keys) is in .test-data\dev, so it neither hands its
// arguments to the Vilausity already running nor touches that one's data. The first start
// copies settings.json and keybindings.json from %APPDATA%\Vilausity; API keys are not copied
// (they are encrypted for the other data folder): add them again in the dev instance.
import { spawnSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(root, '.test-data', 'dev');
const args = process.argv.slice(2);

const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
  const own = path.join(process.env.APPDATA ?? '', 'Vilausity');
  for (const name of ['settings.json', 'keybindings.json']) {
    if (existsSync(path.join(own, name))) {
      copyFileSync(path.join(own, name), path.join(dataDir, name));
      console.log(`copied ${name} from ${own}`);
    }
  }
}

const withData = args.includes('--user-data-dir') ? args : ['--user-data-dir', dataDir, ...args];
const child = spawn(process.execPath, [path.join(root, 'scripts', 'launch.mjs'), ...withData], { cwd: root, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
