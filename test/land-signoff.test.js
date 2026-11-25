/** A landing amend the sign-off hook refuses names the missing maintainer address and blocks the batch [C1,C7,B3]. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { createE2eHelpers } from './e2e-helpers.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project, commitFile } = e2e;

/** Read the recorded landing batches through the production board functions, in this private fixture only. */
function batches(box) {
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return store.landingBatches(board); } finally { store.closeBoard(board); }
}

/** Commit a maintainers list on main as the member author, and publish it to origin. */
function setMaintainers(box, maintainers) {
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.maintainers = maintainers;
  config.lanes.web.owns = [...new Set([...config.lanes.web.owns, 'src/'])];
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: set the maintainers');
  box.git(box.repo, 'push', '-q', 'origin', 'main');
}

/** Act as a git author outside the maintainers list, as the landing machine's identity did on 2026-11-25. */
function asLander(box) {
  Object.assign(box.env, { GIT_AUTHOR_NAME: 'Landing Person', GIT_AUTHOR_EMAIL: 'lander@example.com',
    GIT_COMMITTER_NAME: 'Landing Person', GIT_COMMITTER_EMAIL: 'lander@example.com' });
}

/** Act as the member author every fixture commit starts with. */
function asMember(box) {
  Object.assign(box.env, { GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' });
}

test('a refused landing amend names the author missing from maintainers and blocks the batch [C1,C7,B3]', { timeout: 120_000 }, // budget: one private item landed twice through real hooks; hang ceiling only.
() => {
  const box = project('true');
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  setMaintainers(box, ['agent@example.com']);
  // A landed engine already exists, so the item's unnumbered engine is numbered by amending its landing merge.
  const landed = commitFile(box, box.repo, 'src/base-engine.js', '/** The landed base engine. */\nexport const BASE_ENGINE = 80;\n', 'chore: a landed engine');
  assert.equal(landed.status, 0, landed.stderr);
  box.git(box.repo, 'push', '-q', 'origin', 'main');

  const review = join(box.dir, 'review');
  box.git(box.repo, 'worktree', 'add', '-q', review, '-b', 'api/review');
  assert.equal(box.run(review, 'join', 'api').code, 0);
  const added = box.run(box.repo, 'add', 'web', 'Add the alpha engine', '--specs', 'G1', '--criterion', 'the alpha engine exists',
    '--check', 'test -f src/alpha-engine.js', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  assert.equal(box.run(box.web, 'claim', String(id)).code, 0);
  const leaf = "/** The alpha engine. */\nimport { unassignedEngine } from './engine-next.js';\nexport const ALPHA_ENGINE = unassignedEngine();\n";
  const built = commitFile(box, box.web, 'src/alpha-engine.js', leaf, 'feat(web): add the alpha engine [G1]');
  assert.equal(built.status, 0, built.stderr);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const submitted = box.run(box.web, 'submit', String(id));
  assert.equal(submitted.code, 0, submitted.err);
  box.git(review, 'switch', '-q', '--detach', commit);
  const verdict = box.run(review, 'verify', String(id), 'accept', '--note', 'the alpha engine exists at the submitted commit');
  assert.equal(verdict.code, 0, verdict.err);

  // The item's own commits are by a maintainer, so the merge passes; the amend is the lander's own commit.
  asLander(box);
  const refused = box.run(box.repo, 'land', '--json');
  assert.equal(refused.code, 1, refused.out + refused.err);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'LAND_SIGNOFF', JSON.stringify(error));
  assert.match(error.message, /lander@example\.com/u, 'the refusal shows the address missing from maintainers');
  assert.match(error.message, /maintainers in pullboard\.json/u, 'the refusal says where to add it');
  assert.match(error.message, /pullboard land/u, 'the refusal names the step after adding it');
  assert.match(error.next, /maintainers in pullboard\.json on main to include "lander@example\.com", then run pullboard land/u,`the next step is the concrete fix: ${error.next}`);
  const [batch] = batches(box);
  assert.equal(batch.state, 'blocked', 'the refused batch is not left merging');
  assert.equal(box.tryGit(box.repo, 'merge-base', '--is-ancestor', commit, 'main').status, 1, 'nothing landed');

  // Taking the named step lands the item on the next run.
  asMember(box);
  setMaintainers(box, ['agent@example.com', 'lander@example.com']);
  asLander(box);
  const retried = box.run(box.repo, 'land', '--json');
  assert.equal(retried.code, 0, retried.out + retried.err);
  assert.deepEqual(JSON.parse(retried.out).landed, [id]);
  assert.match(box.git(box.repo, 'show', 'main:src/alpha-engine.js'), /ALPHA_ENGINE = 81;/u, 'the amend numbered the engine');
});
