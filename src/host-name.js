// This computer's own name and how to search text for it. Submit's HOST_NAME check (src/hooks.js) and the
// privacy-words test both read the name from here, so the two cannot drift apart (C1, C7).

import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';

/**
 * Host names that are ordinary words or vendor defaults. They name no one, so they are not private, and as a search
 * pattern they would match ordinary prose ("Mac" is in hundreds of tracked lines, and in every "machine").
 */
export const GENERIC_HOSTS = new Set(['localhost', 'mac', 'imac', 'macmini', 'host', 'server', 'desktop', 'laptop', 'computer',
  'pc', 'workstation', 'ubuntu', 'debian', 'fedora', 'linux', 'raspberrypi', 'runner', 'box', 'node', 'machine']);

/**
 * This computer's own name. On macOS that is `scutil --get LocalHostName`: os.hostname() there falls back to whatever
 * name the current network hands out by reverse DNS (for example "Mac.<isp>.com"), so it changes with the network and
 * is often a common word. Elsewhere, or when scutil fails or prints nothing, os.hostname().
 *
 * @param {{ platform?: string, localHostName?: () => string, osHostname?: () => string }} [sources] - stand-ins for tests
 * @returns {string}
 */
export function machineName({ platform = process.platform, localHostName = scutilLocalHostName, osHostname = hostname } = {}) {
  if (platform === 'darwin') {
    try {
      const name = localHostName().trim();
      if (name) return name;
    } catch { /* scutil missing or slow: fall back below */ }
  }
  return osHostname();
}

/**
 * The macOS LocalHostName, read with a short timeout so a stalled scutil cannot hang a submit or a test.
 *
 * @returns {string}
 */
export function scutilLocalHostName() {
  return execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * Whether a name is distinctive enough to search for: at least 3 characters and not one of GENERIC_HOSTS. A common
 * word is not a private name, and searching for it would refuse or report every ordinary use of the word.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function distinctiveName(name) {
  const trimmed = String(name ?? '').trim();
  return trimmed.length >= 3 && !GENERIC_HOSTS.has(trimmed.toLowerCase());
}

/**
 * A case-insensitive pattern that finds a name only as a whole word, so "mac" would not match inside "machine".
 * The edges are "not a letter, digit or underscore" rather than \b, so a name that starts or ends with punctuation
 * still matches where it stands alone.
 *
 * @param {string} name
 * @returns {RegExp}
 */
export function wholeWord(name) {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${literal(name)}(?![\\p{L}\\p{N}_])`, 'iu');
}

/**
 * The 'this host name' rule for a host, or none. The short name (before the first dot) becomes a whole-word pattern
 * when it is distinctive; a name under 3 characters or in GENERIC_HOSTS gets no rule. Every other name keeps its rule,
 * so a distinctive name is never dropped; only that fixed list of common words is.
 *
 * @param {string} host
 * @returns {{ name: string, pattern: RegExp }[]}
 */
export function hostRule(host) {
  const short = String(host ?? '').split('.')[0];
  if (!distinctiveName(short)) return [];
  return [{ name: 'this host name', pattern: wholeWord(short) }];
}

/**
 * Escape text for use inside a regular expression.
 *
 * @param {string} text
 * @returns {string}
 */
function literal(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
