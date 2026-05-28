/**
 * ELN Core — Minimal Node.js Example
 *
 * Run: node examples/node-basic.js
 * Requires: DEEPSEEK_API_KEY environment variable
 */

import { ELNRuntime } from '../index.js';

const eln = new ELNRuntime({
  apiKey: process.env.DEEPSEEK_API_KEY,

  // Receive streamed tokens in real time
  onToken: token => process.stdout.write(token),

  // Called when a full turn completes
  onTurnEnd: result => {
    console.log('\n\n── Turn complete ──');
    console.log('Summary:', result.summary);
    console.log('Tension:', result.worldState.tension);
    console.log('Location:', result.worldState.location);
    if (result.secretReveals.length) {
      console.log('Secret reveals:', result.secretReveals);
    }
    if (result.suggestClose) {
      console.log('⚠ LLM suggests closing this chapter/beat');
    }
  },
});

// 1. Generate a world from a template
console.log('Generating world...\n');
const world = await eln.generateWorld('republican');
console.log(`World: ${world.name} (${world.tag})`);
console.log(`Characters: ${world.characters.map(c => c.name).join(', ')}\n`);

// 2. Load the world into runtime
eln.loadWorld(world);

// 3. Run three turns
for (let i = 0; i < 3; i++) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Turn ${i + 1}`);
  console.log('─'.repeat(60) + '\n');

  // God-mode intervention on turn 2
  const intervention = i === 1
    ? '一封神秘信件突然出现在桌上'
    : '';

  await eln.runTurn({ intervention });
}

// 4. Save snapshot
eln.saveSnapshot();
console.log('\nSnapshot saved. Current turn:', eln.getState().worldState.turn);
