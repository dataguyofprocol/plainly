---
name: triage
description: Check a Plainly bug report or tester feedback against real evidence, find the root cause, judge whether it should be built at all, and return a verdict plus fix plan per item, without writing any code. Use when the user reports something wrong in a session ("my session got stuck", "LaTeX looks weird", "X isn't working"), pastes feedback from a tester, asks "is this a bug?", or asks to work through .memory/backlog.md items.
---

# Triage: bug reports and feedback

The result is a **verdict and fix plan for the user to approve**. Do not edit product code in this skill. AGENTS.md applies: put every design question to the user with AskUserQuestion, one question per call.

## 1. Split into items

- Break the input into separate items. Feedback often packs several complaints into one message.
- Restate each item as a claim that evidence can confirm or refute. Example: "a step page opens with only its title when the teacher moves on without a learner message", not "the lesson is broken".
- With 2 or more items, start one Explore subagent per item, in parallel. Give each one its claim and the evidence tools below, and ask it to report file:line findings.

## 2. Gather evidence

The user's data lives in their stored chats. Start there before reading code.

```bash
python3 -I .claude/skills/triage/chat.py list -n 10            # newest chats across all data dirs
python3 -I .claude/skills/triage/chat.py find "<words the user saw>"
python3 -I .claude/skills/triage/chat.py dump "<chat.json>" --from 40 --to 60
```

- `dump` shows each message's role, the model that **actually** answered, its `stopReason`, tool calls with their args, tool results with `isError`, and custom entries. Thinking is shown as a length only; add `--thinking` for the full text, and `--width 0` to turn off clipping.
- App logs: `~/Library/Application Support/Plainly/logs/`.
- A screenshot from the user is evidence too. Find its exact on-screen text in the chat.
- Never open, print, or copy values out of any `auth.json`. If the bug involves keys, check only which key names exist.
- If the chat is not on disk, say so, record what was checked, and mark the item **can't reproduce**. Do not guess.

## 3. Reproduce and find the root cause

Decide which side is at fault:
- **Model side:** the model emitted something wrong, such as double-escaped `\n`, a broken `$` math span, or a missing tool call. Name the model and provider from `dump`.
- **Our side:** a parse, heal, projection, render, or client-state bug. Find the code path and cite file:line.
- **Both:** the model emits something odd that our code should tolerate. Say which layer should absorb it, following the repo's "fix at the source, not at display" pattern.

Pick the cheapest way to reproduce:

a. **Throwaway test against the real chat.** Use this for state, projection, and parsing bugs.
   ```ts
   // tests/zz-repro-tmp.test.tsx (delete after use; never commit)
   import fs from "node:fs";
   import { projectView } from "../src/core/view.ts";
   const rec = JSON.parse(fs.readFileSync(process.env.F!, "utf8"));
   const view = projectView(rec.messages);
   // assert the claim against `view`
   ```
   Run it with `F="<chat.json>" NODE_ENV=test npx tsx --test tests/zz-repro-tmp.test.tsx`.

b. **Live app on a copy of the chat.** Use this for visual or interaction bugs.
   - `mkdir -p <scratchpad>/lhdata/chats` and copy that one chat into it.
   - Add a temporary entry to `.claude/launch.json`: `{"name":"triage-<slug>","runtimeExecutable":"env","runtimeArgs":["LH_DATA_DIR=<scratchpad>/lhdata","LH_AUTH_FILE=<HOME>/Library/Application Support/Plainly/auth.json","npx","next","dev","-p","<free port>"],"port":<free port>}`. Pass the auth file by path only; never read it.
   - `preview_start` it and inspect with the browser tools.
   - **Always** `preview_stop` and remove the entry from `launch.json` when done, even when the run fails.

c. **New-user and setup bugs:** `bash scripts/dev-fresh.sh --port <3005+>` gives a clean instance with no keys or data.

## 4. Should we build it?

Judge each confirmed item on its merits. Also judge feedback that is not a bug, such as feature requests and UX complaints.
- **Who hits it, and how often:** every learner, a provider setup, or one odd model.
- **How bad:** blocks a lesson, confuses, or cosmetic.
- **Cost:** how many files, how risky, whether it needs a design decision.
- **Fit with the product:** read `docs/vision.md`, especially the **DECIDED** items, the presentation principles, and §2.5. Treat §4 Roadmap as possibly out of date. Flag requests that go against a decided principle.
- **Prior rulings:** check `.memory/backlog.md` (local, gitignored) for the same item marked SKIPPED, DEFERRED, or FIXED, and respect owner rulings recorded there.

Verdicts:
- **build**
- **skip** (not worth it, or against the vision)
- **defer** (worth it, not now)
- **not a bug** (works as designed; maybe explain it better in the UI)

## 5. Report, then stop

For each item:

| Field | Content |
|---|---|
| Claim | the restated claim |
| Evidence | chat id and message indexes, log lines, file:line |
| Status | confirmed / refuted / can't reproduce |
| Root cause | model side / our side / both, and where |
| Verdict | build / skip / defer / not a bug, with a one-line reason |
| Fix plan | build items only: files to change, the approach, and tests to add |

- Ask open design questions with AskUserQuestion. Do not settle them inside the fix plan.
- For skip and defer items, offer an entry in `.memory/backlog.md` in its existing format: `## N. <Title> — added <YYYY-MM-DD>`, then `**Status:** …`, then **Observed:** and **To do:**. Write it only if the user says yes.
- End by asking which build items to start. Implementation follows only after the user approves.

## Cleanup check before reporting

- `tests/zz-repro-tmp.test.tsx` is deleted.
- No `triage-*` entry remains in `.claude/launch.json`, and every preview is stopped.
- `git status` shows no product-code changes made by this skill.
