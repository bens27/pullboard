#!/usr/bin/env node
/**
 * The "Needs you" popup Herdr opens for the pullboard.needs plugin [B26]. It reads the board with
 * `pullboard needs --json` in the board root, and starts the step, or the batch of selected steps,
 * the person confirms in a new tab of their current workspace. It never writes the board itself: an ask's step is recorded by the
 * tab's script, after the command exits 0, so agents pick it up at their next check.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  batchScript,
  needsMissing,
  parseNeeds,
  rootPane,
  shellQuote,
  stepScript,
  tabCreateArgs,
} from './needs.js';
import { initialState, loaded, press, render } from './view.js';

const run = promisify(execFile);
const HERDR = process.env.HERDR_BIN_PATH || 'herdr';

function configuredRoot() {
  if (process.env.PULLBOARD_NEEDS_ROOT) return process.env.PULLBOARD_NEEDS_ROOT;
  const file = join(import.meta.dirname, 'config.json');
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, 'utf8')).root || process.cwd(); }
    catch { return process.cwd(); } // A damaged config falls back to the popup's folder rather than no panel.
  }
  return process.cwd();
}

async function readBoard(root) {
  const fixture = process.env.PULLBOARD_NEEDS_FIXTURE;
  try {
    const text = fixture ? readFileSync(fixture, 'utf8') : (await run('pullboard', ['needs', '--json'], { cwd: root, maxBuffer: 8 << 20 })).stdout;
    const board = parseNeeds(text);
    return { needs: board.needs, root: board.root || root };
  } catch (error) {
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    if (needsMissing(output)) return { note: 'This pullboard has no `needs` command yet. Update pullboard to list what needs you here.' };
    const first = (output.trim() || String(error.message ?? error)).split('\n')[0];
    return { note: `Could not read what needs you in ${root}: ${first}` };
  }
}

async function workspace() {
  const named = process.env.PULLBOARD_NEEDS_WORKSPACE || process.env.HERDR_WORKSPACE_ID;
  if (named) return named;
  const { stdout } = await run(HERDR, ['api', 'snapshot']);
  return JSON.parse(stdout).result.snapshot.focused_workspace_id ?? '';
}

async function openTab({ name, script, cwd, label }) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-needs-'));
  const file = join(dir, name);
  writeFileSync(file, script(dir), { mode: 0o600 });
  chmodSync(dir, 0o700);
  const created = await run(HERDR, tabCreateArgs({ workspace: await workspace(), cwd, label: label.slice(0, 40) }));
  await run(HERDR, ['pane', 'run', rootPane(created.stdout), `/bin/zsh ${shellQuote(file)}`]);
}

function launch({ need, step, command, root }) {
  const script = (self) => stepScript({ need, step, command, root, self });
  return openTab({ name: 'step.zsh', script, cwd: step.cwd, label: `needs: ${step.label ?? need.title}` });
}

function launchBatch({ items, root }) {
  const script = (self) => batchScript({ items, root, self });
  return openTab({ name: 'batch.zsh', script, cwd: items[0].step.cwd, label: `needs: ${items.length} steps` });
}

const NAMED = { '\r': 'enter', '\n': 'enter', '\x1b': 'escape', '\x7f': 'backspace', '\b': 'backspace', '\x15': 'ctrl+u', '\x03': 'ctrl+c',
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left' };

function keys(chunk) {
  if (NAMED[chunk]) return [NAMED[chunk]];
  if (chunk.startsWith('\x1b')) return [];
  return [...chunk].map((char) => NAMED[char] ?? char).filter((key) => key.length > 1 || key >= ' ');
}

async function main() {
  const root = configuredRoot();
  let state = initialState();
  const draw = () => {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    process.stdout.write('\x1b[H\x1b[2J' + render(state, cols, rows).join('\r\n'));
  };
  const close = (code = 0) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    process.exit(code);
  };
  const refresh = async () => { state = loaded(state, await readBoard(root)); draw(); };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  process.stdout.on('resize', draw);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    for (const key of keys(chunk)) {
      const result = press(state, key);
      state = result.state;
      if (result.effect === 'quit') return close();
      if (result.effect === 'refresh') { state = { ...state, mode: state.mode === 'need' ? 'need' : 'loading' }; draw(); await refresh(); continue; }
      if (result.effect?.run) {
        try { await launch(result.effect.run); return close(); }
        catch (error) { state = { ...state, mode: 'note', note: `Could not open the step's tab: ${String(error.stderr || error.message).split('\n')[0]}` }; }
      }
      if (result.effect?.batch) {
        try { await launchBatch(result.effect.batch); return close(); }
        catch (error) { state = { ...state, mode: 'note', note: `Could not open the batch's tab: ${String(error.stderr || error.message).split('\n')[0]}` }; }
      }
    }
    draw();
  });
  draw();
  await refresh();
}

await main();
