#!/bin/bash
set -euo pipefail

# This script installs software and changes settings. Refuse a physical Mac.
[[ "$(/usr/sbin/sysctl -n hw.model)" == VirtualMac* ]] || { echo 'Run this only inside the disposable macOS VM.' >&2; exit 1; }
[[ "$(id -u)" != 0 ]] || { echo 'Run as the logged-in VM user, without sudo.' >&2; exit 1; }
[[ "$(/usr/bin/sw_vers -productVersion)" == 26.* ]] || { echo 'This test targets macOS Tahoe 26.' >&2; exit 1; }

input='/Volumes/My Shared Files/bootstrap-input'
results='/Volumes/My Shared Files/bootstrap-results'
workspace="$HOME/new-machine-vm-smoke"
stage=${1:-first}
[[ "$stage" == first || "$stage" == after-login ]] || exit 64
[[ -f "$input/source.tar.gz" && -d "$results" ]] || { echo 'Missing VM test shares.' >&2; exit 1; }
status() { printf '%s\n' "$1" > "$results/status.next"; mv "$results/status.next" "$results/status"; }
trap 'result=$?; if [[ "$result" != 0 ]]; then status failed; fi' EXIT
exec > >(tee "$results/guest-$stage.log") 2>&1

if [[ -f "$input/network-ca.pem" ]]; then
  # Keep the guest's public roots and add only the explicitly supplied test CA.
  bundle="$HOME/new-machine-vm-ca-bundle.pem"
  /usr/bin/security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain > "$bundle"
  cat "$input/network-ca.pem" >> "$bundle"
  export CURL_CA_BUNDLE="$bundle" SSL_CERT_FILE="$bundle" GIT_SSL_CAINFO="$bundle"
  export MISE_EXTRA_CA_CERTS="$input/network-ca.pem" NODE_EXTRA_CA_CERTS="$input/network-ca.pem"
  # Homebrew filters ordinary environment variables before invoking its tools.
  export HOMEBREW_CURLRC="$HOME/new-machine-vm.curlrc"
  printf 'cacert = "%s"\n' "$bundle" > "$HOMEBREW_CURLRC"
  echo 'Using the supplied network CA for this VM test; TLS verification remains enabled.'
fi

if [[ "$stage" == first ]]; then
  [[ ! -e "$workspace" ]] || { echo 'Use a fresh VM clone for each test.' >&2; exit 1; }
  for tool in brew mise node; do
    ! command -v "$tool" >/dev/null || { echo "Dirty image: $tool is already installed." >&2; exit 1; }
  done
  [[ ! -e /opt/homebrew && ! -e /usr/local/Homebrew && ! -e "$HOME/.local/share/mise" ]] || { echo 'Dirty image: existing bootstrap tools.' >&2; exit 1; }
  network_ready() {
    local address
    address="$(/usr/sbin/ipconfig getifaddr en0 2>/dev/null || true)"
    [[ -n "$address" && "$address" != 169.254.* ]]
  }
  if ! network_ready; then
    echo 'Waiting for the VM network to obtain a DHCP lease.'
    sudo /usr/sbin/ipconfig set en0 DHCP
    for ((attempt=0; attempt<60; attempt++)); do
      network_ready && break
      sleep 1
    done
    network_ready || { echo 'The VM did not obtain an IPv4 address.' >&2; exit 1; }
  fi
  mkdir "$workspace"
  tar -xzf "$input/source.tar.gz" -C "$workspace"
  /usr/bin/sw_vers > "$results/guest-os.txt"
  # The vanilla image disables Gatekeeper; restore the normal application policy.
  sudo /usr/sbin/spctl --global-enable
  /usr/sbin/spctl --status
  printf '\nAllow Terminal to control System Events when macOS asks.\n'
  /usr/bin/osascript -e 'tell application "System Events" to get UI elements enabled'
  printf 'Enable Terminal in System Settings > Privacy & Security > Accessibility.\n'
  printf 'Keep System Settings and the keyboard free while Spotlight automation runs.\n'
  read -r -p 'Press Return once Accessibility is enabled: '
fi

cd "$workspace"
read -r node_version < .node-version
brew=/opt/homebrew/bin/brew
mise=/opt/homebrew/opt/mise/bin/mise
verify() { "$mise" exec "node@$node_version" -- node vm/verify.ts "$1" "$results"; }
bootstrap() {
  if [[ "$(cat "$input/mode")" == published ]]; then
    # Match the documented fresh-machine command; do not preinstall its runtime.
    curl --fail --silent --show-error --location \
      'https://raw.githubusercontent.com/GregBrimble/new-machine-2026/main/bootstrap.sh' |
      /bin/bash -s --
  else
    /bin/bash bootstrap.sh
  fi
}

if [[ "$stage" == first ]]; then
  # Exercise encrypted key creation and Keychain storage with a guest-only fixture.
  (umask 077; /usr/bin/openssl rand -base64 32 > "$workspace/signing-passphrase")
  chmod 700 "$workspace/vm/signing-askpass.sh"
  export SSH_ASKPASS="$workspace/vm/signing-askpass.sh" SSH_ASKPASS_REQUIRE=force
  bootstrap 2>&1 | tee "$results/bootstrap-first.log"
  unset SSH_ASKPASS SSH_ASKPASS_REQUIRE
  rm "$workspace/signing-passphrase"
  verify first
  bootstrap 2>&1 | tee "$results/bootstrap-repeat.log"
  verify repeat
  printf '\nOpen Search Privacy and check it contains ~/Developer and /opt/homebrew.\n'
  read -r -p 'Type yes once you have visually verified both exclusions: ' confirmed
  [[ "$confirmed" == yes ]] || { echo 'Spotlight verification was not confirmed.' >&2; exit 1; }
  printf 'Both Search Privacy exclusions visually confirmed.\n' > "$results/spotlight.txt"
  cat > "$workspace/after-login.command" <<'EOF'
#!/bin/bash
exec /bin/bash "$HOME/new-machine-vm-smoke/vm/guest.command" after-login
EOF
  chmod +x "$workspace/after-login.command"
  mkdir -p "$HOME/Library/LaunchAgents"
  # Use the user's real home path without inserting it into XML.
  continuation="$HOME/Library/LaunchAgents/com.gregbrimble.new-machine-2026.vm-test.plist"
  /usr/bin/plutil -create xml1 "$continuation"
  /usr/bin/plutil -insert Label -string com.gregbrimble.new-machine-2026.vm-test "$continuation"
  /usr/bin/plutil -insert ProgramArguments -json '["/usr/bin/open","-a","Terminal"]' "$continuation"
  /usr/bin/plutil -insert ProgramArguments.3 -string "$workspace/after-login.command" "$continuation"
  /usr/bin/plutil -insert RunAtLoad -bool true "$continuation"
  # The host can stop the VM as soon as it sees the shared status file.
  /bin/sync
  status reboot-required
  echo 'Waiting for the host to restart this VM. The test continues in Terminal after login.'
else
  rm "$HOME/Library/LaunchAgents/com.gregbrimble.new-machine-2026.vm-test.plist"
  verify after-login
  status passed
  echo 'PASS: configuration, repeat application, login startup, and background Downloads access.'
fi
