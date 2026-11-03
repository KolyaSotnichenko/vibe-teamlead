import type { TFunction } from 'i18next';
import type { ChangelogTask, ChangelogSourceMode, GitCommit } from '../../../shared/types';

export interface SummaryInfo {
  count: number;
  kind: 'task' | 'commit' | 'item';
  details: string;
}

export function getSummaryInfo(
  t: TFunction,
  sourceMode: ChangelogSourceMode,
  selectedTaskIds: string[],
  selectedTasks: ChangelogTask[],
  previewCommits: GitCommit[]
): SummaryInfo {
  switch (sourceMode) {
    case 'tasks':
      return {
        count: selectedTaskIds.length,
        kind: 'task',
        details: selectedTasks.slice(0, 3).map((task) => task.title).join(', ') +
          (selectedTasks.length > 3 ? ` ${t('changelog.summary.more', { count: selectedTasks.length - 3 })}` : '')
      };
    case 'git-history':
    case 'branch-diff':
      return {
        count: previewCommits.length,
        kind: 'commit',
        details: previewCommits.slice(0, 3).map((c) => c.subject.substring(0, 40)).join(', ') +
          (previewCommits.length > 3 ? ` ${t('changelog.summary.more', { count: previewCommits.length - 3 })}` : '')
      };
    default:
      return { count: 0, kind: 'item', details: '' };
  }
}

export function formatVersionTag(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

export function getVersionBumpDescription(t: TFunction, versionReason: string | null): string | null {
  if (!versionReason) return null;

  switch (versionReason) {
    case 'breaking':
      return t('changelog.versionBump.major');
    case 'feature':
      return t('changelog.versionBump.minor');
    default:
      return t('changelog.versionBump.patch');
  }
}
