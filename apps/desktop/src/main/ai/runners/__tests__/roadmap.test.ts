import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { StreamEvent } from '../../session/types';

// =============================================================================
// Mocks — must be declared before any imports that use them
// =============================================================================

const mockRunClaudeTask = vi.fn();

vi.mock('../../claude-code/task', () => ({
  runClaudeTask: (...args: unknown[]) => mockRunClaudeTask(...args),
  READ_TOOLS: ['Read', 'Glob', 'Grep'],
  RESEARCH_TOOLS: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
}));

// Filesystem mocks
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockRenameSync = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  renameSync: (...args: unknown[]) => mockRenameSync(...args),
}));

// json-repair used for safeParseJson
vi.mock('../../../utils/json-repair', () => ({
  safeParseJson: (text: string) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  },
}));

// tryLoadPrompt — return null so inline prompts are used
vi.mock('../../prompts/prompt-loader', () => ({
  tryLoadPrompt: vi.fn().mockReturnValue(null),
}));

// =============================================================================
// Import after mocking
// =============================================================================

import { runRoadmapGeneration } from '../roadmap';
import type { RoadmapConfig, RoadmapStreamEvent } from '../roadmap';

// =============================================================================
// Helpers
// =============================================================================

type TaskOpts = { onEvent?: (e: StreamEvent) => void };

/** A runClaudeTask implementation that emits the given StreamEvents, then resolves */
function emitting(events: StreamEvent[] = []) {
  return async (opts: TaskOpts) => {
    for (const e of events) opts.onEvent?.(e);
    return { text: '', session: { outcome: 'completed' } };
  };
}

/** Valid discovery JSON that passes schema validation */
const VALID_DISCOVERY_JSON = JSON.stringify({
  project_name: 'TestProject',
  target_audience: 'Developers',
  product_vision: 'Make coding easier',
  key_features: ['Auth', 'Dashboard'],
  technical_stack: { language: 'TypeScript' },
  constraints: [],
});

/** Valid roadmap JSON that passes schema validation (>=3 features, all required keys) */
const VALID_ROADMAP_JSON = JSON.stringify({
  vision: 'Automate everything',
  target_audience: { primary: 'Developers', secondary: 'QA' },
  phases: [{ id: 'p1', name: 'MVP' }],
  features: [
    {
      id: 'f1', title: 'Feature A', description: 'Desc A', priority: 'high',
      complexity: 'medium', impact: 'high', phase_id: 'p1', status: 'planned',
      acceptance_criteria: [], user_stories: [],
    },
    {
      id: 'f2', title: 'Feature B', description: 'Desc B', priority: 'medium',
      complexity: 'low', impact: 'medium', phase_id: 'p1', status: 'planned',
      acceptance_criteria: [], user_stories: [],
    },
    {
      id: 'f3', title: 'Feature C', description: 'Desc C', priority: 'low',
      complexity: 'high', impact: 'low', phase_id: 'p1', status: 'planned',
      acceptance_criteria: [], user_stories: [],
    },
  ],
});

function baseConfig(overrides: Partial<RoadmapConfig> = {}): RoadmapConfig {
  return {
    projectDir: '/project',
    outputDir: '/project/.auto-claude/roadmap',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('runRoadmapGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Output dir exists by default (created by mkdirSync is a no-op)
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockReturnValue(undefined);
    mockRunClaudeTask.mockImplementation(emitting());
  });

  // ---------------------------------------------------------------------------
  // Successful full pipeline
  // ---------------------------------------------------------------------------

  it('returns success with roadmapPath when both phases succeed', async () => {
    // existsSync: outputDir does not exist initially; discovery file created after phase 1
    let discoveryCreated = false;

    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('roadmap')) return true; // outputDir exists
      if (p.endsWith('roadmap_discovery.json') && discoveryCreated) return true;
      if (p.endsWith('roadmap.json') && discoveryCreated) return false; // not yet
      return false;
    });

    // Session emits nothing — validation happens from file reads
    mockRunClaudeTask.mockImplementation(async () => {
      discoveryCreated = true; // simulate file being written during the session
      return { text: '', session: { outcome: 'completed' } };
    });

    // readFileSync returns valid JSON for each file
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.endsWith('roadmap_discovery.json')) return VALID_DISCOVERY_JSON;
      if (p.endsWith('roadmap.json')) return VALID_ROADMAP_JSON;
      return '{}';
    });

    // After agent runs, both files exist
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('roadmap_discovery.json')) return true;
      if (p.endsWith('roadmap.json')) return true;
      return true; // outputDir, etc.
    });

    const result = await runRoadmapGeneration(baseConfig());

    expect(result.success).toBe(true);
    expect(result.roadmapPath).toContain('roadmap.json');
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0].phase).toBe('discovery');
    expect(result.phases[1].phase).toBe('features');
  });

  // ---------------------------------------------------------------------------
  // Discovery phase failure
  // ---------------------------------------------------------------------------

  it('returns failure when discovery phase fails after all retries', async () => {
    // Discovery file is never created
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('roadmap')) return true; // outputDir exists
      return false; // discovery file never appears
    });

    mockRunClaudeTask.mockImplementation(emitting());

    const result = await runRoadmapGeneration(baseConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Discovery failed');
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].phase).toBe('discovery');
    expect(result.phases[0].success).toBe(false);
  });

  it('does not run features phase when discovery fails', async () => {
    mockExistsSync.mockReturnValue(false);
    mockRunClaudeTask.mockImplementation(emitting());

    const result = await runRoadmapGeneration(baseConfig());

    // Only 1 phase in result — features was never attempted
    expect(result.phases).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Features phase failure
  // ---------------------------------------------------------------------------

  it('returns failure when features phase fails (no roadmap.json created)', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('roadmap')) return true;
      if (p.endsWith('roadmap_discovery.json')) return true; // discovery succeeded
      if (p.endsWith('project_index.json')) return false;
      return false; // roadmap.json never created
    });

    mockReadFileSync.mockImplementation((p: string) => {
      if (p.endsWith('roadmap_discovery.json')) return VALID_DISCOVERY_JSON;
      return '{}';
    });

    mockRunClaudeTask.mockImplementation(emitting());

    const result = await runRoadmapGeneration(baseConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Feature generation failed');
    expect(result.phases).toHaveLength(2);
    expect(result.phases[1].phase).toBe('features');
    expect(result.phases[1].success).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Cache (refresh=false) — skip phases when files already exist
  // ---------------------------------------------------------------------------

  it('skips discovery phase when discovery file already exists and refresh=false', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('roadmap')) return true;
      if (p.endsWith('roadmap_discovery.json')) return true; // already exists
      if (p.endsWith('roadmap.json')) return true; // also exists
      return false;
    });

    const result = await runRoadmapGeneration(baseConfig({ refresh: false }));

    // No session should run since both files exist
    expect(mockRunClaudeTask).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Output directory creation
  // ---------------------------------------------------------------------------

  it('creates output directory when it does not exist', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('roadmap') && !p.includes('.json')) return false; // dir does not exist
      return false;
    });
    mockRunClaudeTask.mockImplementation(emitting());

    await runRoadmapGeneration(baseConfig({ outputDir: '/project/.auto-claude/roadmap' }));

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('roadmap'),
      expect.objectContaining({ recursive: true }),
    );
  });

  // ---------------------------------------------------------------------------
  // Streaming events
  // ---------------------------------------------------------------------------

  it('emits phase-start and phase-complete events for both phases', async () => {
    // Make discovery succeed via cached file
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('roadmap')) return true;
      if (p.endsWith('roadmap_discovery.json')) return true;
      if (p.endsWith('roadmap.json')) return true;
      return false;
    });

    const events: RoadmapStreamEvent[] = [];
    await runRoadmapGeneration(baseConfig({ refresh: false }), (e) => events.push(e));

    const phaseStartEvents = events.filter((e) => e.type === 'phase-start');
    const phaseCompleteEvents = events.filter((e) => e.type === 'phase-complete');

    expect(phaseStartEvents).toHaveLength(2);
    expect(phaseCompleteEvents).toHaveLength(2);
    expect((phaseStartEvents[0] as { type: string; phase: string }).phase).toBe('discovery');
    expect((phaseStartEvents[1] as { type: string; phase: string }).phase).toBe('features');
  });

  it('forwards text-delta events from stream to callback', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('roadmap_discovery.json')) return true;
      if (p.endsWith('roadmap.json')) return true;
      return true;
    });

    const events: RoadmapStreamEvent[] = [];
    await runRoadmapGeneration(baseConfig({ refresh: false }), (e) => events.push(e));

    // Since files exist and refresh=false, no session runs and no text-delta fires
    // This confirms the caching path works correctly
    const textEvents = events.filter((e) => e.type === 'text-delta');
    expect(textEvents).toHaveLength(0);
  });

  it('forwards text-delta and tool-use events from the session when discovery must be generated', async () => {
    // outputDir exists, but discovery file does not (first attempt)
    // After the first session, discovery file appears
    let callCount = 0;
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('roadmap') && !p.includes('.json')) return true;
      if (p.endsWith('roadmap_discovery.json')) return callCount > 0;
      return false;
    });

    mockReadFileSync.mockReturnValue(VALID_DISCOVERY_JSON);

    mockRunClaudeTask.mockImplementation(async (opts: TaskOpts) => {
      callCount++;
      opts.onEvent?.({ type: 'text-delta', text: 'Analyzing project...' });
      opts.onEvent?.({ type: 'tool-call', toolName: 'Read', toolCallId: 'c1', args: { file_path: 'README.md' } });
      opts.onEvent?.({ type: 'thinking-delta', text: 'ignored' });
      return { text: '', session: { outcome: 'completed' } };
    });

    const events: RoadmapStreamEvent[] = [];
    await runRoadmapGeneration(baseConfig(), (e) => events.push(e));

    expect(events).toContainEqual({ type: 'text-delta', text: 'Analyzing project...' });
    expect(events).toContainEqual({ type: 'tool-use', name: 'Read' });
    expect(events.some((e) => (e as { text?: string }).text === 'ignored')).toBe(false);
  });

  it('forwards session error events as plain messages', async () => {
    mockExistsSync.mockReturnValue(false);
    mockRunClaudeTask.mockImplementation(
      emitting([{ type: 'error', error: { code: 'error', message: 'tool failed', retryable: false } }]),
    );

    const events: RoadmapStreamEvent[] = [];
    await runRoadmapGeneration(baseConfig(), (e) => events.push(e));

    expect(events).toContainEqual({ type: 'error', error: 'tool failed' });
  });

  // ---------------------------------------------------------------------------
  // Task configuration
  // ---------------------------------------------------------------------------

  it('uses sonnet and medium thinking level by default', async () => {
    mockExistsSync.mockReturnValue(false);
    mockRunClaudeTask.mockImplementation(emitting());

    await runRoadmapGeneration(baseConfig());

    const args = mockRunClaudeTask.mock.calls[0][0];
    expect(args.model).toBe('sonnet');
    expect(args.thinkingLevel).toBe('medium');
  });

  it('accepts custom modelShorthand and thinkingLevel', async () => {
    mockExistsSync.mockReturnValue(false);
    mockRunClaudeTask.mockImplementation(emitting());

    await runRoadmapGeneration(baseConfig({ modelShorthand: 'haiku', thinkingLevel: 'low' }));

    const args = mockRunClaudeTask.mock.calls[0][0];
    expect(args.model).toBe('haiku');
    expect(args.thinkingLevel).toBe('low');
  });

  it('runs phases with research tools and writes confined to the roadmap output dir', async () => {
    mockExistsSync.mockReturnValue(false);
    mockRunClaudeTask.mockImplementation(emitting());
    const controller = new AbortController();

    await runRoadmapGeneration(baseConfig({ abortSignal: controller.signal }));

    const args = mockRunClaudeTask.mock.calls[0][0];
    expect(args.agentType).toBe('roadmap_discovery');
    expect(args.cwd).toBe('/project');
    expect(args.tools).toEqual(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Write', 'Edit']);
    expect(args.tools).not.toContain('Bash');
    expect(args.allowedWritePaths).toEqual(['/project/.auto-claude/roadmap']);
    expect(args.maxTurns).toBe(30);
    expect(args.abortSignal).toBe(controller.signal);
    expect(args.systemPrompt).toContain('/project/.auto-claude/roadmap/roadmap_discovery.json');
  });

  it('retries discovery up to 3 times when the file is not created', async () => {
    mockExistsSync.mockReturnValue(false);
    mockRunClaudeTask.mockImplementation(emitting());

    const result = await runRoadmapGeneration(baseConfig());

    expect(mockRunClaudeTask).toHaveBeenCalledTimes(3);
    expect(result.phases[0].errors).toHaveLength(3);
  });

  it('uses default outputDir when not provided', async () => {
    mockExistsSync.mockReturnValue(false);
    mockRunClaudeTask.mockImplementation(emitting());

    await runRoadmapGeneration({ projectDir: '/my/project' });

    // mkdirSync should have been called with the default path
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.auto-claude'),
      expect.anything(),
    );
  });

  // ---------------------------------------------------------------------------
  // Error handling — runClaudeTask rejects
  // ---------------------------------------------------------------------------

  it('records error in phase when runClaudeTask rejects during discovery', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('roadmap') && !p.includes('.json')) return true;
      return false;
    });

    mockRunClaudeTask.mockRejectedValue(new Error('network failure'));

    const events: RoadmapStreamEvent[] = [];
    const result = await runRoadmapGeneration(baseConfig(), (e) => events.push(e));

    expect(result.success).toBe(false);
    expect(result.phases[0].errors[0]).toContain('network failure');
    expect(events).toContainEqual({ type: 'error', error: 'network failure' });
  });
});
