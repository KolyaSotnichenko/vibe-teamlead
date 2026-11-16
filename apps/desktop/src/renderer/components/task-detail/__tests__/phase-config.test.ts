import { describe, expect, it } from 'vitest';

import type { TaskMetadata } from '../../../../shared/types';
import { getPhaseConfig } from '../TaskLogs';

describe('getPhaseConfig', () => {
  const auto = {
    isAutoProfile: true,
    phaseModels: { spec: 'opus', planning: 'opus', coding: 'haiku', qa: 'sonnet' },
    phaseThinking: { spec: 'low', planning: 'low', coding: 'low', qa: 'low' },
  } as unknown as TaskMetadata;

  it("shows the designer's model and effort on the Design phase, from the run", () => {
    const config = getPhaseConfig({ ...auto, designModel: 'claude-opus-5-5', designThinking: 'high' } as TaskMetadata, 'design');
    expect(config?.model).toContain('opus');
    expect(config?.thinking).toBe('tasks:logs.thinkingShort.high');
  });

  it('shows nothing on Design for a task run before the app recorded it', () => {
    expect(getPhaseConfig(auto, 'design')).toBeNull();
  });
});
