# Pullboard panel for Herdr

A Herdr app panel for one Pullboard board. Every 15 seconds it runs, in the board's folder:

    pullboard health --json
    pullboard status --json
    pullboard list --json
    pullboard resources --json
    pullboard settings --json

`exec` runs them with your own PATH and environment, so the panel needs no token or port.
A read that fails shows as a red error line naming the command, and each section drawn from
it says Unknown instead of its calm text; the panel never shows a failed read as an empty board.

## What it shows

- **Needs you**: every entry of `pullboard needs --json` (sign-offs, decisions, rows to
  apply, asks agents filed). Each step shows in order; only the next one has
  **Run in new tab…**. It opens an input for each prompt and a preview of the filled
  command, then **Confirm: run in new tab** opens a tab in the "Needs you" space (made on
  first use), runs the command in the step's folder and leaves the shell open. When an
  ask's step exits 0, the tab runs `pullboard ask done <id> --step <k> --as person` itself.
  A step with a prompt must use it as a bare word, with only letters, digits, spaces and
  `_ . / : @ % + , = -` around it, and each answer must be one line; anything else is
  refused with the reason instead of filled. A pullboard
  without the `needs` command shows one quiet line instead.

  To run several at once, click **[ ] Select** on each need (it turns to **[x] Selected**;
  click again to drop it). A need whose next step is missing, names no folder or has a
  placeholder that cannot be filled safely shows **Not selectable** with the reason
  instead. **Run selected (N)** then asks every prompt of every selected step, top to
  bottom, one at a time with its default prefilled; a selected ask brings all its remaining
  steps. One numbered screen lists each filled command with its folder, and
  **Confirm: run N steps in new tab** opens one tab that runs them in order: a
  `[k/N] <label>  (in <folder>)` header before each, `pullboard ask done` after each ask
  step that exits 0, a stop at the first non-zero exit
  (`stopped at [k/N]: exit <code>; later steps not run`), then a done / failed / not run
  line per step, and the shell stays open. Cancel at any point runs nothing.

- **Needs attention**: halted work that `pullboard health` gives no reason for, flagged,
  with a recommendation and the command that acts on it:
  - a claimed item whose holder is idle or gone: resume the holder or release the claim;
  - an open, unblocked item while a live seat that could take it (same lane, route high
    enough) holds nothing: that seat runs `pullboard next`;
  - an open, unblocked item with no live seat that could take it: `pullboard worktree <lane> --route <route>`;
  - a submitted item with no live review seat: `pullboard worktree review`.

  Not flagged: an item that waits on open `after` items, or on capable seats that are all busy.
- **Halts**: every `health` finding, grouped by cause, with why, the next step and who takes it.
- **Seats**: live, idle or gone, lane, route, model and the items each holds. Retired seats are left out.
- **Test capacity**: gate and browser slots used and free, the line waiting for each, short
  slots, runners-first, and each registered runner's slots. A pool nobody has used yet shows
  the size its setting gives it. The − and + buttons run
  `pullboard settings gateSlots <n>` or `browserSlots <n>`; a move the board would refuse
  (gate below browser, browser above gate, 0 with no runner) is refused in the panel first,
  and the board's own answer or refusal shows under the section. While `settings` cannot be
  read the buttons are off, since a move is relative to the current count.

People and agents share the slot controls. An agent runs, from any terminal:

    herdr-app do pullboard.gateSlots-up      # or gateSlots-down, browserSlots-up, browserSlots-down
    herdr-app do pullboard.refresh

Each command makes the same move as its button, under the same checks, and the board's answer
or refusal shows under Test capacity. An unknown command is refused there by name.

## Which board

Set the `board` prop to the board's folder. Without it, the panel reads the board of the
focused pane's folder at each refresh.

To open only the Needs-you list in its own tab:

    herdr-app do tab.new '{"name":"Needs you","mod":"pullboard","props":{"view":"needs","board":"<board folder>"}}'

The `needsFile` prop reads a saved JSON file instead of running the command (for example
`test/needs.json` in this folder, which stays in the repo and is not installed).

## Install

Herdr loads mods from its app home, never from this folder. From the repo root:

    scripts/install-herdr-mod.sh --dry-run
    scripts/install-herdr-mod.sh

It copies only the tracked files here, backs an old copy up under `mod-backups/` outside
`mods/`, and leaves layouts, other mods and the app alone. `HERDR_APP_HOME` overrides the
app home.

## Files

- `read-model.js`: pure; turns the five reads into what the panel draws. Tests import it.
- `cli.js`: runs the reads and slot moves through Herdr's `exec`.
- `needs-model.js`: pure; quoting, filling prompts, step state and the launch command.
- `needs-batch.js`: pure; which needs can join a batch, its prompts, steps and one script.
- `needs-view.js`: the Needs-you section.
- `main.js`: the Herdr view.
