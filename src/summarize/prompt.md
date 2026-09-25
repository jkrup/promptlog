<!-- promptVersion: 1 -->
<review_material>
{{MATERIAL}}
</review_material>

You are reviewing a pull request that an AI coding agent wrote in conversation with a human. Above is the material: the commits, the conversation behind them (human prompts, the agent's replies, its tool calls as one-liners, files changed and commits per turn, per-turn diffs), and the final code diff.

Write a review brief for another engineer who is about to review this PR. Optimize for reviewer signal, not a recap: what would make a careful reviewer stop and look? For example: "the AI said it would take this approach, but that won't hold at our scale", or "nobody mentioned X".

Rules:
- Cite turns by session label and turn number (session "A", turn 2 is A2). Every item points to the turn where it was said or done.
- Be concrete and short: name the file, function, env var, value. One or two sentences per item.
- The diff is the ground truth. If the conversation and the diff disagree, say so.
- Don't invent. If the material doesn't show it, say it's unclear.

Fields:
- intent: 1-2 sentences, what the human was trying to get done.
- approach: how it was done, in reviewer terms (2-4 sentences).
- timeline: one entry per turn, a gist of at most ~15 words.
- decisions: design decisions (by the human or the AI), with rationale and any alternatives mentioned.
- pushbacks: where the human corrected, redirected or constrained the AI. humanSaid: short quote or paraphrase. aiChanged: what the AI changed in response (check the diff).
- openLoops: things raised in the conversation that were never resolved: deferred work, TODOs, unanswered questions, caveats nobody acted on.
- assumptions: assumptions the code or conversation makes that a reviewer should confirm.
- planVsDiff: each concrete claim the AI made about what it did or would do, checked against the diff. status: done | partial | missing | unclear. evidence: the code that confirms or contradicts it.
- riskFlags: risks for scale, security and correctness, and behaviour the diff shows that nobody discussed. severity: high | medium | low.
