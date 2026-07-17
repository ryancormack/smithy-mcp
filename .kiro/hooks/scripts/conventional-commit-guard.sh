#!/usr/bin/env bash
#
# PreToolUse hook: conventional commit guard.
#
# Fires before the agent runs a shell command (execute_bash). If the command
# is a `git commit` that carries an inline message (via -m/--message), the
# message is checked against the Conventional Commits format:
#
#   <type>[(scope)][!]: <description>
#
# where <type> is one of the conventional set (feat, fix, docs, style,
# refactor, perf, test, build, ci, chore, revert). Non-conforming messages
# BLOCK the call (exit 2) with a message telling the agent to retry with a
# valid conventional commit message. Conforming messages pass straight
# through (exit 0).
#
# Commits with no inline message (e.g. plain `git commit` which opens
# $EDITOR) are NOT blocked here, since there is nothing to inspect yet --
# the editor content can't be validated by this hook.
#
# Multiple -m flags (git's "paragraph" convention: -m <subject> -m <body>)
# are supported; only the first -m (the subject line) is validated against
# the conventional format.
#
# The command is split on shell operators (&&, ||, ;, |) into segments, and
# each segment starting with `git commit` is tokenized with `xargs`, which
# understands shell-style quoting but performs NO expansion (no command
# substitution, no variable/glob expansion). This keeps parsing safe even
# for adversarial input like `git commit -m "feat: $(rm -rf /)"` -- the
# `$(...)` is treated as a literal, inert substring, never executed.
#
# FAIL-OPEN: missing jq, unparseable/malformed input, or anything
# unexpected lets the command through (exit 0) so the hook can never wedge
# the workflow.
#
# stdin: Kiro CLI hook event JSON, e.g.
#   {"tool_name":"execute_bash","tool_input":{"command":"git commit -m \"fix: foo\""}}

input=$(cat)

# Cheap bail-out: if the raw payload never mentions "commit", there is
# nothing to do -- no jq needed.
case "$input" in *commit*) : ;; *) exit 0 ;; esac

command -v jq >/dev/null 2>&1 || exit 0

command_str=$(printf '%s' "$input" | jq -r '
  (.tool_input.command // .toolInput.command // .input.command
   // .parameters.command // .command // empty)' 2>/dev/null)

[ -n "$command_str" ] || exit 0
case "$command_str" in *commit*) : ;; *) exit 0 ;; esac

conventional_types="feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert"
# type[(scope)][!]: description  -- description must be non-empty.
pattern="^(${conventional_types})(\([a-zA-Z0-9._/ -]+\))?!?: .+"

# Split the command into segments on shell operators (&&, ||, ;, |), without
# touching anything inside quotes. We do this with a quote-aware scanner in
# awk rather than naive word-splitting, so quoted operators/spaces survive.
segments=$(printf '%s' "$command_str" | awk '
  BEGIN { seg = ""; }
  {
    line = $0
    n = length(line)
    in_squote = 0; in_dquote = 0
    for (i = 1; i <= n; i++) {
      c = substr(line, i, 1)
      c2 = substr(line, i, 2)
      if (in_squote) {
        seg = seg c
        if (c == "\x27") in_squote = 0
        continue
      }
      if (in_dquote) {
        seg = seg c
        if (c == "\"") in_dquote = 0
        continue
      }
      if (c == "\x27") { in_squote = 1; seg = seg c; continue }
      if (c == "\"") { in_dquote = 1; seg = seg c; continue }
      if (c2 == "&&" || c2 == "||") { print seg; seg = ""; i++; continue }
      if (c == ";" || c == "|" || c == "&") { print seg; seg = ""; continue }
      seg = seg c
    }
  }
  END { if (seg != "") print seg }
')

found_git_commit=0
message=""
has_message=0

while IFS= read -r segment; do
  # Trim leading/trailing whitespace.
  trimmed="${segment#"${segment%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"

  case "$trimmed" in
    git\ commit|git\ commit\ *) : ;;
    *) continue ;;
  esac

  found_git_commit=1

  # Tokenize this segment's args with xargs: quote-aware, but performs no
  # shell expansion (no $(...), no backticks, no variable/glob expansion).
  # We read tokens one-per-line into an array using process substitution.
  args=()
  while IFS= read -r tok; do
    args+=("$tok")
  done < <(printf '%s' "$trimmed" | xargs -n1 printf '%s\n' 2>/dev/null)

  # args[0]="git" args[1]="commit" ...
  idx=2
  n_args=${#args[@]}
  while [ "$idx" -lt "$n_args" ]; do
    tok="${args[$idx]}"
    case "$tok" in
      -m|--message)
        idx=$((idx + 1))
        if [ "$idx" -lt "$n_args" ] && [ "$has_message" -eq 0 ]; then
          message="${args[$idx]}"
          has_message=1
        fi
        ;;
      -m=*|--message=*)
        if [ "$has_message" -eq 0 ]; then
          message="${tok#*=}"
          has_message=1
        fi
        ;;
    esac
    idx=$((idx + 1))
  done
done <<EOF
$segments
EOF

[ "$found_git_commit" -eq 1 ] || exit 0
[ "$has_message" -eq 1 ] || exit 0

if printf '%s' "$message" | grep -qE "$pattern"; then
  exit 0
fi

{
  printf '%s\n' "Blocked by conventional-commit-guard hook: commit message doesn't follow Conventional Commits."
  printf '%s\n' "Message seen: ${message}"
  printf '\n%s\n' "Expected format:"
  printf '  %s\n' "<type>[(scope)][!]: <description>"
  printf '\n%s\n' "Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert"
  printf '\n%s\n' "Examples:"
  printf '  %s\n' "git commit -m \"feat(auth): add password reset flow\""
  printf '  %s\n' "git commit -m \"fix: correct off-by-one in pagination\""
  printf '\n%s\n' "Re-run the commit with a conventional message."
} >&2
exit 2
