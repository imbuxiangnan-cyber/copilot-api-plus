#!/bin/sh

if [ "$#" -eq 0 ]; then
  set -- start
fi

case "$1" in
  --auth)
    # Preserve the legacy auth flag and forward any auth options.
    shift
    set -- auth "$@"
    ;;
  -*)
    # Server options may be passed without an explicit start command.
    set -- start "$@"
    ;;
esac

if [ "$1" = "start" ] && [ -n "${GH_TOKEN:-}" ]; then
  # An explicit CLI token takes precedence over the environment fallback.
  has_token=false
  for arg in "$@"; do
    [ "$arg" = "--" ] && break
    # Inspect only the option name, never an attached value such as -p=value.
    option=${arg%%=*}
    case "$option" in
      --github-token|--githubToken)
        has_token=true
        break
        ;;
      --*) ;;
      -?*)
        # citty accepts short-option groups such as -vg TOKEN.
        case "${option#-}" in
          *g*) has_token=true; break ;;
        esac
        ;;
    esac
  done
  if [ "$has_token" = false ]; then
    shift
    set -- start --github-token "$GH_TOKEN" "$@"
  fi
fi

exec bun run dist/main.js "$@"
