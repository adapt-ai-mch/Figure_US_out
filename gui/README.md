# FigureUS(out) — GUI

The desktop front end for the model-eval skill. It shows what `../scripts/evaluate.py` produces; it never calculates a metric itself.

**What it does:** the start page (image-stream hero, "FigureUS(out)", one liquid-glass button per task) opens each task's CSV page directly. There: add the internal test set CSV, the external test set CSV, or both (upload a file or a folder, or use a CSV in place by its path), match the columns, answer the set-up questions once for both, check the CSVs, confirm the cohorts with Proceed / Retry, and read the results with the two test sets side by side (metrics as evaluate.py reported them, a plot menu, notices, downloads, an editable title). A click on a plot opens it large over the blurred page; under each plot, TIFF and JPEG (600 dpi) and SVG save the copies evaluate.py made, where the person chooses. Recent runs reopens earlier results. The theme is Device (follows the computer), Light or Dark.

It runs on the user's own computer only: `../server/app.py` serves this app and runs `evaluate.py` at http://127.0.0.1:8765.

## Stack

Vite + React 19 + TypeScript, Tailwind CSS v4, shadcn (components in `src/components/ui`, the `@/` alias points at `src`).

| File | What it is |
|---|---|
| `src/components/ui/image-stream-hero.tsx` | Image-stream hero, copied as supplied |
| `src/components/ui/liquid-glass-button.tsx` | `LiquidButton` (used for the task buttons), plus `Button` and `MetalButton`, copied as supplied |
| `src/components/ui/dorpdown-navigation.tsx` | `DropdownNavigation`, adapted from the supplied file (its header comment lists every change). Not used at the moment: the task buttons now open the CSV page directly |
| `src/components/ui/button.tsx` | shadcn's own button (from `shadcn init`; its `cn` import was corrected to `@/lib/utils`) |
| `src/App.tsx` | Picks the screen from the address: `#/`, `#/task/<task>`, `#/results/<run>`, `#/runs` |
| `src/views/StartPage.tsx` | The start page |
| `src/views/Workspace.tsx` | One task's three steps for the internal and external CSV; `DataStep`, `SetupStep`, `CheckStep` and `workspace-model.ts` hold each part |
| `src/views/ResultsView.tsx` | Results of one or two runs (internal and external side by side), and the title editor |
| `src/views/RecentRuns.tsx` | Finished evaluations on this computer |
| `src/components/form.tsx`, `app-chrome.tsx` | Form controls, notes, progress; the header, page frame and theme switch |
| `src/components/plot-lightbox.tsx` | The enlarged plot (a modal `<dialog>` with the page blurred behind it) |
| `src/lib/api.ts` | Client for the local server (`/api/...`) |
| `src/lib/tasks.ts` | The four tasks, their columns, display names for metrics |
| `src/lib/router.ts` | A small hash router |
| `src/lib/save.ts` | Saves a run's file through the browser's Save dialog (Chromium), or as a normal download |
| `src/lib/theme.ts` | Device / Light / Dark theme, kept in this browser's localStorage; `index.html` applies it before the first paint |
| `src/index.css` | Tailwind, shadcn theme with the FigureUS(out) palette, local fonts |
| `public/hero/card_01.jpg` … `card_09.jpg` | Hero images: plots made by FigureUS(out) from **synthetic data**, and three example ultrasound frames (`card_02` segmentation overlay, `card_05` detection boxes, `card_08` fetal head) re-saved without file metadata and with scanner text trimmed |

Why `src/components/ui`: shadcn installs every component there, and the supplied components import from `@/components/ui/...` and `@/lib/utils`. Keeping that folder means future `npx shadcn add …` components drop in without changing imports.

## Run it

People who only use the app need Python alone: `../start_figureus.command` (or `python server/app.py` from the skill folder) serves the built app in `dist/`, which is committed for that reason.

To change the app, install once, while online (Node 20 or newer):

```bash
npm install
```

Then, offline, with the server running in another window (`python server/app.py --no-browser` from the skill folder):

```bash
npm run dev       # http://localhost:5173, sends /api to the server on 127.0.0.1:8765
npm run build     # type-check and rebuild dist/ — commit dist/ with your change
npm run lint
```

Everything the page needs is bundled: fonts come from `@fontsource` packages and the hero images from `public/hero`, so nothing is fetched at run time.

## Notes

- **Palette:** navy `#1E3A5F` = Internal Test, ochre `#A16207` = External Test (`--internal`, `--external` in `index.css`). Headings use Source Serif 4, everything else IBM Plex Sans.
- **Liquid glass:** the distortion uses an SVG filter inside `backdrop-filter`, which only Chromium browsers support. Safari (and a WebKit-based Mac app shell) shows the button without the distortion. The task buttons add a light tint so their text stays readable either way.
- **Reduced motion:** with "Reduce motion" turned on, the corridor freezes as a still picture.
- **Task buttons:** each opens its task's CSV page; there is no menu on hover or click.
- **Two test sets:** each CSV is its own evaluate.py run (`--test-set internal` or `external`). Runs evaluated together share a group id, so Recent runs and the results page (`#/results/<internal run>,<external run>`) keep them together.
- **Themes:** the `.dark` block in `index.css` redefines every colour token (Internal stays blue and External ochre, lightened). Plots stay on white, as evaluate.py draws them.
- **Saving plots:** the TIFF, JPEG and SVG files are made by `evaluate.py --export-figures` when the run is evaluated; the app only fetches them. `showSaveFilePicker` (Chrome, Edge, Brave, Arc) gives a Save dialog with folder and name; other browsers get a normal download.
- **Lint warnings:** the four warnings from `npm run lint` are in the copied component files (`button.tsx`, `liquid-glass-button.tsx`), which are kept exactly as supplied.

## How it talks to evaluate.py

The app never calculates a metric. `src/lib/api.ts` calls the local server, which runs `../scripts/evaluate.py` and reads back what it saved:

1. **Check:** `evaluate.py --validate-only --confirm gui` validates the CSV and saves the cohort counts with a cohort id. Problems come back by CSV line; a `NEEDS INPUT` message comes back with the field it is about, and the app asks that question beside the field.
2. **Proceed:** `evaluate.py --confirm gui --confirmed-cohort <id> --export-figures` runs the evaluation only if the file and the counts are still the ones confirmed, and saves each plot also as 600-dpi TIFF and JPEG and as SVG.
3. **Results:** the metrics sheet's `estimate_reported` and `ci_95_reported` text, the figures with their titles from the run record (and their TIFF, JPEG and SVG copies), notices, the report and every saved file.

Every API call that changes something carries the header `x-figureus: 1`; the server refuses others, and answers only requests addressed to 127.0.0.1 or localhost.
