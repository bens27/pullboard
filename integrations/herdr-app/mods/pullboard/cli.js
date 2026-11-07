/**
 * Runs the board reads and the slot moves for the Herdr Pullboard panel through Herdr's `exec`, which
 * runs `pullboard` with the person's own PATH and environment in the board's folder [B26].
 */
import { parseJson } from './read-model.js';

/** The read-only board reads, each with --json, keyed by the name the read model takes. */
export const READS = {
  health: ['health', '--json'],
  status: ['status', '--json'],
  list: ['list', '--json'],
  resources: ['resources', '--json'],
  settings: ['settings', '--json'],
};

/**
 * Run one `pullboard` command in the board's folder; a launch failure, such as `pullboard` missing
 * from PATH, comes back as a failed result rather than a throw.
 *
 * @param {(cmd: string, args: string[], options: { cwd: string }) => Promise<{ code: number, stdout: string, stderr: string }>} exec
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function pullboard(exec, cwd, args) {
  try { return await exec('pullboard', args, { cwd }); }
  catch (error) { return { code: -1, stdout: '', stderr: String(error?.message ?? error) }; }
}

/**
 * Read every part of the board at once; a part that fails is left out and named in `errors`.
 *
 * @param {Function} exec
 * @param {string} cwd
 * @returns {Promise<Record<string, any> & { errors: string[] }>}
 */
export async function readBoard(exec, cwd) {
  const names = Object.keys(READS);
  const results = await Promise.all(names.map((name) => pullboard(exec, cwd, READS[name])));
  const board = { errors: [] };
  names.forEach((name, i) => {
    const parsed = parseJson(name, results[i]);
    if ('error' in parsed) board.errors.push(parsed.error);
    else board[name] = parsed.value;
  });
  return board;
}

/**
 * Run one `pullboard settings` move and return the board's own answer or refusal line.
 *
 * @param {Function} exec
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function runMove(exec, cwd, args) {
  const result = await pullboard(exec, cwd, args);
  const text = (result.code === 0 ? result.stdout : result.stderr || result.stdout).trim().split('\n').find(Boolean) ?? '';
  return { ok: result.code === 0, message: text.slice(0, 200) };
}
