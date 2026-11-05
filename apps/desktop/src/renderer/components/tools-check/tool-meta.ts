/**
 * Display metadata for the tools check: product names (never translated),
 * how rows are grouped, the per-area summary, and how a "skipped" reason in a
 * security report maps back to the tool that fixes it.
 */

import type { ToolCheck, ToolId } from '../../../shared/types';

export const TOOL_NAMES: Record<ToolId, string> = {
  'claude-code': 'Claude Code',
  codegraph: 'CodeGraph',
  gitleaks: 'gitleaks',
  'osv-scanner': 'OSV-Scanner',
  semgrep: 'Semgrep',
  chrome: 'Google Chrome',
  docker: 'Docker',
  strix: 'Strix',
};

/** Areas the checklist is grouped by, in display order. */
export type ToolArea = 'bundled' | 'security_gates' | 'browser_qa' | 'security_qa';

export const AREA_ORDER: ToolArea[] = ['bundled', 'security_gates', 'browser_qa', 'security_qa'];

export function areaOf(tool: ToolCheck): ToolArea {
  return tool.neededFor === 'agents' || tool.neededFor === 'code_graph' ? 'bundled' : tool.neededFor;
}

/** A tool works when it is bundled, or installed (and running, for Docker). */
export function isAvailable(tool: ToolCheck): boolean {
  return tool.status === 'bundled' || tool.status === 'ready';
}

/** Command that starts Docker Desktop on macOS. */
export const START_DOCKER_COMMAND = 'open -a Docker';

/** What blocks an area: tools that are missing, or Docker that is installed but stopped. */
export interface AreaBlocker {
  id: ToolId;
  /** true when the tool is installed but not running (Docker) */
  notRunning: boolean;
}

export interface AreaSummary {
  area: Exclude<ToolArea, 'bundled'>;
  blockers: AreaBlocker[];
}

/** Summary per pipeline feature; the bundled tools are reassurance only and have no summary entry. */
export function summarize(tools: ToolCheck[]): AreaSummary[] {
  const areas: AreaSummary['area'][] = ['security_gates', 'browser_qa', 'security_qa'];
  return areas
    .map((area) => ({
      area,
      present: tools.some((t) => areaOf(t) === area),
      blockers: tools
        .filter((t) => areaOf(t) === area && !isAvailable(t))
        .map((t) => ({ id: t.id, notRunning: t.status === 'not_running' })),
    }))
    .filter((a) => a.present)
    .map(({ area, blockers }) => ({ area, blockers }));
}

/**
 * The fix for a skipped security check, matched from the report.
 * The install commands mirror `src/main/tools-check.ts` so the hint works
 * without running a check (which takes seconds).
 */
export interface SkipFix {
  tool: ToolId;
  kind: 'install' | 'start';
  command: string;
}

const INSTALL_COMMANDS: Partial<Record<ToolId, string>> = {
  gitleaks: 'brew install gitleaks',
  'osv-scanner': 'brew install osv-scanner',
  semgrep: 'brew install semgrep',
  strix: 'uv tool install strix-agent',
  docker: 'brew install --cask docker',
};

const UNAVAILABLE = /not (available|installed|found)/i;

/** A gate (gitleaks / OSV-Scanner / Semgrep) skipped because its scanner is not on this Mac. */
export function gateSkipFix(gate: string, reason: string): SkipFix | null {
  if ((gate === 'gitleaks' || gate === 'osv-scanner' || gate === 'semgrep') && UNAVAILABLE.test(reason)) {
    return { tool: gate, kind: 'install', command: INSTALL_COMMANDS[gate] as string };
  }
  return null;
}

/** Security QA (Strix) skipped because Strix is missing or Docker is not running. */
export function pentestSkipFix(reason: string | undefined): SkipFix | null {
  if (!reason) return null;
  if (/strix/i.test(reason) && UNAVAILABLE.test(reason)) {
    return { tool: 'strix', kind: 'install', command: INSTALL_COMMANDS.strix as string };
  }
  if (/docker/i.test(reason)) {
    if (/not running/i.test(reason)) return { tool: 'docker', kind: 'start', command: START_DOCKER_COMMAND };
    if (UNAVAILABLE.test(reason)) return { tool: 'docker', kind: 'install', command: INSTALL_COMMANDS.docker as string };
  }
  return null;
}

/** Opens Settings → Tools (App.tsx listens for this event). */
export function openToolsSettings(): void {
  window.dispatchEvent(new CustomEvent('open-app-settings', { detail: 'tools' }));
}
