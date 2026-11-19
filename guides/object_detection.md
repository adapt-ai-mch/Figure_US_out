# Object detection guide (CVAT XML)

CSV columns: `record_id`, `true_xml`, `pred_xml`; `video_path` is used for overlays when present. Each row is one video: a reference XML and a prediction XML with frame numbers and box coordinates. The current prediction exports carry **no confidence scores**.

## Questions to ask

0. **Internal or external test set?** → `--test-set internal` or `--test-set external` (asked for every task; see `SKILL.md`).
1. **Do the rows identify people or video files, and which column links a video to its participant?** → `--participant-col <column>` (use `record_id` only if the user confirms each `record_id` is one participant), or `--id-format visit` for identifiers like `001_32+5`. The script stops with `NEEDS INPUT` and lists the columns if this is missing.
2. **Only if overlays are pending** (no `video_path`, or a file is missing): the run prints `OVERLAYS PENDING for CSV lines [...]`. Ask for the matching local video for each listed line, then re-run with `--overlay-video <csv_line>=<path>` once per video. The XML metrics are already complete and identical on the re-run.

## Commands

```bash
python scripts/evaluate.py --task detection --test-set internal --csv detection.csv --participant-col participant_id

# after the user supplies the two selected videos
python scripts/evaluate.py --task detection --test-set internal --csv detection.csv --participant-col participant_id \
    --overlay-video 3=/path/to/a.mp4 --overlay-video 7=/path/to/b.mp4
```

## Rules the script applies

**The frame numbers explicitly present in `true_xml` are the complete evaluation set for that video.**

- Frames are matched by video and frame number. Frames found only in `pred_xml` are ignored. Nothing is interpolated, and an unlisted frame is never assumed to have been reviewed.
- A reference frame stays in the evaluation when `pred_xml` has no entry for it; its reference boxes are **false negatives**.
- Boxes marked `outside="1"` are not visible objects. A frame whose only reference entry is an `outside="1"` box is still an explicitly listed frame, so predictions on it count as false positives.
- On each eligible frame visible boxes are matched one-to-one at **IoU ≥ 0.50**. Because the boxes are unscored, the assignment maximises the number of eligible matches first and total IoU second (deterministic). Unmatched predictions, including duplicates, are **false positives**.
- **Overall precision and recall** come from pooled TP, FP and FN counts across all videos.
- If every box in both files has a class label, matching is within class and per-class results are also reported. If the files hold only coordinates, results are class-agnostic localization and per-class metrics are `NA`.
- **mAP@50 and mAP@50:95 are reported as `NA — prediction confidence scores unavailable`.** Never invent scores and never treat XML order as a ranking. If the user asks for mAP, explain that it needs a confidence score per predicted box.
- Both CVAT layouts are read: video tracks (`<track><box frame=…>`) and per-image (`<image id=…><box>`), where the image `id` is the frame number. Non-box shapes are counted and reported, not evaluated.

**Acceptance example:** `true_xml` lists frames 10 and 20; `pred_xml` lists 20 and 30. Frames 10 and 20 are evaluated. The reference boxes on frame 10 are missed detections. Boxes on frame 20 are compared. Frame 30 is ignored.

## Overlays

Two videos are selected at random with the fixed seed. Each overlay video (`videos/overlay_csv_line_<n>_<test set>_<run>.mp4`) shows **only eligible frames**, with reference boxes in blue, predicted boxes in orange, a colour key, and a header such as `Internal Test: Detection Overlay | Frame 12`. They play at 2 frames per second and are saved in `videos/`. XML frame `n` is taken as the `n`-th frame of the video counting from zero; if the user's export is offset, pass `--frame-offset`. If an eligible frame number is beyond the end of the video, the run says how many could not be read.

## Outputs

`sheets/metrics_<test set>_<run>.csv` (overall and per class), `sheets/per_video_counts_<test set>_<run>.csv` (TP/FP/FN, eligible frames, reference frames without a prediction entry, prediction-only frames and boxes ignored, by CSV line), `videos/overlay_*.mp4`, and the run record.

## Interpretation notes

- These are metrics at one operating point: the predictions as exported. Without scores there is no precision–recall trade-off to describe.
- Recall is relative to the reviewed frames only. Say how many frames were eligible and how many reference frames had no prediction entry.
- Tell the user how many prediction-only frames were ignored. A large number is worth their attention: either the model fires on unreviewed frames, or the reference export is sparser than they think.
- No confidence intervals are produced for detection in this version; say so if asked.
