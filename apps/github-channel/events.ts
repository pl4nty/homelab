export type TimelineItem = {
  __typename: string;
  id: string;
  createdAt: string;
  actor?: { login: string } | null;
  author?: { login: string } | null;
  label?: { name: string };
  state?: string;
};

export const itemTypes = [
  'LABELED_EVENT',
  'UNLABELED_EVENT',
  'PULL_REQUEST_REVIEW',
  'ISSUE_COMMENT',
  'MERGED_EVENT',
  'CLOSED_EVENT',
  'REOPENED_EVENT',
  'READY_FOR_REVIEW_EVENT',
  'CONVERT_TO_DRAFT_EVENT',
];

export function describe(item: TimelineItem): string | null {
  const who = item.actor?.login ?? item.author?.login ?? 'ghost';
  switch (item.__typename) {
    case 'LabeledEvent':
      return `label added: ${item.label?.name} by ${who}`;
    case 'UnlabeledEvent':
      return `label removed: ${item.label?.name} by ${who}`;
    case 'PullRequestReview':
      return item.state === 'PENDING' ? null : `review: ${item.state} by ${who}`;
    case 'IssueComment':
      return `comment by ${who}`;
    case 'MergedEvent':
      return `merged by ${who}`;
    case 'ClosedEvent':
      return `closed by ${who}`;
    case 'ReopenedEvent':
      return `reopened by ${who}`;
    case 'ReadyForReviewEvent':
      return `ready for review by ${who}`;
    case 'ConvertToDraftEvent':
      return `converted to draft by ${who}`;
    default:
      return null;
  }
}
