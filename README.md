# eln-core

**Open-source Agentic Story World Runtime**

The narrative engine behind [ELN · 空镜叙事](https://eln-app.vercel.app) — extracted, documented, and ready to build on.

```
World State → Prompt Engineering → Streaming Narrative → State Extraction → Loop
```

---

## What this is

`eln-core` is the runtime that powers AI-driven persistent story worlds. It handles:

- **World generation** — LLM generates world background, characters, chapters from a template or free-form prompt
- **Turn engine** — each turn streams narrative prose, then silently extracts state changes (emotions, trust, location, tension)
- **Character agents** — each character has personality, goals, secrets, and dynamic trust relationships
- **God-mode controls** — inject events, force secret reveals, set per-character directives
- **Snapshots & rewind** — branch timelines, rewind to any saved state
- **Persistence** — save/load worlds from localStorage (browser) or your own storage

It is **UI-agnostic**. Bring your own frontend — chat bubble, novel reader, game map, whatever.

---

## Install

```bash
npm install eln-core
```

Or use directly in the browser:

```html
<script type="module">
  import { ELNRuntime } from 'https://esm.sh/eln-core'
</script>
```

---

## Quick Start

```js
import { ELNRuntime } from 'eln-core'

const eln = new ELNRuntime({
  apiKey: 'sk-your-key-here',   // DeepSeek, OpenAI, or any compatible API

  // Receive streamed tokens in real time
  onToken: token => process.stdout.write(token),

  // Called when each turn fully completes
  onTurnEnd: result => {
    console.log('Summary:', result.summary)
    console.log('Tension:', result.worldState.tension)
  },
})

// 1. Generate a world
const world = await eln.generateWorld('republican')  // 民国谍战
eln.loadWorld(world)

// 2. Run a turn
await eln.runTurn()

// 3. God-mode: inject an event next turn
await eln.runTurn({ intervention: '一封神秘信件突然出现在桌上' })

// 4. Force a character to reveal their secret
eln.forceSecretReveal('李明远', '谢云舒')
await eln.runTurn()

// 5. Advance to next chapter
eln.nextChapter('聚焦两人之间的信任危机')
```

---

## API Reference

### `new ELNRuntime(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | **required** | LLM API key |
| `model` | `string` | `deepseek-chat` | Model identifier |
| `apiBase` | `string` | `https://api.deepseek.com` | API base URL |
| `onToken` | `(token: string) => void` | — | Streaming token callback |
| `onLine` | `(line: string) => void` | — | Completed line callback |
| `onTurnEnd` | `(result: TurnResult) => void` | — | Turn completion callback |

---

### World Generation

```js
// From built-in template
const world = await eln.generateWorld('ancient')

// From free-form prompt
const world = await eln.generateWorld(null, '三个间谍在民国上海互相不知道对方身份')

// Load into runtime
eln.loadWorld(world)
```

**Built-in templates:** `ancient` · `republican` · `mystery` · `xianxia` · `campus` · `apocalypse`

You can also pass any string as `templateKey` — it's injected directly into the prompt.

---

### Turn Execution

```js
const result = await eln.runTurn({
  intervention: 'Optional god-mode event string',
})

// result shape:
{
  narrativeText: string,      // Full narrative prose from LLM
  worldState:    WorldState,  // Updated world state
  characters:    Character[], // Updated characters
  chapters:      Chapter[],
  secretReveals: Array,       // Any secrets revealed this turn
  editorNote:    string|null, // LLM's 15-char editorial comment
  suggestClose:  boolean,     // Whether LLM suggests closing the beat
  summary:       string,      // One-line summary
}
```

---

### God Mode

```js
// Inject an event into next turn
await eln.runTurn({ intervention: '地震突然发生' })

// Give a character a one-shot directive
eln.setCharDirective('角色名', '本回合保持沉默，暗中观察')

// Force secret reveal
eln.forceSecretReveal('李明远', '谢云舒')
```

---

### Chapter Management

```js
// Advance to next chapter (returns false if story is complete)
const advanced = eln.nextChapter('下一章聚焦：叛徒身份揭露')
```

---

### Snapshots

```js
// Save current state
const snap = eln.saveSnapshot()

// Rewind to last snapshot
eln.rewindTo()

// Rewind to specific snapshot index
eln.rewindTo(0)
```

---

### Persistence

```js
// Save to localStorage (browser)
eln.save('user-123')

// Load saved worlds
const worlds = ELNRuntime.getSavedWorlds('user-123')
```

---

### Using Your Own LLM

`eln-core` uses the OpenAI chat completions format. Any compatible endpoint works:

```js
// OpenAI
const eln = new ELNRuntime({
  apiKey: 'sk-...',
  apiBase: 'https://api.openai.com',
  model: 'gpt-4o',
})

// Moonshot (Kimi)
const eln = new ELNRuntime({
  apiKey: 'sk-...',
  apiBase: 'https://api.moonshot.cn/v1',
  model: 'moonshot-v1-8k',
})

// Local Ollama
const eln = new ELNRuntime({
  apiKey: 'ollama',
  apiBase: 'http://localhost:11434/v1',
  model: 'qwen2.5:14b',
})
```

---

### Lower-Level API

If you want full control, use the building blocks directly:

```js
import {
  buildWorldGenPrompt,
  buildNarrativePrompt,
  buildStateUpdatePrompt,
  initFromGeneratedWorld,
  applyStateUpdate,
  advanceChapter,
  createSnapshot,
  LLMClient,
} from 'eln-core'
```

---

## Data Structures

### `WorldState`
```ts
{
  id: string
  name: string
  background: string
  outline: string
  turn: number
  currentChapter: number
  time: string
  location: string
  tension: number          // 0–100
  _nextChapterHint: string
}
```

### `Character`
```ts
{
  name: string
  role: string
  personality: string
  secret: string
  goal: string
  weightTag: string        // 男主|女主|男二|女二|反派|隐藏角色
  trigger: string          // ai|alone|secret|tension|emotion
  alive: boolean
  emotion: string
  trustWith: Record<string, number>  // 0–100 per character
}
```

### `Chapter`
```ts
{
  id: number
  name: string
  goal: string
  targetTurns: number
  completedTurns: number
  status: 'active' | 'locked' | 'done'
  beats: Array
}
```

---

## Extending

### Custom Prompts

Override any prompt by building on the exported builders:

```js
import { buildNarrativePrompt } from 'eln-core'

function myPrompt(worldState, characters, chapters, turns, options) {
  const base = buildNarrativePrompt(worldState, characters, chapters, turns, options)
  return base + '\n\nAdditional constraint: write in the style of Raymond Chandler.'
}
```

### Custom Storage

`saveWorld` / `loadWorlds` use `localStorage` by default. For server-side storage, use `createSnapshot` / `restoreSnapshot` directly and persist the JSON yourself.

---

## Examples

- [`examples/node-basic.js`](examples/node-basic.js) — Minimal Node.js usage
- [`examples/browser-demo.html`](examples/browser-demo.html) — Drop-in browser demo
- [ELN App](https://eln-app.vercel.app) — Full production UI built on this runtime

---

## License

Apache-2.0 — commercial use welcome.

---

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

The most useful contributions right now:
- Additional language support (English, Japanese prompts)
- Alternative LLM prompt styles
- Example worlds and templates
- Server-side storage adapters (Redis, Postgres, etc.)
