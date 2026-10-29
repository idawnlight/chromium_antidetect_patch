#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then
  printf 'Usage: %s /path/to/chromium/src\n' "$0" >&2
  exit 2
fi
patch_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
while IFS= read -r patch_name; do
  [[ -z "$patch_name" || "$patch_name" == \#* ]] && continue
  printf 'Applying %s\n' "$patch_name"
  git -C "$1" apply "$patch_repo/patches/chromium/$patch_name"
done < "$patch_repo/patches/chromium/series"
