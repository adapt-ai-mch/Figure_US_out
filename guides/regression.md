# Regression guide

CSV columns: `record_id`, `true`, `pred`.

## Questions to ask

0. **Internal or external test set?** → `--test-set internal` or `--test-set external` (asked for every task; see `SKILL.md`).
1. **What is the common unit of `true` and `pred`?** (weeks, days, millimetres, …) → `--unit weeks`. If the two columns are in different units, stop: the user must supply a CSV in one unit. Do not convert anything yourself.
   - **Weeks:** the script converts both columns to days (× 7) **before** any metric is calculated. Every point estimate and 95% CI in the metrics sheet and report is then in **days** (MSE in `days^2`), and each note says `converted from weeks (× 7) before calculation`. The figures stay in weeks, matching the reference figures.
   - Any other unit is used as given.
2. **Does each participant contribute one pair, or several?**
   - One pair each, `record_id` is the participant → nothing to add.
   - Several pairs, and `record_id` looks like `001_32+5` → `--id-format visit`.
   - Several pairs, linked by another column → `--participant-col <column>`.
   `--inspect` reports how many identifiers have the visit shape; the run also prints a notice. Ask; do not decide from the shape alone.
3. **If participants contribute several pairs, which repeated-measures analysis is intended for agreement?** The script stops with `NEEDS INPUT` until this is answered. Explain both options in plain terms:
   - `--repeated-measures participant-mean` — average the differences within each participant, then ordinary Bland–Altman on one point per participant. Limits describe agreement of participant averages and are narrower than for single measurements.
   - `--repeated-measures all-pairs-anova` — plot every pair; the SD combines within- and between-participant variance from a one-way ANOVA of the differences (Bland & Altman 2007, the case where the true value varies). Limits describe a single future measurement.

## Commands

```bash
python scripts/evaluate.py --task regression --test-set internal --csv preds.csv --unit weeks

python scripts/evaluate.py --task regression --test-set external --csv preds.csv --unit weeks \
    --participant-col participant_id --repeated-measures all-pairs-anova
```

## What the script calculates

- **MAE, MSE, RMSE** over all pairs, each with a 95% percentile CI from 1,000 participant-bootstrap replicates. With `--unit weeks` they are in days (MSE in `days^2`).
- **Bias, SD of differences and 95% limits of agreement** (bias ± 1.96 SD), each with a bootstrap CI; in days for weeks input.
- **Reported format:** every estimate to 2 decimal places (halves round up) with its CI as `[lower - upper]`, e.g. `MAE 3.80 days, 95% CI [3.54 - 4.06]`. The report, the console and the `estimate_reported` / `ci_95_reported` columns all use it; `estimate`, `ci_lower` and `ci_upper` keep full precision.

## Figures (title prefix `Internal Test:` / `External Test:`; axes in the CSV's unit)

| File | Title | What it shows |
|---|---|---|
| `bland_altman_<test set>_<run>.png` | `… : Bland-Altman Plot` | Mean of true & predicted (x) against pred − true (y); red dashed line `Mean diff = …`, grey dashed lines `+1.96 SD = …` and `-1.96 SD = …` (the limits of agreement); a footnote names the repeated-measures method when one was used |
| `true_vs_pred_<test set>_<run>.png` | `… : Predicted vs Ground Truth` | Ground truth (x) against predicted (y) with a least-squares line, and histograms with a density curve of each along the top and right edges |
| `calibration_plot_<test set>_<run>.png` | `… : Calibration Plot` | Mean predicted against mean observed in 10 quantile bins of `pred`, identity line, pointwise 95% bootstrap intervals |

- The Bland-Altman legend shows the limits of agreement only. They are **not** confidence intervals. In the sheet, `loa_lower_95` and `loa_upper_95` are the limits; their `ci_lower`/`ci_upper` columns are bootstrap CIs *of* each limit.
- With `--unit weeks` the legend values are in weeks and the metrics sheet in days: the same numbers × 7.
- The least-squares line is drawn on the figure only (its slope and intercept are in the run record); it is not a reported metric.

## Validation the script performs

Duplicate or empty `record_id`; `true` or `pred` not a finite number; malformed visit identifiers when `--id-format visit` is used.

## Interpretation notes

- Name the test set and the unit first: "Internal Test, all metrics in days (converted from weeks)".
- Bias is `pred − true`: positive means the model over-predicts.
- Never call the limits of agreement a confidence interval. They describe where about 95% of individual differences fall; the CI describes uncertainty in an estimate.
- The limits assume the differences are roughly normal with constant spread. Look at the plot: a fan shape or a slope means bias or spread changes with magnitude, and a single pair of limits is then a poor summary. Say so, and do not transform the data unless the user asks.
- RMSE weights large errors more than MAE; a large gap between them points to outliers.
- Whether the error is acceptable is a clinical judgement that belongs to the user.
