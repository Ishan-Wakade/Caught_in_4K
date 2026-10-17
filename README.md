# Caught in 4K

*(codebase name: Recyclone)*

**The cameras already watching your bins can tell you who keeps sorting them wrong — if anyone bothered to look.**

## The problem

Walk past any shared bin bank outside a food court or strip mall and you'll see it: a recyclable cup in the trash, a compostable box tossed in with the garbage. It happens constantly, at scale, and nobody finds out. The mistake gets emptied out with the trash, the evidence disappears, and the exact same thing happens again tomorrow — not because anyone's careless, but because no one has ever actually told them it's happening.

Meanwhile, there's almost always a security camera pointed at that exact spot already. It's just recording a dumpster for loss-prevention, getting overwritten in 24 hours, and telling nobody anything useful.

## What it does

Caught in 4K points that existing camera at the real problem. It watches a shared bin area, identifies what gets thrown where, and figures out — per restaurant, per item — when a mistake isn't a one-off but a pattern. When it is, it texts that restaurant's manager with a specific, grounded fix (not "please recycle more," but "your cup keeps going in the trash at the patio bins — a sign near pickup could help"), tracks whether they confirm the fix, and keeps watching so it can show whether sorting behavior actually changed afterward.

The loop, end to end:

1. **Watch** — an existing surveillance camera feeds a computer-vision model that detects each item dropped into each bin.
2. **Identify** — the item and its source business, from packaging and branding, with destinations judged against the site's own sorting rules (trash / recycling / compost).
3. **Catch the pattern** — one wrong drop isn't a mistake worth flagging; a business's item scoring low across several drops is.
4. **Tell someone who can fix it** — a text to that business's manager, with the specific item and a concrete suggestion, sent and followed up automatically.
5. **Close the loop** — the manager confirms the action by text, no app or login required, and the dashboard shows sorting behavior before and after.

When origin is genuinely unclear — generic packaging, an unreadable logo — it doesn't guess and blame the wrong business. It queues the drop for a human area manager to resolve instead.

## What's in the demo

The staged scenario is **Riverside Food Court**: four restaurants (Bean Co., Taco Stop, Green Bowl, Shake Shack) sharing one patio station with trash, recycling, and compost bins. The demo footage walks through the full range of what the system handles:

- a correct disposal
- a repeated wrong disposal that crosses the threshold and triggers a text
- a bin approaching full, with an emptying request and a confirmed reset
- an item whose source business is unclear, routed to human review instead of guessed at
- an item the model can't identify at all, correctly never counted as anyone's mistake
- a manager who doesn't reply in time, and gets one automatic follow-up

The dashboard mirrors what a manager would actually use day to day: a live annotated camera feed, bin fullness with AI-generated illustrations of estimated contents, a per-restaurant sorting-score view, the manager-text conversation history, a review queue for uncertain cases, and the packaging catalog behind all of it.

## Under the hood

- A Python computer-vision worker processes camera footage into disposal events in real time.
- A Postgres-backed core service applies the sorting rules, scores items, manages alert and conversation state, and estimates bin fullness.
- A Next.js dashboard presents all of it live.
- **Photon 2.0** sends manager texts and receives their replies.
- **Grok Imagine** illustrates each bin's estimated contents, since a generated image is far cheaper than a live photo feed per bin.

## What's real vs. staged

This is a hackathon prototype, and it stays honest about it on screen: the demo footage is staged and recorded (not hand-labeled into the pipeline — the model processes it live, same as it would a real feed), any mocked integration is visibly labeled as such in the dashboard rather than hidden, demo timers are shortened from their real-world values, and before/after comparisons are never presented as proof of causation. The production ambition — plug into a business's own existing cameras, no staged footage required — is broader than what a hackathon demo can show in three minutes, but the full pipeline above is the same one that would run it.
