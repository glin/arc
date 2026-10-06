import { test } from 'vitest';
import assert from 'node:assert/strict';

import { OversizedRecordReducer } from './oversizedrecord';

function reduce(input: string | Buffer, chunkBytes: number, stringLimit?: number) {
  const bytes = typeof input === 'string' ? Buffer.from(input) : input;
  const reducer = new OversizedRecordReducer(stringLimit);
  for (let start = 0; start < bytes.length; start += chunkBytes)
    reducer.push(bytes.subarray(start, start + chunkBytes));
  const reduced = reducer.finish();
  assert.equal(reduced.bytes.length, reducer.bytes);
  return reduced;
}

const CHUNKS = [1, 2, 3, 7, 4096];

test('a record with no long strings passes through byte for byte', () => {
  const record = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-10-04T10:48:46.651Z',
    payload: {
      quoted: 'a "quote" and \\ back\\slash\n\ttab é 𝄞 \u0001',
      nested: [[], {}, [1, -2.5e3, true, false, null], { 'key with : colon': '[not] {an} array' }],
      replacement_history_note: 'data is not a URI',
      small_image: 'data:image/png;base64,iVBORw0KGgo=',
    },
  });
  for (const chunk of CHUNKS) {
    const reduced = reduce(record + ' ', chunk);
    assert.equal(reduced.complete, true);
    assert.equal(reduced.bytes.toString('utf8'), record + ' ');
  }
});

test('the reduced captured record keeps every field metadata recovery reads', () => {
  const image = 'data:image/png;base64,' + 'iVBOR'.repeat(200_000);
  const record = {
    timestamp: '2026-10-04T10:48:46.651Z',
    ordinal: 156,
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: 'call_Dq6hEXGdehFL6OPTXW1z2BV5',
      output: [
        { type: 'input_text', text: 'Script completed\nWall time 0.3 seconds\nOutput:\n' },
        { type: 'input_text', text: JSON.stringify({ agent_id: 'child', nickname: 'Child' }) },
        { type: 'input_image', image_url: image },
        { type: 'input_image', image_url: image },
      ],
      internal_chat_message_metadata_passthrough: { turn_id: 'turn' },
      metadata: { exit_code: 0 },
    },
  };
  const expected = structuredClone(record);
  expected.payload.output[2].image_url = 'data:image/png;base64,';
  expected.payload.output[3].image_url = 'data:image/png;base64,';
  for (const chunk of [1009, 256 * 1024]) {
    const reduced = reduce(JSON.stringify(record), chunk);
    assert.equal(reduced.complete, true);
    assert.ok(reduced.bytes.length < 1024, `the record reduced to ${reduced.bytes.length} bytes`);
    assert.deepEqual(JSON.parse(reduced.bytes.toString('utf8')), expected);
  }
});

test('a compaction record drops its replacement history and keeps its usage', () => {
  const history = [
    { type: 'message', content: [{ type: 'input_text', text: 'a ] } [ { "quoted" \\ ' + 'x'.repeat(100) }] },
    [[['deep']], { replacement_history: [1, 2] }],
  ];
  const record = {
    type: 'compacted',
    payload: {
      message: 'replacement_history',
      replacement_history: history,
      after: { replacement_history: 'a string value stays' },
      latest_token_usage_record: { usage: { input_tokens: 30000 } },
    },
  };
  for (const chunk of CHUNKS) {
    const reduced = reduce(
      JSON.stringify(record).replace('"replacement_history":[', '"replacement_history" : \n['),
      chunk,
    );
    assert.equal(reduced.complete, true);
    assert.deepEqual(JSON.parse(reduced.bytes.toString('utf8')), {
      ...record,
      payload: { ...record.payload, replacement_history: [] },
    });
  }
});

test('a long string keeps its start and its end at character boundaries outside every escape', () => {
  const value = 'ab\\"cé\\\\d𝄞\u0007e"f\\u00e9𝄞g'.repeat(3);
  const encoded = JSON.stringify(value);
  const sourceBytes = (text: string) => Buffer.byteLength(JSON.stringify(text)) - 2;
  for (let limit = 1; limit < Buffer.byteLength(encoded); limit++) {
    for (const chunk of CHUNKS) {
      const reduced = reduce(JSON.stringify([value]), chunk, limit);
      assert.equal(reduced.complete, true);
      const [kept] = JSON.parse(reduced.bytes.toString('utf8')) as [string];
      // The kept string is a start of the value followed by an end of it, each within its byte bound.
      const split = Array.from({ length: kept.length + 1 }, (_, index) => index).find(
        (index) =>
          value.startsWith(kept.slice(0, index)) &&
          value.endsWith(kept.slice(index)) &&
          sourceBytes(kept.slice(0, index)) <= limit + 6 &&
          sourceBytes(kept.slice(index)) <= limit,
      );
      assert.ok(split !== undefined, `limit ${limit} chunk ${chunk} kept ${JSON.stringify(kept)}`);
      assert.ok(kept.length <= value.length, `limit ${limit} chunk ${chunk} kept more than the value`);
      const end = kept.slice(split);
      const wanted = Math.min(
        limit - Math.max(1, Math.floor(limit / 16)) - 6,
        sourceBytes(value) - sourceBytes(kept.slice(0, split)),
      );
      assert.ok(sourceBytes(end) >= wanted, `limit ${limit} chunk ${chunk} kept an end of ${sourceBytes(end)} bytes`);
    }
  }
  // A string a little longer than the cut keeps every byte, and a long one keeps both of its ends.
  assert.equal(JSON.parse(reduce(JSON.stringify(['x'.repeat(100)]), 7, 60).bytes.toString('utf8'))[0], 'x'.repeat(100));
  const long = 'start ' + 'x'.repeat(10_000) + ' end';
  const [kept] = JSON.parse(reduce(JSON.stringify([long]), 4096, 64).bytes.toString('utf8')) as [string];
  assert.ok(kept.startsWith('start ') && kept.endsWith(' end') && kept.length <= 128, kept);
});

test('a record that ends inside a string, a container, or dropped history is incomplete', () => {
  for (const partial of [
    '{"type":"compacted","text":"unfinished',
    '{"type":"compacted","items":[1,2',
    '{"type":"compacted","replacement_history":[["a"]',
    '{"type":"compacted","text":"ends in an escape \\',
    '{"a":1}}',
  ]) {
    for (const chunk of CHUNKS) assert.equal(reduce(partial, chunk).complete, false, partial);
  }
});
