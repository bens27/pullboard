/**
 * Pure read model for the Herdr Pullboard panel [B26]. It takes the parsed `--json` output of
 * `health`, `status`, `list`, `resources` and `settings` and returns what the panel draws, so tests
 * import it without Herdr. Nothing here runs a command or reads the clock.
 */

const ROUTES = ['light', 'mid', 'strong'];
const PRESENCE_ORDER = ['live', 'idle', 'gone'];
const LIVE_MS = 10 * 60_000;
const IDLE_MS = 30 * 60_000;

/**
 * Rank a route so a seat can take items at its route or lower; an unknown route ranks as strong,
 * the board's default.
 *
 * @param {string|null|undefined} route
 * @returns {number}
 */
function routeRank(route) {
  const rank = ROUTES.indexOf(route ?? 'strong');
  return rank < 0 ? ROUTES.length - 1 : rank;
}

/**
 * A seat's presence: the board's own word when it gives one, otherwise from its last heartbeat
 * with the same live and idle windows the board uses.
 *
 * @param {{ presence?: string, heartbeatAt?: string|null }} agent
 * @param {number} now
 * @returns {'live'|'idle'|'gone'}
 */
function presenceOf(agent, now) {
  if (PRESENCE_ORDER.includes(agent.presence)) return /** @type {any} */ (agent.presence);
  const at = Date.parse(agent.heartbeatAt ?? '');
  if (!Number.isFinite(at)) return 'gone';
  const age = now - at;
  return age < LIVE_MS ? 'live' : age < IDLE_MS ? 'idle' : 'gone';
}

/**
 * Parse one command's result into its JSON value or an error line that names the command, so a
 * failed read shows as an error and never as an empty, healthy board.
 *
 * @param {string} name
 * @param {{ code: number, stdout: string, stderr: string }} result
 * @returns {{ value: any } | { error: string }}
 */
export function parseJson(name, result) {
  if (result.code !== 0) {
    const line = String(result.stderr || result.stdout || '').trim().split('\n').find(Boolean) ?? 'no output';
    return { error: `${name}: exit ${result.code}: ${line.slice(0, 200)}` };
  }
  try { return { value: JSON.parse(result.stdout) }; }
  catch { return { error: `${name}: unreadable output` }; }
}

/**
 * Item ids an item still waits on: `after` entries that are on the board and not yet verified.
 * Items missing from `list` are done, since `list` shows only open, claimed and submitted work.
 *
 * @param {any} item
 * @param {Map<number, any>} byId
 * @returns {number[]}
 */
function waitingOn(item, byId) {
  return String(item.item_after ?? '').split(',').map((part) => Number(part.trim().replace(/^#/, '')))
    .filter((id) => Number.isInteger(id) && id > 0 && byId.has(id));
}

/**
 * Group health findings by cause; each row keeps the board's own reason, next step and owner.
 *
 * @param {any[]} findings
 * @returns {{ cause: string, rows: any[] }[]}
 */
function haltGroups(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const rows = groups.get(finding.cause) ?? [];
    rows.push({
      key: finding.key, item: finding.item ?? null, subject: finding.subject, title: finding.title,
      why: finding.why, next: finding.next, command: finding.command ?? null, ageMinutes: finding.ageMinutes ?? null,
      owner: finding.owner ? [finding.owner.role, finding.owner.who].filter(Boolean).join(' ') : null,
      state: finding.state,
    });
    groups.set(finding.cause, rows);
  }
  return [...groups].map(([cause, rows]) => ({ cause, rows }));
}

/**
 * Flag each halted item that `health` gives no reason for, with a recommendation. Work that waits
 * on open `after` items, or on capable seats that are all busy, is moving and is not flagged.
 *
 * @param {any[]} items
 * @param {any[]} seats
 * @param {Set<number>} explained
 * @returns {any[]}
 */
function unexplained(items, seats, explained) {
  const byId = new Map(items.map((item) => [Number(item.item_id), item]));
  const seatById = new Map(seats.map((s) => [s.id, s]));
  const flags = [];
  const flag = (item, problem, recommendation, command) => flags.push({
    item: item.item_id, subject: '#' + item.item_id, title: item.item_title, lane: item.item_lane,
    status: item.item_status, problem, recommendation, command, flagged: true,
  });
  for (const item of items) {
    if (explained.has(Number(item.item_id))) continue;
    if (item.item_status === 'claimed') {
      const holder = seatById.get(item.item_owner);
      const presence = holder?.presence ?? 'gone';
      if (presence === 'live') continue;
      flag(item, `claimed by ${item.item_owner ?? 'nobody'}, which is ${presence}`,
        `Resume ${item.item_owner ?? 'the holder'} in its worktree, or release the claim so another seat can take it.`,
        `pullboard resume`);
    } else if (item.item_status === 'open') {
      if (item.item_hold_reason || waitingOn(item, byId).length) continue;
      const capable = seats.filter((s) => s.presence === 'live' && s.lane === item.item_lane && routeRank(s.route) >= routeRank(item.item_route));
      const free = capable.filter((s) => s.holds.length === 0);
      if (free.length) {
        flag(item, `open and unblocked while ${free.map((s) => s.id).join(', ')} holds nothing`,
          `Have ${free[0].id} run pullboard next in its worktree to take it.`, 'pullboard next');
      } else if (!capable.length) {
        const route = ROUTES[routeRank(item.item_route)];
        flag(item, `open and unblocked with no live ${item.item_lane} seat at route ${route} or above`,
          `Start a seat for lane ${item.item_lane} at route ${route}; add --model with the exact model label.`,
          `pullboard worktree ${item.item_lane} --route ${route}`);
      }
    } else if (item.item_status === 'submitted') {
      if (seats.some((s) => s.presence === 'live' && s.lane === 'review' && s.id !== item.item_owner)) continue;
      flag(item, 'submitted with no live review seat to verify it',
        'Start a verifier from another parent session; add --model with the exact model label.', 'pullboard worktree review');
    }
  }
  return flags;
}

/**
 * Slots, use and line length of one machine-scope resource. The board writes a pool's row only once
 * something takes a slot, so a pool nobody has used yet has the size its setting gives it.
 *
 * @param {any[]} resources
 * @param {string} name
 * @param {number|null|undefined} configured
 * @returns {{ capacity: number, used: number, free: number, waiting: number, holders: any[] }}
 */
function slotUse(resources, name, configured) {
  const found = resources.find((r) => r.name === name && r.scope === 'machine') ?? { capacity: configured ?? 0, holders: [], line: [] };
  const used = found.holders?.length ?? 0;
  return { capacity: found.capacity ?? 0, used, free: Math.max(0, (found.capacity ?? 0) - used), waiting: found.line?.length ?? 0, holders: found.holders ?? [] };
}

/** The board reads each section is drawn from; a section is unknown when any of them is missing. */
const SECTION_READS = {
  flags: ['health', 'status', 'list'],
  halts: ['health'],
  seats: ['status', 'list'],
  capacity: ['resources', 'settings'],
};

/**
 * Build everything the panel draws from one round of board reads.
 *
 * @param {{ health?: any, status?: any, list?: any, resources?: any, settings?: any, now: number, errors?: string[] }} input
 * @returns {{ halts: any[], flags: any[], seats: any[], capacity: any, errors: string[], unread: string[] }}
 */
export function boardModel({ health, status, list, resources, settings, now, errors = [] }) {
  const reads = { health, status, list, resources, settings };
  const unread = Object.keys(reads).filter((name) => reads[name] == null);
  const items = list?.items ?? [];
  const retired = new Set((health?.retired ?? []).map((r) => r.agent));
  const seats = (status?.agents ?? []).filter((a) => !retired.has(a.agent_id)).map((a) => ({
    id: a.agent_id, lane: a.agent_lane, route: a.agent_route ?? 'strong', model: a.agent_model ?? null,
    presence: presenceOf(a, now), heartbeatAt: a.heartbeatAt ?? null,
    holds: items.filter((i) => i.item_status === 'claimed' && i.item_owner === a.agent_id)
      .map((i) => ({ item: i.item_id, title: i.item_title, leaseUntil: i.item_lease_until ?? null })),
  })).sort((a, b) => PRESENCE_ORDER.indexOf(a.presence) - PRESENCE_ORDER.indexOf(b.presence) || a.id.localeCompare(b.id));
  const findings = [
    ...(health?.stuck ?? []).map((f) => ({ ...f, state: 'stuck' })),
    ...(health?.waiting ?? []).map((f) => ({ ...f, state: 'waiting' })),
  ];
  const explained = new Set(findings.map((f) => f.item).filter((id) => id != null).map(Number));
  // Without both the item list and the seats, a missing reason cannot be told from missing data.
  const flags = health && status && list ? unexplained(items, seats, explained) : [];
  const machine = resources?.resources ?? [];
  const current = settings?.settings ?? {};
  const gateSlots = current.gateSlots ?? null;
  const browserSlots = current.browserSlots ?? resources?.browserSlots ?? null;
  const capacity = {
    gate: slotUse(machine, 'gate', gateSlots),
    browser: slotUse(machine, 'browser', browserSlots),
    runners: (resources?.runners ?? []).map((r) => ({
      host: r.host, slots: r.slots ?? 0, inUse: r.inUse ?? 0, free: Math.max(0, (r.slots ?? 0) - (r.inUse ?? 0)),
      browser: r.browser ?? 0, browserInUse: r.browserInUse ?? 0, unavailable: Boolean(r.unavailable),
    })),
    gateSlots,
    browserSlots,
    shortSlots: current.gate?.shortSlots ?? resources?.shortSlots ?? 0,
    runnersFirst: Boolean(current.gate?.runnersFirst),
    // A ±1 move is relative to the settings read; without it the panel cannot know what +1 means.
    controls: Number.isSafeInteger(current.gateSlots) && Number.isSafeInteger(current.browserSlots),
  };
  return { halts: haltGroups(findings), flags, seats, capacity, errors: [...errors], unread };
}

/**
 * The line a section shows instead of rows: unknown when a read it is drawn from failed, so an
 * empty section never passes for a calm one; otherwise, once every read succeeded, its calm text
 * when it has nothing to show.
 *
 * @param {{ flags: any[], halts: any[], seats: any[], unread?: string[] }} model
 * @param {'flags'|'halts'|'seats'|'capacity'} section
 * @returns {string|null}
 */
export function sectionNote(model, section) {
  const missing = (SECTION_READS[section] ?? []).filter((name) => (model.unread ?? []).includes(name));
  if (missing.length) {
    const names = missing.length === 1 ? missing[0] : missing.slice(0, -1).join(', ') + ' and ' + missing.at(-1);
    return `Unknown: the ${names} read${missing.length === 1 ? '' : 's'} failed.`;
  }
  // A calm line vouches for the board as a whole, so none shows while any read is missing.
  if ((model.unread ?? []).length) return null;
  if (section === 'flags') return model.flags.length ? null : 'Every halt has a recorded reason.';
  if (section === 'halts') return model.halts.length ? null : 'Nothing is stuck.';
  if (section === 'seats') return model.seats.length ? null : 'No seats.';
  return null;
}

/**
 * The `pullboard settings` move for one −/+ click, or why it would be refused: both current counts
 * must be known, gateSlots never drops below browserSlots, and 0 slots of either kind needs a
 * registered runner.
 *
 * @param {string} name
 * @param {number} delta
 * @param {{ gateSlots: number|null|undefined, browserSlots: number|null|undefined, runners: number }} state
 * @returns {{ args: string[] } | { refused: string }}
 */
export function slotMove(name, delta, { gateSlots, browserSlots, runners }) {
  if (name !== 'gateSlots' && name !== 'browserSlots') return { refused: `unknown setting ${name}` };
  // A missing count would read as 0 and turn + into a cut, so no move is made from it.
  if (!Number.isSafeInteger(gateSlots) || !Number.isSafeInteger(browserSlots)) return { refused: 'current slot counts are unknown; refresh once settings can be read' };
  const next = (name === 'gateSlots' ? gateSlots : browserSlots) + delta;
  if (!Number.isSafeInteger(next) || next < 0) return { refused: `${name} cannot go below 0` };
  if (name === 'gateSlots' && next < browserSlots) return { refused: `gateSlots cannot be lower than browserSlots (${browserSlots})` };
  if (name === 'browserSlots' && next > gateSlots) return { refused: `browserSlots cannot be higher than gateSlots (${gateSlots})` };
  if (next === 0 && !runners) return { refused: `${name} 0 needs a registered runner` };
  return { args: ['settings', name, String(next)] };
}

const SLOT_COMMANDS = {
  'gateSlots-up': { move: 'gateSlots', delta: 1 },
  'gateSlots-down': { move: 'gateSlots', delta: -1 },
  'browserSlots-up': { move: 'browserSlots', delta: 1 },
  'browserSlots-down': { move: 'browserSlots', delta: -1 },
};

/**
 * Read a `herdr-app do pullboard.<command>` command, so an agent reaches the same slot moves as a
 * click; each move still passes slotMove's checks against the current counts.
 *
 * @param {string} command
 * @returns {{ move: string, delta: number } | { refresh: true } | { refused: string }}
 */
export function panelCommand(command) {
  if (command === 'refresh') return { refresh: true };
  if (Object.hasOwn(SLOT_COMMANDS, command)) return { ...SLOT_COMMANDS[command] };
  return { refused: `unknown panel command ${command}; use gateSlots-up, gateSlots-down, browserSlots-up, browserSlots-down or refresh` };
}
