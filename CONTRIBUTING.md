# Contributing to eln-core

Thanks for your interest. This is a focused runtime library — contributions that keep it small and composable are most welcome.

## What we want

- **New genre / style packs** — a pack is a data object now, not prompt code
  (see `src/expression/packs/`). English and other writing systems especially.
- **Storage adapters** — Redis, Postgres, Cloudflare KV, etc. Implementing
  `StorageAdapter` is enough; see `src/memory/adapters/`.
- **Retrieval adapters** — a vector retriever to sit alongside the default
  keyword one.
- **LLM provider examples** — tested configs for different models
- **Example worlds** — templates beyond the built-in six
- **Bug fixes** — especially around streaming edge cases

## What to avoid

- Adding UI code to `src/` — this stays UI-agnostic
- Breaking the public API without discussion
- **Adding runtime dependencies without discussion.** The bar is high: a dependency
  must be load-bearing for the contract layer or the transport, not a convenience.
  The only runtime dependency today is `zod` (schema validation + type generation,
  see `DESIGN.md` §10.6). Retrieval and storage stay adapters — implement an
  interface, don't add a package.

## How to contribute

1. Fork the repo
2. Create a branch: `git checkout -b feat/your-thing`
3. Make your changes
4. Test with `examples/node-basic.js`
5. Open a PR with a clear description

## Guiding principle

> The runtime handles what happens. The UI handles how it looks. Never mix the two.
