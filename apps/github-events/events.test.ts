import { expect, test } from 'bun:test';
import { describe } from './events';

test('describes timeline items', () => {
  const base = { id: 'x', createdAt: '2026-11-28T00:00:00Z' };
  expect(
    [
      { ...base, __typename: 'LabeledEvent', actor: { login: 'wingetbot' }, label: { name: 'Changes-Requested' } },
      { ...base, __typename: 'UnlabeledEvent', actor: null, label: { name: 'Needs-Author-Feedback' } },
      { ...base, __typename: 'PullRequestReview', author: { login: 'someone' }, state: 'COMMENTED' },
      { ...base, __typename: 'PullRequestReview', author: { login: 'pl4nty' }, state: 'PENDING' },
      { ...base, __typename: 'IssueComment', author: { login: 'wingetbot' } },
      { ...base, __typename: 'MergedEvent', actor: { login: 'stephengillie' } },
      { ...base, __typename: 'HeadRefForcePushedEvent' },
    ].map(describe),
  ).toEqual([
    'label added: Changes-Requested by wingetbot',
    'label removed: Needs-Author-Feedback by ghost',
    'review: COMMENTED by someone',
    null,
    'comment by wingetbot',
    'merged by stephengillie',
    null,
  ]);
});
