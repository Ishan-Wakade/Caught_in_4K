"use client";

import { useEffect, useState } from "react";
import {
  BELIEFS,
  BIN_WORD,
  BREAKDOWNS,
  QUIZ,
  SLICE_COLOR,
  sourceNumber,
  spoken,
  type Bin,
  type SourceId,
  type Stat,
} from "@/lib/impact";

/** A numbered citation mark that jumps to the source list at the foot of the page. */
export function Cite({ id }: { id: SourceId }) {
  const n = sourceNumber(id);
  return (
    <sup className="ml-0.5 text-[0.7em] leading-none font-medium">
      <a href={`#source-${n}`} aria-label={`Source ${n}`} className="no-underline hover:underline">
        [{n}]
      </a>
    </sup>
  );
}

export function StatGrid({ stats }: { stats: Stat[] }) {
  return (
    <ul className={`m-0 grid list-none gap-4 p-0 sm:grid-cols-2 ${stats.length === 3 ? "lg:grid-cols-3" : "lg:grid-cols-4"}`}>
      {stats.map((s) => (
        <li key={s.label} className="flex flex-col gap-2 rounded-2xl bg-card p-6">
          <span className="text-[44px] leading-none font-bold tracking-[-0.02em] text-forest-deep">
            {s.text}
          </span>
          <span className="text-[15px] leading-snug text-ink-2">
            {s.label}
            <Cite id={s.source} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One 100% bar per breakdown, tabbed. Hover or focus a segment or its legend row to see its figure. */
export function WhereItGoes() {
  const [tab, setTab] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const b = BREAKDOWNS[tab]!;
  const sum = b.slices.reduce((n, s) => n + s.value, 0);
  const share = (v: number) => Math.round((100 * v) / sum);
  const fmt = (v: number) => (b.unit.startsWith("%") ? `${v}%` : `${v.toFixed(1)} ${b.unit}`);

  return (
    <div className="flex flex-col gap-6 rounded-2xl bg-card p-6 sm:p-8">
      <div role="tablist" aria-label="Waste stream" className="flex flex-wrap gap-2">
        {BREAKDOWNS.map((x, i) => (
          <button
            key={x.id}
            role="tab"
            type="button"
            aria-selected={i === tab}
            onClick={() => {
              setTab(i);
              setHover(null);
            }}
            className={`min-h-10 rounded-full border px-4 text-[15px] font-medium ${
              i === tab ? "border-forest bg-forest text-card" : "border-rule bg-transparent text-ink-2 hover:border-forest hover:text-ink"
            }`}
          >
            {x.tab}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-lg font-bold text-ink">
          {b.title}
          <Cite id={b.source} />
        </h3>
        <span className="text-sm text-muted">Total: {b.total}</span>
      </div>

      <div className="relative">
        <div className="flex h-6 gap-[2px]" role="img" aria-label={b.slices.map((s) => `${s.label} ${share(s.value)}%`).join(", ")}>
          {b.slices.map((s, i) => (
            <div
              key={s.key}
              tabIndex={0}
              aria-label={`${s.label}: ${fmt(s.value)}, ${share(s.value)}%`}
              onPointerEnter={() => setHover(s.key)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(s.key)}
              onBlur={() => setHover(null)}
              className={`relative cursor-default outline-offset-2 transition-[flex-grow,opacity] duration-500 ${
                i === 0 ? "rounded-l-[4px]" : ""
              } ${i === b.slices.length - 1 ? "rounded-r-[4px]" : ""} ${hover && hover !== s.key ? "opacity-35" : ""}`}
              style={{ flexGrow: s.value, flexBasis: 0, background: SLICE_COLOR[s.key] }}
            >
              {hover === s.key && (
                <div
                  role="tooltip"
                  className={`pointer-events-none absolute bottom-full z-10 mb-2 w-max max-w-64 rounded-lg bg-night px-3 py-2 text-left text-card shadow-lg ${
                    i === 0 ? "left-0" : i === b.slices.length - 1 ? "right-0" : "left-1/2 -translate-x-1/2"
                  }`}
                >
                  <div className="text-base font-bold">{share(s.value)}%</div>
                  <div className="text-[13px]">
                    {s.label} · {fmt(s.value)}
                  </div>
                  {s.note && <div className="text-xs text-[#D9DCD0]">{s.note}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <ul className="m-0 grid list-none gap-x-8 gap-y-2 p-0 sm:grid-cols-2">
        {b.slices.map((s) => (
          <li
            key={s.key}
            onPointerEnter={() => setHover(s.key)}
            onPointerLeave={() => setHover(null)}
            className={`flex items-baseline gap-3 transition-opacity ${hover && hover !== s.key ? "opacity-50" : ""}`}
          >
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 translate-y-[1px] rounded-[3px]" style={{ background: SLICE_COLOR[s.key] }} />
            <span className="w-11 shrink-0 font-mono text-[15px] text-ink tabular-nums">{share(s.value)}%</span>
            <span className="text-[15px] text-ink-2">
              {s.label}
              {s.note && <span className="text-muted-2"> ({s.note})</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Out of 100 U.S. adults": pick a finding and that many of the hundred light up. */
export function PeopleGrid() {
  const [pick, setPick] = useState(3);
  const belief = BELIEFS[pick]!;

  return (
    <div className="grid gap-8 rounded-2xl bg-card p-6 sm:p-8 lg:grid-cols-[1fr_auto] lg:items-center">
      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Survey finding">
        {BELIEFS.map((x, i) => (
          <button
            key={x.of100}
            type="button"
            role="radio"
            aria-checked={i === pick}
            onClick={() => setPick(i)}
            className={`flex min-h-12 items-center gap-4 rounded-xl border px-4 py-2.5 text-left ${
              i === pick ? "border-forest bg-sage" : "border-rule-soft bg-transparent hover:border-rule-sage hover:bg-paper"
            }`}
          >
            <span className={`w-9 shrink-0 font-mono text-lg tabular-nums ${i === pick ? "font-medium text-forest-deep" : "text-muted"}`}>{x.n}</span>
            <span className={`text-[15px] leading-snug ${i === pick ? "text-ink" : "text-ink-2"}`}>{x.of100}</span>
          </button>
        ))}
      </div>

      <figure className="m-0 flex flex-col items-center gap-3">
        <div aria-hidden="true" className="grid grid-cols-10 gap-1.5">
          {Array.from({ length: 100 }, (_, i) => (
            <span
              key={i}
              className={`h-4 w-4 rounded-full transition-colors duration-300 sm:h-5 sm:w-5 ${i < belief.n ? "bg-forest" : "bg-leaf-soft"}`}
              style={{ transitionDelay: `${(i % 10) * 12 + Math.floor(i / 10) * 12}ms` }}
            />
          ))}
        </div>
        <figcaption className="max-w-72 text-center text-[15px] text-ink" aria-live="polite">
          <strong className="text-forest-deep">{belief.n} of every 100</strong> U.S. adults {belief.of100}.
          <Cite id={belief.source} />
        </figcaption>
      </figure>
    </div>
  );
}

const CHOICES: { bin: Bin; label: string; classes: string }[] = [
  { bin: "recycle", label: "Recycling", classes: "border-recycling text-recycling-ink hover:bg-recycling hover:text-card" },
  { bin: "compost", label: "Compost", classes: "border-compost text-compost-ink hover:bg-compost hover:text-card" },
  { bin: "trash", label: "Trash", classes: "border-trash text-trash-ink hover:bg-trash hover:text-card" },
  { bin: "none", label: "None of these", classes: "border-clay text-clay-deep hover:bg-clay hover:text-card" },
];

function say(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

/** Six items, four bins, Cambridge's rules. Each answer reveals the sentence the voice guide would say. */
export function BinQuiz() {
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState<Bin | null>(null);
  const [score, setScore] = useState(0);
  const [canSpeak, setCanSpeak] = useState(false);
  useEffect(() => setCanSpeak("speechSynthesis" in window), []);
  useEffect(() => () => {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  const done = index >= QUIZ.length;
  const q = QUIZ[Math.min(index, QUIZ.length - 1)]!;

  const choose = (bin: Bin) => {
    if (answer) return;
    setAnswer(bin);
    if (bin === q.bin) setScore((s) => s + 1);
  };
  const next = () => {
    setAnswer(null);
    setIndex((i) => i + 1);
  };
  const restart = () => {
    setAnswer(null);
    setScore(0);
    setIndex(0);
  };

  if (done) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl bg-card p-8 text-center sm:p-12">
        <span className="text-[56px] leading-none font-bold text-forest-deep">
          {score}/{QUIZ.length}
        </span>
        <p className="m-0 max-w-md text-[17px] text-ink">
          {score === QUIZ.length
            ? "Perfect, with time to think. At a real bin, people decide in a moment, with no answer key."
            : "Even with time to think, it's easy to miss one. At a real bin, people decide in a moment."}
        </p>
        <button type="button" onClick={restart} className="min-h-11 rounded-lg border border-forest px-5 text-[15px] font-bold text-forest hover:bg-forest hover:text-card">
          Play again
        </button>
      </div>
    );
  }

  const right = answer === q.bin;

  return (
    <div className="flex flex-col gap-6 rounded-2xl bg-card p-6 sm:p-10">
      <div className="flex items-center justify-between text-sm text-muted-2">
        <span>
          Item {index + 1} of {QUIZ.length}
        </span>
        <span className="font-mono tabular-nums">score {score}</span>
      </div>

      <div className="flex flex-col items-center gap-3 text-center">
        <span aria-hidden="true" className="text-[72px] leading-none">
          {q.emoji}
        </span>
        <span className="font-display text-[28px] leading-tight font-bold text-ink">{q.item}</span>
        <span className="text-[15px] text-muted">Which bin does this go in, in Cambridge, MA?</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {CHOICES.map((c) => {
          const picked = answer === c.bin;
          const correct = answer && c.bin === q.bin;
          return (
            <button
              key={c.bin}
              type="button"
              disabled={!!answer}
              onClick={() => choose(c.bin)}
              className={`min-h-14 rounded-xl border-2 bg-transparent px-3 text-[16px] font-bold transition-colors disabled:cursor-default ${
                answer ? (correct ? "border-forest bg-sage text-forest-deep" : picked ? "border-clay-deep text-clay-deep line-through" : "border-rule-soft text-muted-2") : c.classes
              }`}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      {answer && (
        <div className="animate-rise-in flex flex-col gap-4 rounded-xl bg-paper p-5" aria-live="polite">
          <span className={`text-[17px] font-bold ${right ? "text-forest-deep" : "text-clay-deep"}`}>
            {right ? "Right." : `Not quite: it's ${BIN_WORD[q.bin] === "None" ? "none of the three bins" : BIN_WORD[q.bin].toLowerCase()}.`}
          </span>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium tracking-wide text-muted-2 uppercase">How the voice guide says it</span>
            <q className="text-[17px] leading-snug text-ink">{spoken(q)}</q>
            <span className="text-xs text-muted-2">
              Rule from the City of Cambridge
              <Cite id="cambridge" />
            </span>
          </div>
          <div className="flex flex-wrap gap-3">
            {canSpeak && (
              <button type="button" onClick={() => say(spoken(q))} className="min-h-11 rounded-lg border border-forest px-4 text-[15px] font-bold text-forest hover:bg-forest hover:text-card">
                ▶ Hear it
              </button>
            )}
            <button type="button" onClick={next} className="min-h-11 rounded-lg bg-forest px-5 text-[15px] font-bold text-card hover:bg-forest-deep">
              {index + 1 < QUIZ.length ? "Next item →" : "See your score"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
