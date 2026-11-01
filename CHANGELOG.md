# Changelog

Every Plainly release, newest first. Plainly is a fork of [LearnHarness](https://github.com/amosblomqvist/learnharness) 0.3.7 by Amos Blomqvist; its earlier history lives there.

Install or update with the command in the [README](README.md#get-started), or from Plainly → Check for Updates….

## 0.1.6 — 2026-11-01

Plainly 0.1.6 makes custom model servers work on the first try, and makes the opening check-in shorter and clearer.

- **Custom models start with Vision and Thinking on.** When you connect an OpenAI-compatible server that doesn't describe its models, each model now starts with Vision and Thinking on. Before, they started text-only, so setup had no vision model to offer and you couldn't save. If your server does say what a model can do, Plainly uses that. Turn either off in the model's row if a model doesn't support it.
- **A clearer first question.** The tutor now starts by asking how deep you want to go. Each option includes the ones before it, so you only pick one.
- **A shorter check-in.** Before testing what you already know, the tutor says in a sentence that a few quick questions will find your starting point. It now aims for about 8 questions in total.

## 0.1.5 — 2026-10-31

Plainly 0.1.5 lets you hand the tutor your own files, and fixes two ways a lesson could look stuck.

- **Attach files to a lesson.** Use the paperclip, or drop a file onto the box where you type, on Home or in a lesson. Markdown, text, PDFs and common images (JPG, PNG, GIF, WebP, BMP) work. The tutor reads the file from where it is on your Mac. Nothing is uploaded or copied. Attached files show as chips you can remove before sending, and stay visible in the message afterwards. A file Plainly can't read is refused with a short note saying why.
- **A new step never opens blank.** When the tutor moved on to the next step without you typing anything in between, the new step's page could show only its title, with the tutor's questions and explanation hidden under the earlier steps. They now show on the step they belong to, and the "right first time" count only includes earlier steps.
- **The lesson starts after the check-in.** If a background task finished during the opening check-in, the tutor sometimes didn't start planning until you typed something. It now starts right away.

## 0.1.4 — 2026-10-29

Plainly 0.1.4 fixes dictation and makes it clearer what it's doing.

- **Dictation tells you when something's wrong.** Before, if your Deepgram key was missing or rejected, or the microphone was blocked, clicking the mic quietly did nothing. Now the reason appears under the field. For key problems, a **Fix key** link takes you straight to the Deepgram key in Settings. A key that Deepgram refuses because it needs the Member role now says so.
- **Words appear as you speak.** Each phrase lands in the field a moment after you pause, instead of all at once when you stop.
- **You can see it listening.** The mic's bars move with your voice, and stay flat while it's still connecting.
- **You can see where the words go.** The field being dictated into is outlined while you speak.
- **Every mic works.** The mics in the answer box, "Thinking while reading" and the practice "Your working" box all start and stop dictation.
- **Esc keeps your words.** Pressing Esc stops dictation and keeps what you said, instead of throwing it away.

## 0.1.3 — 2026-10-28

Plainly 0.1.3 fixes how question text and math show up.

- **Explanations break into paragraphs again.** Some models wrote line breaks as the characters `\n`, so the "Why" under an answered question showed `\n\n` in the middle of the text. Plainly now turns them into real line breaks, including in lessons you've already done. Math such as `\nabla` or `\neq` is left alone.
- **Math in previews.** The home screen's "Waiting on you" card and the "Check your understanding" row showed math as bare command names, like "Qclubsuit" for Q♣. They now show the real symbols.
- **Shorter helper text under questions.** The text under a question is now one or two short sentences written to you, and no longer repeats the answer options.

## 0.1.2 — 2026-10-28

Plainly 0.1.2 lets your own OpenAI-compatible servers handle images and thinking.

- **Vision and thinking for your own models.** Each model on an OpenAI-compatible endpoint (vLLM, LM Studio, Ollama, a gateway) now has its own Vision and Thinking switches, plus its context window and max output. Before, every such model was treated as text-only, so none of them could be picked as the vision model, and images sent to them never arrived.
- **Filled in for you where the server says.** "Find models" reads what the server reports about each model (OpenRouter-style gateways, vLLM, Ollama and LM Studio) and sets the switches and limits to match. Anything it can't tell stays off, for you to set.
- **Thinking that matches your server.** Servers ask models to think in different ways, so a thinking model lets you pick the format: OpenAI, Qwen, DeepSeek, Z.AI, Together, OpenRouter and others.
- **Edit endpoints after you add them.** Settings → Providers now lists your OpenAI-compatible endpoints. Open one to rename it, change its URL or key, add or remove models, or change what each model can do.

## 0.1.1 — 2026-10-27

Plainly 0.1.1 fixes how the window looks on macOS.

- **A real title bar on macOS.** The close, minimise and zoom buttons used to sit on the sidebar's corner, right against the Plainly logo. They now have their own bar across the top of the window and stay in the same spot on every screen and at every zoom level. The lesson title and the Knowledge heading sit in that bar next to them, and you can drag the window by any empty part of it.
- **Narrow windows.** Below 800 pixels wide, the icon bar along the top no longer slides off the edge of the window.

## 0.1.0 — 2026-10-27

Plainly 0.1.0 is the first release under the new name. Compared with LearnHarness 0.3.7, it adds:

- **A new interface.** A calmer, redesigned look throughout, in light and dark (follows your system or set it in Settings), with a grouped sidebar that folds to a rail, and ⌘K to start or find anything.
- **Home.** One composer for Learn and Practice, what is waiting on you, and a weekly progress strip with a goal.
- **Lessons with a side panel.** The open question, the plan (Path), and background helpers sit beside the text instead of under it.
- **Four-level confidence.** "How sure?" is guessing, unsure, fairly sure, or certain.
- **Practice rebuilt.** A working panel, sets of five, and short hints in three steps: nudge, bigger hint, first step.
- **Knowledge page.** Topics, an idea card with what each idea rests on and leads to, and Add to practice / Go deeper.
- **Custom providers.** Connect any OpenAI-compatible endpoint, with its models listed alongside the built-in ones.
- **Moving from LearnHarness.** On first launch, Plainly copies your LearnHarness data into its own folder. The original folder is left untouched.
