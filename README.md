# New machine 2026

A single macOS bootstrap script with its configuration inline. Currently it
ensures dark appearance and disables automatic light/dark switching. It checks
the current values, writes only when needed, and verifies the result. It does not
install packages, create a background service, or modify anything else.

Edit `APPEARANCE` at the top of `bootstrap.sh` to change the desired appearance.

```sh
/bin/bash bootstrap.sh --dry-run
/bin/bash bootstrap.sh
```

Run as your normal user. macOS may ask permission for your terminal to control
System Events. An error stops the script; fix the cause and rerun. A preview
describes the desired state without querying System Events or changing settings.

## Run from GitHub

Download and run the latest script:

```sh
curl --fail --silent --show-error --location \
  'https://raw.githubusercontent.com/GregBrimble/new-machine-2026/main/bootstrap.sh' --output bootstrap.sh &&
  /bin/bash bootstrap.sh
```

Or execute directly from the response:

```sh
curl --fail --silent --show-error --location \
  'https://raw.githubusercontent.com/GregBrimble/new-machine-2026/main/bootstrap.sh' | /bin/bash -s --
```

To preview the hosted script, add `--dry-run` after `--` in the second example.
Rerun the command whenever you update the hosted configuration or want to repair
local drift. Nothing runs automatically between invocations.
