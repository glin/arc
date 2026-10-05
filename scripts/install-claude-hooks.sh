#!/usr/bin/env bash

check_claude_marketplace() {
  local repo="$1" catalog="$2" source_type="$3" claude_cli marketplaces
  claude_cli="$(command -v claude || command -v claude.exe || true)"
  if [ -z "$claude_cli" ]; then
    echo 'error: Claude CLI was not found. Install Claude and rerun install.sh.' >&2
    return 1
  fi
  marketplaces="$("$claude_cli" plugin marketplace list --json </dev/null)" || return 1
  printf '%s' "$marketplaces" | node "$repo/scripts/check-claude-marketplace.js" "$catalog" "$source_type"
}

install_claude_hooks() {
  local repo="$1" catalog="$2" source_type="$3" claude_cli plugins plugin_state marketplace_state
  claude_cli="$(command -v claude || command -v claude.exe || true)"
  echo "==> Setting up Claude snapshot plugin"
  marketplace_state="$(check_claude_marketplace "$repo" "$catalog" "$source_type")" || return 1
  if [ "$source_type" = directory ]; then
    echo "==> Local plugin source: $catalog"
  else
    echo "==> Plugin catalog: $catalog"
  fi
  if [ "$marketplace_state" = missing ]; then
    if ! "$claude_cli" plugin marketplace add "$catalog" </dev/null; then
      if [ "$source_type" = directory ]; then
        echo "error: Claude rejected the local plugin source: $catalog. Check its marketplace and plugin files." >&2
      else
        echo "error: hosted catalog is unavailable or Claude rejected it: $catalog. Published HTTPS catalog and plugin assets are required." >&2
      fi
      return 1
    fi
  fi
  "$claude_cli" plugin marketplace update arc </dev/null || return 1
  "$claude_cli" plugin install arc-hooks@arc --scope user </dev/null || return 1
  "$claude_cli" plugin update arc-hooks@arc --scope user </dev/null || return 1
  plugins="$("$claude_cli" plugin list --json </dev/null)" || return 1
  plugin_state="$(printf '%s' "$plugins" | node "$repo/scripts/check-claude-marketplace.js" --plugin-state)" || return 1
  if [ "$plugin_state" = disabled ]; then
    "$claude_cli" plugin enable arc-hooks@arc --scope user </dev/null || return 1
    plugins="$("$claude_cli" plugin list --json </dev/null)" || return 1
  fi
  printf '%s' "$plugins" | node "$repo/scripts/check-claude-marketplace.js" --plugin-report "$catalog" "$source_type"
}
