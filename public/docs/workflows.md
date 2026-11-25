# Workflows and scripts

**Scan** lists two kinds of things in a repository:

- **Build scripts** — `.bat`, `.cmd`, `.ps1` and `.sh` files. Tick them and drag to set the order. They run one after another on the chosen runner.
- **Workflows** — files in `.github/workflows`. Each is rewritten so it can run safely in the temporary repository:
  - it starts only manually,
  - its token is read-only,
  - publishing steps (releases, package pushes, Pages deploys) are removed,
  - in encrypted mode every uploaded artifact is sealed first, and every download is opened.

Warnings shown beside a workflow explain exactly what changed. **Run all workflows** and **Run all scripts** select everything at once.

## Outputs

Output globs (for example `dist/**`, `*.exe`) choose which files come back. Leave them empty to keep everything the scripts upload.

## Pinning

Builds are pinned to the commit that was scanned, so a push during the run cannot change what is built.
