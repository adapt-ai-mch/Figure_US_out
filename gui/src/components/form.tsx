// Form pieces for the FigureUS(out) workspace: visible labels, help and errors under each field,
// native controls (keyboard and screen-reader support come for free), 44px touch targets.
import { useId, type ComponentProps, type ReactNode } from "react"
import { AlertTriangle, ChevronDown, Info, XCircle } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type BtnProps = ComponentProps<"button"> & { variant?: "default" | "outline" | "secondary" | "ghost" | "link" }

// The main action on a screen is gold (call to action) with charcoal text.
const CTA = "bg-cta text-cta-foreground hover:bg-cta/85"

/** A shadcn button at a comfortable size; the default variant is the gold call to action. */
export function Btn({ className, variant = "default", type = "button", ...props }: BtnProps) {
  return (
    <button
      type={type}
      className={cn(
        buttonVariants({ variant }),
        "h-11 cursor-pointer gap-2 rounded-lg px-5 text-[15px] font-semibold disabled:cursor-not-allowed [&_svg:not([class*='size-'])]:size-[18px]",
        variant === "default" && CTA,
        className,
      )}
      {...props}
    />
  )
}

/** The same look on a link (downloads, other screens). */
export function BtnLink({
  className,
  variant = "outline",
  ...props
}: ComponentProps<"a"> & { variant?: BtnProps["variant"] }) {
  return (
    <a
      className={cn(
        buttonVariants({ variant }),
        "h-11 gap-2 rounded-lg px-5 text-[15px] font-semibold [&_svg:not([class*='size-'])]:size-[18px]",
        variant === "default" && CTA,
        className,
      )}
      {...props}
    />
  )
}

type FieldProps = {
  label: ReactNode
  help?: ReactNode
  error?: ReactNode
  required?: boolean
  /** id of the control the label is for */
  htmlFor?: string
  children: ReactNode
  className?: string
  /** When the field is a group of radios, the label becomes a legend. */
  group?: boolean
}

export function Field({ label, help, error, required, htmlFor, children, className, group }: FieldProps) {
  const body = (
    <>
      {help && <span className="block text-sm text-muted-foreground">{help}</span>}
      {children}
      {error && (
        <span role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </span>
      )}
    </>
  )
  const title = (
    <>
      {label}
      {required && (
        <span aria-hidden className="text-destructive">
          {" "}
          *
        </span>
      )}
    </>
  )
  if (group) {
    return (
      <fieldset className={cn("flex min-w-0 flex-col gap-2", className)} aria-required={required || undefined}>
        <legend className="mb-2 text-[15px] font-semibold">{title}</legend>
        {body}
      </fieldset>
    )
  }
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <label htmlFor={htmlFor} className="text-[15px] font-semibold">
        {title}
      </label>
      {body}
    </div>
  )
}

const control =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-[15px] text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 aria-invalid:border-destructive disabled:opacity-50"

export function TextInput({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(control, className)} {...props} />
}

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <span className="relative block min-w-0">
      <select className={cn(control, "cursor-pointer appearance-none pr-10", className)} {...props}>
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 size-[18px] -translate-y-1/2 text-muted-foreground"
      />
    </span>
  )
}

type Choice<T extends string> = { value: T; label: ReactNode; hint?: ReactNode; swatch?: string }

/** Radio buttons drawn as joined segments; arrow keys move between them. */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  invalid,
  stack,
}: {
  name: string
  value: T | null
  options: Choice<T>[]
  onChange: (v: T) => void
  invalid?: boolean
  stack?: boolean
}) {
  return (
    <div
      className={cn(
        "grid gap-2",
        stack ? "grid-cols-1" : options.length === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-3",
      )}
    >
      {options.map((o) => (
        <label
          key={o.value}
          className={cn(
            "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border bg-card px-3.5 py-2.5 transition-colors",
            "has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/40 hover:border-primary/50",
            value === o.value ? "border-primary-ink bg-secondary/60 ring-1 ring-primary-ink" : "border-input",
            invalid && value === null && "border-destructive",
          )}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="mt-1 size-4 shrink-0 accent-[var(--primary)]"
          />
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2 text-[15px] font-medium">
              {o.swatch && <span aria-hidden className="size-2.5 rounded-full" style={{ background: o.swatch }} />}
              {o.label}
            </span>
            {o.hint && <span className="text-sm text-muted-foreground">{o.hint}</span>}
          </span>
        </label>
      ))}
    </div>
  )
}

export function Checkbox({ label, hint, ...props }: ComponentProps<"input"> & { label: ReactNode; hint?: ReactNode }) {
  const id = useId()
  return (
    <label
      htmlFor={id}
      className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-input bg-card px-3.5 py-2.5 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/40"
    >
      <input id={id} type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--primary)]" {...props} />
      <span className="flex flex-col">
        <span className="text-[15px] font-medium">{label}</span>
        {hint && <span className="text-sm text-muted-foreground">{hint}</span>}
      </span>
    </label>
  )
}

const NOTE_STYLE = {
  info: { icon: Info, box: "border-primary/25 bg-secondary/50", text: "text-primary-ink" },
  warning: { icon: AlertTriangle, box: "border-warning-border bg-warning-bg", text: "text-warning-fg" },
  error: { icon: XCircle, box: "border-destructive/40 bg-destructive/5", text: "text-destructive" },
}

export function Note({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: keyof typeof NOTE_STYLE
  title?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const s = NOTE_STYLE[tone]
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("flex gap-3 rounded-lg border px-4 py-3 text-[15px]", s.box, className)}
    >
      <s.icon aria-hidden className={cn("mt-0.5 size-5 shrink-0", s.text)} />
      <div className="flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere]">
        {title && <p className={cn("font-semibold", s.text)}>{title}</p>}
        {children}
      </div>
    </div>
  )
}

/** Step progress from evaluate.py's own "[Step i/n]" log lines. */
export function Progress({ step, total, label }: { step: number; total: number; label: string }) {
  return (
    <div className="flex flex-col gap-2" role="status" aria-live="polite">
      <div className="flex justify-between gap-4 text-sm">
        <span className="font-medium">{label}</span>
        <span className="shrink-0 text-muted-foreground">
          Step {step} of {total}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary-ink transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${Math.max(6, (step / total) * 100)}%` }}
        />
      </div>
    </div>
  )
}
