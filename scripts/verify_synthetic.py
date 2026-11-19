"""
verify_synthetic.py — Run every task on the synthetic dataset and check known answers.

Author : <name>
Created: 2026-11-19
Usage  : python scripts/verify_synthetic.py        (prints PASS / FAIL per check)
"""

# ============================================================
# 1. IMPORTS
# ============================================================
import json
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np
import pandas as pd
from PIL import Image

# ============================================================
# 2. CONFIG
# ============================================================
SCRIPTS = Path(__file__).resolve().parent          # folder holding the scripts
EVALUATE = SCRIPTS / "evaluate.py"                 # evaluator under test
MAKE_DATA = SCRIPTS / "make_synthetic_data.py"     # synthetic data generator
TOL = 1e-6                                         # numeric tolerance for known answers
RESULTS: list[tuple[str, bool, str]] = []

sys.path.insert(0, str(SCRIPTS))
import evaluate as ev  # noqa: E402  (local module, imported after the path is set)


# ============================================================
# 3. FUNCTIONS
# ============================================================
def check(name: str, ok: bool, detail: str = "") -> None:
    """Record one check."""
    RESULTS.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not ok else ""))


def run(out: Path, *args: str, stdin: str = "", test_set: str | None = "internal") -> tuple[int, str]:
    """Run the evaluator (as the internal test set unless told otherwise); returns (exit code, console text)."""
    extra = ["--test-set", test_set] if test_set and "--test-set" not in args else []
    r = subprocess.run([sys.executable, str(EVALUATE), "--out-dir", str(out), *args, *extra],
                       capture_output=True, text=True, input=stdin)
    return r.returncode, r.stdout + r.stderr


def labelled(out: Path, tag: str, label: str) -> bool:
    """Every output file name carries _<tag>_ and every figure title starts with '<label>: '."""
    files = [f for sub in ("figures", "sheets", "reports", "logs", "videos") for f in (out / sub).glob("*") if f.is_file()]
    meta = json.loads(latest(out, "logs", "run_metadata").read_text())
    titles = meta.get("figure_titles", {})
    return (bool(files) and all(f"_{tag}_" in f.name for f in files) and bool(titles)
            and all(t.startswith(f"{label}: ") for t in titles.values()) and meta.get("test_set") == label)


def latest(out: Path, sub: str, prefix: str) -> Path:
    """Newest output file with a given prefix."""
    return sorted((out / sub).glob(f"{prefix}_*"))[-1]


def metric(out: Path, name: str, group: str | None = None, col: str = "estimate"):
    """Read one value from the newest metrics sheet."""
    m = pd.read_csv(latest(out, "sheets", "metrics"), keep_default_na=False)
    m = m[m["metric"] == name]
    if group:
        m = m[m["group"] == group]
    v = m[col].iloc[0]
    return v if v == "NA" or col == "note" else float(v)


def close(a: float, b: float) -> bool:
    """Numeric equality within tolerance."""
    return math.isclose(a, b, rel_tol=0, abs_tol=TOL)


def verify_classification(data: Path, tmp: Path) -> None:
    """Standard and FGR classification."""
    d, out = data / "classification", tmp / "cls"
    code, text = run(out, "--task", "classification", "--mode", "standard", "--csv", str(d / "tiny_known.csv"),
                     "--positive-label", "pos", "--prob-confirmed", "--dca-min", "0.1", "--dca-max", "0.6",
                     "--confirm", "yes")
    check("standard: runs", code == 0, text[-600:])
    check("standard: **Total participants: 8** shown", "**Total participants: 8**" in text)
    check("standard: confusion matrix TP/FP/FN/TN = 2/1/1/4",
          [metric(out, m) for m in ("TP", "FP", "FN", "TN")] == [2, 1, 1, 4])
    shown = pd.read_csv(latest(out, "sheets", "metrics"), dtype=str, keep_default_na=False).set_index("metric")
    check("reporting: counts whole (TP 2, CI [a - b] in whole numbers), proportions to 2 decimals (specificity 0.80)",
          shown.loc["TP", "estimate_reported"] == "2" and bool(re.fullmatch(r"\[\d+ - \d+\]", shown.loc["TP", "ci_95_reported"]))
          and shown.loc["specificity", "estimate_reported"] == "0.80")
    for name, val in (("sensitivity", 2 / 3), ("specificity", 0.8), ("PPV", 2 / 3), ("NPV", 0.8),
                      ("screen_positive_rate", 3 / 8), ("F1", 2 / 3), ("AUROC", 14 / 15)):
        check(f"standard: {name} = {val:.4f}", close(metric(out, name), val))
    y = np.array([1, 1, 1, 0, 0, 0, 0, 0])
    p = np.array([0.9, 0.8, 0.4, 0.7, 0.3, 0.2, 0.1, 0.05])
    ap_hand = 1 / 3 * 1 + 1 / 3 * 1 + 1 / 3 * (3 / 4)  # precision at each positive, descending score
    check("standard: AUPRC uses average precision", close(metric(out, "AUPRC"), ap_hand))
    try:
        from sklearn.metrics import average_precision_score, roc_auc_score  # optional cross-check only
        rng = np.random.default_rng(0)
        yy, pp = rng.random(500) < 0.3, np.round(rng.random(500), 2)  # rounded -> tied scores
        check("AUROC / AP agree with scikit-learn (ties included)",
              close(ev.auroc(yy.astype(int), pp), roc_auc_score(yy, pp))
              and close(ev.average_precision(yy.astype(int), pp), average_precision_score(yy, pp)))
    except ImportError:
        print("SKIP  scikit-learn cross-check (not installed; not required)")
    nb_model, nb_all = ev.net_benefit(y, p, np.array([0.5]))
    check("decision curve: net benefit at 0.5 (model 1/8, treat-all -1/4)",
          close(nb_model[0], 2 / 8 - 1 / 8) and close(nb_all[0], 3 / 8 - 5 / 8))
    check("standard: bootstrap CI reported with 1000 replicates",
          metric(out, "sensitivity", col="n_boot_requested") == 1000 and metric(out, "sensitivity", col="ci_lower") <= 2 / 3)
    for f in ("confusion_matrix", "calibration_plot", "decision_curve", "roc_curve", "pr_curve"):
        check(f"standard: figure {f}.png saved", latest(out, "figures", f).suffix == ".png")
    roc = pd.read_csv(latest(out, "sheets", "roc_curve"))
    fpr, tpr = roc["false_positive_rate"].to_numpy(), roc["true_positive_rate"].to_numpy()
    check("ROC: runs from (0, 0) to (1, 1) and its area equals the reported AUROC",
          fpr[0] == tpr[0] == 0 and fpr[-1] == tpr[-1] == 1
          and close(float(np.sum(np.diff(fpr) * (tpr[1:] + tpr[:-1]) / 2)), metric(out, "AUROC")))
    pr = pd.read_csv(latest(out, "sheets", "pr_curve"))
    check("PR: step area equals the reported AUPRC",
          close(float(np.sum(np.diff(np.r_[0.0, pr["recall"]]) * pr["precision"])), metric(out, "AUPRC")))
    rng_t = np.random.default_rng(3)
    yt, pt = (rng_t.random(300) < 0.35).astype(int), np.round(rng_t.random(300), 1)  # many ties
    rt = ev.roc_table(yt, pt)
    check("ROC: with tied scores the curve area still equals AUROC (ties get half credit)",
          close(float(np.sum(np.diff(rt["false_positive_rate"]) * (rt["true_positive_rate"].to_numpy()[1:] + rt["true_positive_rate"].to_numpy()[:-1]) / 2)),
                ev.auroc(yt, pt)))
    meta_titles = json.loads(latest(out, "logs", "run_metadata").read_text())["figure_titles"]
    check("ROC / PR: titled 'Internal Test: ROC Curve' and 'Internal Test: Precision-Recall Curve'",
          meta_titles[latest(out, "figures", "roc_curve").name] == "Internal Test: ROC Curve"
          and meta_titles[latest(out, "figures", "pr_curve").name] == "Internal Test: Precision-Recall Curve")
    meta = json.loads(latest(out, "logs", "run_metadata").read_text())
    check("metadata: counts, labels, thresholds, seed saved",
          meta["n_participants"] == 8 and meta["label_mapping"]["positive"] == "pos" and meta["random_seed"] == 42
          and meta["thresholds"]["dca_threshold_range"] == [0.1, 0.6])
    check("metadata: implied pred_label threshold found", meta["thresholds"]["pred_label_vs_pred_prob"]["status"] == "consistent")
    check("test set: classification files say internal, titles start 'Internal Test: '",
          labelled(out, "internal", "Internal Test")
          and meta["figure_titles"][latest(out, "figures", "decision_curve").name] == "Internal Test: Decision Curve Analysis")
    code, text = run(tmp / "cls_none", "--task", "classification", "--mode", "standard", "--csv", str(d / "tiny_known.csv"),
                     "--positive-label", "pos", "--prob-confirmed", "--dca-min", "0.1", "--dca-max", "0.6",
                     "--confirm", "yes", test_set=None)
    check("test set: asked for when missing, not guessed (exit 2)", code == 2 and "--test-set" in text)

    code2, _ = run(tmp / "cls_b", "--task", "classification", "--mode", "standard", "--csv", str(d / "standard.csv"),
                   "--positive-label", "FGR", "--prob-confirmed", "--dca-min", "0.05", "--dca-max", "0.5", "--confirm", "yes")
    code3, _ = run(tmp / "cls_c", "--task", "classification", "--mode", "standard", "--csv", str(d / "standard.csv"),
                   "--positive-label", "FGR", "--prob-confirmed", "--dca-min", "0.05", "--dca-max", "0.5", "--confirm", "yes")
    a = pd.read_csv(latest(tmp / "cls_b", "sheets", "metrics"))
    b = pd.read_csv(latest(tmp / "cls_c", "sheets", "metrics"))
    check("reproducible: two runs give identical metrics and intervals", code2 == code3 == 0 and a.equals(b))

    code, text = run(out, "--task", "classification", "--mode", "standard", "--csv", str(d / "missing_column.csv"),
                     "--positive-label", "pos", "--prob-confirmed", "--dca-min", "0.1", "--dca-max", "0.6", "--confirm", "yes")
    check("missing column: exact message and exit code 4",
          code == 4 and "ERROR 404! This particular column (pred_prob) is missing." in text)
    code, text = run(out, "--task", "classification", "--mode", "standard", "--csv", str(d / "invalid_rows.csv"),
                     "--positive-label", "pos", "--prob-confirmed", "--dca-min", "0.1", "--dca-max", "0.6", "--confirm", "yes")
    issues = pd.read_csv(latest(out, "sheets", "validation_issues"))
    check("invalid rows: stops (exit 5) and lists duplicates + bad probabilities",
          code == 5 and len(issues) == 4 and {"duplicate identifier", "probability outside [0, 1]", "not a number"} <= set(issues["issue"]))
    code, text = run(out, "--task", "classification", "--mode", "standard", "--csv", str(d / "tiny_known.csv"),
                     "--positive-label", "pos", "--prob-confirmed", "--dca-min", "0.1", "--dca-max", "0.6",
                     "--confirm", "console", stdin="r\n")
    check("Retry returns to CSV selection (exit 3, nothing evaluated)", code == 3 and "RETRY" in text)
    code, text = run(out, "--task", "classification", "--mode", "standard", "--csv", str(d / "tiny_known.csv"))
    check("missing user choice is asked for, not guessed (exit 2)", code == 2 and "NEEDS INPUT" in text)
    check("leading zeros preserved", ev.read_csv_strict(d / "tiny_known.csv")["record_id"].iloc[0] == "001")

    out = tmp / "fgr"
    code, text = run(out, "--task", "classification", "--mode", "fgr", "--csv", str(d / "fgr.csv"),
                     "--positive-label", "FGR", "--prob-confirmed", "--confirm", "yes")
    raw = pd.read_csv(d / "fgr.csv", dtype=str)
    check("FGR: runs", code == 0, text[-600:])
    check("FGR: participants and visits counted separately",
          f"**Total participants: 60**" in text and f"Visits: {len(raw)}" in text)
    pids, ga = ev.parse_visit_ids(pd.Series(["001_32+5", "001_36+0", "bad"]))
    check("FGR: 001_32+5 and 001_36+0 are one participant, two visits", pids == ["001", "001", None] and ga[:2] == [229, 252])
    tp = int(((raw.true_label == "FGR") & (raw.pred_label == "FGR")).sum())
    check("FGR: every visit scored (TP matches a direct count)", metric(out, "TP") == tp and metric(out, "TP", col="n") == len(raw))
    names = set(pd.read_csv(latest(out, "sheets", "metrics"))["metric"])
    check("FGR: no F1, calibration or decision curve", "F1" not in names and not list((out / "figures").glob("calibration*")))
    check("FGR: ROC and PR curves saved (scored per visit)",
          bool(list((out / "figures").glob("roc_curve_*"))) and bool(list((out / "figures").glob("pr_curve_*"))))
    codes = np.array([0, 0, 1, 2, 2, 2])
    seen = []
    ev.cluster_bootstrap(codes, lambda idx, c: (seen.append(np.bincount(codes[idx], minlength=3)), [0.0])[1], 50,
                         np.random.default_rng(1), "check")
    check("FGR: bootstrap carries all visits of a participant together",
          all(s[0] % 2 == 0 and s[2] % 3 == 0 for s in seen))


def verify_regression(data: Path, tmp: Path) -> None:
    """Error metrics, Bland-Altman, repeated measures."""
    d, out = data / "regression", tmp / "reg"
    code, text = run(out, "--task", "regression", "--csv", str(d / "tiny_known.csv"), "--unit", "days", "--confirm", "yes")
    check("regression: runs", code == 0, text[-600:])
    sd = math.sqrt(29 / 3)
    for name, val in (("MAE", 2.5), ("MSE", 7.5), ("RMSE", math.sqrt(7.5)), ("mean_bias_pred_minus_true", -0.5),
                      ("loa_lower_95", -0.5 - 1.96 * sd), ("loa_upper_95", -0.5 + 1.96 * sd)):
        check(f"regression: {name} = {val:.4f}", close(metric(out, name), val))
    m = pd.read_csv(latest(out, "sheets", "metrics"))
    check("regression: MSE in squared units", m.loc[m.metric == "MSE", "unit"].iloc[0] == "days^2")
    shown = pd.read_csv(latest(out, "sheets", "metrics"), dtype=str, keep_default_na=False).set_index("metric")
    check("reporting: estimates to 2 decimals (MAE 2.50, RMSE 2.74, bias −0.50)",
          [shown.loc[k, "estimate_reported"] for k in ("MAE", "RMSE", "mean_bias_pred_minus_true")] == ["2.50", "2.74", "−0.50"])
    ci_ok = all(re.fullmatch(r"\[−?\d+\.\d{2} - −?\d+\.\d{2}\]", shown.loc[k, "ci_95_reported"]) for k in ("MAE", "MSE", "loa_lower_95"))
    check("reporting: 95% CIs written as [a - b] with 2 decimals", ci_ok, str(shown["ci_95_reported"].tolist()))
    report = latest(out, "reports", "summary").read_text(encoding="utf-8")
    check("reporting: summary table uses the rounded estimate and [a - b] CI",
          f"| MAE | 2.50 | {shown.loc['MAE', 'ci_95_reported']} |" in report)
    check("reporting: console shows the rounded values", "2.50" in text and shown.loc["MAE", "ci_95_reported"] in text)
    check("reporting: halves round up, counts are whole, −0.00 becomes 0.00, NA stays NA",
          ev.fmt_value(0.625) == "0.63" and ev.fmt_value(2.675) == "2.68" and ev.fmt_value(32.5, "count") == "33"
          and ev.fmt_value(-0.004) == "0.00" and ev.fmt_value(-1.5) == "−1.50" and ev.fmt_value(float("nan")) == "NA"
          and ev.fmt_ci(3.149, 4.271) == "[3.15 - 4.27]")
    check("title: without --title the report heading is unchanged and the run record says null",
          report.splitlines()[0] == "# Internal Test: Evaluation summary — regression"
          and json.loads(latest(out, "logs", "run_metadata").read_text())["title"] is None)
    out_t = tmp / "reg_title"
    code, text = run(out_t, "--task", "regression", "--csv", str(d / "tiny_known.csv"), "--unit", "days",
                     "--confirm", "yes", "--title", "GAUGE:  After   Pooling")
    head_t = latest(out_t, "reports", "summary").read_text(encoding="utf-8").splitlines()
    meta_t = json.loads(latest(out_t, "logs", "run_metadata").read_text())
    check("title: --title heads the report, the task line stays below it, and it is saved (spaces tidied)",
          code == 0 and head_t[0] == "# Internal Test: GAUGE: After Pooling"
          and head_t[2] == "Evaluation summary — regression" and meta_t["title"] == "GAUGE: After Pooling", text[-400:])
    check("title: metrics identical with and without a title",
          close(metric(out_t, "MAE"), 2.5) and close(metric(out_t, "loa_upper_95"), metric(out, "loa_upper_95")))
    code, text = run(out_t, "--task", "regression", "--csv", str(d / "tiny_known.csv"), "--unit", "days",
                     "--confirm", "yes", "--title", "x" * 81)
    check("title: longer than 80 characters is asked about, never cut (exit 2)", code == 2 and "--title" in text)

    # --export-figures: every figure again as 600-dpi TIFF and JPEG (RGB) and as SVG; nothing else changes
    check("export: no figures/export/ without --export-figures", not (out / "figures" / "export").exists())
    out_x = tmp / "reg_export"
    code, text = run(out_x, "--task", "regression", "--csv", str(d / "tiny_known.csv"), "--unit", "days",
                     "--confirm", "yes", "--export-figures")
    meta_x = json.loads(latest(out_x, "logs", "run_metadata").read_text())
    pngs = [out_x / "figures" / name for name in meta_x["figure_titles"]]
    exports = {f: [out_x / "figures" / "export" / f"{f.stem}.{ext}" for ext in ("tiff", "jpeg", "svg")] for f in pngs}
    check("export: TIFF, JPEG and SVG saved for every figure", code == 0 and len(pngs) == 3
          and all(p.is_file() for ps in exports.values() for p in ps), text[-600:])
    ok = True
    for png, (tiff, jpeg, svg) in exports.items():
        with Image.open(png) as a, Image.open(tiff) as t, Image.open(jpeg) as j:
            ok &= t.mode == "RGB" and j.mode == "RGB" and t.size == j.size
            ok &= all(round(float(v)) == 600 for v in (*t.info["dpi"], *j.info["dpi"]))
            ok &= abs(t.size[0] - 3 * a.size[0]) <= 6 and abs(t.size[1] - 3 * a.size[1]) <= 6  # 600 vs 200 dpi
        ok &= "<svg" in svg.read_text(encoding="utf-8")[:2000]
    check("export: TIFF and JPEG are RGB, tagged 600 dpi, three times the 200-dpi PNG; SVG is SVG", ok)
    check("export: metrics identical with and without --export-figures",
          close(metric(out_x, "MAE"), metric(out, "MAE")) and close(metric(out_x, "loa_upper_95"), metric(out, "loa_upper_95")))

    # --column: the GUI maps the CSV's own names; the file itself is never changed
    renamed = pd.read_csv(d / "tiny_known.csv", dtype=str).rename(columns={"record_id": "fpath", "true": "TRUE"})
    renamed.to_csv(tmp / "reg_renamed.csv", index=False)
    before = (tmp / "reg_renamed.csv").read_bytes()
    out_m = tmp / "reg_map"
    code, text = run(out_m, "--task", "regression", "--csv", str(tmp / "reg_renamed.csv"), "--unit", "days",
                     "--column", "record_id=fpath", "--column", "true=TRUE", "--confirm", "yes")
    meta_m = json.loads(latest(out_m, "logs", "run_metadata").read_text())
    check("columns: mapped names give the same MAE, the mapping is recorded and the CSV is untouched",
          code == 0 and close(metric(out_m, "MAE"), 2.5) and meta_m["column_mapping"] == {"record_id": "fpath", "true": "TRUE"}
          and (tmp / "reg_renamed.csv").read_bytes() == before, text[-400:])
    code, text = run(out_m, "--task", "regression", "--csv", str(tmp / "reg_renamed.csv"), "--unit", "days",
                     "--column", "record_id=nope", "--column", "true=TRUE", "--confirm", "yes")
    check("columns: mapping from a missing column gives ERROR 404 (exit 4)",
          code == 4 and "ERROR 404! This particular column (nope) is missing." in text)
    both = pd.read_csv(d / "tiny_known.csv", dtype=str).assign(TRUE=lambda x: x["true"])
    both.to_csv(tmp / "reg_both.csv", index=False)
    code, text = run(out_m, "--task", "regression", "--csv", str(tmp / "reg_both.csv"), "--unit", "days",
                     "--column", "true=TRUE", "--confirm", "yes")
    check("columns: two candidate columns are asked about, not guessed (exit 2)", code == 2 and "NEEDS INPUT" in text)

    # --validate-only, then --confirm gui with the cohort id the GUI showed
    out_g = tmp / "reg_gui"
    base_g = ["--task", "regression", "--csv", str(d / "tiny_known.csv"), "--unit", "days"]
    code, text = run(out_g, *base_g, "--validate-only")
    cohort = json.loads(latest(out_g, "logs", "cohort").read_text())
    check("validate-only: saves the cohort counts, calculates nothing (exit 0, no metrics sheet)",
          code == 0 and "VALIDATED" in text and cohort["total_participants"] == 4 and cohort["rows_in_csv"] == 4
          and not list((out_g / "sheets").glob("metrics_*")), text[-400:])
    code, text = run(out_g, *base_g, "--confirm", "gui", "--confirmed-cohort", cohort["cohort_id"])
    check("gui confirm: the matching cohort id runs the evaluation", code == 0 and close(metric(out_g, "MAE"), 2.5), text[-400:])
    code, text = run(out_g, *base_g, "--confirm", "gui", "--confirmed-cohort", "0000000000000000")
    check("gui confirm: a different cohort id is sent back to Retry (exit 3)", code == 3 and "RETRY" in text)
    code, text = run(out_g, *base_g, "--confirm", "gui")
    check("gui confirm: no cohort id is an error (exit 1)", code == 1 and "--confirmed-cohort" in text)
    status_file = tmp / "status.json"
    code, text = run(out_g, *base_g, "--validate-only", "--status-file", str(status_file))
    status = json.loads(status_file.read_text()) if status_file.exists() else {}
    check("status file: exit code, closing message and file tag saved for the local server",
          status.get("exit_code") == 0 and status.get("message", "").startswith("VALIDATED")
          and status.get("file_tag", "").startswith("internal_"), str(status)[:300])
    for f in ("calibration_plot", "bland_altman", "true_vs_pred"):
        check(f"regression: figure {f}.png saved", latest(out, "figures", f).exists())
    meta = json.loads(latest(out, "logs", "run_metadata").read_text())
    check("regression: titles 'Internal Test: Bland-Altman Plot' and 'Internal Test: Predicted vs Ground Truth'",
          meta["figure_titles"][latest(out, "figures", "bland_altman").name] == "Internal Test: Bland-Altman Plot"
          and meta["figure_titles"][latest(out, "figures", "true_vs_pred").name] == "Internal Test: Predicted vs Ground Truth")
    check("test set: regression files say internal", labelled(out, "internal", "Internal Test"))

    # Weeks are converted to days before any metric: the same pairs given in weeks give the same day-metrics
    wk = pd.read_csv(d / "tiny_known.csv", dtype={"record_id": str})
    wk["true"], wk["pred"] = wk["true"] / 7, wk["pred"] / 7
    wk.to_csv(tmp / "reg_weeks.csv", index=False)
    out = tmp / "reg_weeks"
    code, text = run(out, "--task", "regression", "--csv", str(tmp / "reg_weeks.csv"), "--unit", "weeks",
                     "--confirm", "yes", test_set="external")
    check("weeks -> days: runs", code == 0, text[-600:])
    for name, val in (("MAE", 2.5), ("MSE", 7.5), ("RMSE", math.sqrt(7.5)), ("mean_bias_pred_minus_true", -0.5),
                      ("loa_lower_95", -0.5 - 1.96 * sd), ("loa_upper_95", -0.5 + 1.96 * sd)):
        check(f"weeks -> days: {name} = {val:.4f} days", close(metric(out, name), val))
    m = pd.read_csv(latest(out, "sheets", "metrics"))
    check("weeks -> days: metric units are days / days^2 and the conversion is noted",
          set(m.loc[m.metric != "MSE", "unit"]) == {"days"} and m.loc[m.metric == "MSE", "unit"].iloc[0] == "days^2"
          and m["note"].str.contains("converted from weeks").all())
    check("weeks -> days: CI bounds also in days (bracket the estimate)",
          metric(out, "MAE", col="ci_lower") <= 2.5 <= metric(out, "MAE", col="ci_upper"))
    check("test set: external files say external, titles start 'External Test: '",
          labelled(out, "external", "External Test"))
    out = tmp / "reg_rep"
    code, text = run(out, "--task", "regression", "--csv", str(d / "repeated.csv"), "--unit", "days",
                     "--id-format", "visit", "--confirm", "yes")
    check("repeated measures: asks before reporting agreement (exit 2)", code == 2 and "repeated-measures" in text)
    for method in ("participant-mean", "all-pairs-anova"):
        code, text = run(out, "--task", "regression", "--csv", str(d / "repeated.csv"), "--unit", "days",
                         "--id-format", "visit", "--repeated-measures", method, "--confirm", "yes")
        check(f"repeated measures: {method} runs with 40 participants", code == 0 and "**Total participants: 40**" in text)
    # ANOVA limits collapse to the ordinary limits when every participant has one... and widen vs participant means
    dd = np.array([1.0, 3.0, -2.0, 0.0, 4.0, 6.0])
    cl = np.array([0, 0, 1, 1, 2, 2])
    ba = ev.bland_altman_stats(dd, cl, "all-pairs-anova")
    msw, msb = 6 / 3, 2 * ((2 - 2) ** 2 + (-1 - 2) ** 2 + (5 - 2) ** 2) / 2
    check("repeated measures: ANOVA SD matches hand calculation", close(ba[1], math.sqrt(msw + (msb - msw) / 2)))


def verify_detection(data: Path, tmp: Path) -> None:
    """Frame eligibility, matching, NA for mAP, overlays."""
    d, out = data / "detection", tmp / "det"
    t, p = ev.parse_cvat_xml(d / "xml/vid_a_true.xml"), ev.parse_cvat_xml(d / "xml/vid_a_pred.xml")
    res = ev.score_video(t, p, True)
    check("acceptance example: frames 10 and 20 evaluated, frame 30 ignored",
          sorted(t["listed"]) == [10, 20] and res["n_eligible_frames"] == 2 and res["n_prediction_only_frames_ignored"] == 1)
    check("acceptance example: frame 10 box is a missed detection, frame 20 compared (TP 1, FP 0, FN 1)",
          res["counts"] == {"head": [1, 0, 1]})
    code, text = run(out, "--task", "detection", "--csv", str(d / "detection.csv"), "--participant-col", "participant_id",
                     "--confirm", "yes")
    check("detection: runs", code == 0, text[-600:])
    check("detection: participants and videos counted", "**Total participants: 2**" in text and "Videos: 3" in text)
    check("detection: pooled TP/FP/FN = 5/3/3", [metric(out, m, "overall") for m in ("TP", "FP", "FN")] == [5, 3, 3])
    check("detection: precision = recall = 0.625", close(metric(out, "precision", "overall"), 0.625)
          and close(metric(out, "recall", "overall"), 0.625))
    check("detection: per-class head 4/3/2, abdomen 1/0/1 (duplicate and wrong-class boxes are FP)",
          [metric(out, m, "class: head") for m in ("TP", "FP", "FN")] == [4, 3, 2]
          and [metric(out, m, "class: abdomen") for m in ("TP", "FP", "FN")] == [1, 0, 1])
    for m in ("mAP@50", "mAP@50:95"):
        check(f"detection: {m} is NA with the required reason",
              metric(out, m) == "NA" and metric(out, m, col="note") == "NA — prediction confidence scores unavailable")
    meta = json.loads(latest(out, "logs", "run_metadata").read_text())
    vids = [s["overlay"] for s in meta["selected_examples"]]
    check("detection: two overlay videos written", len(vids) == 2 and all(v and Path(v).exists() for v in vids))
    check("test set: overlay video names say internal", all("_internal_" in Path(v).name for v in vids))
    cap = cv2.VideoCapture(vids[0])
    n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    line = meta["selected_examples"][0]["csv_line"]
    n_true = len(ev.parse_cvat_xml(d / f"xml/vid_{'abc'[line - 2]}_true.xml")["listed"])
    check("detection: overlay shows only eligible frames", n_frames == n_true, f"{n_frames} vs {n_true}")
    check("detection: outside=1 box excluded", meta["detection"]["boxes_excluded_outside_1"] == 1)
    # matching: maximise the number of matches before total IoU
    # A-P has the highest IoU, but taking it leaves B unmatched; A-Q + B-P gives two matches
    ref = np.array([[0, 0, 10, 10], [4, 0, 14, 10]], dtype=float)
    pred = np.array([[1, 0, 11, 10], [-3, 0, 7, 10]], dtype=float)
    check("matching: two matches preferred over one higher-IoU match", len(ev.match_boxes(ref, pred)) == 2)
    code, text = run(out, "--task", "detection", "--csv", str(d / "detection_no_video.csv"), "--participant-col",
                     "participant_id", "--confirm", "yes")
    check("detection: no video_path -> metrics complete and videos requested",
          code == 0 and "OVERLAYS PENDING" in text and metric(out, "TP", "overall") == 5)
    code, text = run(out, "--task", "detection", "--csv", str(d / "detection_unlabelled.csv"), "--participant-col",
                     "participant_id", "--confirm", "yes")
    check("detection: coordinates only -> class-agnostic, per-class unavailable",
          code == 0 and metric(out, "per_class_precision_recall") == "NA"
          and metric(out, "TP", "overall (class-agnostic localization)") == 1)
    code, text = run(out, "--task", "detection", "--csv", str(d / "detection.csv"), "--confirm", "yes")
    check("detection: asks which column links files to participants (exit 2)", code == 2 and "--participant-col" in text)


def verify_segmentation(data: Path, tmp: Path) -> None:
    """Dice / IoU, empty-mask rules, validation, examples."""
    d, out = data / "segmentation", tmp / "seg"
    base = ["--task", "segmentation", "--csv", str(d / "segmentation.csv"), "--participant-col", "participant_id", "--confirm", "yes"]
    code, text = run(out, *base)
    check("segmentation: both-empty pair triggers a question (exit 2)", code == 2 and "--empty-both" in text)
    code, text = run(out, *base, "--empty-both", "exclude")
    check("segmentation: runs", code == 0, text[-600:])
    check("segmentation: participants and mask pairs counted", "**Total participants: 6**" in text and "Mask pairs: 8" in text)
    check("segmentation: exclude policy -> Dice 0.527778, IoU 0.461111",
          close(metric(out, "dice_mean"), 3.1666666667 / 6) and close(metric(out, "iou_mean"), 2.7666666667 / 6))
    pp = pd.read_csv(latest(out, "sheets", "per_pair_scores"), keep_default_na=False)
    check("segmentation: per-pair scores match known overlaps",
          [pp.dice[i] for i in (0, 1, 2, 3)] == ["1.0", "0.5", "0.0", "NA"] and close(float(pp.iou[6]), 0.6))
    check("segmentation: affected pairs reported (1 both-empty, 1 one-empty)",
          metric(out, "pairs_both_empty") == 1 and metric(out, "pairs_exactly_one_empty") == 1)
    meta = json.loads(latest(out, "logs", "run_metadata").read_text())
    lines = [s["csv_line"] for s in meta["selected_examples"]]
    check("segmentation: five distinct example pairs saved", len(set(lines)) == 5 and latest(out, "figures", "mask_examples").exists())
    check("test set: segmentation files say internal, title 'Internal Test: Segmentation Mask Examples'",
          labelled(out, "internal", "Internal Test")
          and meta["figure_titles"][latest(out, "figures", "mask_examples").name] == "Internal Test: Segmentation Mask Examples")
    check("segmentation: no image column -> no overlay figure, run record says why",
          not list((out / "figures").glob("mask_overlays_*")) and "no 'image' column" in meta["segmentation"]["image_overlays"])
    out_img = tmp / "seg_img"
    code, text = run(out_img, "--task", "segmentation", "--csv", str(d / "segmentation_with_images.csv"),
                     "--participant-col", "participant_id", "--empty-both", "exclude", "--confirm", "yes",
                     "--export-figures")
    meta_i = json.loads(latest(out_img, "logs", "run_metadata").read_text())
    check("export: mask figures saved as TIFF, JPEG and SVG",
          all((out_img / "figures" / "export" / f"{Path(n).stem}.{ext}").is_file()
              for n in meta_i["figure_titles"] for ext in ("tiff", "jpeg", "svg")) and len(meta_i["figure_titles"]) == 2)
    statuses = {s["csv_line"]: s["overlay"] for s in meta_i["selected_examples"]}
    check("overlays: image column -> mask_overlays figure titled 'Internal Test: Reference vs Predicted Mask on Image'",
          code == 0 and meta_i["figure_titles"].get(latest(out_img, "figures", "mask_overlays").name)
          == "Internal Test: Reference vs Predicted Mask on Image", text[-600:])
    check("overlays: wrong-size image skipped (not resized), every other sampled pair drawn",
          all((v.startswith("image is 40x32 but the masks are 80x64") if k == 7 else v == "ok") for k, v in statuses.items()),
          str(statuses))
    report = latest(out_img, "reports", "summary").read_text(encoding="utf-8")
    check("overlays: notice names the CSV line, never the file path; metrics unchanged",
          ("images/" not in report and "images/" not in text)
          and (7 not in statuses or "Image overlay skipped for CSV line 7" in report)
          and close(metric(out_img, "dice_mean"), 3.1666666667 / 6))
    code, text = run(out, *base, "--empty-both", "one")
    check("segmentation: score-of-one policy -> Dice 0.611111, IoU 0.544444",
          code == 0 and close(metric(out, "dice_mean"), 3.6666666667 / 6) and close(metric(out, "iou_mean"), 3.2666666667 / 6))
    code, text = run(out, "--task", "segmentation", "--csv", str(d / "segmentation_invalid.csv"), "--participant-col",
                     "participant_id", "--confirm", "yes")
    issues = pd.read_csv(latest(out, "sheets", "validation_issues"))
    check("segmentation: size mismatch, non-binary values and missing file reported, nothing resized",
          code == 5 and set(issues["issue"]) == {"dimension mismatch", "invalid mask", "file missing or unreadable"})


# ============================================================
# 4. MAIN
# ============================================================
def main() -> None:
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        data = tmp / "synthetic_data"
        print("[Step 1/5] Building synthetic data...")
        subprocess.run([sys.executable, str(MAKE_DATA), "--out", str(data)], check=True, capture_output=True)
        for i, (name, fn) in enumerate((("classification", verify_classification), ("regression", verify_regression),
                                        ("detection", verify_detection), ("segmentation", verify_segmentation)), start=2):
            print(f"[Step {i}/5] Verifying {name}...")
            fn(data, tmp)
    failed = [r for r in RESULTS if not r[1]]
    print("=" * 60)
    print(f"{len(RESULTS) - len(failed)} of {len(RESULTS)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
