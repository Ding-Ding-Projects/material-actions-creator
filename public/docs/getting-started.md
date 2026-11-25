# Getting started

Material Actions Creator turns a repository's build scripts, its own GitHub Actions workflows, or a Dockerfile into a short-lived GitHub Actions run. It hands back the outputs as downloads and deletes the temporary repository afterwards.

## First run

1. The setup wizard asks for your language, checks the GitHub connection and lets you choose a default run mode. Every step can be revisited from **Settings → Run setup again**.
2. Sign in with **Sign in with GitHub CLI**. The app asks for the `repo`, `workflow`, `delete_repo` and `read:org` scopes so it can create, run and delete temporary repositories.
3. Open **Workflows**, enter `owner/repo`, press **Scan**, tick what to run and press **Build**.
4. Watch the run in **Runs**. Outputs appear there as soon as the run finishes.

## Where things are

| Tab | What it does |
| --- | --- |
| Workflows | Pick a repository, scripts and workflows, runner and outputs |
| Dockerfile | Build a Docker image from Dockerfile instructions |
| Runs | Live progress, downloads, bulk export and dismiss |
| Tools | Base64, file converter and JSON studio, all local |
| Docs | This documentation, bundled with the app |
| Changelog | What changed in each version |
| History | Notifications and every settings change, with restore |
| Completeness | Every planned feature and its honest state |
| Settings | Language, look, sound, modes, identity and data |

Press **Ctrl+Shift+F** anywhere to search every page, command and setting.
