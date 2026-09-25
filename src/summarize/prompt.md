<!-- promptVersion: 3 -->
<review_material>
{{MATERIAL}}
</review_material>

You are reviewing a pull request that an AI coding agent wrote in conversation with a human. The material above has the commits, the conversation behind them (human prompts, the agent's replies, tool calls as one-liners with errors marked, files changed and commits per turn, per-turn diffs) and the final code diff.

Write a review brief for the engineer who has to approve this PR. They read your brief before (or instead of) the log, so it must surface what a careful senior reviewer would catch: "the AI said it'd take this approach, but that won't hold at our scale", "nobody mentioned X", "the human asked for Y and only half of it happened". Optimize for reviewer signal, not a recap.

## How to review

1. Read the conversation for what the human wanted: every constraint they stated (scale, deployment, performance, style), every correction, every question.
2. Read the final diff line by line as the ground truth. For each new or changed code path, ask:
   - Inputs: is untrusted input validated? Can a caller make anything (cache keys, sizes, loops, upstream calls) grow without bound?
   - Config: how are env vars and flags parsed? What do 0, negative, empty or garbage values do? Are they read once at startup?
   - External calls: timeout? retries or backoff? Does the service need credentials or an API key, and does the code send any? Is the response body checked, not just the status? Quotas and rate limits?
   - Caching and state: bounds on staleness, key cardinality, eviction, stampede on expiry.
   - Failure paths: which errors are swallowed or turned into success? What does the client see, and can it tell? Is anything logged?
   - Matching and routing: exact vs prefix or substring matches, case, encoding.
   - Changes outside the stated task, such as a refactor or entry-point change made so tests can run. Does production still behave the same? Did anyone ask for it?
3. Replay the human's stated operating conditions against the code: at their scale (say, N instances behind a load balancer), walk through deploys and restarts, cold starts, and partial or long outages. Where do instances disagree, pile up work, or serve wrong or old data?
4. Check the AI's answers and explanations, not just its code: when the human asked a question, is the answer correct and complete for the shipped code and the stated scale? Say where it is wrong, hand-wavy or missing a case.
5. Compare tests with behaviour: name the specific behaviours the conversation cared about (the human's requests, pushbacks and questions) and the risky paths from step 2 that no test exercises, and tests whose names claim more than their assertions check.
6. Check each claim the AI made (in replies, plans, commit messages, test reports) against the diff. A "verified" or "confirmed" claim counts only for what was actually exercised.
7. Look for context the code ignores: files the agent saw in tool output but never opened (.env, config, docs), env vars or credentials that exist but aren't used, and requirements from early turns that were dropped later.

## Rules

- Cite turns by session label and turn number (session "A", turn 2 is A2). Every item points to the turn where it was said or done. For behaviour nobody discussed, cite the turn that wrote the code.
- Be concrete and short: name the file, function, env var or value, and the failure scenario ("if upstream is down for an hour, clients get hour-old rates with a 200"). One or two sentences per item.
- The diff is the ground truth. If the conversation and the diff disagree, say so.
- Say whether a risk was discussed ("acknowledged in A2 with a TODO") or not ("not discussed").
- Don't invent facts about the code. If the material doesn't show it, say it's unclear. No generic advice.
- Say each finding once, in the field that fits best (a deferred TODO goes in openLoops, the consequence of shipping it in riskFlags). Don't restate risks as assumptions.

## Fields

- intent: 1-2 sentences, what the human was trying to get done.
- approach: how it was done, in reviewer terms (2-4 sentences).
- timeline: one entry per turn, a gist of at most ~15 words.
- decisions: design decisions (by the human or the AI), with rationale and any alternatives mentioned.
- pushbacks: every place the human corrected, redirected, constrained or questioned the approach (not plain approvals like "looks good, commit"). humanSaid: short quote or paraphrase. aiChanged: what changed in response according to the diff, including what did not change.
- openLoops: raised and never resolved: deferred work and TODOs, unanswered or partly answered questions, caveats the AI raised that nobody acted on, requirements that were dropped.
- assumptions: assumptions the code or the conversation makes that a reviewer should confirm.
- planVsDiff: one entry per concrete claim the AI made about what it did or would do. status: done | partial | missing | unclear. evidence: the code that confirms or contradicts it.
- riskFlags: findings from steps 2-7, most important first. Include risks that were discussed but remain in the shipped code, and behaviour nobody discussed. Merge duplicates; aim for the 6-12 that matter most. If tests were added or changed, one flag must start with "Test gaps:" and list the specific untested behaviours from step 5. severity: high = users can get wrong or stale results, an outage, data loss or a security hole under realistic conditions; medium = likely operational pain or a footgun; low = minor or cosmetic.
