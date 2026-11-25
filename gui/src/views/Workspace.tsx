// One task, three steps: choose the internal and/or external test set CSV, set up, check and confirm the
// cohorts. Each CSV is its own evaluate.py run; the results open side by side on their own page.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Check } from "lucide-react"

import { Page } from "@/components/app-chrome"
import { api, ApiError, newGroup, runAndWait, type Job, type RunView } from "@/lib/api"
import { go } from "@/lib/router"
import { TASK_BY_KEY, TEST_SET, type TaskKey } from "@/lib/tasks"
import { cn } from "@/lib/utils"
import { CheckStep, type Busy } from "@/views/CheckStep"
import { DataStep } from "@/views/DataStep"
import { SetupStep } from "@/views/SetupStep"
import {
  autoMap,
  emptySetup,
  emptySlot,
  needsInputText,
  imagesFor,
  participantFrom,
  setupProblems,
  slotProblems,
  TEST_SET_KEYS,
  toOptions,
  type Setup,
  type Slot,
  type TestSetKey,
} from "@/views/workspace-model"

const DATA_FIELDS = new Set(["columns", "participant_col"])
const SET_NAME: Record<TestSetKey, string> = { internal: "internal test set", external: "external test set" }
const message = (e: unknown) => (e instanceof ApiError ? e.message : String(e))
const other = (k: TestSetKey): TestSetKey => (k === "internal" ? "external" : "internal")

/** Bring a field into view and put the cursor in it (after React has drawn it). */
function reveal(id: string) {
  window.setTimeout(() => {
    const el = document.getElementById(id)
    if (!el) return
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" })
    el.querySelector<HTMLElement>("input, select, button")?.focus({ preventScroll: true })
  }, 60)
}

type Labels = { col: string; values: string[] | null }

export function Workspace({ taskKey, mode }: { taskKey: TaskKey; mode: Setup["mode"] }) {
  const task = TASK_BY_KEY[taskKey]
  const [slots, setSlots] = useState<Record<TestSetKey, Slot>>({ internal: emptySlot(), external: emptySlot() })
  const [copied, setCopied] = useState<Partial<Record<TestSetKey, boolean>>>({})
  const [setup, setSetup] = useState<Setup>(() => emptySetup(mode))
  const [labels, setLabels] = useState<Partial<Record<TestSetKey, Labels>>>({})
  const [checks, setChecks] = useState<Partial<Record<TestSetKey, { key: string; view: RunView }>>>({})
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<Busy | null>(null)
  const [evalFailures, setEvalFailures] = useState<Partial<Record<TestSetKey, RunView>>>({})
  const [finished, setFinished] = useState<Partial<Record<TestSetKey, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const [attempted, setAttempted] = useState(false)
  const checkRef = useRef<HTMLLIElement>(null)

  const loaded = TEST_SET_KEYS.filter((k) => slots[k].summary)
  const optionsOf = (k: TestSetKey, slot = slots[k], s = setup) => toOptions(taskKey, k, slot, s)
  const keyOf = (k: TestSetKey) => JSON.stringify(optionsOf(k))
  const current: Partial<Record<TestSetKey, RunView>> = {}
  for (const k of loaded) {
    const c = checks[k]
    if (c && c.key === keyOf(k)) current[k] = c.view
  }
  const stale = loaded.some((k) => checks[k] && !current[k])

  const allSlotProblems = Object.fromEntries(TEST_SET_KEYS.map((k) => [k, slotProblems(taskKey, task.columns, slots[k])]))
  const allSetupProblems = setupProblems(taskKey, setup)
  const dataDone = loaded.length > 0 && loaded.every((k) => Object.keys(allSlotProblems[k]).length === 0)

  // What evaluate.py asked, per field: set-up questions are shared, column questions belong to one CSV.
  const asked = loaded
    .map((k) => ({ k, v: current[k] }))
    .filter(({ v }) => v && (v.status === "needs_input" || v.status === "missing_column"))
  const setupAsks = asked.filter(({ v }) => v!.status === "needs_input" && v!.field && !DATA_FIELDS.has(v!.field))
  const needs = setupAsks.length
    ? {
        field: setupAsks[0].v!.field!,
        text: setupAsks
          .filter(({ v }) => v!.field === setupAsks[0].v!.field)
          .map(({ k, v }) => (loaded.length > 1 ? `${cap(SET_NAME[k])}: ` : "") + needsInputText(v!.field, v!.message ?? ""))
          .join(" "),
      }
    : null
  const columnMessage = (k: TestSetKey) => {
    const v = current[k]
    if (!v) return null
    if (v.status === "missing_column" || (v.status === "needs_input" && DATA_FIELDS.has(v.field ?? ""))) {
      return needsInputText(v.field, v.message ?? "")
    }
    return null
  }

  // Offer the reference labels of the loaded CSVs as choices for the positive label.
  const trueCols = Object.fromEntries(
    TEST_SET_KEYS.map((k) => [k, taskKey === "classification" ? slots[k].mapping.true_label ?? "" : ""]),
  ) as Record<TestSetKey, string>
  const internalJob = slots.internal.job?.job_id
  const externalJob = slots.external.job?.job_id
  const internalCsv = slots.internal.csv
  const externalCsv = slots.external.csv
  useEffect(() => {
    const live = { on: true }
    const fetch = (k: TestSetKey, job: string | undefined, csv: string | null, col: string) => {
      if (!job || !csv || !col) return
      api
        .labels(job, csv, col)
        .then((r) => live.on && setLabels((l) => ({ ...l, [k]: { col, values: r.values } })))
        .catch(() => live.on && setLabels((l) => ({ ...l, [k]: { col, values: null } })))
    }
    fetch("internal", internalJob, internalCsv, trueCols.internal)
    fetch("external", externalJob, externalCsv, trueCols.external)
    return () => {
      live.on = false
    }
  }, [internalJob, externalJob, internalCsv, externalCsv, trueCols.internal, trueCols.external])
  const labelSets = loaded.map((k) => (labels[k]?.col === trueCols[k] ? labels[k]!.values : null))
  const labelChoices =
    loaded.length && labelSets.every((v) => v !== null && v !== undefined)
      ? [...new Set(labelSets.flatMap((v) => v!))].sort()
      : null

  const patchSlot = (k: TestSetKey, patch: Partial<Slot>) => setSlots((s) => ({ ...s, [k]: { ...s[k], ...patch } }))

  async function chooseCsv(k: TestSetKey, job: Job, name: string) {
    patchSlot(k, { job, csv: name, summary: null, mapping: {}, error: null })
    try {
      const summary = await api.csvSummary(job.job_id, name)
      setSlots((s) => {
        const o = s[other(k)]
        const fromOther = !!o.summary
        const mapping = autoMap(task.columns, summary, fromOther ? o.mapping : undefined)
        const participant = fromOther && !s[k].participant ? participantFrom(o, summary) : s[k].participant
        const images = imagesFor(s[k], fromOther ? o : null, summary)
        const same = fromOther && task.columns.some((c) => o.mapping[c.name] && mapping[c.name] === o.mapping[c.name])
        setCopied((c) => ({ ...c, [k]: same }))
        return { ...s, [k]: { ...s[k], summary, mapping, participant, images } }
      })
    } catch (e) {
      patchSlot(k, { error: message(e) })
    }
  }

  function onJob(k: TestSetKey, job: Job) {
    setChecks((c) => ({ ...c, [k]: undefined }))
    if (job.csv_files.length === 1) void chooseCsv(k, job, job.csv_files[0])
    else patchSlot(k, { job, csv: null, summary: null, mapping: {}, error: null })
  }

  function resetSlot(k: TestSetKey) {
    patchSlot(k, emptySlot())
    setChecks((c) => ({ ...c, [k]: undefined }))
    setCopied((c) => ({ ...c, [k]: false }))
    setEvalFailures({})
    setFinished({})
  }

  function resetAll() {
    setSlots({ internal: emptySlot(), external: emptySlot() })
    setChecks({})
    setCopied({})
    setLabels({})
    setEvalFailures({})
    setFinished({})
    setError(null)
    setAttempted(false)
    window.scrollTo({ top: 0 })
  }

  async function runCheck(keys: TestSetKey[] = loaded, nextSlots = slots) {
    setAttempted(true)
    if (!keys.length) return
    for (const k of TEST_SET_KEYS.filter((t) => nextSlots[t].summary)) {
      const first = Object.keys(slotProblems(taskKey, task.columns, nextSlots[k]))[0]
      if (first) {
        return reveal(
          first.startsWith("col:")
            ? `${k}-col-${first.slice(4)}`
            : first === "participant"
              ? `${k}-field-participant_col`
              : `${k}-field-columns`,
        )
      }
    }
    const firstSetup = Object.keys(allSetupProblems)[0]
    if (firstSetup) return reveal(`field-${firstSetup}`)

    setError(null)
    setEvalFailures({})
    setFinished({})
    let askedField: string | null = null
    try {
      for (const k of keys) {
        const opts = optionsOf(k, nextSlots[k])
        const job = nextSlots[k].job
        if (!opts || !job) continue
        setBusy({ kind: "check", testSet: k, progress: null })
        const v = await runAndWait(job.job_id, "check", opts, (progress) => setBusy({ kind: "check", testSet: k, progress }))
        setChecks((c) => ({ ...c, [k]: { key: JSON.stringify(opts), view: v } }))
        if (v.status === "needs_input" && v.field) {
          setRevealed((r) => new Set(r).add(v.field!))
          askedField ??= DATA_FIELDS.has(v.field) ? `${k}-field-${v.field}` : `field-${v.field}`
        }
      }
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(null)
    }
    if (askedField) reveal(askedField)
    else window.setTimeout(() => checkRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 60)
  }

  async function proceed() {
    if (!loaded.every((k) => current[k]?.status === "ok")) return
    const group = newGroup()
    const done: Partial<Record<TestSetKey, string>> = {}
    const failed: Partial<Record<TestSetKey, RunView>> = {}
    setEvalFailures({})
    setFinished({})
    setError(null)
    try {
      for (const k of loaded) {
        const opts = optionsOf(k)!
        setBusy({ kind: "evaluate", testSet: k, progress: null })
        const v = await runAndWait(
          slots[k].job!.job_id,
          "evaluate",
          opts,
          (progress) => setBusy({ kind: "evaluate", testSet: k, progress }),
          current[k]!.cohort!.cohort_id,
          group,
        )
        if (v.status === "ok") done[k] = v.run_id
        else failed[k] = v
      }
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(null)
    }
    const ids = loaded.map((k) => done[k]).filter(Boolean) as string[]
    if (ids.length === loaded.length) return go(`/results/${ids.join(",")}`)
    setEvalFailures(failed)
    setFinished(done)
  }

  function exclude(k: TestSetKey) {
    const next = { ...slots, [k]: { ...slots[k], exclude_invalid: true } }
    setSlots(next)
    void runCheck([k], next)
  }

  const setupProblemsShown = attempted ? allSetupProblems : {}

  return (
    <Page>
      <div className="mb-10 flex flex-col gap-2">
        <h1 className="font-heading text-[clamp(2rem,4.5vw,3rem)] font-bold leading-tight tracking-[-0.02em]">
          {task.label}
          {taskKey === "classification" && setup.mode && (
            <span className="text-muted-foreground"> ({setup.mode === "fgr" ? "FGR" : "Standard"})</span>
          )}
        </h1>
        <p className="max-w-[64ch] text-[17px] text-foreground/80">
          {task.reports} evaluate.py calculates every number on this computer; this page shows what it saved.
        </p>
      </div>

      <ol className="flex max-w-[960px] flex-col">
        <StepSection n={1} title="Choose the predictions CSVs" state={dataDone ? "done" : "current"}>
          <p className="mb-6 max-w-[66ch] text-[15px] text-muted-foreground">
            Add the internal test set, the external test set, or both. Each CSV is checked and evaluated on its own,
            and the results are shown side by side.
          </p>
          <div className="flex flex-col gap-8">
            {TEST_SET_KEYS.map((k) => (
              <section
                key={k}
                aria-labelledby={`${k}-slot-h`}
                className="border-l-4 pl-4 sm:pl-6"
                style={{ borderColor: TEST_SET[k].color }}
              >
                <h3 id={`${k}-slot-h`} className="mb-4 font-heading text-xl font-semibold" style={{ color: TEST_SET[k].color }}>
                  {cap(SET_NAME[k])}
                </h3>
                <DataStep
                  task={task}
                  idPrefix={k}
                  copiedFrom={copied[k] ? SET_NAME[other(k)] : null}
                  job={slots[k].job}
                  csv={slots[k].csv}
                  summary={slots[k].summary}
                  mapping={slots[k].mapping}
                  participant={slots[k].participant}
                  images={slots[k].images}
                  problems={attempted ? allSlotProblems[k] : {}}
                  columnMessage={columnMessage(k)}
                  onJob={(job) => onJob(k, job)}
                  onCsv={(name) => slots[k].job && void chooseCsv(k, slots[k].job!, name)}
                  onReset={() => resetSlot(k)}
                  onMapping={(name, col) => patchSlot(k, { mapping: { ...slots[k].mapping, [name]: col } })}
                  onParticipant={(value) => patchSlot(k, { participant: value })}
                  onImages={(value) => patchSlot(k, { images: value })}
                />
                {slots[k].error && <p className="mt-4 text-sm font-medium text-destructive">{slots[k].error}</p>}
              </section>
            ))}
          </div>
        </StepSection>

        <StepSection
          n={2}
          title="Set up the evaluation"
          state={!loaded.length ? "upcoming" : loaded.every((k) => current[k]?.status === "ok") ? "done" : "current"}
        >
          {loaded.length ? (
            <SetupStep
              task={task}
              setup={setup}
              onChange={(patch) => setSetup((s) => ({ ...s, ...patch }))}
              problems={setupProblemsShown}
              labels={labelChoices}
              needs={needs}
              revealed={revealed}
            />
          ) : (
            <p className="text-[15px] text-muted-foreground">Choose a CSV first.</p>
          )}
        </StepSection>

        <StepSection n={3} title="Check and confirm the cohorts" state={!loaded.length ? "upcoming" : "current"} last itemRef={checkRef}>
          {loaded.length ? (
            <CheckStep
              loaded={loaded}
              checks={current}
              stale={stale}
              busy={busy}
              evalFailures={evalFailures}
              finished={finished}
              error={error}
              canCheck={!busy}
              onCheck={() => void runCheck()}
              onProceed={() => void proceed()}
              onRetry={resetAll}
              onExclude={exclude}
            />
          ) : (
            <p className="text-[15px] text-muted-foreground">The check runs once a CSV and the set-up are ready.</p>
          )}
        </StepSection>
      </ol>
    </Page>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function StepSection({
  n,
  title,
  state,
  last,
  children,
  itemRef,
}: {
  n: number
  title: string
  state: "done" | "current" | "upcoming"
  last?: boolean
  children: ReactNode
  itemRef?: React.Ref<HTMLLIElement>
}) {
  return (
    <li ref={itemRef} className="grid scroll-mt-24 grid-cols-[2.25rem_minmax(0,1fr)] gap-x-4 sm:grid-cols-[2.75rem_minmax(0,1fr)] sm:gap-x-6">
      <div className="flex flex-col items-center" aria-hidden>
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full border-2 font-heading text-lg font-bold sm:size-11 sm:text-xl",
            state === "done" && "border-primary bg-primary text-primary-foreground",
            state === "current" && "border-primary-ink bg-card text-primary-ink",
            state === "upcoming" && "border-border bg-card text-muted-foreground",
          )}
        >
          {state === "done" ? <Check className="size-5" strokeWidth={2.5} /> : n}
        </span>
        {/* A depth scale, like the one beside an ultrasound image, joins the steps. */}
        {!last && (
          <span className="relative my-2 w-2 flex-1">
            <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
            <span className="absolute inset-0 bg-[repeating-linear-gradient(to_bottom,var(--color-input)_0_1px,transparent_1px_16px)]" />
          </span>
        )}
      </div>
      <section aria-label={`Step ${n}: ${title}`} className={cn("min-w-0", last ? "pb-4" : "pb-12")}>
        <h2
          className={cn(
            "mb-5 pt-1 font-heading text-[1.6rem] font-semibold leading-tight tracking-[-0.01em] sm:pt-1.5",
            state === "upcoming" && "text-muted-foreground",
          )}
        >
          <span className="sr-only">Step {n}: </span>
          {title}
        </h2>
        <div className="rounded-xl border bg-card px-5 py-6 sm:px-7">{children}</div>
      </section>
    </li>
  )
}
