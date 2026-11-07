/** Turn the person's board obligations and open asks into ordered steps a panel can run [B26,N26]. */
import { stepPrompts } from './asks.js';

/** One step; personOnly steps must run in the person's own terminal because Pullboard refuses agents there. */
function step(label, command, cwd, personOnly = true) {
  return { n: 1, label, command, cwd, prompts: stepPrompts(command), personOnly, done: false };
}

/** Name the prompts the board's own commands take in words the person reads. */
const PROMPT_LABELS = { note: 'What you checked', answer: 'Your answer', by: 'Your initials', reason: 'Why you decline it' };

/** Label known prompts, keeping unknown keys readable as they are. */
function labelled(entry) {
  for (const s of entry.steps) for (const prompt of s.prompts) prompt.label = PROMPT_LABELS[prompt.key] ?? prompt.label;
  return entry;
}

/** One board need; kinds without a single command stay readable with no steps. */
// Sign-off refuses without --by, so the step asks for it, offering whoever signed last.
function signerDefault(entry, signer) {
  for (const prompt of entry.prompts) if (prompt.key === 'by') prompt.default = signer;
  return entry;
}

function boardNeed(need, root, signer = '') {
  const id = String(need.id);
  const base = { id: `${need.kind}:${id.replace(new RegExp(`^${need.kind}:`, 'u'), '')}`, kind: need.kind, source: 'board',
    title: String(need.text ?? '').split('\n')[0], why: need.what && !String(need.what).startsWith('pullboard ') ? String(need.what) : '',
    from: null, created: need.at ?? null };
  const commands = {
    decision: () => [step('Answer', `pullboard answer ${need.id} {answer} --as person`, root)],
    pending: () => [step(`Answer ${need.id}`, `pullboard spec answer ${need.id} {answer}`, root)],
    hold: () => [step(`Lift the hold on ${need.id}`, `pullboard hold ${need.id} --off`, root, false)],
    'spec-revision': () => [step(`Approve ${need.id}`, `pullboard spec approve ${need.id}`, root)],
    'agent-approved': () => [step(`Confirm ${need.id}`, `pullboard spec approve ${need.id}`, root)],
    'sentinel-draft': () => [step(`Approve watch ${need.ref}`, `pullboard sentinel approve ${need.ref}`, root)],
    signoff: () => [signerDefault(step(`Sign ${need.id}`, `pullboard spec signoff ${need.id} --by {by} --note {note}`, root), signer)],
  };
  // A revision the person already approved waits only for spec apply, which the apply need carries.
  const steps = need.kind === 'spec-revision' && need.actions?.length === 0 ? [] : commands[need.kind]?.() ?? [];
  return labelled({ ...base, steps, next: steps.length ? 1 : null });
}

/**
 * Each draft row as two needs, approve and decline: a panel runs only a need's next step, so a
 * choice between two commands has to be two needs the person picks between.
 */
function draftNeeds(need, root) {
  return (need.rows ?? []).flatMap(row => [['draft', 'Approve', `pullboard spec approve ${row.id}`],
    ['decline', 'Decline', `pullboard spec decline ${row.id} --reason {reason}`]].map(([kind, verb, command]) =>
    labelled({ id: `${kind}:${row.id}`, kind, source: 'board', title: `${verb} ${row.id}: ${String(row.text ?? '').split('\n')[0]}`,
      why: row.stage ?? '', from: null, created: null, steps: [step(`${verb} ${row.id}`, command, root)], next: 1 })));
}

/** One open ask with its own steps, numbered as filed. */
function askNeed(row) {
  const steps = row.steps.map(s => ({ n: s.n, label: s.label, command: s.command, cwd: row.cwd,
    prompts: s.prompts, personOnly: row.personOnly, done: s.done }));
  return { id: `ask:${row.id}`, kind: 'ask', source: 'ask', title: row.title, why: row.why, from: row.from, created: row.created,
    steps, next: steps.find(s => !s.done)?.n ?? null };
}

/** The whole list: person needs first, then rows waiting to be written, coordinator questions and open asks. */
export function needsList({ needs = [], pendingApply = [], openDecisions = [], personQuestions = [], asks = [], root, signer = '' }) {
  const list = needs.flatMap(need => need.kind === 'draft' && need.rows?.length ? draftNeeds(need, root) : [boardNeed(need, root, signer)]);
  const decided = new Set(needs.filter(need => need.kind === 'decision').map(need => String(need.id)));
  for (const ask of personQuestions) {
    if (decided.has(String(ask.id))) continue;
    list.push(boardNeed({ kind: 'decision', id: ask.id, text: ask.question, at: ask.at }, root));
  }
  if (pendingApply.length) {
    list.push({ id: 'apply', kind: 'apply', source: 'board', title: `Write ${pendingApply.length} decided spec ${pendingApply.length === 1 ? 'row' : 'rows'} into SPEC.md`,
      why: pendingApply.map(row => `${row.id} ${row.decision ?? row.kind}`).join(', '), from: null, created: null,
      steps: [step('Apply decisions', 'pullboard spec apply', root, false)], next: 1 });
  }
  for (const ask of openDecisions) {
    list.push(labelled({ id: `question:${ask.id}`, kind: 'question', source: 'board', title: String(ask.question).split('\n')[0],
      why: `asked by ${ask.asker}; waiting for the coordinator`, from: ask.asker, created: ask.at ?? null,
      steps: [step('Answer', `pullboard answer ${ask.id} {answer}`, root, false)], next: 1 }));
  }
  return [...list, ...asks.filter(row => row.status === 'open').map(askNeed)];
}
