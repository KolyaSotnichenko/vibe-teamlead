import { describe, expect, it } from 'vitest';

import { qaKickoffContext } from '../qa-kickoff';

const SPEC = `# Specification: Rate limiting for the public API

## Overview

Add a sliding-window rate limiter to every \`/api/public/*\` route.

## Task Scope

### This Task Will
- [ ] Add a limiter middleware
- [ ] Return 429 with a Retry-After header

## Requirements

### Functional Requirements

1. **Limiter middleware**
   - Description: One limiter per client key.
   - Acceptance:
     - **AC-1** Given a client under its limit, when it calls \`GET /api/public/items\`, then the response is 200 and carries \`X-RateLimit-Remaining\`. — Test: integration
     - **AC-2** Given a client at its limit, when it calls any public route, then the response is 429 with \`Retry-After\`. — Test: integration

2. **Configuration**
   - Acceptance:
     - **AC-3** Given \`RATE_LIMIT_PER_MINUTE=5\`, when the server starts, then the limiter uses 5. — Test: unit

### Edge Cases

1. **Clock skew** - use a monotonic clock

## Success Criteria

The task is complete when:

1. [ ] Every acceptance criterion (AC-1 … AC-3) has an automated test, and all of them pass
2. [ ] No console errors

## QA Acceptance Criteria

### Unit Tests
| AC | Test | File | What to Verify |
|----|------|------|----------------|
| AC-3 | reads the env | \`tests/config.test.ts\` | the limit comes from the env |
`;

const PLAN = JSON.stringify({
  phases: [
    {
      id: 'phase-1',
      subtasks: [
        { id: 'subtask-1-1', title: 'Limiter middleware', description: 'Create src/middleware/rate-limit.ts following the pattern in src/middleware/auth.ts.\nUse a sliding window keyed by client id.', status: 'completed' },
        { subtask_id: 'subtask-1-2', description: 'x'.repeat(300), status: 'completed' },
      ],
    },
    { id: 'phase-2', subtasks: [{ id: 'subtask-2-1', title: 'Config', status: 'pending' }] },
  ],
});

describe('qaKickoffContext', () => {
  it('lists the acceptance criteria once each, without the whole spec', () => {
    const out = qaKickoffContext({ spec: SPEC, plan: PLAN, specDir: '/p/.vibe-teamlead/specs/001' });
    expect(out).toContain('AC-1 Given a client under its limit');
    expect(out).toContain('AC-2 Given a client at its limit');
    expect(out).toContain('AC-3 Given `RATE_LIMIT_PER_MINUTE=5`');
    // The QA table row and the success-criteria line mention AC-3 again, but it is listed once
    expect(out.match(/AC-3/g)).toHaveLength(1);
    expect(out).not.toContain('Clock skew');
    expect(out).not.toContain('## Overview');
    expect(out.length).toBeLessThan(SPEC.length);
  });

  it('tabulates the subtasks with id, status and a truncated first line of the description', () => {
    const out = qaKickoffContext({ spec: SPEC, plan: PLAN });
    expect(out).toContain('| subtask-1-1 | completed | Create src/middleware/rate-limit.ts following the pattern in src/middleware/auth.ts. |');
    expect(out).not.toContain('sliding window keyed');
    expect(out).toContain('| subtask-1-2 | completed | ' + 'x'.repeat(119) + '… |');
    expect(out).toContain('| subtask-2-1 | pending | Config |');
    expect(out).toContain('3 subtasks, 2 completed');
  });

  it('tells the reviewer where the files are and to read spec sections on demand', () => {
    const out = qaKickoffContext({ spec: SPEC, plan: PLAN, specDir: '/p/.vibe-teamlead/specs/001' });
    expect(out).toContain('/p/.vibe-teamlead/specs/001/spec.md');
    expect(out).toContain('implementation_plan.json');
    expect(out).toMatch(/section/i);
  });

  it('falls back to the Acceptance or Success Criteria section when no AC lines exist', () => {
    const spec = '# Spec\n\n## Overview\n\nlong text\n\n## Success Criteria\n\n1. [ ] Users can log in\n2. [ ] Sessions expire\n\n## Implementation Notes\n\nnotes\n';
    const out = qaKickoffContext({ spec, plan: null });
    expect(out).toContain('Users can log in');
    expect(out).toContain('Sessions expire');
    expect(out).not.toContain('long text');
    expect(out).not.toContain('notes');
  });

  it('falls back to the start of the spec with a note when it has no criteria at all', () => {
    const spec = `# Spec\n\n${'a paragraph of text. '.repeat(400)}`;
    const out = qaKickoffContext({ spec, plan: null });
    expect(out).toContain('no acceptance criteria');
    expect(out).toContain('a paragraph of text.');
    expect(out.length).toBeLessThan(5000);
  });

  it('copes with a missing spec or an unreadable plan', () => {
    expect(qaKickoffContext({ spec: null, plan: null })).toContain('spec.md');
    const out = qaKickoffContext({ spec: SPEC, plan: '{not json' });
    expect(out).toContain('AC-1');
    expect(out).toContain('could not be parsed');
  });
});
