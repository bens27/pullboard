/** Adapt the shared Needs-you calls to the cockpit's legacy row shape without changing ownership. */

/**
 * Turn the shared person-call projection into the rows rendered by the cockpit.
 * @param {Array<object>} personalNeeds - Calls returned by the shared needs builder.
 * @param {Array<object>} holds - Holds from the selected project.
 * @returns {Array<object|Array<unknown>>}
 */
export function needsEntries(personalNeeds, holds) {
  return personalNeeds.filter((row) => !['draft', 'rigor-draft', 'sentinel-draft', 'agent-approved'].includes(row.kind)).map((row) => {
    if (row.kind === 'spec-revision') return { revision: row };
    if (row.kind === 'ask') return { ask: row };
    if (row.kind === 'decision') return ['decide:' + row.id, row.ref, row.text, 'decide', row.at];
    if (row.kind === 'pending') return ['spec:' + row.id, row.ref, row.text, 'answer ' + row.ref];
    if (row.kind === 'block') return [null, row.ref, row.text, row.what, row.at, 'block'];
    if (row.kind === 'relay-health') return [null, row.ref, row.text, row.what, row.at, 'relay-health'];
    if (row.kind === 'verify') return [row.target, row.ref, row.text, row.what, row.at, 'verify'];
    if (row.kind === 'signoff') return [row.target, row.ref, row.text, row.what, undefined, 'signoff'];
    return ['tab:shouts', row.ref, row.text, row.what, holds.find((hold) => hold.hold_lane === row.id)?.hold_at];
  });
}

/**
 * Render each adapted Needs-you row with its established action, except a local relay alert is inspection-only.
 * A verdict or sign-off row shows the person's step beside its action, since no agent can take it for them.
 * @param {Function} needRow - The page's escaped standard Needs-you renderer.
 * @param {Function} specRevisionRow - The page's spec revision renderer.
 * @param {object|Array<unknown>} entry - One adapted Needs-you row.
 * @returns {string}
 */
export function renderNeedsRow(needRow, specRevisionRow, entry) {
  if (entry.revision) return specRevisionRow(entry.revision);
  if (entry.ask) {
    // Asks are agent-written, and this source runs in the page without its helpers, so it escapes here.
    const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const ask = entry.ask;
    const steps = ask.steps.map((step) => '<li' + (step.done ? ' class="done"' : '') + '>' + esc(step.label)
      + (step.n === ask.next ? ' <code>' + esc(step.command) + '</code>' : '') + '</li>').join('');
    return '<li class="row ask"><span class="dot ask"></span><div><div class="t"><span>' + esc(ask.ref) + '</span>' + esc(ask.text) + '</div>'
      + (ask.why ? '<div class="why">' + esc(ask.why) + '</div>' : '') + '<ol class="ask-steps">' + steps + '</ol>'
      + '<div class="meta"><span class="why"><b>NEEDS YOU</b> an ask from ' + esc(ask.from) + '</span>'
      + (ask.done ? ' <span>then record it: <code>' + esc(ask.done) + '</code> <button type="button" data-copy="' + esc(ask.done) + '">Copy</button></span>' : '')
      + '</div></div><span class="chip warn">your step</span></li>';
  }
  if (entry[5] === 'block') return needRow(entry, entry[3], 'next step');
  if (entry[5] === 'relay-health') return needRow(entry, entry[3], 'inspect');
  if (entry[5] === 'verify') return needRow(entry, entry[3], 'verify');
  if (entry[5] === 'signoff') return needRow(entry, entry[3], 'sign off');
  if (entry[3] === 'decide') return needRow([entry[0], '', entry[2], entry[3], entry[4]], 'a decision, asked by ' + entry[1], 'decide');
  if (entry[0].startsWith('spec:')) return needRow(entry, 'an open question in SPEC.md', 'answer');
  return needRow(entry, entry[3], 'release');
}
