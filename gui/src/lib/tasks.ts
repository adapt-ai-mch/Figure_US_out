// The four evaluation tasks, the CSV columns each needs, and display names for evaluate.py's metrics.
import { ChartScatter, ScanSearch, Shapes, Split, type LucideIcon } from "lucide-react"

export type TaskKey = "classification" | "regression" | "detection" | "segmentation"

export type ColumnSpec = {
  /** The name evaluate.py expects. */
  name: string
  /** What the column holds, in plain words. */
  holds: string
  optional?: boolean
}

export type Task = {
  key: TaskKey
  label: string
  icon: LucideIcon
  /** What evaluate.py reports for this task. */
  reports: string
  columns: ColumnSpec[]
  /** The CSV lists files (masks, XML), so a folder upload keeps relative paths working. */
  usesFiles: boolean
}

export const TASKS: Task[] = [
  {
    key: "classification",
    label: "Classification",
    icon: Split,
    reports: "Standard or FGR. ROC, precision-recall, calibration and decision curves.",
    columns: [
      { name: "record_id", holds: "Identifier of each record" },
      { name: "true_label", holds: "Reference label" },
      { name: "pred_label", holds: "Predicted label" },
      { name: "pred_prob", holds: "Predicted probability of the positive label" },
    ],
    usesFiles: false,
  },
  {
    key: "regression",
    label: "Regression",
    icon: ChartScatter,
    reports: "MAE, RMSE and Bland-Altman agreement, in days for weeks input.",
    columns: [
      { name: "record_id", holds: "Identifier of each record" },
      { name: "true", holds: "Reference value" },
      { name: "pred", holds: "Predicted value" },
    ],
    usesFiles: false,
  },
  {
    key: "detection",
    label: "Object detection",
    icon: ScanSearch,
    reports: "Precision and recall on reviewed frames, with overlay videos.",
    columns: [
      { name: "record_id", holds: "Identifier of each video" },
      { name: "true_xml", holds: "Reference boxes (CVAT XML file)" },
      { name: "pred_xml", holds: "Predicted boxes (CVAT XML file)" },
      { name: "video_path", holds: "Video file, for overlay videos", optional: true },
    ],
    usesFiles: true,
  },
  {
    key: "segmentation",
    label: "Segmentation",
    icon: Shapes,
    reports: "Dice and IoU, with masks drawn over the original image.",
    columns: [
      { name: "record_id", holds: "Identifier of each image" },
      { name: "true_mask", holds: "Reference mask (PNG, 0 and 255)" },
      { name: "pred_mask", holds: "Predicted mask (PNG, 0 and 255)" },
      { name: "image", holds: "Original image, for the overlays", optional: true },
    ],
    usesFiles: true,
  },
]

export const TASK_BY_KEY = Object.fromEntries(TASKS.map((t) => [t.key, t])) as Record<TaskKey, Task>

export const isTaskKey = (v: string | undefined): v is TaskKey => !!v && v in TASK_BY_KEY

export const TEST_SET = {
  internal: { label: "Internal Test", color: "var(--internal)" },
  external: { label: "External Test", color: "var(--external)" },
} as const

// Display names only; the values themselves always come from evaluate.py's metrics sheet.
const METRIC_NAMES: Record<string, string> = {
  MAE: "MAE",
  MSE: "MSE",
  RMSE: "RMSE",
  mean_bias_pred_minus_true: "Mean bias (pred − true)",
  sd_of_differences: "SD of differences",
  loa_lower_95: "Lower 95% limit of agreement",
  loa_upper_95: "Upper 95% limit of agreement",
  TP: "True positives",
  FP: "False positives",
  FN: "False negatives",
  TN: "True negatives",
  precision: "Precision",
  recall: "Recall",
  per_class_precision_recall: "Precision and recall by class",
  AUROC: "AUROC",
  AUPRC: "AUPRC",
  PPV: "PPV",
  NPV: "NPV",
  F1: "F1 score",
  sensitivity: "Sensitivity",
  specificity: "Specificity",
  screen_positive_rate: "Screen-positive rate",
  dice_mean: "Dice, mean",
  dice_sd: "Dice, SD",
  dice_median: "Dice, median",
  dice_q1: "Dice, lower quartile",
  dice_q3: "Dice, upper quartile",
  dice_min: "Dice, minimum",
  dice_max: "Dice, maximum",
  iou_mean: "IoU, mean",
  iou_sd: "IoU, SD",
  iou_median: "IoU, median",
  iou_q1: "IoU, lower quartile",
  iou_q3: "IoU, upper quartile",
  iou_min: "IoU, minimum",
  iou_max: "IoU, maximum",
  pairs_scored: "Mask pairs scored",
  pairs_exactly_one_empty: "Pairs with one empty mask",
  pairs_both_empty: "Pairs with both masks empty",
}

export function metricName(raw: string): string {
  if (METRIC_NAMES[raw]) return METRIC_NAMES[raw]
  const words = raw.replace(/_/g, " ")
  return /^[A-Z]{2,}/.test(words) ? words : words.charAt(0).toUpperCase() + words.slice(1)
}
