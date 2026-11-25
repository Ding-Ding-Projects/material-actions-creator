# Running on this computer

The third run mode, **This computer**, builds without GitHub: no repository is created, no Actions minutes are used and nothing is uploaded.

## One click

1. In **Workflows**, choose **This computer** under "Where it runs".
2. Enter a repository, or press **Browse…** to pick a folder on this computer (you can also type its full path). A folder needs no sign-in.
3. Press **Scan**, tick scripts and workflows, and press **Run build**.

The run appears in **Runs** and in the **Workspace**, where the log updates while it runs.

## Picking folders and files

- **Browse…** opens a folder picker. It is the app's own dialog, not the system's, because a web page is never told the full path chosen in a system dialog; the app's server lists the folders instead. Folders that hold workflows, build scripts or a Dockerfile are tagged. Choosing a folder scans it straight away.
- On the **Dockerfile** tab, **Open files…** uses the system's file dialog to load a Dockerfile and any extra text files (512 KB each, 50 extra files).

## What runs how

| What | How it runs here |
| --- | --- |
| Build scripts | With this computer's own shell: `.sh` with bash or sh, `.ps1` with PowerShell, `.bat` and `.cmd` with cmd on Windows. |
| A repository's workflows | Through [act](https://github.com/nektos/act) (MIT), a program that runs GitHub Actions workflows locally. |
| Dockerfile | With the local Docker: `docker build`, then the image is saved as `image.tar.gz`. |

## What gets installed for you

- **The runner program.** The first workflow run downloads act at a pinned version, checks it against a pinned SHA-256 and keeps it in the app's data folder. A file that does not match is deleted. **Get it now** in the panel, or `mac local install`, does it ahead of time. An `act` already on the `PATH` is used as is.
- **Container images.** With Docker, the first Linux job pulls the runner image (`catthehacker/ubuntu:act-latest`), which takes a while once.
- **Not Docker itself.** Installing Docker needs an administrator, so the app cannot do it. Without Docker the panel says what that means on your computer.

## Which jobs can run

| Job asks for | Runs here when |
| --- | --- |
| Linux (`ubuntu-*`) | Docker answers (each job gets a clean container), or this is a Linux computer (the job then runs directly on it). |
| Windows (`windows-*`) | This is a Windows computer. |
| macOS (`macos-*`) | This is a Mac. |

No tool can run a Windows or macOS job on another system, so those jobs are not run and are listed by name, with the reason, before the run and on the run card. A workflow with nothing runnable fails straight away with the reasons. The plan is shown in the preview panel before you press Run.

## Safety

- Publishing steps (releases, Pages, package publishing, auto-commits, registry sign-in) are removed, and the list of removed steps is shown on the run.
- No sign-in values are passed: tokens, keys and the app's own settings are stripped from the environment.
- A folder is copied to a working folder first. The original is not changed, and the working folder is removed afterwards.
- Without Docker on Linux, jobs and scripts run as you, with your files in reach. Only run code you trust. With Docker, each job is in a container.
- A local run stops if the app stops; it is marked as failed on the next start and can be run again.

## Differences from GitHub

act follows GitHub Actions closely but is not identical: secrets are empty, hosted services (caches, OIDC, environments) are missing or simplified, and the container image has fewer preinstalled tools than GitHub's runners. In direct mode a job only has the tools installed on this computer.

## Command line

```sh
mac local                                   # what this computer can run
mac local install                           # get the runner program now
mac build ./my-project --local --all-scripts --outputs 'dist/**'
mac build ./my-project --local --all-workflows
mac build owner/repo --local --all-workflows   # fetches the repository, runs it here
mac docker -f Dockerfile --local
```

Settings: `MAC_LOCAL_CONTAINERS=off` never uses Docker; `MAC_ACT_PATH` points at your own act.
