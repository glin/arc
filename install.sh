#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  echo "error: install.sh requires Bash; run: bash install.sh" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail

complete_source() {
  local root="$1" file
  for file in extension/package.json extension/package-lock.json scripts/editor-cli.sh scripts/register-hooks.js scripts/install-claude-hooks.sh scripts/check-claude-marketplace.js .claude-plugin/marketplace.json plugins/arc-hooks/.claude-plugin/plugin.json; do
    [ -f "$root/$file" ] || return 1
  done
}

current_editor_cli() {
  node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
try {
  if (process.env.TERM_PROGRAM !== 'vscode') process.exit(0);
  const native = value => process.platform === 'win32'
    ? value.replace(/^\/([a-z])\//i, (_, drive) => drive + ':/') : value;
  const file = value => {
    const resolved = fs.realpathSync(native(value));
    if (!fs.statSync(resolved).isFile()) throw new Error();
    fs.accessSync(resolved, fs.constants.R_OK);
    return resolved;
  };
  const askpass = file(process.env.VSCODE_GIT_ASKPASS_MAIN || '');
  const executable = process.env.VSCODE_GIT_ASKPASS_NODE ? file(process.env.VSCODE_GIT_ASKPASS_NODE) : '';
  const copied = path.basename(askpass) === 'askpass-main.js'
    && /^[0-9a-f]{16}$/i.test(path.basename(path.dirname(askpass)))
    && path.basename(path.resolve(askpass, '../..')) === 'askpass';
  let root;
  let apps;
  if (copied) {
    if (!executable) process.exit(0);
    root = path.dirname(executable);
    apps = [path.join(root, 'resources', 'app')];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[0-9a-f]{10}$/i.test(entry.name)) {
        apps.push(path.join(root, entry.name, 'resources', 'app'));
      }
    }
    apps = apps.filter(app => fs.existsSync(path.join(app, 'product.json')));
  } else {
    const app = path.resolve(path.dirname(askpass), '../../..');
    if (path.relative(app, askpass).replaceAll(path.sep, '/') !== 'extensions/git/dist/askpass-main.js') process.exit(0);
    if (path.basename(app) !== 'app' || path.basename(path.dirname(app)).toLowerCase() !== 'resources') process.exit(0);
    root = path.resolve(app, '../..');
    if (/^[0-9a-f]{10}$/i.test(path.basename(root)) && executable
      && path.dirname(executable) === path.dirname(root)) root = path.dirname(root);
    apps = [app];
  }
  if (!apps.length) process.exit(0);
  let name;
  for (const app of apps) {
    const metadata = file(path.join(app, 'product.json'));
    if (path.dirname(metadata) !== app) process.exit(0);
    const product = JSON.parse(fs.readFileSync(metadata, 'utf8'));
    if (!['code', 'code-insiders', 'cursor', 'positron', 'codium'].includes(product.applicationName)) process.exit(0);
    if (copied && !['user', 'system'].includes(product.target)) process.exit(0);
    if (name && name !== product.applicationName) process.exit(0);
    name = product.applicationName;
  }
  if (executable) {
    const folder = path.dirname(executable);
    const helper = path.relative(path.join(root, 'Frameworks'), executable).split(path.sep);
    const bundledHelper = path.basename(root) === 'Contents' && helper.length === 4
      && helper[0].endsWith('.app') && helper[1] === 'Contents' && helper[2] === 'MacOS';
    if (folder !== root && folder !== path.join(root, 'MacOS') && !bundledHelper) process.exit(0);
  }
  const launchers = copied ? [path.join(root, 'bin', name)]
    : [path.join(apps[0], 'bin', name), path.join(root, 'bin', name)];
  if (path.basename(root) === 'Contents') launchers.push(path.join(apps[0], 'bin', 'code'));
  if (process.platform === 'win32') launchers.push(path.join(root, 'bin', name + '.cmd'));
  for (const launcher of launchers) {
    try {
      const resolved = file(launcher);
      if (path.relative(root, resolved).startsWith('..') || path.isAbsolute(path.relative(root, resolved))) continue;
      fs.accessSync(resolved, fs.constants.X_OK);
      const cli = process.platform === 'win32'
        ? resolved.replaceAll(path.sep, '/').replace(/^([a-z]):\//i, (_, drive) => '/' + drive.toLowerCase() + '/') : resolved;
      if (/[\r\n]/.test(cli)) process.exit(0);
      process.stdout.write(cli);
      break;
    } catch {}
  }
} catch {}
NODE
}

main() {
  local invocation_cwd="$PWD"
  local setup_hooks=1 mode=auto source_repo=glin/arc source_ref=main
  local marketplace_url=''
  local argument candidate seen choice i cli claude_cli version sha ref_encoded failed=0 installed=0
  local REPO='' local_source=0 marketplace_override=0 hook_source='' hook_source_type=url
  local -a CLIS=()
  while [ "$#" -gt 0 ]; do
    argument="$1"; shift
    case "$argument" in
      --no-hooks) setup_hooks=0 ;;
      --local|--remote)
        if [ "$mode" != auto ] && [ "$mode" != "${argument#--}" ]; then
          echo 'error: --local and --remote cannot be combined.' >&2; exit 1
        fi
        mode="${argument#--}" ;;
      --repo|--ref|--marketplace-url)
        if [ "$#" -eq 0 ] || [ -z "$1" ] || [[ "$1" == --* ]]; then
          echo "error: $argument requires a value." >&2; exit 1
        fi
        case "$argument" in
          --repo) source_repo="$1" ;;
          --ref) source_ref="$1" ;;
          --marketplace-url) marketplace_url="$1"; marketplace_override=1 ;;
        esac
        shift ;;
      --help|-h)
        echo 'Usage: bash install.sh [--local|--remote] [--repo OWNER/REPO] [--ref REF] [--marketplace-url HTTPS_URL] [--no-hooks] [editor-cli ...]'
        echo 'Build Arc from local or temporary downloaded source and install its Claude plugin.'
        echo 'Auto mode uses a complete local checkout, otherwise downloads glin/arc main.'
        echo '--remote forces source download for development testing.'
        echo 'Downloaded source copies matching hooks into durable Arc storage.'
        echo '--marketplace-url explicitly selects an independently published catalog.'
        echo '--no-hooks preserves all Claude plugin and legacy hook settings.'
        exit 0 ;;
      --) CLIS+=("$@"); break ;;
      --*) echo "error: unknown option: $argument" >&2; exit 1 ;;
      *) CLIS+=("$argument") ;;
    esac
  done
  [[ "$source_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo 'error: --repo requires OWNER/REPO.' >&2; exit 1; }
  for candidate in node npm mktemp; do
    command -v "$candidate" >/dev/null 2>&1 || { echo "error: $candidate is required. Install it and rerun install.sh." >&2; exit 1; }
  done
  if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a===22&&b>=12)||a>22?0:1)'; then
    echo "error: installation needs Node.js 22.12+ (found $(node --version))." >&2
    exit 1
  fi
  if [ "$marketplace_override" -eq 1 ]; then
    node -e 'try { const u=new URL(process.argv[1]); if(u.protocol!=="https:"||u.username||u.password) process.exit(1); } catch { process.exit(1); }' "$marketplace_url" || {
      echo 'error: --marketplace-url requires an HTTPS catalog URL without credentials.' >&2; exit 1
    }
  fi
  if [ "$setup_hooks" -eq 1 ]; then
    command -v claude >/dev/null 2>&1 || command -v claude.exe >/dev/null 2>&1 || {
      echo 'error: Claude CLI was not found. Install Claude Code or pass --no-hooks for extension-only installation.' >&2; exit 1
    }
    claude_cli="$(command -v claude || command -v claude.exe)"
  fi
  if [ "${#CLIS[@]}" -eq 0 ]; then
    candidate="$(current_editor_cli)"
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      CLIS=("$candidate")
      echo "==> Current editor: $candidate"
    fi
  fi
  if [ "${#CLIS[@]}" -eq 0 ]; then
    seen=' '
    for candidate in code code-insiders cursor positron codium; do
      if command -v "$candidate" >/dev/null 2>&1; then CLIS+=("$candidate"); seen="$seen$candidate "; fi
    done
    while IFS='|' read -r candidate cli; do
      case "$seen" in *" $candidate "*) continue ;; esac
      if [ -x "$cli" ]; then CLIS+=("$cli"); seen="$seen$candidate "; fi
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
    if [ "${#CLIS[@]}" -gt 1 ]; then
      echo 'Choose editors:' >&2
      printf -v candidate '%s, ' "${CLIS[@]}"
      echo "1) All detected editors (${candidate%, })" >&2
      for i in "${!CLIS[@]}"; do echo "$((i + 2))) ${CLIS[$i]}" >&2; done
      printf 'Editor number [1]: ' >&2
      if ! { read -r choice </dev/tty; } 2>/dev/null; then
        choice=1
        echo '1 (all detected editors)' >&2
      fi
      choice="${choice:-1}"
      if [[ ! "$choice" =~ ^[1-9][0-9]*$ ]] || [ "${#choice}" -gt 6 ] || (( choice > ${#CLIS[@]} + 1 )); then
        echo 'error: select a listed editor number.' >&2; exit 1
      fi
      if [ "$choice" -gt 1 ]; then CLIS=("${CLIS[$((choice - 2))]}"); fi
    fi
  fi
  [ "${#CLIS[@]}" -gt 0 ] || { echo 'error: no editor CLI found. Install its shell command or pass its full path.' >&2; exit 1; }
  for cli in "${CLIS[@]}"; do
    command -v "$cli" >/dev/null 2>&1 || { echo "error: editor CLI not found: $cli" >&2; exit 1; }
  done
  if [ "$mode" != remote ]; then
    if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
      candidate="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
      if complete_source "$candidate"; then REPO="$candidate"; fi
    fi
    if [ -z "$REPO" ] && complete_source "$PWD"; then
      REPO="$PWD"
    fi
  fi
  if [ -n "$REPO" ]; then local_source=1
  elif [ "$mode" = local ]; then
    echo 'error: --local requires a complete Arc source directory.' >&2; exit 1
  else
    for candidate in curl tar; do
      command -v "$candidate" >/dev/null 2>&1 || { echo "error: $candidate is required for source download." >&2; exit 1; }
    done
  fi
  hook_source="$marketplace_url"
  if [ "$marketplace_override" -eq 0 ]; then
    if [ "$local_source" -eq 1 ]; then
      hook_source="$REPO"
      hook_source_type=directory
    else
      hook_source_type=bundled
    fi
  fi
  if [ "$setup_hooks" -eq 1 ] && [ "$hook_source_type" = url ]; then
    version="$("$claude_cli" --version)"
    node -e 'const m=process.argv[1].match(/\b(\d+)\.(\d+)\.(\d+)\b/); if(!m) process.exit(1); const [a,b,c]=m.slice(1).map(Number); process.exit(a>2||(a===2&&(b>1||(b===1&&c>=224)))?0:1)' "$version" || {
      echo "error: HTTPS archive plugins require Claude Code 2.1.224 or later (found $version)." >&2; exit 1
    }
  fi
  # Only this allocation belongs to the installer, including a local build's temporary VSIX.
  ARC_INSTALL_TEMP="$(mktemp -d)"
  trap 'rm -rf -- "$ARC_INSTALL_TEMP"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ "$local_source" -eq 0 ]; then
    ref_encoded="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$source_ref")"
    if ! curl --fail --location --silent --show-error --connect-timeout 15 --max-time 900 "https://api.github.com/repos/$source_repo/commits/$ref_encoded" --output "$ARC_INSTALL_TEMP/commit.json"; then
      echo 'error: source revision download failed or timed out. Check --repo, --ref, and source availability.' >&2; exit 1
    fi
    sha="$(node -e 'const s=require(process.argv[1]).sha; if(typeof s!=="string"||!/^[0-9a-f]{40}$/.test(s)) process.exit(1); process.stdout.write(s)' "$ARC_INSTALL_TEMP/commit.json")" || {
      echo 'error: GitHub did not return a valid source revision.' >&2; exit 1
    }
    echo "==> Source revision: $source_repo@$sha"
    if ! curl --fail --location --silent --show-error --connect-timeout 15 --max-time 900 "https://codeload.github.com/$source_repo/tar.gz/$sha" --output "$ARC_INSTALL_TEMP/source.tar.gz"; then
      echo 'error: source archive download failed or timed out. Check source availability and rerun.' >&2; exit 1
    fi
    mkdir "$ARC_INSTALL_TEMP/source"
    if ! tar -xzf "$ARC_INSTALL_TEMP/source.tar.gz" -C "$ARC_INSTALL_TEMP/source" --strip-components=1; then
      echo 'error: source archive extraction failed.' >&2; exit 1
    fi
    REPO="$ARC_INSTALL_TEMP/source"
    complete_source "$REPO" || { echo 'error: downloaded archive lacks required Arc source files.' >&2; exit 1; }
  else
    echo "==> Local source: $REPO"
  fi
  source "$REPO/scripts/editor-cli.sh"
  for i in "${!CLIS[@]}"; do
    CLIS[$i]="$(resolve_editor_cli "${CLIS[$i]}")"
    command -v "${CLIS[$i]}" >/dev/null 2>&1 || { echo "error: editor CLI not found: ${CLIS[$i]}" >&2; exit 1; }
  done
  if [ "$setup_hooks" -eq 1 ] && [ "$hook_source_type" != bundled ]; then
    source "$REPO/scripts/install-claude-hooks.sh"
    check_claude_marketplace "$REPO" "$hook_source" "$hook_source_type" >/dev/null || exit 1
  fi
  echo '==> Building extension'
  cd "$REPO/extension"
  if [ "$local_source" -eq 1 ]; then
    npm install
  else
    npm ci
  fi
  chmod +x node_modules/.bin/* 2>/dev/null || true
  npm run build
  local VSIX="$ARC_INSTALL_TEMP/arc.vsix"
  if ! node scripts/package.mjs --no-dependencies --allow-missing-repository -o "$VSIX"; then
    echo 'error: packaging failed. No editor installation was attempted.' >&2; exit 1
  fi
  version="$(node -p 'require("./package.json").version')"
  echo "==> Built extension version: $version"
  for cli in "${CLIS[@]}"; do
    echo "==> Installing extension into: $cli"
    if install_editor_extension "$cli" "$VSIX"; then
      installed=$((installed + 1))
    else
      echo "error: Arc extension installation failed in $cli." >&2
      failed=1
    fi
  done
  if [ "$installed" -eq 0 ]; then echo 'error: no editor installed Arc. Hooks were not changed.' >&2; exit 1; fi
  if [ "$setup_hooks" -eq 1 ]; then
    if ! {
      if [ "$hook_source_type" = bundled ]; then
        (cd "$invocation_cwd" && node "$REPO/extension/dist/setup.cjs" --snapshots)
      else
        install_claude_hooks "$REPO" "$hook_source" "$hook_source_type"
      fi
    }; then
      echo 'error: Arc extension is installed, but Claude snapshot plugin setup failed. Resolve the error and rerun install.sh.' >&2
      failed=1
    elif [ "$local_source" -eq 1 ]; then
      if ! node "$REPO/scripts/register-hooks.js"; then
        echo 'error: Arc is installed, but legacy hook settings need manual review. The affected file remains unchanged.' >&2
        failed=1
      fi
    fi
  fi
  [ "$failed" -eq 0 ] || exit 1
  echo '==> Installed Arc. Reload the editor window and restart Claude Code to load the installed files.'
}

# Bash reads the whole function before invoking it. Children never inherit the piped script stream.
main "$@" </dev/null
