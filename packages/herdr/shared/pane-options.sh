#!/usr/bin/env bash
# pane-options.sh — canonical pane-spawn option parser (shared)
#
# ONE option-parser implementation for every pane-spawn script:
# `send-to-pi.sh`, `open-pi-agent.sh` (shared/) and `run-in-pane.sh`
# (scripts/) — the shell counterpart of the TS-side unification in
# `packages/herdr/src/pane-argv.ts` (WL-0MWHWGZI4007D911). A new pane flag is
# added ONCE in the case table below (plus the caller's accepts list) and
# applies to every spawn path, so the option sets can never drift apart
# again.
#
# Usage (from a sourcing script, after `set -uo pipefail`):
#   . "$script_dir/pane-options.sh"
#   parse_pane_options <accepts> "$@"
#   set -- "${PANE_OPTIONS_REMAINDER[@]}"
#
# <accepts> is a space-separated list of the flag names the calling script
# supports, chosen from the canonical vocabulary:
#   pane-name focus no-focus cwd anchor pane-id-file   (sent to the scripts)
#   resize no-resize check-cli request-priority        (send-to-pi.sh only)
#   reservation-ticket local-preference model          (send-to-pi.sh only)
# plus the parser controls: help -- strict
#
# The parser sets these globals ONLY when the corresponding flag is consumed,
# so callers initialise their own defaults BEFORE calling it:
#   pane_name focus resize check_cli cwd_arg anchor_arg request_priority
#   reservation_ticket local_preference model_arg pane_id_file
# and these result globals:
#   PANE_OPTIONS_REMAINDER (array) — the argv left after the options; the
#       caller binds it with `set -- "${PANE_OPTIONS_REMAINDER[@]}"`.
#   PANE_OPTIONS_SHOW_HELP (0|1)  — 1 when -h/--help was seen AND the caller
#       accepts `help`; the caller then prints its own help and exits 0.
#
# Behaviour modes:
#   strict     — an option outside the caller's accepts set, or a completely
#                unknown `-*` token, is an error: prints
#                "Error: Unknown option: <token>" plus a usage line and
#                exits 1 (send-to-pi.sh / open-pi-agent.sh semantics).
#   permissive — parsing stops at the first token the caller does not accept;
#                that token starts the command (run-in-pane.sh semantics:
#                options are parsed only at the head of argv, so a command
#                whose first token begins with `--` still works).
#
# Both modes stop at a non-option token (the command start; e.g. the prompt).
#
# Value flags accept BOTH `--flag <value>` and `--flag=<value>` forms in
# EVERY script. This is a deliberate convergence (WL-0MWHWGZI4007D911):
# before the unification run-in-pane.sh only handled the space-separated form
# for `--cwd` and `--pane-name`, so `--cwd=/path` fell through into the
# command; every script now shares the exact same canonical forms. The
# `--request-priority`, `--reservation-ticket` and `--local-preference`
# values tolerate an empty (`${2:-}`) value exactly as send-to-pi.sh did, so
# their fail-open validation downstream is unchanged.

parse_pane_options() {
  local accepts="$1"
  shift

  # Reset the result globals (a script sources this file once per process,
  # but a re-call must not leak a previous call's remainder/help).
  PANE_OPTIONS_SHOW_HELP=0
  PANE_OPTIONS_REMAINDER=()

  local strict=false
  case " $accepts " in
    *" strict "*) strict=true ;;
  esac

  local consumed=false
  while [ $# -gt 0 ]; do
    consumed=false

    # ── help flag (only meaningful when accepted) ──────────────────────
    case "$1" in
      -h|--help)
        case " $accepts " in
          *" help "*)
            PANE_OPTIONS_SHOW_HELP=1
            shift
            return 0
            ;;
        esac
        ;;
    esac

    # ── `--` end-of-options marker (only when accepted) ────────────────
    if [ "$1" = "--" ]; then
      case " $accepts " in
        *" -- "*)
          shift
          # Everything after `--` is the command, verbatim — option-like
          # tokens are never re-parsed.
          PANE_OPTIONS_REMAINDER=("$@")
          return 0
          ;;
      esac
    fi

    # ── Canonical flag vocabulary ──────────────────────────────────────
    # Value flags (both `--flag <value>` and `--flag=<value>` forms): the
    # three validation-gated flags use "${2:-}" exactly as send-to-pi.sh did.
    case "$1" in
      --pane-name=*|--pane-name)
        if [[ " $accepts " == *" pane-name "* ]]; then
          consumed=true
          if [[ "$1" == *=* ]]; then pane_name="${1#*=}"; else pane_name="$2"; shift; fi
        fi
        ;;
      --cwd=*|--cwd)
        if [[ " $accepts " == *" cwd "* ]]; then
          consumed=true
          if [[ "$1" == *=* ]]; then cwd_arg="${1#*=}"; else cwd_arg="$2"; shift; fi
        fi
        ;;
      --anchor=*|--anchor)
        if [[ " $accepts " == *" anchor "* ]]; then
          consumed=true
          if [[ "$1" == *=* ]]; then anchor_arg="${1#*=}"; else anchor_arg="$2"; shift; fi
        fi
        ;;
      --pane-id-file=*|--pane-id-file)
        if [[ " $accepts " == *" pane-id-file "* ]]; then
          consumed=true
          if [[ "$1" == *=* ]]; then pane_id_file="${1#*=}"; else pane_id_file="$2"; shift; fi
        fi
        ;;
      --model=*|--model)
        if [[ " $accepts " == *" model "* ]]; then
          consumed=true
          if [[ "$1" == *=* ]]; then model_arg="${1#*=}"; else model_arg="$2"; shift; fi
        fi
        ;;
      --request-priority=*|--request-priority)
        if [[ " $accepts " == *" request-priority "* ]]; then
          consumed=true
          if [[ "$1" == *=* ]]; then request_priority="${1#*=}"; else request_priority="${2:-}"; shift; fi
        fi
        ;;
      --reservation-ticket=*|--reservation-ticket)
        if [[ " $accepts " == *" reservation-ticket "* ]]; then
          consumed=true
          if [[ "$1" == *=* ]]; then reservation_ticket="${1#*=}"; else reservation_ticket="${2:-}"; shift; fi
        fi
        ;;
      --local-preference=*|--local-preference)
        if [[ " $accepts " == *" local-preference "* ]]; then
          consumed=true
          if [[ "$1" == *=* ]]; then local_preference="${1#*=}"; else local_preference="${2:-}"; shift; fi
        fi
        ;;
      --focus)
        if [[ " $accepts " == *" focus "* ]]; then focus=true; consumed=true; fi
        ;;
      --no-focus)
        if [[ " $accepts " == *" no-focus "* ]]; then focus=false; consumed=true; fi
        ;;
      --resize)
        if [[ " $accepts " == *" resize "* ]]; then resize=true; consumed=true; fi
        ;;
      --no-resize)
        if [[ " $accepts " == *" no-resize "* ]]; then resize=false; consumed=true; fi
        ;;
      --check-cli)
        if [[ " $accepts " == *" check-cli "* ]]; then check_cli=true; consumed=true; fi
        ;;
    esac

    if [ "$consumed" = true ]; then
      shift
      continue
    fi

    # Token not consumed: either a completely unknown option or a known
    # vocabulary flag this script does not accept. -h/--help and `--` also
    # land here when not accepted.
    case "$1" in
      --*|-*)
        if [ "$strict" = true ]; then
          echo "Error: Unknown option: $1" >&2
          echo "Usage: $(basename "${BASH_SOURCE[1]:-$0}") [options] <command>" >&2
          exit 1
        fi
        ;;
    esac
    break
  done

  PANE_OPTIONS_REMAINDER=("$@")
}
