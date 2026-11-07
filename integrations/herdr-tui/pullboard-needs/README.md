# Pullboard: needs you (Herdr TUI plugin)

A Herdr popup listing what needs you on one Pullboard board. It reads `pullboard needs --json`
in the board's folder, and runs each step of a need in order, in a new tab of the workspace
you were in. It never writes the board itself: an ask's step is marked done by the tab's script
after its command exits 0, so agents pick it up at their next check and are never interrupted.

## Install

From the board's main checkout:

    sh integrations/herdr-tui/pullboard-needs/install.sh [--root <board dir>] [--key <binding>] [--dry-run]

It copies the plugin to `<config>/plugins/local/pullboard.needs`, where `<config>` is
`$HERDR_CONFIG_DIR` or `~/.config/herdr`, writes the board folder to its `config.json`, adds it to
`plugins.json`, and binds its open action in `config.toml` inside a managed block it replaces on
the next run. Before writing, it backs every file it changes up to
`<config>/backups/pullboard-needs-<time>` and prints that path, and the new `config.toml` must
pass `herdr config check`. A binding that is already taken is refused; pick another with
`--key`. `--dry-run` prints the plan and writes nothing. Then run `herdr server reload-config`
or restart Herdr.

If the running Herdr server rewrites `plugins.json` and drops the entry, link the installed
folder instead:

    herdr plugin link ~/.config/herdr/plugins/local/pullboard.needs

## Use

Press `prefix+y` (or the key you chose). In the list, `j`/`k` or the arrows move, `enter` opens
a need, `r` refreshes and `q` quits. In a need, `enter` starts the next step: fill in any
prompts, confirm with `y`, and the step runs in a new tab that stays open. `b` goes back.

## Environment

- `PULLBOARD_NEEDS_ROOT`: the board folder to read, overriding the one `config.json` names.
- `PULLBOARD_NEEDS_FIXTURE`: a JSON file to show instead of running `pullboard needs --json`,
  for trying the popup out; `fixture.json` here is one.
- `HERDR_BIN_PATH`: the `herdr` binary to call, if it is not on PATH.
