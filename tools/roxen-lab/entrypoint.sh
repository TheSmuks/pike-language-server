#!/bin/sh
# Entry point for the Roxen lab image. Three modes, no arguments guessed.
set -eu

ROXEN_PREFIX="${ROXEN_PREFIX:-/usr/local/roxen6}"
ROXEN_INCLUDE="${ROXEN_PREFIX}/server/etc/include"

usage() {
  cat <<EOF
Roxen 6.1 lab.

  oracle [-I dir]... [--json] <file>...
        Compile files with Pike and report a verdict per file. Roxen's own
        include directory is always on the search path; -I adds more.

  serve [roxen args...]
        Start the Roxen server in the foreground. Proves the install is
        functional rather than merely present.

  shell [command...]
        Drop into the image. Defaults to an interactive sh.

  versions
        Print the Pike and Roxen versions this image was built from.
EOF
}

mode="${1:-}"
[ $# -gt 0 ] && shift

case "$mode" in
  oracle)
    exec pike /usr/local/bin/roxen-oracle.pike -I "$ROXEN_INCLUDE" "$@"
    ;;
  serve)
    # --once keeps Roxen in the foreground; without it the start script
    # daemonises and the container exits immediately.
    #
    # -DALLOW_UNSUPPORTED_MYSQL is Roxen's own documented override, and it names
    # it in the message it prints without the flag. Roxen 6.1 lists MariaDB 10.0,
    # 10.1 and 10.3 as known-good; the lab has 10.11, which is newer than
    # anything a 2020 release could have known about rather than known-bad
    # (Roxen's bad list is 10.2 alone). The lab is a compiler and a layout, not a
    # production data store, so the integrity caution it guards does not apply.
    exec "${ROXEN_PREFIX}/server/start" --once -DALLOW_UNSUPPORTED_MYSQL "$@"
    ;;
  shell)
    if [ $# -eq 0 ]; then exec /bin/sh; fi
    exec "$@"
    ;;
  versions)
    pike --version 2>&1 | head -1
    "${ROXEN_PREFIX}/server/start" --version
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    echo "unknown mode: $mode" >&2
    usage >&2
    exit 2
    ;;
esac
