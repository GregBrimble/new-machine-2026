#!/bin/sh
set -eu
exec /bin/cat "${0%/*}/../signing-passphrase"
