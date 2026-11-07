/**
 * The Herdr Pullboard panel's read model turns fixed `--json` output into halts with their recorded
 * reasons, seats, test capacity and flagged halts that have no recorded reason [B26].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardModel, parseJson, slotMove } from '../integrations/herdr-app/mods/pullboard/read-model.js';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

/** A seat as `status --json` reports it. */
function seat(id, lane, route, presence, extra = {}) {
  return { agent_id: id, agent_lane: lane, agent_route: route, agent_model: 'model-x', agent_path: '/board/' + id, heartbeatAt: ago(1), presence, ...extra };
}

/** An item as `list --json` reports it. */
function item(id, lane, status, extra = {}) {
  return { item_id: id, item_title: 'Item ' + id, item_lane: lane, item_status: status, item_owner: null, item_route: 'mid', item_after: null, item_lease_until: null, item_hold_reason: null, ...extra };
}

/** A board snapshot with the given parts and an empty, healthy rest. */
function board({ findings = [], waiting = [], agents = [], items = [], retired = [], resources, settings } = {}) {
  return {
    health: { asOf: ago(0), stuck: findings, waiting, retired, blocks: [] },
    status: { agents },
    list: { items },
    resources: resources ?? {
      resources: [
        { name: 'gate', capacity: 9, scope: 'repo', holders: [], line: [] },
        { name: 'gate', capacity: 3, scope: 'machine', holders: [{ agent: 'ui-1', repo: 'r', since: ago(2), item: 4, kind: 'gate' }], line: [{ agent: 'ui-2' }] },
        { name: 'browser', capacity: 1, scope: 'machine', holders: [{ agent: 'ui-1', repo: 'r', since: ago(2), item: 4, kind: 'browser' }], line: [] },
        { name: 'checkout-session:abc', capacity: 1, scope: 'repo', holders: [], line: [] },
      ],
      runners: [{ host: 'mini', slots: 4, browser: 1, inUse: 1, browserInUse: 0, unavailable: false }],
      browserSlots: 1, shortSlots: 0,
    },
    settings: settings ?? { settings: { gateSlots: 3, browserSlots: 1, gate: { shortSlots: 0, runnersFirst: false } } },
    now: NOW,
  };
}

const lapsed = {
  key: 'CLAIM_LAPSED:item:7', cause: 'CLAIM_LAPSED', item: 7, subject: '#7', title: 'Item 7', since: ago(90), ageMinutes: 90,
  why: 'the claim lapsed 90 minutes ago', next: 'claim it again or release it', command: 'pullboard claim 7', owner: { role: 'builder', who: 'ui-3' }, detail: {},
};

test('halts are grouped by cause with the reason, next step and owner health recorded [B26]', () => {
  const model = boardModel(board({ findings: [lapsed], items: [item(7, 'ui', 'claimed', { item_owner: 'ui-3' })], agents: [seat('ui-3', 'ui', 'mid', 'gone')] }));
  assert.equal(model.halts.length, 1);
  assert.equal(model.halts[0].cause, 'CLAIM_LAPSED');
  assert.deepEqual(model.halts[0].rows.map((row) => [row.subject, row.why, row.next, row.command, row.owner]),
    [['#7', 'the claim lapsed 90 minutes ago', 'claim it again or release it', 'pullboard claim 7', 'builder ui-3']]);
  // A recorded reason means the halt is explained, even though its holder is gone.
  assert.deepEqual(model.flags, []);
});

test('a claimed item whose holder is idle or gone with no recorded reason is flagged [B26]', () => {
  const model = boardModel(board({
    items: [item(8, 'ui', 'claimed', { item_owner: 'ui-1' }), item(9, 'ui', 'claimed', { item_owner: 'ui-2' })],
    agents: [seat('ui-1', 'ui', 'mid', 'idle'), seat('ui-2', 'ui', 'mid', 'gone')],
  }));
  assert.deepEqual(model.flags.map((flag) => [flag.item, flag.problem]),
    [[8, 'claimed by ui-1, which is idle'], [9, 'claimed by ui-2, which is gone']]);
  for (const flag of model.flags) {
    assert.equal(flag.flagged, true);
    assert.match(flag.recommendation, /resume|release/);
  }
});

test('an open unblocked item with a free capable live seat names that seat [B26]', () => {
  const model = boardModel(board({
    items: [item(10, 'ui', 'open', { item_route: 'mid' })],
    agents: [seat('ui-light', 'ui', 'light', 'live'), seat('api-1', 'api', 'strong', 'live'), seat('ui-strong', 'ui', 'strong', 'live')],
  }));
  assert.equal(model.flags.length, 1);
  assert.equal(model.flags[0].item, 10);
  assert.match(model.flags[0].recommendation, /ui-strong/);
  assert.doesNotMatch(model.flags[0].recommendation, /ui-light|api-1/);
  assert.equal(model.flags[0].command, 'pullboard next');
});

test('an open item with no live capable seat recommends starting one [B26]', () => {
  const model = boardModel(board({
    items: [item(11, 'api', 'open', { item_route: 'strong' })],
    agents: [seat('api-mid', 'api', 'mid', 'live'), seat('api-old', 'api', 'strong', 'gone')],
  }));
  assert.equal(model.flags.length, 1);
  assert.equal(model.flags[0].command, 'pullboard worktree api --route strong');
});

test('a submitted item with no live review seat is flagged [B26]', () => {
  const model = boardModel(board({
    items: [item(12, 'ui', 'submitted', { item_owner: 'ui-1' })],
    agents: [seat('ui-1', 'ui', 'mid', 'live'), seat('review-1', 'review', 'strong', 'idle')],
  }));
  assert.equal(model.flags.length, 1);
  assert.equal(model.flags[0].item, 12);
  assert.equal(model.flags[0].command, 'pullboard worktree review');
});

test('busy capable seats, open after items and a live reviewer are not flagged [B26]', () => {
  const model = boardModel(board({
    items: [
      item(13, 'ui', 'claimed', { item_owner: 'ui-1' }),
      item(14, 'ui', 'open'),
      item(15, 'ui', 'open', { item_after: '13, 99' }),
      item(16, 'ui', 'submitted', { item_owner: 'ui-1' }),
    ],
    agents: [seat('ui-1', 'ui', 'strong', 'live'), seat('review-1', 'review', 'strong', 'live')],
  }));
  assert.deepEqual(model.flags, []);
});

test('an open item still waiting on an open after item is not flagged, even with a free seat [B26]', () => {
  const model = boardModel(board({
    items: [item(20, 'api', 'open'), item(21, 'ui', 'open', { item_after: '#20' })],
    agents: [seat('ui-1', 'ui', 'strong', 'live'), seat('api-1', 'api', 'strong', 'live', { presence: 'idle' })],
  }));
  assert.deepEqual(model.flags.map((flag) => flag.item), [20]);
});

test('an open item whose after items are all done is unblocked [B26]', () => {
  const model = boardModel(board({ items: [item(17, 'ui', 'open', { item_after: '98,99' })], agents: [] }));
  assert.deepEqual(model.flags.map((flag) => flag.item), [17]);
});

test('seats show presence and what each holds, retired seats left out [B26]', () => {
  const model = boardModel(board({
    items: [item(18, 'ui', 'claimed', { item_owner: 'ui-1' })],
    agents: [seat('ui-2', 'ui', 'light', 'gone'), seat('ui-1', 'ui', 'mid', 'live'), seat('ui-0', 'ui', 'mid', 'gone')],
    retired: [{ agent: 'ui-0', lane: 'ui', since: ago(500) }],
  }));
  assert.deepEqual(model.seats.map((s) => [s.id, s.presence, s.holds.map((h) => h.item)]), [['ui-1', 'live', [18]], ['ui-2', 'gone', []]]);
  assert.equal(model.seats[0].route, 'mid');
});

test('capacity shows gate and browser slots used and free, runners and settings [B26]', () => {
  const { capacity } = boardModel(board());
  assert.deepEqual([capacity.gate.capacity, capacity.gate.used, capacity.gate.free, capacity.gate.waiting], [3, 1, 2, 1]);
  assert.deepEqual([capacity.browser.capacity, capacity.browser.used, capacity.browser.free], [1, 1, 0]);
  assert.deepEqual(capacity.runners, [{ host: 'mini', slots: 4, inUse: 1, free: 3, browser: 1, browserInUse: 0, unavailable: false }]);
  assert.deepEqual([capacity.gateSlots, capacity.browserSlots, capacity.shortSlots, capacity.runnersFirst], [3, 1, 0, false]);
});

test('slot moves stay within what the settings command accepts [B26]', () => {
  const state = { gateSlots: 3, browserSlots: 1, runners: 0 };
  assert.deepEqual(slotMove('gateSlots', 1, state), { args: ['settings', 'gateSlots', '4'] });
  assert.deepEqual(slotMove('browserSlots', 1, state), { args: ['settings', 'browserSlots', '2'] });
  assert.match(slotMove('gateSlots', -1, { gateSlots: 2, browserSlots: 2, runners: 0 }).refused, /browserSlots/);
  assert.match(slotMove('browserSlots', 1, { gateSlots: 2, browserSlots: 2, runners: 0 }).refused, /gateSlots/);
  assert.match(slotMove('gateSlots', -1, { gateSlots: 1, browserSlots: 0, runners: 0 }).refused, /runner/);
  assert.match(slotMove('browserSlots', -1, { gateSlots: 2, browserSlots: 1, runners: 0 }).refused, /runner/);
  assert.deepEqual(slotMove('gateSlots', -1, { gateSlots: 1, browserSlots: 0, runners: 1 }), { args: ['settings', 'gateSlots', '0'] });
  assert.match(slotMove('shortSlots', 1, state).refused, /unknown/);
});

test('unreadable command output becomes an explicit error, never an empty board [B26]', () => {
  assert.deepEqual(parseJson('health', { code: 0, stdout: '{"stuck":[]}', stderr: '' }), { value: { stuck: [] } });
  assert.match(parseJson('health', { code: 1, stdout: '', stderr: 'pullboard: [NOT_A_BOARD] no board here\n' }).error, /health.*NOT_A_BOARD/);
  assert.match(parseJson('list', { code: 0, stdout: 'not json', stderr: '' }).error, /list.*unreadable/);
  const model = boardModel({ ...board(), list: null, errors: ['list: unreadable output'] });
  assert.deepEqual(model.errors, ['list: unreadable output']);
  assert.deepEqual(model.flags, []);
});
