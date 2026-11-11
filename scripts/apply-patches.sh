#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then
  printf 'Usage: %s /path/to/chromium/src\n' "$0" >&2
  exit 2
fi
src_root="$1"
patch_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

apply_series() {
  local target_dir="$1"
  local series_dir="$2"
  local label="$3"
  local series_file="$series_dir/series"
  [[ -f "$series_file" ]] || return 0
  while IFS= read -r patch_name; do
    [[ -z "$patch_name" || "$patch_name" == \#* ]] && continue
    printf 'Applying [%s] %s\n' "$label" "$patch_name"
    git -C "$target_dir" apply "$series_dir/$patch_name"
  done < "$series_file"
}

apply_series "$src_root" "$patch_repo/patches/chromium" "chromium"
apply_series "$src_root/v8" "$patch_repo/patches/v8" "v8"
