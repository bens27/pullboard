/**
 * scripts/install-herdr-mod.sh copies the tracked Pullboard panel files into a Herdr app home, backs an
 * old copy up outside mods/, and writes nothing on --dry-run [B26]. Every run installs into its own
 * temporary app home, and HOME points there too, so a missing override never reaches a real one.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts/install-herdr-mod.sh');
const SOURCE = join(ROOT, 'integrations/herdr-app/mods/pullboard');
const SHIPPED = [
  'integrations/herdr-app/mods/pullboard/README.md',
  'integrations/herdr-app/mods/pullboard/cli.js',
  'integrations/herdr-app/mods/pullboard/main.js',
  'integrations/herdr-app/mods/pullboard/mod.json',
  'integrations/herdr-app/mods/pullboard/needs-model.js',
  'integrations/herdr-app/mods/pullboard/needs-view.js',
  'integrations/herdr-app/mods/pullboard/read-model.js',
].map((path) => path.split('/').pop());

/** A private app home under a temporary root, and a runner for the script against it. */
function home(t) {
  const root = mkdtempSync(join(tmpdir(), 'herdr-panel-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'app');
  mkdirSync(app);
  const run = (...args) => {
    const result = spawnSync('/bin/sh', [SCRIPT, ...args], { env: { PATH: process.env.PATH, HOME: root, HERDR_APP_HOME: app }, encoding: 'utf8' });
    return { status: result.status, out: result.stdout, err: result.stderr };
  };
  return { root, app, installed: join(app, 'mods', 'pullboard'), run };
}

test('a fresh app home gets every tracked panel file and no backup [B26]', (t) => {
  const { app, installed, run } = home(t);
  const result = run();
  assert.equal(result.status, 0, result.err);
  assert.deepEqual(readdirSync(installed).sort(), [...SHIPPED].sort());
  for (const file of SHIPPED) assert.equal(readFileSync(join(installed, file), 'utf8'), readFileSync(join(SOURCE, file), 'utf8'), file);
  assert.deepEqual(readdirSync(join(app, 'mods')), ['pullboard']);
  assert.equal(existsSync(join(app, 'mod-backups')), false);
  for (const file of SHIPPED) assert.match(result.out, new RegExp(`^added ${file.replace('.', '\\.')}$`, 'm'));
});

test('an untracked file in the panel folder is never installed [B26]', (t) => {
  const { installed, run } = home(t);
  const scratch = join(SOURCE, 'scratch-untracked.js');
  writeFileSync(scratch, 'scratch\n');
  t.after(() => rmSync(scratch, { force: true }));
  assert.equal(run().status, 0);
  assert.equal(existsSync(join(installed, 'scratch-untracked.js')), false);
});

test('an old copy is backed up outside mods/, updated, and keeps its own files [B26]', (t) => {
  const { app, installed, run } = home(t);
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'main.js'), 'stale main\n');
  writeFileSync(join(installed, 'mod.json'), readFileSync(join(SOURCE, 'mod.json')));
  writeFileSync(join(installed, 'jsconfig.json'), '{}\n');
  const result = run();
  assert.equal(result.status, 0, result.err);
  assert.equal(readFileSync(join(installed, 'main.js'), 'utf8'), readFileSync(join(SOURCE, 'main.js'), 'utf8'));
  assert.equal(readFileSync(join(installed, 'jsconfig.json'), 'utf8'), '{}\n');
  assert.deepEqual(readdirSync(join(app, 'mods')), ['pullboard']);
  const backups = readdirSync(join(app, 'mod-backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^pullboard-\d{8}-\d{6}/);
  assert.equal(readFileSync(join(app, 'mod-backups', backups[0], 'main.js'), 'utf8'), 'stale main\n');
  assert.match(result.out, /^updated main\.js$/m);
  assert.doesNotMatch(result.out, /mod\.json/);
});

test('a second install with nothing changed reports nothing changed [B26]', (t) => {
  const { run } = home(t);
  assert.equal(run().status, 0);
  const result = run();
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /^no files changed$/m);
});

test('--dry-run reports the changes and writes nothing [B26]', (t) => {
  const { app, installed, run } = home(t);
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'main.js'), 'stale main\n');
  const result = run('--dry-run');
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /^updated main\.js$/m);
  assert.match(result.out, /^added mod\.json$/m);
  assert.deepEqual(readdirSync(installed), ['main.js']);
  assert.equal(readFileSync(join(installed, 'main.js'), 'utf8'), 'stale main\n');
  assert.equal(existsSync(join(app, 'mod-backups')), false);
});

test('a missing app home or an unknown argument is refused [B26]', (t) => {
  const { root, installed, run } = home(t);
  assert.equal(run('--force').status, 2);
  assert.equal(existsSync(installed), false);
  rmSync(join(root, 'app'), { recursive: true });
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.err, /no Herdr app home/);
  assert.equal(existsSync(join(root, 'app')), false);
});
