/**
 * The person's own Mac as a person channel on a relay-linked board [B26,H16]. The relay already
 * records any move sent with a GitHub person session as the person's, as it does for the phone,
 * so no relay change is needed: this Mac keeps one person session, from a sign-in the person
 * makes in their own terminal, and sends a person move with it.
 *
 * Why a fingerprint-only Secure Enclave key: an agent runs as the same user, so any file, keychain
 * item it can ask for, or environment variable the person's commands can read, an agent can read
 * too, and a password prompt an agent can answer by script. The session is kept sealed to a Secure
 * Enclave key that the enclave uses only after the person's current fingerprint (src/touch-id.js), so
 * the kept file is useless without the person's finger on this Mac. Each person move unwraps it once,
 * with a prompt that names the move and its ids; there is no password fallback and no standing grant.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { machineHome } from './machine-home.js';
import { requirePersonChannel } from './person.js';
import { policyOn } from './policy-settings.js';
import { Refused } from './refused.js';
import { openWithTouchId, personActionFor, sealWithTouchId, touchIdReason, touchIdRefusal } from './touch-id.js';

/** The label of the kept person sign-in; the relay origin names which relay it is for. */
export const PERSON_KEYCHAIN_SERVICE = 'pullboard-relay-person';

const SESSION = /^ps_[A-Za-z0-9_-]{43}$/u;

/** The person session one command holds for its own person move, never shared with a later command. */
const HELD = new WeakMap();

/** The session this command's person move may send with, or undefined. */
export function heldPersonSession(io) {
  return io && typeof io === 'object' ? HELD.get(io) : undefined;
}

/** Whether this machine can keep a person sign-in at all: only a Mac, whose helper then needs Touch ID and a Secure Enclave. */
export function macPersonAvailable(platform = process.platform) {
  return platform === 'darwin';
}

/** Where the sealed sign-in for one relay lives: the account's own Pullboard folder, never the repository or the link file. */
function sealedFile(origin) {
  const name = createHash('sha256').update(`${PERSON_KEYCHAIN_SERVICE}\n${origin}`).digest('hex').slice(0, 32);
  return join(machineHome(), 'relay-person', `${name}.json`);
}

/** The sealed sign-in kept for this relay, or undefined. Reading it asks nothing; it is useless without the fingerprint. */
function sealedSession(origin) {
  const file = sealedFile(origin);
  if (!existsSync(file)) return undefined;
  try {
    const sealed = JSON.parse(readFileSync(file, 'utf8'));
    return sealed?.v === 1 && typeof sealed.key === 'string' && typeof sealed.box === 'string' ? JSON.stringify(sealed) : undefined;
  } catch { return undefined; }
}

/** Whether this Mac keeps a person sign-in for this relay, without asking for a fingerprint. */
export function macPersonSignedIn(origin) {
  return macPersonAvailable() && sealedSession(origin) !== undefined;
}

/** Seal the person session to a new fingerprint-only Secure Enclave key and keep only the sealed form. Sealing never prompts. */
export function storeMacPersonSession(origin, token) {
  if (!SESSION.test(token ?? '')) throw new Refused('RELAY_RESPONSE', 'the relay did not issue a person session; sign in again');
  if (!macPersonAvailable()) throw new Refused('RELAY_KEYCHAIN', 'only a Mac with Touch ID keeps the person sign-in; send person moves from the paired phone');
  const { outcome, sealed, detail } = sealWithTouchId(token);
  let parsed;
  try { parsed = outcome === 'confirmed' ? JSON.parse(sealed) : undefined; } catch { parsed = undefined; }
  if (parsed?.v !== 1 || JSON.stringify(parsed).includes(token)) {
    throw new Refused('RELAY_KEYCHAIN', `this Mac could not seal the person sign-in to its Touch ID key: ${touchIdRefusal(outcome === 'confirmed' ? 'failed' : outcome, detail)}; enrol a fingerprint in System Settings, then run pullboard relay person on again`);
  }
  const file = sealedFile(origin);
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(parsed) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/** Forget this Mac's person sign-in for the relay. Returns whether one was kept. */
export function forgetMacPersonSession(origin) {
  const file = sealedFile(origin);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/**
 * Unwrap the kept sign-in for this command's person move with one fingerprint, prompting with the reason
 * Pullboard wrote for that move, and hold it for this command's io only. A second call for the same io
 * reuses the held session rather than ask again.
 *
 * @param {{ origin: string, reason: string, io: object }} options
 * @returns {{ outcome: string, detail?: string }}
 */
export function openMacPersonSession({ origin, reason, io }) {
  if (heldPersonSession(io)) return { outcome: 'confirmed' };
  const sealed = sealedSession(origin);
  if (!sealed) return { outcome: 'failed', detail: 'this Mac holds no person sign-in' };
  const { outcome, token, detail } = openWithTouchId(reason, sealed);
  if (outcome !== 'confirmed') return { outcome, detail };
  if (!SESSION.test(String(token ?? '').trim())) return { outcome: 'failed', detail: 'the kept sign-in is not a person session' };
  HELD.set(io, String(token).trim());
  return { outcome: 'confirmed' };
}

/** The person channel a move carries in its arguments, if any. */
function moveChannel(args) {
  return (Array.isArray(args) ? args : []).find((arg) => arg && typeof arg === 'object' && typeof arg.channel === 'string')?.channel;
}

/** The action a person move sends, read from the move itself when its command named none: a fixed phrase and plain ids. */
export function moveAction(operation, args = []) {
  const first = args?.[0];
  if (['recordRowDecisions', 'decideSpecRevisions'].includes(operation)) {
    const decisions = Array.isArray(first?.decisions) ? first.decisions : [];
    const kinds = new Set(decisions.map((record) => record?.decision));
    if (decisions.length && kinds.size === 1 && ['approve', 'decline'].includes([...kinds][0])) {
      return { command: `spec ${[...kinds][0]}`, ids: decisions.map((record) => String(record?.id)) };
    }
  }
  if (operation === 'acceptCheck') return { command: 'check accept', ids: [`#${String(first).replace(/^#/u, '')}`] };
  if (operation === 'decideSentinel' && ['approve', 'decline'].includes(first?.decision)) return { command: `sentinel ${first.decision}`, ids: [String(first.name)] };
  return { command: 'person move', ids: [String(operation)] };
}

/**
 * Let one command send its person move as the person from this Mac, or refuse it. Refuses while the
 * board keeps person moves on the phone (policy.personPhoneOnly), refuses an agent's terminal exactly
 * as an unlinked board does (B26_PERSON_CHANNEL), then unwraps the kept session with one fingerprint
 * whose prompt names the move. A Touch ID move from an agent's terminal already unwrapped it in its
 * command (src/touch-id.js), so it is not asked again. The session is held for this command's io only.
 *
 * @param {{ root: string, state: { url: string, board: string }, operation: string, args: any[], io: object, localRecords: Function, request: Function }} options
 */
export async function holdMacPersonSession({ root, state, operation, args, io, localRecords, request }) {
  const phone = 'send this person action from the paired phone';
  const { phoneOnly, touchId } = localRecords(root, (board) => ({ phoneOnly: policyOn(board, 'personPhoneOnly'), touchId: policyOn(board, 'personTouchId') }));
  if (phoneOnly) throw new Refused('HUMAN_REQUIRED', `${phone}; this board turned policy.personPhoneOnly on`);
  // Touch ID (policy.personTouchId) already confirmed this move, and unwrapped the session, in its command.
  const touchIdMove = moveChannel(args) === 'touchid' && touchId;
  if (!touchIdMove) requirePersonChannel(io?.personChannel);
  if (!heldPersonSession(io)) {
    if (touchIdMove || !macPersonSignedIn(state.url)) {
      throw new Refused('HUMAN_REQUIRED', `${phone}, or sign this Mac in for person moves: the person runs pullboard relay person on in their own terminal`);
    }
    // The command's own action names the move best; the move's own fields are next. A move neither can name is never sent blind.
    const reason = [personActionFor(io), moveAction(operation, args)].filter(Boolean).map((action) => {
      try { return touchIdReason(action); } catch { return undefined; }
    }).find(Boolean);
    if (!reason) throw new Refused('HUMAN_REQUIRED', `this move cannot be named in a Touch ID prompt, so nothing was sent; ${phone}`);
    const { outcome, detail } = openMacPersonSession({ origin: state.url, reason, io });
    if (outcome !== 'confirmed') {
      throw new Refused('HUMAN_REQUIRED', `${touchIdRefusal(outcome, detail)}, so nothing was sent; ${phone}, or run it again and touch the sensor`);
    }
  }
  let identity;
  try { identity = await request({ url: state.url, token: HELD.get(io) }, '/auth/session?board=' + state.board, {}, io); }
  catch (error) {
    HELD.delete(io);
    if (error?.code !== 'AUTH_REQUIRED') throw error;
    throw new Refused('HUMAN_REQUIRED', `this Mac's person sign-in expired or was revoked; the person runs pullboard relay person on in their own terminal, or ${phone}`);
  }
  if (identity?.session?.kind !== 'session') {
    HELD.delete(io);
    throw new Refused('HUMAN_REQUIRED', `the kept Mac sign-in is not a person session; the person runs pullboard relay person on again, or ${phone}`);
  }
}
