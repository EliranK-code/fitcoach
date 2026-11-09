"use client";

import { useActionState, useState, type ReactNode } from "react";
import type { CoachKnowledge } from "@fitcoach/core";
import type { FormState } from "@/lib/actions/auth";
import { saveKnowledgeAction } from "@/lib/actions/knowledge";
import { NUTRITION_APPROACH_LABEL, TONE_LABEL } from "@/lib/labels";
import { Button, Field, Input, Notice, Select, Textarea } from "./ui";

// Structured editor for the coach's knowledge (the same shape as coach.yaml). Client-only: no runtime
// imports from @fitcoach/core here, only types.

type K = CoachKnowledge;
type FieldKind = "text" | "textarea" | "lines";
interface FieldSpec<T> {
  key: keyof T & string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
}

const lines = (v: string) => v.split("\n");
const clean = (arr: string[]) => arr.map((s) => s.trim()).filter(Boolean);

function Section({ title, hint, children, open }: { title: string; hint?: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group rounded-xl border border-slate-200 bg-white shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {hint && <p className="text-xs text-slate-500">{hint}</p>}
        </div>
        <span className="text-slate-400 transition-transform group-open:rotate-180">⌄</span>
      </summary>
      <div className="space-y-4 border-t border-slate-100 px-5 py-4">{children}</div>
    </details>
  );
}

function LinesField({ label, hint, value, onChange, rows = 4 }: { label: string; hint?: string; value: string[]; onChange: (v: string[]) => void; rows?: number }) {
  return (
    <Field label={label} hint={hint ?? "One item per line"}>
      <Textarea rows={rows} value={value.join("\n")} onChange={(e) => onChange(lines(e.target.value))} />
    </Field>
  );
}

function RecordList<T extends Record<string, unknown>>({
  items,
  fields,
  empty,
  addLabel,
  onChange,
}: {
  items: T[];
  fields: FieldSpec<T>[];
  empty: T;
  addLabel: string;
  onChange: (items: T[]) => void;
}) {
  const update = (i: number, key: keyof T, value: unknown) => onChange(items.map((it, j) => (j === i ? { ...it, [key]: value } : it)));
  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={i} className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          {fields.map((f) => {
            const v = item[f.key];
            return (
              <Field key={f.key} label={f.label} hint={f.kind === "lines" ? "One item per line" : undefined}>
                {f.kind === "text" ? (
                  <Input value={String(v ?? "")} placeholder={f.placeholder} onChange={(e) => update(i, f.key, e.target.value)} />
                ) : f.kind === "textarea" ? (
                  <Textarea value={String(v ?? "")} placeholder={f.placeholder} onChange={(e) => update(i, f.key, e.target.value)} />
                ) : (
                  <Textarea rows={3} value={((v as string[]) ?? []).join("\n")} onChange={(e) => update(i, f.key, lines(e.target.value))} />
                )}
              </Field>
            );
          })}
          <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} className="text-xs text-red-600 hover:underline">
            Remove
          </button>
        </div>
      ))}
      <Button type="button" size="sm" variant="secondary" onClick={() => onChange([...items, { ...empty }])}>
        + {addLabel}
      </Button>
    </div>
  );
}

/** Trims text and drops empty list entries and empty records before saving. */
function cleaned(k: K): K {
  return {
    ...k,
    tone: { ...k.tone, phrases: clean(k.tone.phrases) },
    training: {
      ...k.training,
      preferredExercises: clean(k.training.preferredExercises),
      avoidedExercises: k.training.avoidedExercises.filter((e) => e.name.trim()).map((e) => ({ ...e, aliases: clean(e.aliases) })),
      samplePrograms: k.training.samplePrograms.filter((p) => p.name.trim()),
    },
    injuries: k.injuries.filter((i) => i.area.trim()).map((i) => ({ ...i, allowed: clean(i.allowed), forbidden: clean(i.forbidden) })),
    supplements: { ...k.supplements, allowed: clean(k.supplements.allowed) },
    faq: k.faq.filter((f) => f.q.trim() && f.a.trim()),
    alwaysEscalate: clean(k.alwaysEscalate),
  };
}

export function KnowledgeForm({ initial }: { initial: K }) {
  const [k, setK] = useState<K>(initial);
  const [state, action, pending] = useActionState<FormState, FormData>(saveKnowledgeAction, {});
  const set = <S extends keyof K>(section: S, patch: Partial<K[S]>) => setK((prev) => ({ ...prev, [section]: { ...(prev[section] as object), ...patch } }));

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="data" value={JSON.stringify(cleaned(k))} />

      <Section title="The coach" hint="How the bot introduces you" open>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name">
            <Input value={k.coach.name} onChange={(e) => set("coach", { name: e.target.value })} required />
          </Field>
          <Field label="Business name">
            <Input value={k.coach.businessName} onChange={(e) => set("coach", { businessName: e.target.value })} />
          </Field>
        </div>
        <Field label="About you">
          <Textarea value={k.coach.bio} onChange={(e) => set("coach", { bio: e.target.value })} />
        </Field>
        <Field label="Default language for new clients" hint="The bot always answers in the language the client writes in">
          <Select value={k.coach.language} onChange={(e) => set("coach", { language: e.target.value })}>
            <option value="he">Hebrew</option>
            <option value="en">English</option>
            <option value="ar">العربية</option>
            <option value="ru">Русский</option>
          </Select>
        </Field>
      </Section>

      <Section title="Tone of voice" hint="How the bot sounds">
        <Field label="Style">
          <div className="flex flex-wrap gap-4">
            {Object.entries(TONE_LABEL).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-emerald-600"
                  checked={k.tone.styles.includes(value as K["tone"]["styles"][number])}
                  onChange={(e) =>
                    set("tone", {
                      styles: e.target.checked
                        ? [...k.tone.styles, value as K["tone"]["styles"][number]]
                        : k.tone.styles.filter((s) => s !== value),
                    })
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Style description">
          <Textarea value={k.tone.description} onChange={(e) => set("tone", { description: e.target.value })} />
        </Field>
        <LinesField label="Your phrases" value={k.tone.phrases} onChange={(phrases) => set("tone", { phrases })} rows={3} />
        <Field label="Emojis">
          <Input value={k.tone.emojis} onChange={(e) => set("tone", { emojis: e.target.value })} />
        </Field>
      </Section>

      <Section title="Training philosophy and principles">
        <Textarea rows={8} value={k.philosophy} onChange={(e) => setK({ ...k, philosophy: e.target.value })} />
      </Section>

      <Section title="Nutrition">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Approach">
            <Select value={k.nutrition.approach} onChange={(e) => set("nutrition", { approach: e.target.value as K["nutrition"]["approach"] })}>
              {Object.entries(NUTRITION_APPROACH_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-emerald-600"
              checked={k.nutrition.showNumbersToClients}
              onChange={(e) => set("nutrition", { showNumbersToClients: e.target.checked })}
            />
            Show clients calorie and macro numbers
          </label>
        </div>
        <Field label="Method details" hint="Portions, timing, rules. The bot builds meal plans exactly by this.">
          <Textarea rows={8} value={k.nutrition.details} onChange={(e) => set("nutrition", { details: e.target.value })} />
        </Field>
      </Section>

      <Section title="Training">
        <Field label="Principles and program structure">
          <Textarea rows={6} value={k.training.principles} onChange={(e) => set("training", { principles: e.target.value })} />
        </Field>
        <LinesField label="Preferred exercises" value={k.training.preferredExercises} onChange={(preferredExercises) => set("training", { preferredExercises })} rows={6} />
        <Field label="Exercises you avoid" hint="The bot won't put them in a plan: this is enforced in code, not just in the prompt.">
          <RecordList
            items={k.training.avoidedExercises}
            empty={{ name: "", aliases: [], reason: "", alternative: "" }}
            addLabel="exercise"
            fields={[
              { key: "name", label: "Exercise name", kind: "text" },
              { key: "aliases", label: "Other names (other languages, slang)", kind: "lines" },
              { key: "reason", label: "Why", kind: "text" },
              { key: "alternative", label: "What to do instead", kind: "text" },
            ]}
            onChange={(avoidedExercises) => set("training", { avoidedExercises })}
          />
        </Field>
        <Field label="Sample programs">
          <RecordList
            items={k.training.samplePrograms}
            empty={{ name: "", description: "" }}
            addLabel="program"
            fields={[
              { key: "name", label: "Name", kind: "text" },
              { key: "description", label: "The program", kind: "textarea" },
            ]}
            onChange={(samplePrograms) => set("training", { samplePrograms })}
          />
        </Field>
      </Section>

      <Section title="Injuries" hint="Your guidance per area. The bot doesn't diagnose, and always refers sharp pain to a doctor.">
        <RecordList
          items={k.injuries}
          empty={{ area: "", guidance: "", allowed: [], forbidden: [] }}
          addLabel="area"
          fields={[
            { key: "area", label: "Area / condition", kind: "text" },
            { key: "guidance", label: "Guidance", kind: "textarea" },
            { key: "allowed", label: "Allowed", kind: "lines" },
            { key: "forbidden", label: "Forbidden", kind: "lines" },
          ]}
          onChange={(injuries) => setK({ ...k, injuries })}
        />
      </Section>

      <Section title="Supplements" hint="The bot recommends only what's on the list, and never dangerous substances">
        <LinesField label="Approved supplements" value={k.supplements.allowed} onChange={(allowed) => set("supplements", { allowed })} rows={3} />
        <Field label="Policy">
          <Textarea value={k.supplements.policy} onChange={(e) => set("supplements", { policy: e.target.value })} />
        </Field>
      </Section>

      <Section title="FAQ" hint="The bot answers these in your words">
        <RecordList
          items={k.faq}
          empty={{ q: "", a: "" }}
          addLabel="question"
          fields={[
            { key: "q", label: "Question", kind: "text" },
            { key: "a", label: "Answer", kind: "textarea" },
          ]}
          onChange={(faq) => setK({ ...k, faq })}
        />
      </Section>

      <Section title="Topics that always go to you" hint="The bot doesn't answer these: it says it will check with you and opens an alert">
        <LinesField label="Topics" value={k.alwaysEscalate} onChange={(alwaysEscalate) => setK({ ...k, alwaysEscalate })} />
      </Section>

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-3 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur md:mx-0 md:rounded-xl md:border">
        <Button disabled={pending}>{pending ? "Saving…" : "Save and publish a new version"}</Button>
        {state.error && <span className="text-sm text-red-700">{state.error}</span>}
        {state.ok && <span className="text-sm text-emerald-700">{state.ok}</span>}
      </div>
      {state.error && <Notice tone="red">{state.error}</Notice>}
    </form>
  );
}
