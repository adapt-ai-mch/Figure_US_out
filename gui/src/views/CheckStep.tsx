// Step 3: what evaluate.py found when it checked each CSV, and the cohort confirmation (Proceed / Retry).
import { ArrowRight, Download, RotateCcw, Users } from "lucide-react"

import { TestSetIcon } from "@/components/app-chrome"
import { Btn, BtnLink, Note, Progress } from "@/components/form"
import { api, type RunView } from "@/lib/api"
import { TEST_SET } from "@/lib/tasks"
import type { TestSetKey } from "@/views/workspace-model"

export type Busy = { kind: "check" | "evaluate"; testSet: TestSetKey; progress: RunView["progress"] }

type Props = {
  /** The test sets with a CSV, in order. */
  loaded: TestSetKey[]
  /** The latest check of each test set, when it still matches the current choices. */
  checks: Partial<Record<TestSetKey, RunView>>
  stale: boolean
  busy: Busy | null
  evalFailures: Partial<Record<TestSetKey, RunView>>
  /** Evaluations that finished while another one failed. */
  finished: Partial<Record<TestSetKey, string>>
  error: string | null
  canCheck: boolean
  onCheck: () => void
  onProceed: () => void
  onRetry: () => void
  onExclude: (testSet: TestSetKey) => void
}

const SET_NAME: Record<TestSetKey, string> = { internal: "Internal test set", external: "External test set" }

export function CheckStep(p: Props) {
  const both = p.loaded.length > 1
  const checked = p.loaded.filter((k) => p.checks[k])
  const allOk = p.loaded.length > 0 && p.loaded.every((k) => p.checks[k]?.status === "ok")
  const showButton = !p.busy && (p.stale || checked.length < p.loaded.length)

  return (
    <div className="flex flex-col gap-5">
      {checked.length === 0 && !p.busy && (
        <p className="max-w-[66ch] text-[15px] text-muted-foreground">
          evaluate.py reads every row and file of {both ? "each CSV" : "the CSV"}, reports any problem by CSV line,
          and counts the cohort. Nothing is calculated until you confirm the counts.
        </p>
      )}
      {p.stale && !p.busy && <Note>Your choices changed after the last check. Check again.</Note>}

      {showButton && (
        <div>
          <Btn onClick={p.onCheck} disabled={!p.canCheck}>
            {both ? "Check both CSVs" : "Check the CSV"}
            <ArrowRight aria-hidden />
          </Btn>
        </div>
      )}

      {p.busy && (
        <div className="max-w-xl rounded-lg border bg-card px-5 py-4">
          <p className="mb-3 flex items-center gap-2 text-[15px] font-semibold" style={{ color: TEST_SET[p.busy.testSet].color }}>
            <TestSetIcon testSet={p.busy.testSet} className="size-[18px]" />
            {SET_NAME[p.busy.testSet]}
          </p>
          <Progress
            step={p.busy.progress?.step ?? 1}
            total={p.busy.progress?.total ?? 6}
            label={p.busy.progress?.label ?? (p.busy.kind === "check" ? "Starting the check" : "Starting the evaluation")}
          />
          {p.busy.kind === "evaluate" && (
            <p className="mt-3 text-sm text-muted-foreground">
              The bootstrap (1000 replicates) can take a minute for large files.
              {both && " The internal test set runs first, then the external."}
            </p>
          )}
        </div>
      )}

      {p.error && <Note tone="error">{p.error}</Note>}

      {!p.stale && checked.length > 0 && (
        <div className={both ? "grid grid-cols-1 gap-5 lg:grid-cols-2" : "flex flex-col gap-5"}>
          {checked.map((k) => (
            <CheckResult key={k} testSet={k} view={p.checks[k]!} onExclude={() => p.onExclude(k)} onRetry={p.onRetry} />
          ))}
        </div>
      )}

      {!p.stale && allOk && !p.busy && (
        <div className="flex flex-col gap-3 border-t pt-5">
          <p className="text-[15px]">
            Proceed if {both ? "these counts match" : "this count matches"} your study. Retry returns to choosing the
            CSV{both ? "s" : ""}.
          </p>
          <div className="flex flex-wrap gap-3">
            <Btn onClick={p.onProceed}>
              Proceed
              <ArrowRight aria-hidden />
            </Btn>
            <Btn variant="outline" onClick={p.onRetry}>
              <RotateCcw aria-hidden />
              Retry
            </Btn>
          </div>
        </div>
      )}

      {p.loaded
        .filter((k) => p.evalFailures[k])
        .map((k) => (
          <Failure key={k} view={p.evalFailures[k]!} testSet={k} />
        ))}
      {Object.entries(p.finished).map(([k, runId]) => (
        <Note key={k} title={`${SET_NAME[k as TestSetKey]}: evaluated`}>
          <a className="font-medium underline" href={`#/results/${runId}`}>
            Open its results
          </a>
        </Note>
      ))}
    </div>
  )
}

function CheckResult({
  testSet,
  view: c,
  onExclude,
  onRetry,
}: {
  testSet: TestSetKey
  view: RunView
  onExclude: () => void
  onRetry: () => void
}) {
  const color = TEST_SET[testSet].color
  const heading = (
    <p className="flex items-center gap-2 text-[15px] font-semibold" style={{ color }}>
      <TestSetIcon testSet={testSet} className="size-[18px]" />
      {SET_NAME[testSet]}
    </p>
  )

  if (c.status === "ok" && c.cohort) {
    const k = c.cohort
    const rows = [
      ...(k.observations !== k.total_participants ? [[cap(k.observation_unit), k.observations] as const] : []),
      ["Rows in CSV", k.rows_in_csv] as const,
      ...(k.rows_excluded ? [["Rows excluded after validation", k.rows_excluded] as const] : []),
    ]
    return (
      <section
        aria-label={`${SET_NAME[testSet]}: cohort`}
        className="overflow-hidden rounded-xl border-2 bg-card"
        style={{ borderColor: color }}
      >
        <div className="flex items-center justify-between gap-3 border-b bg-muted/60 px-5 py-3">
          {heading}
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Users aria-hidden className="size-4" />
            Confirm the cohort
          </span>
        </div>
        <div className="flex flex-col gap-4 px-5 py-5">
          <p className="font-heading text-3xl font-bold tracking-[-0.01em]">Total participants: {k.total_participants}</p>
          <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-[15px]">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
          {Object.keys(k.column_mapping).length > 0 && (
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
              Columns used:{" "}
              {Object.entries(k.column_mapping)
                .map(([name, col]) => `${name} = ${col}`)
                .join(", ")}
            </p>
          )}
          {k.notices.map((n) => (
            <Note key={n} tone="warning">
              {n}
            </Note>
          ))}
        </div>
      </section>
    )
  }

  if (c.status === "invalid" && c.issues) {
    const i = c.issues
    return (
      <section aria-label={`${SET_NAME[testSet]}: problems`} className="flex min-w-0 flex-col gap-3">
        {heading}
        <Note
          tone="warning"
          title={`${i.total} ${i.total === 1 ? "problem" : "problems"} on ${i.rows_affected} ${i.rows_affected === 1 ? "row" : "rows"}`}
        >
          <p>No row is dropped silently. Fix the CSV and check it again, or exclude exactly these rows.</p>
        </Note>
        <div className="max-h-[360px] overflow-auto rounded-lg border bg-card">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Problems found, by CSV line</caption>
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">CSV line</th>
                <th scope="col" className="px-3 py-2 font-semibold">Column</th>
                <th scope="col" className="px-3 py-2 font-semibold">Problem</th>
                <th scope="col" className="px-3 py-2 font-semibold">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {i.rows.map((r, n) => (
                <tr key={n}>
                  <td className="px-3 py-2 tabular-nums">{r.csv_line}</td>
                  <td className="px-3 py-2 font-mono text-[13px]">{r.column}</td>
                  <td className="px-3 py-2">{r.issue}</td>
                  <td className="px-3 py-2 text-muted-foreground [overflow-wrap:anywhere]">{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {i.total > i.rows.length && (
          <p className="text-sm text-muted-foreground">
            The first {i.rows.length} problems are shown; the sheet has all {i.total}.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Btn onClick={onExclude}>Exclude these {i.rows_affected} rows and check again</Btn>
          <Btn variant="outline" onClick={onRetry}>
            <RotateCcw aria-hidden />
            Choose other CSVs
          </Btn>
          <BtnLink variant="ghost" href={api.fileUrl(c.run_id, i.sheet, true)} download>
            <Download aria-hidden />
            Problems sheet (.csv)
          </BtnLink>
        </div>
      </section>
    )
  }

  if (c.status === "needs_input") {
    return (
      <section aria-label={`${SET_NAME[testSet]}: question`} className="flex flex-col gap-3">
        {heading}
        <Note title="One more choice is needed">
          The highlighted question above says what evaluate.py needs. Answer it, then check again.
        </Note>
      </section>
    )
  }

  return <Failure view={c} testSet={testSet} />
}

function Failure({ view, testSet }: { view: RunView; testSet: TestSetKey }) {
  const what =
    view.status === "missing_column"
      ? "a column is missing"
      : view.status === "retry"
        ? "the CSV changed"
        : view.status === "needs_input"
          ? "one more choice is needed"
          : "evaluate.py stopped"
  return (
    <Note tone="error" title={`${SET_NAME[testSet]}: ${what}`}>
      <p className="whitespace-pre-line">{view.message}</p>
      {view.log_tail && view.log_tail.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-sm font-medium">End of the log</summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap text-foreground">
            {view.log_tail.join("\n")}
          </pre>
        </details>
      )}
    </Note>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
