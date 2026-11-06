/**
 * Touch ID as a person channel [B26]: with policy.personTouchId on, a person-only move typed into an
 * agent's terminal proceeds only after the Mac's fingerprint sensor confirms it. An environment marker
 * or a flag cannot tell the person from the agent, since the agent can set either; only the person can
 * touch the sensor. Biometrics only, never the account password, which an agent could type by script.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { userInfo } from 'node:os';
import { AGENT_SHELL_MARKERS, remoteShell, requirePersonChannel } from './person.js';
import { policyOn, TOUCH_ID_CHANNEL } from './policy-settings.js';
import { closeBoard, openBoardForRead } from './board.js';
import { Refused } from './refused.js';

export { TOUCH_ID_CHANNEL };

/** How long the person has to touch the sensor before the move is refused. */
export const TOUCH_ID_TIMEOUT_MS = 60_000;

/** An id the prompt may name: row ids, doctrine ids, item numbers, sentinel names. Anything else is refused, never shown. */
const SAFE_ID = /^#?[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/u;

/** The most ids one prompt names, so the person can read every one of them. */
const MAX_IDS = 20;

/** The longest quoted text (an answer, a replacement row text) a prompt shows in full. */
const MAX_TEXT = 160;

/**
 * The Swift helper: one biometric evaluation with the reason Pullboard wrote. Exit 0 and "confirmed"
 * only on success; 2 cancelled, 3 no usable biometrics, 1 any other failure, 64 bad usage.
 */
export const TOUCH_ID_SWIFT = `import Foundation
import LocalAuthentication

guard CommandLine.arguments.count == 2 else { exit(64) }
let context = LAContext()
context.localizedFallbackTitle = ""
var problem: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &problem) else {
  FileHandle.standardError.write(((problem?.localizedDescription ?? "biometrics unavailable") + "\\n").data(using: .utf8)!)
  exit(3)
}
let done = DispatchSemaphore(value: 0)
var confirmed = false
var failure: NSError?
context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: CommandLine.arguments[1]) { success, error in
  confirmed = success
  failure = error as NSError?
  done.signal()
}
done.wait()
if confirmed { print("confirmed"); exit(0) }
FileHandle.standardError.write(((failure?.localizedDescription ?? "not confirmed") + "\\n").data(using: .utf8)!)
let code = failure.map { LAError.Code(rawValue: $0.code) } ?? nil
switch code {
case .some(.userCancel), .some(.systemCancel), .some(.appCancel), .some(.userFallback): exit(2)
case .some(.biometryNotAvailable), .some(.biometryNotEnrolled), .some(.biometryLockout): exit(3)
default: exit(1)
}
`;

/** Whether this is an agent's local terminal, the one place Touch ID may stand in for the person's own. */
export function touchIdCandidate(channel = 'terminal', environment = process.env) {
  return channel === 'terminal' && AGENT_SHELL_MARKERS.some((name) => Boolean(environment[name])) && !remoteShell(environment);
}

/** Strip control and format characters (bidi overrides included) and quote the result, so text an agent wrote reads as data. */
function quoted(text) {
  const plain = String(text).replace(/[\p{C}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (plain.length > MAX_TEXT) throw new Refused('B26_PERSON_CHANNEL', `this text is too long to show in a Touch ID prompt (over ${MAX_TEXT} characters); make this move in pullboard view or the person's own terminal`);
  return JSON.stringify(plain);
}

/**
 * Write the prompt from Pullboard's own words: a fixed verb phrase for the command, then ids that pass
 * a strict pattern and any quoted text. Row text and notes never reach it.
 *
 * @param {{ command: 'spec approve'|'spec decline'|'spec answer'|'check accept'|'sentinel approve'|'sentinel decline', ids: string[], text?: string }} action
 * @returns {string}
 */
export function touchIdReason({ command, ids = [], text }) {
  const phrases = {
    'spec approve': 'approve spec rows',
    'spec decline': 'decline spec rows',
    'spec answer': 'answer spec question',
    'check accept': 'accept the check of item',
    'sentinel approve': 'approve sentinel',
    'sentinel decline': 'decline sentinel',
  };
  if (!Object.hasOwn(phrases, command)) throw new Refused('B26_PERSON_CHANNEL', 'Touch ID confirms only spec, check and sentinel decisions; use pullboard view or the person\'s own terminal');
  if (!ids.length || ids.length > MAX_IDS || !ids.every((id) => SAFE_ID.test(String(id)))) {
    throw new Refused('B26_PERSON_CHANNEL', `a Touch ID prompt names 1 to ${MAX_IDS} plain ids; make this move in pullboard view or the person's own terminal`);
  }
  const what = `${phrases[command]} ${ids.join(', ')}`;
  return `Pullboard: ${what}${text === undefined ? '' : ` with ${quoted(text)}`} (pullboard ${command})`;
}

/** Where the compiled helper lives: the account's own cache, found from the password database rather than $HOME, which an agent can set. */
function helperPath() {
  const digest = createHash('sha256').update(TOUCH_ID_SWIFT).digest('hex').slice(0, 16);
  return join(userInfo().homedir, 'Library', 'Caches', 'pullboard', `touchid-${digest}`, 'pullboard-touchid');
}

/** A fixed environment for the compiler and helper, so neither DEVELOPER_DIR, PATH nor DYLD_* from the agent's shell reaches them. */
function sealedEnvironment() {
  return { PATH: '/usr/bin:/bin', HOME: userInfo().homedir, TMPDIR: '/tmp' };
}

/** True when a path is this account's own and nobody else can write it. */
function ownedPrivately(path) {
  const stat = lstatSync(path);
  return !stat.isSymbolicLink() && stat.uid === userInfo().uid && (stat.mode & 0o022) === 0;
}

/** Compile the helper once with the system's Swift compiler, then reuse it. Returns null when it cannot be built. */
function compiledHelper() {
  const target = helperPath();
  if (existsSync(target)) return ownedPrivately(target) && ownedPrivately(join(target, '..')) ? target : null;
  mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(target, '..', 'build-'));
  try {
    const source = join(work, 'touchid.swift');
    writeFileSync(source, TOUCH_ID_SWIFT, { mode: 0o600 });
    const built = spawnSync('/usr/bin/swiftc', ['-O', '-o', join(work, basename(target)), source], { env: sealedEnvironment(), encoding: 'utf8', timeout: 300_000 });
    if (built.status !== 0) return null;
    chmodSync(join(work, basename(target)), 0o500);
    renameSync(join(work, basename(target)), target);
    return target;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/**
 * Ask the sensor, synchronously. Returns 'confirmed', 'cancelled', 'unavailable', 'timeout' or 'failed';
 * only 'confirmed' lets the move proceed.
 *
 * @param {string} reason - the prompt touchIdReason wrote
 * @returns {{ outcome: string, detail?: string }}
 */
export function runTouchIdHelper(reason) {
  let helper;
  try { helper = compiledHelper(); } catch (error) { return { outcome: 'unavailable', detail: error.message }; }
  if (!helper) return { outcome: 'unavailable', detail: 'the Touch ID helper could not be built; install the Xcode command line tools with xcode-select --install' };
  const run = spawnSync(helper, [reason], { env: sealedEnvironment(), encoding: 'utf8', timeout: TOUCH_ID_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.error?.code === 'ETIMEDOUT' || run.signal) return { outcome: 'timeout' };
  const detail = (run.stderr ?? '').trim() || undefined;
  if (run.status === 0 && run.stdout.trim() === 'confirmed') return { outcome: 'confirmed' };
  return { outcome: run.status === 2 ? 'cancelled' : run.status === 3 ? 'unavailable' : 'failed', detail };
}

/**
 * Check the channel a person move arrives on where the command checked it before, and return a confirm
 * step the command runs just before it records the move, after its other checks, so the person is
 * never asked to touch the sensor for a move that would be refused anyway. The person's own terminal
 * and the view pass as before. In an agent's local terminal on a board with policy.personTouchId on, a
 * Mac asks for the person's fingerprint and the move carries the touchid channel; every other case
 * refuses exactly as before.
 *
 * @param {any} board
 * @param {string | undefined} channel - io.personChannel
 * On a relay-linked board the relay takes a person move only from the paired phone, whatever the local
 * channel (HUMAN_REQUIRED), so Touch ID refuses there before any prompt rather than ask for a fingerprint
 * the relay would ignore: it counts as the person only where the person's own terminal already would.
 *
 * @param {{ action: Parameters<typeof touchIdReason>[0], command?: string, root?: string, relayed?: (root: string) => Promise<boolean>, environment?: Record<string, string | undefined>, platform?: string, confirm?: (reason: string) => { outcome: string, detail?: string } }} options
 * @returns {{ confirm: () => Promise<string> }}
 */
export function personChannelCheck(board, channel, { action, command, root, relayed = relayBound, environment = process.env, platform = process.platform, confirm = runTouchIdHelper }) {
  try {
    const own = requirePersonChannel(channel, environment, { command });
    return { confirm: async () => own };
  } catch (error) {
    if (error?.code !== 'B26_PERSON_CHANNEL' || !touchIdCandidate(channel, environment) || !policyOn(board, 'personTouchId')) throw error;
  }
  if (platform !== 'darwin') throw new Refused('B26_PERSON_CHANNEL', 'this terminal belongs to an agent, and policy.personTouchId confirms with Touch ID only on macOS; run pullboard view, the person’s channel, and let the person act there');
  const reason = touchIdReason(action);
  return { confirm: async () => {
    if (await relayed(root)) {
      throw new Refused('B26_PERSON_CHANNEL', 'this terminal belongs to an agent, and this board is linked to the relay, which takes a person move only from the paired phone; Touch ID does not stand in for it, so no prompt was shown. Send it from the paired phone, or let the person act in their own terminal or pullboard view');
    }
    const { outcome, detail } = confirm(reason);
    if (outcome === 'confirmed') return TOUCH_ID_CHANNEL;
    const why = { cancelled: 'the Touch ID prompt was cancelled', unavailable: 'Touch ID is not available on this Mac', timeout: `nobody touched the sensor within ${TOUCH_ID_TIMEOUT_MS / 1000} seconds` }[outcome] ?? 'Touch ID did not confirm it';
    throw new Refused('B26_PERSON_CHANNEL', `this terminal belongs to an agent and ${why}${detail ? ` (${detail.replace(/[\p{C}]/gu, ' ').slice(0, 120)})` : ''}; nothing was recorded. Run it again and touch the sensor, or let the person act in pullboard view`);
  } };
}

/** Whether this checkout's moves go through the relay, read only once a Touch ID prompt is due, so other commands never load the relay module. */
async function relayBound(root) {
  if (!root) return true;
  const relay = await import('./relay.js');
  return relay.relayLinked(root) || Boolean(relay.relayRecovered(root));
}

/** personChannelCheck and its confirm step at once: the channel the move carries, or a refusal. */
export async function personChannelFor(board, channel, options) {
  return personChannelCheck(board, channel, options).confirm();
}

/** Whether the board at this context turned policy.personTouchId on, read without creating or migrating a board. */
export function touchIdPolicyAt(ctx) {
  const board = openBoardForRead(ctx.file, ctx.clock);
  if (!board) return false;
  try { return policyOn(board, 'personTouchId'); } finally { closeBoard(board); }
}

/**
 * The early person-channel check some commands make before they open the board. In an agent's local
 * terminal on a board that turned policy.personTouchId on, it defers to personChannelFor inside the
 * board; otherwise it refuses exactly as before.
 *
 * @param {string | undefined} channel
 * @param {() => boolean} touchIdOn - reads the board's policy; any failure counts as off
 * @param {{ command?: string, environment?: Record<string, string | undefined> }} [options]
 * @returns {boolean} true when the check is deferred to personChannelFor
 */
export function requirePersonChannelOrTouchId(channel, touchIdOn, { command, environment = process.env } = {}) {
  if (touchIdCandidate(channel, environment)) {
    let on = false;
    try { on = touchIdOn() === true; } catch { on = false; }
    if (on) return true;
  }
  requirePersonChannel(channel, environment, { command });
  return false;
}
