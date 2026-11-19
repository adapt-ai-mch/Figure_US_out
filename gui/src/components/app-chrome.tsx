// Shared chrome for the inner screens: the FigureUS(out) mark, a way back to the tasks, recent runs.
import type { ReactNode, SVGProps } from "react"
import { History } from "lucide-react"

import { href } from "@/lib/router"
import { cn } from "@/lib/utils"

/** The FigureUS(out) mark: an ultrasound fan with a measurement cross. */
export function FanLogo(props: SVGProps<SVGSVGElement>) {
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

/** Top bar; its bottom edge takes the test-set colour once the test set is known. */
export function AppHeader({ accent }: { accent?: string }) {
  return (
    <header
      className="sticky top-0 z-30 border-b-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      style={{ borderBottomColor: accent ?? "var(--border)" }}
    >
      <div className="mx-auto flex h-16 max-w-[1240px] items-center justify-between gap-4 px-4 sm:px-6">
        <a
          href={href("/")}
          className="flex min-h-11 items-center gap-2.5 rounded-md text-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
        >
          <FanLogo className="size-8" />
          <span className="font-heading text-xl font-bold tracking-[-0.02em] text-brand">FigureUS(out)</span>
          <span className="sr-only">: back to the tasks</span>
        </a>
        <a
          href={href("/runs")}
          className="flex min-h-11 items-center gap-2 rounded-md px-2 text-[15px] font-medium text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/40"
        >
          <History aria-hidden className="size-[18px]" />
          Recent runs
        </a>
      </div>
    </header>
  )
}

export function Page({ children, className, accent }: { children: ReactNode; className?: string; accent?: string }) {
  return (
    <>
      <AppHeader accent={accent} />
      <main className={cn("mx-auto w-full max-w-[1240px] px-4 pt-8 pb-20 sm:px-6", className)}>{children}</main>
    </>
  )
}
