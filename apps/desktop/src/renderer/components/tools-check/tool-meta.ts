/**
 * Display metadata for the tools check: product names (never translated),
 * how rows are grouped, the per-area summary, and how a "skipped" reason in a
 * security report maps back to the tool that fixes it.
 */

import type { ToolCheck, ToolId } from '../../../shared/types';
import { type HintPlatform, startDockerCommand, toolInstallHints } from '../../../shared/utils/tool-install-hints';
import { isWindows } from '../../lib/os-detection';

export const TOOL_NAMES: Record<ToolId, string> = {
  'claude-code': 'Claude Code',
  'git-bash': 'Git for Windows',
  codegraph: 'CodeGraph',
  gitleaks: 'gitleaks',
  'osv-scanner': 'OSV-Scanner',
  semgrep: 'Semgrep',
  chrome: 'Google Chrome',
  docker: 'Docker',
  strix: 'Strix',
};

/** Areas the checklist is grouped by, in display order. */
export type ToolArea = 'required' | 'bundled' | 'security_gates' | 'browser_qa' | 'security_qa';

export const AREA_ORDER: ToolArea[] = ['required', 'bundled', 'security_gates', 'browser_qa', 'security_qa'];

/** Git for Windows is the one tool agents need that the user installs: its own area */
export function areaOf(tool: ToolCheck): ToolArea {
  if (tool.id === 'git-bash') return 'required';
  return tool.neededFor === 'agents' || tool.neededFor === 'code_graph' ? 'bundled' : tool.neededFor;
}

/** A tool works when it is bundled, or installed (and running, for Docker). */
export function isAvailable(tool: ToolCheck): boolean {
  return tool.status === 'bundled' || tool.status === 'ready';
}

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
  const areas: AreaSummary['area'][] = ['required', 'security_gates', 'browser_qa', 'security_qa'];
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
 * The commands come from the same per-platform table the main process uses
 * (`shared/utils/tool-install-hints.ts`), so the hint works without running a
 * check (which takes seconds).
 */
export interface SkipFix {
  tool: ToolId;
  kind: 'install' | 'start';
  command: string;
}

/** The platform the renderer runs on, for install hints (Windows, else the macOS hints). */
function hostPlatform(): HintPlatform {
  return isWindows() ? 'win32' : 'darwin';
}

function installCommand(tool: ToolId, platform: HintPlatform): string {
  return toolInstallHints(platform)[tool]?.command as string;
}

const UNAVAILABLE = /not (available|installed|found)/i;

/** A gate (gitleaks / OSV-Scanner / Semgrep) skipped because its scanner is not on this computer. */
export function gateSkipFix(gate: string, reason: string, platform: HintPlatform = hostPlatform()): SkipFix | null {
  if ((gate === 'gitleaks' || gate === 'osv-scanner' || gate === 'semgrep') && UNAVAILABLE.test(reason)) {
    return { tool: gate, kind: 'install', command: installCommand(gate, platform) };
  }
  return null;
}

/** Security QA (Strix) skipped because Strix is missing or Docker is not running. */
export function pentestSkipFix(reason: string | undefined, platform: HintPlatform = hostPlatform()): SkipFix | null {
  if (!reason) return null;
  if (/strix/i.test(reason) && UNAVAILABLE.test(reason)) {
    return { tool: 'strix', kind: 'install', command: installCommand('strix', platform) };
  }
  if (/docker/i.test(reason)) {
    if (/not running/i.test(reason)) return { tool: 'docker', kind: 'start', command: startDockerCommand(platform) };
    if (UNAVAILABLE.test(reason)) return { tool: 'docker', kind: 'install', command: installCommand('docker', platform) };
  }
  return null;
}

/** Opens Settings → Tools (App.tsx listens for this event). */
export function openToolsSettings(): void {
  window.dispatchEvent(new CustomEvent('open-app-settings', { detail: 'tools' }));
}
