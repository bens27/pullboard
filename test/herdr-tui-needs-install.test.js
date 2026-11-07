/**
 * integrations/herdr-tui/pullboard-needs/install.sh copies the needs plugin into a Herdr config
 * folder, registers it in plugins.json, binds its key in a managed config.toml block, and backs up
 * what it changes first [B26]. Every run uses its own temporary HOME and HERDR_CONFIG_DIR, and a
 * fake herdr, so a real Herdr config is never read or written.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = join(ROOT, 'integrations/herdr-tui/pullboard-needs');
const SCRIPT = join(SOURCE, 'install.sh');
const SHIPPED = ['README.md', 'fixture.json', 'herdr-plugin.toml', 'needs.js', 'open.sh', 'panel.js', 'view.js'];
const OTHER = { plugin_id: 'someone.else', plugin_root: '/elsewhere', enabled: true };
const CONFIG = '[ui]\ntheme = "dark"\n\n[keys]\nprefix = "ctrl+b"\n';

// Stands in for herdr: prints a default config naming one built-in binding, and fails
// `config check` for any candidate config.toml that contains the word BAD.
const FAKE_HERDR = `#!/bin/sh
echo "$*" >> "$(dirname "$0")/calls.log"
case "$1" in
  --default-config) printf '[keys]\\n# settings = "prefix+s"\\n' ;;
  config) if grep -q BAD "$HERDR_CONFIG_PATH"; then echo "config: issues found"; exit 1; fi; echo "config: ok" ;;
esac
`;

/** A private HOME and Herdr config folder, and a runner for install.sh against them. */
function home(t, { config = CONFIG, plugins = [OTHER], fake = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'herdr-tui-needs-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cfg = join(root, 'herdr');
  const board = join(root, 'board');
  const bin = join(root, 'bin');
  for (const dir of [cfg, board, bin]) mkdirSync(dir);
  if (fake) writeFileSync(join(bin, 'herdr'), FAKE_HERDR, { mode: 0o755 });
  if (config !== null) writeFileSync(join(cfg, 'config.toml'), config);
  if (plugins !== null) writeFileSync(join(cfg, 'plugins.json'), JSON.stringify(plugins, null, 2));
  const run = (...args) => {
    const env = { PATH: process.env.PATH, HOME: root, HERDR_CONFIG_DIR: cfg, HERDR_BIN_PATH: join(bin, 'herdr') };
    const result = spawnSync('/bin/sh', [SCRIPT, '--root', board, ...args], { cwd: root, env, encoding: 'utf8' });
    return { status: result.status, out: result.stdout, err: result.stderr };
  };
  const calls = () => (existsSync(join(bin, 'calls.log')) ? readFileSync(join(bin, 'calls.log'), 'utf8') : '');
  return { root, cfg, board, installed: join(cfg, 'plugins', 'local', 'pullboard.needs'), run, calls };
}

/** Every file under a folder with its contents, to show a run changed nothing. */
function snapshot(dir) {
  const files = {};
  const walk = (at, rel) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path, `${rel}${name}/`);
      else files[`${rel}${name}`] = readFileSync(path, 'utf8');
    }
  };
  walk(dir, '');
  return files;
}

const blocks = (text) => text.split('# >>> pullboard.needs keys').length - 1;

test('a fresh install copies the plugin, registers it and binds prefix+y [B26]', (t) => {
  const { cfg, board, installed, run, calls } = home(t);
  const result = run();
  assert.equal(result.status, 0, result.err);
  assert.deepEqual(readdirSync(installed).sort(), [...SHIPPED, 'config.json'].sort());
  for (const file of SHIPPED) assert.equal(readFileSync(join(installed, file), 'utf8'), readFileSync(join(SOURCE, file), 'utf8'), file);
  assert.deepEqual(JSON.parse(readFileSync(join(installed, 'config.json'), 'utf8')), { root: board });

  const plugins = JSON.parse(readFileSync(join(cfg, 'plugins.json'), 'utf8'));
  assert.deepEqual(plugins[0], OTHER);
  assert.equal(plugins.length, 2);
  assert.equal(plugins[1].plugin_id, 'pullboard.needs');
  assert.equal(plugins[1].plugin_root, installed);
  assert.equal(plugins[1].manifest_path, join(installed, 'herdr-plugin.toml'));

  const toml = readFileSync(join(cfg, 'config.toml'), 'utf8');
  assert.ok(toml.startsWith(CONFIG), 'the person\'s own config is kept as it was');
  assert.equal(blocks(toml), 1);
  assert.match(toml, /\[\[keys\.command\]\]\nkey = "prefix\+y"\ntype = "plugin_action"\ncommand = "pullboard\.needs\.open"/);
  assert.match(calls(), /^config check$/m);
  assert.deepEqual(readdirSync(cfg).filter((name) => name.includes('pullboard-needs')), [], 'no candidate or temp file is left');
  assert.match(result.out, /^key prefix\+y -> pullboard\.needs\.open$/m);
});

test('the files it changes are backed up first and the backup path is printed [B26]', (t) => {
  const { cfg, installed, run } = home(t);
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'panel.js'), 'stale panel\n');
  const result = run();
  assert.equal(result.status, 0, result.err);
  const backups = readdirSync(join(cfg, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^pullboard-needs-\d{8}-\d{6}/);
  const backup = join(cfg, 'backups', backups[0]);
  assert.match(result.out, new RegExp(`^backup ${backup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.equal(readFileSync(join(backup, 'config.toml'), 'utf8'), CONFIG);
  assert.deepEqual(JSON.parse(readFileSync(join(backup, 'plugins.json'), 'utf8')), [OTHER]);
  assert.equal(readFileSync(join(backup, 'pullboard.needs', 'panel.js'), 'utf8'), 'stale panel\n');
  assert.equal(readFileSync(join(installed, 'panel.js'), 'utf8'), readFileSync(join(SOURCE, 'panel.js'), 'utf8'));
});

test('a config folder with no config.toml or plugins.json gets both [B26]', (t) => {
  const { cfg, run } = home(t, { config: null, plugins: null });
  const result = run();
  assert.equal(result.status, 0, result.err);
  assert.equal(JSON.parse(readFileSync(join(cfg, 'plugins.json'), 'utf8')).length, 1);
  assert.equal(blocks(readFileSync(join(cfg, 'config.toml'), 'utf8')), 1);
});

test('--dry-run prints the plan and writes nothing [B26]', (t) => {
  const { cfg, run, calls } = home(t);
  const before = snapshot(cfg);
  const result = run('--dry-run');
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /^dry run: nothing written$/m);
  assert.deepEqual(snapshot(cfg), before);
  assert.doesNotMatch(calls(), /config check/);
});

test('a key the config or Herdr already binds is refused and nothing is written [B26]', (t) => {
  const own = `${CONFIG}\n[[keys.command]]\nkey = "prefix+y"\ntype = "shell"\ncommand = "echo mine"\n`;
  const { cfg, run } = home(t, { config: own });
  const before = snapshot(cfg);
  const clash = run();
  assert.equal(clash.status, 1);
  assert.match(clash.err, /prefix\+y is already bound; choose another with --key/);
  const builtIn = run('--key', 'prefix+s');
  assert.equal(builtIn.status, 1);
  assert.match(builtIn.err, /prefix\+s is already bound/);
  assert.deepEqual(snapshot(cfg), before);
  const chosen = run('--key', 'prefix+shift+y');
  assert.equal(chosen.status, 0, chosen.err);
  assert.match(readFileSync(join(cfg, 'config.toml'), 'utf8'), /key = "prefix\+shift\+y"\ntype = "plugin_action"/);
});

test('a config.toml that herdr config check refuses is never written [B26]', (t) => {
  const { cfg, installed, run } = home(t, { config: `${CONFIG}# BAD\n` });
  const before = snapshot(cfg);
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.err, /herdr config check refused the new config\.toml; nothing written/);
  assert.deepEqual(snapshot(cfg), before);
  assert.equal(existsSync(installed), false);
});

test('a second run keeps one managed block and one plugins.json entry [B26]', (t) => {
  const { cfg, run } = home(t);
  assert.equal(run().status, 0);
  const toml = readFileSync(join(cfg, 'config.toml'), 'utf8');
  const plugins = readFileSync(join(cfg, 'plugins.json'), 'utf8');
  const again = run();
  assert.equal(again.status, 0, again.err);
  assert.equal(readFileSync(join(cfg, 'config.toml'), 'utf8'), toml);
  assert.equal(readFileSync(join(cfg, 'plugins.json'), 'utf8'), plugins);
  assert.equal(blocks(toml), 1);
  const rekeyed = run('--key', 'prefix+shift+y');
  assert.equal(rekeyed.status, 0, rekeyed.err);
  const moved = readFileSync(join(cfg, 'config.toml'), 'utf8');
  assert.equal(blocks(moved), 1);
  assert.doesNotMatch(moved, /key = "prefix\+y"/);
});

test('a missing config folder or an unknown argument is refused [B26]', (t) => {
  const { root, cfg, installed, run } = home(t);
  const bad = run('--force');
  assert.equal(bad.status, 1);
  assert.match(bad.err, /^usage: install\.sh/m);
  assert.equal(existsSync(installed), false);
  rmSync(cfg, { recursive: true });
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.err, /no Herdr config folder/);
  assert.equal(existsSync(cfg), false);
  assert.deepEqual(readdirSync(root).sort(), ['bin', 'board']);
});

test('without a herdr to run config check, nothing is installed and the reason is printed [B26]', (t) => {
  const { cfg, installed, run } = home(t, { fake: false });
  const before = snapshot(cfg);
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.err, /herdr could not be run to check the new config\.toml; nothing written/);
  assert.deepEqual(snapshot(cfg), before);
  assert.equal(existsSync(installed), false);
});

test('a binding written as a single-quoted TOML string still counts as taken [B26]', (t) => {
  const own = `${CONFIG}detach  =  'prefix+d'  \n\n[[keys.command]]\n  key='prefix+y'\ntype = "shell"\ncommand = "echo mine"\n`;
  const { cfg, run } = home(t, { config: own });
  const before = snapshot(cfg);
  for (const key of ['prefix+y', 'prefix+d']) {
    const clash = run('--key', key);
    assert.equal(clash.status, 1, key);
    assert.match(clash.err, /is already bound; choose another with --key/, key);
  }
  assert.deepEqual(snapshot(cfg), before);
});

test('files or folders already at its scratch names are left as they were [B26]', (t) => {
  const { cfg, installed, run } = home(t);
  const local = join(cfg, 'plugins', 'local');
  mkdirSync(join(`${installed}.installing`), { recursive: true });
  writeFileSync(join(`${installed}.installing`, 'mine.txt'), 'mine\n');
  for (const name of ['config.toml.pullboard-needs-candidate', 'config.toml.pullboard-needs-installing', 'plugins.json.pullboard-needs-installing']) {
    writeFileSync(join(cfg, name), `mine: ${name}\n`);
  }
  const before = { ...snapshot(cfg) };
  const result = run();
  assert.equal(result.status, 0, result.err);
  const after = snapshot(cfg);
  for (const [path, text] of Object.entries(before)) {
    if (path.includes('pullboard-needs-') || path.includes('.installing/')) assert.equal(after[path], text, path);
  }
  assert.deepEqual(readdirSync(local).sort(), ['pullboard.needs', 'pullboard.needs.installing']);
});

test('the key anywhere in config.toml as a quoted string is refused, whatever its table or comment [B26]', (t) => {
  const configs = [
    `${CONFIG}\n[[keys.command]]\n"key" = 'prefix+y'\ntype = "shell"\ncommand = "echo mine"\n`,
    '[keys] # my bindings\nprefix = "ctrl+b"\nsettings = "prefix+y"\n',
  ];
  for (const config of configs) {
    const { cfg, installed, run } = home(t, { config });
    const before = snapshot(cfg);
    const clash = run();
    assert.equal(clash.status, 1, config);
    assert.match(clash.err, /prefix\+y is already bound; choose another with --key/, config);
    assert.deepEqual(snapshot(cfg), before);
    assert.equal(existsSync(installed), false);
  }
});
