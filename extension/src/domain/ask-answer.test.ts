import { test } from 'vitest';
import assert from 'node:assert';
import { completedQuestionAnswer, questionAnswered } from './ask-answer.ts';

test('a question answer requires one answer for every request field', () => {
  const ids = ['colour', 'size'];
  assert.equal(questionAnswered('size', { colour: ['Red'] }, {}), false);
  assert.equal(completedQuestionAnswer(ids, { colour: ['Red'] }), null);
  assert.deepEqual(
    completedQuestionAnswer(ids, {
      colour: ['Red'],
      size: ['Large', 'Small'],
    }),
    {
      decision: 'answer',
      answers: {
        colour: { labels: ['Red'], written: '' },
        size: { labels: ['Large', 'Small'], written: '' },
      },
    },
  );
});

test('a written answer replaces offered labels and whitespace stays incomplete', () => {
  assert.equal(completedQuestionAnswer(['size'], {}, { size: '   ' }), null);
  assert.equal(completedQuestionAnswer(['size'], { size: ['Large'] }, { size: 'Own size' }), null);
  assert.deepEqual(completedQuestionAnswer(['size'], {}, { size: 'Own size' }), {
    decision: 'answer',
    answers: { size: { labels: [], written: 'Own size' } },
  });
});
