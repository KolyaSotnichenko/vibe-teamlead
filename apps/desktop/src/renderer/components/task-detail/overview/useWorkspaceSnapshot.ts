/**
 * Reads the task's workspace (spec ACs, plan, architecture, security reports)
 * for the Overview summary. Same IPC as the Workspace tab; re-read when the
 * agents move the task forward.
 */

import { useEffect, useRef, useState } from 'react';
import type { Task, TaskWorkspace } from '../../../../shared/types';

export function useWorkspaceSnapshot(task: Task) {
  const [workspace, setWorkspace] = useState<TaskWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const requestRef = useRef(0);
  const progressKey = `${task.id}|${task.status}|${task.executionProgress?.phase ?? ''}|${task.subtasks.map((s) => s.status[0]).join('')}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: progressKey is the intended trigger
  useEffect(() => {
    const request = ++requestRef.current;
    const api = window.electronAPI?.getTaskWorkspace;
    if (!api) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api(task.id, task.projectId)
      .then((result) => {
        if (request !== requestRef.current) return;
        setWorkspace(result.success ? (result.data ?? null) : null);
      })
      .catch(() => {
        if (request === requestRef.current) setWorkspace(null);
      })
      .finally(() => {
        if (request === requestRef.current) setLoading(false);
      });
  }, [progressKey]);

  return { workspace, loading };
}
