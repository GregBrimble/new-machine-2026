# macOS VM smoke test

This is an opt-in, attended end-to-end test on an Apple Silicon Mac. It clones a
fresh macOS Tahoe **vanilla** image, runs the real initializer, checks the result,
runs it again, then restarts the VM and checks login startup and background
Downloads access. Normal `npm test` does not start a VM or install software.

Install [Tart](https://tart.run/quick-start/) on the host, then run:

```sh
brew install openai/tools/tart
npm run test:vm
# Test uncommitted checkout contents instead of the public curl entry point:
npm run test:vm -- --local
```

The driver itself needs only Bash and Tart, so `/bin/bash vm/run.sh` works without
Node installed on the host. Allow at least **60 GiB free** for the image cache,
guest disk, developer tools, and apps; the image download is roughly 25 GB.
The test uses the image's resource defaults (4 CPUs, 8 GiB RAM, and a 50 GB disk
for the default vanilla image). The host initializer does not install Tart automatically.

The VM opens visibly. Its default credentials are `admin` / `admin`. In its
Finder, use Go > Go to Folder to open:

```text
/Volumes/My Shared Files/bootstrap-input/start.command
```

Follow the Terminal instructions: allow Automation prompts, enable Terminal's
Accessibility access, and leave the keyboard and System Settings alone during
Search Privacy automation. Grant any normal Downloads permission prompts.
Choose a disposable passphrase when SSH signing key generation asks, then enter
it again to save it in the guest's Keychain. No GitHub account or key upload is
needed: the test checks signing and verification locally. After restart, its
first signed commit exercises the signing helper's Keychain reload.
Finally, visually check both Search Privacy exclusions and type `yes`. macOS has
no supported folder-level API for independently reading that exclusion list.
The test never edits the TCC database or disables SIP to bypass these steps.

The host restarts the VM automatically. A test-only LaunchAgent opens Terminal
to continue after login; this also exercises the real Downloads helper's login
startup. A second test-only LaunchAgent invokes the installed helper with its
real cleanup command, shortening the age to two seconds and restricting names
to unique test fixtures in Downloads. It confirms an aged file is trashed and
a partial download is preserved, under the background process's own permissions.
A permission failure fails the test and keeps the VM available for inspection.

Checks cover the pinned Node version, Homebrew-owned mise, zsh activation and
completions, zoxide's shell functions, the editable configuration checkout,
the Apple container CLI, application bundles and Homebrew receipts, dark appearance, Git SSH signing,
VLC, the Developer directories, Finder's Trash preference, configuration file
hashes, package versions, and background helper startup. Repeat application must
leave those files and package versions unchanged; only Spotlight's ensure step
is expected to report application again. The test checks scheduler registration
and actual background file access; it does not wait for macOS's discretionary
24-hour activity or Finder's 30-day retention period.
The container check runs `container --version`; running Linux containers inside
this macOS guest would require nested virtualization and is outside this test.

Logs, snapshots, the checkout commit/diff, and a snapshot hash are saved in the
printed temporary artifacts directory. Published mode tests the moving public
`main` entry point against this checkout's expectations; synchronize the checkout
with `main` first. Local mode snapshots current source, including uncommitted
changes, and runs `bootstrap.sh` from that snapshot. No host home directory,
credentials, or SSH agent are shared. Test source is mounted read-only; only the
artifacts directory is writable by the guest.

The VM is stopped and deleted after success. On failure or interruption it is
stopped and retained with its name printed. Resume it for inspection with
`tart run <name>`, and remove it with `tart delete <name>` when finished. Tart's
downloaded image cache persists across runs.

For a fixed OS image, pass a versioned image or OCI digest:

```sh
/bin/bash vm/run.sh --image ghcr.io/cirruslabs/macos-tahoe-vanilla@sha256:<digest>
```

The default follows `:latest` to find macOS regressions. The
[vanilla image template](https://github.com/cirruslabs/macos-image-templates/blob/main/templates/vanilla-tahoe.pkr.hcl)
sets up auto-login, passwordless sudo, remote access, and disables Gatekeeper;
the guest test re-enables Gatekeeper before installing anything. The image is a
clean tooling environment with those test conveniences, rather than Setup
Assistant on an untouched laptop.
