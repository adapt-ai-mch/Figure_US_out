"""
make_synthetic_data.py — Build a small synthetic dataset for every task (no real data).

Author : <name>
Created: 2026-11-19
Usage  : python scripts/make_synthetic_data.py [--out synthetic_data]
"""

# ============================================================
# 1. IMPORTS
# ============================================================
import argparse
from pathlib import Path

import cv2
import numpy as np
import pandas as pd
from PIL import Image

# ============================================================
# 2. CONFIG
# ============================================================
OUT_DIR = Path("synthetic_data")      # where the synthetic files go
SEED = 7                              # generator seed
N_STANDARD = 200                      # participants, Standard classification
N_FGR_PARTICIPANTS = 60               # participants, FGR classification
N_REGRESSION = 150                    # participants, regression
VIDEO_SIZE = (160, 120)               # width, height of synthetic videos
VIDEO_FRAMES = 40                     # frames per synthetic video
MASK_SHAPE = (64, 80)                 # height, width of synthetic masks


# ============================================================
# 3. FUNCTIONS
# ============================================================
def make_classification(out: Path, rng: np.random.Generator) -> None:
    """Standard (one row per participant) and FGR (several visits per participant)."""
    d = out / "classification"
    d.mkdir(parents=True, exist_ok=True)
    y = rng.random(N_STANDARD) < 0.3
    p = np.clip(np.where(y, rng.beta(4, 2, N_STANDARD), rng.beta(2, 5, N_STANDARD)), 0, 1).round(4)
    lab = np.where(y, "FGR", "normal")
    pd.DataFrame({"record_id": [f"{i:03d}" for i in range(1, N_STANDARD + 1)], "true_label": lab,
                  "pred_label": np.where(p >= 0.5, "FGR", "normal"), "pred_prob": p}
                 ).to_csv(d / "standard.csv", index=False)

    rows = [("001", "32+5", "normal", "normal", 0.20), ("001", "36+0", "FGR", "FGR", 0.81)]
    for i in range(2, N_FGR_PARTICIPANTS + 1):
        ga = 28
        for _ in range(int(rng.integers(1, 4))):
            ga += int(rng.integers(1, 5))
            truth = rng.random() < 0.3
            prob = round(float(rng.beta(4, 2) if truth else rng.beta(2, 5)), 4)
            rows.append((f"{i:03d}", f"{ga}+{int(rng.integers(0, 7))}", "FGR" if truth else "normal",
                         "FGR" if prob >= 0.5 else "normal", prob))
    pd.DataFrame({"record_id": [f"{a}_{b}" for a, b, *_ in rows], "true_label": [r[2] for r in rows],
                  "pred_label": [r[3] for r in rows], "pred_prob": [r[4] for r in rows]}
                 ).to_csv(d / "fgr.csv", index=False)

    # Hand-checkable table: TP=2, FP=1, FN=1, TN=4
    pd.DataFrame({"record_id": [f"{i:03d}" for i in range(1, 9)],
                  "true_label": ["pos", "pos", "pos", "neg", "neg", "neg", "neg", "neg"],
                  "pred_label": ["pos", "pos", "neg", "pos", "neg", "neg", "neg", "neg"],
                  "pred_prob": [0.9, 0.8, 0.4, 0.7, 0.3, 0.2, 0.1, 0.05]}).to_csv(d / "tiny_known.csv", index=False)
    pd.DataFrame({"record_id": ["001", "002"], "true_label": ["pos", "neg"], "pred_label": ["pos", "neg"]}
                 ).to_csv(d / "missing_column.csv", index=False)
    pd.DataFrame({"record_id": ["001", "001", "003", "004"], "true_label": ["pos", "neg", "neg", "pos"],
                  "pred_label": ["pos", "neg", "neg", "pos"], "pred_prob": ["0.9", "0.2", "1.7", "abc"]}
                 ).to_csv(d / "invalid_rows.csv", index=False)


def make_regression(out: Path, rng: np.random.Generator) -> None:
    """One pair per participant, a repeated-measures file, and a hand-checkable file."""
    d = out / "regression"
    d.mkdir(parents=True, exist_ok=True)
    true = rng.uniform(140, 280, N_REGRESSION).round(1)
    pred = (true + 1.5 + rng.normal(0, 6, N_REGRESSION)).round(1)
    pd.DataFrame({"record_id": [f"{i:03d}" for i in range(1, N_REGRESSION + 1)], "true": true, "pred": pred}
                 ).to_csv(d / "single.csv", index=False)
    rows = []
    for i in range(1, 41):
        offset = rng.normal(0, 4)
        for ga in sorted(rng.choice(np.arange(20, 40), size=int(rng.integers(2, 4)), replace=False)):
            t = ga * 7 + int(rng.integers(0, 7))
            rows.append((f"{i:03d}_{ga}+{t % 7}", t, round(t + offset + rng.normal(0, 3), 1)))
    pd.DataFrame(rows, columns=["record_id", "true", "pred"]).to_csv(d / "repeated.csv", index=False)
    # errors 1, -2, 3, -4 -> MAE 2.5, MSE 7.5, RMSE sqrt(7.5), bias -0.5
    pd.DataFrame({"record_id": ["001", "002", "003", "004"], "true": [10, 20, 30, 40], "pred": [11, 18, 33, 36]}
                 ).to_csv(d / "tiny_known.csv", index=False)


def _cvat_xml(path: Path, tracks: list[tuple[str, list[tuple]]]) -> None:
    """Write a minimal CVAT-for-video XML. Each box: (frame, xtl, ytl, xbr, ybr, outside)."""
    lines = ['<?xml version="1.0" encoding="utf-8"?>', "<annotations>", "  <version>1.1</version>"]
    for tid, (label, boxes) in enumerate(tracks):
        lab = f' label="{label}"' if label else ""
        lines.append(f'  <track id="{tid}"{lab} source="manual">')
        for f, x1, y1, x2, y2, outside in boxes:
            lines.append(f'    <box frame="{f}" outside="{outside}" occluded="0" keyframe="1" '
                         f'xtl="{x1}" ytl="{y1}" xbr="{x2}" ybr="{y2}" z_order="0"></box>')
        lines.append("  </track>")
    lines.append("</annotations>")
    path.write_text("\n".join(lines), encoding="utf-8")


def _video(path: Path, rng: np.random.Generator) -> None:
    """Small noise video with the frame index burnt in."""
    w = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, VIDEO_SIZE)
    for f in range(VIDEO_FRAMES):
        img = rng.integers(40, 90, (VIDEO_SIZE[1], VIDEO_SIZE[0], 3), dtype=np.uint8)
        cv2.putText(img, f"src {f}", (60, 112), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (200, 200, 200), 1)
        w.write(img)
    w.release()


def make_detection(out: Path, rng: np.random.Generator) -> None:
    """Three labelled videos (the first is the acceptance example) plus an unlabelled set."""
    d = out / "detection"
    (d / "xml").mkdir(parents=True, exist_ok=True)
    (d / "videos").mkdir(exist_ok=True)
    # vid_a — acceptance example: true frames 10, 20; pred frames 20, 30
    _cvat_xml(d / "xml/vid_a_true.xml", [("head", [(10, 20, 20, 60, 60, 0), (20, 30, 30, 70, 70, 0)])])
    _cvat_xml(d / "xml/vid_a_pred.xml", [("head", [(20, 32, 31, 71, 72, 0), (30, 10, 10, 50, 50, 0)])])
    # vid_b — duplicate prediction (FP), a poor-IoU prediction (FP + FN), an outside=1 box, and a class mismatch
    _cvat_xml(d / "xml/vid_b_true.xml", [("head", [(5, 10, 10, 50, 50, 0), (6, 10, 10, 50, 50, 0), (7, 10, 10, 50, 50, 1)]),
                                         ("abdomen", [(5, 80, 40, 140, 100, 0), (8, 80, 40, 140, 100, 0)])])
    _cvat_xml(d / "xml/vid_b_pred.xml", [("head", [(5, 11, 11, 51, 51, 0), (6, 40, 40, 80, 80, 0)]),
                                         ("head", [(5, 12, 10, 52, 50, 0), (8, 80, 40, 140, 100, 0)]),
                                         ("abdomen", [(5, 82, 42, 141, 101, 0)])])
    # vid_c — perfect agreement on two frames
    _cvat_xml(d / "xml/vid_c_true.xml", [("head", [(0, 10, 10, 60, 60, 0), (15, 20, 20, 70, 70, 0)])])
    _cvat_xml(d / "xml/vid_c_pred.xml", [("head", [(0, 10, 10, 60, 60, 0), (15, 20, 20, 70, 70, 0)])])
    for v in "abc":
        _video(d / f"videos/vid_{v}.mp4", rng)
    ids = ["vid_a", "vid_b", "vid_c"]
    base = pd.DataFrame({"record_id": ids, "participant_id": ["001", "001", "002"],
                         "true_xml": [f"xml/{v}_true.xml" for v in ids], "pred_xml": [f"xml/{v}_pred.xml" for v in ids]})
    base.assign(video_path=[f"videos/{v}.mp4" for v in ids]).to_csv(d / "detection.csv", index=False)
    base.to_csv(d / "detection_no_video.csv", index=False)
    # coordinates only (no class labels)
    _cvat_xml(d / "xml/vid_u_true.xml", [("", [(3, 10, 10, 50, 50, 0)])])
    _cvat_xml(d / "xml/vid_u_pred.xml", [("", [(3, 12, 12, 52, 52, 0)])])
    pd.DataFrame({"record_id": ["vid_u"], "participant_id": ["003"], "true_xml": ["xml/vid_u_true.xml"],
                  "pred_xml": ["xml/vid_u_pred.xml"]}).to_csv(d / "detection_unlabelled.csv", index=False)


def _mask(path: Path, box: tuple | None) -> None:
    """Save a 0/255 mask with an optional filled rectangle (r0, r1, c0, c1)."""
    m = np.zeros(MASK_SHAPE, dtype=np.uint8)
    if box:
        m[box[0]:box[1], box[2]:box[3]] = 255
    Image.fromarray(m).save(path)


def make_segmentation(out: Path) -> None:
    """Eight pairs with known Dice / IoU, including one-empty and both-empty cases."""
    d = out / "segmentation"
    (d / "masks").mkdir(parents=True, exist_ok=True)
    spec = [  # (id, participant, true box, pred box)
        ("img_01", "001", (10, 30, 10, 30), (10, 30, 10, 30)),   # identical       dice 1      iou 1
        ("img_02", "001", (10, 30, 10, 30), (10, 30, 20, 40)),   # half overlap    dice 0.5    iou 1/3
        ("img_03", "002", (10, 30, 10, 30), None),               # prediction empty -> 0, 0
        ("img_04", "002", None, None),                           # both empty
        ("img_05", "003", (0, 20, 0, 20), (0, 20, 0, 10)),       # dice 2/3  iou 0.5
        ("img_06", "004", (5, 25, 5, 45), (5, 25, 5, 45)),       # identical
        ("img_07", "005", (20, 40, 20, 60), (20, 40, 30, 70)),   # dice 0.75 iou 0.6
        ("img_08", "006", (0, 10, 0, 10), (30, 40, 30, 40)),     # disjoint -> 0, 0
    ]
    for rid, _, tb, pb in spec:
        _mask(d / f"masks/{rid}_true.png", tb)
        _mask(d / f"masks/{rid}_pred.png", pb)
    df = pd.DataFrame({"record_id": [s[0] for s in spec], "participant_id": [s[1] for s in spec],
                       "true_mask": [f"masks/{s[0]}_true.png" for s in spec],
                       "pred_mask": [f"masks/{s[0]}_pred.png" for s in spec]})
    df.to_csv(d / "segmentation.csv", index=False)
    # problem files: wrong size and non-binary values
    Image.fromarray(np.zeros((32, 40), dtype=np.uint8)).save(d / "masks/bad_size_pred.png")
    grey = np.zeros(MASK_SHAPE, dtype=np.uint8)
    grey[10:20, 10:20] = 128
    Image.fromarray(grey).save(d / "masks/bad_values_pred.png")
    bad = df.iloc[:3].copy()
    bad.loc[0, "pred_mask"] = "masks/bad_size_pred.png"
    bad.loc[1, "pred_mask"] = "masks/bad_values_pred.png"
    bad.loc[2, "pred_mask"] = "masks/does_not_exist.png"
    bad.to_csv(d / "segmentation_invalid.csv", index=False)
    # original images for overlays: grey speckle with the reference region brighter; one has the wrong size
    (d / "images").mkdir(parents=True, exist_ok=True)
    noise = np.random.default_rng(7)
    for rid, _, tb, _ in spec:
        img = noise.integers(20, 90, MASK_SHAPE).astype(np.uint8)
        if tb:
            img[tb[0]:tb[1], tb[2]:tb[3]] += 100
        Image.fromarray(img).save(d / f"images/{rid}.png")
    Image.fromarray(np.zeros((32, 40), dtype=np.uint8)).save(d / "images/img_06_small.png")
    with_img = df.assign(image=[f"images/{s[0]}.png" for s in spec])
    with_img.loc[with_img["record_id"] == "img_06", "image"] = "images/img_06_small.png"
    with_img.to_csv(d / "segmentation_with_images.csv", index=False)


# ============================================================
# 4. MAIN
# ============================================================
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    out = ap.parse_args().out
    rng = np.random.default_rng(SEED)
    for i, (name, fn) in enumerate((("classification", lambda: make_classification(out, rng)),
                                    ("regression", lambda: make_regression(out, rng)),
                                    ("detection", lambda: make_detection(out, rng)),
                                    ("segmentation", lambda: make_segmentation(out))), start=1):
        print(f"[Step {i}/4] Writing synthetic {name} data...")
        fn()
    print(f"Saved -> {out.resolve()}")


if __name__ == "__main__":
    main()
