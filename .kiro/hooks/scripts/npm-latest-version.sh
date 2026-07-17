#!/usr/bin/env bash
#
# PreToolUse hook: npm latest-version guard.
#
# Fires before the agent runs a shell command (execute_bash). If the command is
# an `npm install` / `npm i` / `npm add` with one or more UNPINNED packages, it
# looks up the latest published version with `npm view <pkg> version` and, by
# default, BLOCKS the call (exit 2) with a message telling the agent to re-run
# the install with exact version pins. Already-pinned installs pass straight
# through (exit 0), so there is no block/retry loop.
#
# Modes (env var NPM_LATEST_HOOK_MODE):
#   block (default) -> stderr message + exit 2 (blocks; agent re-runs pinned)
#   warn            -> stdout message + exit 0 (install proceeds; info only)
#
# FAIL-OPEN: missing jq/npm, unparseable input, or a failed lookup all let the
# command through (exit 0) so the hook can never wedge the workflow.
#
# stdin: Kiro CLI hook event JSON, e.g.
#   {"tool_name":"execute_bash","tool_input":{"command":"npm install foo"}}

MODE="block"
[ "$NPM_LATEST_HOOK_MODE" = "warn" ] && MODE="warn"

# This hook fires on EVERY execute_bash call, because a PreToolUse matcher can
# only match on the tool name, not the command text. So bail out as cheaply as
# possible for the common case: if the raw payload never mentions npm, there is
# nothing to do -- no jq, no npm view, no network.
input=$(cat)
case "$input" in *npm*) : ;; *) exit 0 ;; esac

# jq is required to extract the command precisely; without it, do nothing.
command -v jq >/dev/null 2>&1 || exit 0

command_str=$(printf '%s' "$input" | jq -r '
  (.tool_input.command // .toolInput.command // .input.command
   // .parameters.command // .command // empty)' 2>/dev/null)

# Nothing to inspect, or the command contains no npm invocation. The precise
# `npm install` detection happens in the token parser below.
[ -n "$command_str" ] || exit 0
case "$command_str" in *npm*) : ;; *) exit 0 ;; esac

# Put spaces around shell operators so we can word-split cleanly.
spaced=$(printf '%s' "$command_str" | sed -E 's/(&&|\|\||;|\|)/ & /g')

# Word-split without glob expansion (handles spaces, tabs, newlines).
set -f
# shellcheck disable=SC2206
tokens=( $spaced )
set +f

is_operator() {
  case "$1" in
    "&&"|"||"|";"|"|"|"&") return 0 ;;
    *) return 1 ;;
  esac
}

# Skip local paths, URLs, tarballs and git/github specs.
is_installable() {
  case "$1" in
    .*|/*|~*) return 1 ;;
    *"://"*) return 1 ;;
    git:*|github:*|file:*|http:*|https:*|npm:*) return 1 ;;
    *.tgz|*.tar.gz) return 1 ;;
    *) return 0 ;;
  esac
}

findings_list=""
example=""
seen=" "
count=0

n=${#tokens[@]}
i=0
at_boundary=1
while [ "$i" -lt "$n" ]; do
  tok="${tokens[$i]}"

  if is_operator "$tok"; then
    at_boundary=1
    i=$((i + 1))
    continue
  fi

  if [ "$at_boundary" -eq 1 ] && [ "$tok" = "npm" ]; then
    j=$((i + 1))
    sub=""
    # Subcommand = first non-flag token before the next operator.
    while [ "$j" -lt "$n" ]; do
      t="${tokens[$j]}"
      is_operator "$t" && break
      case "$t" in -*) j=$((j + 1)); continue ;; esac
      sub="$t"; j=$((j + 1)); break
    done

    if [ "$sub" = "install" ] || [ "$sub" = "i" ] || [ "$sub" = "add" ]; then
      while [ "$j" -lt "$n" ]; do
        t="${tokens[$j]}"
        is_operator "$t" && break
        case "$t" in -*) j=$((j + 1)); continue ;; esac
        is_installable "$t" || { j=$((j + 1)); continue; }

        # Split token into name + version spec.
        if [ "${t:0:1}" = "@" ]; then
          rest="${t#@}"
          case "$rest" in
            *@*) name="@${rest%%@*}"; spec="${rest#*@}" ;;
            *)   name="$t"; spec="" ;;
          esac
        else
          case "$t" in
            *@*) name="${t%%@*}"; spec="${t#*@}" ;;
            *)   name="$t"; spec="" ;;
          esac
        fi

        # Bare names and floating tags/ranges need a lookup; exact do not.
        need=1
        if [ -n "$spec" ]; then
          case "$spec" in [0-9]*) need=0 ;; esac
        fi

        if [ "$need" -eq 1 ] && [ "${seen#* $name }" = "$seen" ]; then
          if printf '%s' "$name" | grep -qE '^(@[a-z0-9~-][a-z0-9._~-]*/)?[a-z0-9~-][a-z0-9._~-]*$'; then
            version=$(npm view "$name" version 2>/dev/null | tail -n1 | tr -d '[:space:]')
            if [ -n "$version" ]; then
              seen="$seen$name "
              findings_list="${findings_list}  - ${name} -> latest is ${version}
"
              example="${example} ${name}@${version}"
              count=$((count + 1))
            fi
          fi
        fi
        j=$((j + 1))
      done
    fi

    at_boundary=0
    i=$j
    continue
  fi

  at_boundary=0
  i=$((i + 1))
done

[ "$count" -eq 0 ] && exit 0

example="${example# }"

if [ "$MODE" = "warn" ]; then
  printf '%s\n' "npm-latest-version hook (warn): latest published versions:"
  printf '%s' "$findings_list"
  printf '\n%s\n  npm install %s\n' "Consider pinning exact versions, e.g.:" "$example"
  exit 0
fi

{
  printf '%s\n' "Blocked by npm-latest-version hook: pin exact versions before installing."
  printf '%s\n' "Latest published versions:"
  printf '%s' "$findings_list"
  printf '\n%s\n  npm install %s\n' "Re-run the install with these exact versions, e.g.:" "$example"
  printf '%s\n' "(Keep any flags like -D/-g. Already-pinned packages pass through automatically.)"
} >&2
exit 2
