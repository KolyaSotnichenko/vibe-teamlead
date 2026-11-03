import { EventEmitter } from 'events';
import path from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { AgentState } from './agent-state';
import { AgentEvents } from './agent-events';
import { AgentProcessManager } from './agent-process';
import { AgentQueueManager } from './agent-queue';
import {
  SpecCreationMetadata,
  TaskExecutionOptions,
  RoadmapConfig
} from './types';
import type { IdeationConfig } from '../../shared/types';
import { resetStuckSubtasks } from '../ipc-handlers/task/plan-file-utils';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../shared/constants';
import { projectStore } from '../project-store';
import { type ResolvedClaudeCredential, resolveClaudeCredential } from '../ai/claude-code/credential';
import { isClaudeModel, resolveModelId } from '../ai/config/phase-config';
import type { AgentExecutorConfig, SerializableSessionConfig, SerializedSecurityProfile } from '../ai/agent/types';
import { getSecurityProfile } from '../ai/security/security-profile';
import { createOrGetWorktree } from '../ai/worktree';
import { findTaskWorktree } from '../worktree-paths';
import { tryLoadPrompt } from '../ai/prompts/prompt-loader';

/**
 * Main AgentManager - orchestrates agent process lifecycle
 * This is a slim facade that delegates to focused modules
 */
export class AgentManager extends EventEmitter {
  private state: AgentState;
  private events: AgentEvents;
  private processManager: AgentProcessManager;
  private queueManager: AgentQueueManager;
  constructor() {
    super();

    // Initialize modular components
    this.state = new AgentState();
    this.events = new AgentEvents();
    this.processManager = new AgentProcessManager(this.state, this.events, this);
    this.queueManager = new AgentQueueManager(this.state, this.events, this.processManager, this);
  }

  /**
   * Configure paths for Python and auto-claude source
   */
  configure(pythonPath?: string, autoBuildSourcePath?: string): void {
    this.processManager.configure(pythonPath, autoBuildSourcePath);
  }

  /**
   * The app's Claude credential for a new session. Emits a task error and
   * returns null when none is configured.
   */
  private requireClaudeAuth(taskId: string): ResolvedClaudeCredential | null {
    const auth = resolveClaudeCredential();
    if (!auth.key) {
      this.emit('error', taskId, 'No Claude credentials configured. Add an Anthropic API key in Settings > Claude before starting tasks.');
      return null;
    }
    return auth;
  }

  /**
   * Run startup recovery scan to detect and reset stuck subtasks on app launch
   * Scans all projects for implementation_plan.json files and resets any stuck subtasks
   */
  async runStartupRecoveryScan(): Promise<void> {
    console.log('[AgentManager] Running startup recovery scan for stuck subtasks...');

    try {
      // Get all projects from the store
      const projects = projectStore.getProjects();

      if (projects.length === 0) {
        console.log('[AgentManager] No projects found - skipping startup recovery scan');
        return;
      }

      let totalScanned = 0;
      let totalReset = 0;

      // Scan each project for stuck subtasks
      for (const project of projects) {
        if (!project.autoBuildPath) {
          continue; // Skip projects that haven't been initialized yet
        }

        const specsDir = path.join(project.path, getSpecsDir(project.autoBuildPath));

        // Check if specs directory exists
        if (!existsSync(specsDir)) {
          continue;
        }

        // Read all spec directories
        try {
          const specDirs = readdirSync(specsDir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

          // Process each spec directory
          for (const specDirName of specDirs) {
            const planPath = path.join(specsDir, specDirName, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);

            // Check if implementation_plan.json exists
            if (!existsSync(planPath)) {
              continue;
            }

            totalScanned++;

            // Reset stuck subtasks (pass project.id to invalidate tasks cache)
            const { success, resetCount } = await resetStuckSubtasks(planPath, project.id);

            if (success && resetCount > 0) {
              totalReset += resetCount;
              console.log(`[AgentManager] Startup recovery: Reset ${resetCount} stuck subtask(s) in ${specDirName}`);
            }
          }
        } catch (err) {
          console.warn(`[AgentManager] Failed to scan specs directory for project ${project.name}:`, err);
        }
      }

      if (totalReset > 0) {
        console.log(`[AgentManager] Startup recovery complete: Reset ${totalReset} stuck subtask(s) across ${totalScanned} task(s)`);
      } else {
        console.log(`[AgentManager] Startup recovery complete: No stuck subtasks found (scanned ${totalScanned} task(s))`);
      }
    } catch (err) {
      console.error('[AgentManager] Startup recovery scan failed:', err);
    }
  }

  /**
   * Start spec creation process
   */
  async startSpecCreation(
    taskId: string,
    projectPath: string,
    taskDescription: string,
    specDir?: string,
    metadata?: SpecCreationMetadata,
    baseBranch?: string,
    projectId?: string
  ): Promise<void> {
    const auth = this.requireClaudeAuth(taskId);
    if (!auth) return;

    // Reset stuck subtasks if restarting an existing spec creation task
    if (specDir) {
      const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
      console.log('[AgentManager] Resetting stuck subtasks before spec creation restart:', planPath);
      try {
        const { success, resetCount } = await resetStuckSubtasks(planPath);
        if (success && resetCount > 0) {
          console.log(`[AgentManager] Successfully reset ${resetCount} stuck subtask(s) before spec creation`);
        }
      } catch (err) {
        console.warn('[AgentManager] Failed to reset stuck subtasks before spec creation:', err);
      }
    }

    // Resolve model and thinking level for the spec phase
    const specModelShorthand = metadata?.phaseModels?.spec
      ? metadata.phaseModels.spec
      : (metadata?.model ?? 'sonnet');

    const specModelId = resolveModelId(isClaudeModel(specModelShorthand) ? specModelShorthand : 'sonnet');

    // Load system prompt from prompts directory
    const systemPrompt = this.loadPrompt('spec_orchestrator') ?? this.buildDefaultSpecPrompt(taskDescription, specDir);

    // Build the serializable session config for the worker
    const resolvedSpecDir = specDir ?? path.join(projectPath, '.auto-claude', 'specs', taskId);
    const sessionConfig: SerializableSessionConfig = {
      agentType: 'spec_orchestrator' as const,
      systemPrompt,
      phase: 'spec' as const,
      initialMessages: [
        {
          role: 'user',
          content: `Task: ${taskDescription}\n\nProject directory: ${projectPath}${specDir ? `\nSpec directory: ${specDir}` : ''}${baseBranch ? `\nBase branch: ${baseBranch}` : ''}${metadata?.requireReviewBeforeCoding ? '\nRequire review before coding: true' : '\nAuto-approve: true'}`,
        },
      ],
      maxSteps: 1000,
      specDir: resolvedSpecDir,
      projectDir: projectPath,
      modelId: specModelId,
      ...this.sessionAuth(auth),
      mcpOptions: {
        context7Enabled: true,
        memoryEnabled: !!process.env.GRAPHITI_MCP_URL,
        linearEnabled: !!process.env.LINEAR_API_KEY,
      },
      toolContext: {
        cwd: projectPath,
        projectDir: projectPath,
        specDir: resolvedSpecDir,
        securityProfile: this.serializeSecurityProfile(projectPath),
      },
    };

    const executorConfig: AgentExecutorConfig = {
      taskId,
      projectId,
      processType: 'spec-creation',
      session: sessionConfig,
    };

    await this.processManager.spawnWorkerProcess(taskId, executorConfig, {}, 'spec-creation', projectId);

    // Note (Python fallback preserved for reference):
    // const combinedEnv = this.processManager.getCombinedEnv(projectPath);
    // const args = [specRunnerPath, '--task', taskDescription, '--project-dir', projectPath];
    // await this.processManager.spawnProcess(taskId, projectPath, args, combinedEnv, 'task-execution', projectId);
  }

  /**
   * Start task execution (build orchestrator)
   */
  async startTaskExecution(
    taskId: string,
    projectPath: string,
    specId: string,
    options: TaskExecutionOptions = {},
    projectId?: string
  ): Promise<void> {
    const auth = this.requireClaudeAuth(taskId);
    if (!auth) return;

    // Resolve the spec directory from specId
    const project = projectStore.getProjects().find((p) => p.id === projectId || p.path === projectPath);
    const specsBaseDir = getSpecsDir(project?.autoBuildPath);
    const specDir = path.join(projectPath, specsBaseDir, specId);

    // Load model configuration from task_metadata.json if available
    const modelId = await this.resolveTaskModelId(specDir, 'planning');

    // Load system prompt (planner prompt for build orchestrator entry point)
    const systemPrompt = this.loadPrompt('planner') ?? this.buildDefaultPlannerPrompt(specId, projectPath);

    // Create or get existing git worktree for task isolation
    // This matches the Python backend's WorktreeManager.create_worktree() behavior
    let worktreePath: string | null = null;
    let worktreeSpecDir = specDir;
    const useWorktree = options.useWorktree !== false; // Default to true (matching Python backend)
    if (useWorktree) {
      try {
        const baseBranch = options.baseBranch ?? project?.settings?.mainBranch ?? 'main';
        const result = await createOrGetWorktree(
          projectPath,
          specId,
          baseBranch,
          options.useLocalBranch ?? false,
          project?.settings?.pushNewBranches !== false,
          project?.autoBuildPath,
        );
        worktreePath = result.worktreePath;
        // Spec dir in the worktree (spec files were copied by createOrGetWorktree)
        worktreeSpecDir = path.join(worktreePath, specsBaseDir, specId);
        console.warn(`[AgentManager] Task ${taskId} will run in worktree: ${worktreePath}`);
      } catch (err) {
        console.error(`[AgentManager] Failed to create worktree for ${taskId}:`, err);
        // Fall back to running in project root (non-fatal)
        console.warn(`[AgentManager] Falling back to project root for ${taskId}`);
      }
    }

    const effectiveCwd = worktreePath ?? projectPath;
    const effectiveProjectDir = worktreePath ?? projectPath;

    // Load initial context from spec directory
    const initialMessages = this.buildTaskExecutionMessages(worktreeSpecDir, specId, effectiveProjectDir);

    // Build the serializable session config for the worker
    const sessionConfig: SerializableSessionConfig = {
      agentType: 'build_orchestrator' as const,
      systemPrompt,
      initialMessages,
      maxSteps: 1000,
      specDir: worktreeSpecDir,
      projectDir: effectiveProjectDir,
      // When running in a worktree, sourceSpecDir points to the main project spec dir
      // so the subtask iterator can sync phase updates in real time (not just on exit).
      sourceSpecDir: worktreePath ? specDir : undefined,
      modelId,
      ...this.sessionAuth(auth),
      mcpOptions: {
        context7Enabled: true,
        memoryEnabled: !!process.env.GRAPHITI_MCP_URL,
        linearEnabled: !!process.env.LINEAR_API_KEY,
      },
      toolContext: {
        cwd: effectiveCwd,
        projectDir: effectiveProjectDir,
        specDir: worktreeSpecDir,
        securityProfile: this.serializeSecurityProfile(effectiveProjectDir),
      },
    };

    const executorConfig: AgentExecutorConfig = {
      taskId,
      projectId,
      processType: 'task-execution',
      session: sessionConfig,
    };

    await this.processManager.spawnWorkerProcess(taskId, executorConfig, {}, 'task-execution', projectId);

    // Note (Python fallback preserved for reference):
    // const combinedEnv = this.processManager.getCombinedEnv(projectPath);
    // const args = [runPath, '--spec', specId, '--project-dir', projectPath, '--auto-continue', '--force'];
    // await this.processManager.spawnProcess(taskId, projectPath, args, combinedEnv, 'task-execution', projectId);
  }

  /**
   * Start QA process (qa_reviewer agent)
   */
  async startQAProcess(
    taskId: string,
    projectPath: string,
    specId: string,
    projectId?: string
  ): Promise<void> {
    const auth = this.requireClaudeAuth(taskId);
    if (!auth) return;

    // Resolve the spec directory from specId
    const project = projectStore.getProjects().find((p) => p.id === projectId || p.path === projectPath);
    const specsBaseDir = getSpecsDir(project?.autoBuildPath);
    const specDir = path.join(projectPath, specsBaseDir, specId);

    // Load model configuration from task_metadata.json if available
    const modelId = await this.resolveTaskModelId(specDir, 'qa');

    // Load system prompt for QA reviewer
    const systemPrompt = this.loadPrompt('qa_reviewer') ?? this.buildDefaultQAPrompt(specId, projectPath);

    // Find existing worktree for QA (created during task execution)
    const worktreePath = findTaskWorktree(projectPath, specId);
    const effectiveCwd = worktreePath ?? projectPath;
    const effectiveProjectDir = worktreePath ?? projectPath;
    const effectiveSpecDir = worktreePath
      ? path.join(worktreePath, specsBaseDir, specId)
      : specDir;

    if (worktreePath) {
      console.warn(`[AgentManager] QA for ${taskId} will run in worktree: ${worktreePath}`);
    } else {
      console.warn(`[AgentManager] No worktree found for ${taskId}, QA running in project root`);
    }

    // Load initial context from spec directory
    const qaInitialMessages = this.buildQAInitialMessages(effectiveSpecDir, specId, effectiveProjectDir);

    // Build the serializable session config for the worker
    const sessionConfig: SerializableSessionConfig = {
      agentType: 'qa_reviewer',
      systemPrompt,
      initialMessages: qaInitialMessages,
      maxSteps: 1000,
      specDir: effectiveSpecDir,
      projectDir: effectiveProjectDir,
      modelId,
      ...this.sessionAuth(auth),
      mcpOptions: {
        context7Enabled: true,
        memoryEnabled: !!process.env.GRAPHITI_MCP_URL,
        linearEnabled: !!process.env.LINEAR_API_KEY,
      },
      toolContext: {
        cwd: effectiveCwd,
        projectDir: effectiveProjectDir,
        specDir: effectiveSpecDir,
        securityProfile: this.serializeSecurityProfile(effectiveProjectDir),
      },
    };

    const executorConfig: AgentExecutorConfig = {
      taskId,
      projectId,
      processType: 'qa-process',
      session: sessionConfig,
    };

    await this.processManager.spawnWorkerProcess(taskId, executorConfig, {}, 'qa-process', projectId);

    // Note (Python fallback preserved for reference):
    // const combinedEnv = this.processManager.getCombinedEnv(projectPath);
    // const args = [runPath, '--spec', specId, '--project-dir', projectPath, '--qa'];
    // await this.processManager.spawnProcess(taskId, projectPath, args, combinedEnv, 'qa-process', projectId);
  }

  /**
   * Start roadmap generation process
   */
  startRoadmapGeneration(
    projectId: string,
    projectPath: string,
    refresh: boolean = false,
    enableCompetitorAnalysis: boolean = false,
    refreshCompetitorAnalysis: boolean = false,
    config?: RoadmapConfig
  ): void {
    this.queueManager.startRoadmapGeneration(projectId, projectPath, refresh, enableCompetitorAnalysis, refreshCompetitorAnalysis, config);
  }

  /**
   * Start ideation generation process
   */
  startIdeationGeneration(
    projectId: string,
    projectPath: string,
    config: IdeationConfig,
    refresh: boolean = false
  ): void {
    this.queueManager.startIdeationGeneration(projectId, projectPath, config, refresh);
  }

  /**
   * Kill a specific task's process
   */
  killTask(taskId: string): boolean {
    return this.processManager.killProcess(taskId);
  }

  /**
   * Stop ideation generation for a project
   */
  stopIdeation(projectId: string): boolean {
    return this.queueManager.stopIdeation(projectId);
  }

  /**
   * Check if ideation is running for a project
   */
  isIdeationRunning(projectId: string): boolean {
    return this.queueManager.isIdeationRunning(projectId);
  }

  /**
   * Stop roadmap generation for a project
   */
  stopRoadmap(projectId: string): boolean {
    return this.queueManager.stopRoadmap(projectId);
  }

  /**
   * Check if roadmap is running for a project
   */
  isRoadmapRunning(projectId: string): boolean {
    return this.queueManager.isRoadmapRunning(projectId);
  }

  /**
   * Kill all running processes
   */
  async killAll(): Promise<void> {
    await this.processManager.killAllProcesses();
  }

  /**
   * Check if a task is running
   */
  isRunning(taskId: string): boolean {
    return this.state.hasProcess(taskId);
  }

  /**
   * Get all running task IDs
   */
  getRunningTasks(): string[] {
    return this.state.getRunningTaskIds();
  }

  // ============================================
  // Private helpers for TypeScript agent path
  // ============================================

  /**
   * Credential fields of the worker session config. The worker turns them
   * into session auth (subscription tokens only in personal mode).
   */
  private sessionAuth(auth: ResolvedClaudeCredential): Pick<SerializableSessionConfig, 'apiKey' | 'baseURL'> {
    return { apiKey: auth.key, baseURL: auth.baseURL };
  }

  /**
   * Serialize a project's SecurityProfile (Sets) into a SerializedSecurityProfile (arrays)
   * for transfer across worker thread boundaries.
   */
  private serializeSecurityProfile(projectDir: string): SerializedSecurityProfile {
    const profile = getSecurityProfile(projectDir);
    return {
      baseCommands: [...profile.baseCommands],
      stackCommands: [...profile.stackCommands],
      scriptCommands: [...profile.scriptCommands],
      customCommands: [...profile.customCommands],
      customScripts: {
        shellScripts: profile.customScripts.shellScripts,
      },
    };
  }

  /**
   * Resolve the Claude model ID for a task by reading task_metadata.json.
   * Falls back to the default sonnet model if metadata is not available.
   *
   * @param specDir - The spec directory path
   * @param phase - The execution phase ('planning', 'coding', 'qa', 'spec')
   */
  private async resolveTaskModelId(specDir: string, phase: 'planning' | 'coding' | 'qa' | 'spec'): Promise<string> {
    try {
      const metadataPath = path.join(specDir, 'task_metadata.json');
      if (existsSync(metadataPath)) {
        const raw = readFileSync(metadataPath, 'utf-8');
        const metadata = JSON.parse(raw) as {
          phaseModels?: Record<string, string>;
          model?: string;
        };
        const model = metadata.phaseModels?.[phase] || metadata.model;
        // Tasks created with a model of a removed provider fall back to the default
        if (isClaudeModel(model)) return resolveModelId(model);
      }
    } catch {
      // Fall through to default
    }

    return resolveModelId('sonnet');
  }

  /**
   * Load a system prompt from the prompts directory.
   * Returns null if the prompt file is not found.
   *
   * @param promptName - The prompt filename without extension (e.g., 'planner', 'qa_reviewer')
   */
  private loadPrompt(promptName: string): string | null {
    return tryLoadPrompt(promptName);
  }

  /**
   * Build a minimal default system prompt for spec orchestration
   * when the prompt file is not found.
   */
  private buildDefaultSpecPrompt(taskDescription: string, specDir?: string): string {
    return `You are a spec creation agent. Your job is to create a detailed specification and implementation plan for the following task:\n\n${taskDescription}${specDir ? `\n\nSpec directory: ${specDir}` : ''}\n\nCreate a spec.md with requirements and an implementation_plan.json with phases and subtasks.`;
  }

  /**
   * Build a minimal default system prompt for the planner/build orchestrator
   * when the prompt file is not found.
   */
  private buildDefaultPlannerPrompt(specId: string, projectPath: string): string {
    return `You are a planning agent. Your job is to review the spec and create an implementation plan for spec ${specId} in project ${projectPath}. Read the spec.md and create implementation_plan.json with phases and subtasks.`;
  }

  /**
   * Build a minimal default system prompt for the QA reviewer
   * when the prompt file is not found.
   */
  private buildDefaultQAPrompt(specId: string, projectPath: string): string {
    return `You are a QA reviewer agent. Your job is to review the implementation of spec ${specId} in project ${projectPath}. Check that all requirements in spec.md are implemented correctly and write a qa_report.md with Status: PASSED or Status: FAILED.`;
  }

  /**
   * Build initial messages for task execution (build_orchestrator).
   * Includes the spec.md and implementation_plan.json content for agent context.
   */
  private buildTaskExecutionMessages(
    specDir: string,
    specId: string,
    projectPath: string,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const parts: string[] = [];

    parts.push(`You are implementing spec ${specId} in project: ${projectPath}`);
    parts.push(`Spec directory: ${specDir}`);
    parts.push('');

    // Read spec.md
    const specPath = path.join(specDir, 'spec.md');
    try {
      if (existsSync(specPath)) {
        const specContent = readFileSync(specPath, 'utf-8');
        parts.push('## Specification (spec.md)');
        parts.push('');
        parts.push(specContent);
        parts.push('');
      }
    } catch {
      // Not critical — agent can read spec itself
    }

    // Read implementation_plan.json if it exists (resume scenario)
    const planPath = path.join(specDir, 'implementation_plan.json');
    try {
      if (existsSync(planPath)) {
        const planContent = readFileSync(planPath, 'utf-8');
        parts.push('## Implementation Plan (implementation_plan.json)');
        parts.push('');
        parts.push('```json');
        parts.push(planContent);
        parts.push('```');
        parts.push('');
        parts.push('Resume implementing the pending/in-progress subtasks. Do NOT redo completed subtasks. Update each subtask status to "completed" in implementation_plan.json after finishing it.');
      } else {
        parts.push('No implementation plan exists yet. Start by creating implementation_plan.json with phases and subtasks, then implement each subtask.');
      }
    } catch {
      // Fall through
    }

    return [{ role: 'user', content: parts.join('\n') }];
  }

  /**
   * Build initial messages for QA process.
   * Includes spec.md and implementation plan to give QA agent full context.
   */
  private buildQAInitialMessages(
    specDir: string,
    specId: string,
    projectPath: string,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const parts: string[] = [];

    parts.push(`You are reviewing the implementation of spec ${specId} in project: ${projectPath}`);
    parts.push(`Spec directory: ${specDir}`);
    parts.push('');

    // Read spec.md
    const specPath = path.join(specDir, 'spec.md');
    try {
      if (existsSync(specPath)) {
        const specContent = readFileSync(specPath, 'utf-8');
        parts.push('## Specification (spec.md)');
        parts.push('');
        parts.push(specContent);
        parts.push('');
      }
    } catch {
      // Not critical
    }

    // Read implementation_plan.json to show what was planned/completed
    const planPath = path.join(specDir, 'implementation_plan.json');
    try {
      if (existsSync(planPath)) {
        const planContent = readFileSync(planPath, 'utf-8');
        parts.push('## Implementation Plan (implementation_plan.json)');
        parts.push('');
        parts.push('```json');
        parts.push(planContent);
        parts.push('```');
        parts.push('');
      }
    } catch {
      // Fall through
    }

    parts.push('Review the implementation against the specification. Check that all requirements are met, the code is correct, and tests pass. Write your findings to qa_report.md with "Status: PASSED" or "Status: FAILED" and a list of any issues found.');

    return [{ role: 'user', content: parts.join('\n') }];
  }
}
