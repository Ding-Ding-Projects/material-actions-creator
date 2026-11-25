# Running on Linux

The app is a Node.js server with a web interface, so it runs on any Linux with Node.js 22 or newer. Docker is optional.

## One command

```sh
git clone https://github.com/Ding-Ding-Projects/material-actions-creator
cd material-actions-creator
scripts/run-linux.sh
```

The launcher checks Node.js, the GitHub CLI, the data folder and the port, installs dependencies on first start, then serves the app on `http://127.0.0.1:8080`.

| Command | What it does |
| --- | --- |
| `scripts/run-linux.sh --check` | Only run the checks. |
| `scripts/run-linux.sh --self-test` | Start on a spare port with throwaway data, exercise the API and extensions, stop. |
| `scripts/run-linux.sh --port 9000` | Use another port. |
| `scripts/run-linux.sh --install-service` | Install and start a systemd user service. |
| `scripts/run-linux.sh --uninstall-service` | Remove the service. Settings and data are kept. |
| `scripts/run-linux.sh --install-desktop` | Add an applications-menu entry that opens the app. |

## Where things live

| What | Where |
| --- | --- |
| Data, journal, downloaded outputs | `$XDG_DATA_HOME/material-actions-creator` (usually `~/.local/share/material-actions-creator`) |
| Your extensions | the `extensions` folder inside the data folder |
| Settings for the launcher and service | `$XDG_CONFIG_HOME/material-actions-creator/env` (usually `~/.config/…`), `KEY=value` lines, readable only by you |

Useful settings: `PORT`, `HOST` (default `127.0.0.1`; use `0.0.0.0` to reach it from other machines, together with `APP_ACCESS_KEY`), `GITHUB_OWNER`, `GITHUB_TOKEN`.

## Signing in

With the GitHub CLI installed, **Sign in with GitHub CLI** in the app runs the device-code sign-in with the scopes it needs. Without it, set `GITHUB_TOKEN` in the settings file.

## Checking a machine or a change

```sh
scripts/run-linux.sh --self-test     # server, API, extensions, clean stop
node scripts/browser-check.mjs       # the real page in headless Chrome or Chromium
npm test                             # unit and integration tests
```

`browser-check` needs Chrome or Chromium; set `CHROME_BIN` to choose one. Add `--shots <folder>` to save screenshots.

## Docker instead

```sh
docker build -t material-actions-creator .
docker run --rm -p 8080:8080 -v mac-data:/app/data material-actions-creator
```
