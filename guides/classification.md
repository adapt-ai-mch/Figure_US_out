# Classification guide (binary; Standard or FGR)

## The two modes

| | Standard | FGR |
|---|---|---|
| `record_id` | `001` = one participant, one prediction | `001_32+5` = participant `001` at 32 weeks + 5 days |
| Scoring unit | One participant | One scan. Every visit is scored against FGR status at that scan |
| Bootstrap | Participants | Participants, with all their visits carried together |
| Outputs | Confusion matrix, AUROC, AUPRC, PPV, NPV, sensitivity, specificity, screen-positive rate, F1, ROC curve, precision-recall curve, calibration plot, decision curve | Confusion matrix, AUROC, AUPRC, PPV, NPV, sensitivity, specificity, screen-positive rate, ROC curve, precision-recall curve |

In FGR mode `001_32+5` and `001_36+0` are **one participant and two scored visits**, and the two visits may have different true labels. The script does not carry a label from one visit to another.

## Questions to ask

0. **Internal or external test set?** → `--test-set internal` or `--test-set external` (asked for every task; see `SKILL.md`).
1. **Standard or FGR?** → `--mode standard` or `--mode fgr`
2. **Which label is positive?** Show the label counts from `--inspect`. → `--positive-label <label>`
3. **Is `pred_prob` the probability of that positive label?** Pass `--prob-confirmed` only after an explicit yes. If it is the probability of the other class, stop: the user must supply the right column. Do not compute `1 − p` yourself.
4. If more than two labels occur, ask which is negative → `--negative-label <label>`. Rows with any other label are reported as invalid.
5. **Standard only:** the relevant threshold-probability range for decision curve analysis → `--dca-min`, `--dca-max` (0 < min < max < 1). Ask for the clinically relevant range; do not suggest a default as if it were neutral.

## Commands

```bash
# Standard
python scripts/evaluate.py --task classification --mode standard --test-set internal --csv preds.csv \
    --positive-label FGR --prob-confirmed --dca-min 0.05 --dca-max 0.50

# FGR
python scripts/evaluate.py --task classification --mode fgr --test-set external --csv preds.csv \
    --positive-label FGR --prob-confirmed
```

## Figures (file names carry the test set; titles start `Internal Test:` / `External Test:`)

| File | Title |
|---|---|
| `roc_curve_<test set>_<run>.png` (both modes) | `… : ROC Curve` |
| `pr_curve_<test set>_<run>.png` (both modes) | `… : Precision-Recall Curve` |
| `confusion_matrix_<test set>_<run>.png` | `… : Confusion Matrix (participants)` or `(visits)` |
| `calibration_plot_<test set>_<run>.png` (Standard) | `… : Calibration Plot` |
| `decision_curve_<test set>_<run>.png` (Standard) | `… : Decision Curve Analysis` |

## What the script calculates

- `pred_label` → confusion matrix and operating-point metrics (PPV, NPV, sensitivity, specificity, screen-positive rate, F1).
- `pred_prob` → AUROC, AUPRC, calibration and the decision curve.
- **AUPRC** uses the average-precision convention: Σ (Rₖ − Rₖ₋₁) · Pₖ over distinct scores, with no interpolation.
- **ROC curve** (both modes): false-positive rate against sensitivity at every distinct `pred_prob`, joined by straight lines so its area is exactly the reported AUROC (ties included). The chance diagonal, AUROC with its `[lower - upper]` CI, and the operating point of `pred_label` are drawn. Points are in `sheets/roc_curve_*.csv`.
- **Precision-recall curve** (both modes): drawn as steps, so its area is exactly the reported AUPRC. A dashed line marks the positive fraction (chance level), and the `pred_label` operating point is drawn. Points are in `sheets/pr_curve_*.csv`. Neither curve is drawn when the data lack the classes it needs; the log says so.
- **Screen-positive rate** = scored observations predicted positive ÷ all scored observations.
- **95% CIs**: percentile, 1,000 participant-bootstrap replicates, for every scalar metric and each confusion-matrix cell.
- **Calibration (Standard)**: mean predicted probability against observed event frequency in 10 quantile bins fixed on the full data, with pointwise 95% bootstrap intervals and an identity line.
- **Decision curve (Standard)**: net benefit = TP/n − FP/n · pt/(1 − pt), treating when `pred_prob ≥ pt`, on a 0.01 grid across the user's range, beside treat-all and treat-none, with pointwise 95% bootstrap bands.
- **Consistency check**: the run record states whether `pred_label` is a single cut of `pred_prob` and, if so, the interval the threshold lies in. A `WARNING direction` status means predicted-positive rows have the lower mean probability: re-confirm question 3 with the user before interpreting anything.

## Validation the script performs

Duplicate or empty `record_id`; labels outside the binary mapping; `pred_prob` not numeric or outside [0, 1]; in FGR mode, identifiers that are not `<participant>_<weeks>+<days>` with days 0–6. In Standard mode, a notice appears if every identifier looks like a visit identifier.

## Interpretation notes

- Name the scoring unit every time. FGR metrics are per scan, so a participant with more visits contributes more observations; the participant bootstrap accounts for this in the interval, not in the point estimate.
- In FGR mode the confusion-matrix cell intervals come from replicates with varying numbers of visits.
- PPV and NPV depend on prevalence in this sample. Say so if the user wants to transfer them to another population.
- AUPRC should be read against the positive fraction, which is its chance level.
- Decision curve: the model adds value over a range of thresholds only where its net benefit exceeds both treat-all and treat-none. Overlapping bands mean the data do not separate the strategies there.
- With few events, calibration bins are wide and intervals long. Report that as a limit of the data.
- `NA` examples: AUROC with one reference class; PPV with no predicted positives. Give the stated reason.
