// Step 2: the choices evaluate.py needs before it can check the CSVs; one set-up serves both test sets.
import { Checkbox, Field, Segmented, Select, TextInput } from "@/components/form"
import type { Task } from "@/lib/tasks"
import { TITLE_MAX, type Problems, type Setup } from "@/views/workspace-model"

type Props = {
  task: Task
  setup: Setup
  onChange: (patch: Partial<Setup>) => void
  problems: Problems
  /** Labels in the reference-label column, when it holds a short list of labels. */
  labels: string[] | null
  /** The field evaluate.py asked about, and what to tell the person. */
  needs: { field: string | null; text: string } | null
  /** Questions evaluate.py asked during this session; they stay on screen once asked. */
  revealed: Set<string>
}

const UNITS = ["weeks", "days", "mm", "cm", "g", "kg"]

export function SetupStep({ task, setup: s, onChange, problems, labels, needs, revealed }: Props) {
  const ask = (field: string) => (needs?.field === field ? needs.text : undefined)
  const err = (field: string) => problems[field] ?? ask(field)
  const showNegative = (labels && labels.length > 2) || revealed.has("negative_label") || !!s.negative_label
  const showRepeated = task.key === "regression" && (revealed.has("repeated_measures") || s.repeated_measures !== null)
  const showEmpty = task.key === "segmentation" && (revealed.has("empty_both") || s.empty_both !== null)

  return (
    <div className="flex flex-col gap-7">
      <div id="field-title">
        <Field
          htmlFor="title"
          label="Title for these results (optional)"
          help={`Heads the report of each test set, for example "GAUGE: After Pooling". You can change it later on the results page.`}
          error={err("title")}
        >
          <TextInput
            id="title"
            value={s.title}
            maxLength={TITLE_MAX + 20}
            onChange={(e) => onChange({ title: e.target.value })}
            aria-invalid={!!err("title") || undefined}
            aria-describedby="title-count"
          />
          <span id="title-count" className="self-end text-sm text-muted-foreground">
            {s.title.trim().length} of {TITLE_MAX} characters
          </span>
        </Field>
      </div>

      {task.key === "classification" && (
        <>
          <div id="field-mode">
            <Field group label="Mode" required error={err("mode")}>
              <Segmented
                name="mode"
                value={s.mode}
                onChange={(v) => onChange({ mode: v })}
                options={[
                  { value: "standard", label: "Standard", hint: "One prediction per participant" },
                  { value: "fgr", label: "FGR", hint: "One prediction per scan; record_id like 001_32+5" },
                ]}
              />
            </Field>
          </div>
          <div className="grid gap-6 sm:grid-cols-2">
            <div id="field-positive_label">
              <Field htmlFor="positive" label="Positive label" required error={err("positive_label")}>
                {labels ? (
                  <Select
                    id="positive"
                    value={s.positive_label}
                    onChange={(e) => onChange({ positive_label: e.target.value, prob_confirmed: false })}
                  >
                    <option value="" disabled>
                      Choose a label
                    </option>
                    {labels.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <TextInput
                    id="positive"
                    value={s.positive_label}
                    onChange={(e) => onChange({ positive_label: e.target.value, prob_confirmed: false })}
                  />
                )}
              </Field>
            </div>
            {showNegative && (
              <div id="field-negative_label">
                <Field htmlFor="negative" label="Negative label" error={err("negative_label")}>
                  {labels ? (
                    <Select id="negative" value={s.negative_label} onChange={(e) => onChange({ negative_label: e.target.value })}>
                      <option value="">Choose a label</option>
                      {labels
                        .filter((l) => l !== s.positive_label)
                        .map((l) => (
                          <option key={l} value={l}>
                            {l}
                          </option>
                        ))}
                    </Select>
                  ) : (
                    <TextInput id="negative" value={s.negative_label} onChange={(e) => onChange({ negative_label: e.target.value })} />
                  )}
                </Field>
              </div>
            )}
          </div>
          <div id="field-prob_confirmed">
            <Field group label="Predicted probability" required error={err("prob_confirmed")}>
              <Checkbox
                checked={s.prob_confirmed}
                disabled={!s.positive_label}
                onChange={(e) => onChange({ prob_confirmed: e.target.checked })}
                label={`pred_prob is the probability of ${s.positive_label ? `"${s.positive_label}"` : "the positive label"}`}
                hint="Not the probability of the predicted label. Curves and calibration depend on it."
              />
            </Field>
          </div>
          {s.mode === "standard" && (
            <div id="field-dca">
              <Field
                group
                label="Threshold range for the decision curve"
                help="The threshold probabilities that matter clinically, between 0 and 1, for example 0.05 to 0.50."
                required
                error={err("dca")}
              >
                <div className="grid max-w-md grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1 text-sm">
                    Lowest
                    <TextInput inputMode="decimal" value={s.dca_min} onChange={(e) => onChange({ dca_min: e.target.value })} />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    Highest
                    <TextInput inputMode="decimal" value={s.dca_max} onChange={(e) => onChange({ dca_max: e.target.value })} />
                  </label>
                </div>
              </Field>
            </div>
          )}
        </>
      )}

      {task.key === "regression" && (
        <div id="field-unit" className="max-w-md">
          <Field
            htmlFor="unit"
            label="Unit of true and pred"
            help="Weeks are converted to days for every metric; the figures stay in weeks."
            required
            error={err("unit")}
          >
            <TextInput id="unit" list="units" value={s.unit} onChange={(e) => onChange({ unit: e.target.value })} />
            <datalist id="units">
              {UNITS.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </Field>
        </div>
      )}

      {showRepeated && (
        <div id="field-repeated_measures">
          <Field group label="Participants with several pairs" required error={ask("repeated_measures")}>
            <Segmented
              name="repeated"
              stack
              value={s.repeated_measures}
              onChange={(v) => onChange({ repeated_measures: v })}
              options={[
                { value: "participant-mean", label: "Average within each participant", hint: "One point per participant" },
                {
                  value: "all-pairs-anova",
                  label: "Use every pair",
                  hint: "Limits of agreement include the variation within each participant (repeated-measures ANOVA)",
                },
              ]}
            />
          </Field>
        </div>
      )}

      {showEmpty && (
        <div id="field-empty_both">
          <Field group label="Mask pairs empty in both" required error={ask("empty_both")}>
            <Segmented
              name="empty_both"
              stack
              value={s.empty_both}
              onChange={(v) => onChange({ empty_both: v })}
              options={[
                { value: "exclude", label: "Leave them out of the foreground average" },
                { value: "one", label: "Score them as 1 (perfect agreement)" },
              ]}
            />
          </Field>
        </div>
      )}

      {task.key === "detection" && (
        <div id="field-frame_offset" className="max-w-xs">
          <Field
            htmlFor="frame-offset"
            label="Frame offset"
            help="Video frame index = XML frame number + offset. Leave 0 unless the overlays are shifted."
            error={err("frame_offset")}
          >
            <TextInput
              id="frame-offset"
              inputMode="numeric"
              value={s.frame_offset}
              onChange={(e) => onChange({ frame_offset: e.target.value })}
            />
          </Field>
        </div>
      )}
    </div>
  )
}
