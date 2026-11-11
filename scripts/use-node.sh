# Source this file (`. scripts/use-node.sh`) to put a supported Node.js first
# on PATH. The repository needs Node 22.14 or newer; some shells default to an
# older nvm version, where vitest cannot load its TypeScript config.
qt_node_ok() {
  "${1:-node}" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 14) ? 0 : 1)' 2>/dev/null
}

if ! qt_node_ok; then
  for qt_node_dir in $(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/v2[2-9]* 2>/dev/null | sort -V -r); do
    if qt_node_ok "$qt_node_dir/bin/node"; then
      PATH="$qt_node_dir/bin:$PATH"
      export PATH
      break
    fi
  done
fi
unset qt_node_dir

if ! qt_node_ok; then
  echo "query-table needs Node.js 22.14 or newer; found $(node -v 2>/dev/null || echo none)." >&2
  return 1 2>/dev/null || exit 1
fi
