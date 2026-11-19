---
name: model-eval
description: Evaluate saved model predictions locally and offline on a Mac (CPU, 16 GB RAM) for binary classification (Standard or FGR), regression, object detection (CVAT XML) and segmentation (binary masks). Use when the user has a predictions CSV and wants metrics, confidence intervals, calibration, decision curves, Bland–Altman, detection precision/recall, Dice/IoU, or overlay videos. The agent guides task selection, input validation, cohort confirmation and interpretation; a Python script does every calculation.
---

# Model prediction evaluation

You guide the conversation. `scripts/evaluate.py` does every calculation. Never compute, estimate, round or "sanity-correct" a metric yourself, and never fill in a choice the user has not made: the script stops with `NEEDS INPUT` when a choice is missing, and you then ask the user.

## Rules that hold for every task

1. **Ask, do not assume.** Test set (internal or external), task, classification mode, positive label, units, threshold range, participant link, repeated-measures analysis and the both-empty mask rule are the user's choices. Do not infer the test set from the file name.
2. **Never drop records silently.** If validation finds problems, show them and stop. Use `--exclude-invalid` only after the user agrees to exclude exactly the listed rows.
3. **No participant identifiers in the chat.** The script identifies rows by CSV line number. Do the same. Do not open the CSV to quote `record_id` values.
4. **Offline.** After installation nothing needs the network. Do not fetch anything during a run.
5. **Report `NA` as `NA`.** Give the reason from the `note` column. Do not substitute a value.
6. **Do not pass `--confirm yes` on real data.** It skips the pop-up and exists for the synthetic self-test.
7. **The GUI options are for the FigureUS(out) server only.** `--validate-only`, `--confirm gui`, `--confirmed-cohort` and `--status-file` let the local app (`server/app.py`) show the cohort with Proceed / Retry in its own window. Do not use them in the chat workflow, where the pop-up is the confirmation.

## Workflow

### Step 0 — Environment (first use only)
Follow `README_macOS.md`. Then run `python scripts/verify_synthetic.py` and confirm that every check passes before touching real data.

### Step 1 — Task
Ask the user to select: **classification, regression, object detection or segmentation**. For classification, next ask **Standard** or **FGR**. Then read the matching guide before going further:

| Task | Guide | Required CSV columns |
|---|---|---|
| Classification | `guides/classification.md` | `record_id`, `true_label`, `pred_label`, `pred_prob` |
| Regression | `guides/regression.md` | `record_id`, `true`, `pred` |
| Object detection | `guides/object_detection.md` | `record_id`, `true_xml`, `pred_xml` (`video_path` optional) |
| Segmentation | `guides/segmentation.md` | `record_id`, `true_mask`, `pred_mask` (`image` optional, for overlays) |

### Step 2 — CSV
Ask for the CSV path (or omit `--csv` and the script opens a macOS file chooser). Inspect it first:

```bash
python scripts/evaluate.py --task <task> [--mode standard|fgr] --csv <path> --inspect   # --test-set not needed here
```

This checks the columns and prints column names, row counts and label counts, with no identifiers. For each missing required column the script prints, and you relay verbatim:

```text
ERROR 404! This particular column (pred_prob) is missing.
```

Stop there (exit code 4) until the user supplies a corrected CSV. Identifiers are read as text, so `001` stays `001`. Relative file paths are resolved from the CSV's folder.

When the data are in the CSV under other names (for example `fpath` for `record_id`, `TRUE` for `true`), do not edit or copy the file: ask the user which column holds each name, then pass one `--column NAME=CSV_COLUMN` per name, for example `--column record_id=fpath --column true=TRUE --column pred=PRED`. The CSV is not changed, its checksum in the run record stays the original file's, and the mapping is saved as `column_mapping`. A mapped column that does not exist gives the `ERROR 404!` line; a CSV that has both the expected name and the mapped column stops with `NEEDS INPUT` (ask which one to use). `--participant-col` takes the CSV's own column name.

### Step 3 — Task questions
First, for every task, ask: **Is this CSV the internal test set or the external test set?** → `--test-set internal` or `--test-set external`. The script stops with `NEEDS INPUT` (exit 2) until this is given. The answer goes into every output file name (`metrics_internal_<run>.csv`, `bland_altman_external_<run>.png`, …) and starts every plot title (`Internal Test: Bland-Altman Plot`, `External Test: Confusion Matrix (participants)`, …).

If the user gives a title for these results (for example `GAUGE: After Pooling`), pass `--title "<title>"`. It heads the summary report as `# Internal Test: GAUGE: After Pooling`, with the task line below it, and is saved as `title` in the run record. It is optional: never invent one. At most 80 characters (a longer one stops with `NEEDS INPUT`), and it must not contain participant identifiers.

Then ask the questions listed in the task guide and turn each answer into its option. For detection and segmentation, ask whether rows identify people or files, and which column links rows to participants.

### Step 4 — Validation
Run the evaluation command from the guide. The script reports invalid values, duplicate `record_id`s and unreadable files by CSV line, saves them to `sheets/validation_issues_<test set>_<run>.csv`, and stops with exit code 5. Summarise the problem types and counts for the user and ask how to proceed (fix the CSV, or exclude exactly those rows).

### Step 5 — Cohort confirmation
Before any metric is calculated the script prints `**Total participants: N**` and, when it differs, the number of visits, videos or mask pairs. Show that line in bold in the chat. The script then opens a local pop-up with the same counts and **Proceed** / **Retry** buttons.

- **Proceed** starts the evaluation.
- **Retry** ends the run with exit code 3: go back to Step 2 and ask for the CSV again. (When the CSV came from the file chooser, the chooser reopens by itself.)

### Step 6 — Interpretation
Read `reports/summary_<test set>_<run>.md` and `sheets/metrics_<test set>_<run>.csv`. Name the test set (Internal Test / External Test) first. Present each estimate to 2 decimal places with its 95% CI written as `[lower - upper]` (for example `3.71 days, 95% CI [3.15 - 4.27]`), copied from the `estimate_reported` and `ci_95_reported` columns. The script does the rounding (halves round up; counts stay whole numbers), so never round a number yourself. Also give the number of bootstrap replicates that contributed. State the scoring unit (participant, visit, box, mask pair), the label mapping and units. For regression in weeks, every estimate and CI is in **days** (the script converts before calculating); the figures stay in weeks. Pass on every `NOTICE` line. Follow the interpretation notes in the task guide, and keep description separate from judgement: say what the numbers are before saying what they might mean.

## Exit codes

| Code | Meaning | What you do |
|---|---|---|
| 0 | Finished | Interpret the results |
| 2 | `NEEDS INPUT` | Ask the user the question printed, re-run with the answer |
| 3 | `RETRY` | Return to CSV selection |
| 4 | Missing column | Relay the `ERROR 404!` lines, ask for a corrected CSV |
| 5 | Invalid data | Show the problems, ask how to proceed |
| 1 | Other error | Show the message; do not work around it |

## Outputs (under `--out-dir`, default `eval_output/`)

| Folder | Contents |
|---|---|
| `sheets/` | `metrics_*.csv` (full-precision `estimate`, `ci_lower`, `ci_upper`, plus the reported strings `estimate_reported` and `ci_95_reported`) and task tables (confusion matrix, curves, per-video counts, per-pair scores, validation issues) |
| `figures/` | PNG plots; with `--export-figures`, also `figures/export/` with every plot as TIFF and JPEG at 600 dpi (RGB) and as SVG, for journals |
| `videos/` | Detection overlay videos (`.mp4`) |
| `logs/` | `run_*.log` and `run_metadata_*.json`: test set, participant and observation counts, label mapping, thresholds, units (and any weeks-to-days conversion), seed, selected examples, figure titles, CSV hash, package versions |
| `reports/` | `summary_*.md` |

Every file name is `<name>_<internal|external>_<run timestamp>.<ext>`, so the test set is visible in the name and earlier runs are never overwritten. Every plot title starts with `Internal Test:` or `External Test:`; detection overlay videos carry the same label on each frame. The run record lists each figure's title under `figure_titles`.

## FigureUS(out), the local app

`server/app.py` serves the FigureUS(out) GUI at `http://127.0.0.1:8765` on this computer only (start it with `./start_figureus.command` or `python server/app.py`). The person chooses the task, then the internal test set CSV, the external test set CSV, or both (an upload, a folder for masks and XML files, or a path used in place), matches the columns, and answers the same questions as above once for both. Each CSV is its own evaluate.py run with its own `--test-set`. The server only runs `scripts/evaluate.py`: a check with `--validate-only`, then, after **Proceed** in the app, the evaluation with `--confirm gui --confirmed-cohort <id> --export-figures` (the id ties the confirmation to that file and those counts). The app shows the two test sets' results side by side; a plot opens large when clicked and can be saved as the TIFF, JPEG (600 dpi) or SVG copy evaluate.py made. Every value the app shows is read from the files evaluate.py saved. Uploads and results go to `eval_output/gui_jobs/`, which is never committed. `python scripts/verify_server.py` checks the server on synthetic data.

## Reproducibility

- Seed 42 (change with `--seed`) drives the bootstrap and the sampling of example videos and masks. Same CSV, same options, same seed gives identical numbers.
- Confidence intervals are 95% percentile intervals from 1,000 bootstrap replicates that resample **participants** with replacement and carry all of a participant's rows together.
- A replicate in which a metric is undefined does not contribute to that metric's interval; `n_boot_contributed` reports how many did.
- Undefined metrics are written as `NA` with the reason in `note`.
