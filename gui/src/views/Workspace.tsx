// One task, three steps: choose the CSV, set up, check and confirm the cohort. Results open on their own page.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Check } from "lucide-react"

import { Page } from "@/components/app-chrome"
import { api, ApiError, runAndWait, type CsvSummary, type Job, type RunView } from "@/lib/api"
import { go } from "@/lib/router"
import { TASK_BY_KEY, TEST_SET, type TaskKey } from "@/lib/tasks"
import { cn } from "@/lib/utils"
import { CheckStep } from "@/views/CheckStep"
import { DataStep } from "@/views/DataStep"
import { SetupStep } from "@/views/SetupStep"
import { autoMap, emptySetup, missingChoices, needsInputText, toOptions, type Setup } from "@/views/workspace-model"

const DATA_FIELDS = new Set(["columns", "participant_col"])
const message = (e: unknown) => (e instanceof ApiError ? e.message : String(e))

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

export function Workspace({ taskKey, mode }: { taskKey: TaskKey; mode: Setup["mode"] }) {
  const task = TASK_BY_KEY[taskKey]
  const [job, setJob] = useState<Job | null>(null)
  const [csv, setCsv] = useState<string | null>(null)
  const [summary, setSummary] = useState<CsvSummary | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [participant, setParticipant] = useState("")
  const [setup, setSetup] = useState<Setup>(() => emptySetup(mode))
  const [labels, setLabels] = useState<{ col: string; values: string[] | null } | null>(null)
  const [check, setCheck] = useState<{ key: string; view: RunView } | null>(null)
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<{ kind: "check" | "evaluate"; progress: RunView["progress"] } | null>(null)
  const [evalFailure, setEvalFailure] = useState<RunView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempted, setAttempted] = useState(false)
  const checkRef = useRef<HTMLLIElement>(null)

  const options = csv ? toOptions(taskKey, csv, mapping, participant, setup) : null
  const optionsKey = JSON.stringify(options)
  const current = check && check.key === optionsKey ? check.view : null
  const allProblems = missingChoices(taskKey, task.columns, mapping, participant, setup)
  const problems = attempted ? allProblems : {}
  const needs =
    current?.status === "needs_input" && current.field && !DATA_FIELDS.has(current.field)
      ? { field: current.field, text: needsInputText(current.field, current.message ?? "") }
      : null
  const columnMessage =
    current && (current.status === "missing_column" || (current.status === "needs_input" && DATA_FIELDS.has(current.field ?? "")))
      ? needsInputText(current.field, current.message ?? "")
      : null
  const dataDone = !!summary && !Object.keys(allProblems).some((k) => k.startsWith("col:") || k === "columns" || k === "participant")
  const trueCol = taskKey === "classification" ? mapping.true_label : ""

  // Offer the reference labels as choices for the positive label.
  useEffect(() => {
    if (!job || !csv || !trueCol) return
    let live = true
    api
      .labels(job.job_id, csv, trueCol)
      .then((r) => live && setLabels({ col: trueCol, values: r.values }))
      .catch(() => live && setLabels({ col: trueCol, values: null }))
    return () => {
      live = false
    }
  }, [job, csv, trueCol])

  async function chooseCsv(j: Job, name: string) {
    setCsv(name)
    setSummary(null)
    setMapping({})
    setError(null)
    try {
      const s = await api.csvSummary(j.job_id, name)
      setSummary(s)
      setMapping(autoMap(task.columns, s))
    } catch (e) {
      setError(message(e))
    }
  }

  function onJob(j: Job) {
    setJob(j)
    setCheck(null)
    if (j.csv_files.length === 1) void chooseCsv(j, j.csv_files[0])
    else {
      setCsv(null)
      setSummary(null)
    }
  }

  function reset() {
    setJob(null)
    setCsv(null)
    setSummary(null)
    setMapping({})
    setParticipant("")
    setLabels(null)
    setCheck(null)
    setEvalFailure(null)
    setError(null)
    setAttempted(false)
    setSetup((s) => ({ ...s, exclude_invalid: false }))
    window.scrollTo({ top: 0 })
  }

  async function runCheck(opts = options) {
    setAttempted(true)
    if (!job || !opts) return
    const first = Object.keys(allProblems)[0]
    if (first) {
      reveal(
        first.startsWith("col:")
          ? `col-${first.slice(4)}`
          : first === "participant"
            ? "field-participant_col"
            : first === "columns"
              ? "field-columns"
              : `field-${first}`,
      )
      return
    }
    setBusy({ kind: "check", progress: null })
    setError(null)
    setEvalFailure(null)
    try {
      const v = await runAndWait(job.job_id, "check", opts, (progress) => setBusy({ kind: "check", progress }))
      setCheck({ key: JSON.stringify(opts), view: v })
      if (v.status === "needs_input" && v.field) {
        setRevealed((r) => new Set(r).add(v.field!))
        reveal(`field-${v.field}`)
      } else {
        window.setTimeout(() => checkRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 60)
      }
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(null)
    }
  }

  async function proceed() {
    if (!job || !options || !current?.cohort) return
    setBusy({ kind: "evaluate", progress: null })
    setEvalFailure(null)
    setError(null)
    try {
      const v = await runAndWait(
        job.job_id,
        "evaluate",
        options,
        (progress) => setBusy({ kind: "evaluate", progress }),
        current.cohort.cohort_id,
      )
      if (v.status === "ok") go(`/results/${v.run_id}`)
      else setEvalFailure(v)
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(null)
    }
  }

  function exclude() {
    if (!csv) return
    const next = { ...setup, exclude_invalid: true }
    setSetup(next)
    void runCheck(toOptions(taskKey, csv, mapping, participant, next))
  }

  const accent = setup.test_set ? TEST_SET[setup.test_set].color : undefined

  return (
    <Page accent={accent}>
      <div className="mb-10 flex flex-col gap-2">
        <h1 className="font-heading text-[clamp(2rem,4.5vw,3rem)] font-bold leading-tight tracking-[-0.02em]">
          {task.label}
        </h1>
        <p className="max-w-[64ch] text-[17px] text-foreground/80">
          {task.reports} evaluate.py calculates every number on this computer; this page shows what it saved.
        </p>
      </div>

      <ol className="flex max-w-[920px] flex-col">
        <StepSection n={1} title="Choose the predictions CSV" state={dataDone ? "done" : "current"}>
          <DataStep
            task={task}
            job={job}
            csv={csv}
            summary={summary}
            mapping={mapping}
            participant={participant}
            problems={problems}
            columnMessage={columnMessage}
            onJob={onJob}
            onCsv={(name) => job && void chooseCsv(job, name)}
            onReset={reset}
            onMapping={(name, col) => setMapping((m) => ({ ...m, [name]: col }))}
            onParticipant={setParticipant}
          />
          {error && !summary && <p className="mt-4 text-sm font-medium text-destructive">{error}</p>}
        </StepSection>

        <StepSection n={2} title="Set up the evaluation" state={!summary ? "upcoming" : current?.status === "ok" ? "done" : "current"}>
          {summary ? (
            <SetupStep
              task={task}
              setup={setup}
              onChange={(patch) => setSetup((s) => ({ ...s, ...patch }))}
              problems={problems}
              labels={labels && labels.col === trueCol ? labels.values : null}
              needs={needs}
              revealed={revealed}
            />
          ) : (
            <p className="text-[15px] text-muted-foreground">Choose the CSV first.</p>
          )}
        </StepSection>

        <StepSection
          n={3}
          title="Check and confirm the cohort"
          state={!summary ? "upcoming" : "current"}
          last
          itemRef={checkRef}
        >
          {summary ? (
            <CheckStep
              check={current}
              stale={!!check && !current}
              busy={busy}
              evalFailure={evalFailure}
              error={summary ? error : null}
              canCheck={!!job && !!summary && !busy}
              onCheck={() => void runCheck()}
              onProceed={() => void proceed()}
              onRetry={reset}
              onExclude={exclude}
            />
          ) : (
            <p className="text-[15px] text-muted-foreground">The check runs once the CSV and the set-up are ready.</p>
          )}
        </StepSection>
      </ol>
    </Page>
  )
}

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
            state === "current" && "border-primary bg-card text-primary",
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
