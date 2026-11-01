<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/plainly_banner_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/plainly_banner_light.png">
    <img src="docs/assets/plainly_banner_light.png" alt="Plainly" width="640">
  </picture>
</p>

<p align="center"><strong>An agent harness for learning.</strong></p>

<p align="center">
  <a href="#get-started">Install</a> ·
  <a href="#how-a-lesson-works">How it works</a> ·
  <a href="#new-in-010">What's new</a> ·
  <a href="docs/development.md">Documentation</a> ·
  <a href="https://github.com/dataguyofprocol/plainly/issues">Issues</a>
</p>

Tell Plainly what you want to understand. It finds out what you already know, maps a path from there to your goal, and teaches you one step at a time.

https://github.com/user-attachments/assets/452b6efc-e9b2-4949-8170-63214491a049

Instead of handing you an explanation, it reads your answers and your reasoning and decides what you need next. Everything you learn goes into a knowledge graph, so the next session picks up where this one ended. You can import your own notes too, and the graph never scores you.

## How a lesson works

1. **Measure:** before teaching anything, it asks questions to find where your understanding runs out.
2. **Plan:** it maps the steps from there to your goal, and the plan changes when your answers surprise it.
3. **Teach:** each step builds on something you already get. You predict, read, then check yourself. Confusions get fixed before anything is built on top of them.
4. **Practice:** sets of five problems where you have to recall the right idea without being told which one.

The goal is for the idea to feel obviously true, not just familiar.

Every question comes with a box for your thinking and a "How sure?" switch: guessing, unsure, fairly sure, or certain. Type or dictate. That's what gives Plainly a detailed picture of how you think, beyond a record of right and wrong answers.

When a picture would help, the agent can draw a diagram or build an interactive demo. It can also go research a question in the background while you keep learning.

Press ⌘K anywhere to start something new or find an old session or idea.

## Get started

On a Mac with Apple Silicon, paste this into Terminal:

```sh
curl -fsSL https://github.com/dataguyofprocol/plainly/releases/latest/download/install.sh | sh
```

It installs Plainly in Applications and opens it. Plainly then updates itself: new versions download in the background and install when you restart. Plainly isn't signed with an Apple Developer ID yet, and macOS blocks unsigned apps downloaded in a browser, which is why there's no download link. The [script](scripts/install.sh) is short if you want to read it first.

To uninstall, delete Plainly from Applications. Your data stays in `~/Library/Application Support/Plainly` until you delete that too.

Windows and Linux builds are coming. Until then, [run from source](#development).

Plainly runs on your models. Connect OpenAI, Anthropic, OpenRouter, DeepSeek, Z.AI, or any OpenAI-compatible endpoint like Ollama or vLLM (30+ options in all), pick your models, and start a lesson. Dictation and web search are optional and use their own keys.

## Your keys, your data

- No Plainly subscription, no markup. You pay your providers directly, and a live meter shows what each session costs.
- Your chats, graph, settings, and API keys live on your machine as plain files you can open and read.
- Local storage doesn't mean offline. Model calls, web research, and dictation send what the task needs to those services.
- Every system prompt is visible and editable, and the whole app is open source.

## What's new

**0.1.6:** custom model servers work on the first try, and the opening check-in is shorter and clearer.

See [CHANGELOG.md](CHANGELOG.md) for every release.

## Development

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # deterministic, no LLM, no network
```

Read the [development guide](docs/development.md), the [architecture notes](docs/architecture.md), and the [desktop release guide](docs/desktop-release.md). Bugs, questions, and ideas go in [GitHub Issues](https://github.com/dataguyofprocol/plainly/issues).

## License

[AGPL-3.0](LICENSE). Based on [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist; see [NOTICE](NOTICE).
