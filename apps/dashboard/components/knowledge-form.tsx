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
    <Field label={label} hint={hint ?? "פריט אחד בכל שורה"}>
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
              <Field key={f.key} label={f.label} hint={f.kind === "lines" ? "פריט אחד בכל שורה" : undefined}>
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
            הסרה
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

      <Section title="המאמן" hint="איך הבוט מציג אותך" open>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="שם">
            <Input value={k.coach.name} onChange={(e) => set("coach", { name: e.target.value })} required />
          </Field>
          <Field label="שם העסק">
            <Input value={k.coach.businessName} onChange={(e) => set("coach", { businessName: e.target.value })} />
          </Field>
        </div>
        <Field label="קצת עליך">
          <Textarea value={k.coach.bio} onChange={(e) => set("coach", { bio: e.target.value })} />
        </Field>
        <Field label="שפת ברירת מחדל ללקוחות חדשים" hint="הבוט תמיד עונה בשפה שבה הלקוח כותב">
          <Select value={k.coach.language} onChange={(e) => set("coach", { language: e.target.value })}>
            <option value="he">עברית</option>
            <option value="en">English</option>
            <option value="ar">العربية</option>
            <option value="ru">Русский</option>
          </Select>
        </Field>
      </Section>

      <Section title="טון דיבור" hint="איך הבוט נשמע">
        <Field label="סגנון">
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
        <Field label="תיאור הסגנון">
          <Textarea value={k.tone.description} onChange={(e) => set("tone", { description: e.target.value })} />
        </Field>
        <LinesField label="ביטויים שלך" value={k.tone.phrases} onChange={(phrases) => set("tone", { phrases })} rows={3} />
        <Field label="אימוג'ים">
          <Input value={k.tone.emojis} onChange={(e) => set("tone", { emojis: e.target.value })} />
        </Field>
      </Section>

      <Section title="פילוסופיית אימון ועקרונות">
        <Textarea rows={8} value={k.philosophy} onChange={(e) => setK({ ...k, philosophy: e.target.value })} />
      </Section>

      <Section title="תזונה">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="גישה">
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
            להציג ללקוחות מספרי קלוריות ומאקרו
          </label>
        </div>
        <Field label="פירוט השיטה" hint="מנות, תזמון, כללים. הבוט בונה תפריטים בדיוק לפי זה.">
          <Textarea rows={8} value={k.nutrition.details} onChange={(e) => set("nutrition", { details: e.target.value })} />
        </Field>
      </Section>

      <Section title="אימונים">
        <Field label="עקרונות ומבנה תוכניות">
          <Textarea rows={6} value={k.training.principles} onChange={(e) => set("training", { principles: e.target.value })} />
        </Field>
        <LinesField label="תרגילים מועדפים" value={k.training.preferredExercises} onChange={(preferredExercises) => set("training", { preferredExercises })} rows={6} />
        <Field label="תרגילים שאת/ה נמנע/ת מהם" hint="הבוט לא יכניס אותם לתוכנית: הנתון הזה נאכף בקוד, לא רק בהנחיה.">
          <RecordList
            items={k.training.avoidedExercises}
            empty={{ name: "", aliases: [], reason: "", alternative: "" }}
            addLabel="תרגיל"
            fields={[
              { key: "name", label: "שם התרגיל", kind: "text" },
              { key: "aliases", label: "שמות נוספים (עברית, אנגלית, סלנג)", kind: "lines" },
              { key: "reason", label: "למה", kind: "text" },
              { key: "alternative", label: "מה עושים במקום", kind: "text" },
            ]}
            onChange={(avoidedExercises) => set("training", { avoidedExercises })}
          />
        </Field>
        <Field label="תוכניות לדוגמה">
          <RecordList
            items={k.training.samplePrograms}
            empty={{ name: "", description: "" }}
            addLabel="תוכנית"
            fields={[
              { key: "name", label: "שם", kind: "text" },
              { key: "description", label: "התוכנית", kind: "textarea" },
            ]}
            onChange={(samplePrograms) => set("training", { samplePrograms })}
          />
        </Field>
      </Section>

      <Section title="פציעות" hint="ההנחיות שלך לכל אזור. הבוט לא מאבחן, ובכאב חריף תמיד מפנה לרופא.">
        <RecordList
          items={k.injuries}
          empty={{ area: "", guidance: "", allowed: [], forbidden: [] }}
          addLabel="אזור"
          fields={[
            { key: "area", label: "אזור / מצב", kind: "text" },
            { key: "guidance", label: "הנחיות", kind: "textarea" },
            { key: "allowed", label: "מותר", kind: "lines" },
            { key: "forbidden", label: "אסור", kind: "lines" },
          ]}
          onChange={(injuries) => setK({ ...k, injuries })}
        />
      </Section>

      <Section title="תוספים" hint="הבוט ממליץ רק על מה שברשימה, ולעולם לא על חומרים מסוכנים">
        <LinesField label="תוספים מאושרים" value={k.supplements.allowed} onChange={(allowed) => set("supplements", { allowed })} rows={3} />
        <Field label="מדיניות">
          <Textarea value={k.supplements.policy} onChange={(e) => set("supplements", { policy: e.target.value })} />
        </Field>
      </Section>

      <Section title="שאלות נפוצות" hint="הבוט עונה עליהן במילים שלך">
        <RecordList
          items={k.faq}
          empty={{ q: "", a: "" }}
          addLabel="שאלה"
          fields={[
            { key: "q", label: "שאלה", kind: "text" },
            { key: "a", label: "תשובה", kind: "textarea" },
          ]}
          onChange={(faq) => setK({ ...k, faq })}
        />
      </Section>

      <Section title="נושאים שתמיד עוברים אליך" hint="הבוט לא עונה עליהם: אומר שיבדוק איתך ופותח התראה">
        <LinesField label="נושאים" value={k.alwaysEscalate} onChange={(alwaysEscalate) => setK({ ...k, alwaysEscalate })} />
      </Section>

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-3 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur md:mx-0 md:rounded-xl md:border">
        <Button disabled={pending}>{pending ? "שומר…" : "שמור ופרסם גרסה חדשה"}</Button>
        {state.error && <span className="text-sm text-red-700">{state.error}</span>}
        {state.ok && <span className="text-sm text-emerald-700">{state.ok}</span>}
      </div>
      {state.error && <Notice tone="red">{state.error}</Notice>}
    </form>
  );
}
