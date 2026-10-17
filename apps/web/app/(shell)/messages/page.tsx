"use client";

import { useEffect, useRef, useState } from "react";
import { useDisposals } from "@/hooks/useDisposals";
import { useResource } from "@/hooks/useResource";
import { useScenes } from "@/hooks/useScenes";
import { api } from "@/lib/api";
import { ALERT_STATE_LABEL, BIN_LABEL, dayTime, fullnessPercent, shortTime } from "@/lib/format";
import type { Alert, AlertMessage, BinStatus, ItemSummary } from "@/lib/types";
import { LogoMark } from "@/components/shell/Logo";
import { Dot, Empty, LoadError, Mono } from "@/components/ui";

const isClosed = (a: Alert) => a.state === "action_confirmed" || a.state === "emptied";

function Why({ alert, item, bin }: { alert: Alert; item?: ItemSummary; bin?: BinStatus }) {
  const disposals = useDisposals();
  const who = alert.contact.name;

  if (alert.kind === "emptying") {
    const pct = bin ? fullnessPercent(bin.estimated_fullness) : null;
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2.5">
          <span className="text-sm text-muted">Why Recyclone texted the {who}</span>
          <p className="m-0 font-display text-[38px] leading-[1.08] font-bold tracking-[-0.01em] text-balance">
            {bin ? `${bin.name} looked nearly full` : alert.trigger}
          </p>
        </div>
        {bin && (
          <div className="flex flex-wrap items-end gap-x-11 gap-y-4">
            <div className="flex flex-col">
              <span className="font-display text-[60px] leading-[0.9] font-extrabold">~{pct}%</span>
              <span className="text-[13px] text-muted-2">full now · estimated</span>
            </div>
            <div className="flex flex-col">
              <span className="font-display text-[60px] leading-[0.9] font-extrabold">{Math.round(bin.fullness_threshold * 100)}%</span>
              <span className="text-[13px] text-muted-2">empty at</span>
            </div>
          </div>
        )}
        <span className="text-[13px] text-ink-2">Triggered by: {alert.trigger}</span>
      </div>
    );
  }

  const drops = disposals
    .filter((d) => d.item_id === alert.item_id && (d.outcome === "correct" || d.outcome === "incorrect"))
    .slice(0, 10)
    .reverse();
  const byBin = new Map<string, number>();
  for (const d of drops) if (d.bin) byBin.set(BIN_LABEL[d.bin], (byBin.get(BIN_LABEL[d.bin]) ?? 0) + 1);
  const scoreKnown = item && item.score.status === "ok";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2.5">
        <span className="text-sm text-muted">Why Recyclone texted the {who}</span>
        <p className="m-0 font-display text-[38px] leading-[1.08] font-bold tracking-[-0.01em] text-balance">
          {scoreKnown ? `${item.name} goes in the right bin ${Math.round((item.score as { percent: number }).percent)}% of the time` : alert.trigger}
        </p>
        <span className="text-sm text-ink-2">Texted because: {alert.trigger}</span>
      </div>
      {item && (
        <div className="flex flex-wrap items-end gap-x-11 gap-y-4">
          <div className="flex flex-col">
            <span className="font-display text-[60px] leading-[0.9] font-extrabold">{item.threshold_percent}%</span>
            <span className="text-[13px] text-muted-2">goal</span>
          </div>
          <div className="flex flex-col">
            <span className="font-display text-[60px] leading-[0.9] font-extrabold">{item.assessed_count}</span>
            <span className="text-[13px] text-muted-2">drops seen</span>
          </div>
          {drops.length > 0 && (
            <div className="flex flex-col gap-2 pb-0.5">
              <div role="img" aria-label={`Recent drops: ${[...byBin].map(([b, n]) => `${n} into ${b}`).join(", ")}`} className="flex gap-2">
                {drops.map((d) => (
                  <span key={d.cursor} className={`h-[18px] w-[18px] rounded-full ${d.outcome === "correct" ? "bg-compost" : "bg-clay"}`} />
                ))}
              </div>
              <span className="text-[13px] text-ink-2">
                {[...byBin].map(([b, n]) => `${n} into ${b}`).join(", ")} · {shortTime(drops[0].at)}–{shortTime(drops.at(-1)!.at)}
              </span>
            </div>
          )}
        </div>
      )}
      <span className="text-[13px] text-muted-2">Percentages weight recent drops more. Items we couldn&apos;t identify aren&apos;t counted.</span>
    </div>
  );
}

function Others({ alerts, activeId, onPick }: { alerts: Alert[]; activeId: string; onPick: (id: string) => void }) {
  const others = alerts.filter((a) => a.alert_id !== activeId);
  if (!others.length) return null;
  return (
    <section aria-labelledby="others-h" className="flex flex-col rounded-3xl bg-sage px-[22px] pt-[18px] pb-2.5">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="others-h" className="m-0 font-display text-2xl font-bold text-forest-deep">Other conversations</h2>
        <span className="text-[13px] text-forest">{others.length} more</span>
      </div>
      {others.map((a, i) => (
        <button
          key={a.alert_id}
          onClick={() => onPick(a.alert_id)}
          className={`flex cursor-pointer flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5 text-left ${i ? "border-t border-rule-sage" : ""}`}
        >
          <span className="flex flex-col gap-px">
            <strong className="text-[19px]">{a.contact.name}</strong>
            <span className="text-sm text-ink-2">{a.kind === "emptying" ? "Bin nearly full" : a.trigger}</span>
          </span>
          <span className="flex flex-col items-end gap-px">
            <span className="flex items-center gap-2 text-base font-bold text-forest">
              <Dot className="bg-forest" />
              {ALERT_STATE_LABEL[a.state]}
            </span>
            <Mono className="text-xs text-ink-2">{dayTime(a.opened_at)}</Mono>
          </span>
        </button>
      ))}
    </section>
  );
}

const QUICK: Record<Alert["kind"], string[]> = {
  recommendation: ["OK, will do", "DONE, sign is up at the counter", "Which item?"],
  emptying: ["EMPTIED", "OK"],
};

function Phone({ alert, mocked }: { alert: Alert; mocked: boolean }) {
  const bottom = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [alert.messages.length, alert.alert_id]);

  const send = async (body: string) => {
    if (!body.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.mockReply({ contactId: alert.contact.contact_id, body: body.trim() });
      setText("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  let lastAt = 0;
  const stamp = (m: AlertMessage, i: number) => {
    const t = Date.parse(m.at);
    const show = i === 0 || t - lastAt > 10 * 60_000;
    lastAt = t;
    return show ? <span className="self-center text-xs text-muted-2">{i === 0 ? dayTime(m.at) : shortTime(m.at)}</span> : null;
  };

  return (
    <figure className="m-0 flex flex-none flex-col items-center gap-2">
      <div
        role="group"
        aria-label={`The ${alert.contact.name}'s phone showing the text conversation with Recyclone`}
        className="box-border h-[750px] w-[450px] max-w-full rounded-[60px] bg-[#33382F] p-3.5 shadow-[0_26px_54px_rgba(50,45,25,0.22),0_8px_18px_rgba(50,45,25,0.12)]"
      >
        <div className="flex h-full flex-col overflow-hidden rounded-[48px] bg-card text-ink">
          <div className="flex flex-col items-center gap-1 border-b border-rule-soft px-5 pt-6 pb-2.5">
            <span className="flex h-[42px] w-[42px] items-center justify-center rounded-full bg-mint">
              <LogoMark size={24} />
            </span>
            <span className="text-base font-bold">Recyclone</span>
          </div>
          <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 pt-3 pb-4 text-[15.5px] leading-[1.36]">
            {alert.messages.map((m, i) => (
              <div key={m.message_id} className="contents">
                {stamp(m, i)}
                <p
                  className={`m-0 max-w-[85%] px-[13px] py-[9px] ${
                    m.direction === "outbound"
                      ? "self-start rounded-[18px_18px_18px_5px] bg-[#EFEAE0]"
                      : "self-end rounded-[18px_18px_5px_18px] bg-forest text-white"
                  }`}
                >
                  {m.body}
                </p>
              </div>
            ))}
            <div ref={bottom} />
          </div>
          {mocked && !isClosed(alert) && (
            <div className="border-t border-rule-soft bg-paper px-3 pt-2 pb-4">
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {QUICK[alert.kind].map((q) => (
                  <button
                    key={q}
                    disabled={busy}
                    onClick={() => send(q)}
                    className="cursor-pointer rounded-full border border-rule bg-card px-2.5 py-1 text-xs text-ink-2 hover:border-forest disabled:opacity-50"
                  >
                    {q}
                  </button>
                ))}
              </div>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  send(text);
                }}
              >
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={`Reply as the ${alert.contact.name}…`}
                  aria-label={`Mock reply as the ${alert.contact.name}`}
                  className="min-h-10 flex-1 rounded-full border border-rule bg-white px-4 text-[15px] outline-none focus:border-forest"
                />
                <button
                  disabled={busy || !text.trim()}
                  className="min-h-10 cursor-pointer rounded-full bg-forest px-4 text-sm font-bold text-white disabled:opacity-40"
                >
                  Send
                </button>
              </form>
              {err && <span className="mt-1 block text-xs text-clay-deep">{err}</span>}
            </div>
          )}
        </div>
      </div>
      <figcaption className="max-w-[450px] text-center text-xs text-muted-2">
        {mocked
          ? `The ${alert.contact.name}'s phone, as they'd see it · mock texting service, no real phone receives these${isClosed(alert) ? "" : " · typing here stands in for their reply"}`
          : `The ${alert.contact.name}'s phone, as they see it · sent through Photon`}
      </figcaption>
    </figure>
  );
}

type Step = { label: string; at: string; detail: string };

function steps(alert: Alert, mocked: boolean): Step[] {
  const out: Step[] = [];
  const first = alert.messages.find((m) => m.direction === "outbound");
  if (first) out.push({ label: "Sent", at: first.at, detail: mocked ? "delivered (mock)" : "delivered" });
  const follow = alert.messages.find((m) => m.kind === "follow_up");
  if (follow && first) {
    const mins = Math.round((Date.parse(follow.at) - Date.parse(first.at)) / 60_000);
    out.push({ label: "Follow-up sent", at: follow.at, detail: `no reply after ${mins < 1 ? "under a minute" : `${mins} min`}` });
  }
  const replies = alert.messages.filter((m) => m.direction === "inbound");
  const quote = (m: AlertMessage) => `replied “${m.body.length > 40 ? `${m.body.slice(0, 40)}…` : m.body}”`;
  const clarify = alert.messages.find((m) => m.kind === "clarification");
  // "OK" is an acknowledgement, not a confirmation; show it as its own step.
  if (alert.state === "acknowledged" && replies.length) out.push({ label: "Acknowledged", at: replies.at(-1)!.at, detail: quote(replies.at(-1)!) });
  else if (isClosed(alert) && replies.length > 1) out.push({ label: "Acknowledged", at: replies[0].at, detail: quote(replies[0]) });
  if (clarify) out.push({ label: "Asked to clarify", at: clarify.at, detail: "the reply was unclear" });
  if (isClosed(alert) && replies.length) {
    const last = replies.at(-1)!;
    out.push({ label: ALERT_STATE_LABEL[alert.state], at: last.at, detail: quote(last) });
  }
  return out;
}

function Status({ alert, mocked }: { alert: Alert; mocked: boolean }) {
  const list = steps(alert, mocked);
  return (
    <section aria-label="Conversation status" className="flex min-w-0 flex-[1_1_220px] flex-col gap-4">
      <h2 className="m-0 text-sm font-medium text-muted">Status</h2>
      <ol className="m-0 flex list-none flex-col p-0">
        {list.map((s, i) => {
          const current = i === list.length - 1;
          return (
            <li key={s.label} aria-current={current ? "step" : undefined} className={`relative flex flex-col gap-0.5 pl-[30px] ${current ? "" : "pb-5"}`}>
              {current ? (
                <span aria-hidden="true" className="absolute top-[9px] -left-[3px] h-[18px] w-[18px] rounded-full bg-forest shadow-[0_0_0_5px_var(--color-mint)]" />
              ) : (
                <>
                  <span aria-hidden="true" className="absolute top-1.5 left-0 h-3 w-3 rounded-full bg-leaf" />
                  <span aria-hidden="true" className="absolute top-[22px] bottom-0.5 left-[5px] border-l-2 border-leaf-soft" />
                </>
              )}
              <span className={current ? "font-display text-[32px] leading-[1.05] font-extrabold text-forest" : "text-lg font-bold"}>{s.label}</span>
              <span className="text-[13px] text-muted-2">
                <Mono>{dayTime(s.at)}</Mono> · {s.detail}
              </span>
            </li>
          );
        })}
      </ol>
      {!isClosed(alert) && (
        <span className="text-[13px] text-muted-2">
          {alert.kind === "recommendation" ? "Waiting for them to confirm the change." : "Waiting for them to confirm it's emptied."}
        </span>
      )}
    </section>
  );
}

export default function MessagesPage() {
  const alerts = useResource(api.alerts);
  const items = useResource(api.items);
  const bins = useResource(api.bins);
  const { activeAlertId, setActiveAlert } = useScenes();

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("alert");
    if (id) setActiveAlert(id);
  }, [setActiveAlert]);

  if (alerts.error && !alerts.data) return <LoadError error={alerts.error} />;
  if (!alerts.data) return <Empty title="Loading conversations…" />;
  if (!alerts.data.alerts.length)
    return (
      <Empty title="No texts yet">
        When an item keeps going in the wrong bin, or a bin fills up, Recyclone texts the right person. The conversation shows up here.
      </Empty>
    );

  const list = alerts.data.alerts;
  const alert = list.find((a) => a.alert_id === activeAlertId) ?? list[0];
  const item = items.data?.items.find((i) => i.catalog_item_id === alert.item_id);
  const bin = bins.data?.bins.find((b) => b.bin_id === alert.bin_id);
  const mocked = alerts.data.messenger_mocked;

  return (
    <div className="flex flex-1 flex-wrap items-center justify-center gap-x-14 gap-y-6 px-10 pt-3.5 pb-3">
      <div className="flex min-w-0 flex-[1.3_1_360px] flex-col gap-5">
        <Why alert={alert} item={item} bin={bin} />
        <Others alerts={list} activeId={alert.alert_id} onPick={setActiveAlert} />
      </div>
      <Phone alert={alert} mocked={mocked} />
      <Status alert={alert} mocked={mocked} />
    </div>
  );
}
