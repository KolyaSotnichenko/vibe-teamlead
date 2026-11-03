import type { GitCommit } from '../../shared/types';
import { runClaudeTask } from '../ai/claude-code/task';
import { getFeatureSettings } from '../ipc-handlers/feature-settings-helper';

const TIMEOUT_MS = 2 * 60 * 1000;

interface VersionSuggestion {
  version: string;
  reason: string;
  bumpType: 'major' | 'minor' | 'patch';
}

/**
 * Version bump suggester: Claude (the "Utility" feature model) reads the commits
 * Analyzes commits to intelligently suggest semantic version bumps
 */
export class VersionSuggester {
  private debugEnabled: boolean;

  constructor(debugEnabled = false) {
    this.debugEnabled = debugEnabled;
  }

  private debug(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.warn('[VersionSuggester]', ...args);
    }
  }

  /**
   * Suggest a version bump from the commits (falls back to a patch bump).
   */
  async suggestVersionBump(commits: GitCommit[], currentVersion: string): Promise<VersionSuggestion> {
    this.debug('suggestVersionBump called', { commitCount: commits.length, currentVersion });
    const { model } = getFeatureSettings('utility');
    try {
      const result = await runClaudeTask({
        systemPrompt: 'You are a semantic versioning expert. Reply with the JSON object only.',
        prompt: this.buildPrompt(commits, currentVersion),
        model,
        maxTurns: 1,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const suggestion = this.parseAIResponse(result.text.trim(), currentVersion);
      this.debug('AI suggestion parsed', suggestion);
      return suggestion;
    } catch (error) {
      this.debug('AI analysis failed', error);
      return this.fallbackSuggestion(currentVersion);
    }
  }

  /**
   * Build prompt for Claude to analyze commits and suggest version bump
   */
  private buildPrompt(commits: GitCommit[], currentVersion: string): string {
    const commitSummary = commits
      .map((c, i) => `${i + 1}. ${c.hash} - ${c.subject}`)
      .join('\n');

    return `You are a semantic versioning expert analyzing git commits to suggest the appropriate version bump.

Current version: ${currentVersion}

Analyze these ${commits.length} commits and determine the appropriate semantic version bump:

${commitSummary}

Consider:
- MAJOR (X.0.0): Breaking changes, API changes, removed features, architectural changes
- MINOR (0.X.0): New features, enhancements, additions that maintain backward compatibility
- PATCH (0.0.X): Bug fixes, small tweaks, documentation updates, refactoring without new features

Respond with ONLY a JSON object in this exact format (no markdown, no extra text):
{
  "bumpType": "major|minor|patch",
  "reason": "Brief explanation of the decision"
}`;
  }

  /**
   * Parse AI response to extract version suggestion
   */
  private parseAIResponse(output: string, currentVersion: string): VersionSuggestion {
    // Extract JSON from output (Claude might wrap it in markdown or other text)
    const jsonMatch = output.match(/\{[\s\S]*"bumpType"[\s\S]*"reason"[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in AI response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const bumpType = parsed.bumpType as 'major' | 'minor' | 'patch';
    const reason = parsed.reason || 'AI analysis of commits';

    // Calculate new version
    const [major, minor, patch] = currentVersion.split('.').map(Number);

    let newVersion: string;
    switch (bumpType) {
      case 'major':
        newVersion = `${major + 1}.0.0`;
        break;
      case 'minor':
        newVersion = `${major}.${minor + 1}.0`;
        break;
      default:
        newVersion = `${major}.${minor}.${patch + 1}`;
        break;
    }

    return {
      version: newVersion,
      reason,
      bumpType
    };
  }

  /**
   * Fallback suggestion if AI analysis fails
   */
  private fallbackSuggestion(currentVersion: string): VersionSuggestion {
    const [major, minor, patch] = currentVersion.split('.').map(Number);
    return {
      version: `${major}.${minor}.${patch + 1}`,
      reason: 'Patch version bump (default)',
      bumpType: 'patch'
    };
  }
}
