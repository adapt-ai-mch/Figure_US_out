// The start page: the image-stream hero; FigureUS(out) appears first, the tagline a second later, then one
// image badge per task (its plots fan out on hover). Each badge opens that task's CSV page.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { motion, useReducedMotion, type Transition } from "framer-motion"
import { History } from "lucide-react"

import { FanLogo, ThemeSwitch } from "@/components/app-chrome"
import { ImageStreamHero, type StreamImage } from "@/components/ui/image-stream-hero"
import { ImagesBadge, type BadgeImage } from "@/components/ui/images-badge"
import { go, href } from "@/lib/router"
import { TASKS, type TaskKey } from "@/lib/tasks"

// Plots FigureUS(out) made from synthetic data, and three example ultrasound frames
// (segmentation overlay, detection boxes, fetal head) with no identifying text or file metadata.
// Bundled in public/hero so the app works offline.
const HERO_IMAGES: StreamImage[] = Array.from({ length: 9 }, (_, i) => ({
  src: `/hero/card_${String(i + 1).padStart(2, "0")}.jpg`,
}))

// Thumbnails in public/tasks: crops of FigureUS(out) plots made from synthetic data and of the three
// example frames above. Decorative (empty alt): each badge is named by its task.
const thumbs = (task: TaskKey, order: number[]): BadgeImage[] =>
  order.map((n) => ({ src: `/tasks/${task}-${n}.jpg`, alt: "" }))
const TASK_IMAGES: Record<TaskKey, BadgeImage[]> = {
  classification: thumbs("classification", [1, 2, 3, 4, 5]), // ROC, PR, confusion matrix, calibration, decision curve
  regression: thumbs("regression", [1, 4, 2, 3]), // Bland-Altman, fetal head, predicted vs true, calibration
  detection: thumbs("detection", [1, 2]), // detection boxes, close-up
  segmentation: thumbs("segmentation", [1, 2, 3]), // mask on image, overlay, mask example
}

// Soft wash in the page colour (--scrim, light or dark) behind the title and the buttons,
// so text stays readable over the cards.
const SCRIM =
  "radial-gradient(ellipse 46% 30% at 50% 20%, rgb(var(--scrim) / 0.97) 0%, rgb(var(--scrim) / 0.9) 55%, rgb(var(--scrim) / 0) 100%)," +
  "radial-gradient(ellipse 56% 22% at 50% 85%, rgb(var(--scrim) / 0.95) 0%, rgb(var(--scrim) / 0.82) 55%, rgb(var(--scrim) / 0) 100%)"

const EASE = [0.22, 1, 0.36, 1] as const

// Seconds after the page opens: the name at once, the tagline a second later, then the tasks.
const AT = { name: 0.15, tagline: 1.3, tasks: 2.3 }

// The intro plays when the app is opened, not again when coming back to this page from another screen.
let introPlayed = false

/** Fade up out of a soft blur after `delay` seconds; when the intro is not playing, it is simply there. */
function appear(play: boolean, delay: number) {
  if (!play) return {}
  return {
    initial: { opacity: 0, y: 16, filter: "blur(8px)" },
    animate: { opacity: 1, y: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } },
    transition: { delay, duration: 0.9, ease: EASE } satisfies Transition,
  }
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

export function StartPage() {
  const narrow = useNarrowScreen()
  const reduced = useReducedMotion()
  const [play] = useState(() => !introPlayed && !reduced)
  useEffect(() => {
    introPlayed = true
  }, [])

  // The corridor's axis goes in the middle of the gap between the title and the tasks, wherever that falls
  // (on a phone the hero grows with its content). Layout offsets, so the intro's movement is ignored.
  const heroRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const tasksRef = useRef<HTMLDivElement>(null)
  const [gapAxis, setGapAxis] = useState<number | null>(null)
  useLayoutEffect(() => {
    const hero = heroRef.current
    const top = topRef.current
    const tasks = tasksRef.current
    if (!hero || !top || !tasks) return
    const content = top.offsetParent as HTMLElement
    const observer = new ResizeObserver(() => {
      const middle = content.offsetTop + (top.offsetTop + top.offsetHeight + tasks.offsetTop) / 2
      setGapAxis(Math.round((middle / hero.offsetHeight) * 1000) / 10)
    })
    observer.observe(hero)
    return () => observer.disconnect()
  }, [narrow])

  return (
    <main className="mx-auto flex min-h-svh max-w-[1440px] flex-col gap-6 p-4 sm:p-6">
      <ImageStreamHero
        ref={heroRef}
        images={HERO_IMAGES}
        axis={gapAxis ?? (narrow ? 42 : 55)}
        aria-labelledby="task-question"
        className="w-full rounded-xl border border-border bg-background sm:h-[min(720px,calc(100svh-2rem))] sm:min-h-[600px]"
      >
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: SCRIM }} />
        <ThemeSwitch className="absolute top-3 right-3 z-20 sm:top-4 sm:right-4" />
        {/* On a phone the hero grows with its content; the large gap leaves room for the corridor. */}
        <div className="relative z-10 flex h-full flex-col items-center justify-between gap-44 px-6 py-11 text-center sm:gap-6">
          <div ref={topRef} className="flex flex-col items-center gap-3">
            <motion.div {...appear(play, AT.name)} className="flex flex-col items-center gap-3">
              <FanLogo className="size-14 text-primary" />
              <h1 className="font-heading text-[clamp(2.6rem,7.5vw,6.5rem)] font-bold leading-[0.98] tracking-[-0.03em] text-brand">
                FigureUS(out)
              </h1>
            </motion.div>
            <motion.p
              {...appear(play, AT.tagline)}
              className="-mt-1 text-balance font-heading text-[clamp(1.15rem,2.2vw,1.6rem)] italic tracking-[-0.005em] text-primary"
            >
              because every model has a story to plot...
            </motion.p>
          </div>

          <div ref={tasksRef} className="flex w-full flex-col items-center gap-[18px]">
            <motion.h2 {...appear(play, AT.tasks)} id="task-question" className="text-xl font-semibold">
              Which task do you want to evaluate?
            </motion.h2>
            {/* Each task opens its CSV page directly. Fixed grid cells, so a badge fanning out on hover
                never pushes the others around. */}
            <nav aria-label="Choose a task" className="w-full max-w-[640px]">
              <ul className="grid grid-cols-1 justify-items-center gap-x-6 gap-y-3.5 sm:grid-cols-2">
                {TASKS.map((t, i) => (
                  <motion.li key={t.key} {...appear(play, AT.tasks + 0.15 + i * 0.1)} className="relative hover:z-10 focus-within:z-10">
                    <ImagesBadge
                      images={TASK_IMAGES[t.key]}
                      label={t.label}
                      onClick={() => go(`/task/${t.key}`)}
                      className="h-12 pr-5 text-[15px] outline-none focus-visible:ring-3 focus-visible:ring-ring/60 dark:border-border dark:bg-card/85"
                      imageClassName="dark:border-card"
                    />
                  </motion.li>
                ))}
              </ul>
            </nav>
            <motion.a
              {...appear(play, AT.tasks + 0.6)}
              href={href("/runs")}
              className="flex min-h-11 items-center gap-2 rounded-md px-2 text-[15px] font-medium text-primary hover:underline"
            >
              <History aria-hidden className="size-[18px]" />
              Recent runs
            </motion.a>
          </div>
        </div>
      </ImageStreamHero>

      <motion.section
        {...appear(play, AT.tasks + 0.6)}
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
      </motion.section>
    </main>
  )
}
