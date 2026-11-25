# Workspace, logs and recipes

## Workspace

The **Workspace** tab is a set of panels you can drag by their tabs to split, stack or float. The layout is remembered in this browser, and **Reset layout** puts it back.

| Panel | Shows |
| --- | --- |
| Runs | Every build. Pick one to drive the other panels. |
| Log | While a job runs: each step and how long it has taken. After it ends: the full job log, searchable with the regex builder, with timestamps on or off and a download link. |
| Where the time went | One bar per step on a shared time axis, with the total and the longest step. Running steps keep growing. |
| Outputs | Decrypted files to download, or why there are none. |
| Extension results | Run any extension that handles finished builds on the selected build and read its result. |

GitHub only releases a job's full log when the job ends, so the live view shows steps rather than log lines. Logs are saved before the temporary repository is deleted, up to 2 MB per build, and are removed when the build's downloads expire.

## Recipes

A recipe is a saved Workflows form: repository, branch, scripts, workflows, runner, outputs and mode.

1. Fill in the **Workflows** tab.
2. Open **Recipes**, type a name and press **Save the current Workflows form**.
3. Press **Run now** whenever you want that build again.

Each recipe can have a schedule: only when you press Run, every N hours, or every day at a time on the server's clock. Schedules run while the app is running, even with the page closed; a run that cannot start (for example when signed out) is recorded on the card and tried again at the next slot. A recipe always builds the newest commit of its branch.

From the command line:

```sh
mac recipe save nightly owner/repo --all-scripts --encrypted --daily 02:00
mac recipes
mac recipe run nightly
mac recipe rm nightly
```
