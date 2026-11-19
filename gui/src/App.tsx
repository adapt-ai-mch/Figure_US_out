import { useState, useSyncExternalStore, type SVGProps } from "react"
import { ChartScatter, ScanSearch, Shapes, Split, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ImageStreamHero, type StreamImage } from "@/components/ui/image-stream-hero"
import { LiquidButton } from "@/components/ui/liquid-glass-button"

type TaskKey = "classification" | "regression" | "detection" | "segmentation"

type Task = {
  key: TaskKey
  label: string
  icon: LucideIcon
  /** What evaluate.py reports for this task. */
  reports: string
  /** Columns the predictions CSV must have (names are exact and lower-case). */
  needs: string
}

const TASKS: Task[] = [
  {
    key: "classification",
    label: "Classification",
    icon: Split,
    reports: "Standard or FGR. ROC, precision-recall, calibration and decision curves.",
    needs: "record_id, true_label, pred_label, pred_prob",
  },
  {
    key: "regression",
    label: "Regression",
    icon: ChartScatter,
    reports: "MAE, RMSE and Bland-Altman agreement, in days for weeks input.",
    needs: "record_id, true, pred",
  },
  {
    key: "detection",
    label: "Object detection",
    icon: ScanSearch,
    reports: "Precision and recall on reviewed frames, with overlay videos.",
    needs: "record_id, true_xml, pred_xml",
  },
  {
    key: "segmentation",
    label: "Segmentation",
    icon: Shapes,
    reports: "Dice and IoU, with masks drawn over the original image.",
    needs: "record_id, true_mask, pred_mask",
  },
]

// Figures and ultrasound-style frames that Figure US out itself produces, made from
// synthetic data only (no study data). Bundled in public/hero so the app works offline.
const HERO_IMAGES: StreamImage[] = Array.from({ length: 9 }, (_, i) => ({
  src: `/hero/card_${String(i + 1).padStart(2, "0")}.jpg`,
}))

// Soft light wash behind the title and the buttons, so text stays readable over the cards.
const SCRIM =
  "radial-gradient(ellipse 46% 30% at 50% 20%, rgb(248 250 252 / 0.97) 0%, rgb(248 250 252 / 0.9) 55%, rgb(248 250 252 / 0) 100%)," +
  "radial-gradient(ellipse 56% 22% at 50% 85%, rgb(248 250 252 / 0.95) 0%, rgb(248 250 252 / 0.82) 55%, rgb(248 250 252 / 0) 100%)"

/** The Figure US out mark: an ultrasound fan with a measurement cross. */
function FanLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden {...props}>
      <path d="M18 5 L5 29" />
      <path d="M18 5 L31 29" />
      <path d="M9 22.5 Q18 27 27 22.5" />
      <path d="M6.6 27 Q18 33 29.4 27" />
      <path d="M14 15 h8 M18 11 v8" strokeWidth={1.4} />
    </svg>
  )
}

const NARROW = "(max-width: 639px)"

/** True on phone-width screens, where the hero stacks its content and needs a higher vanishing point. */
function useNarrowScreen() {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(NARROW)
      query.addEventListener("change", onChange)
      return () => query.removeEventListener("change", onChange)
    },
    () => window.matchMedia(NARROW).matches,
    () => false,
  )
}

export default function App() {
  const [selected, setSelected] = useState<TaskKey | null>(null)
  const narrow = useNarrowScreen()
  const task = TASKS.find((t) => t.key === selected)

  return (
    <main className="mx-auto flex min-h-svh max-w-[1440px] flex-col gap-6 p-4 sm:p-6">
      <ImageStreamHero
        images={HERO_IMAGES}
        axis={narrow ? 42 : 55}
        aria-labelledby="task-question"
        className="w-full rounded-xl border border-border bg-background sm:h-[min(720px,calc(100svh-2rem))] sm:min-h-[600px]"
      >
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: SCRIM }} />
        {/* On a phone the hero grows with its content; the large gap leaves room for the corridor. */}
        <div className="relative z-10 flex h-full flex-col items-center justify-between gap-44 px-6 py-11 text-center sm:gap-6">
          <div className="flex flex-col items-center gap-3">
            <FanLogo className="size-14 text-primary" />
            <h1 className="font-heading text-[clamp(2.6rem,7.5vw,6.5rem)] font-bold leading-[0.98] tracking-[-0.03em] text-foreground">
              Figure US out
            </h1>
            <p className="max-w-[52ch] text-balance text-lg text-foreground/90">
              Evaluate saved ultrasound model predictions on this Mac. evaluate.py calculates every number, and
              nothing leaves the computer.
            </p>
          </div>

          <div className="flex flex-col items-center gap-[18px]">
            <h2 id="task-question" className="text-xl font-semibold">
              Which task do you want to evaluate?
            </h2>
            <div className="flex flex-wrap justify-center gap-x-[18px] gap-y-3.5">
              {TASKS.map((t) => (
                <LiquidButton
                  key={t.key}
                  aria-pressed={selected === t.key}
                  onClick={() => setSelected(t.key)}
                  className="overflow-hidden rounded-full bg-white/70 text-base font-semibold text-primary aria-pressed:bg-secondary aria-pressed:ring-2 aria-pressed:ring-primary"
                >
                  <span className="inline-flex items-center gap-2.5">
                    <t.icon aria-hidden className="size-5" />
                    {t.label}
                  </span>
                </LiquidButton>
              ))}
            </div>
          </div>
        </div>
      </ImageStreamHero>

      {task ? (
        <section aria-live="polite" className="mx-auto flex w-full max-w-3xl flex-col gap-3 rounded-lg border bg-card p-6">
          <p className="text-sm text-muted-foreground">Task chosen</p>
          <h2 className="font-heading text-2xl font-bold">{task.label}</h2>
          <p>
            Next, choose the predictions CSV. It needs the columns <span className="font-medium">{task.needs}</span>.
          </p>
          <div className="flex flex-wrap gap-3 pt-1">
            <Button size="lg" disabled>
              Choose the CSV (not built yet)
            </Button>
            <Button size="lg" variant="outline" onClick={() => setSelected(null)}>
              Change task
            </Button>
          </div>
        </section>
      ) : null}

      <section
        aria-label="What each task needs"
        className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 lg:grid-cols-4"
      >
        {TASKS.map((t) => (
          <div key={t.key} className="flex flex-col gap-1 bg-card px-5 py-4">
            <span className="font-semibold">{t.label}</span>
            <span className="text-sm text-foreground/80">{t.reports}</span>
            <span className="text-[13px] [overflow-wrap:anywhere] text-muted-foreground">CSV needs {t.needs}</span>
          </div>
        ))}
      </section>
    </main>
  )
}
