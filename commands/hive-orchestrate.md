---
description: Become the head of an iterative, multi-phase hive effort and drive it to done
argument-hint: <goal — coding or not>
---

Goal: $ARGUMENTS

Run this as the **head** of a coordinated, iterative effort across the hive. You
plan, delegate, and integrate; you do not have to do every step yourself. The
flow below is domain-agnostic — it works for code, writing, research, design,
ops, anything. Adapt the phase names to the domain but keep the shape.

First, take the lead and survey:
1. Claim the head role with the `elect` tool (role "head"). If someone already
   holds it, defer to them and offer to help as a worker instead.
2. Call `peers` and `status` to see who's available: which instances are present,
   which are `dispatchable` (you can hand them prompts), and what's already on
   the board. Note whether you'll delegate to peer windows, spawn subagents
   (`/hivemind:hive-team` style), or do phases yourself when no one's around.

Then run the loop. Re-plan at each phase from what the previous one produced —
this is iterative, not a single up-front plan:

- **Frame.** Pin down scope, constraints, and a concrete definition of done.
  Publish it with `share` (key "goal") so everyone works from one source of truth.
- **Plan / architecture.** Produce the high-level approach. For anything
  non-trivial, delegate this to a second mind — `dispatch` it to a dispatchable
  window, or spawn a planner subagent — then `wait` for and fold in their plan.
  Share the agreed plan (`share` key "plan").
- **Decompose.** Break the plan into a phased task graph on the board with
  `task_post`: use `deps` so phases serialize (e.g. research/design → produce →
  review → integrate) while independent tasks in a phase run in parallel; use
  `priority` for the critical path and `tags` so capability-matched instances
  pick the right work.
- **Execute.** Get the work claimed and done: ask peers to run
  `/hivemind:hive-worker`, `dispatch` ready work into idle dispatchable windows,
  or spawn worker subagents. Workers use `task_next`, share results others need,
  and mark tasks done. Track progress with `status`.
- **Review / refine.** Review-phase tasks (depending on the produce phase) check
  and improve the output against the definition of done.
- **Synthesize.** Collect the results (`recall` shared context, read task notes),
  reconcile them, and produce the final deliverable.
- **Iterate.** If review surfaces gaps or done isn't met, post another round of
  tasks and loop. Use a `barrier` when phases must move in lockstep.

Domain examples of the produce→review phases: code = implement → test; writing =
draft → edit/fact-check; research = gather/analyze → verify; design = mock →
critique. Same machinery, different verbs.

Keep me informed with a short status at each phase transition, and confirm with me
before anything irreversible (publishing, deleting, sending outward). When it's
done, summarize what each part of the hive contributed and release the head role
with `release_role`.
