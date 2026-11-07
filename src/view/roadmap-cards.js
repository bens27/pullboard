/**
 * The Roadmap's milestone reading and cards [N26], moved out of src/cockpit.js to keep it under its line cap. Its
 * text is what the page served before the move, verbatim; it reads the page script's own names, so it is embedded
 * in place, not run here.
 *
 * @returns {string} The script text of the Roadmap's milestone functions.
 */
export function roadmapCardsScript() {
return `/**
 * A milestone's item as the Items tab reads it (N26). This board's own come from its items, and
 * another repo's, written repo#id, from that repo's board when the view lists one by that name or
 * folder, as the roadmap resolves it: the same state, sent back included, and it opens there. An
 * item no listed board holds keeps the status the roadmap read for it, and opens nowhere.
 */
function milestoneItem(entry, p) {
  const local = typeof entry.id === 'number';
  const ref = local ? null : /^(.+)#([1-9]\\d*)$/.exec(String(entry.id));
  const named = ref ? data.projects.filter((x) => x.name === ref[1] || String(x.root).split('/').pop() === ref[1]) : [];
  const root = local ? view.root : named.length === 1 && named[0].ok ? named[0].root : null;
  const id = local ? entry.id : ref ? Number(ref[2]) : null;
  const item = (root === view.root ? p.items : root ? named[0].items : []).find((i) => i.id === id) || null;
  const source = root === view.root ? p : root ? named[0] : null;
  const label = local ? '#' + entry.id : String(entry.id);
  const expanded = view.tab === 'roadmap' && view.roadmapOpen.get(JSON.stringify([view.root, 'i:' + label])) === true;
  // A folded row holds whatever detail is already kept, so it opens in place whole (#1039).
  const detail = item ? detailOf(source, item, expanded, root) : null;
  if (item && !expanded) roadmapAhead.set('i:' + label, () => detailOf(source, item, 'ahead', root));
  // A status the lifecycle declares; the roadmap says unavailable or missing for an item it could not read.
  const read = item || (FLOW.states.some((state) => state.id === entry.status) ? { status: entry.status, verdict: null } : null);
  return {
    label: local ? '#' + entry.id : String(entry.id),
    title: item ? item.title : read ? entry.title : '',
    root,
    titles: new Map((root === view.root ? p.items : root ? named[0].items : []).map((i) => [String(i.id), i.title])),
    state: read ? stateOf(read) : null,
    stale: item ? staleChip(item) : '', held: item ? heldNote(item, source, entry) : null,
    block: item ? roadmapBlock(detail?.item || item, {
      holds: root === view.root ? source.holds : source.laneHolds, itemHolds: source.itemHolds, items: source.items, agents: source.agents, state: stateOf,
      address: (id) => itemAddress(id, root), board: root === view.root ? null : root,
      releases: (p.milestones || []).filter((milestone) => milestone.items.some((ref) => ref.id === entry.id)).map((milestone) => milestone.name),
      error: expanded ? detail?.error : undefined,
    }) : null,
    // Until its omitted fields arrive, an expanded row paints what its summary holds and fills the rest in place (#1039).
    pending: expanded && Boolean(detail?.loading),
    stage: entry.state === 'landed' ? 'merged' : entry.state === 'accepted' ? 'accepted' : item ? pipelineStage(item) : entry.status,
    word: entry.status,
    open: item ? { root, id } : null,
    // Why an item does not open, short enough to read beside its id on a phone.
    why: item ? '' : local ? 'not on this board' : root ? 'not on that board' : snapshot ? 'not in this snapshot'
      : named.length > 1 ? 'board name not unique' : named.length ? 'board unreadable' : 'no such board',
  };
}

/** Mark the release nearest the top of the Roadmap in its companion panel. */
function updateRoadmapPanel() {
  const panel = $('roadmap-panel');
  if (!panel || view.tab !== 'roadmap') return;
  aheadRoadmapRows();
  const entries = [...panel.querySelectorAll('[data-roadmap-jump]')].map((button) => ({
    key: button.dataset.roadmapJump,
    target: $('roadmap-list').querySelector('[data-key="' + CSS.escape(button.dataset.roadmapJump) + '"]'),
  })).filter((entry) => entry.target);
  if (!entries.length) return;
  const threshold = (document.querySelector('.top')?.getBoundingClientRect().bottom ?? 0) + 8;
  const active = entries.find((entry) => entry.target.getBoundingClientRect().bottom > threshold)?.key || entries.at(-1).key;
  for (const entry of entries) {
    const button = panel.querySelector('[data-roadmap-jump="' + CSS.escape(entry.key) + '"]');
    if (button) {
      if (entry.key === active) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
  }
}

/** Open a selected release in the list and briefly mark it after the jump. */
function jumpToRoadmap(key) {
  if (key === 'shipped') {
    view.roadmapOpen.set(JSON.stringify([view.root, 'shipped']), true);
    render();
  }
  const target = $('roadmap-list')?.querySelector('[data-key="' + CSS.escape(key) + '"]');
  if (!target) return;
  const topbar = document.querySelector('.top');
  if (matchMedia('(max-width: 900px)').matches && topbar) {
    // The Roadmap scrolls in the document viewport; use the wrapped sticky bar's actual lower edge, not its minimum height.
    target.style.scrollMarginTop = Math.ceil(topbar.getBoundingClientRect().bottom + 16) + 'px';
  } else target.style.removeProperty('scroll-margin-top');
  target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  target.classList.remove('roadmap-arrival');
  void target.offsetWidth;
  target.classList.add('roadmap-arrival');
  setTimeout(() => target.classList.remove('roadmap-arrival'), 1300);
  updateRoadmapPanel();
}

/**
 * One item's row on the Roadmap, laid out as the Items list lays one out: the dot of its state, its
 * id and title on one line that ends in an ellipsis when cut, and the Items tab's chip. The whole
 * title is the row's tooltip. Every row expands in place; its compact detail alone links over to Items.
 */
function milestoneRow(row, titles, hidden = false) {
  const title = row.title ? inline(String(row.title).replace(/\\s+/g, ' '), row.titles || titles, 'in-place', row.root) : '<span class="muted">' + esc(row.why) + '</span>';
  const label = '<span class="id">' + esc(row.label) + '</span>' + title;
  const text = row.block?.dot ? '<span class="milestone-title">' + label + '</span>' + row.block.dot : label;
  const key = 'i:' + row.label, open = view.roadmapOpen.get(JSON.stringify([view.root, key])) === true;
  const status = (open && row.block?.dot ? '<span class="chip warn roadmap-blocked"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>blocked</span>' : '') + (row.stage === 'merged' ? '<span class="chip ok roadmap-landed">verified</span>' : row.stage === 'accepted' ? '<span class="chip ok">accepted</span>' : row.held ? heldChip(row.held) : row.state ? chip(row.state) : '<span class="chip">' + esc(row.word) + '</span>');
  const inner = '<span class="dot' + (row.state ? ' ' + row.state : '') + '"></span><span class="t">' + text + '</span>' + (row.stale || '') + '<span class="roadmap-status">' + status + '</span>';
  const board = row.open && row.open.root !== view.root ? ' data-board="' + esc(row.open.root) + '"' : '';
  const toggle = 'class="milestone-item' + (row.block?.dot ? ' blocked' : '') + '" data-roadmap-key="' + esc(key) + '" aria-expanded="' + open + '"' + board + ' title="' + esc(row.title ? row.title + (!row.open && row.why ? ' (' + row.why + ')' : '') : row.why) + '"';
  const detail = row.block ? row.block.detail : '<p>' + esc(row.why || row.word) + '</p>';
  // Every row stays on the Roadmap; only its explicit Open in Items link navigates (#605).
  return '<li' + (hidden ? ' hidden' : '') + '><div ' + toggle + ' role="button" tabindex="0">' + inner + '</div>'
    + '<div class="milestone-why"' + (open ? '' : ' hidden') + (row.pending ? ' aria-busy="true"' : '') + '>' + detail + '</div></li>';
}

/** Read supplied landed counts and explicit shipments; keep old exports readable and omit withdrawn rows. */
function readMilestone(milestone, p) {
  const visible = milestone.items.map((entry) => milestoneItem(entry, p)).filter((row) => row.state !== 'withdrawn');
  const verified = visible.filter((row) => row.state === 'verified');
  /** Group work in the legend's shipping order; stable sorting preserves milestone order within each group. */
  const rank = (row) => row.stage === 'merged' ? 5 : row.stage === 'accepted' ? 0 : row.stage === 'submitted' ? 1 : row.held ? 4 : row.stage === 'claimed' ? 2 : row.state === 'verified' ? 5 : 3;
  const rows = [...visible].sort((a, b) => rank(a) - rank(b));
  // Current API milestones own their landed count and explicit shipment. Old exports retain their old count.
  /** Reject malformed snapshot counts before they reach numeric HTML attributes. */
  const numeric = value => Number.isInteger(value) && value >= 0 ? value : null;
  const done = numeric(milestone.summary?.landed) ?? numeric(milestone.landed) ?? verified.length;
  const total = numeric(milestone.summary?.total) ?? numeric(milestone.total) ?? rows.length;
  // Nothing left (every item landed or withdrawn) is finished and sits under Shipped, shipped or not.
  const left = numeric(milestone.summary?.left), finished = milestone.items.length > 0 && (left !== null ? left === 0 : rows.every((row) => row.stage === 'merged'));
  const shipped = finished || (milestone.shipped !== undefined ? Boolean(milestone.shipped) : rows.length > 0 && verified.length === rows.length);
  return { milestone, rows, done, total, shipped };
}

/** Pick the first release with remaining work in roadmap order; empty plans wait behind it. */
function nextMilestone(p) {
  const next = (p.milestones || []).find((milestone) => {
    const read = readMilestone(milestone, p);
    return read.rows.length > 0 && !read.shipped;
  });
  if (!next) return next;
  const read = readMilestone(next, p);
  return { ...next, done: read.done, total: read.total };
}

/**
 * The Roadmap (N26, N38) opens releases with work left in board order and folds shipped or finished ones into Shipped.
 * Headers show the backend's summary; accepted and landed rows stay distinct; shipped history carries its commit; old
 * exports keep their legacy completion rule; each part keeps the person's disclosure choice for this visit.
 */
function roadmapCards(p, titles) {
  // Opened from the status bar's release, the Roadmap is that release alone, with a way back to all of them.
  const only = view.roadmapOnly && (p.milestones || []).some((m) => m.name === view.roadmapOnly) ? view.roadmapOnly : null;
  const milestones = (p.milestones || []).filter((m) => !only || m.name === only);
  const lead = only ? '<div class="roadmap-only"><span>' + esc(only) + '</span><button class="link" data-roadmap-all type="button">show all</button></div>' : '';
  const read = milestones.map((milestone) => readMilestone(milestone, p));
  const coming = read.filter((m) => !m.shipped && m.rows.length).concat(read.filter((m) => !m.shipped && !m.rows.length)), shipped = read.filter((m) => m.shipped).reverse();
  /** Preserve each board's disclosure choices independently. */
  const isOpen = (key, first) => view.roadmapOpen.has(JSON.stringify([view.root, key])) ? view.roadmapOpen.get(JSON.stringify([view.root, key])) : first;
  const caret = '<svg class="caret" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>'; // The view's stroke chevron, set inside the title to centre on its first line (#870).
  const next = coming.find((m) => m.rows.length) || null;
  const headerFor = roadmapHeaders(roadmapSummary, { time: when, address: itemAddress, root: view.root, held: view.roadmapHeld });
  const stages = [['open', 'Open'], ['claimed', 'Building'], ['submitted', 'In review'], ['accepted', 'Accepted'], ['merged', 'Landed']];
  const counts = headerFor(next) ? null : Object.fromEntries(stages.map(([stage]) => [stage, next ? next.rows.filter((row) => row.stage === stage).length : 0]));
  const shippingCounts = headerFor(next)
    ? '<dl class="roadmap-stage-counts">' + [['landed','Landed'],['landing','Accepted, landing'],['review','In review'],['building','Building'],['waiting','Waiting'],['held','Held']].map(([key,label]) => '<div data-shipping-stage="' + key + '"><dt>' + label + '</dt><dd>' + next.milestone.summary[key] + '</dd></div>').join('') + '</dl>'
    : '<dl class="roadmap-stage-counts">' + stages.map(([stage, label]) => '<div data-shipping-stage="' + stage + '"><dt>' + label + '</dt><dd>' + counts[stage] + '</dd></div>').join('') + '</dl>';
  const lastShipped = '<p class="roadmap-last-shipped"><span>Last shipped</span><b>' + esc(shipped[0]?.milestone.name || 'None yet') + '</b>'
    + (shipped[0]?.milestone.note ? '<small>' + esc(firstLine(shipped[0].milestone.note)) + '</small>' : '') + '</p>';
  const mobileShipping = '<section class="roadmap-shipping roadmap-mobile-shipping" aria-label="Shipping counts">' + shippingCounts + lastShipped + '</section>';
  const mobileHistory = '<section class="roadmap-shipping roadmap-mobile-shipping" aria-label="Last shipped release">' + lastShipped + '</section>';
  /** Keep supplied landed progress beside an upcoming release without a modern summary. */
  const count = (m) => m.total ? '<span class="milestone-count" aria-label="' + m.done + '/' + m.total + ' landed">' + m.done + '/' + m.total + ' landed</span>' : '';
  /** Show the backend's capacity independently of remaining-work headers, including empty and shipped plans [N26]. */
  const capacity = (m) => Number.isSafeInteger(m.milestone.limit) && m.milestone.limit >= 0 && Number.isSafeInteger(m.milestone.count) && m.milestone.count >= 0
    ? '<span class="milestone-limit">' + m.milestone.count + '/' + m.milestone.limit + ' items</span>' : '';
  /** Render the existing milestone items, progress and complete note when opened. */
  const body = (read) => {
    const { milestone, rows, done, total } = read;
    const progress = headerFor(read) ? '' : '<svg class="milestone-progress" viewBox="0 0 100 1" preserveAspectRatio="none" role="progressbar" aria-label="' + esc(milestone.name) + ': ' + done + ' of ' + total + ' landed" aria-valuemin="0" aria-valuemax="' + total + '" aria-valuenow="' + done + '"><rect width="' + (total ? (100 * done) / total : 0) + '" height="1"/></svg>';
    return (rows.length ? progress + '<ul>' + rows.map((row) => milestoneRow(row, titles, view.roadmapHeld === milestone.name && !row.held)).join('') + '</ul>' : '<p class="milestone-empty">No items yet.</p>')
      + (milestone.note ? '<p class="milestone-note">' + rich(milestone.note, titles) + '</p>' : '');
  };
  /** Keep folding consistent with the View's other keyboard-accessible disclosure controls. */
  const wrap = (tag, classes, key, first, heading, contents, afterHead = '') => {
    const open = isOpen(key, first);
    return '<' + tag + ' class="' + classes + '" data-key="' + esc(key) + '"><div class="milestone-head" data-roadmap-key="' + esc(key) + '" role="button" tabindex="0" aria-expanded="' + open + '">' + heading.replace('<h2>', '<h2>' + caret) + '</div>' + afterHead + '<div class="milestone-body"' + (open ? '' : ' hidden') + '>' + contents + '</div></' + tag + '>';
  };
  /** Open every upcoming milestone by default; the person's current-page fold remains in the view map. */
  const card = (m) => {
    const header = headerFor(m);
    const legacyTarget = m.milestone.target ? '<div class="milestone-targetline">Target <time datetime="' + esc(m.milestone.target) + '">' + when(m.milestone.target) + '</time>' + (m.milestone.pastTarget ? ' <span class="chip warn">past target</span>' : '') + '</div>' : '';
    return wrap('section', 'card-panel milestone' + (header ? ' roadmap-has-summary' : ''), 'm:' + m.milestone.name, true,
      '<h2>' + linked(m.milestone.name, titles) + '</h2>' + (header ? header.count : count(m)) + capacity(m), body(m), header ? header.detail + (m === next ? mobileHistory : '') : legacyTarget + (m === next ? mobileShipping : ''));
  };
  /** Summarize one shipped milestone with its first note line and total count. */
  const line = (m) => wrap('div', 'milestone shipped-one', 'm:' + m.milestone.name, false, '<h2>' + esc(m.milestone.name) + '</h2><small>' + esc(firstLine(m.milestone.note)) + '</small>' + (m.milestone.shipped?.commit ? '<code class="roadmap-shipped-commit" title="' + esc(m.milestone.shipped.commit) + '">' + esc(m.milestone.shipped.commit.slice(0, 12)) + '</code>' : '') + '<span class="milestone-count">' + m.total + (m.total === 1 ? ' item' : ' items') + '</span>' + capacity(m), body(m));
  const releaseButtons = coming.map((m) => {
    const key = 'm:' + m.milestone.name;
    return '<button class="roadmap-release" data-roadmap-jump="' + esc(key) + '" type="button"><span>' + esc(m.milestone.name) + '</span><b>' + m.done + '/' + m.total + '</b></button>';
  }).join('');
  const shippedButton = shipped.length
    ? '<button class="roadmap-release" data-roadmap-jump="shipped" type="button"><span>Shipped</span><b>' + shipped.length + '</b></button>' : '';
  const releasePanel = '<aside class="card-panel roadmap-panel" id="roadmap-panel" aria-label="Roadmap releases and shipping">'
    + '<section class="roadmap-release-index"><h2>Releases</h2><nav class="roadmap-releases" id="roadmap-releases" aria-label="Roadmap releases">' + releaseButtons + shippedButton + '</nav></section>'
    + '<section class="roadmap-shipping roadmap-desktop-shipping" aria-label="Shipping counts"><h2>Shipping</h2><h3 class="roadmap-next-release">' + esc(next?.milestone.name || 'No upcoming release') + '</h3>'
    + shippingCounts + lastShipped + '</section></aside>';
  const roadmapList = '<div class="roadmap-list" id="roadmap-list">' + lead + (milestones.length ? coming.map(card).join('') : '<div class="card-panel empty">No milestones yet. The coordinator adds one with <code class="inline">pullboard milestone add</code>.</div>')
    + (shipped.length ? wrap('section', 'card-panel shipped', 'shipped', false, '<h2>Shipped</h2><span class="milestone-count">' + shipped.length + (shipped.length === 1 ? ' release' : ' releases') + '</span>', shipped.map(line).join('')) : '') + '</div>';
  // With no releases there is nothing to jump to, so the Roadmap is its list alone, as before the panel.
  return (milestones.length ? releasePanel : '') + roadmapList;
}`;
}
