/**
 * The person's own Mac as a person channel on a relay-linked board [B26,H16]. The relay already
 * records any move sent with a GitHub person session as the person's, as it does for the phone,
 * so no relay change is needed: this Mac keeps one person session, from a sign-in the person
 * makes in their own terminal, and sends a person move with it.
 *
 * Why the keychain, with no trusted app: an agent runs as the same user, so any file or
 * environment variable the person's commands can read, an agent can read too. A login-keychain
 * item that trusts no application makes macOS ask the person, with their login password, before
 * every read, and the session never sits in a file, an argument list or the link file.
 */
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import { requirePersonChannel } from './person.js';
import { policyOn } from './policy-settings.js';
import { Refused } from './refused.js';

/** The keychain service the person session is kept under; the account is the relay origin. */
export const PERSON_KEYCHAIN_SERVICE = 'pullboard-relay-person';

/** How long a person may take to answer the macOS keychain prompt. */
const PROMPT_MS = 120_000;

const SESSION = /^ps_[A-Za-z0-9_-]{43}$/u;

/** The person session one command holds for its own person move, never shared with a later command. */
const HELD = new WeakMap();

/** The session this command's person move may send with, or undefined. */
export function heldPersonSession(io) {
  return io && typeof io === 'object' ? HELD.get(io) : undefined;
}

/** Whether a macOS keychain is reachable through the system `security` tool. */
export function keychainAvailable() {
  if (process.platform !== 'darwin') return false;
  const probe = spawnSync('security', ['list-keychains'], { encoding: 'utf8', timeout: 5000 });
  return probe.status === 0;
}

/** Whether this Mac keeps a person sign-in for this relay; reads attributes only, so macOS asks nothing. */
export function macPersonSignedIn(origin) {
  if (!keychainAvailable()) return false;
  return spawnSync('security', ['find-generic-password', '-s', PERSON_KEYCHAIN_SERVICE, '-a', origin], { encoding: 'utf8', timeout: 5000 }).status === 0;
}

/**
 * Keep the person session in the login keychain, trusting no app. The secret goes over stdin to
 * `security -i`, never in an argument list another process could read.
 */
export function storeMacPersonSession(origin, token) {
  if (!SESSION.test(token ?? '')) throw new Refused('RELAY_RESPONSE', 'the relay did not issue a person session; sign in again');
  if (!keychainAvailable()) {
    throw new Refused('RELAY_KEYCHAIN', 'only a Mac login keychain keeps the person sign-in, and none is available here; send person moves from the paired phone');
  }
  const removed = spawnSync('security', ['delete-generic-password', '-s', PERSON_KEYCHAIN_SERVICE, '-a', origin], { encoding: 'utf8', timeout: 5000 });
  if (![0, 44].includes(removed.status)) throw new Refused('RELAY_KEYCHAIN', 'unlock the login keychain, then run pullboard relay person on again');
  const command = `add-generic-password -s ${PERSON_KEYCHAIN_SERVICE} -a "${origin}" -l "Pullboard person sign-in" -T "" -w ${token}\n`;
  const added = spawnSync('security', ['-i'], { input: command, encoding: 'utf8', timeout: 15000 });
  if (added.status !== 0 || !macPersonSignedIn(origin)) {
    throw new Refused('RELAY_KEYCHAIN', 'the login keychain did not keep the person sign-in; unlock it and run pullboard relay person on again');
  }
}

/** Forget this Mac's person sign-in for the relay. Returns whether one was kept. */
export function forgetMacPersonSession(origin) {
  if (!keychainAvailable()) return false;
  const removed = spawnSync('security', ['delete-generic-password', '-s', PERSON_KEYCHAIN_SERVICE, '-a', origin], { encoding: 'utf8', timeout: 5000 });
  if (removed.status === 44) return false;
  if (removed.status !== 0) throw new Refused('RELAY_KEYCHAIN', 'unlock the login keychain, then run pullboard relay person off again');
  return true;
}

/** Read the session; macOS asks the person to allow it. Resolves undefined when none is kept, the person declines, or there is no screen to ask on. */
function readMacPersonSession(origin) {
  return new Promise((resolve) => {
    const child = spawn('security', ['find-generic-password', '-s', PERSON_KEYCHAIN_SERVICE, '-a', origin, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), PROMPT_MS);
    child.stdout.setEncoding('utf8').on('data', (part) => { output += part; });
    child.once('error', () => { clearTimeout(timer); resolve({ status: null }); });
    child.once('close', (status) => { clearTimeout(timer); resolve({ status, token: output.trim() }); });
  });
}

/** The person channel a move carries in its arguments, if any. */
function moveChannel(args) {
  return (Array.isArray(args) ? args : []).find((arg) => arg && typeof arg === 'object' && typeof arg.channel === 'string')?.channel;
}

/**
 * Let one command send its person move as the person from this Mac, or refuse it. Refuses while the
 * board keeps person moves on the phone (policy.personPhoneOnly), refuses an agent's terminal exactly
 * as an unlinked board does (B26_PERSON_CHANNEL), then asks macOS for the kept session, which shows
 * the person a prompt. The session is held for this command's io only.
 *
 * @param {{ root: string, state: { url: string, board: string }, args: any[], io: object, localRecords: Function, request: Function }} options
 */
export async function holdMacPersonSession({ root, state, args, io, localRecords, request }) {
  const phone = 'send this person action from the paired phone';
  const { phoneOnly, touchId } = localRecords(root, (board) => ({ phoneOnly: policyOn(board, 'personPhoneOnly'), touchId: policyOn(board, 'personTouchId') }));
  if (phoneOnly) throw new Refused('HUMAN_REQUIRED', `${phone}; this board turned policy.personPhoneOnly on`);
  // Touch ID (policy.personTouchId) already confirmed this move in its command; every other channel is checked as on an unlinked board.
  if (!(moveChannel(args) === 'touchid' && touchId)) requirePersonChannel(io?.personChannel);
  if (!keychainAvailable() || !macPersonSignedIn(state.url)) {
    throw new Refused('HUMAN_REQUIRED', `${phone}, or sign this Mac in for person moves: the person runs pullboard relay person on in their own terminal`);
  }
  const { status, token } = await readMacPersonSession(state.url);
  if (status !== 0 || !SESSION.test(token ?? '')) {
    throw new Refused('HUMAN_REQUIRED', `macOS did not release the person sign-in (declined, timed out, or no screen to ask on), so nothing was sent; ${phone}, or allow the keychain prompt on this Mac`);
  }
  let identity;
  try { identity = await request({ url: state.url, token }, '/auth/session?board=' + state.board, {}, io); }
  catch (error) {
    if (error?.code !== 'AUTH_REQUIRED') throw error;
    throw new Refused('HUMAN_REQUIRED', `this Mac's person sign-in expired or was revoked; the person runs pullboard relay person on in their own terminal, or ${phone}`);
  }
  if (identity?.session?.kind !== 'session') throw new Refused('HUMAN_REQUIRED', `the kept Mac sign-in is not a person session; the person runs pullboard relay person on again, or ${phone}`);
  HELD.set(io, token);
}
