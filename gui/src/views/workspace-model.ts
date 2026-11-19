// Workspace state helpers: what the user chose, turned into evaluate.py options.
// One task page holds up to two CSVs, the internal and the external test set; each is checked and
// evaluated on its own (evaluate.py takes one CSV per run), with one shared set-up.
import type { CsvSummary, Job, Options } from "@/lib/api"
import type { ColumnSpec, TaskKey } from "@/lib/tasks"

export const RECORD = "__record__" // each record_id is one participant
export const VISIT = "__visit__" // record_id holds visit ids like 001_32+5
export const TITLE_MAX = 80 // same limit as evaluate.py --title

export type TestSetKey = "internal" | "external"
export const TEST_SET_KEYS: TestSetKey[] = ["internal", "external"]

/** One test set's CSV and how its columns are read. */
export type Slot = {
  job: Job | null
  csv: string | null
  summary: CsvSummary | null
  mapping: Record<string, string>
  participant: string
  exclude_invalid: boolean
  error: string | null
}

export const emptySlot = (): Slot => ({
  job: null,
  csv: null,
  summary: null,
  mapping: {},
  participant: "",
  exclude_invalid: false,
  error: null,
})

/** Choices shared by both test sets. */
export type Setup = {
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
}

export const emptySetup = (mode: Setup["mode"]): Setup => ({
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
})

/**
 * Pick the CSV column for each expected name: the column the other test set uses, when this CSV has one
 * of that name; otherwise the expected name itself (exact, then ignoring case); otherwise leave it for the user.
 */
export function autoMap(specs: ColumnSpec[], summary: CsvSummary, other?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of specs) {
    const fromOther = other?.[s.name]
    out[s.name] =
      (fromOther && summary.columns.includes(fromOther) ? fromOther : undefined) ??
      summary.columns.find((c) => c === s.name) ??
      summary.columns.find((c) => c.toLowerCase() === s.name.toLowerCase()) ??
      ""
  }
  return out
}

/** The other test set's participant link, when it also makes sense for this CSV. */
export function participantFrom(other: Slot, summary: CsvSummary): string {
  const p = other.participant
  if (p === RECORD || p === VISIT) return p
  return p && summary.columns.includes(p) ? p : ""
}

const num = (v: string) => (v.trim() === "" ? null : Number(v))

export function toOptions(task: TaskKey, testSet: TestSetKey, slot: Slot, s: Setup): Options | null {
  if (!slot.csv) return null
  const classification = task === "classification"
  const p = slot.participant
  return {
    task,
    csv: slot.csv,
    test_set: testSet,
    title: s.title.trim() || null,
    columns: Object.fromEntries(Object.entries(slot.mapping).filter(([, col]) => col)),
    participant_col: !classification && p && p !== RECORD && p !== VISIT ? p : null,
    id_format: !classification && p === VISIT ? "visit" : "plain",
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
    exclude_invalid: slot.exclude_invalid,
  }
}

export type Problems = Partial<Record<string, string>>

/** Column and participant choices still missing for one CSV. */
export function slotProblems(task: TaskKey, specs: ColumnSpec[], slot: Slot): Problems {
  const p: Problems = {}
  if (!slot.summary) return p
  for (const c of specs) {
    if (!c.optional && !slot.mapping[c.name]) p[`col:${c.name}`] = `Choose the column that holds ${c.name}.`
  }
  const used = Object.values(slot.mapping).filter(Boolean)
  const twice = used.find((c, i) => used.indexOf(c) !== i)
  if (twice) p.columns = `The column "${twice}" is chosen for two names. Each name needs its own column.`
  if (task !== "classification" && !slot.participant) p.participant = "Choose how rows link to participants."
  return p
}

/** Shared set-up choices still missing. evaluate.py checks everything again. */
export function setupProblems(task: TaskKey, s: Setup): Problems {
  const p: Problems = {}
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
