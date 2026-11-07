/** The block ledger: refusals that stopped someone's command. Not in refused.js, which the browser loads [C6]. */
import {
  appendFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  requirePersonChannel,
  requireRelayOnChannel,
} from './person.js';
import {
  gitConfig,
  repoInfo,
} from './git.js';
import { homedir } from 'node:os';

/** The ledger of refusals that stopped someone's command, beside the board in Git's common folder. */
export const BLOCKS_FILE = join('pullboard', 'blocks.jsonl');

/**
 * Append one block: its code, the command, who was stopped, who can clear it, and the plain reason
 * and step. A ledger beside the board, not a board event, so recording a block never needs the
 * board's lock or changes what the event log replays.
 *
 * @param {string} commonDir
 * @param {{ at: string, code: string, command: string, by: string, path: string, audience: string, reason: string, step: string }} block
 */
export function recordBlock(commonDir, block) {
  const folder = join(commonDir, 'pullboard');
  // A repository without a board has no ledger yet; the refusal itself still prints.
  if (!existsSync(folder)) return false;
  appendFileSync(join(commonDir, BLOCKS_FILE), JSON.stringify({ ...block, ...(block.moveKey ? { id: randomUUID() } : {}) }) + '\n');
  return true;
}

/**
 * The blocks recorded at or after `since`, oldest first. A torn last line from a crash is skipped.
 *
 * @param {string} commonDir
 * @param {{ since?: Date }} [options]
 * @returns {any[]}
 */
export function readBlocks(commonDir, { since } = {}) {
  const file = join(commonDir, BLOCKS_FILE);
  if (!existsSync(file)) return [];
  const from = since ? since.getTime() : -Infinity;
  const blocks = new Map();
  let legacy = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let block;
    try { block = JSON.parse(line); } catch { continue; /* A torn line from an interrupted append carries no block. */ }
    if (block?.kind === 'clear' && Array.isArray(block.ids)) {
      for (const id of block.ids) {
        const previous = blocks.get(id);
        const pending = previous?.moveKeys?.filter(move => !block.moveKeys?.includes(move));
        if (block.moveKeys && pending?.length) blocks.set(id, { ...previous, moveKeys: pending });
        else blocks.delete(id);
      }
    } else if (typeof block?.code === 'string') blocks.set(block.id ?? `legacy:${legacy++}`, block);
  }
  return [...blocks.values()].filter(block => Date.parse(block.at) >= from);
}

/** Hash a local matching key; command text, argument bodies and credentials never enter the ledger. */
function key(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** The command branch and its target, excluding prose and option values. */
export function blockMoveKey(io) {
  const command = io.relayCommand;
  if (!command) return null;
  const name = command.cliOperation;
  const words = command.positionals ?? [];
  const branches = new Set(['spec', 'doctrine', 'sentinel', 'runner', 'relay', 'lane', 'milestone', 'hook', 'settings', 'loop', 'rigor', 'blueprint', 'flakes']);
  let verb = name === 'hold' ? command.values?.off ? 'off' : 'on'
    : name === 'land' && command.values?.waive !== undefined ? 'waive'
    : ['verify', 'fact'].includes(name) ? words[1] ?? ''
    : name === 'check' && words[0] === 'accept' ? 'accept' : branches.has(name) ? words[0] ?? '' : '';
  const itemTargets = new Set(['answer', 'claim', 'submit', 'verify', 'check', 'show', 'release', 'withdraw', 'merged', 'fact', 'escalate', 'hold', 'edit', 'refreeze', 'reopen', 'pass', 'log', 'why', 'done']);
  const namedTargets = new Set(['shout', 'join', 'worktree', 'list', 'inbox', 'prompt', 'forget', 'import', 'add']);
  let numericItem = itemTargets.has(name);
  let target = numericItem || namedTargets.has(name) ? words[0] ?? '' : '';
  if (name === 'check' && verb === 'accept') target = words[1] ?? '';
  if (name === 'land' && verb === 'waive') target = String(command.values.waive);
  if (name === 'next' && command.values?.verifyId !== undefined) {
    target = String(command.values.verifyId);
    numericItem = true;
  }
  // These handlers take a named entity after their verb, not prose or an option value.
  const namedBranches = new Set(['sentinel', 'runner', 'milestone', 'lane', 'loop', 'rigor', 'blueprint', 'flakes']);
  if (namedBranches.has(name) || name === 'relay' && verb === 'revoke'
      || name === 'spec' && ['answer', 'show'].includes(verb)) target = words[1] ?? '';
  if (name === 'spec' && ['approve', 'decline', 'signoff'].includes(verb)) {
    target = [...new Set(words.slice(1).flatMap(word => word.split(/[\s,]+/u)).filter(Boolean))].sort().join(',');
  }
  if (name === 'spec' && ['fit', 'signers'].includes(verb)) {
    verb += ':' + (words[1] ?? '');
    target = words[2] ?? '';
  }
  // A person-only ask refused for one seat must not clear when that seat completes another ask or step [B26].
  if (name === 'ask' && ['done', 'drop'].includes(words[0])) {
    verb = words[0] === 'done' ? `done:${[command.values?.step ?? []].flat().join(',')}` : 'drop';
    target = String(words[1] ?? '').replace(/^ask:/u, '');
  }
  if (name === 'bar') {
    verb = ['sign', 'ready'].includes(words[0]) ? words[0] : '';
    target = verb === 'sign' ? words[1] ?? '' : verb === 'ready' ? `ready:${words[1] ?? ''}` : words[0] ?? '';
    numericItem = verb !== 'ready';
  }
  if (name === 'intake') {
    verb = words[0] === 'approve' ? 'approve' : '';
    target = (verb ? words[1] : words[0]) ?? '';
    numericItem = Boolean(verb);
  }
  // The destination and the companion key name which move it was, not prose.
  if (name === 'move') target = { item: words[0] ?? '', to: command.values?.to ?? '' };
  if (name === 'companion') target = { parent: String(Number(String(words[0] ?? '').replace(/^#/u, ''))), lane: words[1] ?? '', key: command.values?.key ?? '' };
  if (name === 'blueprint' && verb === 'add') {
    target = [...new Set([words[1], ...[].concat(command.values?.blueprint ?? [])].filter(Boolean))].sort();
  }
  if (name === 'spec' && verb === 'signers:add') {
    const root = repoInfo(io.cwd ?? process.cwd()).root;
    /** Read the signer's configured defaults without reading any key contents. */
    const setting = field => gitConfig(root, field, { flags: false }).stdout || '';
    const requested = command.values?.key || setting('user.signingkey') || join(homedir(), '.ssh/id_ed25519.pub');
    const expanded = requested === '~' ? homedir() : requested.startsWith('~/') ? join(homedir(), requested.slice(2)) : requested;
    target = { principal: command.values?.by || setting('user.email'), key: resolve(root, expanded).replace(/\.pub$/u, '') };
  }
  if (['forget', 'import'].includes(name) && target) target = resolve(io.cwd ?? process.cwd(), target);
  if (name === 'milestone' && verb === 'add') target = target.trim();
  // Item IDs accept #1 and 01 as aliases. Names such as milestones '01' and '1' remain distinct.
  if (numericItem && /^#?\d+$/u.test(target)) target = String(Number(target.replace(/^#/u, '')));
  return key({ command: name, verb, item: target });
}

/**
 * The whole command a block stopped, hashed: its name, every word and every option. A runner's
 * success clears its person block only when it ran exactly this, since a coarser move key would let
 * a lesser command stand in for the decision that was refused [B26].
 */
export function stoppedCommandKey(io) {
  const command = io.relayCommand;
  if (!command?.cliOperation) return null;
  const values = command.values ?? {};
  return key({ stopped: command.cliOperation, words: (command.positionals ?? []).map(String),
    values: Object.keys(values).sort().map(name => [name, values[name]]) });
}

/** Blocks recorded before the stopped command was hashed kept only its name, so they cannot prove a runner repeated it. */
function stoppedBy(block, io) {
  return Boolean(block.stopped) && block.stopped === stoppedCommandKey(io);
}

/** A multirow refusal completes only after every target has its own later successful move. */
export function blockMoveKeys(io) {
  const command = io.relayCommand;
  if (command?.cliOperation === 'spec' && ['approve', 'decline', 'signoff'].includes(command.positionals?.[0])) {
    return [...new Set(command.positionals.slice(1).flatMap(word => word.split(/[\s,]+/u)).filter(Boolean))]
      .map(id => blockMoveKey({ relayCommand: { ...command, positionals: [command.positionals[0], id] } }));
  }
  if (command?.cliOperation === 'blueprint' && command.positionals?.[0] === 'add') {
    const refs = [...new Set([command.positionals[1], ...[].concat(command.values?.blueprint ?? [])].filter(Boolean))];
    return refs.map(reference => blockMoveKey({ ...io, relayCommand: { ...command,
      positionals: ['add', reference], values: { ...command.values, blueprint: [] } } }));
  }
  const move = blockMoveKey(io);
  return move ? [move] : [];
}

/** Agent blocks belong to that checkout's seat; person and coordinator blocks belong to this board. */
export function blockOwner(audience, info) {
  return audience === 'agent' ? key({ audience, seat: info.root }) : audience;
}

function personRelayOn(channel, environment) {
  try { requireRelayOnChannel(channel, environment); return true; } catch { return false; }
}

/** Record only the matching completed move's clear, leaving later or unrelated blocks intact. */
export function clearCompletedBlocks(io, now = io.clock?.now?.() ?? new Date()) {
  let info;
  try { info = repoInfo(io.cwd); } catch { return; }
  const moveKeys = blockMoveKeys(io);
  if (!moveKeys.length) return;
  const owners = new Set([blockOwner('agent', info)]);
  if (info.isMain) owners.add('coordinator');
  const environment = io.environment ?? process.env;
  try { requirePersonChannel(io.personChannel, environment); owners.add('person'); } catch { /* An agent's success cannot clear a person's block. */ }
  const caller = io.callerRole?.();
  const runner = caller === 'person' ? 'person' : info.isMain ? 'coordinator' : 'agent';
  // A person block records whom it stopped and what; once that checkout completes that exact command, nothing stops it any more.
  const unstopped = block => block.by === runner && block.path === info.root && stoppedBy(block, io);
  // Relay on reissues the coordinator's token, so every block an expired token raised is moot.
  // Relay on admits the person's SSH device sign-in, so its success is judged by relay on's own channel rule.
  const reissued = io.relayCommand?.cliOperation === 'relay' && io.relayCommand.positionals?.[0] === 'on' && personRelayOn(io.personChannel, environment);
  try {
    const expired = block => reissued && block.code === 'TOKEN_EXPIRED' && block.owner === 'person';
    const cleared = readBlocks(info.commonDir).filter(block => block.id && Date.parse(block.at) <= now.getTime()
      && (expired(block) || (block.moveKeys ?? [block.moveKey]).some(move => moveKeys.includes(move)) && (owners.has(block.owner) || unstopped(block))));
    if (!cleared.length) return;
    const ids = cleared.map(block => block.id);
    // An expired-token block clears whole, so the clear names every move it was waiting on.
    const keys = [...new Set([...moveKeys, ...cleared.filter(expired).flatMap(block => block.moveKeys ?? [block.moveKey])])];
    appendFileSync(join(info.commonDir, BLOCKS_FILE), JSON.stringify({ kind: 'clear', at: now.toISOString(), ids, moveKeys: keys }) + '\n');
  } catch (error) { io.err(`pullboard: the move completed, but its earlier block could not be cleared (${error.message})`); }
}

/**
 * The last day's blocks only the person can clear, carrying only their plain words, never a local
 * path, for every Needs you projection: the CLI, the local API and the sealed relay page [C6].
 *
 * @param {string} commonDir
 * @param {Date} now
 */
export function personBlockWords(commonDir, now) {
  return readBlocks(commonDir, { since: new Date(now.getTime() - 86_400_000) })
    .filter(block => block.audience === 'person')
    .map(({ at, code, command, audience, reason, step }) => ({ at, code, command, audience, reason, step }));
}
