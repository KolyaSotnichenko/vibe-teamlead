import { EventEmitter } from 'events';
import type {
  ChangelogGenerationRequest,
  ChangelogGenerationResult,
  ChangelogGenerationProgress,
  TaskSpecContent
} from '../../shared/types';
import { runClaudeTask } from '../ai/claude-code/task';
import type { ThinkingLevel } from '../ai/config/types';
import { getFeatureSettings } from '../ipc-handlers/feature-settings-helper';
import { detectRateLimit, createSDKRateLimitInfo } from '../rate-limit-detector';
import { buildChangelogPrompt, buildGitPrompt } from './formatter';
import { getBranchDiffCommits, getCommits } from './git-integration';
import { extractChangelog } from './parser';

const TIMEOUT_MS = 5 * 60 * 1000;

const CHANGELOG_SYSTEM_PROMPT =
  'You write release changelogs. Follow the requested format and audience exactly and reply with the changelog only, in Markdown, without any preamble or closing remarks.';

/**
 * Changelog generation with Claude Code (the app's Claude credential and the
 * "Utility" feature model). Supports tasks (specs), git history and branch diff.
 */
export class ChangelogGenerator extends EventEmitter {
  private generations = new Map<string, AbortController>();

  constructor(private debugEnabled = false) {
    super();
  }

  private debug(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.warn('[ChangelogGenerator]', ...args);
    }
  }

  /**
   * Generate changelog using Claude AI
   * Supports multiple source modes: tasks (specs), git-history, or branch-diff
   */
  async generate(
    projectId: string,
    projectPath: string,
    request: ChangelogGenerationRequest,
    specs?: TaskSpecContent[]
  ): Promise<void> {
    const sourceMode = request.sourceMode || 'tasks';

    this.debug('generate called', {
      projectId,
      projectPath,
      sourceMode,
      taskCount: request.taskIds?.length || 0,
      version: request.version,
      format: request.format,
      audience: request.audience
    });

    // Kill existing process if any
    this.cancel(projectId);

    let prompt: string;
    let itemCount: number;

    // Handle different source modes
    if (sourceMode === 'git-history' && request.gitHistory) {
      // Git history mode
      this.emitProgress(projectId, {
        stage: 'loading_commits',
        progress: 10,
        message: 'Loading commits from git history...'
      });

      const commits = getCommits(projectPath, request.gitHistory, this.debugEnabled);
      if (commits.length === 0) {
        this.emitError(projectId, 'No commits found for the specified range');
        return;
      }

      prompt = buildGitPrompt(request, commits);
      itemCount = commits.length;

    } else if (sourceMode === 'branch-diff' && request.branchDiff) {
      // Branch diff mode
      this.emitProgress(projectId, {
        stage: 'loading_commits',
        progress: 10,
        message: `Loading commits between ${request.branchDiff.baseBranch} and ${request.branchDiff.compareBranch}...`
      });

      const commits = getBranchDiffCommits(projectPath, request.branchDiff, this.debugEnabled);
      if (commits.length === 0) {
        this.emitError(projectId, 'No commits found between the specified branches');
        return;
      }

      prompt = buildGitPrompt(request, commits);
      itemCount = commits.length;

    } else {
      // Tasks mode (original behavior)
      if (!specs || specs.length === 0) {
        this.emitError(projectId, 'No specs provided for changelog generation');
        return;
      }

      this.emitProgress(projectId, {
        stage: 'loading_specs',
        progress: 10,
        message: 'Preparing changelog generation...'
      });

      prompt = buildChangelogPrompt(request, specs);
      itemCount = specs.length;
    }

    this.debug('Prompt built', {
      promptLength: prompt.length,
      promptPreview: prompt.substring(0, 500) + '...'
    });

    this.emitProgress(projectId, {
      stage: 'generating',
      progress: 30,
      message: 'Generating changelog with Claude...'
    });

    const abort = new AbortController();
    this.generations.set(projectId, abort);
    const timeout = setTimeout(() => abort.abort(), TIMEOUT_MS);
    const { model, thinkingLevel } = getFeatureSettings('utility');

    try {
      const result = await runClaudeTask({
        systemPrompt: CHANGELOG_SYSTEM_PROMPT,
        prompt,
        model,
        thinkingLevel: thinkingLevel as ThinkingLevel,
        maxTurns: 1,
        abortSignal: abort.signal,
      });
      if (this.generations.get(projectId) !== abort) return; // cancelled or superseded

      this.emitProgress(projectId, { stage: 'formatting', progress: 90, message: 'Formatting changelog...' });
      const changelog = extractChangelog(result.text.trim());
      if (!changelog) {
        this.emitError(projectId, 'Claude returned an empty changelog');
        return;
      }
      this.emitProgress(projectId, { stage: 'complete', progress: 100, message: 'Changelog generation complete' });
      const generated: ChangelogGenerationResult = {
        success: true,
        changelog,
        version: request.version,
        tasksIncluded: itemCount
      };
      this.emit('generation-complete', projectId, generated);
    } catch (error) {
      if (this.generations.get(projectId) !== abort) return;
      const message = abort.signal.aborted
        ? 'Changelog generation timed out after 5 minutes'
        : error instanceof Error ? error.message : String(error);
      const rateLimit = detectRateLimit(message);
      if (rateLimit.isRateLimited) {
        this.emit('rate-limit', projectId, createSDKRateLimitInfo('changelog', rateLimit, { projectId }));
      }
      this.debug('Generation failed', { error: message.substring(0, 500) });
      this.emitError(projectId, message);
    } finally {
      clearTimeout(timeout);
      if (this.generations.get(projectId) === abort) this.generations.delete(projectId);
    }
  }

  /**
   * Cancel ongoing generation
   */
  cancel(projectId: string): boolean {
    const abort = this.generations.get(projectId);
    if (!abort) return false;
    this.generations.delete(projectId);
    abort.abort();
    return true;
  }

  /**
   * Emit progress update
   */
  private emitProgress(projectId: string, progress: ChangelogGenerationProgress): void {
    this.emit('generation-progress', projectId, progress);
  }

  /**
   * Emit error
   */
  private emitError(projectId: string, error: string): void {
    this.emit('generation-progress', projectId, {
      stage: 'error',
      progress: 0,
      message: error,
      error
    });
    this.emit('generation-error', projectId, error);
  }
}
