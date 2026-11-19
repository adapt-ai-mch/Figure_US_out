"""
evaluate.py — Offline, CPU-only evaluation of saved model predictions
(classification, regression, object detection, segmentation).

Author : <name>
Created: 2026-11-19
Usage  : python scripts/evaluate.py --task classification --mode standard --test-set internal \
             --csv preds.csv --positive-label FGR --prob-confirmed \
             --dca-min 0.05 --dca-max 0.50
         python scripts/evaluate.py --task regression --test-set external --csv preds.csv --unit weeks
         python scripts/evaluate.py --help        # every option
         python scripts/evaluate.py --task regression --csv preds.csv --inspect

All calculations are deterministic functions in this file. The agent (or user)
supplies choices as command-line options; the script never guesses a choice
that the workflow says must be asked. Console output, logs, plots and reports
identify records by CSV line number only, never by identifier.

Every output file name carries the test set (internal / external) and every plot
title starts with "Internal Test:" or "External Test:". Regression values given in
weeks are converted to days before any metric is calculated.
"""

# ============================================================
# 1. IMPORTS  (standard library -> third-party)
# ============================================================
import argparse
import hashlib
import io
import json
import logging
import platform
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import cv2
import matplotlib

matplotlib.use("Agg")  # file output only; no GUI backend needed
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import scipy
from PIL import Image
from scipy.optimize import linear_sum_assignment
from scipy.stats import gaussian_kde, rankdata
from tqdm.auto import tqdm

# ============================================================
# 2. CONFIG  — every path and parameter lives here
# ============================================================
RUN_NAME = datetime.now().strftime("%Y%m%d_%H%M%S")       # tags all outputs of this run
FILE_TAG = RUN_NAME                                       # "<internal|external>_<run>" once --test-set is known
PLOT_PREFIX = ""                                          # "Internal Test" / "External Test" once --test-set is known
TEST_SET_LABEL = {"internal": "Internal Test", "external": "External Test"}
TITLE_MAX = 80                                            # longest --title accepted (characters)

# --- Units (regression) ---
WEEK_UNITS = {"week", "weeks", "wk", "wks"}               # --unit values treated as weeks
DAYS_PER_WEEK = 7                                         # weeks are converted to days before any metric

# --- Output paths ---
OUTPUT_DIR = Path("eval_output")                          # default root; override with --out-dir
OUTPUT_SUBDIRS = ["figures", "sheets", "videos", "logs", "reports"]
EXPORT_SUBDIR = "export"                                  # figures/export/: the --export-figures copies
EXPORT_DPI = 600                                          # TIFF and JPEG resolution (and any image inside the SVG)
EXPORT_JPEG_QUALITY = 95                                  # JPEG quality, 1-95

# --- Statistics ---
SEED = 42                                                 # fixed seed: bootstrap + visual sampling
N_BOOT = 1000                                             # bootstrap replicates
CI_LEVEL = 0.95                                           # percentile confidence level
CALIB_BINS = 10                                           # quantile bins for calibration plots
DCA_STEP = 0.01                                           # threshold-probability grid step
LOA_Z = 1.96                                              # multiplier for 95% limits of agreement
REPORT_DECIMALS = 2                                       # decimals for reported estimates and CIs (halves round up)
COUNT_UNITS = {"count", "boxes", "mask pairs"}            # metrics reported as whole numbers

# --- Detection ---
IOU_MATCH = 0.50                                          # box-matching IoU threshold
IOU_TOL = 1e-9                                            # float tolerance on IoU >= threshold
N_OVERLAY_VIDEOS = 2                                      # videos sampled for overlays
OVERLAY_FPS = 2                                           # playback speed of overlay videos
COLOUR_REF_BGR = (178, 114, 0)                            # reference boxes: blue  (#0072B2)
COLOUR_PRED_BGR = (0, 159, 230)                           # predicted boxes: orange (#E69F00)
MAP_NA = "NA — prediction confidence scores unavailable"

# --- Segmentation ---
N_MASK_EXAMPLES = 5                                       # mask pairs sampled for display
MASK_FG, MASK_BG = 255, 0                                 # required pixel encoding
IMAGE_COLUMN = "image"                                    # optional original image, used for overlays only
OVERLAY_REF_RGB = (0.22, 0.74, 0.97)                      # reference mask: light blue, solid outline
OVERLAY_PRED_RGB = (0.96, 0.62, 0.04)                     # predicted mask: amber, dashed outline
OVERLAY_ALPHA = 0.35                                      # mask fill opacity on the image

# --- Plot colours (colour-blind safe) ---
C_MODEL, C_ALT, C_GREY = "#0072B2", "#E69F00", "#555555"

# --- Plot style (reference figures: grey grid background, blue points, red mean line) ---
PLOT_STYLE = "seaborn-v0_8-darkgrid"
C_POINT, C_MEAN, C_LIMIT = "#4C72B0", "#E41A1C", "#7F7F7F"
plt.style.use(PLOT_STYLE)

# --- Input schema ---
REQUIRED_COLUMNS = {
    "classification": ["record_id", "true_label", "pred_label", "pred_prob"],
    "regression": ["record_id", "true", "pred"],
    "detection": ["record_id", "true_xml", "pred_xml"],
    "segmentation": ["record_id", "true_mask", "pred_mask"],
}
MISSING_COLUMN_MSG = "ERROR 404! This particular column ({col}) is missing."
VISIT_ID_PATTERN = re.compile(r"^(?P<pid>.+)_(?P<weeks>\d{1,2})\+(?P<days>[0-6])$")  # 001_32+5
OBS_UNIT = {"classification": "visits", "regression": "pairs",
            "detection": "videos", "segmentation": "mask pairs"}

# --- Exit codes (the agent reads these) ---
EXIT_OK, EXIT_ERROR, EXIT_NEEDS_INPUT, EXIT_RETRY, EXIT_MISSING_COLUMN, EXIT_INVALID = 0, 1, 2, 3, 4, 5

# ============================================================
# 3. SETUP HELPERS
# ============================================================
log = logging.getLogger("run")
DIRS: dict[str, Path] = {}
SAVED_FILES: list[Path] = []
FIGURE_TITLES: dict[str, str] = {}
EXPORT_FIGURES = False                                    # set by --export-figures


class Stop(Exception):
    """Controlled stop carrying an exit code and a message for the user."""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def setup_output_dirs(root: Path, subdirs: list[str]) -> dict[str, Path]:
    """Create <root>/<subdir> folders if missing and return {name: path}."""
    dirs = {}
    for name in subdirs:
        d = root / name
        d.mkdir(parents=True, exist_ok=True)
        dirs[name] = d
    return dirs


def setup_logger(log_file: Path) -> None:
    """Log to console and to a file at the same time."""
    log.setLevel(logging.INFO)
    log.handlers.clear()
    fmt = logging.Formatter("%(asctime)s | %(message)s", datefmt="%H:%M:%S")
    for h in (logging.StreamHandler(sys.stdout), logging.FileHandler(log_file, encoding="utf-8")):
        h.setFormatter(fmt)
        log.addHandler(h)


def saved(path: Path) -> Path:
    """Record and announce a saved output file."""
    SAVED_FILES.append(path)
    log.info(f"Saved -> {path}")
    return path


def plot_title(text: str) -> str:
    """Prefix a plot title with the test set, e.g. 'Internal Test: Bland-Altman Plot'."""
    return f"{PLOT_PREFIX}: {text}" if PLOT_PREFIX else text


def save_figure(fig, stem: str, title: str, dpi: int = 200, tight: bool = True) -> Path:
    """Save a figure as <stem>_<test set>_<run>.png (plus the export copies), record its title and close it."""
    path = saved(DIRS["figures"] / f"{stem}_{FILE_TAG}.png")
    if tight:
        fig.tight_layout()
    fig.savefig(path, dpi=dpi, bbox_inches="tight")
    if EXPORT_FIGURES:
        export_figure(fig, path.stem)
    plt.close(fig)
    FIGURE_TITLES[path.name] = title
    return path


def export_figure(fig, name: str) -> None:
    """The same figure for journals, in figures/export/: TIFF (LZW) and JPEG at EXPORT_DPI, both RGB, and SVG."""
    folder = DIRS["figures"] / EXPORT_SUBDIR
    folder.mkdir(exist_ok=True)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=EXPORT_DPI, bbox_inches="tight")
    buf.seek(0)
    with Image.open(buf) as img:
        rgb = img.convert("RGB")  # the figure background is opaque, so dropping alpha changes no pixel
    rgb.save(saved(folder / f"{name}.tiff"), compression="tiff_lzw", dpi=(EXPORT_DPI, EXPORT_DPI))
    rgb.save(saved(folder / f"{name}.jpeg"), quality=EXPORT_JPEG_QUALITY, dpi=(EXPORT_DPI, EXPORT_DPI))
    fig.savefig(saved(folder / f"{name}.svg"), format="svg", dpi=EXPORT_DPI, bbox_inches="tight")


def step(i: int, total: int, text: str) -> None:
    """Step-level progress line."""
    log.info(f"[Step {i}/{total}] {text}")


def sha256_file(path: Path) -> str:
    """Hash a file so a run can be tied to its exact input."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ============================================================
# 4. FUNCTIONS
# ============================================================
# ---------- 4.1 CSV intake and validation ----------
def read_csv_strict(path: Path) -> pd.DataFrame:
    """Read every cell as text (keeps leading zeros) and add the CSV line number."""
    if not path.exists():
        raise Stop(EXIT_ERROR, f"CSV not found: {path}")
    df = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    df.columns = [str(c).strip() for c in df.columns]
    for c in df.columns:
        df[c] = df[c].astype(str).str.strip()
    df.insert(0, "csv_line", np.arange(len(df)) + 2)  # header is line 1
    return df


def apply_column_mapping(df: pd.DataFrame, pairs: list[str]) -> dict[str, str]:
    """Rename CSV columns to the names evaluate.py expects (--column record_id=fpath). Returns {expected: original}.

    The CSV file itself is never changed, so the run record's fingerprint is the original file's.
    """
    mapping: dict[str, str] = {}
    for item in pairs:
        target, sep, source = (s.strip() for s in item.partition("="))
        if not sep or not target or not source:
            raise Stop(EXIT_ERROR, f"--column needs NAME=CSV_COLUMN, for example --column true=TRUE (got '{item}').")
        if source not in df.columns:
            raise Stop(EXIT_MISSING_COLUMN, MISSING_COLUMN_MSG.format(col=source))
        if target != source and target in df.columns:
            raise Stop(EXIT_NEEDS_INPUT, f"NEEDS INPUT: the CSV has a column named '{target}' as well as '{source}'. "
                                         f"Ask which one holds {target}, then map only that one.")
        mapping[target] = source
    if len(set(mapping.values())) != len(mapping):
        raise Stop(EXIT_NEEDS_INPUT, "NEEDS INPUT: one CSV column is mapped to two names. Ask which name it is.")
    df.rename(columns={s: t for t, s in mapping.items() if s != t}, inplace=True)
    for t, s in mapping.items():
        if s != t:
            log.info(f"Column mapping: {t} <- {s}")
    return mapping


def check_columns(df: pd.DataFrame, task: str) -> list[str]:
    """Return the required columns that are absent."""
    return [c for c in REQUIRED_COLUMNS[task] if c not in df.columns]


def add_issue(issues: list[dict], line: int, column: str, issue: str, detail: str = "") -> None:
    """Append one validation problem (identified by CSV line, never by identifier)."""
    issues.append({"csv_line": int(line), "column": column, "issue": issue, "detail": detail})


def validate_record_ids(df: pd.DataFrame, issues: list[dict]) -> None:
    """record_id must be present and unique on every row."""
    counts = df["record_id"].value_counts()
    for line, rid in zip(df["csv_line"], df["record_id"]):
        if rid == "":
            add_issue(issues, line, "record_id", "empty identifier")
        elif counts[rid] > 1:
            add_issue(issues, line, "record_id", "duplicate identifier",
                      f"this identifier appears on {counts[rid]} rows")


def parse_visit_ids(ids: pd.Series) -> tuple[list, list]:
    """Split '<participant>_<weeks>+<days>' identifiers; None where the format fails."""
    pids, ga_days = [], []
    for rid in ids:
        m = VISIT_ID_PATTERN.match(rid)
        pids.append(m.group("pid") if m else None)
        ga_days.append(int(m.group("weeks")) * 7 + int(m.group("days")) if m else None)
    return pids, ga_days


def resolve_path(value: str, csv_dir: Path) -> Path:
    """Resolve a relative file path from the CSV directory."""
    p = Path(value).expanduser()
    return p if p.is_absolute() else csv_dir / p


def to_number(series: pd.Series) -> np.ndarray:
    """Convert text to float; anything non-numeric or non-finite becomes NaN."""
    x = pd.to_numeric(series, errors="coerce").to_numpy(dtype=float, copy=True)
    x[~np.isfinite(x)] = np.nan
    return x


def derive_participants(df: pd.DataFrame, args, task: str, issues: list[dict]) -> pd.Series:
    """Return the participant key per row according to the confirmed linkage."""
    if task == "classification" and args.mode == "standard":
        return df["record_id"]
    visit = (task == "classification" and args.mode == "fgr") or args.id_format == "visit"
    if visit:
        pids, _ = parse_visit_ids(df["record_id"])
        for line, pid in zip(df["csv_line"], pids):
            if pid is None:
                add_issue(issues, line, "record_id", "invalid visit identifier",
                          "expected <participant>_<weeks>+<days>, e.g. 001_32+5 (days 0-6)")
        return pd.Series([p if p is not None else "" for p in pids], index=df.index)
    if args.participant_col:
        if args.participant_col not in df.columns:
            raise Stop(EXIT_MISSING_COLUMN, MISSING_COLUMN_MSG.format(col=args.participant_col))
        for line, v in zip(df["csv_line"], df[args.participant_col]):
            if v == "":
                add_issue(issues, line, args.participant_col, "empty participant link")
        return df[args.participant_col]
    if task in ("detection", "segmentation"):
        extra = [c for c in df.columns if c not in ("csv_line",)]
        raise Stop(EXIT_NEEDS_INPUT,
                   "NEEDS INPUT: do the rows identify people or files? Ask which column links rows to "
                   f"participants, then pass --participant-col <column> (use record_id if each record_id "
                   f"is one participant) or --id-format visit. Columns available: {extra}")
    return df["record_id"]


# ---------- 4.2 Cohort confirmation pop-up ----------
def _osascript(script: str) -> tuple[int, str]:
    """Run one AppleScript line; returns (return code, stdout)."""
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=3600)
        return r.returncode, r.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return 1, ""


def _as_quote(text: str) -> str:
    """Escape text for an AppleScript string literal."""
    return text.replace("\\", "\\\\").replace('"', '\\"')


def choose_csv_dialog() -> Path:
    """Native macOS file chooser for the predictions CSV (falls back to typed path)."""
    if platform.system() == "Darwin":
        code, out = _osascript('POSIX path of (choose file with prompt "Select the predictions CSV")')
        if code == 0 and out:
            return Path(out)
    typed = input("Path to the predictions CSV: ").strip().strip('"').strip("'")
    if not typed:
        raise Stop(EXIT_ERROR, "No CSV selected.")
    return Path(typed).expanduser()


def _tk_confirm(headline: str, body: str) -> bool | None:
    """Tk fallback pop-up; returns None when Tk is unavailable."""
    try:
        import tkinter as tk  # optional: only used when the native macOS dialog is unavailable
    except ImportError:
        return None
    try:
        root = tk.Tk()
    except tk.TclError:
        return None
    result = {"proceed": False}
    root.title("Confirm cohort")
    tk.Label(root, text=headline, font=("Helvetica", 16, "bold"), padx=24, pady=12).pack()
    tk.Label(root, text=body, justify="left", padx=24).pack()
    row = tk.Frame(root, pady=12)
    row.pack()

    def close(value: bool) -> None:
        result["proceed"] = value
        root.destroy()

    tk.Button(row, text="Retry", width=10, command=lambda: close(False)).pack(side="left", padx=8)
    tk.Button(row, text="Proceed", width=10, command=lambda: close(True)).pack(side="left", padx=8)
    root.mainloop()
    return result["proceed"]


def confirm_cohort(headline: str, body: str, how: str) -> bool:
    """Show the counts with Proceed / Retry. True = Proceed, False = Retry."""
    if how == "yes":  # synthetic self-tests only
        log.info("Cohort confirmation skipped (--confirm yes; for synthetic verification only).")
        return True
    if how == "popup":
        if platform.system() == "Darwin":
            script = (f'display alert "{_as_quote(headline)}" message "{_as_quote(body)}" '
                      'buttons {"Retry", "Proceed"} default button "Proceed"')
            code, out = _osascript(script)
            if code == 0 and "button returned:" in out:
                return out.endswith("Proceed")
        answer = _tk_confirm(headline, body)
        if answer is not None:
            return answer
        log.info("No pop-up available on this system; asking in the terminal instead.")
    print(f"\n{headline}\n{body}\n")
    reply = input("Type P to Proceed or R to Retry: ").strip().lower()
    return reply.startswith("p")


# ---------- 4.3 Bootstrap ----------
def cluster_bootstrap(codes: np.ndarray, stat_fn, n_boot: int, rng: np.random.Generator,
                      desc: str) -> np.ndarray:
    """Resample participants with replacement, carrying all their rows together.

    stat_fn(row_idx, cluster_ids) -> 1-D float array (NaN where undefined).
    """
    n_p = int(codes.max()) + 1
    order = np.argsort(codes, kind="stable")
    sorted_codes = codes[order]
    starts = np.searchsorted(sorted_codes, np.arange(n_p), side="left")
    ends = np.searchsorted(sorted_codes, np.arange(n_p), side="right")
    sizes = ends - starts
    single = len(codes) == n_p
    out, t0 = None, time.time()
    for b in tqdm(range(n_boot), desc=desc, leave=False):
        s = rng.integers(0, n_p, n_p)
        if single:
            idx, clusters = order[starts[s]], np.arange(n_p)
        else:
            idx = np.concatenate([order[starts[i]:ends[i]] for i in s])
            clusters = np.repeat(np.arange(n_p), sizes[s])
        v = np.asarray(stat_fn(idx, clusters), dtype=float)
        if out is None:
            out = np.full((n_boot, len(v)), np.nan)
        out[b] = v
        if b == 19 and n_boot > 20:
            remaining = (time.time() - t0) / 20 * (n_boot - 20)
            finish = datetime.now() + timedelta(seconds=remaining)
            log.info(f"Estimated finish of bootstrap: {finish:%H:%M:%S} (in ~{remaining:.0f} s)")
    return out


def percentile_ci(col: np.ndarray) -> tuple[float, float, int]:
    """Percentile interval from the replicates where the statistic was defined."""
    ok = col[np.isfinite(col)]
    if len(ok) == 0:
        return np.nan, np.nan, 0
    a = (1 - CI_LEVEL) / 2 * 100
    lo, hi = np.percentile(ok, [a, 100 - a])
    return float(lo), float(hi), int(len(ok))


def fmt_value(v, unit: str = "") -> str:
    """A value as reported: 2 decimals with halves rounded up (0.625 -> 0.63), whole numbers for
    counts, a true minus sign for negatives, NA when undefined."""
    if v is None or not np.isfinite(float(v)):
        return "NA"
    step = Decimal(1) if unit in COUNT_UNITS else Decimal(10) ** -REPORT_DECIMALS
    s = format(Decimal(repr(float(v))).quantize(step, rounding=ROUND_HALF_UP), "f")
    if s.startswith("-") and not s.strip("-0."):
        s = s[1:]  # -0.00 -> 0.00
    return s.replace("-", "−")


def fmt_ci(lo, hi, unit: str = "") -> str:
    """A 95% CI as reported: [lower - upper], each rounded like fmt_value."""
    if lo is None or hi is None or not (np.isfinite(float(lo)) and np.isfinite(float(hi))):
        return "NA"
    return f"[{fmt_value(lo, unit)} - {fmt_value(hi, unit)}]"


def metric_row(metric: str, estimate, boot_col=None, unit: str = "", n=None, note: str = "",
               group: str = "overall", n_boot: int = N_BOOT) -> dict:
    """One row of the metrics sheet; undefined values stay NaN and are written as NA.

    estimate / ci_lower / ci_upper keep full precision; estimate_reported and ci_95_reported are the
    rounded strings used in the report and console ("3.71", "[3.15 - 4.27]").
    """
    row = {"group": group, "metric": metric, "estimate": estimate, "ci_lower": np.nan,
           "ci_upper": np.nan, "ci_level": np.nan, "n_boot_requested": np.nan,
           "n_boot_contributed": np.nan, "unit": unit, "n": n, "note": note}
    undefined = isinstance(estimate, float) and not np.isfinite(estimate)
    if undefined and not note:
        row["note"] = "NA — undefined for this data"
    if boot_col is not None:
        lo, hi, k = percentile_ci(boot_col)
        row.update(ci_level=CI_LEVEL, n_boot_requested=n_boot, n_boot_contributed=k)
        if not undefined:
            row.update(ci_lower=lo, ci_upper=hi)
            if k < n_boot:
                extra = f"undefined in {n_boot - k} of {n_boot} bootstrap replicates"
                row["note"] = f"{row['note']}; {extra}" if row["note"] else extra
    row["estimate_reported"] = fmt_value(estimate, unit)
    row["ci_95_reported"] = fmt_ci(row["ci_lower"], row["ci_upper"], unit) if boot_col is not None else ""
    return row


def write_metrics(rows: list[dict], name: str) -> pd.DataFrame:
    """Save a metrics table with NA for undefined values."""
    df = pd.DataFrame(rows)
    df.to_csv(saved(DIRS["sheets"] / f"{name}_{FILE_TAG}.csv"), index=False, na_rep="NA")
    return df


# ---------- 4.4 Classification ----------
def confusion_counts(y: np.ndarray, yhat: np.ndarray) -> tuple[int, int, int, int]:
    """TP, FP, FN, TN from 0/1 arrays."""
    tp = int(np.sum((y == 1) & (yhat == 1)))
    fp = int(np.sum((y == 0) & (yhat == 1)))
    fn = int(np.sum((y == 1) & (yhat == 0)))
    tn = int(np.sum((y == 0) & (yhat == 0)))
    return tp, fp, fn, tn


def safe_div(a: float, b: float) -> float:
    """a / b, NaN when the denominator is zero."""
    return float(a) / float(b) if b else np.nan


def auroc(y: np.ndarray, p: np.ndarray) -> float:
    """Area under the ROC curve (Mann-Whitney form, ties get half credit)."""
    n1 = int(y.sum())
    n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return np.nan
    r = rankdata(p)
    return float((r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def average_precision(y: np.ndarray, p: np.ndarray) -> float:
    """AUPRC by the average-precision convention: sum of (R_k - R_k-1) * P_k."""
    n1 = int(y.sum())
    if n1 == 0:
        return np.nan
    order = np.argsort(-p, kind="stable")
    ps, ys = p[order], y[order]
    last = np.r_[np.where(np.diff(ps) != 0)[0], len(ps) - 1]  # last index of each distinct score
    tps = np.cumsum(ys)[last]
    precision = tps / (last + 1)
    recall = tps / n1
    return float(np.sum(np.diff(np.r_[0.0, recall]) * precision))


def curve_points(y: np.ndarray, p: np.ndarray) -> pd.DataFrame:
    """Cumulative TP / FP at each distinct score, highest score first (treat if p >= threshold).

    The ROC curve joins these points with straight lines (its trapezoid area equals AUROC, ties
    included); the PR curve is drawn as steps (its area equals average precision).
    """
    order = np.argsort(-p, kind="stable")
    ps, ys = p[order], y[order]
    last = np.r_[np.where(np.diff(ps) != 0)[0], len(ps) - 1]
    tps = np.cumsum(ys)[last]
    fps = (last + 1) - tps
    return pd.DataFrame({"threshold": ps[last], "tp": tps, "fp": fps})


def roc_table(y: np.ndarray, p: np.ndarray) -> pd.DataFrame:
    """ROC points from (0, 0) to (1, 1); the first row has no threshold (nothing treated)."""
    pts = curve_points(y, p)
    n1, n0 = int(y.sum()), int(len(y) - y.sum())
    return pd.DataFrame({"threshold": np.r_[np.nan, pts["threshold"]],
                         "false_positive_rate": np.r_[0.0, pts["fp"] / n0],
                         "true_positive_rate": np.r_[0.0, pts["tp"] / n1]})


def pr_table(y: np.ndarray, p: np.ndarray) -> pd.DataFrame:
    """Precision and recall at each distinct threshold, recall increasing."""
    pts = curve_points(y, p)
    return pd.DataFrame({"threshold": pts["threshold"], "recall": pts["tp"] / int(y.sum()),
                         "precision": pts["tp"] / (pts["tp"] + pts["fp"])})


def net_benefit(y: np.ndarray, p: np.ndarray, grid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Net benefit of the model (treat if p >= pt) and of treat-all, on a threshold grid."""
    n = len(y)
    order = np.argsort(p, kind="stable")
    sp = p[order]
    cum_pos = np.r_[0, np.cumsum(y[order])]
    k = np.searchsorted(sp, grid, side="left")  # rows with p < pt
    tp = cum_pos[-1] - cum_pos[k]
    fp = (n - k) - tp
    w = grid / (1 - grid)
    prev = cum_pos[-1] / n
    return tp / n - fp / n * w, prev - (1 - prev) * w


def quantile_bins(x: np.ndarray, n_bins: int) -> tuple[np.ndarray, np.ndarray]:
    """Fixed quantile-bin edges and the bin index of every value."""
    edges = np.unique(np.quantile(x, np.linspace(0, 1, n_bins + 1)))
    if len(edges) < 2:
        edges = np.array([edges[0], edges[0]])
    idx = np.clip(np.searchsorted(edges, x, side="right") - 1, 0, len(edges) - 2)
    return edges, idx


def binned_means(values: np.ndarray, bin_idx: np.ndarray, n_bins: int) -> np.ndarray:
    """Mean of values per bin (NaN for empty bins)."""
    counts = np.bincount(bin_idx, minlength=n_bins)
    sums = np.bincount(bin_idx, weights=values, minlength=n_bins)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(counts > 0, sums / np.maximum(counts, 1), np.nan)


def implied_threshold(yhat: np.ndarray, p: np.ndarray) -> dict:
    """Check that pred_label is consistent with pred_prob being P(positive)."""
    pos, neg = p[yhat == 1], p[yhat == 0]
    if len(pos) == 0 or len(neg) == 0:
        return {"status": "NA", "note": "pred_label contains a single class; threshold not identifiable"}
    if pos.min() > neg.max():
        return {"status": "consistent", "threshold_lower_exclusive": float(neg.max()),
                "threshold_upper_inclusive": float(pos.min()),
                "note": "pred_label equals a single cut of pred_prob within this interval"}
    discordant = int(np.sum(pos < neg.max()) + np.sum(neg > pos.min()))
    out = {"status": "no single threshold", "n_rows_in_overlap": discordant,
           "note": "pred_label is not a single cut of pred_prob; operating-point metrics use pred_label as given"}
    if pos.mean() < neg.mean():
        out["status"] = "WARNING direction"
        out["note"] = ("mean pred_prob is LOWER among predicted-positive rows; pred_prob may be the "
                       "probability of the other class. Re-confirm before interpreting.")
    return out


CLS_SCALARS = ["TP", "FP", "FN", "TN", "AUROC", "AUPRC", "PPV", "NPV", "sensitivity", "specificity",
               "screen_positive_rate", "F1"]


def classification_scalars(y: np.ndarray, yhat: np.ndarray, p: np.ndarray) -> np.ndarray:
    """All scalar classification metrics in CLS_SCALARS order."""
    tp, fp, fn, tn = confusion_counts(y, yhat)
    return np.array([tp, fp, fn, tn, auroc(y, p), average_precision(y, p),
                     safe_div(tp, tp + fp), safe_div(tn, tn + fn), safe_div(tp, tp + fn),
                     safe_div(tn, tn + fp), safe_div(tp + fp, len(y)),
                     safe_div(2 * tp, 2 * tp + fp + fn)], dtype=float)


def classification_na_reasons(tp: int, fp: int, fn: int, tn: int) -> dict[str, str]:
    """Why a metric is undefined, when it is."""
    r = {}
    if tp + fn == 0:
        r["sensitivity"] = r["AUPRC"] = "NA — no reference-positive observations"
    if tn + fp == 0:
        r["specificity"] = "NA — no reference-negative observations"
    if tp + fn == 0 or tn + fp == 0:
        r["AUROC"] = "NA — needs both reference classes"
    if tp + fp == 0:
        r["PPV"] = "NA — no predicted-positive observations"
    if tn + fn == 0:
        r["NPV"] = "NA — no predicted-negative observations"
    if 2 * tp + fp + fn == 0:
        r["F1"] = "NA — no true positives, false positives or false negatives"
    return r


def validate_classification(df: pd.DataFrame, args, issues: list[dict]) -> dict:
    """Check labels and probabilities; return the label mapping."""
    labels = sorted((set(df["true_label"]) | set(df["pred_label"])) - {""})
    if not args.positive_label:
        raise Stop(EXIT_NEEDS_INPUT, f"NEEDS INPUT: ask which label is positive, then pass "
                                     f"--positive-label. Labels found: {labels}")
    if args.positive_label not in labels:
        raise Stop(EXIT_NEEDS_INPUT, f"NEEDS INPUT: positive label '{args.positive_label}' does not occur. "
                                     f"Labels found: {labels}")
    if not args.prob_confirmed:
        raise Stop(EXIT_NEEDS_INPUT, "NEEDS INPUT: confirm with the user that pred_prob is the probability "
                                     f"of '{args.positive_label}', then pass --prob-confirmed.")
    others = [v for v in labels if v != args.positive_label]
    negative = args.negative_label
    if negative is None:
        if len(others) > 1:
            raise Stop(EXIT_NEEDS_INPUT, f"NEEDS INPUT: classification is binary but labels {labels} were "
                                         "found. Ask which label is negative and pass --negative-label; rows "
                                         "with any other label are then reported as invalid.")
        negative = others[0] if others else None
    allowed = {args.positive_label, negative}
    for col in ("true_label", "pred_label"):
        for line, v in zip(df["csv_line"], df[col]):
            if v == "":
                add_issue(issues, line, col, "empty label")
            elif v not in allowed:
                add_issue(issues, line, col, "label outside the binary mapping", f"value '{v}'")
    prob = to_number(df["pred_prob"])
    for line, raw, v in zip(df["csv_line"], df["pred_prob"], prob):
        if np.isnan(v):
            add_issue(issues, line, "pred_prob", "not a number", f"value '{raw}'")
        elif v < 0 or v > 1:
            add_issue(issues, line, "pred_prob", "probability outside [0, 1]", f"value '{raw}'")
    return {"positive": args.positive_label, "negative": negative,
            "encoding": {args.positive_label: 1, str(negative): 0}}


def plot_confusion(tp: int, fp: int, fn: int, tn: int, cis: dict, mapping: dict, unit: str) -> None:
    """2x2 confusion matrix with bootstrap intervals in each cell."""
    fig, ax = plt.subplots(figsize=(5.2, 4.6))
    cells = np.array([[tp, fn], [fp, tn]])
    names = [["TP", "FN"], ["FP", "TN"]]
    ax.imshow(cells, cmap="Blues", vmin=0, vmax=max(cells.max(), 1) * 1.6)
    for i in range(2):
        for j in range(2):
            lo, hi = cis[names[i][j]]
            ax.text(j, i, f"{names[i][j]} = {cells[i, j]}\n95% CI {fmt_ci(lo, hi, 'count')}",
                    ha="center", va="center", fontsize=10)
    ax.set_xticks([0, 1], [f"Predicted {mapping['positive']}", f"Predicted {mapping['negative']}"])
    ax.set_yticks([0, 1], [f"Reference {mapping['positive']}", f"Reference {mapping['negative']}"],
                  rotation=90, va="center")
    ax.grid(False)
    title = plot_title(f"Confusion Matrix ({unit})")
    ax.set_title(title, fontweight="bold")
    save_figure(fig, "confusion_matrix", title)


def plot_calibration(x: np.ndarray, y: np.ndarray, lo: np.ndarray, hi: np.ndarray, xlabel: str,
                     ylabel: str, n_bins: int, name: str, unit_range: tuple | None) -> None:
    """Binned calibration plot with pointwise bootstrap intervals and an identity line."""
    fig, ax = plt.subplots(figsize=(6.4, 6.2))
    lim = unit_range or (np.nanmin(np.r_[x, y, lo]), np.nanmax(np.r_[x, y, hi]))
    pad = 0 if unit_range else 0.04 * (lim[1] - lim[0] or 1)
    lim = (lim[0] - pad, lim[1] + pad)
    ax.plot(lim, lim, ls="--", color=C_LIMIT, lw=1.6, label="Identity (perfect calibration)")
    ax.errorbar(x, y, yerr=[np.clip(y - lo, 0, None), np.clip(hi - y, 0, None)], fmt="o-",
                color=C_POINT, capsize=3, lw=1.6, ms=6,
                label=f"Mean in each of {n_bins} quantile bins, pointwise 95% bootstrap CI")
    ax.set_xlim(lim)
    ax.set_ylim(lim)
    ax.set_aspect("equal")
    ax.set_xlabel(xlabel, fontweight="bold")
    ax.set_ylabel(ylabel, fontweight="bold")
    title = plot_title("Calibration Plot")
    ax.set_title(title, fontweight="bold")
    ax.legend(loc="upper left", fontsize=8, frameon=True)
    save_figure(fig, name, title)


def plot_dca(curve: pd.DataFrame) -> None:
    """Decision curve: model vs treat-all vs treat-none, pointwise 95% bootstrap bands."""
    fig, ax = plt.subplots(figsize=(7.2, 5.2))
    g = curve["threshold_probability"]
    ax.fill_between(g, curve["model_ci_lower"], curve["model_ci_upper"], color=C_POINT, alpha=0.2, lw=0)
    ax.plot(g, curve["net_benefit_model"], color=C_POINT, lw=2, label="Model (band: pointwise 95% bootstrap CI)")
    ax.fill_between(g, curve["treat_all_ci_lower"], curve["treat_all_ci_upper"], color=C_ALT, alpha=0.2, lw=0)
    ax.plot(g, curve["net_benefit_treat_all"], color=C_ALT, lw=1.6, ls="--",
            label="Treat all (band: pointwise 95% bootstrap CI)")
    ax.axhline(0, color=C_LIMIT, lw=1.4, ls=":", label="Treat none")
    top = np.nanmax(np.r_[curve["model_ci_upper"], curve["treat_all_ci_upper"], 0.01])
    ax.set_ylim(-0.25 * top, 1.1 * top)
    ax.set_xlabel("Threshold probability", fontweight="bold")
    ax.set_ylabel("Net benefit", fontweight="bold")
    title = plot_title("Decision Curve Analysis")
    ax.set_title(title, fontweight="bold")
    ax.legend(frameon=True, fontsize=8, loc="upper right")
    save_figure(fig, "decision_curve", title)


def plot_roc(roc: pd.DataFrame, area: dict, op: tuple[float, float], unit: str) -> None:
    """ROC curve with the chance diagonal, AUROC and its CI, and the pred_label operating point."""
    fig, ax = plt.subplots(figsize=(6.6, 6.4))
    ax.plot([0, 1], [0, 1], ls="--", color=C_LIMIT, lw=1.6, label="Chance (AUROC 0.50)")
    ax.plot(roc["false_positive_rate"], roc["true_positive_rate"], color=C_POINT, lw=2.4,
            label=f"Model, AUROC {area['est']} {area['ci']}")
    ax.plot(*op, marker="o", ms=11, mfc="white", mec="black", mew=2.2, ls="none",
            label="Operating point of pred_label")
    ax.set_xlim(-0.01, 1.01)
    ax.set_ylim(-0.01, 1.01)
    ax.set_aspect("equal")
    ax.set_xlabel("1 − specificity (false-positive rate)", fontweight="bold")
    ax.set_ylabel("Sensitivity (true-positive rate)", fontweight="bold")
    title = plot_title("ROC Curve")
    ax.set_title(title, fontweight="bold")
    ax.legend(loc="lower right", frameon=True, facecolor="white", framealpha=0.9, fontsize=9,
              title=f"Scored per {unit}; CI is 95% bootstrap", title_fontsize=8)
    save_figure(fig, "roc_curve", title)


def plot_pr(pr: pd.DataFrame, area: dict, op: tuple[float, float], prevalence: float, unit: str) -> None:
    """Precision-recall curve drawn as steps (area = average precision), chance line at prevalence."""
    fig, ax = plt.subplots(figsize=(6.6, 6.4))
    ax.axhline(prevalence, ls="--", color=C_LIMIT, lw=1.6, label=f"Chance (positive fraction {fmt_value(prevalence)})")
    ax.step(np.r_[0.0, pr["recall"]], np.r_[pr["precision"].iloc[0], pr["precision"]], where="pre",
            color=C_POINT, lw=2.4, label=f"Model, AUPRC {area['est']} {area['ci']}")
    if np.isfinite(op[1]):
        ax.plot(*op, marker="o", ms=11, mfc="white", mec="black", mew=2.2, ls="none",
                label="Operating point of pred_label")
    ax.set_xlim(-0.01, 1.01)
    ax.set_ylim(-0.01, 1.01)
    ax.set_aspect("equal")
    ax.set_xlabel("Recall (sensitivity)", fontweight="bold")
    ax.set_ylabel("Precision (PPV)", fontweight="bold")
    title = plot_title("Precision-Recall Curve")
    ax.set_title(title, fontweight="bold")
    ax.legend(loc="lower left", frameon=True, facecolor="white", framealpha=0.9, fontsize=9,
              title=f"Scored per {unit}; CI is 95% bootstrap", title_fontsize=8)
    save_figure(fig, "pr_curve", title)


def evaluate_classification(df: pd.DataFrame, codes: np.ndarray, mapping: dict, args,
                            rng: np.random.Generator, meta: dict) -> pd.DataFrame:
    """Confusion matrix, discrimination and operating-point metrics; Standard adds calibration + DCA."""
    standard = args.mode == "standard"
    y = (df["true_label"] == mapping["positive"]).to_numpy().astype(int)
    yhat = (df["pred_label"] == mapping["positive"]).to_numpy().astype(int)
    p = to_number(df["pred_prob"])
    n = len(y)
    unit = "participants" if standard else "visits"
    names = [m for m in CLS_SCALARS if standard or m != "F1"]
    keep = [CLS_SCALARS.index(m) for m in names]

    meta["thresholds"]["pred_label_vs_pred_prob"] = implied_threshold(yhat, p)
    log.info(f"pred_label vs pred_prob check: {meta['thresholds']['pred_label_vs_pred_prob']['note']}")

    edges, bin_idx, grid = None, None, None
    if standard:
        edges, bin_idx = quantile_bins(p, CALIB_BINS)
        n_bins = len(edges) - 1
        grid = np.round(np.arange(args.dca_min, args.dca_max + DCA_STEP / 2, DCA_STEP), 6)
        meta["thresholds"].update(dca_threshold_range=[args.dca_min, args.dca_max], dca_step=DCA_STEP,
                                  calibration_bin_edges=[float(e) for e in edges])

    def stats(idx: np.ndarray, _clusters: np.ndarray) -> np.ndarray:
        yy, hh, pp = y[idx], yhat[idx], p[idx]
        v = [classification_scalars(yy, hh, pp)[keep]]
        if standard:
            v.append(binned_means(yy.astype(float), bin_idx[idx], n_bins))
            v.extend(net_benefit(yy, pp, grid))
        return np.concatenate(v)

    est = stats(np.arange(n), None)
    boot = cluster_bootstrap(codes, stats, args.n_boot, rng, "Bootstrap (participants)")
    tp, fp, fn, tn = (int(v) for v in classification_scalars(y, yhat, p)[:4])
    reasons = classification_na_reasons(tp, fp, fn, tn)

    rows = []
    for j, m in enumerate(names):
        value = int(est[j]) if m in ("TP", "FP", "FN", "TN") else float(est[j])
        note = reasons.get(m, "")
        if m in ("TP", "FP", "FN", "TN") and not standard:
            note = "count of visits; bootstrap replicates contain varying numbers of visits"
        rows.append(metric_row(m, value, boot[:, j], unit="count" if m in ("TP", "FP", "FN", "TN") else "proportion",
                               n=n, note=note, n_boot=args.n_boot))
    metrics = write_metrics(rows, "metrics")

    cm = metrics[metrics["metric"].isin(["TP", "FP", "FN", "TN"])].copy()
    cm.insert(0, "predicted", [mapping["positive"], mapping["positive"], str(mapping["negative"]), str(mapping["negative"])])
    cm.insert(0, "reference", [mapping["positive"], str(mapping["negative"]), mapping["positive"], str(mapping["negative"])])
    cm.drop(columns=["group"]).to_csv(saved(DIRS["sheets"] / f"confusion_matrix_{FILE_TAG}.csv"),
                                      index=False, na_rep="NA")
    cis = {r["metric"]: (r["ci_lower"], r["ci_upper"]) for r in rows[:4]}
    plot_confusion(tp, fp, fn, tn, cis, mapping, unit)

    # ROC and precision-recall curves (both modes); points from the same thresholds as AUROC / AUPRC
    by_name = {r["metric"]: r for r in rows}
    unit_one = "participant" if standard else "visit"
    n_pos = int(y.sum())
    if 0 < n_pos < n:
        roc = roc_table(y, p)
        roc.to_csv(saved(DIRS["sheets"] / f"roc_curve_{FILE_TAG}.csv"), index=False, na_rep="NA")
        auc = by_name["AUROC"]
        plot_roc(roc, {"est": auc["estimate_reported"], "ci": auc["ci_95_reported"]},
                 (safe_div(fp, fp + tn), safe_div(tp, tp + fn)), unit_one)
    else:
        log.info("ROC curve not produced: it needs both reference classes.")
    if n_pos > 0:
        pr = pr_table(y, p)
        pr.to_csv(saved(DIRS["sheets"] / f"pr_curve_{FILE_TAG}.csv"), index=False, na_rep="NA")
        ap = by_name["AUPRC"]
        plot_pr(pr, {"est": ap["estimate_reported"], "ci": ap["ci_95_reported"]},
                (safe_div(tp, tp + fn), safe_div(tp, tp + fp)), n_pos / n, unit_one)
    else:
        log.info("Precision-recall curve not produced: there are no reference-positive observations.")

    if standard:
        k = len(names)
        counts = np.bincount(bin_idx, minlength=n_bins)
        ci = [percentile_ci(boot[:, k + b]) for b in range(n_bins)]
        calib = pd.DataFrame({
            "bin": np.arange(1, n_bins + 1), "bin_lower": edges[:-1], "bin_upper": edges[1:], "n": counts,
            "mean_predicted_probability": binned_means(p, bin_idx, n_bins),
            "observed_event_frequency": est[k:k + n_bins],
            "ci_lower": [c[0] for c in ci], "ci_upper": [c[1] for c in ci],
            "n_boot_contributed": [c[2] for c in ci]})
        calib.to_csv(saved(DIRS["sheets"] / f"calibration_curve_{FILE_TAG}.csv"), index=False, na_rep="NA")
        plot_calibration(calib["mean_predicted_probability"].to_numpy(),
                         calib["observed_event_frequency"].to_numpy(), calib["ci_lower"].to_numpy(),
                         calib["ci_upper"].to_numpy(), "Predicted probability", "Observed event frequency",
                         n_bins, "calibration_plot", (0, 1))
        g0 = k + n_bins
        ng = len(grid)
        ci_m = [percentile_ci(boot[:, g0 + i]) for i in range(ng)]
        ci_a = [percentile_ci(boot[:, g0 + ng + i]) for i in range(ng)]
        curve = pd.DataFrame({
            "threshold_probability": grid, "net_benefit_model": est[g0:g0 + ng],
            "model_ci_lower": [c[0] for c in ci_m], "model_ci_upper": [c[1] for c in ci_m],
            "net_benefit_treat_all": est[g0 + ng:g0 + 2 * ng],
            "treat_all_ci_lower": [c[0] for c in ci_a], "treat_all_ci_upper": [c[1] for c in ci_a],
            "net_benefit_treat_none": 0.0, "n_boot_contributed": [c[2] for c in ci_m]})
        curve.to_csv(saved(DIRS["sheets"] / f"decision_curve_{FILE_TAG}.csv"), index=False, na_rep="NA")
        plot_dca(curve)
    return metrics


# ---------- 4.5 Regression ----------
def bland_altman_stats(d: np.ndarray, clusters: np.ndarray, method: str) -> np.ndarray:
    """Bias, SD of differences, lower and upper 95% limits of agreement.

    method 'single'            : one pair per participant.
    method 'participant-mean'  : average the differences within participant first.
    method 'all-pairs-anova'   : all pairs; SD combines within- and between-participant variance
                                 (Bland & Altman 2007, true value varies).
    """
    nan4 = np.full(4, np.nan)
    if method == "participant-mean":
        d = np.bincount(clusters, weights=d) / np.bincount(clusters)
        method = "single"
    if method == "single":
        if len(d) < 2:
            return nan4
        bias, sd = float(d.mean()), float(d.std(ddof=1))
    else:
        m = np.bincount(clusters).astype(float)
        n_p, n_all = len(m), len(d)
        if n_p < 2 or n_all <= n_p:
            return nan4
        means = np.bincount(clusters, weights=d) / m
        bias = float(d.mean())
        ms_within = float(((d - means[clusters]) ** 2).sum() / (n_all - n_p))
        ms_between = float((m * (means - bias) ** 2).sum() / (n_p - 1))
        m0 = (n_all ** 2 - (m ** 2).sum()) / ((n_p - 1) * n_all)
        sd = float(np.sqrt(ms_within + max((ms_between - ms_within) / m0, 0.0)))
    return np.array([bias, sd, bias - LOA_Z * sd, bias + LOA_Z * sd])


def plot_bland_altman(mean_xy: np.ndarray, d: np.ndarray, ba: np.ndarray, unit: str, method_note: str) -> None:
    """Bland-Altman plot in the reference style: mean difference (red dashed) and ±1.96 SD limits (grey dashed)."""
    fig, ax = plt.subplots(figsize=(8.4, 6.2))
    ax.scatter(mean_xy, d, s=60 if len(d) <= 1000 else 36, color=C_POINT, alpha=0.5, lw=0)
    bias, _, lo, hi = ba
    ax.axhline(bias, color=C_MEAN, lw=2.2, ls="--", label=f"Mean diff = {fmt_value(bias)}")
    ax.axhline(hi, color=C_LIMIT, lw=1.8, ls="--", label=f"+1.96 SD = {fmt_value(hi)}")
    ax.axhline(lo, color=C_LIMIT, lw=1.8, ls="--", label=f"-1.96 SD = {fmt_value(lo)}")
    ax.set_xlabel(f"Mean of True & Predicted ({unit})", fontweight="bold")
    ax.set_ylabel(f"Difference (Pred - True) in {unit}", fontweight="bold")
    title = plot_title("Bland-Altman Plot")
    ax.set_title(title, fontweight="bold")
    ax.legend(loc="upper right", frameon=True, facecolor="white", framealpha=0.9)
    if method_note:
        fig.text(0.01, 0.005, method_note, fontsize=7, color=C_GREY, ha="left", va="bottom")
    save_figure(fig, "bland_altman", title)


def plot_true_vs_pred(t: np.ndarray, p: np.ndarray, unit: str, meta: dict) -> None:
    """Predicted against ground truth with a least-squares line and marginal histograms (with KDE)."""
    fig = plt.figure(figsize=(8.4, 8.4))
    gs = fig.add_gridspec(2, 2, width_ratios=(5, 1), height_ratios=(1, 5), wspace=0.04, hspace=0.04)
    ax = fig.add_subplot(gs[1, 0])
    ax_top = fig.add_subplot(gs[0, 0], sharex=ax)
    ax_right = fig.add_subplot(gs[1, 1], sharey=ax)
    ax.scatter(t, p, s=40 if len(t) > 1000 else 60, color=C_POINT, alpha=0.7, lw=0)
    lo, hi = float(np.min(np.r_[t, p])), float(np.max(np.r_[t, p]))
    pad = 0.04 * (hi - lo or 1)
    if len(t) >= 2 and np.ptp(t) > 0:
        slope, intercept = np.polyfit(t, p, 1)
        xs = np.array([t.min(), t.max()])
        ax.plot(xs, intercept + slope * xs, color=C_POINT, lw=3, label="Least-squares line")
        ax.legend(loc="lower right", frameon=True, facecolor="white", framealpha=0.9, fontsize=9)
        meta["true_vs_pred_least_squares_line"] = {"slope": float(slope), "intercept": float(intercept),
                                                   "unit": unit, "note": "drawn on the figure only; not a metric"}
    edges = np.histogram_bin_edges(np.r_[t, p], bins=20)
    width = edges[1] - edges[0]
    grid = np.linspace(lo - pad, hi + pad, 300)
    for values, axis, vertical in ((t, ax_top, True), (p, ax_right, False)):
        if vertical:
            axis.hist(values, bins=edges, color=C_POINT, alpha=0.5, edgecolor="#333333", lw=0.8)
        else:
            axis.hist(values, bins=edges, color=C_POINT, alpha=0.5, edgecolor="#333333", lw=0.8,
                      orientation="horizontal")
        try:
            dens = gaussian_kde(values)(grid) * len(values) * width
            axis.plot(grid, dens, color=C_POINT, lw=1.8) if vertical else axis.plot(dens, grid, color=C_POINT, lw=1.8)
        except (np.linalg.LinAlgError, ValueError):
            pass  # too few distinct values for a density curve; the histogram alone is shown
    ax_top.tick_params(labelbottom=False, labelleft=False)
    ax_right.tick_params(labelleft=False, labelbottom=False)
    ax.set_xlim(lo - pad, hi + pad)
    ax.set_ylim(lo - pad, hi + pad)
    ax.set_xlabel(f"Ground Truth ({unit})", fontweight="bold")
    ax.set_ylabel(f"Predicted ({unit})", fontweight="bold")
    title = plot_title("Predicted vs Ground Truth")
    fig.suptitle(title, fontweight="bold", y=0.93)
    save_figure(fig, "true_vs_pred", title, tight=False)


def evaluate_regression(df: pd.DataFrame, codes: np.ndarray, args, rng: np.random.Generator,
                        meta: dict) -> pd.DataFrame:
    """MAE, MSE, RMSE with participant-bootstrap CIs, calibration and Bland-Altman.

    Values in weeks are converted to days (× 7) before any metric is calculated, so every estimate and CI is
    in days. Figures keep the CSV's own unit, as in the reference figures.
    """
    t_in, p_in = to_number(df["true"]), to_number(df["pred"])
    in_unit = args.unit.strip()
    weeks = in_unit.lower() in WEEK_UNITS
    factor = DAYS_PER_WEEK if weeks else 1
    unit = "days" if weeks else in_unit                    # unit of every metric, CI and sheet
    conv_note = f"converted from {in_unit} (× {DAYS_PER_WEEK}) before calculation" if weeks else ""
    meta["unit_conversion"] = {"input_unit": in_unit, "metrics_unit": unit, "factor": factor, "figures_unit": in_unit}
    meta["units"] = f"days (converted from {in_unit} × {DAYS_PER_WEEK}); figures in {in_unit}" if weeks else in_unit
    if weeks:
        log.info(f"Units: true and pred converted from {in_unit} to days (× {DAYS_PER_WEEK}); "
                 f"metrics in days, figures in {in_unit}.")
    t, p = t_in * factor, p_in * factor
    d = p - t
    n, n_p = len(d), int(codes.max()) + 1
    repeated = n > n_p
    method = args.repeated_measures if repeated else "single"
    meta["repeated_measures_analysis"] = method if repeated else "not applicable (one pair per participant)"
    edges, bin_idx = quantile_bins(p, CALIB_BINS)
    n_bins = len(edges) - 1
    meta["thresholds"]["calibration_bin_edges"] = [float(e) for e in edges]

    def stats(idx: np.ndarray, clusters: np.ndarray) -> np.ndarray:
        dd = d[idx]
        mse = float(np.mean(dd ** 2))
        head = np.array([np.mean(np.abs(dd)), mse, np.sqrt(mse)])
        return np.concatenate([head, bland_altman_stats(dd, clusters, method),
                               binned_means(t[idx], bin_idx[idx], n_bins)])

    est = stats(np.arange(n), codes)
    boot = cluster_bootstrap(codes, stats, args.n_boot, rng, "Bootstrap (participants)")
    pooled = "pooled over all pairs; participants resampled as clusters" if repeated else ""
    ba_n = n_p if method in ("single", "participant-mean") else n
    ba_note = {"single": "", "participant-mean": "differences averaged within participant first",
               "all-pairs-anova": "all pairs; SD combines within- and between-participant variance"}[method]
    loa_note = "limit of agreement (bias ± 1.96 SD), not a confidence interval; the CI columns are its bootstrap CI"
    pooled, ba_note, loa_note = ("; ".join(x for x in (s, conv_note) if x) for s in (pooled, ba_note, loa_note))
    rows = [
        metric_row("MAE", est[0], boot[:, 0], unit, n, pooled, n_boot=args.n_boot),
        metric_row("MSE", est[1], boot[:, 1], f"{unit}^2", n, pooled, n_boot=args.n_boot),
        metric_row("RMSE", est[2], boot[:, 2], unit, n, pooled, n_boot=args.n_boot),
        metric_row("mean_bias_pred_minus_true", est[3], boot[:, 3], unit, ba_n, ba_note, n_boot=args.n_boot),
        metric_row("sd_of_differences", est[4], boot[:, 4], unit, ba_n, ba_note, n_boot=args.n_boot),
        metric_row("loa_lower_95", est[5], boot[:, 5], unit, ba_n, loa_note, n_boot=args.n_boot),
        metric_row("loa_upper_95", est[6], boot[:, 6], unit, ba_n, loa_note, n_boot=args.n_boot),
    ]
    if not np.isfinite(est[3]):
        for r in rows[3:]:
            r["note"] = "NA — agreement needs at least two participants (and replicate pairs for the ANOVA method)"
    metrics = write_metrics(rows, "metrics")

    ci = [percentile_ci(boot[:, 7 + b]) for b in range(n_bins)]
    calib = pd.DataFrame({"bin": np.arange(1, n_bins + 1), "bin_lower": edges[:-1], "bin_upper": edges[1:],
                          "n": np.bincount(bin_idx, minlength=n_bins),
                          "mean_predicted": binned_means(p, bin_idx, n_bins), "mean_observed": est[7:],
                          "ci_lower": [c[0] for c in ci], "ci_upper": [c[1] for c in ci],
                          "n_boot_contributed": [c[2] for c in ci], "unit": unit})
    calib.to_csv(saved(DIRS["sheets"] / f"calibration_curve_{FILE_TAG}.csv"), index=False, na_rep="NA")
    # Figures: same numbers, shown in the CSV's own unit (÷ factor undoes the conversion for display only)
    plot_calibration(*(calib[c].to_numpy() / factor for c in ("mean_predicted", "mean_observed", "ci_lower", "ci_upper")),
                     f"Mean predicted ({in_unit})", f"Mean observed ({in_unit})", n_bins, "calibration_plot", None)
    plot_true_vs_pred(t_in, p_in, in_unit, meta)

    if np.isfinite(est[3]):
        pair_mean = (p + t) / 2
        if method == "participant-mean":
            cnt = np.bincount(codes)
            pair_mean, dd = np.bincount(codes, weights=pair_mean) / cnt, np.bincount(codes, weights=d) / cnt
        else:
            dd = d
        note = {"single": "", "participant-mean": "One point per participant (differences averaged within participant).",
                "all-pairs-anova": "All pairs; SD combines within- and between-participant variance (Bland & Altman 2007)."}[method]
        plot_bland_altman(pair_mean / factor, dd / factor, est[3:7] / factor, in_unit, note)
    else:
        log.info("Bland–Altman plot not produced: agreement statistics are NA.")
    return metrics


# ---------- 4.6 Object detection (CVAT XML) ----------
def _box_score(box: ET.Element) -> bool:
    """True when a box carries a confidence score."""
    if box.get("score") is not None or box.get("confidence") is not None:
        return True
    return any((a.get("name") or "").lower() in ("score", "confidence", "conf") for a in box.findall("attribute"))


def parse_cvat_xml(path: Path) -> dict:
    """Read frames and boxes from a CVAT XML (video tracks or per-image layout).

    Returns {'listed': set of frame numbers explicitly present,
             'frames': {frame: [(label, xtl, ytl, xbr, ybr), ...]} visible boxes only,
             'all_labelled', 'has_scores', 'n_outside', 'n_other_shapes'}.
    Raises ValueError with a reason when the file cannot be used.
    """
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as e:
        raise ValueError(f"XML parse error: {e}") from e
    out = {"listed": set(), "frames": {}, "all_labelled": True, "has_scores": False,
           "n_outside": 0, "n_other_shapes": 0}
    other = ("polygon", "polyline", "points", "cuboid", "ellipse", "mask", "skeleton")

    def handle(box: ET.Element, frame_text, label) -> None:
        try:
            frame = int(frame_text)
            xtl, ytl, xbr, ybr = (float(box.get(k)) for k in ("xtl", "ytl", "xbr", "ybr"))
        except (TypeError, ValueError) as e:
            raise ValueError("box without a valid frame number or coordinates") from e
        out["listed"].add(frame)
        if box.get("outside", "0") == "1":
            out["n_outside"] += 1
            return
        if not (np.isfinite([xtl, ytl, xbr, ybr]).all() and xbr > xtl and ybr > ytl):
            raise ValueError(f"degenerate box on frame {frame} (needs xbr > xtl and ybr > ytl)")
        if not label:
            out["all_labelled"] = False
        out["has_scores"] = out["has_scores"] or _box_score(box)
        out["frames"].setdefault(frame, []).append((label or "", xtl, ytl, xbr, ybr))

    for track in root.iter("track"):
        for box in track.findall("box"):
            handle(box, box.get("frame"), track.get("label"))
        out["n_other_shapes"] += sum(len(track.findall(s)) for s in other)
    for image in root.iter("image"):
        try:
            out["listed"].add(int(image.get("id")))
        except (TypeError, ValueError) as e:
            raise ValueError("<image> element without a numeric id (frame number)") from e
        for box in image.findall("box"):
            handle(box, image.get("id"), box.get("label"))
        out["n_other_shapes"] += sum(len(image.findall(s)) for s in other)
    return out


def iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Pairwise IoU between boxes a (n,4) and b (m,4) in xtl, ytl, xbr, ybr."""
    ix = np.clip(np.minimum(a[:, None, 2], b[None, :, 2]) - np.maximum(a[:, None, 0], b[None, :, 0]), 0, None)
    iy = np.clip(np.minimum(a[:, None, 3], b[None, :, 3]) - np.maximum(a[:, None, 1], b[None, :, 1]), 0, None)
    inter = ix * iy
    area_a = (a[:, 2] - a[:, 0]) * (a[:, 3] - a[:, 1])
    area_b = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    return inter / (area_a[:, None] + area_b[None, :] - inter)


def match_boxes(ref: np.ndarray, pred: np.ndarray, thr: float = IOU_MATCH) -> list[tuple[int, int, float]]:
    """One-to-one matching that maximises the number of IoU >= thr pairs, then total IoU."""
    if len(ref) == 0 or len(pred) == 0:
        return []
    iou = iou_matrix(ref, pred)
    ok = iou >= thr - IOU_TOL
    if not ok.any():
        return []
    big = min(iou.shape) + 1.0  # one extra match always outweighs any gain in total IoU
    r, c = linear_sum_assignment(np.where(ok, big + iou, 0.0), maximize=True)
    return [(int(i), int(j), float(iou[i, j])) for i, j in zip(r, c) if ok[i, j]]


def score_video(true: dict, pred: dict, class_aware: bool) -> dict:
    """TP / FP / FN on the reference frames of one video."""
    counts: dict[str, list[int]] = {}
    frames = sorted(true["listed"])
    for f in frames:
        tb, pb = true["frames"].get(f, []), pred["frames"].get(f, [])
        classes = sorted({b[0] for b in tb} | {b[0] for b in pb}) if class_aware else [None]
        for c in classes:
            t = np.array([b[1:] for b in tb if c is None or b[0] == c], dtype=float).reshape(-1, 4)
            p = np.array([b[1:] for b in pb if c is None or b[0] == c], dtype=float).reshape(-1, 4)
            k = len(match_boxes(t, p))
            acc = counts.setdefault(c if c is not None else "all", [0, 0, 0])
            acc[0] += k
            acc[1] += len(p) - k
            acc[2] += len(t) - k
    pred_only = pred["listed"] - true["listed"]
    return {"counts": counts, "n_eligible_frames": len(frames),
            "n_reference_frames_without_prediction_entry": len(true["listed"] - pred["listed"]),
            "n_prediction_only_frames_ignored": len(pred_only),
            "n_prediction_boxes_ignored": sum(len(pred["frames"].get(f, [])) for f in pred_only)}


def validate_detection(df: pd.DataFrame, csv_dir: Path, issues: list[dict], notices: list[str]) -> dict:
    """Parse every XML pair; unreadable files become explicit issues."""
    parsed = {}
    for line, tx, px in tqdm(list(zip(df["csv_line"], df["true_xml"], df["pred_xml"])), desc="Reading XML",
                             leave=False):
        pair = {}
        for col, val in (("true_xml", tx), ("pred_xml", px)):
            path = resolve_path(val, csv_dir)
            if val == "" or not path.is_file():
                add_issue(issues, line, col, "file missing or unreadable", "path does not point to a file")
                continue
            try:
                pair[col] = parse_cvat_xml(path)
            except (ValueError, OSError) as e:
                add_issue(issues, line, col, "unreadable XML", str(e))
        if len(pair) == 2:
            parsed[int(line)] = pair
            if not pair["true_xml"]["listed"]:
                notices.append(f"CSV line {line}: true_xml lists no frames, so this video contributes no evaluated frames.")
    for col in ("true_xml", "pred_xml"):
        dup = int(df[col][df[col] != ""].duplicated().sum())
        if dup:
            notices.append(f"{dup} rows reuse a {col} path that already appears on another row.")
    return parsed


def render_overlay(video: Path, true: dict, pred: dict, out_path: Path, frame_offset: int) -> dict:
    """Write a video of the eligible frames with reference and predicted boxes drawn."""
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        return {"status": "unreadable video file", "frames_written": 0}
    wanted = {f + frame_offset: f for f in true["listed"]}
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    writer = None
    for codec in ("avc1", "mp4v"):
        writer = cv2.VideoWriter(str(out_path), cv2.VideoWriter_fourcc(*codec), OVERLAY_FPS, (w, h))
        if writer.isOpened():
            break
        writer.release()
    if writer is None or not writer.isOpened():
        cap.release()
        return {"status": "could not open a video writer", "frames_written": 0}
    scale = max(0.4, min(w, h) / 600)
    thick = max(1, round(2 * scale))
    written, pos, last = 0, 0, max(wanted) if wanted else -1
    while pos <= last and cap.grab():
        if pos in wanted:
            ok, img = cap.retrieve()
            if ok:
                f = wanted[pos]
                for boxes, colour in ((true["frames"].get(f, []), COLOUR_REF_BGR),
                                      (pred["frames"].get(f, []), COLOUR_PRED_BGR)):
                    for _, x1, y1, x2, y2 in boxes:
                        cv2.rectangle(img, (round(x1), round(y1)), (round(x2), round(y2)), colour, thick)
                y0 = round(22 * scale)
                header = f"{PLOT_PREFIX}: Detection Overlay | Frame {f}" if PLOT_PREFIX else f"Frame {f}"
                for i, (text, colour) in enumerate(((header, (255, 255, 255)),
                                                    ("Reference", COLOUR_REF_BGR), ("Prediction", COLOUR_PRED_BGR))):
                    org = (round(6 * scale), y0 * (i + 1))
                    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, 0.6 * scale, (0, 0, 0), thick + 2, cv2.LINE_AA)
                    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, 0.6 * scale, colour, thick, cv2.LINE_AA)
                writer.write(img)
                written += 1
        pos += 1
    cap.release()
    writer.release()
    missing = len(wanted) - written
    status = "ok" if missing == 0 else f"{missing} eligible frames could not be read from the video"
    return {"status": status, "frames_written": written}


def evaluate_detection(df: pd.DataFrame, parsed: dict, csv_dir: Path, args, rng: np.random.Generator,
                       meta: dict, notices: list[str]) -> pd.DataFrame:
    """Pooled precision / recall on reference frames, per-class when labels exist, overlays."""
    lines = [int(v) for v in df["csv_line"]]
    pairs = [parsed[v] for v in lines]
    class_aware = all(p["true_xml"]["all_labelled"] and p["pred_xml"]["all_labelled"] for p in pairs)
    has_scores = any(p["pred_xml"]["has_scores"] for p in pairs)
    n_outside = sum(p["true_xml"]["n_outside"] + p["pred_xml"]["n_outside"] for p in pairs)
    n_other = sum(p["true_xml"]["n_other_shapes"] + p["pred_xml"]["n_other_shapes"] for p in pairs)
    if n_other:
        notices.append(f"{n_other} non-box shapes (polygons, points, ...) are present and were not evaluated.")
    meta["thresholds"].update(iou_match=IOU_MATCH, matching="one-to-one; maximum number of matches, then total IoU")
    meta["label_mapping"] = {"mode": "class-aware" if class_aware else "class-agnostic"}
    meta["detection"] = {"boxes_excluded_outside_1": n_outside, "frame_offset": args.frame_offset}

    totals: dict[str, np.ndarray] = {}
    per_video = []
    for line, pair in zip(tqdm(lines, desc="Matching boxes", leave=False), pairs):
        res = score_video(pair["true_xml"], pair["pred_xml"], class_aware)
        v = np.sum(list(res["counts"].values()), axis=0) if res["counts"] else np.zeros(3, dtype=int)
        for c, k in res["counts"].items():
            totals[c] = totals.get(c, np.zeros(3, dtype=int)) + np.array(k)
        per_video.append({"csv_line": line, "TP": int(v[0]), "FP": int(v[1]), "FN": int(v[2]),
                          **{k: res[k] for k in res if k != "counts"}})
    pv = pd.DataFrame(per_video)
    pv.to_csv(saved(DIRS["sheets"] / f"per_video_counts_{FILE_TAG}.csv"), index=False)
    tp, fp, fn = (int(pv[c].sum()) for c in ("TP", "FP", "FN"))
    n_frames = int(pv["n_eligible_frames"].sum())
    meta["detection"].update(eligible_frames=n_frames,
                             reference_frames_without_prediction_entry=int(pv["n_reference_frames_without_prediction_entry"].sum()),
                             prediction_only_frames_ignored=int(pv["n_prediction_only_frames_ignored"].sum()),
                             prediction_boxes_ignored=int(pv["n_prediction_boxes_ignored"].sum()))

    def block(group: str, a: int, b: int, c: int) -> list[dict]:
        return [metric_row("TP", a, unit="boxes", n=n_frames, group=group),
                metric_row("FP", b, unit="boxes", n=n_frames, group=group),
                metric_row("FN", c, unit="boxes", n=n_frames, group=group),
                metric_row("precision", safe_div(a, a + b), unit="proportion", n=n_frames, group=group,
                           note="" if a + b else "NA — no predicted boxes on eligible frames"),
                metric_row("recall", safe_div(a, a + c), unit="proportion", n=n_frames, group=group,
                           note="" if a + c else "NA — no reference boxes on eligible frames")]

    scope = "overall" if class_aware else "overall (class-agnostic localization)"
    rows = block(scope, tp, fp, fn)
    map_note = MAP_NA if not has_scores else ("NA — confidence scores were found in pred_xml, but scored mAP is "
                                              "not implemented in this version")
    rows += [metric_row("mAP@50", np.nan, group=scope, note=map_note),
             metric_row("mAP@50:95", np.nan, group=scope, note=map_note)]
    if class_aware:
        for c in sorted(totals):
            rows += block(f"class: {c}", *(int(x) for x in totals[c]))
    else:
        rows.append(metric_row("per_class_precision_recall", np.nan, group="per-class",
                               note="NA — XML files contain coordinates without class labels in both files"))
    metrics = write_metrics(rows, "metrics")

    # Overlays: two videos chosen with the fixed seed
    k = min(N_OVERLAY_VIDEOS, len(lines))
    chosen = sorted(int(v) for v in rng.choice(lines, size=k, replace=False))
    supplied = dict(item.split("=", 1) for item in args.overlay_video)
    by_line = dict(zip(lines, df["record_id"]))
    selected, pending = [], []
    for line in chosen:
        raw = supplied.get(str(line)) or supplied.get(by_line[line]) or \
              (df.loc[df["csv_line"] == line, "video_path"].iloc[0] if "video_path" in df.columns else "")
        entry = {"csv_line": line, "overlay": None, "status": ""}
        video = resolve_path(raw, csv_dir) if raw else None
        if video is None or not video.is_file():
            entry["status"] = "no local video supplied" if not raw else "video file missing or unreadable"
            pending.append(line)
        else:
            out_path = DIRS["videos"] / f"overlay_csv_line_{line}_{FILE_TAG}.mp4"
            res = render_overlay(video, parsed[line]["true_xml"], parsed[line]["pred_xml"], out_path, args.frame_offset)
            entry["status"] = res["status"]
            if res["frames_written"]:
                entry["overlay"] = str(saved(out_path))
                entry["frames_written"] = res["frames_written"]
            else:
                pending.append(line)
        selected.append(entry)
    meta["selected_examples"] = selected
    if pending:
        notices.append(f"OVERLAYS PENDING for CSV lines {pending}: ask the user for the matching local videos and "
                       "re-run with --overlay-video <csv_line>=<path> for each. The XML-based metrics above are complete.")
    return metrics


# ---------- 4.7 Segmentation ----------
def load_mask(path: Path) -> np.ndarray:
    """Load a 2-D binary mask (0 / 255) with no resizing, conversion or thresholding."""
    if path.suffix.lower() == ".npy":
        arr = np.load(path, allow_pickle=False)
        mode = f"npy {arr.dtype}"
    else:
        with Image.open(path) as img:
            if getattr(img, "n_frames", 1) > 1:
                raise ValueError(f"multi-frame image ({img.n_frames} frames); expected one 2-D mask")
            mode = img.mode
            arr = np.asarray(img)
        if mode == "P":
            raise ValueError("palette-indexed image; expected a greyscale mask with values 0 and 255")
    if arr.ndim != 2:
        raise ValueError(f"not a 2-D mask (shape {tuple(arr.shape)}, mode {mode})")
    if arr.dtype == bool:
        raise ValueError("1-bit / boolean mask (values 0 and 1); expected 0 and 255")
    bad = ~((arr == MASK_BG) | (arr == MASK_FG))
    if bad.any():
        values = np.unique(arr[bad])[:5].tolist()
        raise ValueError(f"{int(bad.sum())} pixels are not 0 or 255 (e.g. values {values})")
    return arr


def validate_segmentation(df: pd.DataFrame, csv_dir: Path, issues: list[dict], notices: list[str]) -> dict:
    """Check every mask pair and keep only pixel counts (memory-light)."""
    counts = {}
    for line, tm, pm in tqdm(list(zip(df["csv_line"], df["true_mask"], df["pred_mask"])), desc="Checking masks",
                             leave=False):
        arrays = {}
        for col, val in (("true_mask", tm), ("pred_mask", pm)):
            path = resolve_path(val, csv_dir)
            if val == "" or not path.is_file():
                add_issue(issues, line, col, "file missing or unreadable", "path does not point to a file")
                continue
            try:
                arrays[col] = load_mask(path)
            except (ValueError, OSError) as e:
                add_issue(issues, line, col, "invalid mask", str(e))
        if len(arrays) == 2:
            t, p = arrays["true_mask"], arrays["pred_mask"]
            if t.shape != p.shape:
                add_issue(issues, line, "true_mask/pred_mask", "dimension mismatch",
                          f"reference {t.shape[1]}x{t.shape[0]} vs prediction {p.shape[1]}x{p.shape[0]} (width x height)")
                continue
            tf, pf = t == MASK_FG, p == MASK_FG
            counts[int(line)] = (int((tf & pf).sum()), int(tf.sum()), int(pf.sum()))
    for col in ("true_mask", "pred_mask"):
        dup = int(df[col][df[col] != ""].duplicated().sum())
        if dup:
            notices.append(f"{dup} rows reuse a {col} path that already appears on another row.")
    return counts


def dice_iou(inter: int, n_true: int, n_pred: int, empty_both: str | None) -> tuple[float, float]:
    """Foreground Dice and IoU for one pair; both-empty follows the chosen policy."""
    if n_true == 0 and n_pred == 0:
        return (1.0, 1.0) if empty_both == "one" else (np.nan, np.nan)
    return 2 * inter / (n_true + n_pred), inter / (n_true + n_pred - inter)


def plot_mask_examples(examples: list[dict], csv_dir: Path) -> None:
    """Reference beside prediction for each sampled pair, same grey scale and size."""
    k = len(examples)
    fig, axes = plt.subplots(k, 2, figsize=(7, 3.3 * k), squeeze=False)
    for row, ex in zip(axes, examples):
        for ax, col, title in ((row[0], "true_mask", "Reference"), (row[1], "pred_mask", "Prediction")):
            ax.imshow(load_mask(resolve_path(ex[col], csv_dir)), cmap="gray", vmin=MASK_BG, vmax=MASK_FG,
                      interpolation="nearest", aspect="equal")
            dice = fmt_value(ex["dice"])
            ax.set_title(f"{title} — CSV line {ex['csv_line']} (Dice {dice})", fontsize=9)
            ax.set_xticks([])
            ax.set_yticks([])
            ax.grid(False)
    title = plot_title("Segmentation Mask Examples")
    fig.suptitle(f"{title}\nBlack = background (0), white = foreground (255)", fontsize=10, fontweight="bold")
    save_figure(fig, "mask_examples", title, dpi=150)


def load_image(path: Path) -> np.ndarray:
    """Load an original image for display only: shown in greyscale, never resized."""
    if path.suffix.lower() == ".npy":
        arr = np.load(path, allow_pickle=False)
    else:
        with Image.open(path) as img:
            if getattr(img, "n_frames", 1) > 1:
                raise ValueError("multi-frame image")
            arr = np.asarray(img if img.mode in ("L", "I", "I;16") else img.convert("L"))
    if arr.ndim != 2:
        raise ValueError("not a 2-D image")
    return arr


def check_overlay_image(raw: str, csv_dir: Path, mask_shape: tuple) -> tuple[np.ndarray | None, str]:
    """Return (image, 'ok') or (None, reason). Reasons never contain the path, which may hold an identifier."""
    path = resolve_path(raw, csv_dir) if raw else None
    if path is None or not path.is_file():
        return None, "no image file"
    try:
        arr = load_image(path)
    except (ValueError, OSError):
        return None, "image could not be read"
    if arr.shape != mask_shape:
        return None, (f"image is {arr.shape[1]}x{arr.shape[0]} but the masks are {mask_shape[1]}x{mask_shape[0]} "
                      "(width x height); nothing is resized")
    return arr, "ok"


def plot_mask_overlays(examples: list[dict], csv_dir: Path) -> None:
    """Original image with the reference mask beside the same image with the predicted mask."""
    k = len(examples)
    fig, axes = plt.subplots(k, 2, figsize=(8, 4.0 * k), squeeze=False)
    for row, ex in zip(axes, examples):
        img = ex["image_array"]
        span = {"vmin": 0, "vmax": 255} if img.dtype == np.uint8 else {}
        for ax, col, label, rgb, style in ((row[0], "true_mask", "Reference mask on image", OVERLAY_REF_RGB, "solid"),
                                           (row[1], "pred_mask", "Predicted mask on image", OVERLAY_PRED_RGB, "dashed")):
            mask = load_mask(resolve_path(ex[col], csv_dir)) == MASK_FG
            ax.imshow(img, cmap="gray", interpolation="nearest", **span)
            fill = np.zeros(mask.shape + (4,))
            fill[mask] = (*rgb, OVERLAY_ALPHA)
            ax.imshow(fill, interpolation="nearest")
            if mask.any() and not mask.all():
                ax.contour(mask.astype(float), levels=[0.5], colors=[rgb], linestyles=style, linewidths=1.6)
            empty = "" if mask.any() else ", mask empty"
            ax.set_title(f"{label}: CSV line {ex['csv_line']} (Dice {fmt_value(ex['dice'])}{empty})", fontsize=9)
            ax.set_xticks([])
            ax.set_yticks([])
            ax.grid(False)
    title = plot_title("Reference vs Predicted Mask on Image")
    fig.suptitle(f"{title}\nReference: blue fill, solid outline. Prediction: amber fill, dashed outline.",
                 fontsize=10, fontweight="bold")
    save_figure(fig, "mask_overlays", title, dpi=150)


def evaluate_segmentation(df: pd.DataFrame, codes: np.ndarray, counts: dict, csv_dir: Path, args,
                          rng: np.random.Generator, sample_rng: np.random.Generator, meta: dict,
                          notices: list[str]) -> pd.DataFrame:
    """Per-pair Dice / IoU, averaged within participant, summarised across participants."""
    lines = [int(v) for v in df["csv_line"]]
    c = np.array([counts[v] for v in lines])
    both_empty = (c[:, 1] == 0) & (c[:, 2] == 0)
    one_empty = (c[:, 1] == 0) ^ (c[:, 2] == 0)
    scores = np.array([dice_iou(*row, args.empty_both) for row in c.tolist()])
    per_pair = pd.DataFrame({"csv_line": lines, "participant_index": codes + 1,
                             "reference_foreground_px": c[:, 1], "prediction_foreground_px": c[:, 2],
                             "intersection_px": c[:, 0], "dice": scores[:, 0], "iou": scores[:, 1],
                             "empty_case": np.where(both_empty, "both empty", np.where(one_empty, "one empty", ""))})
    per_pair.to_csv(saved(DIRS["sheets"] / f"per_pair_scores_{FILE_TAG}.csv"), index=False, na_rep="NA")
    part = per_pair.groupby("participant_index")[["dice", "iou"]].mean()  # NaN pairs are skipped
    n_p = int(codes.max()) + 1
    policy = {"one": "score of one assigned", "exclude": "excluded from the foreground average",
              None: "none present"}[args.empty_both if both_empty.any() else None]
    meta["segmentation"] = {"pairs_both_empty": int(both_empty.sum()), "pairs_exactly_one_empty": int(one_empty.sum()),
                            "both_empty_policy": policy}
    meta["label_mapping"] = {"background": MASK_BG, "foreground": MASK_FG}

    rows = []
    for m in ("dice", "iou"):
        v = part[m].to_numpy()
        ok = v[np.isfinite(v)]
        note = f"{n_p - len(ok)} participants have no scored pair and are not in this summary" if len(ok) < n_p else ""
        if len(ok) == 0:
            rows.append(metric_row(f"{m}_mean", np.nan, n=0, note="NA — no scored pairs"))
            continue
        boot = cluster_bootstrap(np.arange(len(ok)), lambda idx, _c: [ok[idx].mean()], args.n_boot, rng,
                                 f"Bootstrap {m}")
        rows.append(metric_row(f"{m}_mean", float(ok.mean()), boot[:, 0], "proportion", len(ok),
                               "mean of participant-level means" + (f"; {note}" if note else ""), n_boot=args.n_boot))
        q1, med, q3 = np.percentile(ok, [25, 50, 75])
        for name, val in (("sd", float(ok.std(ddof=1)) if len(ok) > 1 else np.nan), ("median", med), ("q1", q1),
                          ("q3", q3), ("min", ok.min()), ("max", ok.max())):
            rows.append(metric_row(f"{m}_{name}", float(val), unit="proportion", n=len(ok),
                                   note="across participants" if np.isfinite(val) else "NA — needs two participants"))
    rows += [metric_row("pairs_scored", int(np.isfinite(scores[:, 0]).sum()), unit="mask pairs", n=len(lines)),
             metric_row("pairs_exactly_one_empty", int(one_empty.sum()), unit="mask pairs", n=len(lines),
                        note="Dice and IoU are zero for these pairs"),
             metric_row("pairs_both_empty", int(both_empty.sum()), unit="mask pairs", n=len(lines),
                        note=f"policy: {policy}")]
    metrics = write_metrics(rows, "metrics")

    k = min(N_MASK_EXAMPLES, len(lines))
    pick = sorted(int(i) for i in sample_rng.choice(len(lines), size=k, replace=False))
    examples = [{"csv_line": lines[i], "true_mask": df["true_mask"].iloc[i], "pred_mask": df["pred_mask"].iloc[i],
                 "dice": scores[i, 0]} for i in pick]
    plot_mask_examples(examples, csv_dir)

    # Optional overlays on the original image (display only; images never affect a metric)
    if IMAGE_COLUMN in df.columns:
        for i, ex in zip(pick, examples):
            shape = load_mask(resolve_path(ex["true_mask"], csv_dir)).shape
            ex["image_array"], ex["overlay"] = check_overlay_image(df[IMAGE_COLUMN].iloc[i], csv_dir, shape)
        usable = [e for e in examples if e["overlay"] == "ok"]
        skipped = [e for e in examples if e["overlay"] != "ok"]
        if usable:
            plot_mask_overlays(usable, csv_dir)
        for e in skipped:
            notices.append(f"Image overlay skipped for CSV line {e['csv_line']}: {e['overlay']}. "
                           "The masks-only figure still shows this pair; the metrics are unaffected.")
        meta["segmentation"]["image_overlays"] = f"{len(usable)} of {len(examples)} sampled pairs"
    else:
        meta["segmentation"]["image_overlays"] = f"not made: the CSV has no '{IMAGE_COLUMN}' column"
    meta["selected_examples"] = [{"csv_line": e["csv_line"], "overlay": e.get("overlay", "no image column")}
                                 for e in examples]
    return metrics


# ---------- 4.8 Run orchestration ----------
def parse_args() -> argparse.Namespace:
    """Command-line options; every user choice is an explicit option."""
    ap = argparse.ArgumentParser(description="Offline evaluation of saved model predictions.")
    ap.add_argument("--task", required=True, choices=list(REQUIRED_COLUMNS))
    ap.add_argument("--mode", choices=["standard", "fgr"], help="classification only")
    ap.add_argument("--csv", type=Path, help="predictions CSV; omit to pick it in a file dialog")
    ap.add_argument("--out-dir", type=Path, default=OUTPUT_DIR)
    ap.add_argument("--inspect", action="store_true", help="only check columns and summarise the CSV")
    ap.add_argument("--positive-label")
    ap.add_argument("--negative-label")
    ap.add_argument("--prob-confirmed", action="store_true",
                    help="the user confirmed pred_prob is the probability of the positive label")
    ap.add_argument("--dca-min", type=float, help="lowest threshold probability (Standard classification)")
    ap.add_argument("--dca-max", type=float, help="highest threshold probability (Standard classification)")
    ap.add_argument("--test-set", choices=list(TEST_SET_LABEL),
                    help="which test set this CSV is; goes into every output file name and plot title")
    ap.add_argument("--title", help=f"optional title for these results, up to {TITLE_MAX} characters "
                                    "(e.g. 'GAUGE: After Pooling'); heads the report and is saved in the run record")
    ap.add_argument("--unit", help="common unit of true and pred (regression); weeks are converted to days "
                                   "for every metric")
    ap.add_argument("--participant-col", help="CSV column that links rows to participants")
    ap.add_argument("--id-format", choices=["plain", "visit"], default="plain",
                    help="'visit' parses participant from record_id like 001_32+5")
    ap.add_argument("--repeated-measures", choices=["participant-mean", "all-pairs-anova"],
                    help="agreement analysis when participants contribute several pairs (regression)")
    ap.add_argument("--empty-both", choices=["exclude", "one"], help="segmentation pairs where both masks are empty")
    ap.add_argument("--overlay-video", action="append", default=[], metavar="CSV_LINE=PATH",
                    help="local video for a selected detection example (repeatable)")
    ap.add_argument("--frame-offset", type=int, default=0, help="video frame index = XML frame number + offset")
    ap.add_argument("--exclude-invalid", action="store_true",
                    help="exclude rows with reported problems (only after the user agrees)")
    ap.add_argument("--column", action="append", default=[], metavar="NAME=CSV_COLUMN",
                    help="use a differently named CSV column, e.g. --column record_id=fpath --column true=TRUE "
                         "(repeatable; the CSV file is not changed)")
    ap.add_argument("--validate-only", action="store_true",
                    help="check the CSV and save the cohort counts (logs/cohort_*.json) without calculating anything")
    ap.add_argument("--confirmed-cohort", metavar="ID",
                    help="with --confirm gui: the cohort id the GUI showed with Proceed / Retry")
    ap.add_argument("--confirm", choices=["popup", "console", "yes", "gui"], default="popup",
                    help="'yes' skips the pop-up and is for synthetic verification only")
    ap.add_argument("--status-file", type=Path, metavar="PATH",
                    help="also write the exit code, the closing message and the saved files to this JSON file "
                         "(used by the FigureUS(out) local server)")
    ap.add_argument("--export-figures", action="store_true",
                    help=f"also save every figure as TIFF and JPEG at {EXPORT_DPI} dpi and as SVG, in figures/export/")
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--n-boot", type=int, default=N_BOOT, help="leave at 1000 for reported results")
    return ap.parse_args()


def check_task_options(args) -> None:
    """Stop early when a choice the user must make is missing."""
    if not args.test_set and not args.inspect:
        raise Stop(EXIT_NEEDS_INPUT, "NEEDS INPUT: ask whether this CSV is the internal or the external test set, "
                                     "then pass --test-set internal or --test-set external.")
    if args.confirm == "gui" and not args.confirmed_cohort and not (args.inspect or args.validate_only):
        raise Stop(EXIT_ERROR, "--confirm gui needs --confirmed-cohort, the id the GUI showed with the cohort counts.")
    if args.title is not None:
        args.title = " ".join(args.title.split()) or None  # one line, single spaces
        if args.title and len(args.title) > TITLE_MAX:
            raise Stop(EXIT_NEEDS_INPUT, f"NEEDS INPUT: the title has {len(args.title)} characters. Ask for a title of "
                                         f"at most {TITLE_MAX} characters, then pass --title again.")
    if args.task == "classification":
        if not args.mode:
            raise Stop(EXIT_NEEDS_INPUT, "NEEDS INPUT: ask the user to choose Standard or FGR, then pass --mode.")
        if args.mode == "standard" and not args.inspect:
            if args.dca_min is None or args.dca_max is None:
                raise Stop(EXIT_NEEDS_INPUT, "NEEDS INPUT: ask for the relevant threshold-probability range for "
                                             "decision curve analysis, then pass --dca-min and --dca-max.")
            if not 0 < args.dca_min < args.dca_max < 1:
                raise Stop(EXIT_NEEDS_INPUT, "NEEDS INPUT: the threshold range must satisfy 0 < min < max < 1.")
    if args.task == "regression" and not (args.unit or "").strip() and not args.inspect:
        raise Stop(EXIT_NEEDS_INPUT, "NEEDS INPUT: ask for the common unit of true and pred, then pass --unit.")


def inspect_csv(df: pd.DataFrame, task: str) -> None:
    """Summarise the CSV for the agent without printing any identifier."""
    log.info(f"Columns: {[c for c in df.columns if c != 'csv_line']}")
    log.info(f"Rows: {len(df)} | unique record_id: {df['record_id'].nunique()} | "
             f"empty record_id: {int((df['record_id'] == '').sum())}")
    n_visit = sum(bool(VISIT_ID_PATTERN.match(r)) for r in df["record_id"])
    log.info(f"record_id values shaped like <participant>_<weeks>+<days>: {n_visit} of {len(df)}")
    if task == "classification":
        log.info(f"true_label values: {df['true_label'].value_counts().to_dict()}")
        log.info(f"pred_label values: {df['pred_label'].value_counts().to_dict()}")
    if task == "detection":
        log.info(f"video_path column present: {'video_path' in df.columns}")
    if task == "segmentation":
        log.info(f"{IMAGE_COLUMN} column present (for overlays): {IMAGE_COLUMN in df.columns}")


def write_report(meta: dict, metrics: pd.DataFrame, notices: list[str]) -> None:
    """Short Markdown summary (aggregate values only)."""
    head = f"{PLOT_PREFIX}: " if PLOT_PREFIX else ""
    summary = f"Evaluation summary — {meta['task']}" + (f" ({meta['mode']})" if meta.get("mode") else "")
    top = [f"# {head}{meta['title']}", "", summary, ""] if meta.get("title") else [f"# {head}{summary}", ""]
    lines = top + [f"- Test set: **{meta['test_set']}**",
             f"- Run: `{RUN_NAME}` | seed {meta['random_seed']} | bootstrap replicates {meta['n_boot']}",
             f"- **Total participants: {meta['n_participants']}**",
             f"- {meta['observation_unit'].capitalize()} scored: {meta['n_observations']}",
             f"- Rows in CSV: {meta['n_rows_csv']} | rows excluded after validation: {meta['n_rows_excluded']}",
             f"- Units: {meta['units']}", "", "## Metrics", "",
             f"Estimates to {REPORT_DECIMALS} decimal places (counts as whole numbers); 95% CIs written as [lower - upper].", "",
             "| group | metric | estimate | 95% CI | replicates used | unit | note |", "|---|---|---|---|---|---|---|"]

    for r in metrics.to_dict("records"):
        ci = r["ci_95_reported"] or "—"
        used = "—" if not np.isfinite(r["n_boot_requested"]) else f"{int(r['n_boot_contributed'])} of {int(r['n_boot_requested'])}"
        lines.append(f"| {r['group']} | {r['metric']} | {r['estimate_reported']} | {ci} | {used} | {r['unit']} | {r['note']} |")
    if notices:
        lines += ["", "## Notices", ""] + [f"- {n}" for n in notices]
    path = saved(DIRS["reports"] / f"summary_{FILE_TAG}.md")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_once(args, csv_path: Path) -> None:
    """One pass: read, validate, confirm the cohort, evaluate, save."""
    total, task = 6, args.task
    csv_path = csv_path.expanduser().resolve()
    csv_dir = csv_path.parent
    issues, notices = [], []

    step(1, total, f"Reading CSV: {csv_path.name}")
    df = read_csv_strict(csv_path)
    column_mapping = apply_column_mapping(df, args.column)
    if args.participant_col in column_mapping.values():  # the participant column may have been renamed
        args.participant_col = next(t for t, s in column_mapping.items() if s == args.participant_col)
    missing = check_columns(df, task)
    if missing:
        raise Stop(EXIT_MISSING_COLUMN, "\n".join(MISSING_COLUMN_MSG.format(col=c) for c in missing))
    log.info(f"Loaded {len(df)} rows x {df.shape[1] - 1} columns (identifiers kept as text)")
    if args.inspect:
        inspect_csv(df, task)
        return
    if len(df) == 0:
        raise Stop(EXIT_INVALID, "The CSV has a header but no data rows.")

    step(2, total, "Validating identifiers, values and files")
    validate_record_ids(df, issues)
    participants = derive_participants(df, args, task, issues)
    mapping, parsed = {}, {}
    if task == "classification":
        mapping = validate_classification(df, args, issues)
        if args.mode == "standard" and all(VISIT_ID_PATTERN.match(r) for r in df["record_id"]):
            notices.append("Every record_id looks like <participant>_<weeks>+<days>; confirm that Standard, not FGR, is intended.")
    elif task == "regression":
        for col in ("true", "pred"):
            for line, raw, v in zip(df["csv_line"], df[col], to_number(df[col])):
                if np.isnan(v):
                    add_issue(issues, line, col, "not a finite number", f"value '{raw}'")
        if args.id_format == "plain" and not args.participant_col and \
                all(VISIT_ID_PATTERN.match(r) for r in df["record_id"]):
            notices.append("Every record_id looks like <participant>_<weeks>+<days>; ask whether participants "
                           "contribute several pairs (then use --id-format visit).")
    elif task == "detection":
        parsed = validate_detection(df, csv_dir, issues, notices)
    else:
        parsed = validate_segmentation(df, csv_dir, issues, notices)

    bad_lines = sorted({i["csv_line"] for i in issues})
    if issues:
        rep = pd.DataFrame(issues).sort_values(["csv_line", "column"])
        rep.to_csv(saved(DIRS["sheets"] / f"validation_issues_{FILE_TAG}.csv"), index=False)
        log.info(f"VALIDATION: {len(issues)} problems on {len(bad_lines)} of {len(df)} rows:")
        for (col, issue), k in rep.groupby(["column", "issue"]).size().items():
            log.info(f"  - {col}: {issue} — {k} rows")
        if not args.exclude_invalid:
            raise Stop(EXIT_INVALID, "Evaluation stopped: no record is dropped silently. Show the problems to the "
                                     "user. Either fix the CSV, or, if the user agrees to exclude exactly these "
                                     f"{len(bad_lines)} rows, re-run with --exclude-invalid.")
        log.info(f"Excluding {len(bad_lines)} rows at the user's request (--exclude-invalid); listed in the sheet above.")
    else:
        log.info("VALIDATION: no problems found.")
    valid = ~df["csv_line"].isin(bad_lines)
    dfv = df[valid].reset_index(drop=True)
    if len(dfv) == 0:
        raise Stop(EXIT_INVALID, "No valid rows remain.")
    codes = pd.factorize(participants[valid].reset_index(drop=True))[0]
    n_p, n_obs = int(codes.max()) + 1, len(dfv)

    if task == "regression" and n_obs > n_p and not args.repeated_measures:
        raise Stop(EXIT_NEEDS_INPUT,
                   f"NEEDS INPUT: {n_p} participants contribute {n_obs} pairs. Ask for the intended "
                   "repeated-measures analysis before agreement is reported, then pass --repeated-measures "
                   "participant-mean (average within participant, one point each) or all-pairs-anova "
                   "(all pairs; limits include within-participant variance).")
    if task == "segmentation" and not args.empty_both:
        n_both = sum(1 for v in dfv["csv_line"] if parsed[int(v)][1] == 0 and parsed[int(v)][2] == 0)
        if n_both:
            raise Stop(EXIT_NEEDS_INPUT,
                       f"NEEDS INPUT: {n_both} mask pairs are empty in both reference and prediction. Ask whether "
                       "to exclude them from the foreground average or assign a score of one, then pass "
                       "--empty-both exclude or --empty-both one.")

    step(3, total, "Cohort confirmation")
    unit = "participants" if (task == "classification" and args.mode == "standard") else OBS_UNIT[task]
    headline = f"Total participants: {n_p}"
    body = [f"{unit.capitalize()}: {n_obs}"] if n_obs != n_p else []  # shown only when it differs
    body.append(f"Rows in CSV: {len(df)}")
    if bad_lines:
        body.append(f"Rows excluded after validation: {len(bad_lines)}")
    log.info(f"**{headline}**")
    for b in body:
        log.info(b)
    for n in notices:
        log.info(f"NOTICE: {n}")
    csv_sha = sha256_file(csv_path)
    # Ties a GUI confirmation to this exact file and these exact counts.
    cohort_id = hashlib.sha256(f"{csv_sha}|{n_p}|{n_obs}|{len(df)}|{len(bad_lines)}".encode()).hexdigest()[:16]
    if args.validate_only:
        cohort = {"total_participants": n_p, "observations": n_obs, "observation_unit": unit, "rows_in_csv": len(df),
                  "rows_excluded": len(bad_lines), "excluded_csv_lines": bad_lines, "notices": notices,
                  "column_mapping": column_mapping, "cohort_id": cohort_id}
        path = saved(DIRS["logs"] / f"cohort_{FILE_TAG}.json")
        path.write_text(json.dumps(cohort, indent=2), encoding="utf-8")
        raise Stop(EXIT_OK, f"VALIDATED: cohort {cohort_id} saved; nothing was calculated. Show the counts with "
                            "Proceed / Retry, then run again with --confirm gui --confirmed-cohort <id>.")
    if args.confirm == "gui":
        if args.confirmed_cohort != cohort_id:
            raise Stop(EXIT_RETRY, "RETRY: the CSV or the options changed the cohort since it was confirmed in the "
                                   "GUI. Check the CSV again.")
        log.info(f"Cohort {cohort_id} confirmed in the FigureUS(out) GUI (same file, same counts).")
    elif not confirm_cohort(headline, "\n".join(body), args.confirm):
        raise Stop(EXIT_RETRY, "RETRY: the user chose Retry. Return to CSV selection.")
    else:
        log.info("User chose Proceed.")

    meta = {"run_name": RUN_NAME, "test_set": TEST_SET_LABEL[args.test_set], "title": args.title,
            "task": task, "mode": args.mode if task == "classification" else None,
            "column_mapping": column_mapping or None, "cohort_id": cohort_id,
            "csv_file": str(csv_path), "csv_sha256": csv_sha, "n_rows_csv": len(df),
            "n_rows_excluded": len(bad_lines), "excluded_csv_lines": bad_lines, "n_participants": n_p,
            "n_observations": n_obs, "observation_unit": unit,
            "participant_link": ("visit identifier" if (task == "classification" and args.mode == "fgr") or args.id_format == "visit"
                                 else args.participant_col or "record_id"),
            "label_mapping": mapping or None, "thresholds": {},
            "units": args.unit if task == "regression" else {"classification": "proportion / count",
                                                             "detection": "boxes / proportion; coordinates in pixels",
                                                             "segmentation": "proportion (Dice, IoU); pixels"}[task],
            "random_seed": args.seed, "n_boot": args.n_boot, "ci_level": CI_LEVEL, "ci_method": "percentile bootstrap, participants resampled",
            "selected_examples": [],
            "versions": {"python": platform.python_version(), "numpy": np.__version__, "pandas": pd.__version__,
                         "scipy": scipy.__version__, "matplotlib": matplotlib.__version__, "opencv": cv2.__version__,
                         "pillow": Image.__version__}, "platform": platform.platform()}
    boot_seed, sample_seed = np.random.SeedSequence(args.seed).spawn(2)
    boot_rng, sample_rng = np.random.default_rng(boot_seed), np.random.default_rng(sample_seed)

    step(4, total, "Calculating metrics and figures")
    if task == "classification":
        metrics = evaluate_classification(dfv, codes, mapping, args, boot_rng, meta)
    elif task == "regression":
        metrics = evaluate_regression(dfv, codes, args, boot_rng, meta)
    elif task == "detection":
        metrics = evaluate_detection(dfv, parsed, csv_dir, args, sample_rng, meta, notices)
    else:
        metrics = evaluate_segmentation(dfv, codes, parsed, csv_dir, args, boot_rng, sample_rng, meta, notices)

    step(5, total, "Saving run record")
    meta["notices"] = notices
    meta["figure_titles"] = dict(FIGURE_TITLES)
    path = saved(DIRS["logs"] / f"run_metadata_{FILE_TAG}.json")
    path.write_text(json.dumps(meta, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    write_report(meta, metrics, notices)

    step(6, total, "Results")
    show = metrics[["group", "metric", "estimate_reported", "ci_95_reported", "unit", "n_boot_contributed", "note"]].rename(
        columns={"estimate_reported": "estimate", "ci_95_reported": "95% CI", "n_boot_contributed": "replicates"})
    show = show.assign(**{"95% CI": show["95% CI"].replace("", "—")})
    for line in show.to_string(index=False, na_rep="—", float_format=lambda v: f"{v:.0f}").splitlines():
        log.info(line)
    for n in notices:
        log.info(f"NOTICE: {n}")


# ============================================================
# 5. MAIN
# ============================================================
def main() -> None:
    global FILE_TAG, PLOT_PREFIX, EXPORT_FIGURES
    args = parse_args()
    EXPORT_FIGURES = args.export_figures
    if args.test_set:
        FILE_TAG = f"{args.test_set}_{RUN_NAME}"
        PLOT_PREFIX = TEST_SET_LABEL[args.test_set]
    DIRS.update(setup_output_dirs(args.out_dir, OUTPUT_SUBDIRS))
    setup_logger(DIRS["logs"] / f"run_{FILE_TAG}.log")
    t0 = time.time()
    log.info("=" * 60)
    log.info(f"START  {Path(__file__).name}  |  {datetime.now():%Y-%m-%d %H:%M:%S}")
    log.info(f"Task  : {args.task}" + (f" ({args.mode})" if args.mode else ""))
    log.info(f"Test set: {PLOT_PREFIX or 'not given'}")
    if args.title:
        log.info(f"Title : {' '.join(args.title.split())}")
    log.info(f"Output: {args.out_dir.resolve()}  |  run: {RUN_NAME}")
    log.info(f"Seed {args.seed} | bootstrap replicates {args.n_boot} | device: CPU (offline)")
    log.info("=" * 60)

    code, message = EXIT_OK, ""
    try:
        check_task_options(args)
        while True:
            from_dialog = args.csv is None
            csv_path = choose_csv_dialog() if from_dialog else args.csv
            try:
                run_once(args, csv_path)
                break
            except Stop as s:
                if s.code == EXIT_RETRY and from_dialog:
                    log.info("Retry chosen: returning to CSV selection.")
                    continue
                raise
    except Stop as s:
        code, message = s.code, s.message
        for line in s.message.splitlines():
            log.info(line)

    log.info("=" * 60)
    log.info(f"END  {datetime.now():%H:%M:%S}  |  duration {timedelta(seconds=int(time.time() - t0))}  |  exit code {code}")
    log.info("Outputs written:")
    for p in SAVED_FILES:
        log.info(f"  - {p}")
    log.info("=" * 60)
    if args.status_file:
        status = {"exit_code": code, "message": message, "run_name": RUN_NAME, "file_tag": FILE_TAG,
                  "saved_files": [str(p) for p in SAVED_FILES]}
        args.status_file.write_text(json.dumps(status, indent=2, ensure_ascii=False), encoding="utf-8")
    sys.exit(code)


if __name__ == "__main__":
    main()
