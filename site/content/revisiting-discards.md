# A discard is a decision about now, not forever

Run #7 failed. Eight runs later, the same idea was the best result in the session. Here's what changed in between — and what pi-autoresearch now does about it.

## The run that failed for the right reason

You're speeding up a website's build script. Every build turns a folder of pages and photos into the finished site, and it takes 48 seconds.

Run #7 tries the obvious idea: build eight pages at a time instead of one. The build comes back slower. The agent discards it and writes down why:

> **rollback_reason:** resizing photos already keeps every CPU core busy. Extra workers just fight over the same cores.

You'd have made the same call. No point spending more runs on something that just got slower.

## The assumption quietly stopped being true

Run #12 caches the resized photos, so a build only resizes the ones that changed. Build time drops. The agent keeps it, and the loop moves on.

But something else just changed, and nobody logged it: the CPU is mostly idle now. The whole reason #7 was rejected — "every core is already busy" — was true of the *old* build. It isn't true of this one.

The idea in the graveyard is now worth digging up.

## The question that sends it back

Nobody tells the agent to look at #7 again. Agents make that connection on their own sometimes — and "sometimes" is the problem.

So now, every time `log_experiment` records a result, pi-autoresearch appends one question to what the agent reads back, before it picks the next idea:

> Before choosing the next experiment, consider whether this result or discovery invalidates a previous discard's rollback reason. If so, name what changed and weigh a targeted retry against other candidates. Otherwise, move on. Don't revive a discarded idea without a changed assumption. Verification reruns to resolve measurement noise are separate.

After #12, the agent answers it:

> Does #12 invalidate an earlier discard? Yes. #7 was rejected because image resizing kept every core busy. Cached images leave the CPU mostly idle, so that rollback reason no longer holds. Retrying parallel page builds.

Run #15 turns the discard from #7 into the best result of the session:

```text
✓ #15 (wall: 14.3s, build_time: 14.30s) Retry parallel pages with cached images. │ ★ best: 14.30s
↻ Revisiting #7
```

No scheduler. No automatic reruns. One question, asked at the one moment it matters.

## Learning—or forgetting?

Watching an agent repeat itself makes you want to intervene. But ruling out every repeat would have ruled out this result, too.

That's why intentional retries carry `↻ Revisiting #N`. The agent sets `asi.revisits_run` to the earlier run number and records what it believes changed in the result's `description`. Both are visible in the transcript and saved in `.auto/log.jsonl`. You can check its reasoning without digging through the whole session.

You don't label the run or maintain a retry queue. The agent does.

## "Won't it just retry everything?"

That was my worry too. It's why the bar is *a changed assumption*, not *maybe this time*.

"The test database now runs in memory, so the timeout that sank batching is gone" — qualifies.

"It was within noise, let's try again" — that's a verification rerun. Still useful, still allowed, but it doesn't get a revisit marker.

A newly relevant discard becomes one more candidate for the next experiment, weighed against everything else. Nothing interrupts the loop.

## Try it on your next session

Update, start a session as usual, and watch for `↻ Revisiting #N`.

```bash
pi install npm:pi-autoresearch
```

The next time your agent goes back to an old idea, look for what changed.
