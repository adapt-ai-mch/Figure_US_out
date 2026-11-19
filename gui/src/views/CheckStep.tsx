// Step 3: what evaluate.py found when it checked the CSV, and the cohort confirmation (Proceed / Retry).
import { ArrowRight, Download, RotateCcw, Users } from "lucide-react"

import { Btn, BtnLink, Note, Progress } from "@/components/form"
import { api, type RunView } from "@/lib/api"

type Props = {
  check: RunView | null
  stale: boolean
  busy: { kind: "check" | "evaluate"; progress: RunView["progress"] } | null
  evalFailure: RunView | null
  error: string | null
  canCheck: boolean
  onCheck: () => void
  onProceed: () => void
  onRetry: () => void
  onExclude: () => void
}

export function CheckStep(p: Props) {
  const c = p.check
  return (
    <div className="flex flex-col gap-5">
      {!c && !p.busy && (
        <p className="max-w-[66ch] text-[15px] text-muted-foreground">
          evaluate.py reads every row and file, reports any problem by CSV line, and counts the cohort. Nothing is
          calculated until you confirm the counts.
        </p>
      )}
      {p.stale && !p.busy && <Note>Your choices changed after the last check. Check the CSV again.</Note>}

      {(!c || p.stale) && !p.busy && (
        <div>
          <Btn onClick={p.onCheck} disabled={!p.canCheck}>
            Check the CSV
            <ArrowRight aria-hidden />
          </Btn>
        </div>
      )}

      {p.busy && (
        <div className="max-w-xl rounded-lg border bg-card px-5 py-4">
          <Progress
            step={p.busy.progress?.step ?? 1}
            total={p.busy.progress?.total ?? 6}
            label={p.busy.progress?.label ?? (p.busy.kind === "check" ? "Starting the check" : "Starting the evaluation")}
          />
          {p.busy.kind === "evaluate" && (
            <p className="mt-3 text-sm text-muted-foreground">
              The bootstrap (1000 replicates) can take a minute for large files.
            </p>
          )}
        </div>
      )}

      {p.error && <Note tone="error">{p.error}</Note>}

      {c && !p.stale && !p.busy && <CheckResult {...p} check={c} />}
    </div>
  )
}

function CheckResult({ check: c, evalFailure, onProceed, onRetry, onExclude }: Props & { check: RunView }) {
  if (c.status === "ok" && c.cohort) {
    const k = c.cohort
    const rows = [
      ...(k.observations !== k.total_participants ? [[cap(k.observation_unit), k.observations] as const] : []),
      ["Rows in CSV", k.rows_in_csv] as const,
      ...(k.rows_excluded ? [["Rows excluded after validation", k.rows_excluded] as const] : []),
    ]
    return (
      <div className="flex flex-col gap-4">
        <section
          aria-labelledby="cohort-heading"
          className="max-w-xl overflow-hidden rounded-xl border-2 border-primary/80 bg-card shadow-[0_1px_0_rgb(15_23_42/0.04)]"
        >
          <div className="flex items-center gap-3 border-b bg-secondary/60 px-5 py-3">
            <Users aria-hidden className="size-5 text-primary" />
            <h3 id="cohort-heading" className="font-semibold text-primary">
              Confirm the cohort
            </h3>
          </div>
          <div className="flex flex-col gap-4 px-5 py-5">
            <p className="font-heading text-3xl font-bold tracking-[-0.01em]">
              Total participants: {k.total_participants}
            </p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-[15px]">
              {rows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-right font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
            {Object.keys(k.column_mapping).length > 0 && (
              <p className="text-sm text-muted-foreground">
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
            <p className="text-sm text-muted-foreground">Proceed if these counts match your study. Retry returns to choosing the CSV.</p>
            <div className="flex flex-wrap gap-3">
              <Btn onClick={onProceed}>
                Proceed
                <ArrowRight aria-hidden />
              </Btn>
              <Btn variant="outline" onClick={onRetry}>
                <RotateCcw aria-hidden />
                Retry
              </Btn>
            </div>
          </div>
        </section>
        {evalFailure && <Failure view={evalFailure} />}
      </div>
    )
  }

  if (c.status === "invalid" && c.issues) {
    const i = c.issues
    return (
      <div className="flex flex-col gap-4">
        <Note tone="warning" title={`${i.total} ${i.total === 1 ? "problem" : "problems"} on ${i.rows_affected} ${i.rows_affected === 1 ? "row" : "rows"}`}>
          <p>No row is dropped silently. Fix the CSV and check it again, or exclude exactly these rows.</p>
        </Note>
        <div className="max-h-[420px] overflow-auto rounded-lg border bg-card">
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
            Choose another CSV
          </Btn>
          <BtnLink variant="ghost" href={api.fileUrl(c.run_id, i.sheet, true)} download>
            <Download aria-hidden />
            Problems sheet (.csv)
          </BtnLink>
        </div>
      </div>
    )
  }

  if (c.status === "needs_input") {
    return <Note title="One more choice is needed">The highlighted question above says what evaluate.py needs. Answer it, then check again.</Note>
  }

  return <Failure view={c} />
}

function Failure({ view }: { view: RunView }) {
  const title =
    view.status === "missing_column"
      ? "A column is missing"
      : view.status === "retry"
        ? "The CSV changed"
        : view.status === "needs_input"
          ? "One more choice is needed"
          : "evaluate.py stopped"
  return (
    <Note tone="error" title={title}>
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
