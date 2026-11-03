import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BriefProposalSchema } from '../../schema/brief-proposal';
import { toOutputJsonSchema } from '../runner';

describe('toOutputJsonSchema', () => {
  it('has no $schema: Claude Code rejects the draft 2020-12 one zod adds by default', () => {
    const schema = toOutputJsonSchema(BriefProposalSchema as z.ZodType);
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties as object)).toEqual(expect.arrayContaining(['title', 'tasks', 'epics']));
  });

  it('uses draft-07 keywords (definitions, not $defs)', () => {
    const Node: z.ZodType = z.lazy(() => z.object({ name: z.string(), children: z.array(Node) }));
    const json = JSON.stringify(toOutputJsonSchema(z.object({ root: Node })));
    expect(json).not.toContain('$defs');
    expect(json).not.toContain('2020-12');
  });
});
