/**
 * ELN Core
 *
 * Open-source Agentic Story World Runtime
 * https://github.com/lant1ng-1216/eln-app
 *
 * @example
 * import { ELNRuntime } from 'eln-core'
 *
 * const eln = new ELNRuntime({ apiKey: 'sk-...' })
 * const world = await eln.generateWorld('ancient')
 * eln.loadWorld(world)
 *
 * eln.onLine = line => console.log(line)
 * const result = await eln.runTurn()
 */

export { ELNRuntime }         from './src/runtime.js';
export { LLMClient }          from './src/llm-client.js';
export {
  buildWorldGenPrompt,
  buildNarrativePrompt,
  buildStateUpdatePrompt,
}                             from './src/prompts.js';
export {
  initFromGeneratedWorld,
  applyStateUpdate,
  advanceChapter,
  createSnapshot,
  restoreSnapshot,
  saveWorld,
  loadWorlds,
}                             from './src/state.js';
