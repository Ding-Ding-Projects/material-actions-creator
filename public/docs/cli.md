# Command line (mac)

The `mac` command does everything the web app does.

```sh
mac login                         # assisted GitHub CLI sign-in with the extra scopes
mac whoami                        # who is signed in and which scopes are missing
mac scan owner/repo               # build scripts and workflows, with what will change
mac build owner/repo --all-scripts
mac build owner/repo --all-workflows --encrypted --out ./dist
mac preview owner/repo --script build.bat   # print the generated workflow only
mac docker -f Dockerfile --platform linux/arm64
mac runs                          # list builds
mac watch <id>                    # follow a build, resuming it if needed
mac download <id> --out ./dist    # save every output, decrypted
mac sweep                         # delete leftover temporary repositories
```

By default `mac` runs the engine in-process. Use `--server http://host:8080` (or `MAC_SERVER`) to drive a running app instead, and `--json` for machine-readable output.
