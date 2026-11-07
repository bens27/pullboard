# Pullboard panel for Herdr

A Herdr app panel for one Pullboard board. Every 15 seconds it runs, in the board's folder:

    pullboard health --json
    pullboard status --json
    pullboard list --json
    pullboard resources --json
    pullboard settings --json

`exec` runs them with your own PATH and environment, so the panel needs no token or port.
A read that fails shows as a red error line naming the command; the panel never shows a
failed read as an empty board.

## What it shows

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
  slots, runners-first, and each registered runner's slots. The − and + buttons run
  `pullboard settings gateSlots <n>` or `browserSlots <n>`; a move the board would refuse
  (gate below browser, browser above gate, 0 with no runner) is refused in the panel first,
  and the board's own answer or refusal shows under the section.

The slot buttons are click-only: the panel registers no `herdr-app do` command for them.

## Which board

Set the `board` prop to the board's folder. Without it, the panel reads the board of the
focused pane's folder at each refresh.

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
- `main.js`: the Herdr view.
