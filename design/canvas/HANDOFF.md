# Design canvas handoff

Source of truth for the hosted design canvas "Material Actions Creator — UI". These files are a copy; the hosted canvas keeps the same boards. Nothing here is a claim that a design is implemented, verified or shipped beyond what each note says.

`support.js` is supplied by the canvas runtime and is not part of this folder, so the `.dc.html` files render only inside the canvas.

## Pages and boards

| Page | Board | Tweaks | Note beside it says |
| --- | --- | --- | --- |
| Workflows — build a repository | `WorkflowCreator.dc.html` | accent, motion | Workflows tab; try scripts, runner, run mode; YAML preview follows |
| Workflows — build a repository | `RepoWorkflows.dc.html` | accent, motion | The repository's own workflows; Run all / None; per-workflow changes |
| Runs — GitHub Actions pipeline | `Runs.dc.html` | accent, motion | Resumed encrypted run and a finished run with decrypted outputs |
| Runs — GitHub Actions pipeline | `EncryptedRun.dc.html` | accent, motion | Nine stages, temporary key countdown, what the public can see |
| Runs — GitHub Actions pipeline | `Recovery.dc.html` | accent, motion | What the app shows after it was closed mid-run |
| Dockerfile — Docker image builds | `Main.dc.html` | accent, motion | Original Dockerfile screen; platform buttons work |
| GitHub CLI login | `SignIn.dc.html` | accent, motion | Assisted device-code sign-in |
| mac CLI | `Cli.dc.html` | accent, motion | Assisted login and an encrypted build in the terminal |
| Docs site | `Docs.dc.html` | accent, motion | Docs hero and how it works |
| App shell — tabs, palette, menus | `Shell.dc.html` | accent, motion, stage | Every tab open, springing active underline, live palette, context menu |
| Setup wizard, tour and personal wording | `Onboarding.dc.html` | accent, motion, step | Five-step wizard with Back/Next/Skip, then the tour coach card |
| Setup wizard, tour and personal wording | `Vocab.dc.html` | accent, motion, stage | Personal wording before/after, window drop zone, celebration burst |
| Records — completeness and history | `Records.dc.html` | accent, motion, filter | Completeness meter and filters beside notifications and settings history |

`accent` is the shared colour lever (default `#d4ff3a`, same name and default on every board). `motion` stills every animation and transition on the board: the drifting background orbs, the entrance rise, the flowing active progress segment, the pulsing live dots, the blinking terminal cursor and the hover lifts. Reduced-motion settings also still everything.

## Motion

Every board carries the same motion system: two blurred accent/violet orbs drifting behind the content, staggered entrance for panels and cards, a flowing gradient on the active pipeline stage, pulsing live indicators, and spring hover lifts on buttons and links. The app itself follows the same language: drifting aurora with a slow conic glow, view transitions between tabs, staggered panels, a glow when a run turns ready, a light sweep across primary buttons, and an animated device code.

## Review

Process: the Stageshow skill could not be installed in this environment, so the pinned copy at upstream commit `299140fafd08df55a9c234e610c3f64af3f45531` was read (SKILL.md, references/review.md). Its rules are written for animated marketing demos; restraint, hierarchy and motion-with-a-cause were applied, the film/rehearse scripts were not run. Frames were taken from the real app with Playwright at 1440×1000 and 390×844 instead of filming the canvas boards.

Findings from those frames and their state:

- Avatar showed an empty dark circle when the profile photo failed to load — fixed (the gradient stays until the photo loads).
- Full-page captures show the sticky header mid-page — capture artifact, not a fault in the app.
- Boards are not rendered outside the canvas here, so the boards themselves were not filmed — open.

## Still to design

- Loading, empty, offline and error stages for every board (only the main stages are drawn).
- Phone-width versions of the Workflows and Runs boards.
- A board for the sub-run chips and workflow-change list as shown on a run card.

## Pass 2026-11-24 — app shell

New boards above. Motion per board: Shell — springing tab underline, palette pop-in, blinking caret; Onboarding — growing progress bars, pulsing tour ring, flowing dashed pointer; Vocab — drop zone pop-in, 24-piece burst and spring headline; Records — meter grows from the left, rows rise in sequence. All stilled by the motion Tweak and reduced motion. The app ships the same motion in `public/css/shell.css`. These boards were made after the matching code in this pass rather than before it, and were not rendered as frames before publishing.

## Pass 2026-11-25 — extensions and Linux

Boards drawn before the code this time: `Extensions.dc.html` (page "Extensions — manager and consent"; Tweaks accent, motion, stage) and `Linux.dc.html` (page "Linux — launcher and self-check"; Tweaks accent, motion, stage). Motion: extension cards rise in sequence, the switch knob springs, the consent dialog pops in and the new permission pulses; on the Linux board the check rows rise in sequence and the terminal cursor blinks. All stilled by the motion Tweak and reduced motion. The app carries the same motion in `public/css/shell.css` (extension cards, pending chips, consent ring). Differences from the boards: the app has no raw JSON-line log panel, and the launcher prints `warn`/`FAIL` rows the same way but in plain terminal text. Frames of the canvas boards were not rendered; the app itself is screenshotted by `scripts/browser-check.mjs` into `docs/screenshots/`.

## Pass 2026-11-25 (second) — workspace, gallery, recipes, tools

Boards: `Workspace.dc.html` (Tweaks accent, motion, layout), `Gallery.dc.html` (accent, motion, isolation), `Recipes.dc.html` (accent, motion, stage), `Tools.dc.html` (accent, motion, tool). The first three were drawn before the code; the Tools board records a tab that had already shipped. Motion: Workspace — timing bars grow from the left, blinking log cursor; Gallery — cards rise in sequence, the run action pops in; Recipes — cards rise in sequence; Tools — the panel pops in on each switch and the arrow's dashes flow. All stilled by the motion Tweak and reduced motion. The app carries matching motion in `public/css/shell.css` (growing and striped timing bars, rising cards, drop-area lift). Frames of the canvas boards were not rendered; the app is screenshotted by `scripts/browser-check.mjs` into `docs/screenshots/`.

## Pass 2026-11-25 (third) — run on this computer

Board `RunLocal.dc.html` (page "Run on this computer"; Tweaks accent, motion, stage), drawn before the code. Motion: capability rows rise in sequence, the download bar grows, the log cursor blinks; stilled by the motion Tweak and reduced motion. The app's capability list rises in sequence the same way (`.cap-list` in `public/css/shell.css`). Difference: the app has no live per-job rows; the plan is text in the preview panel and warnings on the run card. Frames not rendered.
