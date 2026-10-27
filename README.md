<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/plainly_banner_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/plainly_banner_light.png">
    <img src="docs/assets/plainly_banner_light.png" alt="Plainly" width="640">
  </picture>
</p>

<p align="center"><strong>An agent harness for learning.</strong></p>

<p align="center">
  <a href="https://github.com/dataguyofprocol/plainly/releases">Download</a> ·
  <a href="#how-a-lesson-works">How it works</a> ·
  <a href="#new-in-010">What's new</a> ·
  <a href="docs/development.md">Documentation</a> ·
  <a href="https://github.com/dataguyofprocol/plainly/issues">Issues</a>
</p>

Tell Plainly what you want to understand. It finds out what you already know, maps a path from there to your goal, and teaches you one step at a time.

Instead of handing you an explanation, it reads your answers and your reasoning and decides what you need next. Everything you learn goes into a knowledge graph, so the next session picks up where this one ended.

![A Plainly lesson: the explanation on the left, the open question in the side panel](docs/assets/lesson.png)

## How a lesson works

1. **Measure:** before teaching anything, it asks questions to find where your understanding runs out.
2. **Plan:** it maps the steps from there to your goal. The Path tab shows the map and where you are on it, and the plan changes when your answers surprise it.
3. **Teach:** each step builds on something you already get. You predict, read, then check yourself, with the question in a panel right beside the text. Confusions get fixed before anything is built on top of them.
4. **Practice:** sets of five problems where you have to recall the right idea without being told which one.

The goal is for the idea to feel obviously true, not just familiar.

Every question comes with a box for your thinking and a "How sure?" switch: guessing, unsure, fairly sure, or certain. Type or dictate. That's what gives Plainly a detailed picture of how you think, beyond a record of right and wrong answers.

When a picture would help, the agent can draw a diagram or build an interactive demo. It can also go research a question in the background while you keep learning.

## Pick up where you left off

![Plainly Home: one composer, what is waiting on you, and this week's progress](docs/assets/home.png)

Home is one text box. Type a topic and pick Learn or Practice, or start from a suggestion pulled from your graph. Underneath sits the question that's waiting on you and this week's minutes against your goal.

Press ⌘K anywhere to start something new or find an old session or idea.

## Practice

![A Plainly practice problem with a nudge in the working panel](docs/assets/practice.png)

Write your working in the panel. When you're stuck, ask for a nudge, then a bigger hint, then the first step. Hints read what you've written so far and answer only the next thing blocking you, so a nudge is a sentence or two. The problem card remembers which hints you used.

## Knowledge that sticks around

![The Plainly knowledge graph with an idea selected and its chain lit](docs/assets/knowledge.png)

What you learn piles up as ideas and the reasoning that links them. Click one to light up what it rests on and what it leads to, then add it to practice or open a deeper session on it. You can import your own notes too.

Future lessons read this graph instead of starting from scratch. It holds ideas and how they connect. It never scores you.

## Get started

**[Download for macOS (Apple Silicon)](https://github.com/dataguyofprocol/plainly/releases)**

Drag it to Applications. The app isn't signed with an Apple Developer ID yet, so the first time, right-click it and choose Open. That's also why updates aren't automatic for now: grab new versions from Releases.

Windows and Linux builds are coming. Until then, [run from source](#development).

Plainly runs on your models. Connect OpenAI, Anthropic, OpenRouter, DeepSeek, Z.AI, or any OpenAI-compatible endpoint like Ollama or vLLM (30+ options in all), pick your models, and start a lesson. Dictation and web search are optional and use their own keys.

## Your keys, your data

- No Plainly subscription, no markup. You pay your providers directly, and a live meter shows what each session costs.
- Your chats, graph, settings, and API keys live on your machine as plain files you can open and read.
- Local storage doesn't mean offline. Model calls, web research, and dictation send what the task needs to those services.
- Every system prompt is visible and editable, and the whole app is open source.

## New in 0.1.0

This is the first release under the Plainly name. Coming from LearnHarness 0.3.7, you get a redesigned interface with dark mode, the new Home screen, lessons with a side panel, rebuilt practice, the Knowledge page, and custom OpenAI-compatible providers.

On first launch, Plainly copies your LearnHarness data into its own folder and leaves the original untouched.

## Development

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # deterministic, no LLM, no network
```

Read the [development guide](docs/development.md), the [architecture notes](docs/architecture.md), and the [desktop release guide](docs/desktop-release.md). Bugs, questions, and ideas go in [GitHub Issues](https://github.com/dataguyofprocol/plainly/issues).

## License

[AGPL-3.0](LICENSE). Based on [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist; see [NOTICE](NOTICE).
