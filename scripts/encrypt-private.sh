#!/bin/bash
set -euo pipefail
umask 077

[[ $# == 2 && "$2" == *.age && -r "$1" ]] || {
  echo 'Usage: scripts/encrypt-private.sh <plaintext-file> <encrypted-file.age>' >&2
  exit 64
}
command -v age >/dev/null || { echo 'Install age with brew install age first.' >&2; exit 1; }
mkdir -p "$(dirname -- "$2")"
staged="$(mktemp "$2.XXXXXX")"
trap 'rm -f -- "$staged"' EXIT
age --encrypt --passphrase --armor --output "$staged" "$1"
mv -f -- "$staged" "$2"
printf 'Encrypted file saved: %s\n' "$2"
