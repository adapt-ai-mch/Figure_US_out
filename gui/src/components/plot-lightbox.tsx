// The enlarged plot: a modal over the page, with the page blurred behind it. Esc, the close button or a
// click anywhere outside the plot closes it. With both test sets, the toggle (or ← →) switches between them.
import { useEffect, useRef, type MouseEvent } from "react"
import { useLenis } from "lenis/react"
import { X } from "lucide-react"

import { TEST_SET } from "@/lib/tasks"
import { cn } from "@/lib/utils"

export type LightboxItem = { key: string; src: string; title: string; testSet: "internal" | "external" }

/** True when the click landed on the drawn picture, not on the empty margin object-fit leaves around it. */
function onPicture(e: MouseEvent<HTMLImageElement>) {
  const img = e.currentTarget
  const box = img.getBoundingClientRect()
  if (!img.naturalWidth || !img.naturalHeight) return true
  const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight)
  const w = img.naturalWidth * scale
  const h = img.naturalHeight * scale
  const x = e.clientX - box.left - (box.width - w) / 2
  const y = e.clientY - box.top - (box.height - h) / 2
  return x >= 0 && y >= 0 && x <= w && y <= h
}

export function PlotLightbox({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: LightboxItem[]
  index: number | null
  onIndex: (i: number) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const item = index === null ? undefined : items[index]
  const open = item !== undefined

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  // Keep the page behind still while the plot is open (Lenis would otherwise keep scrolling it).
  const lenis = useLenis()
  useEffect(() => {
    if (!open) return
    const root = document.documentElement
    const before = root.style.overflow
    root.style.overflow = "hidden"
    lenis?.stop()
    return () => {
      root.style.overflow = before
      lenis?.start()
    }
  }, [open, lenis])

  const many = items.length > 1
  const step = (by: number) => {
    if (index !== null) onIndex((index + by + items.length) % items.length)
  }

  return (
    <dialog
      ref={ref}
      aria-label={item?.title ?? "Enlarged plot"}
      // Esc: close through our own state at once. The native "close" event comes later, so one left over
      // from closing the last plot must not close a plot opened since; it only counts if the dialog is shut.
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClose={() => {
        if (!ref.current?.open) onClose()
      }}
      onKeyDown={(e) => {
        if (!many || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return
        e.preventDefault()
        step(e.key === "ArrowRight" ? 1 : -1)
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-dvw max-w-none overflow-hidden bg-transparent p-0 text-foreground backdrop:bg-slate-950/55 backdrop:backdrop-blur-md"
    >
      {item && (
        <div
          className="mx-auto flex h-full w-full max-w-[1600px] flex-col items-center gap-3 p-3 sm:p-6"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose()
          }}
        >
          {/* Title | close; the test-set toggle sits between them, or on its own row on a phone.
              The left edge takes the test-set colour. */}
          <div
            className={cn(
              "grid w-full shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-xl border border-l-4 bg-card/95 py-2 pr-2 pl-4 shadow-lg",
              many && "sm:grid-cols-[minmax(0,1fr)_auto_auto]",
            )}
            style={{ borderLeftColor: TEST_SET[item.testSet].color }}
          >
            <h2 className="font-heading text-lg leading-snug font-semibold [overflow-wrap:anywhere]">{item.title}</h2>
            {many && (
              <div
                role="group"
                aria-label="Test set"
                className="col-span-2 row-start-2 flex gap-1 justify-self-start rounded-lg bg-muted p-1 sm:col-span-1 sm:col-start-2 sm:row-start-1"
              >
                {items.map((it, i) => (
                  <button
                    key={it.key}
                    type="button"
                    aria-pressed={i === index}
                    onClick={() => onIndex(i)}
                    className={cn(
                      "flex min-h-9 cursor-pointer items-center rounded-md px-3 text-sm font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40",
                      i === index && "bg-card shadow-sm",
                    )}
                    style={i === index ? { color: TEST_SET[it.testSet].color } : undefined}
                  >
                    {TEST_SET[it.testSet].label}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              className={cn(
                "col-start-2 row-start-1 flex size-11 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40",
                many && "sm:col-start-3",
              )}
            >
              <X aria-hidden className="size-6" />
              <span className="sr-only">Close the enlarged plot</span>
            </button>
          </div>
          <div
            className="relative min-h-0 w-full flex-1"
            onClick={(e) => {
              if (e.target === e.currentTarget) onClose()
            }}
          >
            <img
              key={item.key}
              src={item.src}
              alt={item.title}
              onClick={(e) => {
                if (!onPicture(e)) onClose()
              }}
              className="absolute inset-0 h-full w-full object-contain drop-shadow-2xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95"
            />
          </div>
          <p className="shrink-0 rounded-full bg-slate-950/60 px-3 py-1 text-center text-[13px] text-white">
            <span className="hidden [@media(hover:hover)]:inline">
              {many ? "← → switch test set · " : ""}Esc or a click outside the plot closes it
            </span>
            <span className="[@media(hover:hover)]:hidden">Tap outside the plot to close it</span>
          </p>
        </div>
      )}
    </dialog>
  )
}
