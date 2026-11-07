/**
 * Pure model for the panel's Needs you section [B26]: it reads `pullboard needs --json`, fills a
 * step's `{key}` placeholders from the person's answers, and builds the terminal a step runs in.
 * Nothing here runs a command, so tests import it without Herdr.
 */

/** The Herdr App space every step's tab opens in, so the person's runs collect in one place. */
export const NEEDS_SPACE = 'Needs you';

/**
 * Quote one value for a POSIX shell: single quotes keep everything literal, and a ' inside is
 * closed, escaped and reopened, so a typed answer can never become shell syntax.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function shellQuote(value) {
  return "'" + String(value ?? '').replaceAll("'", "'\\''") + "'";
}

/**
 * Read one `pullboard needs --json` run. A pullboard without the command is `missing`, which the
 * panel shows as one quiet line, since every older install answers that way on every poll.
 *
 * @param {{ code: number, stdout: string, stderr: string }} result
 * @returns {{ state: 'ok', root: string|null, needs: any[] } | { state: 'missing' } | { state: 'error', message: string }}
 */
export function readNeeds(result) {
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  const message = String(parsed?.error?.message ?? (result.stderr || result.stdout || '')).trim();
  if (/no command "needs"|unknown command:? "?needs/i.test(message)) return { state: 'missing' };
  if (result.code !== 0) return { state: 'error', message: `needs: exit ${result.code}: ${(message.split('\n').find(Boolean) ?? 'no output').slice(0, 200)}` };
  if (!parsed || !Array.isArray(parsed.needs)) return { state: 'error', message: 'needs: unreadable output' };
  return { state: 'ok', root: parsed.root ?? null, needs: parsed.needs.filter((need) => need && need.id != null) };
}

/**
 * Each step with whether it is done, the one to run next, or waiting on an earlier step; only
 * `next` can run, so steps go in order.
 *
 * @param {{ steps?: any[], next?: number|null }} need
 * @returns {(any & { state: 'done'|'next'|'later' })[]}
 */
export function stepStates(need) {
  return (need.steps ?? []).map((step) => ({
    ...step,
    state: step.done ? 'done' : step.n === need.next ? 'next' : 'later',
  }));
}

/**
 * The step a run may start, or null when `n` is not the need's next step.
 *
 * @param {{ steps?: any[], next?: number|null }} need
 * @param {number} n
 * @returns {any|null}
 */
export function runnableStep(need, n) {
  if (need.next == null || n !== need.next) return null;
  const step = (need.steps ?? []).find((s) => s.n === n);
  return step && !step.done ? step : null;
}

/**
 * Fill a step's command: each `{key}` a prompt declares becomes that answer, shell-quoted, and a
 * missing answer takes the prompt's default. Braces no prompt declares stay as written, since a
 * command may carry its own (an awk program, say). A step with a declared placeholder is refused
 * when it uses ", a backtick, \ or $(, since each can put the answer back inside a shell parse;
 * with those gone single quotes cannot nest, so a placeholder between two ' is refused too.
 *
 * @param {{ command: string, prompts?: { key: string, default?: string }[] }} step
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function fillCommand(step, values = {}) {
  const prompts = new Map((step.prompts ?? []).map((p) => [p.key, p]));
  const template = String(step.command ?? '');
  const placeholder = /\{([A-Za-z_][\w-]*)\}/y;
  const hits = [];
  let quoted = false;
  for (let i = 0; i < template.length; i += 1) {
    if (template[i] === "'") { quoted = !quoted; continue; }
    placeholder.lastIndex = i;
    const hit = template[i - 1] !== '$' ? placeholder.exec(template) : null;
    if (hit && prompts.has(hit[1])) hits.push({ at: i, key: hit[1], len: hit[0].length, quoted });
  }
  if (!hits.length) return template;
  const unsafe = /["`\\]|\$\(/.test(template) ? hits[0] : hits.find((h) => h.quoted);
  if (unsafe) {
    throw new Error(`placeholder {${unsafe.key}} cannot be filled safely: a step with one may not use ", \`, \\ or $(, or quote it in: ${template}`);
  }
  let out = '';
  let from = 0;
  for (const { at, key, len } of hits) {
    const value = Object.hasOwn(values, key) ? values[key] : prompts.get(key).default ?? '';
    out += template.slice(from, at) + shellQuote(value);
    from = at + len;
  }
  return out + template.slice(from);
}

/**
 * The ask id `pullboard ask done` takes, from an ask's need id (`ask:<8 hex>`); null for a board
 * need, which clears itself when the board changes.
 *
 * @param {{ id: string, source?: string }} need
 * @returns {string|null}
 */
export function askId(need) {
  if (need.source !== 'ask') return null;
  const id = String(need.id);
  return id.startsWith('ask:') ? id.slice(4) : id;
}

/**
 * The script a step's tab runs. The command runs in a subshell so an `exit` in it cannot close the
 * tab; the tab then prints the exit status and stays open as a login shell. For an ask, an exit 0
 * marks the step done from the board root as the person, whose terminal this is, so the panel
 * never has to watch the tab to learn it.
 *
 * @param {{ command: string, askId?: string|null, step?: number, root?: string|null }} run
 * @returns {string}
 */
export function stepScript({ command, askId: ask = null, step, root = null }) {
  const lines = ['(', command, ')', 'pb_status=$?', 'echo', 'echo "[exit $pb_status]"'];
  if (ask != null) {
    const into = root ? `cd ${shellQuote(root)} && ` : '';
    lines.push(`if [ "$pb_status" -eq 0 ]; then (${into}pullboard ask done ${shellQuote(ask)} --step ${Number(step)} --as person); fi`);
  }
  lines.push('exec /bin/zsh -l');
  return lines.join('\n');
}

/**
 * The Herdr App command that opens a step's tab: a new tab in the Needs you space when there is
 * one on this computer, else that space made with the step as its first tab.
 *
 * @param {{ id: string, name: string, named?: boolean, machine?: string|null }[]} spaces
 * @param {{ name: string, cwd: string, script: string }} launch
 * @returns {{ command: 'tab.new' | 'space.new', args: Record<string, unknown> }}
 */
export function launchCommand(spaces, { name, cwd, script }) {
  const argv = ['/bin/zsh', '-lc', script];
  const space = (spaces ?? []).find((s) => s.name === NEEDS_SPACE && s.named !== false && !s.machine);
  if (space) return { command: 'tab.new', args: { space: space.id, name, folder: cwd, argv } };
  // The board is on this computer, so the space is too, whichever space has focus.
  return { command: 'space.new', args: { name: NEEDS_SPACE, folder: cwd, tab: name, argv, machine: '' } };
}

/**
 * Everything one confirmed run needs: the filled command, the tab's command and its name, or why
 * it cannot run (a step that is not next, one with no folder, or a placeholder it cannot fill safely).
 *
 * @param {{ need: any, n: number, values: Record<string, string>, root?: string|null, spaces: any[] }} input
 * @returns {{ command: string, launch: { command: string, args: Record<string, unknown> } } | { refused: string }}
 */
export function planRun({ need, n, values, root = null, spaces }) {
  const step = runnableStep(need, n);
  if (!step) return { refused: `step ${n} of ${need.id} is not the next step` };
  if (!step.cwd) return { refused: `step ${n} of ${need.id} names no folder to run in` };
  let command;
  try { command = fillCommand(step, values); } catch (error) { return { refused: error.message }; }
  const script = stepScript({ command, askId: askId(need), step: n, root });
  const name = `${need.title ?? need.id} · ${step.label ?? 'step ' + n}`.slice(0, 60);
  return { command, launch: launchCommand(spaces, { name, cwd: step.cwd, script }) };
}
