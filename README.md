# New machine 2026

A macOS initializer written in TypeScript with Effect. A small Bash launcher
prepares Homebrew, Homebrew-owned mise, the pinned Node version, and locked npm
dependencies before running the components.

## Run

Run as your normal user:

```sh
curl --fail --silent --show-error --location \
  'https://raw.githubusercontent.com/GregBrimble/new-machine-2026/main/bootstrap.sh' |
  /bin/bash -s --
```

Append `--profile personal` or `--profile cloudflare` after `--` as appropriate.
Both currently share the same settings. Homebrew can prompt for your administrator
password and Command Line Tools. Rex asks for the private configuration’s age
passphrase on first install. Signing asks for its own passphrase; macOS settings
can prompt for Automation and Accessibility permissions.

From an existing checkout:

```sh
/bin/bash bootstrap.sh --status
/bin/bash bootstrap.sh --component vlc-settings
/bin/bash bootstrap.sh --status --json
```

See the [CLI reference](docs/cli.md) for preview, inspection, targeted repair and
the JSON event protocol. **Every mode except `--help` prepares the runtime first**,
so even a preview can install runtime prerequisites on a fresh Mac.

## Edit a component

Desired settings live beside their implementation in [`src/components`](src/components).
There is no central configuration object. [`index.ts`](src/components/index.ts)
lists the components, their dependencies and their interaction requirements.
[`Machine`](src/machine.ts) contains runtime context: home, resolved zsh startup
directory, selected profile, and launcher-provided Homebrew/mise executables.

| Change | Module |
| --- | --- |
| Appearance | [appearance.ts](src/components/appearance.ts) |
| Packages and personal/Cloudflare package additions | [homebrew.ts](src/components/homebrew.ts) |
| Rex and its encrypted installer | [rex.ts](src/components/rex.ts), [private setup](docs/components.md#private-setup-and-rex) |
| Homebrew/mise activation and zsh completions | [shell.ts](src/components/shell.ts) |
| Developer layout | [developer.ts](src/components/developer.ts) |
| This repository's persistent checkout | [checkout.ts](src/components/checkout.ts) |
| Git defaults and SSH signing | [git.ts](src/components/git.ts), [signing.ts](src/components/signing.ts) |
| VLC playback and subtitles | [vlc.ts](src/components/vlc.ts) |
| Downloads cleanup and Finder's Trash retention | [downloads.ts](src/components/downloads.ts), [trash.ts](src/components/trash.ts) |
| Search Privacy exclusions | [spotlight.ts](src/components/spotlight.ts) |

Edit a module's `settings` function; use `machine.profile` there for profile-specific
choices. Add a component to the registry when introducing a new responsibility.
Components validate their inputs before operations begin. The runner inspects,
applies when needed, then reinspects to verify; a component can override verification.

The initializer keeps an editable checkout at
`~/Developer/repos/github.com/GregBrimble/new-machine-2026`. Existing branches,
files and remotes are preserved; reruns never pull or reset it. Run that checkout's
`bootstrap.sh` to apply local edits. The hosted command runs downloaded source.

See [component behavior](docs/components.md) for signing enrollment, Downloads
retention, shell setup, Spotlight permissions, containers and the repository layout.
Open a new login terminal after shell changes. Downloads cleanup runs in the
background after login; other components run when you invoke the initializer.

## Develop and test

```sh
mise exec "node@$(cat .node-version)" -- npm ci --ignore-scripts
mise exec "node@$(cat .node-version)" -- npm run check
mise exec "node@$(cat .node-version)" -- npm test
```

Node runs TypeScript directly; there is no build step. Ordinary tests use temporary
files, focused component fixtures and simulated bootstrap tools. They do not
install applications or change host settings. GitHub Actions runs these checks
on macOS for each push and pull request.

For a full clean-machine install, repeat and restart check, run
`npm run test:vm -- --local`. The [VM guide](vm/README.md) covers prerequisites,
public-entry-point testing, artifacts, networking and debugging. The Effect host
owns VM lifecycle and deadlines; a Python VNC driver handles guest permissions.

The launcher uses macOS tools before Node exists. It downloads an archive when
outside a checkout, prepares Homebrew and mise, selects `.node-version`, and
installs locked production dependencies with scripts disabled. Hosted temporary
source is cleaned up on exit; Homebrew, mise, Node, npm's cache and the editable
checkout persist. Local runs reuse dependencies when the lock fingerprint matches.
