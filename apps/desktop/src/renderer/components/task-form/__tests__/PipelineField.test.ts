import { describe, expect, it } from 'vitest';

import { pipelineChoiceOf, shownPipelineOption } from '../PipelineField';

describe("the pipeline field: a task's choice and the project's default", () => {
  describe('in a project with no default pipeline', () => {
    it('nothing chosen is shown as Auto, and choosing Auto stores nothing', () => {
      expect(shownPipelineOption(undefined, undefined)).toBe('auto');
      expect(shownPipelineOption('auto', undefined)).toBe('auto');
      expect(pipelineChoiceOf('auto', undefined)).toBeUndefined();
    });

    it('a pipeline is shown and stored as itself', () => {
      for (const kind of ['single', 'short', 'full'] as const) {
        expect(shownPipelineOption(kind, undefined)).toBe(kind);
        expect(pipelineChoiceOf(kind, undefined)).toBe(kind);
      }
    });
  });

  describe('in a project whose default is a pipeline', () => {
    it('nothing chosen is shown as "as in the project", and choosing that stores nothing', () => {
      expect(shownPipelineOption(undefined, 'single')).toBe('project');
      expect(pipelineChoiceOf('project', 'single')).toBeUndefined();
    });

    it('Auto is a choice of its own there: the app decides for this task whatever the project says', () => {
      expect(pipelineChoiceOf('auto', 'single')).toBe('auto');
      expect(shownPipelineOption('auto', 'single')).toBe('auto');
    });

    it("the task's own pipeline still shows as itself", () => {
      expect(shownPipelineOption('full', 'single')).toBe('full');
      expect(pipelineChoiceOf('full', 'single')).toBe('full');
    });
  });
});
