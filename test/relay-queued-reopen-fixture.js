/** Exercise a reopen queued against a real native submission and an isolated relay. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runFixtureChild as spawnSync } from './fixture-child.js';
import { relayClientFixture } from './relay-client-fixture.js';

const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Prove that queued automatic reopens drain without relaxing the fresh-send check. */
export async function queuedAutomaticReopen(t) {
  const box = await relayClientFixture(t);
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${CLI}" "$@"\n`, { mode: 0o700 });
  /** Run Git in the isolated relay fixture and return its output. */
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: box.root, env: box.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const configPath = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, relay: { outbox: true } }));
  const conflictPath = join(box.root, 'conflict.txt');
  writeFileSync(conflictPath, 'base\n');
  git('add', 'pullboard.json', 'conflict.txt');
  git('commit', '-qm', 'chore(fixture): set up conflict base');
  const trunk = git('branch', '--show-current');
  git('switch', '-qc', 'fixture-submission');
  writeFileSync(conflictPath, 'submitted\n');
  git('commit', '-qam', 'chore(fixture): write submitted change');
  const commit = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  git('switch', '-q', trunk);
  writeFileSync(conflictPath, 'trunk\n');
  git('commit', '-qam', 'chore(fixture): write conflicting trunk');

  const modules = `
    import * as store from ${JSON.stringify(new URL('../src/board.js', import.meta.url).href)};
    import { localRecords, relayOperation, syncRelay } from ${JSON.stringify(new URL('../src/relay.js', import.meta.url).href)};
    import { computedReturnArgs } from ${JSON.stringify(new URL('../src/computed-conflict-return.js', import.meta.url).href)};
    import { transport } from ${JSON.stringify(new URL('../src/relay-conflict-record.js', import.meta.url).href)};
    import { createHash } from 'node:crypto';
    const root = process.cwd();
  `;
  const setup = await box.script(modules + `
    const item = localRecords(root, board => {
      const lane = ${JSON.stringify(box.lane)};
      const agentId = 'coordinator';
      const id = store.addItem(board, { by: agentId, lane, title: 'Conflicting submission', criterion: 'Return for merge' });
      store.claim(board, id, { agentId, lane, leaseMs: 3600000, freeze: () => {
        const text = '{"title":"Conflicting submission"}';
        return { text, digest: createHash('sha256').update(text).digest('hex') };
      } });
      store.submit(board, id, { agentId, commit: '${commit}', tree: '${tree}',
        submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'fixture' } });
      return id;
    });
    console.log(JSON.stringify({item}));
  `);
  assert.equal(setup.code, 0, setup.failure);
  const id = setup.document.item;
  await box.link();
  await box.stopRelay();
  const offline = await box.script(modules + `
    const args = localRecords(root, board => computedReturnArgs(board, [${id}, { agentId: 'coordinator', automaticConflict: true }]));
    const io = { cwd: root, say() {}, err() {}, relayOutbox: () => true };
    await relayOperation(root, 'reopen', args, io);
    const itemStatus = localRecords(root, board => store.getItem(board, ${id}).item_status);
    let freshRefusal;
    try { transport(root, { operation: 'reopen', args }, localRecords, () => {}); }
    catch (error) { freshRefusal = error.code; }
    console.log(JSON.stringify({itemStatus, freshRefusal}));
  `);
  assert.equal(offline.code, 0, offline.failure);
  assert.deepEqual(offline.document, { itemStatus: 'open', freshRefusal: 'COORDINATOR_ONLY' });
  const later = 'queued after the locally applied automatic reopen';
  assert.equal((await box.cli('shout', 'all', later)).code, 0);
  const waiting = await box.cli('status');
  assert.deepEqual(waiting.document.relay.outbox.map(move => move.operation), ['reopen', 'shout']);
  await box.restartRelay();
  const synced = await box.script(modules + `
    const diagnostics = [];
    const result = await syncRelay(root, { cwd: root, say() {}, err: line => diagnostics.push(line) });
    console.log(JSON.stringify({ outbox: result.outbox, refusals: result.outboxRefusals, diagnostics }));
  `);
  assert.equal(synced.code, 0, synced.failure);
  assert.equal(synced.document.outbox, undefined, synced.document.diagnostics.join('\n') || 'sync drains both moves');
  assert.deepEqual(synced.document.refusals ?? [], [], 'the relay ordered both moves without replay refusals');
  const exported = await box.cli('export');
  assert.equal(exported.document.tables.item.find(item => item.item_id === id).item_status, 'open');
  assert.equal(exported.document.tables.shout.filter(shout => shout.shout_text === later).length, 1);
}
