// Workspace state helpers: what the user chose, turned into evaluate.py options.
import type { CsvSummary, Options } from "@/lib/api"
import type { ColumnSpec, TaskKey } from "@/lib/tasks"

export const RECORD = "__record__" // each record_id is one participant
export const VISIT = "__visit__" // record_id holds visit ids like 001_32+5
export const TITLE_MAX = 80 // same limit as evaluate.py --title

export type Setup = {
  test_set: "internal" | "external" | null
  title: string
  mode: "standard" | "fgr" | null
  positive_label: string
  negative_label: string
  prob_confirmed: boolean
  dca_min: string
  dca_max: string
  unit: string
  repeated_measures: Options["repeated_measures"]
  empty_both: Options["empty_both"]
  frame_offset: string
  exclude_invalid: boolean
}

export const emptySetup = (mode: Setup["mode"]): Setup => ({
  test_set: null,
  title: "",
  mode,
  positive_label: "",
  negative_label: "",
  prob_confirmed: false,
  dca_min: "",
  dca_max: "",
  unit: "",
  repeated_measures: null,
  empty_both: null,
  frame_offset: "0",
  exclude_invalid: false,
})

/** Pick the CSV column with the expected name (exact, then ignoring case); otherwise leave it for the user. */
export function autoMap(specs: ColumnSpec[], summary: CsvSummary): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of specs) {
    out[s.name] =
      summary.columns.find((c) => c === s.name) ??
      summary.columns.find((c) => c.toLowerCase() === s.name.toLowerCase()) ??
      ""
  }
  return out
}

const num = (v: string) => (v.trim() === "" ? null : Number(v))

export function toOptions(
  task: TaskKey,
  csv: string,
  mapping: Record<string, string>,
  participant: string,
  s: Setup,
): Options {
  const classification = task === "classification"
  const participantCol = !classification && participant && participant !== RECORD && participant !== VISIT ? participant : null
  return {
    task,
    csv,
    test_set: s.test_set,
    title: s.title.trim() || null,
    columns: Object.fromEntries(Object.entries(mapping).filter(([, col]) => col)),
    participant_col: participantCol,
    id_format: !classification && participant === VISIT ? "visit" : "plain",
    mode: classification ? s.mode : null,
    positive_label: classification ? s.positive_label || null : null,
    negative_label: classification ? s.negative_label || null : null,
    prob_confirmed: classification && s.prob_confirmed,
    dca_min: classification && s.mode === "standard" ? num(s.dca_min) : null,
    dca_max: classification && s.mode === "standard" ? num(s.dca_max) : null,
    unit: task === "regression" ? s.unit.trim() || null : null,
    repeated_measures: task === "regression" ? s.repeated_measures : null,
    empty_both: task === "segmentation" ? s.empty_both : null,
    frame_offset: task === "detection" ? Number(s.frame_offset) || 0 : 0,
    exclude_invalid: s.exclude_invalid,
  }
}

export type Problems = Partial<Record<string, string>>

/** Choices still missing before evaluate.py can check the CSV. evaluate.py checks everything again. */
export function missingChoices(
  task: TaskKey,
  specs: ColumnSpec[],
  mapping: Record<string, string>,
  participant: string,
  s: Setup,
): Problems {
  const p: Problems = {}
  for (const c of specs) {
    if (!c.optional && !mapping[c.name]) p[`col:${c.name}`] = `Choose the column that holds ${c.name}.`
  }
  const used = Object.values(mapping).filter(Boolean)
  const twice = used.find((c, i) => used.indexOf(c) !== i)
  if (twice) p.columns = `The column "${twice}" is chosen for two names. Each name needs its own column.`
  if (task !== "classification" && !participant) p.participant = "Choose how rows link to participants."
  if (!s.test_set) p.test_set = "Choose the test set. It goes into every file name and plot title."
  if (s.title.trim().length > TITLE_MAX) p.title = `Shorten the title to ${TITLE_MAX} characters or fewer.`
  if (task === "classification") {
    if (!s.mode) p.mode = "Choose Standard or FGR."
    if (!s.positive_label) p.positive_label = "Choose the positive label."
    if (!s.prob_confirmed) p.prob_confirmed = "Confirm what pred_prob holds."
    if (s.mode === "standard") {
      const lo = num(s.dca_min)
      const hi = num(s.dca_max)
      if (lo === null || hi === null || Number.isNaN(lo) || Number.isNaN(hi)) {
        p.dca = "Give the lowest and highest threshold probability."
      } else if (!(lo > 0 && lo < hi && hi < 1)) {
        p.dca = "The range must satisfy 0 < lowest < highest < 1."
      }
    }
  }
  if (task === "regression" && !s.unit.trim()) p.unit = "Give the unit of true and pred."
  if (task === "detection" && !/^-?\d+$/.test(s.frame_offset.trim())) p.frame_offset = "Give a whole number (0 if unsure)."
  return p
}

/** evaluate.py's NEEDS INPUT messages are written for an assistant; say the same thing to the person. */
export function needsInputText(field: string | null | undefined, message: string): string {
  const plain = message.replace(/^NEEDS INPUT:\s*/, "")
  if (field === "repeated_measures") {
    const m = plain.match(/(\d+) participants contribute (\d+) pairs/)
    return m
      ? `${m[1]} participants contribute ${m[2]} pairs. Choose how agreement handles participants with several pairs.`
      : "Participants contribute several pairs. Choose how agreement handles them."
  }
  if (field === "empty_both") {
    const m = plain.match(/(\d+) mask pairs are empty in both/)
    return `${m ? m[1] : "Some"} mask pairs are empty in both the reference and the prediction. Choose how they count.`
  }
  if (field === "negative_label") return "More than two labels were found. Choose the negative label; rows with any other label are then reported."
  if (field === "participant_col") return "Choose how rows link to participants."
  return plain
}
