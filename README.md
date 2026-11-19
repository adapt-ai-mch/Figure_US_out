# FigureUS(out)

Evaluate saved ultrasound model predictions on your own computer. FigureUS(out) takes a predictions CSV and reports metrics with 95% confidence intervals and figures for four tasks:

| Task | Reports | CSV columns |
|---|---|---|
| Classification (Standard or FGR) | Confusion matrix, AUROC, AUPRC, PPV, NPV, sensitivity, specificity; ROC, precision-recall, calibration and decision curves | `record_id`, `true_label`, `pred_label`, `pred_prob` |
| Regression | MAE, MSE, RMSE, Bland-Altman agreement (weeks converted to days) | `record_id`, `true`, `pred` |
| Object detection | Precision and recall on reviewed frames, overlay videos | `record_id`, `true_xml`, `pred_xml` (`video_path` optional) |
| Segmentation | Dice and IoU, masks drawn over the original image | `record_id`, `true_mask`, `pred_mask` (`image` optional) |

Columns with other names are matched in the app (or with `--column`), so the CSV is never edited.

Every number comes from `scripts/evaluate.py`: confidence intervals resample participants (1,000 bootstrap replicates, seed 42), estimates are reported to 2 decimal places with CIs written `[lower - upper]`, and nothing is dropped or guessed silently.

In the app, click a plot to see it large, and save any plot as TIFF or JPEG at 600 dpi, or as SVG, into the folder you choose. The app follows the computer's light or dark setting, or keeps the theme you pick.

## Runs locally, never hosted

FigureUS(out) runs on the computer that holds the data. The app's server listens on `127.0.0.1` only, so no other computer can reach it, and after installation nothing needs the internet. Uploaded copies and results stay in `eval_output/`, which git ignores. **Never commit study data or results to this repository.**

## Start (macOS)

Needs Python 3.10 or newer ([python.org](https://www.python.org/downloads/)).

```bash
git clone https://github.com/adapt-ai-mch/Figure_US_out.git
```

Then double-click **`start_figureus.command`** in the `Figure_US_out` folder (first time: right-click it and choose **Open**). The first start installs the Python packages into `.venv` (internet needed once); after that it starts offline and opens http://127.0.0.1:8765 in your browser. Keep the Terminal window open while you work.

On Windows or Linux, from the folder:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python server/app.py
```

(On Windows use `.venv\Scripts\python` instead of `.venv/bin/python`.)

## Check the installation

```bash
.venv/bin/python scripts/verify_synthetic.py    # the evaluator, on synthetic data
.venv/bin/python scripts/verify_server.py       # the app's server, on synthetic data
```

Both should end with every check passed.

## What is in this folder

| Path | What it is |
|---|---|
| `scripts/evaluate.py` | The evaluator: every calculation, figure and report |
| `server/app.py` | The local server: runs `evaluate.py` for the app and serves it |
| `gui/` | The app (React). `gui/dist` is the built app, committed so only Python is needed |
| `start_figureus.command` | Double-click launcher for macOS |
| `SKILL.md`, `guides/` | Instructions for using the evaluator through an AI agent |
| `README_macOS.md` | Command-line use, the app step by step, troubleshooting |
| `scripts/verify_*.py`, `scripts/make_synthetic_data.py` | Self-tests and the synthetic data they use |
