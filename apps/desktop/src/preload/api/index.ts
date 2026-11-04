import { ProjectAPI, createProjectAPI } from './project-api';
import { TerminalAPI, createTerminalAPI } from './terminal-api';
import { TaskAPI, createTaskAPI } from './task-api';
import { SettingsAPI, createSettingsAPI } from './settings-api';
import { FileAPI, createFileAPI } from './file-api';
import { AgentAPI, createAgentAPI } from './agent-api';
import type { IdeationAPI } from './modules/ideation-api';
import type { InsightsAPI } from './modules/insights-api';
import { AppUpdateAPI, createAppUpdateAPI } from './app-update-api';
import { GitHubAPI, createGitHubAPI } from './modules/github-api';
import type { GitLabAPI } from './modules/gitlab-api';
import { DebugAPI, createDebugAPI } from './modules/debug-api';
import { ClaudeCodeAPI, createClaudeCodeAPI } from './modules/claude-code-api';
import { McpAPI, createMcpAPI } from './modules/mcp-api';
import { ScreenshotAPI, createScreenshotAPI } from './screenshot-api';
import { type AgentQuestionsAPI, createAgentQuestionsAPI } from './agent-questions-api';
import { type BriefAPI, createBriefAPI } from './brief-api';
import { type DesignAPI, createDesignAPI } from './design-api';
import { createToolsCheckAPI } from './tools-check-api';
import type { ToolsCheckAPI } from '../../shared/types/tools-check';

export interface ElectronAPI extends
  ProjectAPI,
  TerminalAPI,
  TaskAPI,
  SettingsAPI,
  FileAPI,
  AgentAPI,
  IdeationAPI,
  InsightsAPI,
  AppUpdateAPI,
  GitLabAPI,
  DebugAPI,
  ClaudeCodeAPI,
  McpAPI,
  ScreenshotAPI {
  github: GitHubAPI;
  /** Questions agents ask the user */
  agentQuestions: AgentQuestionsAPI;
  /** Brief import: brief → epics and tasks */
  brief: BriefAPI;
  /** External tools the pipeline uses (gitleaks, OSV-Scanner, Chrome, Docker, Strix) */
  tools: ToolsCheckAPI;
  /** The project's design system and Storybook */
  design: DesignAPI;
}

export const createElectronAPI = (): ElectronAPI => ({
  ...createProjectAPI(),
  ...createTerminalAPI(),
  ...createTaskAPI(),
  ...createSettingsAPI(),
  ...createFileAPI(),
  ...createAgentAPI(),  // Includes: Roadmap, Ideation, Insights, Changelog, Linear, GitHub, GitLab, Shell
  ...createAppUpdateAPI(),
  ...createDebugAPI(),
  ...createClaudeCodeAPI(),
  ...createMcpAPI(),
  ...createScreenshotAPI(),
  github: createGitHubAPI(),
  agentQuestions: createAgentQuestionsAPI(),
  brief: createBriefAPI(),
  tools: createToolsCheckAPI(),
  design: createDesignAPI()
});

// Export individual API creators for potential use in tests or specialized contexts
// Note: IdeationAPI, InsightsAPI, and GitLabAPI are included in AgentAPI
export {
  createProjectAPI,
  createTerminalAPI,
  createTaskAPI,
  createSettingsAPI,
  createFileAPI,
  createAgentAPI,
  createAppUpdateAPI,
  createGitHubAPI,
  createDebugAPI,
  createClaudeCodeAPI,
  createMcpAPI,
  createScreenshotAPI
};

export type {
  ProjectAPI,
  TerminalAPI,
  TaskAPI,
  SettingsAPI,
  FileAPI,
  AgentAPI,
  IdeationAPI,
  InsightsAPI,
  AppUpdateAPI,
  GitHubAPI,
  GitLabAPI,
  DebugAPI,
  ClaudeCodeAPI,
  McpAPI,
  ScreenshotAPI
};
