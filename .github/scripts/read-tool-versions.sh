#!/usr/bin/env bash
set -euo pipefail

file="${1:-.tool-versions}"

if [[ ! -f "$file" ]]; then
  echo "missing tool versions file: $file" >&2
  exit 1
fi

read_tool_version() {
  local tool="$1"
  awk -v tool="$tool" '$1 == tool { print $2; exit }' "$file"
}

emit_tool_version() {
  local output_name="$1"
  local tool="$2"
  local version
  version="$(read_tool_version "$tool")"

  if [[ -z "$version" ]]; then
    echo "missing $tool entry in $file" >&2
    exit 1
  fi

  printf '%s=%s\n' "$output_name" "$version"
}

emit_tool_version node node
emit_tool_version pnpm pnpm
emit_tool_version vite_plus npm:vite-plus
