# Segmentation guide (2-D binary masks)

CSV columns: `record_id`, `true_mask`, `pred_mask`. Masks are 2-D, encoded `0 = background`, `255 = foreground` (PNG, TIFF, BMP or `.npy`).

Optional column `image`: the original image for each pair (any greyscale or colour image, or `.npy`), at the same size as its masks. It is used only to draw overlays and never affects a metric.

## Questions to ask

0. **Internal or external test set?** → `--test-set internal` or `--test-set external` (asked for every task; see `SKILL.md`).
1. **Do the rows identify people or image files, and which column links an image to its participant?** → `--participant-col <column>` (use `record_id` only if the user confirms each `record_id` is one participant), or `--id-format visit`.
2. **Only if some pairs are empty in both masks** (the script stops with `NEEDS INPUT` and gives the count): exclude those pairs from the foreground average, or assign a score of one?
   - `--empty-both exclude` — the pair has no foreground to score, so it is left out. A participant whose pairs are all excluded drops out of the summary, and the count is reported.
   - `--empty-both one` — a correct "nothing here" counts as perfect agreement. This raises the average when many images have no target.
   Explain both and let the user choose.

## Command

```bash
python scripts/evaluate.py --task segmentation --test-set internal --csv segmentation.csv \
    --participant-col participant_id [--empty-both exclude|one]
```

## What the script checks (and never repairs)

- Each file exists and opens.
- Each mask is 2-D. RGB, palette, 1-bit (0/1) and multi-frame images are reported as invalid.
- Every pixel is 0 or 255. Other values are reported with examples.
- Reference and prediction have identical dimensions.

Mismatches are listed by CSV line in `sheets/validation_issues_*.csv`. The script **does not resize, convert or threshold** anything. If the user wants masks fixed, that is a separate step they do themselves, and then re-run.

## What the script calculates

- Per pair: foreground **Dice** = 2·|A∩B| / (|A| + |B|) and **IoU** = |A∩B| / |A∪B|.
- If exactly one mask is empty, both scores are zero.
- Several images from one participant are **averaged within that participant first**; the summary is then across participants: mean with a 95% participant-bootstrap CI (1,000 replicates), SD, median, quartiles, minimum and maximum.
- The metrics sheet reports the number of pairs scored, pairs with exactly one empty mask, pairs with both empty, and the policy applied.
- **Five distinct pairs** are sampled with the fixed seed (all pairs if fewer than five) and shown reference beside prediction with the same grey scale (0 black, 255 white) and the same size, labelled by CSV line.
- **Overlays (only with an `image` column):** for the same five pairs, `figures/mask_overlays_*.png` shows the original image with the reference mask (blue fill, solid outline) beside the same image with the predicted mask (amber fill, dashed outline), titled `Internal Test: Reference vs Predicted Mask on Image`. An image that is missing, unreadable or a different size from its masks is skipped with a `NOTICE` naming the CSV line (never the path); nothing is resized, the masks-only figure still shows that pair, and the run carries on. The run record lists each sampled pair's overlay status.

## Outputs

`sheets/metrics_<test set>_<run>.csv`, `sheets/per_pair_scores_<test set>_<run>.csv` (by CSV line, with pixel counts), `figures/mask_examples_<test set>_<run>.png` (title `Internal Test: Segmentation Mask Examples` or `External Test: …`), `figures/mask_overlays_<test set>_<run>.png` when an `image` column is present, and the run record.

## Interpretation notes

- State the both-empty policy next to every average; the two policies answer different questions and are not comparable.
- Dice is always at least as large as IoU for the same pair; do not compare one study's Dice with another's IoU.
- Small structures give volatile scores: a few pixels move Dice a long way. The per-pair sheet has the foreground sizes.
- A mean can hide a group of complete misses. Report the minimum and the count of one-empty pairs alongside it.
- Five examples are an illustration chosen at random, not evidence of typical performance.
