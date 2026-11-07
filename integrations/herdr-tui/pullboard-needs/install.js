#!/usr/bin/env node
/**
 * Installs the pullboard.needs plugin into a Herdr config folder: copies the plugin, registers it in
 * plugins.json and binds its open action in config.toml [B26]. Every file it will change or replace
 * is copied to a timestamped backup folder first, and the new config.toml must pass
 * `herdr config check` before anything is written.
 * Usage: install.sh [--root <board dir>] [--key <binding>] [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const PLUGIN_ID = 'pullboard.needs';
export const DEFAULT_KEY = 'prefix+y';
export const FILES = ['herdr-plugin.toml', 'open.sh', 'panel.js', 'needs.js', 'view.js', 'fixture.json', 'README.md'];
const BEGIN = `# >>> ${PLUGIN_ID} keys (managed by integrations/herdr-tui/pullboard-needs/install.sh)`;
const END = `# <<< ${PLUGIN_ID} keys`;

/**
 * The plugins.json entry Herdr reads for a local plugin, mirroring herdr-plugin.toml.
 *
 * @param {string} pluginRoot
 * @returns {any}
 */
export function pluginEntry(pluginRoot) {
  return {
    plugin_id: PLUGIN_ID,
    name: 'Pullboard: needs you',
    version: '0.1.0',
    min_herdr_version: '0.9.0',
    description: 'What needs you on the Pullboard board, with each step run in order in a new tab',
    manifest_path: join(pluginRoot, 'herdr-plugin.toml'),
    plugin_root: pluginRoot,
    enabled: true,
    platforms: ['linux', 'macos'],
    actions: [{ id: 'open', title: 'Pullboard: needs you', contexts: ['workspace'], command: ['sh', 'open.sh'] }],
    panes: [{ id: 'needs', title: 'Needs you', placement: 'popup', width: '80%', height: '80%', command: ['node', 'panel.js'] }],
    source: { kind: 'local' },
  };
}

/**
 * plugins.json with this plugin's entry replaced or appended; other plugins keep their place.
 *
 * @param {string | null} current
 * @param {any} entry
 * @returns {string}
 */
export function planPlugins(current, entry) {
  const list = current === null || !current.trim() ? [] : JSON.parse(current);
  if (!Array.isArray(list)) throw new Error('plugins.json is not a list; not changing it');
  const index = list.findIndex((plugin) => plugin?.plugin_id === entry.plugin_id);
  const next = index < 0 ? [...list, entry] : list.map((plugin, at) => (at === index ? entry : plugin));
  return JSON.stringify(next, null, 2);
}

const normalize = (key) => key.toLowerCase().replaceAll(' ', '');
// A TOML value as a basic "..." or a literal '...' string; either can bind a key.
const VALUE = String.raw`\s*=\s*(?:"([^"]*)"|'([^']*)')`;
const OWN = new RegExp(String.raw`^\s*(\w+)${VALUE}`, 'u');
const BOUND = new RegExp(String.raw`^\s*key${VALUE}`, 'u');

function withoutBlock(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(END, start);
  if (end < 0) throw new Error(`config.toml has "${BEGIN}" without its end line; fix it by hand`);
  return (text.slice(0, start).replace(/\n+$/u, '\n') + text.slice(end + END.length).replace(/^\n+/u, '\n')).replace(/^\n$/u, '');
}

/**
 * Bindings already taken: Herdr's built-in actions (from `herdr --default-config`) unless the
 * config rebinds that action, and every binding the config itself sets.
 *
 * @param {string} config
 * @param {string} defaults
 * @returns {Set<string>}
 */
export function takenKeys(config, defaults) {
  const named = new Map();
  let inKeys = false;
  for (const line of defaults.split('\n')) {
    if (/^\s*\[/u.test(line)) inKeys = /^\s*\[keys\]\s*$/u.test(line);
    const match = inKeys && line.match(/^#\s*(\w+)\s*=\s*"([^"]*)"/u);
    if (match) named.set(match[1], match[2]);
  }
  const taken = new Set();
  inKeys = false;
  for (const line of config.split('\n')) {
    if (/^\s*\[/u.test(line)) inKeys = /^\s*\[keys\]\s*$/u.test(line);
    const own = inKeys && line.match(OWN);
    if (own) named.set(own[1], own[2] ?? own[3]);
    const bound = line.match(BOUND);
    if (bound) taken.add(normalize(bound[1] ?? bound[2]));
  }
  for (const value of named.values()) if (value) taken.add(normalize(value));
  return taken;
}

/**
 * config.toml with this plugin's managed binding block in place of any earlier one, appended at
 * the end where a new [[keys.command]] table is always valid TOML.
 *
 * @param {string} current
 * @param {string} key
 * @param {string} defaults
 * @returns {string}
 */
export function planKeys(current, key, defaults = '') {
  if (!/^[\w+.-]+$/u.test(key)) throw new Error(`not a Herdr key binding: ${key}`);
  const rest = withoutBlock(current);
  if (takenKeys(rest, defaults).has(normalize(key))) throw new Error(`${key} is already bound; choose another with --key`);
  const block = [BEGIN, '[[keys.command]]', `key = "${key}"`, 'type = "plugin_action"', `command = "${PLUGIN_ID}.open"`, 'description = "Pullboard: needs you"', END].join('\n');
  return (rest ? rest.replace(/\n*$/u, '\n\n') : '') + block + '\n';
}

function boardRoot(cwd) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return dirname(common);
  } catch {
    return cwd; // Outside git the folder the person ran it from is the best guess; --root overrides.
  }
}

function herdr(args, env) {
  return execFileSync(process.env.HERDR_BIN_PATH || 'herdr', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
}

function parseArgs(argv) {
  const options = { key: DEFAULT_KEY, root: '', dryRun: false };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === '--dry-run') options.dryRun = true;
    else if ((arg === '--key' || arg === '--root') && argv[at + 1]) { options[arg.slice(2)] = argv[at + 1]; at += 1; }
    else throw new Error('usage: install.sh [--root <board dir>] [--key <binding>] [--dry-run]');
  }
  return options;
}

// Scratch names are fresh and created exclusively, so a file the person already keeps beside
// config.toml or plugins.json is never overwritten or removed.
function scratch(path) {
  return `${path}.pullboard-needs-${randomUUID()}`;
}

function write(path, text) {
  const temp = scratch(path);
  writeFileSync(temp, text, { flag: 'wx' });
  renameSync(temp, path);
}

function stamp(date) {
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Run the install and return the lines it prints.
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function install(argv, env) {
  const options = parseArgs(argv);
  const config = env.HERDR_CONFIG_DIR || join(env.HOME || homedir(), '.config', 'herdr');
  // A missing folder means Herdr never ran here or HOME is wrong; creating it would hide that.
  if (!existsSync(config) || !statSync(config).isDirectory()) throw new Error(`no Herdr config folder at ${config}; set HERDR_CONFIG_DIR`);
  const root = resolve(options.root || boardRoot(process.cwd()));
  if (!existsSync(root)) throw new Error(`no board folder at ${root}`);
  const source = import.meta.dirname;
  const dest = join(config, 'plugins', 'local', PLUGIN_ID);
  const pluginsPath = join(config, 'plugins.json');
  const tomlPath = join(config, 'config.toml');
  const plugins = planPlugins(existsSync(pluginsPath) ? readFileSync(pluginsPath, 'utf8') : null, pluginEntry(dest));
  let defaults = '';
  try { defaults = herdr(['--default-config'], env); }
  catch { defaults = ''; } // Without herdr only the config's own bindings are checked for a clash.
  const toml = planKeys(existsSync(tomlPath) ? readFileSync(tomlPath, 'utf8') : '', options.key, defaults);
  const lines = [`board ${root}`, `plugin ${dest}`, `key ${options.key} -> ${PLUGIN_ID}.open`];
  if (options.dryRun) return [...lines, 'dry run: nothing written'];

  const candidate = scratch(tomlPath);
  writeFileSync(candidate, toml, { flag: 'wx' });
  try { herdr(['config', 'check'], { ...env, HERDR_CONFIG_PATH: candidate }); }
  catch (error) {
    rmSync(candidate, { force: true });
    // An unchecked config.toml could stop Herdr from starting, so no herdr means no install.
    if (error.code === 'ENOENT') throw new Error(`herdr could not be run to check the new config.toml; nothing written (${error.message}); install Herdr or set HERDR_BIN_PATH`);
    throw new Error(`herdr config check refused the new config.toml; nothing written\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
  rmSync(candidate, { force: true });

  let backup = join(config, 'backups', `pullboard-needs-${stamp(new Date())}`);
  if (existsSync(backup)) backup = `${backup}-${process.pid}`;
  mkdirSync(backup, { recursive: true });
  for (const [path, name] of [[pluginsPath, 'plugins.json'], [tomlPath, 'config.toml'], [dest, PLUGIN_ID]]) {
    if (existsSync(path)) cpSync(path, join(backup, name), { recursive: true, preserveTimestamps: true });
  }
  lines.push(`backup ${backup}`);

  mkdirSync(dirname(dest), { recursive: true });
  const staging = mkdtempSync(`${dest}.pullboard-needs-`);
  for (const file of FILES) cpSync(join(source, file), join(staging, file));
  writeFileSync(join(staging, 'config.json'), JSON.stringify({ root }, null, 2) + '\n');
  rmSync(dest, { recursive: true, force: true });
  renameSync(staging, dest);
  write(pluginsPath, plugins + '\n');
  write(tomlPath, toml);
  return [...lines, 'installed; run `herdr server reload-config` (or restart Herdr) to load it'];
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try { for (const line of install(process.argv.slice(2), process.env)) console.log(line); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
