import { expect, test } from 'bun:test';
import { diff, type Pull } from './diff';

const pull: Pull = {
  id: 'PR_1',
  url: 'https://github.com/microsoft/winget-pkgs/pull/1',
  title: 'New version: A.B 1.0',
  repo: 'microsoft/winget-pkgs',
  number: 1,
  state: 'OPEN',
  isDraft: false,
  labels: ['Azure-Pipeline-Passed'],
  reviewDecision: null,
  review: null,
  comments: 1,
  unresolvedThreads: 0,
  checks: 'PENDING',
};

test('reports what changed', () => {
  const after: Pull = {
    ...pull,
    labels: ['Changes-Requested'],
    review: { id: 'R_1', state: 'COMMENTED', author: 'someone' },
    comments: 3,
    unresolvedThreads: 1,
    checks: 'FAILURE',
  };
  expect(diff(new Map([[pull.id, pull]]), new Map([[pull.id, after]]))[0].events).toEqual([
    'label added: Changes-Requested',
    'label removed: Azure-Pipeline-Passed',
    'review: COMMENTED by someone',
    '2 new comment(s)',
    'unresolved review threads: 0 -> 1',
    'checks: PENDING -> FAILURE',
  ]);
});

test('reports new and merged pulls, skips unchanged', () => {
  const other = { ...pull, id: 'PR_2', number: 2 };
  const changes = diff(
    new Map([
      [pull.id, pull],
      [other.id, other],
    ]),
    new Map([
      [pull.id, { ...pull, state: 'MERGED' }],
      [other.id, other],
      ['PR_3', { ...pull, id: 'PR_3' }],
    ]),
  );
  expect(changes.map((c) => [c.pull.id, c.events])).toEqual([
    ['PR_1', ['state: OPEN -> MERGED']],
    ['PR_3', ['opened']],
  ]);
});
