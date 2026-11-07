/** Cheap filesystem observation of the primary or retained trunk [E8,A2]. */
import {
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { plainLocalConfigValue } from './git.js';
import { trunkRef } from './trusted-policy-read.js';

/** Invalidate a retained branch lookup only when its local configuration changes. */
function fileMarkerForPath(path) {
  try {
    const stat = statSync(path);
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'missing';
    throw error;
  }
}

const TRUNK_REVISION_READERS = new Map();

/** Watch the primary trunk ref even when this served worktree's HEAD remains fixed [E8]. */
export function trunkRevisionReader(info) {
  const cached = TRUNK_REVISION_READERS.get(info.commonDir);
  if (cached) return cached;
  let retainedMarker = null;
  let retained = null;
  /** Read loose or packed refs without spawning Git in every event-stream poll. */
  const read = () => readTrunkRevision(info.commonDir, () => {
    const marker = fileMarkerForPath(join(info.commonDir, 'config'));
    if (marker !== retainedMarker) { retained = trunkRef(info.root); retainedMarker = marker; }
    return retained;
  });
  TRUNK_REVISION_READERS.set(info.commonDir, read);
  while (TRUNK_REVISION_READERS.size > 32) TRUNK_REVISION_READERS.delete(TRUNK_REVISION_READERS.keys().next().value);
  return read;
}

/**
 * The trunk revision read from files alone, for a poller that must start no Git process: a detached primary's retained
 * trunk comes from a plain local config entry, and a config only Git can read leaves it unknown (null) [C7].
 */
export function fileTrunkRevision(commonDir) {
  return readTrunkRevision(commonDir, () => plainLocalConfigValue(commonDir, 'pullboard', 'trunk') ?? null);
}

/** Read the primary's branch, or the retained trunk when it is detached, from loose or packed refs. */
function readTrunkRevision(commonDir, retainedRef) {
  const head = readFileSync(join(commonDir, 'HEAD'), 'utf8').trim();
  const ref = /^ref: (refs\/heads\/.+)$/u.exec(head)?.[1] ?? retainedRef();
  if (!ref?.startsWith('refs/heads/') || ref.includes('\\') || ref.split('/').some(part => !part || part === '.' || part === '..')) return null;
  try { return readFileSync(join(commonDir, ref), 'utf8').trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    return readFileSync(join(commonDir, 'packed-refs'), 'utf8').split('\n')
      .find(line => line.endsWith(' ' + ref))?.split(' ')[0] ?? null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
