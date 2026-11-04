# macOS VM smoke test

This is an opt-in, unattended end-to-end test on an Apple Silicon Mac. It clones a
fresh macOS Tahoe **vanilla** image, runs the real initializer, checks the result,
runs it again, then restarts the VM and checks login startup and background
Downloads access. Normal `npm test` does not start a VM or install software.

Install [Tart](https://tart.run/quick-start/) on the host, then run:

```sh
brew install openai/tools/tart age
npm run test:vm
# Test uncommitted checkout contents instead of the public curl entry point:
npm run test:vm -- --local
# Operate the guest yourself for debugging:
npm run test:vm -- --attended
# For headless runs, supply an already decrypted private cask:
npm run test:vm -- --local --private-cask /path/to/rex.rb
# Behind a TLS-inspecting proxy, provide its public CA certificates:
npm run test:vm -- --ca-bundle /path/to/corporate-ca.pem
```

The Effect host driver requires Node and this checkout's npm dependencies, plus
Tart and age. Run `npm ci --ignore-scripts` first. The driver asks age to decrypt
`private/rex.rb.age` in the host terminal before creating the VM; the guest then
installs Rex from that cask without receiving the passphrase. `--private-cask`
uses an already decrypted local file instead and avoids that prompt.
Unattended interaction also requires Python 3.11+ and Swift command line tools. It caches a Python virtual environment
with the versions in `vm/requirements.txt` and compiles an Apple Vision OCR helper.
`vm/driver.ts` owns process scopes, guest status, deadlines, restart and cleanup;
`vm/ui.py` only handles VNC input and expected permission dialogs. Attended mode
uses the same Effect lifecycle without the Python UI driver. Allow at least **60 GiB free** for the image cache,
guest disk, developer tools, and apps; the image download is roughly 25 GB.
When the selected image is already cached, the driver requires **30 GiB free**
for the new clone and installations. The default image is pinned by OCI digest;
overriding it with a moving tag may require another download.
The test uses the image's resource defaults (4 CPUs, 8 GiB RAM, and a 50 GB disk
for the default vanilla image). The host initializer does not install Tart automatically.

The default runs without a VM window. A host-side controller connects to Tart's
password-protected loopback VNC endpoint, recognizes text in guest screenshots,
and uses the guest's virtual mouse and keyboard. The driver uses SSH with the
image's public fixture password to open the shared script in the GUI Terminal;
it disables public-key and agent authentication for that connection. The VNC
controller approves the expected Automation and Downloads prompts and enables Terminal's
Accessibility switch using the disposable image's `admin` / `admin` account.
It does not require Accessibility or Screen Recording permission on the host.
Unexpected privacy prompts fail with a screenshot rather than being approved.
The controller targets the pinned English Tahoe image and Tart's experimental
VNC server; UI or protocol changes can require updating it.

The initializer itself opens Accessibility settings and waits for permission,
then continues without a rerun. The guest independently reads Search Privacy's
accessibility table after each pass and after reboot. That table exposes display
names, so this fresh-image test compares the exact expected row names and count;
full folder paths are submitted by the initializer's folder picker automation.
No manual visual confirmation is required. Neither script edits the TCC database
or disables SIP.

With `--attended`, the VM opens visibly. In Finder, use Go > Go to Folder to open
`/Volumes/My Shared Files/bootstrap-input/start.command` and grant the normal
privacy prompts. The guest renews DHCP if it starts without an IPv4 address.

The guest generates a disposable signing passphrase and supplies it through
OpenSSH's askpass interface for key creation and Keychain storage. It removes
the passphrase file and askpass environment before verification and repeat
application. No GitHub account or key upload is needed: the test checks signing
and verification locally. After restart, its first signed commit exercises the
signing helper's Keychain reload without askpass.

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

Logs, UI screenshots, Spotlight table results, the checkout commit/diff, and a
snapshot hash are saved in the printed temporary artifacts directory. Published mode tests the moving public
`main` entry point against this checkout's expectations; synchronize the checkout
with `main` first. Local mode snapshots current source, including uncommitted
changes, and runs `bootstrap.sh` from that snapshot. The decrypted private Rex cask
is copied into the read-only input share with owner-only permissions; artifacts
and the retained guest can contain its private installer URL. Keep these local.
The host's home directory, age passphrase and SSH agent are not shared. Test source
is mounted read-only; only the results directory is writable by the guest.
With `--ca-bundle`, only the specified PEM certificate file is copied into that
read-only input share; files containing private keys are rejected. The guest
combines it with macOS's public roots and configures curl, Git, Ruby/OpenSSL,
mise, and Node through the test process's environment, including after restart.
Homebrew receives an explicit curl configuration through `HOMEBREW_CURLRC`,
since it filters the ordinary certificate environment variables.
It does not install the CA into either machine's Keychain or disable TLS checks.

The VM is stopped and deleted after success. On failure or interruption it is
stopped and retained with its name printed. Resume it for inspection with
`tart run <name>`, and remove it with `tart delete <name>` when finished. Tart's
downloaded image cache persists across runs.

If the guest fails network preflight with no IPv4 address, check the host's DHCP
service with `launchctl print system/com.apple.bootpd`. If it is idle and the
guest receives no lease, a host administrator can start it, then retry in a
fresh clone:

```sh
sudo /bin/launchctl kickstart system/com.apple.bootpd
```

This starts the existing service without changing the host's network settings.

For a fixed OS image, pass a versioned image or OCI digest:

```sh
npm run test:vm -- --image ghcr.io/cirruslabs/macos-tahoe-vanilla@sha256:<digest>
```

Pinning the image fixes the starting OS state. Homebrew packages, downloads,
and published `main` remain live inputs, so this is repeatable integration
coverage rather than a fully hermetic build. The
[vanilla image template](https://github.com/cirruslabs/macos-image-templates/blob/main/templates/vanilla-tahoe.pkr.hcl)
sets up auto-login, passwordless sudo, remote access, and disables Gatekeeper;
the guest test re-enables Gatekeeper before installing anything. The image is a
clean tooling environment with those test conveniences, rather than Setup
Assistant on an untouched laptop.
