# Writing an extension

An extension is a folder with a `manifest.json` and a program in any language. The app starts the program as a separate process, writes **one line of JSON** to its standard input and reads **one line of JSON** from its standard output. That is the whole protocol.

## Try the samples first

Four runnable samples ship under `extension-samples/` and in the Extensions tab's gallery:

- `hello-shell` — eight lines of POSIX `sh`.
- `word-count-python` — Python 3, takes text you type.
- `release-notes` — drafts release notes from a finished build.
- `size-budget` — warns when an output is over a size budget.

Press **Add** in the gallery (or copy a folder into your extensions folder and press **Rescan**), then switch it on and allow it. The three built-in extensions in `extensions/` (`checksums`, `workflow-lint`, `build-summary`) are also short enough to read as examples.

## manifest.json

```json
{
  "manifestVersion": 1,
  "id": "word-count-python",
  "name": "Word count (Python)",
  "version": "0.1.0",
  "description": "Counts lines, words and characters in the text you give it.",
  "run": { "command": "python3", "args": ["main.py"] },
  "hooks": ["command"],
  "permissions": [],
  "command": { "title": "Count words", "inputLabel": "Text to count" },
  "limits": { "timeoutMs": 10000, "maxOutputBytes": 262144 }
}
```

| Field | Rules |
| --- | --- |
| `manifestVersion` | Always `1`. |
| `id` | 2-40 lowercase letters, digits or dashes. Must equal the folder name. |
| `version` | `major.minor.patch`. |
| `run.command` | A program name found on `PATH` (`node`, `python3`, `sh`) or a `./relative` path inside the folder. |
| `run.args` | Up to 32 strings. The working directory is the extension folder. |
| `hooks` | One or more of the hooks below. |
| `permissions` | Zero or more of the permissions below. |
| `limits` | Optional. Time up to 60 000 ms (default 10 000) and output up to 1 048 576 bytes (default 262 144). |

A manifest that breaks a rule is listed under **Not loaded** with the reason, and never runs.

## Hooks

| Hook | When it runs |
| --- | --- |
| `build.finished` | Once, when a build ends as ready or failed. |
| `workflow.lint` | When you press **Check with extensions** on a workflow preview. |
| `command` | When you press the extension's button in the Extensions tab. `payload.input` holds the text you typed. |

## Permissions

Permissions decide what the app puts in the request. Anything not granted is simply absent.

| Permission | Adds to the payload |
| --- | --- |
| `build:read` | `build`: title, mode, runner, status, timing, stage names and states, output count. |
| `outputs:read` | `outputs`: name, size and local path of each decrypted output file. |
| `workflow:read` | `workflow.yaml`: the generated workflow text. |
| `network` | Nothing in the payload. Lets a sandboxed extension reach the network. |

The first time you switch an extension on, and whenever a new version asks for a permission you have not allowed, the app shows exactly what is requested and keeps the extension off until you decide. Built-in extensions start on with the permissions they shipped with.

## The request

```json
{"protocol":1,"hook":"build.finished","extension":{"id":"checksums","version":"1.0.0"},"payload":{"build":{"id":"3f9a…","title":"owner/repo","status":"ready"},"outputs":[{"name":"Setup.exe","size":1234,"path":"/…/Setup.exe"}]}}
```

## The reply

```json
{"ok":true,"result":{"title":"2 outputs hashed","items":[{"label":"Setup.exe","value":"9f2c…"}]}}
```

`result` may hold any of these; everything else is dropped:

- `title` — one line, shown in the notification and the card.
- `summary` — plain text or Markdown.
- `items` — up to 200 `{ "label", "value" }` pairs.
- `findings` — up to 200 `{ "level": "error" | "warning" | "info", "message", "line" }`.

To report a failure, reply `{"ok":false,"error":"what went wrong"}`.

## What the app guarantees, and what it does not

- The process is stopped at the time limit and when its output passes the size limit. A failing extension never fails a build.
- The environment contains only `PATH`, `LANG`, `HOME`, `MAC_EXTENSION_ID`, `MAC_EXTENSION_DATA` and `MAC_PROTOCOL`. No tokens, keys or access key are passed. `HOME` and `MAC_EXTENSION_DATA` point at a folder that belongs to the extension, where it may keep files.
- The temporary repository name, its owner and every key stay out of the payload.
- Extension text is shown as text or through the app's safe Markdown renderer, never as HTML.
- Without the Linux sandbox described below, an extension is a program running as you. Only add extensions you trust.

## Adding and removing

- **Gallery** — the Extensions tab lists the bundled samples; **Add** copies one into your extensions folder, switched off.
- **Zip** — drop a `.zip` on the gallery's drop area or choose a file. The manifest may be at the top level or inside one top folder. Limits: 2 MB zipped, 5 MB and 200 files unpacked. Paths that leave the folder are refused. Uploading the same id again replaces the files and keeps your earlier answers, unless the new version asks for more.
- **Remove** deletes an added extension's files. Built-in extensions can only be switched off.

## The sandbox on Linux

When [bubblewrap](https://github.com/containers/bubblewrap) is installed and allowed to start, every extension runs inside it:

- the system is read-only;
- your home folder, the app's data folder and the GitHub CLI's sign-in folder are replaced by empty folders;
- the extension's own folder is readable, its data folder is writable, and output files are readable only with `outputs:read`;
- there is no network unless you allowed `network`.

The Extensions tab says which mode this computer is in, and each run is marked **sandboxed** when it was. `MAC_EXTENSION_ISOLATION` controls it: `auto` (default), `off`, or `require` (extensions refuse to run without a sandbox). On Windows, macOS, and inside most containers there is no sandbox and extensions run as ordinary programs.

## Test it without the app

```sh
echo '{"protocol":1,"hook":"command","payload":{"input":"one two three"}}' | python3 main.py
```
