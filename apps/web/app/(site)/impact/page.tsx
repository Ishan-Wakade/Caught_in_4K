import type { Metadata } from "next";
import Link from "next/link";
import { BinQuiz, Cite, PeopleGrid, StatGrid, WhereItGoes } from "@/components/impact/Impact";
import { NUMBERS, SOURCES } from "@/lib/impact";

export const metadata: Metadata = { title: "Why it matters", description: "What happens at the bin, by the numbers, with sources" };

function Chapter({ n, kicker, title, children }: { n: string; kicker: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`ch-${n}`} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <span className="font-mono text-sm text-forest">
          {n} · {kicker}
        </span>
        <h2 id={`ch-${n}`} className="m-0 max-w-3xl font-display text-[clamp(28px,4vw,44px)] leading-[1.05] font-bold text-balance text-ink">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

function Lede({ children }: { children: React.ReactNode }) {
  return <p className="m-0 max-w-2xl text-[17px] leading-relaxed text-pretty text-ink-2">{children}</p>;
}

const RESEARCH = [
  {
    finding: "Attention alone can backfire.",
    detail:
      "Pictures of watching eyes above campus bins increased sorting errors in mixed recycling by 4.5 percentage points. Paired with the sorting instructions, the same nudge cut errors by 7 points.",
    source: "lotti-2023",
  },
  {
    finding: "Item-by-item feedback teaches.",
    detail:
      "People who got immediate feedback on each item in a sorting game sorted more accurately afterwards, even a week later. In residences where people played it, contamination fell and more food went to compost.",
    source: "luo-2019",
  },
  {
    finding: "A generic reminder isn't enough.",
    detail:
      "A motion-activated “Please recycle right” message, played at 24 bin locations for 30 days, produced an estimated 5-point drop in contamination that was not statistically significant.",
    source: "ackerman-2026",
  },
] as const;

export default function ImpactPage() {
  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-24 px-6 pt-16 pb-24 sm:px-10">
      <header className="flex flex-col gap-6">
        <span className="font-mono text-sm text-forest">why it matters</span>
        <h1 className="m-0 max-w-4xl font-display text-[clamp(40px,7vw,80px)] leading-[0.95] font-extrabold tracking-[-0.02em] text-balance text-forest-deep">
          Most of us are guessing at the bin.
        </h1>
        <Lede>
          Nearly nine in ten Americans say recycling is important.
          <Cite id="kab-2025" /> But at the bin, many of us aren&apos;t sure which one to use. So recyclables end up in the
          trash, and trash ends up in recycling. Read below to see what that costs, why it happens, and what helps.
        </Lede>
      </header>

      <Chapter n="01" kicker="by the numbers" title="Half of what we throw away gets buried.">
        <Lede>
          Most of what we could recycle at home never makes it into a recycling bin.
          <Cite id="trp-2024" /> Half of what Americans throw away ends up in a landfill,
          <Cite id="epa-ff" /> where rotting food gives off methane, a potent greenhouse gas.
          <Cite id="epa-lmop" />
        </Lede>
        <StatGrid stats={NUMBERS} />
        <WhereItGoes />
      </Chapter>

      <Chapter n="02" kicker="the confusion" title="People want to get it right. The rules make it hard.">
        <Lede>
          Each bin follows local rules that change from city to city and item to item. Pick a finding to see it as
          people.
        </Lede>
        <PeopleGrid />
      </Chapter>

      <Chapter n="03" kicker="your turn" title="Beat the bin.">
        <Lede>
          Six items people often get wrong, four choices. The answers follow the City of Cambridge rules the voice guide
          uses in our demo.
          <Cite id="cambridge" /> Your city&apos;s rules may differ.
        </Lede>
        <div id="quiz" className="scroll-mt-6">
          <BinQuiz />
        </div>
      </Chapter>

      <Chapter n="04" kicker="what helps" title="The answer has to be specific, and it has to arrive in time.">
        <ul className="m-0 grid list-none gap-4 p-0 lg:grid-cols-3">
          {RESEARCH.map((r) => (
            <li key={r.source} className="flex flex-col gap-2 rounded-2xl bg-card p-6">
              <span className="text-[19px] leading-snug font-bold text-ink">{r.finding}</span>
              <span className="text-[15px] leading-relaxed text-ink-2">
                {r.detail}
                <Cite id={r.source} />
              </span>
            </li>
          ))}
        </ul>
        <Lede>
          In these studies, prompts that only asked for attention did little or made things worse. What helped was
          information about where things go, and feedback on each item at the moment of sorting.
        </Lede>
      </Chapter>

      <section aria-labelledby="pitch-h" className="flex flex-col gap-6 rounded-3xl bg-forest-deep p-8 text-card sm:p-12">
        <span className="font-mono text-sm text-leaf">that&apos;s why we built Caught in 4K</span>
        <h2 id="pitch-h" className="m-0 max-w-3xl font-display text-[clamp(28px,4vw,44px)] leading-[1.05] font-bold text-balance">
          It&apos;s built to name the bin for the item in your hand, before you reach the bins.
        </h2>
        <ol className="m-0 grid list-none gap-6 p-0 sm:grid-cols-3">
          {[
            ["Sees it", "The store's existing camera spots what someone is carrying as they walk up."],
            ["Checks the rules", "It looks the item up against that city's own disposal rules."],
            ["Says it", "A speaker by the bins says the bin and the reason: “Recycling. Aluminum can…”"],
          ].map(([t, d], i) => (
            <li key={t} className="flex flex-col gap-1">
              <span className="font-mono text-leaf">{i + 1}</span>
              <span className="text-[17px] font-bold">{t}</span>
              <span className="text-[15px] leading-snug text-[#D9DCD0]">{d}</span>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-3">
          <Link href="/camera" className="flex min-h-11 items-center rounded-lg bg-leaf px-5 text-[15px] font-bold text-night no-underline hover:bg-leaf-soft hover:text-night">
            Try the live camera
          </Link>
          <Link href="/upload" className="flex min-h-11 items-center rounded-lg border border-card/70 px-5 text-[15px] font-bold text-card no-underline hover:bg-card hover:text-forest-deep">
            Try it on your video
          </Link>
        </div>
      </section>

      <section id="sources" aria-labelledby="sources-h" className="flex scroll-mt-6 flex-col gap-4">
        <h2 id="sources-h" className="m-0 text-sm font-medium text-muted-2">sources</h2>
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {SOURCES.map((s, i) => (
            <li key={s.id} id={`source-${i + 1}`} className="grid scroll-mt-6 grid-cols-[2.25rem_1fr] gap-x-2 text-[15px] leading-snug target:rounded-lg target:bg-sage">
              <span className="font-mono text-muted-2">[{i + 1}]</span>
              <span className="text-ink-2">
                {s.by}. <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>{s.title.endsWith(".") ? "" : "."} <span className="text-muted">{s.detail}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="m-0 text-sm text-muted-2">
          Figures are national U.S. estimates unless noted, and are as published; survey shares are rounded to whole
          people in the grid. Sources were checked on 18 October 2026.
        </p>
      </section>
    </div>
  );
}
