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
 * Fill a step's `{key}` placeholders from the person's answers, each value shell-quoted; a step with
 * no declared placeholder runs as written. A step with one is an allowlist, not a denylist, since
 * every shell keeps finding new ways to re-parse a quoted word ($(, heredocs, comments, zsh's (e)
 * flag): each placeholder must stand alone as a word between spaces, and the rest may hold only
 * letters, digits, spaces and _ . / : @ % + , = -. An answer must be one line, so it can never
 * start a command of its own.
 *
 * @param {{ command: string, prompts?: { key: string, default?: string }[] }} step
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function fillCommand(step, values = {}) {
  const prompts = new Map((step.prompts ?? []).map((prompt) => [prompt.key, prompt]));
  const template = String(step.command ?? '');
  const hits = [...template.matchAll(/\{([A-Za-z_][\w-]*)\}/gu)]
    .filter((hit) => prompts.has(hit[1]))
    .map((hit) => ({ at: hit.index, key: hit[1], length: hit[0].length }));
  if (!hits.length) return template;
  let rest = '';
  let from = 0;
  for (const { at, length } of hits) {
    rest += template.slice(from, at);
    from = at + length;
  }
  rest += template.slice(from);
  const loose = hits.find(({ at, length }) => (at > 0 && template[at - 1] !== ' ') || (at + length < template.length && template[at + length] !== ' '));
  const unsafe = loose ?? (/^[A-Za-z0-9 _./:@%+,=-]*$/u.test(rest) ? null : hits[0]);
  if (unsafe) {
    throw new Error(`placeholder {${unsafe.key}} cannot be filled safely: a step with a placeholder must use it as a bare word and only letters, digits, spaces and _ . / : @ % + , = - in: ${template}`);
  }
  const answers = new Map(hits.map(({ key }) => [key, Object.hasOwn(values, key) ? String(values[key]) : String(prompts.get(key).default ?? '')]));
  for (const [key, value] of answers) {
    if (/[\n\r\0]/u.test(value)) throw new Error(`answer for {${key}} must be one line: a line break or NUL in it would run as its own command`);
  }
  let out = '';
  from = 0;
  for (const { at, key, length } of hits) {
    out += template.slice(from, at) + shellQuote(answers.get(key));
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
 * The steps a selected need adds to a batch: every remaining step of an ask, in order, since the
 * person asked for the whole ask; a board need's one next step.
 *
 * @param {{ source?: string, next: number | null, steps: any[] }} need
 * @returns {any[]}
 */
export function remainingSteps(need) {
  const next = nextStep(need);
  if (!next) return [];
  if (need.source !== 'ask') return [next];
  return need.steps.filter((step) => !step.done && step.n >= next.n).sort((a, b) => a.n - b.n);
}

/**
 * Why a need cannot join a batch, or '' when it can: it needs a step to run, and every step it
 * would add must pass the placeholder rule, so a batch never stops halfway on a refused template.
 *
 * @param {any} need
 * @returns {string}
 */
export function batchRefusal(need) {
  const steps = remainingSteps(need);
  if (!steps.length) return 'it has no step to run now';
  for (const step of steps) {
    // Blank answers test the template alone; a default the person may still edit is judged at the run.
    const blank = Object.fromEntries((step.prompts ?? []).map((prompt) => [prompt.key, '']));
    try { fillCommand(step, blank); }
    catch (error) { return `step ${step.n}: ${error.message}`; }
  }
  return '';
}

/**
 * The steps of a batch in list order, whatever order the person selected them in; a need that
 * cannot join a batch adds nothing.
 *
 * @param {any[]} needs
 * @param {string[]} selected
 * @returns {{ need: any, step: any }[]}
 */
export function batchSteps(needs, selected) {
  const chosen = new Set(selected);
  return needs
    .filter((need) => chosen.has(need.id) && !batchRefusal(need))
    .flatMap((need) => remainingSteps(need).map((step) => ({ need, step })));
}

/**
 * The zsh script one new tab runs for a batch. Each step runs as a single run does, in its own
 * folder and a subshell, from commands fillCommand already built; the first failure stops the
 * rest, so a later step never runs on top of an earlier one that did not happen.
 *
 * @param {{ items: { need: any, step: any, command: string }[], root: string, self: string }} input
 * @returns {string}
 */
export function batchScript({ items, root, self }) {
  const total = items.length;
  const tag = (k) => `[${k}/${total}]`;
  const lines = [`rm -rf -- ${shellQuote(self)}`, 'stopped=0', 'first=0'];
  items.forEach((_, index) => lines.push(`st_${index + 1}='not run'`));
  items.forEach(({ need, step, command }, index) => {
    const k = index + 1;
    const label = step.label ?? need.title;
    lines.push(
      'if [ $stopped -eq 0 ]; then',
      'echo',
      `print -r -- ${shellQuote(`${tag(k)} ${label}  (in ${step.cwd})`)}`,
      `if cd -- ${shellQuote(step.cwd)}; then`,
      `print -r -- ${shellQuote(`$ ${command}`)}`,
      `(
${command}
)`,
      'rc=$?',
      'else',
      `print -r -- ${shellQuote(`[cannot enter ${step.cwd}]`)}`,
      'rc=1',
      'fi',
      'if [ $rc -eq 0 ]; then',
      `st_${k}=done`,
    );
    if (need.source === 'ask') {
      const done = `pullboard ask done ${shellQuote(askId(need))} --step ${shellQuote(String(step.n))} --as person`;
      lines.push(`(cd -- ${shellQuote(root)} && ${done}) || echo '[could not record the step done; run: ${done.replaceAll("'", '')}]'`);
    }
    lines.push(
      'else',
      `st_${k}="failed (exit $rc)"`,
      'stopped=1',
      'first=$rc',
      `echo ${shellQuote(`stopped at ${tag(k)}: exit `)}"$rc"'; later steps not run'`,
      'fi',
      'fi',
    );
  });
  lines.push('echo');
  items.forEach(({ need, step }, index) => {
    lines.push(`print -r -- ${shellQuote(`${tag(index + 1)} ${step.label ?? need.title}: `)}"$st_${index + 1}"`);
  });
  lines.push('exit $first');
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
