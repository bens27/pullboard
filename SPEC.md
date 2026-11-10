# Pullboard local

The local-first core of Pullboard: a work board, lanes, a spec and git hooks that live in the repo. No account, no network. This file is the spec, in the format `pullboard spec check` lints.

Statuses: approved = decided · draft = proposed · pending = open question · fact = true today · wont = won't build, decided and kept · retired = no longer applies, kept. Ids are permanent: never delete or renumber a row. Tiers: must · aim.

## P · Principles
- P1 [approved, must] Nothing ships until a second agent verifies it. | gate: test/board.test.js
- P2 [approved, must] Works offline in any git repo, with no account or network unless you turn on sync. | gate: test/e2e.test.js
- P3 [approved, must] Zero runtime dependencies. Node 22.13 or newer. | gate: test/package.test.js
- P4 [approved, must] Every refusal names its rule, shows what it saw, and gives the next step. | gate: review
- P5 [approved, must] The core names no model or vendor, and opens no connection except the sync you turn on. | gate: test/boundary.test.js
- P6 [approved, must] A person's own moves (approving rows, answering decisions, signing off) come only from the person: their own terminal, the view in their own browser (local or on pullboard.dev), or a signed person move; never through an agent interface such as MCP, the API, or a CLI run in an agent's shell. | gate: test/mcp.test.js

## B · Board
- B1 [approved, must] One SQLite file in the git common dir. Every worktree sees it; nothing is committed. | gate: test/e2e.test.js
- B2 [approved, must] Every move is one immediate transaction. Two agents never hold one item. | gate: test/e2e.test.js | serves: P1
- B3 [approved, must] An agent is its worktree. The main checkout is the coordinator. | gate: test/e2e.test.js
- B4 [approved, must] A claim is a lease, 2h by default. Claiming again renews it. | gate: test/board.test.js
- B5 [approved, must] One live claim per agent, besides reworks of its own rejects and child items. | gate: test/board.test.js
- B6 [approved, must] Items cite spec ids that exist. | gate: test/e2e.test.js | serves: S1
- B7 [approved, must] Shouts reach a lane, an agent or all. Inbox marks them read. | gate: test/board.test.js
- B8 [approved, must] An item can wait on others; claiming it is refused until they are verified. | gate: test/board.test.js
- B9 [approved, must] Submit pins the commit under refs/pullboard/items, so submitted work is never lost. | gate: test/e2e.test.js
- B10 [approved, must] An item carries a brief: how to build it. Next and show print it; edit changes it until verified. | gate: test/board.test.js, test/e2e.test.js
- B11 [retired] Items route strong or light; B13 replaced the two routes with three tiers.
- B12 [approved, must] Every item is built in its own lane; the coordinator claims only coordinator-lane items. | gate: test/board.test.js | serves: L3
- B13 [approved, must] Routes are tiers: light, mid, strong. An agent claims and verifies its tier and below, its own first. | gate: test/board.test.js | serves: B10
- B14 [approved, must] Below strong, an item needs a criterion, a check command, and a brief naming its test and in-lane files. | gate: test/board.test.js, test/e2e.test.js | serves: B10
- B15 [approved, must] Escalate frees an item one tier up, its attempt pinned and its failure attached. | gate: test/board.test.js, test/e2e.test.js | serves: B13
- B16 [approved, must] When only work above an agent's tier is open in its lane, next names it and the ways through. | gate: test/board.test.js | serves: B13
- B17 [approved, must] Every agent on a board runs one tested version of pullboard, never a checkout's unfinished edits. | gate: test/e2e.test.js | serves: P1
- B18 [approved, aim] An item can wait until a time; next and claim pass over it until then. | gate: test/board.test.js | serves: B8
- B19 [approved, aim] An item can wait until main contains a given commit; next and claim pass over it until then. | gate: test/e2e.test.js | serves: B8
- B20 [approved, aim] The person orders open items: now, next or later, and up or down within each; next follows it first. | gate: test/board.test.js
- B21 [approved, aim] A shout can ask for a decision; it stays open until someone answers it. | gate: test/board.test.js | serves: B7
- B22 [approved, aim] A shout can attach typed evidence: attempt or receipt, outcome, item and commit, as fields, not prose. | gate: test/board.test.js | serves: B7
- B23 [approved, aim] A shout's path:lines@commit reference opens that code as it was at that commit. | gate: test/cockpit/references.test.js | serves: B7
- B24 [approved, aim] An item can wait on an item in another repo of its project, written repo#id. | gate: test/board.test.js | serves: N33
- B25 [approved, must] Questions go one step up: agents ask their coordinator; a coordinator asks the person or the coordinator above. | gate: test/board.test.js | serves: B21
- B26 [approved, must] Needs-you holds only the person's calls: decisions passed up, rows to approve, held lanes; agents ask their coordinator. | gate: test/board.test.js | serves: B25
- B27 [approved, must] A coordinator answers a decision or passes it up with its note; the answer reaches whoever asked. | gate: test/board.test.js | serves: B25
- B28 [approved, must] Work renews the lease: a commit, gate run or command from the holder's worktree renews its claim. | gate: test/board.test.js | serves: B4
- B29 [approved, must] Any agent appends typed facts to an item's thread; the board stamps each with author, time and id. | gate: test/board.test.js | serves: B22
- B30 [approved, must] Judgements on an item (decision, rejection, supersession, root cause) come only from its holder or the coordinator. | gate: test/board.test.js | serves: B29
- B31 [approved, must] A thread is append-only: a correction is a new fact that supersedes the old one, and both stay visible. | gate: test/board.test.js | serves: B29
- B32 [approved, must] A fact binds code by full sha; show prints an item's moves and facts as one timeline. | gate: test/board.test.js | serves: B29
- B33 [approved, aim] The view shows an item's thread in its detail, with code references live. | gate: test/cockpit.test.js | serves: B29
- B34 [approved, must] The trunk is the main checkout's branch, whatever its name; nothing assumes main. | gate: test/trunk.test.js | serves: P2
- B35 [approved, must] Needs-you assumes the person's view is stale until shown fresh: an ask records the board facts its steps name (items, rows, milestones, tags) when filed; each read re-checks them and marks the ask stale with its reason (a missing milestone, a landed item, a newer ask on the same subject), a stale step will not run until the filer re-confirms or drops it, and a step marked done stays open when its effect cannot be seen (the tag or release is absent). Measure: asks the person completed or dropped while already stale, counted per month, fall to zero; review 2026-12-07. | gate: review
- B36 [approved, must] pullboard takeover will not move a seat from a live session (fresh heartbeat) without --force, and tells the old holder, so two resumed sessions cannot pull the coordinator seat back and forth. Measure: takeovers that move a seat whose holder had a fresh heartbeat, counted from board activity, fall to zero without --force; review 2026-12-07. | gate: review

## M · Machine
- M1 [approved, must] One declaration holds every item state, move, guard and refusal; code, help and docs derive from it. | gate: test/machine.test.js
- M2 [approved, must] Every way into a final state passes that state's exit guards, whatever command gets there. | gate: test/machine.test.js | serves: P1
- M3 [approved, must] The board file refuses an undeclared move, and verified without an ACCEPT at the submitted commit. | gate: test/machine.test.js | serves: P1
- M4 [approved, must] A property check proves the declaration: every state reachable, none a trap, every refusal naming a next step. | gate: test/machine.test.js | serves: M1

## V · Verification
- V1 [approved, must] The builder never verifies its own work. | gate: test/board.test.js | serves: P1
- V2 [approved, must] The criterion, title and cited rows freeze at first claim; they alone are the bar, never the brief. | gate: test/board.test.js | serves: P1
- V3 [approved, must] Submit and verify refuse when the frozen criterion or its cited rows changed since claim. | gate: test/e2e.test.js | serves: V2
- V4 [approved, must] Submit needs a clean tree and, green at HEAD, the item's check and the tests its change can reach; the full gate runs at landing. | gate: test/e2e.test.js
- V5 [approved, must] ACCEPT needs CRITERION_MET and a note of the proof. REJECT needs a reason code and a note. | gate: test/board.test.js
- V6 [approved, must] REJECT reopens the item. Resubmitting needs a new head. | gate: test/board.test.js
- V7 [approved, must] The verifier's checkout contains the submitted commit. | gate: test/e2e.test.js
- V8 [approved, must] Every verdict binds the submitted commit and the frozen digest. | gate: test/board.test.js
- V9 [approved, must] In the main checkout, verify needs --as coordinator, so no verdict is misfiled as the coordinator's. | gate: test/e2e.test.js | serves: V1
- V10 [approved, must] Agents see a gate digest: one line when green, the failures when red; the full log stays in .git. | gate: test/e2e.test.js | serves: V4
- V11 [retired] Merged into V3: submit and verify both refuse a bar that moved.
- V12 [approved, must] Verify and escalate take --note-file, so a note reaches the board exactly as written. | gate: test/e2e.test.js | serves: V5
- V13 [approved, must] Every verdict records the verifier's HEAD; a review past the submitted commit is flagged, or refused if the repo asks. | gate: test/board.test.js | serves: V8
- V14 [retired] Merged into V2.
- V15 [approved, must] `next --verify` reserves the review under a lease; another verdict on it is refused while the lease lives. | gate: test/machine.test.js | serves: V1
- V16 [approved, must] Submit runs the gate itself on the exact tree it submits, never trusting an earlier stamp. | gate: test/gate.test.js | serves: P1
- V17 [approved, must] Submit refuses a head carrying commits pinned to another item that is not verified. | gate: test/e2e.test.js | serves: V6
- V18 [approved, must] Accept runs the repo's install step before the frozen check; a failed install or timeout reads unverified, never red. | gate: test/e2e.test.js | serves: V2
- V19 [approved, must] Every accept records whether a frozen check ran at the submitted commit; show and the ledger say so. | gate: test/verdict-check.test.js | serves: V8
- V20 [approved, must] A rework after a reject that names a reproduction must add a test that reproduces that edge, shown red at the rejected head; submit names the reject's edge when the change adds no test for it, so one item does not bounce on the same cause. After a second reject with the same cause, the next submit states the premise the item rests on and the evidence that falsifies or keeps it before a third build. Measure: pullboard rigor counts of items rejected three or more times on one cause fall to zero; review 2026-12-07. | gate: review

## O · Options
- O1 [approved, aim] Pullboard asks the person once whether to check for new releases, and checks only if they said yes; pullboard update upgrades on request. | gate: test/settings.test.js | serves: O5
- O2 [approved, aim] verify.family: off, prefer or require a verifier from a model family that built none of it. | gate: test/board.test.js | serves: V1
- O3 [approved, aim] Agents declare their model family on joining; submissions and verdicts record it. | gate: test/board.test.js | serves: O2
- O4 [retired] Merged into V13.
- O5 [approved, aim] Machine settings in ~/.pullboard hold what belongs to the machine: gate concurrency, run's tier commands, the view's port. | gate: test/settings.test.js
- O6 [approved, aim] Each setting has one home: board rules in the repo, machine capacity and tools in ~/.pullboard; flags override. | gate: test/settings.test.js | serves: O5
- O7 [retired] Merged into Q4.
- O8 [approved, must] Every agent declares the model that runs it; names show it, as web-1 (Claude) or claude-web-1 by option. | gate: test/board.test.js | serves: O3

## L · Lanes
- L1 [approved, must] Lanes live in pullboard.json: folders owned, spec prefixes, when it starts. | gate: test/lanes.test.js
- L2 [approved, must] The longest owned prefix decides a path's lane. Unowned paths are the coordinator's. | gate: test/lanes.test.js
- L3 [approved, must] In a lane's worktree, pre-commit refuses changes outside the lane, moves included. | gate: test/e2e.test.js
- L4 [approved, must] A worktree that has not joined a lane cannot commit. | gate: test/e2e.test.js

## S · Spec
- S1 [approved, must] SPEC.md holds one row per line: id, status, text, gate, what it serves. | gate: test/spec.test.js
- S2 [approved, must] Ids are unique forever. Retired rows stay, so no id is reused. | gate: test/spec.test.js
- S3 [approved, must] Serves links name real ids and never cycle. | gate: test/spec.test.js
- S4 [approved, must] Approved must-rows name their gate. | gate: test/spec.test.js
- S5 [approved, must] A sign-off keeps the text it approved. Changing the row makes it stale. | gate: test/spec.test.js
- S6 [approved, must] PRACTICE.md holds the house rules in the same row format; spec check lints both. | gate: test/practice.test.js
- S7 [approved, must] `pullboard spec view` renders spec, questions, sign-offs and practice as one offline page. | gate: test/view.test.js
- S8 [approved, must] Commit refuses a deleted row; spec check finds any id once committed or cited, now gone. | gate: test/e2e.test.js, test/spec.test.js
- S9 [approved, must] A wont row stays with its id, out of the counts; nothing new may cite it. | gate: test/spec.test.js
- S10 [approved, must] At an older commit, spec check skips ids that items cite and a later commit added. | gate: test/e2e.test.js | serves: S8
- S11 [approved, must] pullboard.json names products, each a list of spec ids or section letters, as lanes list theirs. | gate: test/products.test.js
- S12 [approved, must] Lanes and items belong to the product of their spec prefixes and cited rows; nothing restates it. | gate: test/products.test.js | serves: S11
- S13 [approved, must] `pullboard spec --json` prints every parsed row, so tools in any language read the spec without parsing it. | gate: test/spec.test.js
- S14 [approved, must] A sign-off can say what the signer checked, with --note, and the note stays with it. | gate: test/spec.test.js | serves: S5
- S15 [approved, must] Signing a row shows the tests and verified items that cite it; a row nothing proves cannot be signed. | gate: test/spec.test.js | serves: S5
- S16 [approved, aim] Each approved row not yet signed shows where it stands on its way to a sign-off. | gate: test/spec.test.js | serves: S5
- S17 [approved, must] Once a repo lists signers, each sign-off carries the signer's SSH signature over the row's exact text. | gate: test/signoff.test.js | serves: S5
- S18 [approved, must] A row can name who must sign it; it is met only when each has a current signed sign-off. | gate: test/signoff.test.js | serves: S17
- S19 [approved, must] spec check refuses a sign-off whose signature fails or whose key isn't listed; a changed row makes it stale. | gate: test/signoff.test.js | serves: S17
- S20 [approved, must] A change to the signer list counts only when a key already on it signs that change. | gate: test/signoff.test.js | serves: S17
- S21 [approved, must] `pullboard spec signers add` sets a repo up with the SSH key the person already uses; no GPG. | gate: test/signoff.test.js | serves: S17

## D · Doctrine
- D1 [approved, must] Pullboard ships a standard doctrine, versioned, with PB ids; every repo inherits it, Pullboard's own included. | gate: test/practice.test.js
- D2 [approved, must] A repo's PRACTICE.md adds rules, overrides one by its PB id, or declines one with a wont row and reason. | gate: test/practice.test.js | serves: D1
- D3 [approved, must] Agents and the view see one doctrine in force: inherited rules and the repo's own, each marked with its source and version. | gate: test/practice.test.js | serves: D1
- D4 [approved, must] Init writes a DOCTRINE.md for the repo's own rules only; the standard needs no copy. | gate: test/e2e.test.js | serves: D1
- D5 [wont, aim] Covered: D6 versions every change; the changelog shows it. | gate: test/practice.test.js | serves: D1
- D6 [approved, must] The standard changes only by an accepted RFC in docs/rfcs, and each change bumps its version. | gate: review | serves: D1
- D7 [approved, must] pullboard.json `components` lists the components a board has. Run packs, the AGENTS.md block and resume notes omit a rule tagged with an unlisted one. | gate: test/doctrine-tags.test.js
- D8 [approved, must] Without a `components` list, Pullboard probes each known component; `rigor` is present when `pullboard rigor quality` runs. A tag with no probe counts as present. | gate: test/doctrine-tags.test.js
- D9 [approved, must] No rule is hidden silently: the view and `spec --json` show every row with its tags, and filtered text ends by counting omitted rules per absent component. | gate: test/doctrine-tags.test.js
- D10 [approved, must] A doctrine row may name the components it pertains to in a trailing field, `tags: rigor, browser`: lowercase, comma-separated. A row without tags pertains everywhere. | gate: test/doctrine-tags.test.js

## C · Commits
- C1 [approved, must] Header: type(scope): subject [ids], 72 characters at most. | gate: test/hooks.test.js
- C2 [approved, must] Cited ids exist. feat and fix commits cite at least one. | gate: test/hooks.test.js | serves: S1
- C3 [approved, must] Pre-push runs the gate, unless this exact tree already passed it. | gate: test/e2e.test.js | serves: V4
- C4 [retired] Merged into P4, which now also says a refusal shows what it saw.
- C5 [approved, must] Pre-commit runs the configured fixers on fully staged files and restages what they fix. | gate: test/e2e.test.js
- C6 [approved, must] Submit refuses unless the item's commits since claim, together, cite every spec row the item cites. | gate: test/e2e.test.js | serves: C2
- C7 [approved, must] CI runs the gate on every push and pull request, Node 22.13 and 24, on Linux and, once public, macOS. | gate: test/ci.test.js | serves: C3

## R · Receipts
- R1 [approved, must] The ledger lists built items: lane, spec, builder, verifier, verdict, commit. | gate: test/board.test.js
- R2 [approved, must] Every move lands in an append-only event log. | gate: test/board.test.js
- R3 [approved, must] merged records only a trunk commit that contains the item's commit or carries its patch; anything else needs a note. | gate: test/merged.test.js | serves: R1

## I · Init
- I1 [approved, must] One command sets up config, spec, agent instructions, hooks and board. | gate: test/e2e.test.js
- I2 [approved, must] Init is idempotent and never overwrites a file it did not write. | gate: test/e2e.test.js
- I3 [approved, must] Init writes the standard PRACTICE.md and the role guides as Claude Code skills. | gate: test/e2e.test.js
- I4 [approved, must] `pullboard worktree <lane>` makes a joined worktree and prints its agent's opening lines: folder, identity, AGENTS.md governs. | gate: test/e2e.test.js
- I5 [approved, must] Every command pullboard suggests to an agent starts with cd to its worktree. | gate: test/e2e.test.js | serves: I4
- I6 [approved, must] Init adds a Claude Code SessionStart hook that runs `pullboard resume`, keeping every other setting. | gate: test/e2e.test.js | serves: N19
- I7 [retired] Merged into I4.
- I8 [approved, must] Init registers the project on this machine, so the view lists it. | gate: test/e2e.test.js | serves: N26
- I9 [approved, must] Init ends by telling an agent to start a new session, which loads its skills, then say what to build. | gate: test/e2e.test.js
- I10 [approved, aim] The README draws how work moves, an item's life, where things live and starting with an agent. | gate: test/readme.test.js | serves: M1
- I11 [approved, must] The README shows the board as people see it, captured from a demo board a script rebuilds. | gate: docs/shots/shots.test.js
- I12 [approved, must] The README states what runs where today, which systems are tested, and what comes next. | gate: review
- I13 [approved, aim] A recording of `pullboard tour` plays on the README and the site, regenerated by a script. | gate: docs/shots/shots.test.js
- I14 [approved, aim] A 90-second product video, rendered by a script from the demo board, plays on the README and the site. | gate: docs/shots/shots.test.js | serves: I13
- I15 [approved, must] A release is a tag on a green commit; CI publishes it to npm with provenance, never by hand. | gate: review
- I16 [approved, aim] Init ignores the folders agent tools make inside the repo, such as .claude/worktrees/, so they never block a submit. | gate: test/init-ignore.test.js | serves: I1
- I17 [approved, must] pullboard init and every registerProjectAndLink caller confirm the project is in the machine registry before saying registration is complete; relay on --all names every initialized board missing from the registry instead of skipping it silently. Measure: a board initialized but absent from projects.json is named by relay on --all; review 2026-12-07. | gate: review

## N · Next commands
- N1 [approved, must] `pullboard decide`: the person's queue of everything waiting on them.
- N2 [approved, must] `pullboard next` claims my lane's next free item; --verify names work I did not build. | gate: test/e2e.test.js
- N3 [wont, must] `pullboard context <id>`; pullboard show prints all of it.
- N4 [approved, must] `pullboard ask add` stores the client's documents in ask/, hashed; rows can cite them.
- N5 [approved, must] `pullboard spec approve` and `spec answer` record who changed a row's status, and when.
- N6 [approved, must] `pullboard prompt <role>` prints the role guide, overridable per repo. | gate: test/practice.test.js
- N7 [approved, must] `pullboard plan` proposes lanes and items from the spec and the repo; --apply writes them.
- N8 [approved, must] `pullboard run` starts configured agent commands per lane and role, under budgets and stops.
- N9 [wont, aim] `pullboard report`; spec view, the view's product progress and the ledger cover it.
- N10 [approved, aim] `pullboard tour` shows a reject and its rework with scripted agents in thirty seconds. | gate: test/e2e.test.js
- N11 [approved, aim] A git-pullboard bin, so `git pullboard <command>` works.
- N12 [wont, aim] `pullboard mcp` serves the commands as MCP tools; A9 covers it.
- N13 [approved, must] `next` names items still awaiting a verdict; a lane is done when its items are verified. | gate: test/board.test.js | serves: N2
- N14 [approved, must] `pullboard run` builds routed items unattended: a command per tier, verified dependencies merged, check, retry, submit or escalate. | gate: test/e2e.test.js | serves: N8
- N15 [approved, must] `pullboard sweep` files a checker's problems as light items, one per file, each check seen failing first. | gate: test/sweep.test.js, test/e2e.test.js
- N16 [retired] Merged into N14.
- N17 [retired] Merged into N15.
- N18 [retired] Model ladders and routing by history left the core for a separate project; the core keeps tiers and escalation.
- N19 [approved, must] `pullboard resume` prints one short card: the claim, the branch against main, what came back, unread shouts, the next step. | gate: test/e2e.test.js
- N20 [approved, must] Within a tier, `next` takes the item sharing most files with the agent's recent work, and names them. | gate: test/board.test.js, test/e2e.test.js | serves: N2
- N21 [approved, must] Submit records the files an item changed; show and the run pack name verified items that share them. | gate: test/board.test.js, test/e2e.test.js
- N22 [approved, must] `pullboard hold <lane>` pauses a lane: nothing new is claimed there, and next says who held it and why. | gate: test/board.test.js, test/e2e.test.js
- N23 [approved, must] `pullboard check [id]` runs an item's check command, yours by default, and prints a digest. | gate: test/e2e.test.js
- N24 [approved, must] Output piped into a reader that stops early, such as head, ends quietly, with no stack trace. | gate: test/e2e.test.js
- N25 [approved, must] Every wait pullboard suggests names its unit and fits one ten-minute tool call. | gate: test/e2e.test.js | serves: N13
- N26 [approved, must] `pullboard view` serves every project's board on localhost, behind a per-session secret. | gate: test/e2e.test.js
- N27 [approved, must] From the view, the person adds items, shouts and holds lanes; each runs the CLI command. | gate: test/e2e.test.js | serves: N26
- N28 [approved, must] The view shows each product's progress: rows met, and items open, building and verified. | gate: test/e2e.test.js | serves: S11
- N29 [draft, must] `pullboard why <path|id>`: the rows, doctrine and verified items behind it, rejections included. | gate: test/e2e.test.js
- N30 [approved, must] `show` prints the latest verdict in full and earlier ones as one line each; --history prints them all. | gate: test/show.test.js
- N31 [approved, must] `pullboard prompt run` and the pullboard-run skill guide one agent through the team: spec, plan, builders, verifier, merges. | gate: test/practice.test.js
- N32 [draft, must] The coordinator's resume names its next step from board and spec: spec, approve, plan, build, verify or merge. | gate: test/e2e.test.js
- N33 [draft, must] A repo names its project in pullboard.json, and the view lists projects with their repos beneath. | gate: test/cockpit.test.js | serves: N26
- N34 [approved, must] A project has one Needs-you and one activity feed across its repos; each repo keeps its own board. | gate: test/cockpit/needs.test.js | serves: N33
- N35 [draft, aim] A repo whose folder is gone leaves the view; `pullboard forget <path>` removes one by hand. | gate: test/e2e.test.js | serves: N26
- N36 [draft, aim] The view names each repo as pullboard.json does, falling back to its folder name. | gate: test/cockpit.test.js | serves: N26
- N37 [draft, must] pullboard help keeps each command's usage apart from its words, so tools can read it. | gate: test/e2e.test.js
- N38 [draft, must] Every tab, item, row and shout in the view has its own address, so any of them can be linked. | gate: test/cockpit.test.js | serves: N26
- N39 [approved, must] The view's secret never stays in the address bar: the first link trades it for a cookie. | gate: test/e2e-view.test.js | serves: N26
- N40 [approved, must] Every action in the view answers within 100 ms and never over 250 ms, on a board of 3,000 items with eight projects open. | gate: test/cockpit/perf.test.js | serves: N26
- N41 [approved, must] The Herdr TUI Pullboard panel (built from the pullboard.needs plugin) opens as a side panel split to the right of the focused terminal pane, not a popup, and reads every board on this machine through the local view's API (/api/v1 with the view's session secret), with a board switcher; it starts pullboard view when none is running and follows the view's live event stream, falling back to polling. Measure: opening it beside a terminal pane leaves that pane visible on the left, and with the view stopped it starts the view and lists every board the web UI lists. | gate: review
- N42 [approved, must] The TUI Pullboard panel shows everything the web UI shows: items with search and detail, spec, doctrine, Needs you, roadmap, shouts, activity, settings (read-only) and relay status. Measure: for one board state, each web UI tab's rows appear in the panel's matching tab, checked by a test against the same /api/v1 state document. | gate: review
- N43 [approved, must] Every action the Pullboard web UI offers works from the TUI panel as the person, through the same /api/v1 moves and endpoints: approve or decline spec and doctrine rows (one or a whole section), approve or decline sentinels, shout to an agent or lane, request to the coordinator, answer decisions, add an item, hold or release a lane, list and revoke agent credentials, relay sign-in and sharing (opening the browser for GitHub's step), forget unreadable boards, and run a Needs-you step. A refusal shows the code and next step. Measure: a test drives each action from the panel and sees the same move recorded as from the web UI. | gate: review

## A · API: the engine others build on
- A1 [approved, must] Every command prints --json in a documented shape, stable within a major version. | gate: test/api.test.js
- A2 [approved, must] `pullboard serve` offers a versioned local HTTP API: the board's state, its moves, and live events. | gate: test/api.test.js
- A3 [approved, must] The view uses that API and nothing else, so any app can do what the view does. | gate: test/api.test.js | serves: A2
- A4 [approved, must] The relay serves the same API, sealed, so a client with the key works the same locally or on pullboard.dev. | gate: test/relay.test.js | serves: A2
- A5 [approved, must] SPEC.md's grammar, the board's schema and its event log are documented, versioned, and upgraded in place. | gate: test/api.test.js
- A6 [approved, must] `pullboard doctor` checks a board's integrity and names how to repair each thing it finds. | gate: test/api.test.js
- A7 [approved, aim] `pullboard export` writes a whole board as JSON, and `import` rebuilds it, losing nothing. | gate: test/api.test.js
- A8 [approved, aim] The gate passes on macOS, Linux and Windows. | gate: test/ci.test.js | serves: C7
- A9 [approved, aim] An agent can work the board through MCP tools, with the same moves and refusals as the CLI. | gate: test/api.test.js
- A10 [approved, aim] The view exports a board as a read-only static snapshot that replays its events, for any static host. | gate: test/cockpit.test.js | serves: A3

## H · Relay: pullboard.dev, opt in
- H1 [approved, must] `pullboard relay on|off` links this board to pullboard.dev, after a GitHub sign-in. | gate: test/relay.test.js
- H2 [approved, aim] With the relay, each agent has its own token, so a verdict records which agent gave it. | gate: test/relay.test.js
- H3 [approved, must] With the relay on, every move passes through it in one order: a claim is won once, everywhere. | gate: test/relay.test.js | serves: H1
- H4 [retired] Merged into H16: clients, not the relay, apply moves in the relay's order.
- H5 [approved, must] Signed in and paired, you see and act on your boards live, on phone or desktop. | gate: test/relay.test.js | serves: N26
- H6 [retired] Merged into H12.
- H7 [approved, must] The relay holds board records, never code; unlinking loses nothing, since the local board stays complete. | gate: test/relay.test.js
- H8 [approved, must] You see and act only on boards of repos your GitHub account can read. | gate: test/relay.test.js
- H9 [approved, aim] An agent that can't push reaches the relay with a token scoped to one board. | gate: test/relay.test.js | serves: H1
- H10 [approved, aim] Offline, a linked board reads locally and refuses moves until the relay answers. | gate: test/relay.test.js | serves: H3
- H11 [approved, aim] Without an account, `pullboard sync` keeps one board across machines through the repo's own git remote. | gate: test/sync.test.js
- H12 [approved, must] pullboard.dev never writes to a repo: what you do there, like approving a row, reaches your agents as a request. | gate: test/relay.test.js | serves: H6
- H13 [approved, must] Acting on a board, and minting its tokens, needs write access to its repo. | gate: test/relay.test.js | serves: H8
- H14 [approved, must] A public repo's board is hidden from readers without triage access, unless its owner publishes it. | gate: test/relay.test.js | serves: H8
- H15 [approved, must] The relay can't read boards: the CLI seals every move and snapshot with a key that stays on your devices. | gate: test/relay.test.js | serves: H7
- H16 [approved, must] Every client applies moves in the relay's order with the CLI's engine, refusing what the CLI refuses. | gate: test/relay.test.js | serves: H3
- H17 [approved, must] A phone or machine joins a board by pairing once, from a code or QR a linked machine prints. | gate: test/relay.test.js | serves: H15
- H18 [approved, must] The relay keeps a board only while linked: unlinking deletes it; 90 idle days delete it; backups last 14 days. | gate: test/relay.test.js | serves: H7
- H19 [approved, aim] Without the relay, a phone sees and acts on a board through the view on the local network, after scanning a pairing code. | gate: test/cockpit/lan.test.js
- H21 [approved, aim] A linked board reads and moves locally whether or not the relay answers: every move returns at once and is sent when the relay is reachable, and a conflict found on sync is refused loudly naming the winner (revises H10 for #1013). | gate: test/relay-local-first.test.js
- H22 [approved, aim] A linked board stays linked: the person signs in once per machine, and only relay off or a revoke unlinks it. | gate: review
- H23 [approved, must] Relay status reads never write the link: relay status and pullboard status run no catch-up save or credential migration save, and every link save happens under locked(file). Measure: a test runs both status reads against a read-only link file and sees no write and no error; review 2026-12-07. | gate: review
- H24 [approved, must] A board policy that changes whether a move is accepted (verifierStanding) is part of replay: the local apply runs under the same standing and policy the relay replay uses, and a policy change that alters replay outcomes either bumps the engine or lands as an ordered move, so a verify one replica accepts no other replica refuses. Measure: replaying a board's ordered log on another machine yields the same item states; review 2026-12-07. | gate: review
- H25 [approved, must] When a queued move is refused on replay, every later queued move from the same seat that depends on it (an activity delivery receipt naming events that move created) is rebased or dropped with the refusal, never replayed into BAD_ACTIVITY_RECEIPT. Measure: kept BAD_ACTIVITY_RECEIPT refusals fall to zero; review 2026-12-07. | gate: review
- H26 [approved, must] A kept relay refusal retires once a later accepted receipt covers the same item and operation by the same seat, and relay status lists only refusals still unresolved. Measure: relay status on a board whose refused moves were all later redone lists zero kept refusals; review 2026-12-07. | gate: review
- H27 [approved, must] relay on and relay on --all link a board only when the signed-in account has write access to its origin repository: otherwise they refuse WRITE_REQUIRED before writing the board id or a link without a credential, and a relay request with no bearer credential is refused AUTH_REQUIRED naming the board to relink, never BAD_ORIGIN (which is for browser cookie writes). Measure: relay status never shows linked with an empty account; review 2026-12-07. | gate: review

## E · Teams: many people, one board

- E1 [approved, must] A team shares one board: every person's clones, machines and phones show the same items in one order. | gate: test/team.test.js
- E2 [approved, must] Two people adding or claiming at once never make two #1s or two holders; the relay's order decides. | gate: test/team.test.js
- E3 [approved, must] Each person signs in as themselves; every move records the person, and the agent if one made it. | gate: test/team.test.js
- E4 [approved, must] A board's people are its repository's writers; only the approvers pullboard.json names approve rows or answer person decisions, and a change to that list takes effect only once an existing approver approves it. | gate: test/team.test.js
- E5 [approved, must] Every agent acts with its own token under the person running it, never as its checkout path; removing a person stops their agents. | gate: test/team.test.js
- E6 [approved, must] Removing a person's write access removes them from the board; the next member device online rotates the key, so their devices read nothing made after it. | gate: test/team.test.js
- E7 [approved, must] Main moves in one landing order, sequenced on the trunk's board; a second landing builds on the first or is refused. | gate: test/team.test.js
- E8 [approved, must] A verdict reads stale on every replica once main moves under it in a file the item changed, until re-verified or landed. | gate: test/team.test.js
- E9 [approved, must] Every session on a paired machine works the board alike: terminal, SSH, agent, scheduled job or CI; the key sits in an owner-only file. | gate: test/team.test.js
- E10 [approved, must] A CI drill proves it: two people, two machines, a keyless session and a private board share work through a local relay. | gate: test/team.test.js
- E11 [approved, must] Each person may keep a private board per repo in ~/.pullboard; its items stay on that person's devices. | gate: test/team.test.js
- E12 [approved, must] pullboard.json names the repo's board and its approvers; a clone of a linked repo joins that board, and the relay refuses to link a second team board to the same repo. | gate: test/team.test.js
- E13 [approved, must] A new item goes to the repo's board; --private keeps it on the person's own board. | gate: test/team.test.js
- E14 [approved, must] Across boards an item is named handle#id, as web#12 or alice/web#7. | gate: test/team.test.js
- E15 [approved, must] Move re-homes an open or verified item in one sequenced move; its old id points to the new one and is never reused. | gate: test/team.test.js
- E16 [approved, must] Pairing registers a device key, and each board key is wrapped to its members' devices, so adding or removing a member needs no new code. | gate: test/team.test.js
- E17 [approved, must] A member's new device gets its board keys from any online member device once an SSH key on their GitHub account signs its device key. | gate: test/team.test.js
- E18 [approved, must] A CI or cloud session reads and moves with a board key and an agent token from its environment, scoped to one board. | gate: test/team.test.js
- E19 [approved, must] Each board has one coordinator, held by one session at a time; takeover passes it between sessions, machines and people. | gate: test/team.test.js
- E20 [approved, must] Only a board's approvers can unlink it or replace its snapshot, and a move no member can open is set aside without stopping replay. | gate: test/team.test.js
- E21 [approved, must] An agent's grant is a subset of its person's; at claim it narrows to the item's lane and criterion, and it ends with the lease. | gate: test/team.test.js
- E22 [approved, must] Person-only moves carry the person's signature from the phone or an SSH key; agents never hold their person's relay credential. | gate: test/team.test.js
- E23 [approved, aim] Join and claim write the agent's grant into its harness's own permission rules: its lane writable, key files and pushes denied. | gate: test/team.test.js
- E24 [approved, must] Every default names who can change it; an override is a signed record with a reason and an expiry. | gate: test/team.test.js
- E25 [approved, must] A trunk lands one batch at a time under its board's landing lease; the rest queue behind it. | gate: test/team.test.js
- E26 [approved, must] A batch takes the trunk's verified items in verdict order. | gate: test/team.test.js
- E27 [approved, must] pullboard.json names the landing gate, its timeouts, its cadence and the environment it must run in; land runs the batch on a matching host. | gate: test/team.test.js
- E28 [approved, must] A machine joins a trunk's landing pool by its own setting, and every gate run and verdict records the environment it ran in. | gate: test/team.test.js
- E29 [approved, must] A red batch that bisects to no culprit files a defect against the failing test; the trunk holds until it's fixed or an approver signs an expiring waiver. | gate: test/team.test.js
- E30 [approved, aim] A merge queue lands verified items in the trunk board's order, with no one running land by hand. | gate: test/team.test.js
- E31 [approved, aim] A private item lands on the repo's trunk with a receipt: its id, commit and verifier, never its text. | gate: test/team.test.js
- E32 [approved, aim] A repo's board can name a parent board, and approvers on both sides sign the link. | gate: test/team.test.js
- E33 [approved, aim] A parent item shows its children's states from the boards below, never their text. | gate: test/team.test.js
- E34 [approved, aim] A board chooses what its link carries up: states, counts or nothing. | gate: test/team.test.js
- E35 [approved, aim] A board offers an item to a board below, which accepts it as a child or declines with a reason. | gate: test/team.test.js
- E36 [approved, aim] A rule set on a board holds on every board below it. | gate: test/team.test.js
- E37 [approved, aim] A board below loosens an inherited rule only with an approver's signed, expiring waiver. | gate: test/team.test.js
- E38 [approved, aim] Rules reach boards below as a signed bundle any board can verify offline. | gate: test/team.test.js
- E39 [approved, aim] A decision spanning two boards with no common parent needs an approver from each. | gate: test/team.test.js
- E40 [approved, aim] A planning repo's board sits above team boards, and its members are that repo's writers. | gate: test/team.test.js
- E41 [approved, aim] A board can have two parents, and both parents' rules apply. | gate: test/team.test.js
- E42 [approved, aim] Detaching a board keeps its inherited rules as its own, and its old parent stops receiving its states. | gate: test/team.test.js
- E43 [approved, aim] Handles carry an organization prefix across organizations, as acme/web#12. | gate: test/team.test.js

## Q · Queues and procedures
- Q1 [approved, must] A resource has a name, a capacity, a scope (machine, repo or board) and a queue. | gate: test/resources.test.js
- Q2 [approved, must] Taking a full resource queues the taker in order, and it says what it waits behind. | gate: test/resources.test.js | serves: Q1
- Q3 [approved, must] A resource is held under a lease, so a holder that dies frees it when the lease lapses. | gate: test/resources.test.js | serves: Q1
- Q4 [approved, must] Each gate run takes one of its machine's gate slots, two by default; a cached pass takes none. | gate: test/resources.test.js | serves: Q1
- Q5 [approved, aim] Procedures are state machines declared as data: states, moves, actors, guards and resources. | gate: test/procedures.test.js
- Q6 [approved, aim] The item lifecycle runs from its declaration, as the first procedure. | gate: test/procedures.test.js | serves: Q5
- Q7 [approved, aim] Agents raise proposals from friction; another agent reviews the evidence; the coordinator adopts. | gate: test/procedures.test.js | serves: Q5
- Q8 [approved, must] An adopted procedure starts as a draft for the person to approve, and they can suspend it any time. | gate: test/procedures.test.js | serves: Q7
- Q9 [approved, must] spec check refuses a procedure with an unreachable state, a move no actor can make, or a resource cycle. | gate: test/procedures.test.js | serves: Q5
- Q10 [approved, must] Procedures only add structure: they queue, order and guard moves, and never drop a standard guard. | gate: test/procedures.test.js | serves: Q5
- Q11 [approved, aim] A repo option says when a draft procedure runs: at once by default, once approved, or never. | gate: test/procedures.test.js | serves: Q7
