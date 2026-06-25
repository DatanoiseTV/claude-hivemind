---
description: Drive a goal with a tight Observe-Orient-Decide-Act loop over the hive
argument-hint: <goal — coding or not>
---

Goal: $ARGUMENTS

Pursue this with an explicit OODA loop, using the hive as your senses. The point
of OODA is the **Orient** step: each cycle, genuinely re-read the situation and be
willing to change or discard the plan when reality has moved — don't just march a
fixed plan to completion. Keep cycles short.

Each iteration:

1. **Observe.** Call the `observe` tool. It returns, in one shot, everything that
   changed in the hive since your last look: new messages, task changes, file
   changes (including external edits, builds, git), updated shared context, hive
   activity, what's ready to claim, and who's active. This is your sensor sweep.
2. **Orient.** Interpret it against the goal and your current plan. Ask: did
   something invalidate an assumption? Did a peer finish or change something I was
   about to do? Did files change under me? Is the plan still the right one, or
   does the new evidence call for a different move? Update your mental model
   first; re-frame if needed. Share any changed understanding with `share` so the
   hive stays aligned.
3. **Decide.** Choose the single most useful next action given the *current*
   situation — not the situation you planned for. That might be: claim a ready
   task (`task_next`), post or re-prioritize tasks, hand work to a peer
   (`send`/`dispatch`) or a subagent, lock a file, or just do the next step
   yourself.
4. **Act.** Do it. Record outcomes the hive needs (`task_update`, `share`), so the
   next Observe has signal.

Then loop. Stop when the goal's definition of done is met, when `observe` shows
nothing actionable left and nothing new is arriving, or when you're blocked and
need me. Don't spin: if two cycles pass with no progress and no new observations,
stop and tell me what's stuck rather than burning turns.

Give me a one-line read at each Orient ("situation changed: X, so I'm now doing
Y") so I can follow the loop. This works the same for non-coding goals — the
senses and the loop don't care about the domain.
