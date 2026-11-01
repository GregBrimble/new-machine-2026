# Status, repair and CLI reference

Each component exposes Effect operations for inspection and repair. The runner
reinspects after repair by default; components can supply custom verification.
The shared engine in [`src/runner.ts`](../src/runner.ts) supports a selected component
or all components, with declared dependencies and interaction requirements.
These operations are the foundation for a future status UI and its repair buttons.

```sh
# Show current state, reporting individual errors and continuing other checks:
/bin/bash bootstrap.sh --status
# Inspect one component without inspecting its dependencies:
/bin/bash bootstrap.sh --status --component appearance
# Repair one component, checking/repairing its dependencies first:
/bin/bash bootstrap.sh --component vlc-settings
# Stream status snapshots as newline-delimited JSON:
/bin/bash bootstrap.sh --status --json
# Repair all components with progress events and individual error reporting:
/bin/bash bootstrap.sh --json
```

Repeat `--component` to select several. Invalid IDs or dependency graphs fail
before component operations start. `--plan` is the fail-fast inspection mode;
`--status` continues after inspection errors so every selected component gets a
result. Status checks can require Automation permission. All launcher modes still
prepare the runtime as described above.

JSON output contains a `start` record with protocol version `1`, `component`
snapshots, and a `complete` record with final states and success. Fatal startup
errors emit `fatal`. Component snapshots include stable IDs, descriptions,
dependencies, interaction requirements, phase, status, detail, and whether repair
was verified. Bootstrap and interactive installer output goes to stderr, keeping
stdout parseable. Component failures and blocked repairs produce exit status 1.

`runComponents` accepts an event callback for a UI to consume directly without
parsing console text. It continues independent work after a component failure
and blocks repairs that depend on that failure. The ordinary text apply command
keeps fail-fast behavior. Operations run sequentially; a future UI should allow
one status/repair run at a time. No server or background reconciliation is started.
Spotlight remains `unknown` after repair because its status cannot be queried
independently; its event still records that the repair completed. Its metadata
marks the Automation and Accessibility requirements for an explicit repair action.

`--dry-run` lists selected components without inspecting or applying them.
`--profile shared|personal|cloudflare`
selects component-local profile choices (shared is the default).

All modes except `--help` prepare the runtime first and ask zsh for its startup
directory. On a fresh machine this can install Homebrew, mise, Node and runner
dependencies. The zsh query runs `.zshenv`, including any commands it contains,
without loading `.zprofile` or `.zshrc`. Reading appearance can prompt for
Automation permission; Spotlight status stays `unknown`.
