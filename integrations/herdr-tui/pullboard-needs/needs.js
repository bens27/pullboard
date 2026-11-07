/**
 * The pure part of the Herdr TUI "Needs you" panel: reading `pullboard needs --json`, filling a
 * step's prompts into its command, and building what a new Herdr tab runs [B26]. Nothing here
 * touches a terminal, a process or a file, so every rule is unit-tested.
 */

/**
 * Quote one value for a POSIX shell: single quotes, with each ' closed, escaped and reopened.
 *
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

/**
 * Fill a step's `{key}` placeholders from the person's answers, each value shell-quoted. Only keys
 * the step declares as prompts are filled, so shell text such as `${HOME}` passes through. A step
 * with a declared placeholder is refused when it uses ", a backtick, \ or $(, since each can put
 * the answer back inside a shell parse; with those gone single quotes cannot nest, so a
 * placeholder between two ' is refused too: `'{note}'` answered `$(cmd)` would run cmd.
 *
 * @param {{ command: string, prompts?: { key: string, default?: string }[] }} step
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function fillCommand(step, values = {}) {
  const prompts = new Map((step.prompts ?? []).map((prompt) => [prompt.key, prompt]));
  const template = String(step.command ?? '');
  const placeholder = /\{([A-Za-z_][\w-]*)\}/uy;
  const hits = [];
  let quoted = false;
  for (let at = 0; at < template.length; at += 1) {
    if (template[at] === "'") { quoted = !quoted; continue; }
    placeholder.lastIndex = at;
    const hit = template[at - 1] !== '$' ? placeholder.exec(template) : null;
    if (hit && prompts.has(hit[1])) hits.push({ at, key: hit[1], length: hit[0].length, quoted });
  }
  if (!hits.length) return template;
  const unsafe = /["`\\]|\$\(/u.test(template) ? hits[0] : hits.find((hit) => hit.quoted);
  if (unsafe) {
    throw new Error(`placeholder {${unsafe.key}} cannot be filled safely: a step with one may not use ", \`, \\ or $(, or quote it in: ${template}`);
  }
  let out = '';
  let from = 0;
  for (const { at, key, length } of hits) {
    const value = Object.hasOwn(values, key) ? values[key] : (prompts.get(key).default ?? '');
    out += template.slice(from, at) + shellQuote(value);
    from = at + length;
  }
  return out + template.slice(from);
}

/**
 * Parse and check the `needs --json` document; a shape this panel cannot render throws, so the
 * panel shows one clear message instead of a half-drawn list.
 *
 * @param {string} text
 * @returns {{ version: number, root: string, needs: any[] }}
 */
export function parseNeeds(text) {
  const data = JSON.parse(text);
  if (!data || data.version !== 1 || !Array.isArray(data.needs)) throw new Error('needs: expected version 1 with a needs list');
  for (const need of data.needs) {
    if (typeof need?.id !== 'string' || typeof need.title !== 'string' || !Array.isArray(need.steps)) throw new Error('needs: a need lacks id, title or steps');
    for (const step of need.steps) {
      if (!Number.isInteger(step?.n) || typeof step.command !== 'string' || typeof step.cwd !== 'string') throw new Error(`needs: ${need.id} has a step without n, command or cwd`);
    }
  }
  return { version: 1, root: typeof data.root === 'string' ? data.root : '', needs: data.needs };
}

/**
 * Where a step stands: done, the one step the person may run now, or waiting on an earlier step.
 *
 * @param {{ next: number | null }} need
 * @param {{ n: number, done?: boolean }} step
 * @returns {'done' | 'next' | 'waiting'}
 */
export function stepState(need, step) {
  if (step.done) return 'done';
  return need.next === step.n ? 'next' : 'waiting';
}

/**
 * The step the person may run now, or null when every step is done or the board names none.
 *
 * @param {{ next: number | null, steps: any[] }} need
 * @returns {any | null}
 */
export function nextStep(need) {
  if (need.next === null || need.next === undefined) return null;
  const step = need.steps.find((row) => row.n === need.next);
  return step && !step.done ? step : null;
}

/**
 * The id `pullboard ask done` takes for an ask: the board lists asks as `ask:<8 hex>` and the
 * ask command names them by that hex id.
 *
 * @param {{ id: string }} need
 * @returns {string}
 */
export function askId(need) {
  return need.id.startsWith('ask:') ? need.id.slice(4) : need.id;
}

/**
 * The zsh script a new tab runs for one step. It removes itself first, so a filled answer never
 * outlives the run on disk; it prints the exit code; and for an ask it records the step done only
 * when the command exited 0, from the board root so the right board hears it, and as the person,
 * since a person-only ask refuses anyone else and this tab is the person's own terminal.
 *
 * @param {{ need: any, step: any, command: string, root: string, self: string }} input
 * @returns {string}
 */
export function stepScript({ need, step, command, root, self }) {
  const lines = [
    `rm -rf -- ${shellQuote(self)}`,
    `cd -- ${shellQuote(step.cwd)} || { print -r -- '[cannot enter '${shellQuote(step.cwd)}']'; exit 1; }`,
    `print -r -- ${shellQuote(`$ ${command}`)}`,
    // A subshell, so an `exit` in the command still reaches the status line and the done check.
    `(\n${command}\n)`,
    'rc=$?',
    'echo',
    "echo '[exit '$rc']'",
  ];
  if (need.source === 'ask') {
    const done = `pullboard ask done ${shellQuote(askId(need))} --step ${step.n} --as person`;
    lines.push(`if [ $rc -eq 0 ]; then (cd -- ${shellQuote(root)} && ${done}) || echo '[could not record the step done; run: ${done.replaceAll("'", '')}]'; fi`);
  }
  lines.push('exit $rc');
  return lines.join('\n') + '\n';
}

/**
 * The two Herdr calls that start a step: a tab in the person's workspace at the step's folder, then
 * the script run in that tab's own shell, which stays open afterwards.
 *
 * @param {{ workspace: string, cwd: string, label: string }} tab
 * @returns {string[]}
 */
export function tabCreateArgs({ workspace, cwd, label }) {
  const args = ['tab', 'create', '--cwd', cwd, '--label', label, '--focus'];
  return workspace ? [...args.slice(0, 2), '--workspace', workspace, ...args.slice(2)] : args;
}

/**
 * The root pane of a `herdr tab create` reply.
 *
 * @param {string} text
 * @returns {string}
 */
export function rootPane(text) {
  const pane = JSON.parse(text)?.result?.root_pane;
  const id = typeof pane === 'string' ? pane : pane?.pane_id;
  if (typeof id !== 'string' || !id) throw new Error('herdr tab create returned no root pane');
  return id;
}

/**
 * Whether a failed `pullboard needs` run means this pullboard has no `needs` command yet, which the
 * panel reports quietly instead of as an error.
 *
 * Pullboard puts a --json refusal on stdout, so the caller passes both streams.
 *
 * @param {string} output
 * @returns {boolean}
 */
export function needsMissing(output) {
  return /no command \\?"needs\\?"|unknown command:? \\?"?needs/iu.test(output);
}
