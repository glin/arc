#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: bash install-release.sh VERSION [EDITOR]" >&2
  echo "EDITOR is code, code-insiders, cursor, positron, codium, or an editor CLI path." >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
version="$1"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || usage
asset="glin.arc-${version}.vsix"
base="${ARC_RELEASE_BASE_URL:-https://github.com/glin/arc/releases/download}"
base="${base%/}/v${version}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to download Arc." >&2
  exit 1
fi

resolve_editor_cli() {
  local cli="$1"
  local found resolved candidate

  [[ "$(basename "$cli")" == positron ]] || { printf '%s\n' "$cli"; return; }
  found="$(command -v "$cli" 2>/dev/null || true)"
  [[ -n "$found" ]] || { printf '%s\n' "$cli"; return; }
  resolved="$found"
  if command -v readlink >/dev/null 2>&1; then
    candidate="$(readlink -f "$found" 2>/dev/null || true)"
    [[ -n "$candidate" ]] && resolved="$candidate"
  fi
  candidate="$(dirname "$resolved")/bin/positron"
  if [[ -x "$candidate" ]]; then printf '%s\n' "$candidate"; else printf '%s\n' "$cli"; fi
}

editors=()
if [[ $# -eq 2 ]]; then
  editors=("$2")
else
  seen=' '
  for candidate in code code-insiders cursor positron codium; do
    if command -v "$candidate" >/dev/null 2>&1; then
      editors+=("$candidate")
      seen="${seen}${candidate} "
    fi
  done
  while IFS='|' read -r key cli; do
    case "$seen" in *" $key "*) continue ;; esac
    if [[ -x "$cli" ]]; then
      editors+=("$cli")
      seen="${seen}${key} "
    fi
  done <<EOF
code|/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code
code|$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code
code-insiders|/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders
cursor|/Applications/Cursor.app/Contents/Resources/app/bin/cursor
positron|/Applications/Positron.app/Contents/Resources/app/bin/positron
positron|/Applications/Positron.app/Contents/Resources/app/bin/code
positron|$HOME/Applications/Positron.app/Contents/Resources/app/bin/code
codium|/Applications/VSCodium.app/Contents/Resources/app/bin/codium
EOF
  if [[ "${#editors[@]}" -eq 0 ]]; then
    echo "No editor CLI found. Install its shell command or pass its full path as EDITOR." >&2
    exit 1
  fi
  if [[ "${#editors[@]}" -gt 1 ]]; then
    echo "Choose one editor:" >&2
    for i in "${!editors[@]}"; do
      echo "$((i + 1))) ${editors[$i]}" >&2
    done
    if ! read -r -p 'Editor number: ' choice </dev/tty; then
      echo "Several editors found. Pass one as EDITOR, for example: bash install-release.sh $version code" >&2
      exit 1
    fi
    [[ "$choice" =~ ^[1-9][0-9]*$ ]] && (( choice <= ${#editors[@]} )) || usage
    editors=("${editors[$((choice - 1))]}")
  fi
fi
editor="${editors[0]}"
if ! command -v "$editor" >/dev/null 2>&1 && [[ ! -x "$editor" ]]; then
  echo "Editor CLI not found: $editor" >&2
  exit 1
fi
editor="$(resolve_editor_cli "$editor")"

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
curl --fail --location --silent --show-error "$base/$asset" --output "$tmp/$asset"
curl --fail --location --silent --show-error "$base/$asset.sha256" --output "$tmp/$asset.sha256"
read -r expected name extra < "$tmp/$asset.sha256" || true
if [[ ! "${expected:-}" =~ ^[0-9a-f]{64}$ || "${name:-}" != "$asset" || -n "${extra:-}" || "$(wc -l < "$tmp/$asset.sha256")" -ne 1 ]]; then
  echo "Invalid Arc checksum file." >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum < "$tmp/$asset")"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 < "$tmp/$asset")"
else
  echo "sha256sum or shasum is required to verify Arc." >&2
  exit 1
fi
actual="${actual%% *}"
if [[ "$actual" != "$expected" ]]; then
  echo "Arc download failed checksum verification." >&2
  exit 1
fi

"$editor" --install-extension "$tmp/$asset" --force
echo "Installed Arc $version in $editor. Reload the editor window to open Arc."
