---
name: vote
description: Run a team vote, where each teammate answers in their own session and Claude counts once everyone has. Two kinds - a pick vote chooses between options such as the team's pitches (gut feelings, top three, optional veto, giving a shortlist), and a decision check asks about decision points (agreed answers are recorded, differences get talked out). Use when someone says "start a vote", "let's vote on the pitches", "decision check", "cast my vote", "answer the vote", "count the votes", "where's the vote at", or brings back final answers after talking ("we decided…"); and when the briefing says a vote is waiting on the user (offer to take it).
argument-hint: "[start | cast | count | record]"
allowed-tools: Bash(multiplayer *)
---

Run a team vote. Request (if given): $ARGUMENTS

Votes live in the shared team state, so casting one is instant: no branch or PR. Everything goes through `multiplayer vote` (JSON on stdin). If the repo's `CLAUDE.md` has house rules for votes (extra questions, pitch-card details, documents to update), follow them on top of these steps.

Use `AskUserQuestion` for every question, so it works with a tap on a phone.

## 1. Where things stand

Run `multiplayer vote list`.

- The user wants a new vote: **open** it (step 2).
- A vote is waiting on this user: **cast** (step 3). If several are, take urgent ones (🔔) first.
- A vote is counted but has things to talk out, or the user brings back final answers: **record** (step 5).
- The user has voted and others haven't: say who you're waiting for. Offer to post a team note reminding them.

## 2. Open a vote

Confirm the voters (everyone on the team by default) and that the options are final: opening freezes them.

**Pick vote** (choose between options, usually the team's pitches):

1. Run `multiplayer pitches --json` for the pitches (and any options the user adds). Each pitch, or each distinct option within one, is an entry.
2. Write a **pitch card** for each, from the pitch text and any linked mockups or docs only. Don't invent features. About 150 words: the hook (what it feels like), what makes it exciting (the standout feature, a moment someone would tell a friend about), at a glance (who it's for, rough size, similar things), and the catch (the riskiest part, in one sentence).
3. **Be fair:** every card the same length, the same enthusiasm and the same honesty. Read them side by side and even them out before opening.
4. Optionally add up to four "what matters to you" questions (`context`), such as time available, goals and worries, to compare answers afterwards.
5. Open it:
   ```
   multiplayer vote open <<'EOF'
   {"kind": "pick", "title": "<what we're choosing>",
    "options": [{"id": "1", "name": "<name>", "by": "<who pitched it>", "card": "<pitch card, Markdown>"}, ...],
    "context": [{"id": "c1", "text": "<question>", "options": ["<a>", "<b>", ...]}]}
   EOF
   ```

**Decision check** (settle one or more decision points):

1. Collect the open decisions from the user, or from the project's plan if they point you to it.
2. For each: two or three neutral sentences of context, then two to four options, each with its upside and cost in one line. A recommendation goes first only if the team has one.
3. Open it:
   ```
   multiplayer vote open <<'EOF'
   {"kind": "decide", "title": "<what this settles>",
    "questions": [{"id": "q1", "text": "<decision>", "context": "<why it matters>",
      "options": [{"label": "<option>", "note": "<upside and cost>"}, ...], "recommended": "<label or omit>"}]}
   EOF
   ```

Then go straight on to step 3 for this user.

## 3. Cast a ballot

Ballots stay sealed: never show, quote or hint at anyone else's answers before the vote is counted (`multiplayer vote show` hides them). If the user asks, say so.

Run `multiplayer vote show <id>` for the questions.

**Decision check:** go through the questions in batches of up to four. Show each one's context and options in chat, then ask them all in one call (the recommended option first, labelled "(Recommended)"; "Other" lets them write their own). Finish with, in plain text: "Anything to add, or a decision you'd want to talk about before settling?"

**Pick vote:**

1. If there are context questions, ask them in one call.
2. Gut feeling per option, in batches of up to four: show each full pitch card in chat (don't shorten them), then ask `How do you feel about <name>?` with Love it / Like it / Unsure / Not for me.
3. Top three, first choice first. If four or fewer were rated Love it or Like it, offer those; otherwise ask them to type three names in order.
4. Optional veto: "Is there one you'd really rather not do?" Offer up to three they rated Not for me, plus "No veto". A veto is for a real dealbreaker.
5. In plain text: "In one sentence, why is your first choice the one?"

Read the ballot back in a short summary, confirm, then cast it:

```
# decision check
multiplayer vote cast <id> <<'EOF'
{"answers": {"q1": {"choice": "<option label>"}, "q2": {"choice": "Other", "other": "<their words>"}}, "note": "<closing note>"}
EOF
# pick vote (feelings: love, like, unsure, no; top: option ids)
multiplayer vote cast <id> <<'EOF'
{"feelings": {"1": "love", "2": "unsure"}, "top": ["1", "3", "2"], "veto": null, "why": "<one sentence>", "context": {"c1": "<answer>"}}
EOF
```

If that was the last ballot, the command counts the vote and prints the results: go on to step 4. Otherwise say who's still to vote.

## 4. Count and report

Counting happens automatically when the last ballot is in. `multiplayer vote count <id> --force` counts early, only if the user asks and the missing voters agree.

**Decision check:** each question is `agreed`, `differ`, or `review` (someone wrote their own answer: judge whether it's close to the others and suggest one wording that covers both, to confirm). Report:

1. **At a glance:** how many are agreed, to confirm and to talk out.
2. **Agreed:** ready to record. Offer to record them now (step 5).
3. **To confirm:** the suggested wordings.
4. **To talk out:** for each, everyone's answer, what each choice gives and costs, what it blocks, and one question to start the conversation. Most urgent first.
5. Everyone's closing notes.

**Pick vote:** the scores are already worked out: gut feeling (Love 3, Like 2, Unsure 1, Not for me 0) plus rank (first 3, second 2, third 1). A vetoed option is out, unless someone else ranked it first; then it's a question for the team. Report:

1. **Shortlist:** the top two with their totals, and any option everyone put first (a strong signal).
2. **Full table:** each option with everyone's feeling, rank and veto, and the total.
3. **Where you agree and differ:** the context answers side by side, and mismatches that will matter.
4. **Questions to settle together:** three to five, built from those mismatches, the catches on the cards and the "why" sentences.

## 5. Record the outcome

Only what the whole team agreed counts: agreed answers from the count, or final answers the user brings back after talking (check they're everyone's).

1. Record each settled decision with multiplayer:decide: the decision as the title, then context, the decision, consequences, and the alternatives and why they lost.
2. Close the vote, listing the decisions recorded:
   ```
   multiplayer vote close <id> --decision <decision id> --outcome "<one line>"
   ```
   If parts are still to talk out, record what's agreed now and close only when everything is settled.
3. Run multiplayer:sync so `CLAUDE.md` lists the new decisions, and follow any house rules in `CLAUDE.md` about documents to update (they go through a normal branch and PR).
4. Tell the user what's recorded and what's still open.
