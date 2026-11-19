# Figure US out — GUI

The desktop front end for the model-eval skill. It shows what `../scripts/evaluate.py` produces; it never calculates a metric itself.

**Status:** the start page is built. It has the image-stream hero, "Figure US out", and the four task buttons. Choosing a task shows which CSV columns it needs. The later steps (choose the CSV, set-up, check, confirm, results, report) exist only in the clickable mockup so far and are not wired to `evaluate.py` yet.

## Stack

Vite + React 19 + TypeScript, Tailwind CSS v4, shadcn (components in `src/components/ui`, the `@/` alias points at `src`).

| File | What it is |
|---|---|
| `src/components/ui/image-stream-hero.tsx` | Image-stream hero, copied as supplied |
| `src/components/ui/liquid-glass-button.tsx` | `LiquidButton` (used for the task buttons), plus `Button` and `MetalButton`, copied as supplied |
| `src/components/ui/button.tsx` | shadcn's own button (from `shadcn init`; its `cn` import was corrected to `@/lib/utils`) |
| `src/App.tsx` | The start page |
| `src/index.css` | Tailwind, shadcn theme with the Figure US out palette, local fonts |
| `public/hero/card_01.jpg` … `card_09.jpg` | Hero images: plots and ultrasound-style frames made by Figure US out from **synthetic data only** |

Why `src/components/ui`: shadcn installs every component there, and both supplied components import from `@/components/ui/...` and `@/lib/utils`. Keeping that folder means future `npx shadcn add …` components drop in without changing imports.

## Run it

Install once, while online (Node 20 or newer):

```bash
npm install
```

Then, offline:

```bash
npm run dev       # development server on http://localhost:5173
npm run build     # type-check and build to dist/
npm run preview   # serve the built app
npm run lint
```

Everything the page needs is bundled: fonts come from `@fontsource` packages and the hero images from `public/hero`, so nothing is fetched at run time.

## Notes

- **Palette:** navy `#1E3A5F` = Internal Test, ochre `#A16207` = External Test (`--internal`, `--external` in `index.css`). Headings use Source Serif 4, everything else IBM Plex Sans.
- **Liquid glass:** the distortion uses an SVG filter inside `backdrop-filter`, which only Chromium browsers support. Safari (and a WebKit-based Mac app shell) shows the button without the distortion. The task buttons add a light tint so their text stays readable either way.
- **Reduced motion:** with "Reduce motion" turned on, the corridor freezes as a still picture.
- **Lint warnings:** the four warnings from `npm run lint` are in the copied component files (`button.tsx`, `liquid-glass-button.tsx`), which are kept exactly as supplied.

## Next

Connecting the GUI to `evaluate.py` needs a way for the browser app to run a local Python process, for example a small desktop shell (Tauri or Electron) or a local-only Python server. That choice is still open.
