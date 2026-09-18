/**
 * P0 acceptance — contracts layer.
 *
 * The load-bearing claim: a malformed extraction is *contained*. A bad block is
 * dropped and reported; the good blocks still validate. Nothing about bad model
 * output should ever throw out of the validator.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateExtraction, validateCanon, formatZodError, parseJSONLoose,
} from '../src/contracts/validate.js';
import { PREDICATE_KEYS, isPredicate } from '../src/contracts/vocab.js';
import { FIXTURE_WORLD, sampleExtraction } from './helpers.js';
import { canonFromGeneratedWorld } from '../src/state/canon.js';

test('a fully valid extraction validates every block with no degradation', () => {
  const { blocks, degraded, errors } = validateExtraction(sampleExtraction());

  assert.deepEqual(degraded, []);
  assert.deepEqual(errors, {});
  assert.equal(blocks.summary, '李明远试探谢云舒，未果。');
  assert.equal(blocks.characters.length, 2);
  assert.equal(blocks.facts.length, 1);
  assert.equal(blocks.events.length, 1);
  assert.equal(blocks.seeds.length, 1);
  assert.equal(blocks.knowledge.length, 1);
  assert.equal(blocks.editor.note, '节奏偏慢');
});

test('a non-object payload degrades at the root instead of throwing', () => {
  for (const bad of [null, 42, 'nope', []]) {
    const out = validateExtraction(bad);
    assert.deepEqual(out.degraded, ['root']);
    assert.equal(out.blocks.summary, undefined);
  }
});

test('a block that is not an array is dropped and reported by name', () => {
  const { blocks, degraded, errors } = validateExtraction(
    sampleExtraction({ characters: '李明远、谢云舒' })
  );

  assert.ok(!('characters' in blocks), 'characters block must be dropped');
  assert.ok(degraded.includes('characters'));
  assert.match(errors.characters, /not an array/);
  // The rest of the payload survives.
  assert.equal(blocks.facts.length, 1);
  assert.equal(blocks.events.length, 1);
});

test('one bad array item is dropped without losing its siblings', () => {
  const payload = sampleExtraction({
    characters: [
      { name: '李明远', emotion: '警觉' },
      { emotion: '缺少 name 字段' },          // invalid: name is required
      { name: '赵鹏', emotion: '贪婪' },
    ],
  });

  const { blocks, degraded } = validateExtraction(payload);

  assert.equal(blocks.characters.length, 2, 'two valid characters kept');
  assert.deepEqual(blocks.characters.map(c => c.name), ['李明远', '赵鹏']);
  assert.ok(degraded.includes('characters[1]'), 'the bad index is reported');
});

test('an unknown predicate falls back to `other` rather than failing the block', () => {
  const payload = sampleExtraction({
    facts: [{ subject: '李明远', predicate: 'invented_relation', object: '某物' }],
  });

  const { blocks, degraded } = validateExtraction(payload);

  assert.deepEqual(degraded, []);
  assert.equal(blocks.facts[0].predicate, 'other');
  assert.ok(isPredicate(blocks.facts[0].predicate));
});

test('knowledge referencing a fact index out of range is dropped', () => {
  const payload = sampleExtraction({
    knowledge: [{ holderId: '李明远', factIndex: 7, stance: 'knows' }],
  });

  const { blocks, degraded, errors } = validateExtraction(payload);

  assert.deepEqual(blocks.knowledge, []);
  assert.ok(degraded.includes('knowledge[0]'));
  assert.match(errors['knowledge[0]'], /out of range/);
});

test('knowledge is dropped wholesale when the facts block failed', () => {
  const payload = sampleExtraction({ facts: 'not-an-array' });

  const { blocks, degraded, errors } = validateExtraction(payload);

  assert.ok(!('facts' in blocks));
  assert.ok(!('knowledge' in blocks), 'knowledge cannot be resolved without facts, so it is absent');
  assert.ok(degraded.includes('knowledge'));
  assert.match(errors.knowledge, /unresolvable/);
});

test('a missing summary degrades but still yields a usable delta', () => {
  const payload = sampleExtraction();
  delete payload.summary;

  const { blocks, degraded, errors } = validateExtraction(payload);

  assert.equal(blocks.summary, '');
  assert.ok(degraded.includes('summary'));
  assert.match(errors.summary, /missing/);
  assert.equal(blocks.characters.length, 2, 'other blocks unaffected');
});

test('validateCanon rejects malformed engine state loudly', () => {
  const good = canonFromGeneratedWorld(FIXTURE_WORLD, 1);
  assert.doesNotThrow(() => validateCanon(good));

  assert.throws(
    () => validateCanon({ ...good, tension: 999 }),
    /Invalid Canon/
  );
  assert.throws(
    () => validateCanon({ ...good, entities: [{ name: '缺少 id' }] }),
    /Invalid Canon/
  );
});

test('parseJSONLoose tolerates model preamble and code fences', () => {
  const fenced = 'Sure! Here you go:\n```json\n{"summary":"ok"}\n```\n希望有帮助';
  assert.deepEqual(parseJSONLoose(fenced), { summary: 'ok' });
  assert.throws(() => parseJSONLoose('no json here'), /No JSON found/);
});

test('formatZodError produces a readable path: message list', () => {
  const out = validateExtraction({ summary: 'x', world: { tension: 500 } });
  assert.ok(out.degraded.includes('world'));
  assert.match(formatZodError({ issues: [] }), /^$/);
});

test('the controlled predicate vocabulary is closed and non-trivial', () => {
  assert.ok(PREDICATE_KEYS.length >= 20);
  assert.ok(PREDICATE_KEYS.includes('secret'));
  assert.ok(PREDICATE_KEYS.includes('other'), '`other` must exist as the escape hatch');
  assert.ok(!isPredicate('definitely_not_a_predicate'));
});
