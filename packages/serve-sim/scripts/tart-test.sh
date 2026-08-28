#!/usr/bin/env bash
# Compatibility wrapper. Prefer: bun run tart <setup|up|test|dev>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CLI="$HERE/tart/cli.ts"
cmd="${1:-test}"
case "$cmd" in
  setup | up | boot | stage | test | dev | ssh | help | -h | --help)
    exec bun "$CLI" "$@"
    ;;
  *)
    exec bun "$CLI" test "$@"
    ;;
esac
