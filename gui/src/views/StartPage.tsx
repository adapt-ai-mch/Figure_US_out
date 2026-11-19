// The start page: the image-stream hero, FigureUS(out), and one liquid-glass button per task.
import { useSyncExternalStore, type SVGProps } from "react"
import { Building2, ChevronDown, Globe, History } from "lucide-react"

import { FanLogo } from "@/components/app-chrome"
import { DropdownNavigation, type NavItem } from "@/components/ui/dorpdown-navigation"
import { ImageStreamHero, type StreamImage } from "@/components/ui/image-stream-hero"
import { LiquidButton } from "@/components/ui/liquid-glass-button"
import { href } from "@/lib/router"
import { TASKS, type TaskKey } from "@/lib/tasks"
import { cn } from "@/lib/utils"

// Test-set icons in the test-set colours: navy = Internal Test, ochre = External Test.
const InternalIcon = (props: SVGProps<SVGSVGElement>) => <Building2 {...props} style={{ color: "var(--internal)" }} />
const ExternalIcon = (props: SVGProps<SVGSVGElement>) => <Globe {...props} style={{ color: "var(--external)" }} />

type Mode = "standard" | "fgr"

/** Internal and External test set, each opening the task with that test set already chosen. */
function testSets(task: TaskKey, mode?: Mode) {
  const link = (test: "internal" | "external") =>
    href(`/task/${task}?${mode ? `mode=${mode}&` : ""}test=${test}`)
  return [
    { label: "Internal test set", description: "Titled Internal Test", icon: InternalIcon, href: link("internal") },
    { label: "External test set", description: "Titled External Test", icon: ExternalIcon, href: link("external") },
  ]
}

const recent = (task: TaskKey) => ({
  title: "Results",
  items: [{ label: "Open a recent run", description: "Saved on this computer", icon: History, href: href(`/runs/${task}`) }],
})

// What each task's dropdown offers once its liquid-glass button is clicked.
const TASK_MENUS: Record<TaskKey, NavItem["subMenus"]> = {
  classification: [
    { title: "Standard", items: testSets("classification", "standard") },
    { title: "FGR", items: testSets("classification", "fgr") },
    recent("classification"),
  ],
  regression: [{ title: "Evaluate", items: testSets("regression") }, recent("regression")],
  detection: [{ title: "Evaluate", items: testSets("detection") }, recent("detection")],
  segmentation: [{ title: "Evaluate", items: testSets("segmentation") }, recent("segmentation")],
}

// One dropdown per task; the id maps back to TASKS (id - 1).
const NAV_ITEMS: NavItem[] = TASKS.map((t, i) => ({ id: i + 1, label: t.label, subMenus: TASK_MENUS[t.key] }))

// Plots FigureUS(out) made from synthetic data, and three example ultrasound frames
// (segmentation overlay, detection boxes, fetal head) with no identifying text or file metadata.
// Bundled in public/hero so the app works offline.
const HERO_IMAGES: StreamImage[] = Array.from({ length: 9 }, (_, i) => ({
  src: `/hero/card_${String(i + 1).padStart(2, "0")}.jpg`,
}))

// Soft light wash behind the title and the buttons, so text stays readable over the cards.
const SCRIM =
  "radial-gradient(ellipse 46% 30% at 50% 20%, rgb(248 250 252 / 0.97) 0%, rgb(248 250 252 / 0.9) 55%, rgb(248 250 252 / 0) 100%)," +
  "radial-gradient(ellipse 56% 22% at 50% 85%, rgb(248 250 252 / 0.95) 0%, rgb(248 250 252 / 0.82) 55%, rgb(248 250 252 / 0) 100%)"

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

export function StartPage() {
  const narrow = useNarrowScreen()

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
            <h1 className="font-heading text-[clamp(2.6rem,7.5vw,6.5rem)] font-bold leading-[0.98] tracking-[-0.03em] text-brand">
              FigureUS(out)
            </h1>
            <p className="-mt-1 text-balance font-heading text-[clamp(1.15rem,2.2vw,1.6rem)] italic tracking-[-0.005em] text-primary">
              because every model has a story to plot...
            </p>
          </div>

          <div className="flex flex-col items-center gap-[18px]">
            <h2 id="task-question" className="text-xl font-semibold">
              Which task do you want to evaluate?
            </h2>
            {/* The menus open upward: the hero clips anything below its bottom edge. */}
            <DropdownNavigation
              aria-label="Choose a task"
              navItems={NAV_ITEMS}
              side="top"
              align="center"
              listClassName="flex-wrap justify-center gap-x-[18px] gap-y-3.5"
              renderTrigger={(item, { open, toggle, menuId }) => {
                const t = TASKS[item.id - 1]
                return (
                  <LiquidButton
                    aria-label={t.label}
                    aria-expanded={open}
                    aria-haspopup="true"
                    aria-controls={open ? menuId : undefined}
                    onClick={toggle}
                    className="overflow-hidden rounded-full bg-white/70 text-base font-semibold text-primary aria-expanded:bg-secondary aria-expanded:ring-2 aria-expanded:ring-primary"
                  >
                    <span className="inline-flex items-center gap-2.5">
                      <t.icon aria-hidden className="size-5" />
                      {t.label}
                      <ChevronDown
                        aria-hidden
                        className={cn("size-4 transition-transform duration-300", open && "rotate-180")}
                      />
                    </span>
                  </LiquidButton>
                )
              }}
            />
            <a href={href("/runs")} className="flex min-h-11 items-center gap-2 rounded-md px-2 text-[15px] font-medium text-primary hover:underline">
              <History aria-hidden className="size-[18px]" />
              Recent runs
            </a>
          </div>
        </div>
      </ImageStreamHero>

      <section
        aria-label="What each task needs"
        className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 lg:grid-cols-4"
      >
        {TASKS.map((t) => (
          <div key={t.key} className="flex flex-col gap-1 bg-card px-5 py-4">
            <span className="font-semibold">{t.label}</span>
            <span className="text-sm text-foreground/80">{t.reports}</span>
            <span className="text-[13px] [overflow-wrap:anywhere] text-muted-foreground">
              CSV needs {t.columns.filter((c) => !c.optional).map((c) => c.name).join(", ")}
            </span>
          </div>
        ))}
      </section>
    </main>
  )
}
