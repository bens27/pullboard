/**
 * Touch ID as a person channel [B26]: with policy.personTouchId on, a person-only move typed into an
 * agent's terminal proceeds only after the Mac's fingerprint sensor confirms it. An environment marker
 * or a flag cannot tell the person from the agent, since the agent can set either; only the person can
 * touch the sensor. Biometrics only, never the account password, which an agent could type by script.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  join,
} from 'node:path';
import { userInfo } from 'node:os';
import {
  AGENT_SHELL_MARKERS,
  remoteShell,
  requirePersonChannel,
} from './person.js';
import {
  policyOn,
  TOUCH_ID_CHANNEL,
} from './policy-settings.js';
import {
  closeBoard,
  openBoardForRead,
} from './board.js';
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
 * The Swift helper, three modes and nothing else; run with no mode it exits 64 without prompting.
 *   confirm <reason>  one biometric evaluation with the reason Pullboard wrote; prints "confirmed".
 *   seal              reads a relay person session on stdin and prints it sealed to a new Secure Enclave key
 *                     whose use needs the current enrolled fingerprints; sealing needs only the public key,
 *                     so it never prompts.
 *   open <reason>     reads a sealed session on stdin, asks for one fingerprint with the reason, and only
 *                     then can the Secure Enclave unwrap it; prints the session.
 * Why a Secure Enclave key rather than a biometry-protected keychain item: SecAccessControl biometry needs
 * the data protection keychain, which needs a keychain-access-groups entitlement and so a provisioning
 * profile that a swiftc-built, ad-hoc-signed helper cannot have. A Secure Enclave key needs no keychain:
 * its wrapped form is useless off this Mac's enclave, and the enclave uses it only after a fingerprint.
 * Biometry only (.biometryCurrentSet): no passcode or password fallback, and a newly enrolled finger
 * voids the key. Exit 0 on success; 2 cancelled, 3 no usable biometrics, 1 any other failure, 64 bad usage.
 */
export const TOUCH_ID_SWIFT = `import Foundation
import CryptoKit
import LocalAuthentication
import Security

let args = CommandLine.arguments
guard args.count >= 2, ["confirm", "seal", "open"].contains(args[1]), args.count == (args[1] == "seal" ? 2 : 3) else { exit(64) }
let mode = args[1]
func fail(_ text: String, _ code: Int32) -> Never {
  FileHandle.standardError.write((text + "\\n").data(using: .utf8)!)
  exit(code)
}
func exitFor(_ error: NSError?) -> Never {
  let code = error.map { LAError.Code(rawValue: $0.code) } ?? nil
  switch code {
  case .some(.userCancel), .some(.systemCancel), .some(.appCancel), .some(.userFallback): fail(error?.localizedDescription ?? "cancelled", 2)
  case .some(.biometryNotAvailable), .some(.biometryNotEnrolled), .some(.biometryLockout): fail(error?.localizedDescription ?? "biometrics unavailable", 3)
  default: fail(error?.localizedDescription ?? "not confirmed", 1)
  }
}
let context = LAContext()
context.localizedFallbackTitle = ""
var problem: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &problem) else {
  fail(problem?.localizedDescription ?? "biometrics unavailable", 3)
}
var accessError: Unmanaged<CFError>?
guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &accessError) else {
  fail("could not describe the fingerprint-only key", 1)
}
let salt = Data("pullboard-relay-person-v1".utf8)
func wrapKey(_ shared: SharedSecret, _ ephemeral: Data, _ recipient: Data) -> SymmetricKey {
  shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt, sharedInfo: ephemeral + recipient, outputByteCount: 32)
}
func wait(_ start: (@escaping (Bool, Error?) -> Void) -> Void) {
  let done = DispatchSemaphore(value: 0)
  var confirmed = false
  var failure: NSError?
  start { success, error in confirmed = success; failure = error as NSError?; done.signal() }
  done.wait()
  if !confirmed { exitFor(failure) }
}
switch mode {
case "confirm":
  wait { context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: args[2], reply: $0) }
  print("confirmed")
case "seal":
  guard SecureEnclave.isAvailable else { fail("this Mac has no Secure Enclave", 3) }
  let token = FileHandle.standardInput.readDataToEndOfFile()
  guard !token.isEmpty, token.count < 4096 else { fail("nothing to seal", 64) }
  do {
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
    let ephemeral = P256.KeyAgreement.PrivateKey()
    let recipient = key.publicKey.x963Representation
    let shared = try ephemeral.sharedSecretFromKeyAgreement(with: key.publicKey)
    let box = try AES.GCM.seal(token, using: wrapKey(shared, ephemeral.publicKey.x963Representation, recipient))
    let sealed: [String: Any] = ["v": 1, "key": key.dataRepresentation.base64EncodedString(), "ephemeral": ephemeral.publicKey.x963Representation.base64EncodedString(), "box": box.combined!.base64EncodedString()]
    print(String(data: try JSONSerialization.data(withJSONObject: sealed), encoding: .utf8)!)
  } catch { fail("could not seal the session: \\(error)", 1) }
default:
  let input = FileHandle.standardInput.readDataToEndOfFile()
  guard let sealed = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any], sealed["v"] as? Int == 1,
        let keyData = Data(base64Encoded: sealed["key"] as? String ?? ""),
        let ephemeralData = Data(base64Encoded: sealed["ephemeral"] as? String ?? ""),
        let boxData = Data(base64Encoded: sealed["box"] as? String ?? "") else { fail("the kept sign-in is unreadable", 1) }
  wait { context.evaluateAccessControl(access, operation: .useKeyKeyExchange, localizedReason: args[2], reply: $0) }
  do {
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: keyData, authenticationContext: context)
    let shared = try key.sharedSecretFromKeyAgreement(with: try P256.KeyAgreement.PublicKey(x963Representation: ephemeralData))
    let token = try AES.GCM.open(try AES.GCM.SealedBox(combined: boxData), using: wrapKey(shared, ephemeralData, key.publicKey.x963Representation))
    FileHandle.standardOutput.write(token)
  } catch { fail("the Secure Enclave did not release the sign-in: \\(error)", 1) }
}
exit(0)
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
 * @param {{ command: 'spec approve'|'spec decline'|'spec answer'|'check accept'|'sentinel approve'|'sentinel decline'|'person move', ids: string[], text?: string }} action
 * @returns {string}
 */
export function touchIdReason({ command, ids = [], text }) {
  const phrases = {
    'spec approve': 'approve spec rows',
    'spec decline': 'decline spec rows',
    'spec answer': 'answer spec question',
    'spec signoff': 'sign off spec rows',
    'check accept': 'accept the check of item',
    'sentinel approve': 'approve sentinel',
    'sentinel decline': 'decline sentinel',
    'person move': 'send the person move',
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

/** Run the compiled helper once; the one seam tests replace, through useTouchIdHelper, never through the environment. */
function spawnHelper(args, input) {
  let helper;
  try { helper = compiledHelper(); } catch (error) { return { status: 3, stderr: error.message }; }
  if (!helper) return { status: 3, stderr: 'the Touch ID helper could not be built; install the Xcode command line tools with xcode-select --install' };
  const run = spawnSync(helper, args, { env: sealedEnvironment(), encoding: 'utf8', timeout: TOUCH_ID_TIMEOUT_MS, input: input ?? '', stdio: ['pipe', 'pipe', 'pipe'] });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', timedOut: run.error?.code === 'ETIMEDOUT' || Boolean(run.signal) };
}

let helperRunner = spawnHelper;

/**
 * Replace the helper for a test process (a preload or the test itself); returns the restore step. An agent that
 * can load code into Pullboard can already rewrite it, and a stand-in helper still cannot unwrap a session that
 * the real Secure Enclave sealed.
 *
 * @param {(args: string[], input?: string) => { status: number|null, stdout?: string, stderr?: string, timedOut?: boolean }} runner
 */
export function useTouchIdHelper(runner) {
  const before = helperRunner;
  helperRunner = runner;
  return () => { helperRunner = before; };
}

/** Name a helper result: 'confirmed', 'cancelled', 'unavailable', 'timeout' or 'failed'. */
function helperOutcome(run) {
  if (run.timedOut) return { outcome: 'timeout' };
  const detail = (run.stderr ?? '').trim() || undefined;
  if (run.status === 0) return { outcome: 'confirmed', detail };
  return { outcome: run.status === 2 ? 'cancelled' : run.status === 3 ? 'unavailable' : 'failed', detail };
}

/**
 * Ask the sensor, synchronously. Only 'confirmed' lets the move proceed.
 *
 * @param {string} reason - the prompt touchIdReason wrote
 * @returns {{ outcome: string, detail?: string }}
 */
export function runTouchIdHelper(reason) {
  const run = helperRunner(['confirm', reason]);
  const result = helperOutcome(run);
  return result.outcome === 'confirmed' && String(run.stdout ?? '').trim() !== 'confirmed' ? { outcome: 'failed' } : result;
}

/** Seal a relay person session to a new fingerprint-only Secure Enclave key; never prompts. Returns the sealed text, or a refusal outcome. */
export function sealWithTouchId(token) {
  const run = helperRunner(['seal'], token);
  const result = helperOutcome(run);
  if (result.outcome !== 'confirmed') return result;
  return { outcome: 'confirmed', sealed: String(run.stdout ?? '').trim() };
}

/** Unwrap a sealed person session with one fingerprint, prompting with the reason Pullboard wrote. */
export function openWithTouchId(reason, sealed) {
  const run = helperRunner(['open', reason], sealed);
  const result = helperOutcome(run);
  if (result.outcome !== 'confirmed') return result;
  return { outcome: 'confirmed', token: String(run.stdout ?? '') };
}

/** The person action a command named for this io's person move, so the fingerprint prompt says exactly what it sends. */
const PERSON_ACTIONS = new WeakMap();

/** The action personChannelCheck recorded for this command's person move, if any. */
export function personActionFor(io) {
  return io && typeof io === 'object' ? PERSON_ACTIONS.get(io) : undefined;
}

/** Why a helper outcome refused, in the person's words. */
export function touchIdRefusal(outcome, detail) {
  const why = { cancelled: 'the Touch ID prompt was cancelled', unavailable: 'Touch ID is not available on this Mac', timeout: `nobody touched the sensor within ${TOUCH_ID_TIMEOUT_MS / 1000} seconds` }[outcome] ?? 'Touch ID did not confirm it';
  return `${why}${detail ? ` (${detail.replace(/[\p{C}]/gu, ' ').slice(0, 120)})` : ''}`;
}

/**
 * Check the channel a person move arrives on where the command checked it before, and return a confirm
 * step the command runs just before it records the move, after its other checks, so the person is
 * never asked to touch the sensor for a move that would be refused anyway. The person's own terminal
 * and the view pass as before. In an agent's local terminal on a board with policy.personTouchId on, a
 * Mac asks for the person's fingerprint and the move carries the touchid channel; every other case
 * refuses exactly as before.
 *
 * On a relay-linked board the fingerprint is the one that unwraps this Mac's person sign-in
 * (src/relay-mac-person.js), with the same prompt, so the move needs exactly one touch. It refuses
 * before any prompt while the board keeps person moves on the phone (policy.personPhoneOnly) or this Mac
 * holds no person sign-in.
 *
 * @param {any} board
 * @param {string | undefined} channel - io.personChannel
 * @param {{ action: Parameters<typeof touchIdReason>[0], command?: string, root?: string, io?: object, linked?: (root: string) => Promise<{ url?: string } | null>, macPerson?: { macPersonSignedIn: (origin: string) => boolean, openMacPersonSession: (options: object) => { outcome: string, detail?: string } }, environment?: Record<string, string | undefined>, platform?: string, confirm?: (reason: string) => { outcome: string, detail?: string } }} options
 * @returns {{ confirm: () => Promise<string> }}
 */
export function personChannelCheck(board, channel, { action, command, root, io, linked = relayLink, macPerson, environment = process.env, platform = process.platform, confirm = runTouchIdHelper }) {
  try {
    const own = requirePersonChannel(channel, environment, { command });
    if (io && typeof io === 'object') PERSON_ACTIONS.set(io, action);
    return { confirm: async () => own };
  } catch (error) {
    if (error?.code !== 'B26_PERSON_CHANNEL' || !touchIdCandidate(channel, environment) || !policyOn(board, 'personTouchId')) throw error;
  }
  if (platform !== 'darwin') throw new Refused('B26_PERSON_CHANNEL', 'this terminal belongs to an agent, and policy.personTouchId confirms with Touch ID only on macOS; run pullboard view, the person’s channel, and let the person act there');
  const reason = touchIdReason(action);
  return { confirm: async () => {
    const link = await linked(root);
    if (link) {
      const phone = 'send it from the paired phone, or let the person act in their own terminal or pullboard view';
      if (policyOn(board, 'personPhoneOnly')) throw new Refused('HUMAN_REQUIRED', `this board turned policy.personPhoneOnly on, so a person move goes only from the paired phone; no prompt was shown`);
      const mac = macPerson ?? await import('./relay-mac-person.js');
      if (!link.url || !io || !mac.macPersonSignedIn(link.url)) {
        throw new Refused('HUMAN_REQUIRED', `this board is linked to the relay and this Mac holds no person sign-in, so no prompt was shown; ${phone}, or the person runs pullboard relay person on in their own terminal`);
      }
      const { outcome, detail } = mac.openMacPersonSession({ origin: link.url, reason, io });
      if (outcome === 'confirmed') return TOUCH_ID_CHANNEL;
      throw new Refused('B26_PERSON_CHANNEL', `this terminal belongs to an agent and ${touchIdRefusal(outcome, detail)}; nothing was sent. Run it again and touch the sensor, or ${phone}`);
    }
    const { outcome, detail } = confirm(reason);
    if (outcome === 'confirmed') return TOUCH_ID_CHANNEL;
    throw new Refused('B26_PERSON_CHANNEL', `this terminal belongs to an agent and ${touchIdRefusal(outcome, detail)}; nothing was recorded. Run it again and touch the sensor, or let the person act in pullboard view`);
  } };
}

/** This checkout's relay link, read only once a Touch ID prompt is due, so other commands never load the relay module; a recovery without a link names no origin. */
async function relayLink(root) {
  if (!root) return {};
  const relay = await import('./relay.js');
  if (relay.relayLinked(root)) return { url: relay.relayLinkOrigin(root) };
  return relay.relayRecovered(root) ? {} : null;
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
