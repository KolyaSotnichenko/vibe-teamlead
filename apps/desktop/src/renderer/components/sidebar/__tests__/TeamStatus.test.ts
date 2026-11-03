import { describe, expect, it } from 'vitest';

import { countTeam } from '../TeamStatus';

describe('countTeam', () => {
  it('counts working, queued and review tasks', () => {
    expect(countTeam(['in_progress', 'ai_review', 'queue', 'human_review', 'done', 'backlog'])).toEqual({
      working: 2,
      queued: 1,
      review: 1,
    });
  });
});
