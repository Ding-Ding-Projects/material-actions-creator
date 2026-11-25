#!/usr/bin/env bash
# Run Material Actions Creator on Linux without Docker.
#
#   scripts/run-linux.sh                    check the machine, then start the app
#   scripts/run-linux.sh --check            only run the checks
#   scripts/run-linux.sh --self-test        start on a spare port with throwaway data, exercise it, stop
#   scripts/run-linux.sh --install-service  install and start a systemd user service
#   scripts/run-linux.sh --uninstall-service
#   scripts/run-linux.sh --install-desktop  add an entry to the applications menu
#   scripts/run-linux.sh --port 9000        use another port (default 8080, or $PORT)
#
# Settings can also live in ${XDG_CONFIG_HOME:-~/.config}/material-actions-creator/env
# as KEY=value lines (for example APP_ACCESS_KEY, GITHUB_OWNER, PORT).
set -euo pipefail

APP_ID="material-actions-creator"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/$APP_ID"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
ENV_FILE="$CONFIG_DIR/env"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/$APP_ID.service"

action="run"
port_arg=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) action="check" ;;
    --self-test) action="self-test" ;;
    --install-service) action="install-service" ;;
    --uninstall-service) action="uninstall-service" ;;
    --install-desktop) action="install-desktop" ;;
    --port) shift; port_arg="${1:-}" ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
PORT="${port_arg:-${PORT:-8080}}"
HOST="${HOST:-127.0.0.1}"
DATA_DIR="${DATA_DIR:-$DATA_HOME/$APP_ID}"
case "$PORT" in ''|*[!0-9]*) echo "Port must be a number." >&2; exit 2 ;; esac

failures=0
ok()   { printf '  ok    %-22s %s\n' "$1" "$2"; }
warn() { printf '  warn  %-22s %s\n' "$1" "$2"; }
bad()  { printf '  FAIL  %-22s %s\n' "$1" "$2"; failures=$((failures + 1)); }

port_free() {
  node -e 'const s=require("net").createServer();s.once("error",()=>process.exit(1));s.listen(Number(process.argv[1]),process.argv[2],()=>s.close(()=>process.exit(0)))' "$1" "$HOST"
}

checks() {
  if [ "$(uname -s)" = "Linux" ]; then ok "System" "$(uname -sr)"; else warn "System" "$(uname -s) is not Linux; this launcher is written for Linux"; fi
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [ "$major" -ge 22 ]; then ok "Node.js" "$(node -v)"; else bad "Node.js" "$(node -v) found, 22 or newer is needed"; fi
  else
    bad "Node.js" "not found. Install Node.js 22 or newer (https://nodejs.org)"
    return
  fi
  if [ -d "$ROOT/node_modules/yaml" ]; then ok "Dependencies" "installed"
  elif command -v npm >/dev/null 2>&1; then warn "Dependencies" "missing; they are installed on first start (npm ci)"
  else bad "Dependencies" "missing and npm was not found"; fi
  if command -v gh >/dev/null 2>&1; then ok "GitHub CLI" "$(gh --version | head -n 1)"
  else warn "GitHub CLI" "not found. Sign-in from the app is unavailable; GITHUB_TOKEN still works"; fi
  if mkdir -p "$DATA_DIR" 2>/dev/null && [ -w "$DATA_DIR" ]; then ok "Data folder" "$DATA_DIR"; else bad "Data folder" "cannot write to $DATA_DIR"; fi
  n="$(find "$ROOT/extensions" -mindepth 2 -maxdepth 2 -name manifest.json 2>/dev/null | wc -l | tr -d ' ')"
  langs="node"
  command -v python3 >/dev/null 2>&1 && langs="$langs, python3"
  command -v sh >/dev/null 2>&1 && langs="$langs, sh"
  ok "Extensions" "$n built in · can run: $langs"
  if [ "$1" = "port" ]; then
    if port_free "$PORT"; then ok "Port" "$PORT is free on $HOST"; else bad "Port" "$PORT is already in use on $HOST (try --port)"; fi
  fi
}

install_deps() {
  [ -d "$ROOT/node_modules/yaml" ] && return 0
  echo "  Installing dependencies…"
  (cd "$ROOT" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
}

wait_for() { # url, seconds
  for _ in $(seq 1 $(( $2 * 5 ))); do
    if node -e 'fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$1" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}

case "$action" in
  check)
    checks port
    [ "$failures" -eq 0 ] || exit 1
    ;;

  run)
    checks port
    [ "$failures" -eq 0 ] || { echo; echo "  Fix the items marked FAIL, then run this again."; exit 1; }
    install_deps
    echo
    echo "  Material Actions Creator $(node -p "require('$ROOT/package.json').version")"
    echo "  http://$HOST:$PORT"
    echo
    cd "$ROOT"
    PORT="$PORT" HOST="$HOST" DATA_DIR="$DATA_DIR" exec node src/server.js
    ;;

  self-test)
    checks noport
    [ "$failures" -eq 0 ] || exit 1
    install_deps
    tmp="$(mktemp -d)"
    test_port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
    base="http://127.0.0.1:$test_port"
    mkdir -p "$tmp/data/extensions"
    cp -r "$ROOT/extension-samples/hello-shell" "$tmp/data/extensions/"
    (cd "$ROOT" && PORT="$test_port" HOST=127.0.0.1 DATA_DIR="$tmp/data" SWEEP_ON_START=false GITHUB_TOKEN="" GH_TOKEN="" exec node src/server.js >"$tmp/server.log" 2>&1) &
    pid=$!
    cleanup() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$tmp"; }
    trap cleanup EXIT
    echo
    if wait_for "$base/api/health" 10; then ok "Starts" "answered on port $test_port"; else bad "Starts" "no answer; log follows"; cat "$tmp/server.log"; exit 1; fi
    # shellcheck disable=SC2016
    BASE="$base" node --input-type=module -e '
      const base = process.env.BASE;
      const get = async (p) => (await fetch(base + p)).json();
      const post = async (p, body) => { const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
      const line = (good, name, detail) => { console.log(`  ${good ? "ok   " : "FAIL "} ${name.padEnd(22)} ${detail}`); if (!good) process.exitCode = 1; };
      const page = await (await fetch(base + "/")).text();
      line(page.includes("tabstrip"), "Web app", "page and tab strip served");
      const prov = await get("/api/provenance");
      line(Boolean(prov.version), "Version", `${prov.version}${prov.commit ? " · " + prov.commit : ""}`);
      const cfg = await get("/api/config");
      line(cfg.runners.includes("ubuntu-latest"), "Runners", cfg.runners.join(", "));
      const docs = await get("/docs/index.json");
      line(docs.pages.length > 0, "Offline docs", `${docs.pages.length} pages`);
      const exts = await get("/api/extensions");
      line(exts.extensions.filter((e) => e.source === "builtin" && e.enabled).length >= 3, "Built-in extensions", exts.extensions.filter((e) => e.source === "builtin").map((e) => e.id).join(", "));
      const lint = await post("/api/extensions/workflow-lint/run", { hook: "workflow.lint", yaml: "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n" });
      line(lint.ok === true && lint.result.findings.length === 2, "Extension run (node)", `workflow-lint: ${lint.result?.title ?? lint.error}`);
      const blocked = await post("/api/extensions/hello-shell/run", { hook: "command" });
      line(blocked.status === 409, "Consent gate", "a new extension cannot run before it is allowed");
      await post("/api/extensions/hello-shell", { grant: [], enabled: true });
      const sh = await post("/api/extensions/hello-shell/run", { hook: "command", input: "hi" });
      line(sh.ok === true, "Extension run (sh)", sh.result?.summary ?? sh.error);
      const auth = await get("/api/auth");
      line(auth.signedIn === false, "Signed-out state", auth.ghAvailable ? "GitHub CLI found, not signed in" : "no GitHub CLI; token sign-in only");
    ' || failures=$((failures + 1))
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    if grep -q "saving the journal" "$tmp/server.log"; then ok "Clean stop" "journal saved on SIGTERM"; else bad "Clean stop" "no shutdown message"; fi
    echo
    if [ "$failures" -eq 0 ]; then echo "  Self-test passed."; else echo "  Self-test failed."; exit 1; fi
    ;;

  install-service)
    checks noport
    [ "$failures" -eq 0 ] || exit 1
    install_deps
    mkdir -p "$UNIT_DIR" "$CONFIG_DIR" "$DATA_DIR"
    [ -f "$ENV_FILE" ] || printf '# KEY=value lines read by the service, for example:\n# APP_ACCESS_KEY=choose-a-long-key\n# GITHUB_OWNER=your-org\n' > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Material Actions Creator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=PORT=$PORT
Environment=HOST=$HOST
Environment=DATA_DIR=$DATA_DIR
Environment=PATH=$PATH
EnvironmentFile=-$ENV_FILE
ExecStart=$(command -v node) $ROOT/src/server.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=default.target
UNIT_EOF
    echo "  wrote $UNIT"
    if systemctl --user daemon-reload 2>/dev/null && systemctl --user enable --now "$APP_ID.service" 2>/dev/null; then
      echo "  started. Open http://$HOST:$PORT"
      echo "  Logs: journalctl --user -u $APP_ID -f"
    else
      echo "  The unit file is in place, but this session has no systemd user manager to start it."
      echo "  On a normal desktop or server login run: systemctl --user enable --now $APP_ID.service"
      exit 3
    fi
    ;;

  uninstall-service)
    systemctl --user disable --now "$APP_ID.service" 2>/dev/null || true
    rm -f "$UNIT"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "  removed $UNIT (settings in $CONFIG_DIR and data in $DATA_DIR were kept)"
    ;;

  install-desktop)
    apps="$DATA_HOME/applications"
    mkdir -p "$apps"
    cat > "$apps/$APP_ID.desktop" <<DESKTOP_EOF
[Desktop Entry]
Type=Application
Name=Material Actions Creator
Comment=Run build scripts and workflows on temporary GitHub Actions repositories
Exec=xdg-open http://$HOST:$PORT
Icon=$ROOT/public/icon.svg
Terminal=false
Categories=Development;
DESKTOP_EOF
    echo "  wrote $apps/$APP_ID.desktop (it opens http://$HOST:$PORT; start the app or install the service first)"
    ;;
esac
