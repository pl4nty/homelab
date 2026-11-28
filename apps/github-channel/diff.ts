export type Pull = {
  id: string;
  url: string;
  title: string;
  repo: string;
  number: number;
  state: string;
  isDraft: boolean;
  labels: string[];
  reviewDecision: string | null;
  review: { id: string; state: string; author: string } | null;
  comments: number;
  unresolvedThreads: number;
  checks: string | null;
};

export type Change = { pull: Pull; events: string[] };

export function diff(before: Map<string, Pull>, after: Map<string, Pull>): Change[] {
  const changes: Change[] = [];
  for (const [id, pull] of after) {
    const old = before.get(id);
    const events: string[] = [];
    if (!old) {
      events.push('opened');
    } else {
      for (const label of pull.labels) if (!old.labels.includes(label)) events.push(`label added: ${label}`);
      for (const label of old.labels) if (!pull.labels.includes(label)) events.push(`label removed: ${label}`);
      if (pull.state !== old.state) events.push(`state: ${old.state} -> ${pull.state}`);
      if (pull.isDraft !== old.isDraft) events.push(pull.isDraft ? 'converted to draft' : 'ready for review');
      if (pull.review && pull.review.id !== old.review?.id)
        events.push(`review: ${pull.review.state} by ${pull.review.author}`);
      if (pull.reviewDecision !== old.reviewDecision)
        events.push(`review decision: ${old.reviewDecision ?? 'none'} -> ${pull.reviewDecision ?? 'none'}`);
      if (pull.comments > old.comments) events.push(`${pull.comments - old.comments} new comment(s)`);
      if (pull.unresolvedThreads > old.unresolvedThreads)
        events.push(`unresolved review threads: ${old.unresolvedThreads} -> ${pull.unresolvedThreads}`);
      if (pull.checks !== old.checks) events.push(`checks: ${old.checks ?? 'none'} -> ${pull.checks ?? 'none'}`);
    }
    if (events.length) changes.push({ pull, events });
  }
  return changes;
}
