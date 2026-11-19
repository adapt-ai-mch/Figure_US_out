# Running the evaluator on macOS

Works on Apple-silicon and Intel MacBooks with 16 GB RAM. CPU only. The internet is needed once, for step 2.

## 1. Check Python

Open **Terminal** and run:

```bash
python3 --version
```

You need 3.10 or newer. If it is older or missing, install Python from python.org (or `brew install python`).

## 2. Install (once, online)

```bash
cd /path/to/model-eval
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

To prepare a Mac that will never be online, download the wheels on another Mac of the same type and Python version, copy the folder across, and install from it:

```bash
python -m pip download -r requirements.txt -d wheels            # on the online Mac
python -m pip install --no-index --find-links wheels -r requirements.txt   # on the offline Mac
```

## 3. Verify (offline)

```bash
source .venv/bin/activate
python scripts/verify_synthetic.py
```

This builds a small synthetic dataset in a temporary folder, runs all four tasks and checks about 100 known answers, including the internal/external labels on file names and plot titles, the weeks-to-days conversion, the 2-decimal `[lower - upper]` reporting format, ROC and precision-recall curves whose areas match AUROC and AUPRC, and segmentation overlays on the original image. The last line should read `N of N checks passed` with the two numbers equal (one cross-check is skipped unless scikit-learn happens to be installed; it is not required). To keep a copy of the synthetic data to look at: `python scripts/make_synthetic_data.py --out synthetic_data`.

## 4. Run

Every session:

```bash
cd /path/to/model-eval
source .venv/bin/activate
```

Then one of:

```bash
# Classification — Standard
python scripts/evaluate.py --task classification --mode standard --test-set internal --csv ~/data/preds.csv \
    --positive-label FGR --prob-confirmed --dca-min 0.05 --dca-max 0.50

# Classification — FGR (record_id like 001_32+5)
python scripts/evaluate.py --task classification --mode fgr --test-set internal --csv ~/data/preds.csv \
    --positive-label FGR --prob-confirmed

# Regression (weeks are converted to days before every metric; figures stay in weeks)
python scripts/evaluate.py --task regression --test-set internal --csv ~/data/preds.csv --unit weeks

# Object detection
python scripts/evaluate.py --task detection --test-set external --csv ~/data/detection.csv --participant-col participant_id

# Segmentation
python scripts/evaluate.py --task segmentation --test-set external --csv ~/data/segmentation.csv --participant-col participant_id
```

- `--test-set internal` or `--test-set external` is required for every evaluation. It goes into every output file name and starts every plot title (`Internal Test: Bland-Altman Plot`).
- `--title "GAUGE: After Pooling"` (optional, up to 80 characters) heads the summary report and is saved in the run record. Leave out participant identifiers.
- Leave out `--csv` to choose the file in a Finder dialog.
- Add `--inspect` to check the columns and see counts without evaluating.
- Add `--out-dir <folder>` to choose where results go (default `eval_output/` in the current folder).
- `python scripts/evaluate.py --help` lists every option.

## 5. The pop-up

After validation a macOS alert shows **Total participants: N** and the other counts, with **Proceed** and **Retry**. It is a standard system dialog raised through `osascript`, so nothing extra is installed. If no dialog can be shown (for example over SSH), the same question appears in the terminal: type `P` or `R`.

## 6. Results

Inside the output folder: `sheets/` (CSV), `figures/` (PNG), `videos/` (MP4 overlays), `logs/` (run log and `run_metadata_*.json`), `reports/` (Markdown summary). File names are `<name>_<internal|external>_<run time>`, for example `bland_altman_internal_20261119_112523.png`, so the test set is visible and nothing is overwritten. Overlay videos open in QuickTime Player.

The report and console show every estimate to 2 decimal places (counts as whole numbers) with its 95% CI as `[lower - upper]`, for example `3.80 [3.54 - 4.06]`. The metrics CSV keeps the full-precision numbers as well, in `estimate`, `ci_lower` and `ci_upper`.

## Using it with the agent

Give the agent this folder as a skill (it reads `SKILL.md`, then the guide for your task). It asks the questions, runs the commands above for you, and explains the results. All numbers come from `scripts/evaluate.py`.

## Memory and speed

Masks and XML files are read one pair at a time and videos are streamed frame by frame, so memory use stays small. The 1,000-replicate bootstrap takes about a second for a few hundred rows and well under a minute for 100,000.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `ModuleNotFoundError` | The environment is not active: `source .venv/bin/activate` |
| `ERROR 404! This particular column (...) is missing.` | Rename or add the column in the CSV; names are exact and lower-case |
| Exit code 5, "Evaluation stopped" | Open `sheets/validation_issues_*.csv`; fix the rows, or agree to exclude them with `--exclude-invalid` |
| Overlay boxes are one frame early or late | Your export counts frames from 1: add `--frame-offset -1` |
| Overlay video will not open in QuickTime | Try another player you already have (for example VLC). The metrics are unaffected |
