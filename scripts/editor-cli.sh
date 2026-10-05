#!/usr/bin/env bash

resolve_editor_cli() {
  local cli="$1"
  local found resolved candidate

  case "$(basename "$cli")" in
    positron) ;;
    *)
      printf '%s\n' "$cli"
      return
      ;;
  esac

  found="$(command -v "$cli" 2>/dev/null || true)"
  if [ -z "$found" ]; then
    printf '%s\n' "$cli"
    return
  fi

  resolved="$found"
  if command -v readlink >/dev/null 2>&1; then
    candidate="$(readlink -f "$found" 2>/dev/null || true)"
    [ -n "$candidate" ] && resolved="$candidate"
  fi

  # Some Linux packages put the desktop executable on PATH beside the real CLI launcher.
  candidate="$(dirname "$resolved")/bin/positron"
  if [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
  else
    printf '%s\n' "$cli"
  fi
}

filter_editor_stderr() {
  awk '
    warning {
      if ($0 ~ /^\(Use `(Code|Positron) --trace-deprecation \.\.\.` to show where the warning was created\)$/) {
        warning = ""
        next
      }
      print warning
      warning = ""
    }
    /^\[[0-9]{4}\/[0-9]{6}\.[0-9]{3}:ERROR:third_party\\crashpad\\crashpad\\util\\win\\registration_protocol_win\.cc:108\] CreateFile: The system cannot find the file specified\. \(0x2\)$/ { next }
    /^\(node:[0-9]+\) \[DEP0169\] DeprecationWarning: `url\.parse\(\)` behavior is not standardized and prone to errors that have security implications\. Use the WHATWG URL API instead\. CVEs are not issued for `url\.parse\(\)` vulnerabilities\.$/ { warning = $0; next }
    { print }
    END { if (warning) { print warning } }
  '
}

install_editor_extension() {
  local cli="$1"
  local vsix="$2"

  if "$cli" --install-extension "$vsix" --force 2> >(filter_editor_stderr >&2); then
    return 0
  fi

  printf "    installation failed in '%s'; see the editor error above.\n" "$cli" >&2
  return 1
}
