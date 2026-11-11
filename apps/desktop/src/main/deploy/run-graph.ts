/**
 * Builds the run graph of one workflow run: columns are the topological levels of the
 * workflow's `jobs.<id>.needs`, nodes are workflow jobs (matrix and reusable-workflow
 * jobs from the API folded into them), and deployments form a last column.
 */
import { load } from 'js-yaml';
import type {
  DeployDeployment,
  DeployJob,
  GraphNode,
  GraphNodeStatus,
  RunGraph,
} from '../../shared/types/deploy';

interface WorkflowJob {
  id: string;
  label: string;
  needs: string[];
  matchers: Array<(name: string) => boolean>;
}

const DEPLOY_STAGE = 'deploy';
const OTHER_STAGE = 'other';

function jobStatus(job: DeployJob): GraphNodeStatus {
  if (job.status === 'in_progress') return 'running';
  if (job.status === 'queued' || job.status === 'waiting') return 'queued';
  switch (job.conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failure';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
    case 'neutral':
      return 'skipped';
    default:
      return 'skipped';
  }
}

function deploymentStatus(d: DeployDeployment): GraphNodeStatus {
  switch (d.state) {
    case 'success':
      return 'success';
    case 'failure':
    case 'error':
      return 'failure';
    case 'in_progress':
      return 'running';
    case 'queued':
    case 'pending':
      return 'queued';
    default:
      return 'skipped';
  }
}

function aggregate(statuses: GraphNodeStatus[]): GraphNodeStatus {
  const has = (s: GraphNodeStatus) => statuses.includes(s);
  if (has('running')) return 'running';
  if (has('failure')) return 'failure';
  if (has('cancelled')) return 'cancelled';
  if (has('queued')) return 'queued';
  if (statuses.every((s) => s === 'skipped')) return 'skipped';
  return 'success';
}

const MAX_YAML_BYTES = 1024 * 1024;
const MAX_WORKFLOW_JOBS = 500;

/** Linear-time match of literal segments in order (an expression `${{ … }}` stands for any text). */
function matchesSegments(name: string, segments: string[]): boolean {
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!name.startsWith(first)) return false;
  let pos = first.length;
  for (let i = 1; i < segments.length - 1; i++) {
    const at = name.indexOf(segments[i], pos);
    if (at < 0) return false;
    pos = at + segments[i].length;
  }
  return name.length - last.length >= pos && name.endsWith(last);
}

/** Matches the API name against a workflow name: exact, matrix suffix " (…)", or reusable prefix "name / ". */
function nameMatcher(workflowName: string): (name: string) => boolean {
  if (workflowName.includes('${{')) {
    const segments = workflowName.split(/\$\{\{.*?\}\}/);
    if (segments.length < 2 || segments.every((x) => x === '')) return () => false;
    return (name) => matchesSegments(name, segments);
  }
  return (name) =>
    name === workflowName || name.startsWith(`${workflowName} (`) || name.startsWith(`${workflowName} / `);
}

function parseWorkflow(yaml: string | null): WorkflowJob[] | null {
  if (!yaml || yaml.length > MAX_YAML_BYTES) return null;
  try {
    const doc = load(yaml);
    const jobs = (doc as { jobs?: unknown } | null)?.jobs;
    if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return null;
    const entries = Object.entries(jobs as Record<string, unknown>);
    if (entries.length > MAX_WORKFLOW_JOBS) return null;
    const result: WorkflowJob[] = [];
    for (const [id, raw] of entries) {
      const def = raw && typeof raw === 'object' ? (raw as { name?: unknown; needs?: unknown }) : {};
      const label = typeof def.name === 'string' && def.name ? def.name : id;
      const needs = typeof def.needs === 'string' ? [def.needs] : Array.isArray(def.needs) ? def.needs.map(String) : [];
      const matchers = [nameMatcher(id)];
      if (label !== id) matchers.push(nameMatcher(label));
      result.push({ id, label, needs, matchers });
    }
    return result.length > 0 ? result : null;
  } catch {
    return null;
  }
}

/** Topological level of each job (Kahn, iterative), or null when `needs` is cyclic. Unknown needs are ignored. */
function levels(jobs: WorkflowJob[]): Map<string, number> | null {
  const ids = new Set(jobs.map((j) => j.id));
  const pending = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const j of jobs) {
    const needs = [...new Set(j.needs)].filter((n) => ids.has(n));
    pending.set(j.id, needs.length);
    for (const n of needs) dependents.set(n, [...(dependents.get(n) ?? []), j.id]);
  }
  const level = new Map<string, number>();
  let queue = jobs.filter((j) => pending.get(j.id) === 0).map((j) => j.id);
  for (const id of queue) level.set(id, 0);
  while (queue.length) {
    const next: string[] = [];
    for (const id of queue) {
      for (const d of dependents.get(id) ?? []) {
        level.set(d, Math.max(level.get(d) ?? 0, (level.get(id) ?? 0) + 1));
        const left = (pending.get(d) ?? 0) - 1;
        pending.set(d, left);
        if (left === 0) next.push(d);
      }
    }
    queue = next;
  }
  return level.size === ids.size ? level : null;
}

function byStart(a: DeployJob, b: DeployJob): number {
  return (a.startedAt ?? '￿').localeCompare(b.startedAt ?? '￿') || a.id - b.id;
}

function makeNode(key: string, label: string, jobs: DeployJob[]): GraphNode {
  const sorted = [...jobs].sort(byStart);
  const starts = sorted.map((j) => j.startedAt).filter((s): s is string => !!s);
  const ends = sorted.map((j) => j.completedAt).filter((s): s is string => !!s);
  const allDone = sorted.every((j) => j.status === 'completed');
  return {
    key,
    label,
    jobIds: sorted.map((j) => j.id),
    status: aggregate(sorted.map(jobStatus)),
    startedAt: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : undefined,
    completedAt: allDone && ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : undefined,
  };
}

function deployColumn(deployments: DeployDeployment[]): { stage: string; nodes: GraphNode[] } | null {
  if (deployments.length === 0) return null;
  const latest = new Map<string, DeployDeployment>();
  for (const d of deployments) {
    const prev = latest.get(d.environment);
    if (!prev || d.createdAt >= prev.createdAt) latest.set(d.environment, d);
  }
  return {
    stage: DEPLOY_STAGE,
    nodes: [...latest.values()].map((d) => ({
      key: `deploy:${d.environment}`,
      label: d.environment,
      jobIds: [],
      status: deploymentStatus(d),
      startedAt: d.createdAt,
      deploymentUrl: d.url,
      logUrl: d.logUrl,
    })),
  };
}

export function buildRunGraph(
  workflowYaml: string | null,
  jobs: DeployJob[],
  deployments: DeployDeployment[],
): RunGraph {
  const columns: RunGraph['columns'] = [];
  const workflow = parseWorkflow(workflowYaml);
  const levelOf = workflow ? levels(workflow) : null;

  if (!workflow || !levelOf) {
    const nodes = [...jobs].sort(byStart).map((j) => makeNode(`job-${j.id}`, j.name, [j]));
    if (nodes.length) columns.push({ stage: OTHER_STAGE, nodes });
  } else {
    const assigned = new Map<string, DeployJob[]>();
    const unmatched: DeployJob[] = [];
    for (const j of jobs) {
      // Prefer an exact match over a prefix match when several workflow jobs could claim it.
      const exact = workflow.find((w) => w.id === j.name || w.label === j.name);
      const target = exact ?? workflow.find((w) => w.matchers.some((m) => m(j.name)));
      if (!target) unmatched.push(j);
      else assigned.set(target.id, [...(assigned.get(target.id) ?? []), j]);
    }
    const stages = new Map<number, GraphNode[]>();
    for (const w of workflow) {
      const mine = assigned.get(w.id);
      if (!mine) continue;
      const l = levelOf.get(w.id) ?? 0;
      stages.set(l, [...(stages.get(l) ?? []), makeNode(w.id, w.label, mine)]);
    }
    for (const l of [...stages.keys()].sort((a, b) => a - b)) {
      columns.push({ stage: `level-${columns.length + 1}`, nodes: stages.get(l) ?? [] });
    }
    if (unmatched.length) {
      columns.push({
        stage: OTHER_STAGE,
        nodes: unmatched.sort(byStart).map((j) => makeNode(`job-${j.id}`, j.name, [j])),
      });
    }
  }

  const deploy = deployColumn(deployments);
  if (deploy) columns.push(deploy);
  return { columns };
}
