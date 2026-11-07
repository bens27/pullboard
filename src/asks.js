/** Things a seat needs the person to run, held on the board so they sync and survive like other records [B26]. */
import { isAbsolute } from 'node:path';
import {
  atomic,
  logEvent,
  PERSON,
  shout,
} from './board.js';
import { listAgents } from './board-query.js';
import { COORDINATOR } from './config.js';
import { ENGINE_VERSION } from './machine.js';
import { Refused } from './refused.js';
import { ASK_ENGINE } from './ask-engine.js';

export { ASK_ENGINE };
const LINE = /[\r\n\0]/u;
/** The id a command draws for each ask, so every replica names it the same however events interleave. */
export const ASK_ID = /^[0-9a-f]{8}$/u;
const PLACEHOLDER = /(?<!\$)\{([a-z][a-z0-9_-]{0,31})\}/gu;

/** Split one `--step "<label>::<command>"` value; the label is what the person reads on the button. */
export function parseAskStep(value) {
  const text = String(value ?? '');
  const split = text.indexOf('::');
  if (split < 1) throw new Refused('BAD_ASK', 'write each step as --step "<label>::<command>"');
  return { label: text.slice(0, split).trim(), command: text.slice(split + 2).trim() };
}

/** The prompts a step's `{key}` placeholders need, in first-use order. */
export function stepPrompts(command) {
  const keys = [...new Set([...String(command).matchAll(PLACEHOLDER)].map(match => match[1]))];
  return keys.map(key => ({ key, label: key, default: '' }));
}

/**
 * The first `{key}` a panel could not fill safely, or null. A panel fills a key with a single-quoted answer, so a
 * step with any key may not use ", a backtick, \ or $(: each can put that answer back inside a shell parse. With
 * those gone, single quotes cannot nest, so toggling on each ' says exactly whether a key sits inside quotes.
 */
export function quotedPlaceholder(command) {
  const text = String(command);
  const keys = stepPrompts(text);
  if (!keys.length) return null;
  if (/["`\\]|\$\(/u.test(text)) return keys[0].key;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "'") { quoted = !quoted; continue; }
    if (!quoted || text[i] !== '{' || text[i - 1] === '$') continue;
    const hit = /^\{([a-z][a-z0-9_-]{0,31})\}/u.exec(text.slice(i));
    if (hit) return hit[1];
  }
  return null;
}

/** Refuse anything a panel could not show on one line or run in order. */
function askFiling(value) {
  const text = (field, max) => typeof field === 'string' && field.trim() && field.length <= max && !LINE.test(field);
  const steps = value?.steps;
  if (!text(value?.title, 200) || typeof (value.why ?? '') !== 'string' || (value.why ?? '').length > 1_000
      || !Array.isArray(steps) || !steps.length || steps.length > 20
      || steps.some(step => !text(step?.label, 120) || !text(step?.command, 4_096))
      || typeof value.cwd !== 'string' || !isAbsolute(value.cwd) || LINE.test(value.cwd)) {
    throw new Refused('BAD_ASK', 'file an ask with a one-line title, at least one --step "<label>::<command>" and an absolute --cwd');
  }
  const quoted = steps.map(step => quotedPlaceholder(step.command)).find(Boolean);
  if (quoted) {
    throw new Refused('ASK_QUOTED_PLACEHOLDER', `a step with a {key} must not use " \` \\ or $( and must keep {key} outside quotes`);
  }
  return { title: value.title.trim(), why: (value.why ?? '').trim(), cwd: value.cwd, personOnly: value.personOnly === true,
    steps: steps.map(step => ({ label: step.label.trim(), command: step.command.trim() })) };
}

/** Every ask in filing order, replayed from its events and keyed by the id its filing move carried. */
export function asks(board) {
  const rows = new Map();
  const events = board.db.prepare("SELECT * FROM event WHERE event_kind = 'ask' ORDER BY event_id").all();
  for (const event of events) {
    const detail = JSON.parse(event.event_detail);
    if (detail.engine !== ASK_ENGINE) continue;
    if (detail.action === 'file') {
      if (!ASK_ID.test(detail.id ?? '') || rows.has(detail.id)) continue;
      rows.set(detail.id, { id: detail.id, ...detail.ask, from: event.event_by, created: event.event_at, status: 'open',
        steps: detail.ask.steps.map((step, index) => ({ n: index + 1, ...step, prompts: stepPrompts(step.command), done: false })) });
      continue;
    }
    const row = rows.get(detail.id);
    if (!row || row.status !== 'open') continue;
    if (detail.action === 'done') {
      Object.assign(row.steps[detail.step - 1], { done: true, doneBy: event.event_by, doneAt: event.event_at,
        ...(detail.note ? { note: detail.note } : {}) });
      if (row.steps.every(step => step.done)) Object.assign(row, { status: 'done', closedAt: event.event_at });
    } else if (detail.action === 'drop') {
      Object.assign(row, { status: 'dropped', closedAt: event.event_at, reason: detail.reason, droppedBy: event.event_by });
    }
  }
  return [...rows.values()];
}

/** Tell the filer at their next inbox read; a shout is a direct entry there, never an interrupt. */
function tellFiler(board, row, by, text) {
  if (row.from === by || row.from === PERSON) return;
  shout(board, { from: by, to: row.from, text, lanes: [...new Set(listAgents(board).map(agent => agent.agent_lane))] });
}

/** File, finish one step of, or drop an ask; the board keeps every record. */
export function recordAsk(board, { agentId, action, ask, id, step, note, reason, asPerson = false, channel = 'terminal' }) {
  return atomic(board, () => {
    if ((board.executionEngineVersion ?? ENGINE_VERSION) < ASK_ENGINE) {
      throw new Refused('ENGINE_VERSION', `asks require engine ${ASK_ENGINE}; upgrade Pullboard`);
    }
    if (agentId !== PERSON && !listAgents(board).some(agent => agent.agent_id === agentId)) {
      throw new Refused('NOT_JOINED', 'join this board before filing or closing an ask: pullboard join <lane>');
    }
    if (action === 'file') {
      if (typeof id !== 'string' || !ASK_ID.test(id) || asks(board).some(entry => entry.id === id)) {
        throw new Refused('BAD_ASK', 'file an ask with a new id of 8 lowercase hex characters; pullboard ask draws one');
      }
      logEvent(board, agentId, 'ask', null, { action, id, ask: askFiling(ask), engine: ASK_ENGINE });
      return asks(board).find(entry => entry.id === id);
    }
    const row = asks(board).find(entry => entry.id === id);
    if (!row) throw new Refused('NO_ASK', `no ask ${id}; see pullboard needs`);
    if (row.status !== 'open') throw new Refused('ASK_CLOSED', `ask ${id} is already ${row.status}`);
    if (action === 'done') {
      if (asPerson && (agentId !== COORDINATOR || !['terminal', 'view'].includes(channel))) {
        throw new Refused('B26_PERSON_ANSWER', 'only the main checkout marks an ask done as the person, in their own terminal or the view');
      }
      const by = asPerson ? PERSON : agentId;
      if (row.personOnly && by !== PERSON) {
        throw new Refused('ASK_PERSON_ONLY', `ask ${id} is the person's alone; they mark it done at the main checkout: pullboard ask done ${id} --as person`);
      }
      if (![row.from, COORDINATOR, PERSON].includes(by)) {
        throw new Refused('ASK_NOT_FILER', 'only the seat that filed an ask, the coordinator or the person marks its steps done');
      }
      const index = step ?? row.steps.find(entry => !entry.done).n;
      if (!Number.isSafeInteger(index) || !row.steps[index - 1] || row.steps[index - 1].done
          || typeof (note ?? '') !== 'string' || LINE.test(note ?? '')) {
        throw new Refused('BAD_ASK', `name a step of ask ${id} that is not done yet, with an optional one-line --note`);
      }
      logEvent(board, by, 'ask', null, { action, id, step: index, ...(note?.trim() ? { note: note.trim() } : {}), ...(asPerson ? { channel } : {}), engine: ASK_ENGINE });
      const done = asks(board).find(entry => entry.id === id);
      if (done.status === 'done') tellFiler(board, done, by, `Ask ${id} done: ${done.title}${note?.trim() ? `\nNote: ${note.trim()}` : ''}`);
      return done;
    }
    if (action === 'drop') {
      if (agentId !== row.from && agentId !== COORDINATOR) throw new Refused('ASK_NOT_FILER', 'only the seat that filed an ask or the coordinator drops it');
      if (typeof reason !== 'string' || !reason.trim() || LINE.test(reason)) throw new Refused('BAD_ASK', 'drop an ask with --reason "<why>"');
      logEvent(board, agentId, 'ask', null, { action, id, reason: reason.trim(), engine: ASK_ENGINE });
      const dropped = asks(board).find(entry => entry.id === id);
      tellFiler(board, dropped, agentId, `Ask ${id} dropped: ${dropped.title}\nReason: ${reason.trim()}`);
      return dropped;
    }
    throw new Refused('BAD_ASK', 'record an ask as file, done or drop');
  });
}
