# Contributing to eln-core

Thanks for your interest. This is a focused runtime library — contributions that keep it small and composable are most welcome.

## What we want

- **New prompt styles** — e.g. English-language prompts, different narrative genres, other writing systems
- **Storage adapters** — Redis, Postgres, Cloudflare KV, etc.
- **LLM provider examples** — tested configs for different models
- **Example worlds** — templates beyond the built-in six
- **Bug fixes** — especially around streaming edge cases

## What to avoid

- Adding UI code to `src/` — this stays UI-agnostic
- Breaking the public API without discussion
- Adding npm dependencies (currently zero)

## How to contribute

1. Fork the repo
2. Create a branch: `git checkout -b feat/your-thing`
3. Make your changes
4. Test with `examples/node-basic.js`
5. Open a PR with a clear description

## Guiding principle

> The runtime handles what happens. The UI handles how it looks. Never mix the two.
