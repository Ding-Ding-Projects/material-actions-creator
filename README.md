# Material Actions Creator

**Dockerfile in. Image out.** A self-hosted web app that builds a Docker image on GitHub Actions from your Dockerfile, hands the image back as a downloadable `.tar.gz`, and deletes the temporary repository it used.

📖 Docs site: https://ding-ding-projects.github.io/material-actions-creator/

## How it works

1. Creates a private `mac-tmp-<id>` repository under `GITHUB_OWNER` (or the signed-in user).
2. Commits your Dockerfile and extra files into `context/`, plus a generated `build-image.yml` workflow.
3. Starts the workflow with `workflow_dispatch`.
4. Buildx (and QEMU for non-x86 platforms) builds the image, `docker save`s it, and uploads it as an artifact.
5. The server downloads the artifact and unpacks it into a plain `image.tar.gz`.
6. Deletes the repository — on success **and** on failure. A startup sweeper removes any `mac-tmp-*` repositories older than three hours.

Load the result with `docker load -i <file>.tar.gz`.

## Run

```sh
docker build -t material-actions-creator .
docker run -d --name mac -p 8080:8080 -v mac-data:/data \
  -e GITHUB_OWNER=Ding-Ding-Projects material-actions-creator
```

Open http://localhost:8080 and click **Sign in with GitHub CLI**. The server runs `gh auth login --web` with the scopes it needs (`repo`, `workflow`, `delete_repo`, `read:org`) and shows the one-time device code in the app. If an existing sign-in is missing scopes, **Add missing scopes** runs `gh auth refresh`.

Without Docker: `npm start` (Node 22+, and `gh` on the `PATH` for the assisted sign-in).

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_OWNER` | signed-in user | Owner of the temporary repositories |
| `GITHUB_TOKEN` | — | Use this token instead of the GitHub CLI sign-in |
| `APP_ACCESS_KEY` | — | Require a key for the API and downloads |
| `PORT` | `8080` | HTTP port |
| `DATA_DIR` | `/data/builds` | Where finished images are kept |
| `GH_CONFIG_DIR` | `/data/gh` | GitHub CLI sign-in storage |
| `DOWNLOAD_TTL_MINUTES` | `60` | How long downloads stay available |
| `POLL_INTERVAL_MS` | `5000` | Workflow polling interval |
| `KEEP_REPO_ON_FAILURE` | `false` | Keep failed build repositories for debugging |
| `SWEEP_ON_START` | `true` | Delete stale `mac-tmp-*` repositories at startup |

## Tests

```sh
npm test
```

GitHub Actions in this repository:

- **`ci.yml`** — unit + integration tests on Node 22 and 24 (fake GitHub API, fake `gh` binary), actionlint on this repo's workflows and on generated build workflows, Docker image build and container smoke test.
- **`e2e.yml`** — live end-to-end: builds a real image through a throwaway repository, loads and runs it, and checks the repository is gone. Needs the `E2E_GITHUB_TOKEN` secret (classic token with `repo`, `workflow`, `delete_repo`); skipped without it.
- **`pages.yml`** — deploys the docs site in `docs/` to GitHub Pages.

## Security notes

- User files are written under `context/`, so they can't replace the workflow. Paths with `..`, absolute paths and duplicates are rejected.
- Image names, platforms and build args reach the workflow only through quoted `env:` values; `${{` is rejected so nothing is evaluated by Actions.
- The temporary workflow runs with `contents: read` and the artifact is kept for one day at most (the repository is deleted right after download anyway).
- The token is powerful (it can delete repositories). Put the app behind `APP_ACCESS_KEY` or a private network.
