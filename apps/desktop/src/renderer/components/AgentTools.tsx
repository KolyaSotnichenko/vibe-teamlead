/**
 * Agent Tools Overview
 *
 * Displays MCP server and tool configuration for each agent phase.
 * Helps users understand what tools are available during different execution phases.
 * Now shows per-project MCP configuration with toggles to enable/disable servers.
 */

import {
  Server,
  Brain,
  Search,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  Monitor,
  Globe,
  ClipboardList,
  ListChecks,
  Info,
  AlertCircle,
  Plus,
  Pencil,
  Trash2,
  Terminal,
  Loader2,
  RefreshCw,
  Lock
} from 'lucide-react';
import { useState, useMemo, useEffect, useCallback } from 'react';
import { ScrollArea } from './ui/scroll-area';
import { Switch } from './ui/switch';
import { Button } from './ui/button';
import { useSettingsStore } from '../stores/settings-store';
import { useProjectStore } from '../stores/project-store';
import type { ProjectEnvConfig, AgentMcpOverride, CustomMcpServer, McpHealthCheckResult, } from '../../shared/types';
import { CustomMcpDialog } from './CustomMcpDialog';
import { useTranslation } from 'react-i18next';
import {
  useResolvedAgentSettings,
  resolveAgentSettings as resolveAgentModelConfig,
} from '../hooks';
import type { ThinkingLevel } from '../../shared/types/settings';
import { thinkingLabel } from '../lib/agent-labels';
import { AGENT_CONFIGS, AgentConfig, CATEGORIES, getModelLabel } from './agent-tools/catalog';
import { AgentCard } from './agent-tools/AgentCard';

export function AgentTools() {
  const { t } = useTranslation(['settings']);
  const settings = useSettingsStore((state) => state.settings);
  const projects = useProjectStore((state) => state.projects);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(['spec', 'build', 'qa'])
  );
  const [envConfig, setEnvConfig] = useState<ProjectEnvConfig | null>(null);
  const [, setIsLoading] = useState(false);

  // Custom MCP server dialog state
  const [showCustomMcpDialog, setShowCustomMcpDialog] = useState(false);
  const [editingCustomServer, setEditingCustomServer] = useState<CustomMcpServer | null>(null);

  // Health status tracking for custom servers
  const [serverHealthStatus, setServerHealthStatus] = useState<Record<string, McpHealthCheckResult>>({});
  const [testingServers, setTestingServers] = useState<Set<string>>(new Set());

  // Load project env config when project changes
  useEffect(() => {
    if (selectedProjectId && selectedProject?.autoBuildPath) {
      setIsLoading(true);
      window.electronAPI.getProjectEnv(selectedProjectId)
        .then((result) => {
          if (result.success && result.data) {
            setEnvConfig(result.data);
          } else {
            setEnvConfig(null);
          }
        })
        .catch(() => {
          setEnvConfig(null);
        })
        .finally(() => {
          setIsLoading(false);
        });
    } else {
      setEnvConfig(null);
    }
  }, [selectedProjectId, selectedProject?.autoBuildPath]);

  // Update MCP server toggle
  const updateMcpServer = useCallback(async (
    key: keyof NonNullable<ProjectEnvConfig['mcpServers']>,
    value: boolean
  ) => {
    if (!selectedProjectId || !envConfig) return;

    const newMcpServers = {
      ...envConfig.mcpServers,
      [key]: value,
    };

    // Optimistic update
    setEnvConfig((prev) => prev ? { ...prev, mcpServers: newMcpServers } : null);

    // Save to backend
    try {
      await window.electronAPI.updateProjectEnv(selectedProjectId, {
        mcpServers: newMcpServers,
      });
    } catch (error) {
      // Revert on error
      console.error('Failed to update MCP config:', error);
      setEnvConfig((prev) => prev ? { ...prev, mcpServers: envConfig.mcpServers } : null);
    }
  }, [selectedProjectId, envConfig]);

  // Handle adding an MCP to an agent
  const handleAddMcp = useCallback(async (agentId: string, mcpId: string) => {
    if (!selectedProjectId || !envConfig) return;

    const currentOverrides = envConfig.agentMcpOverrides || {};
    const agentOverride = currentOverrides[agentId] || {};

    // If it's in the remove list, take it out (restore)
    // Otherwise, add it to the add list
    let newOverride: AgentMcpOverride;
    if (agentOverride.remove?.includes(mcpId)) {
      newOverride = {
        ...agentOverride,
        remove: agentOverride.remove.filter(m => m !== mcpId),
      };
    } else {
      newOverride = {
        ...agentOverride,
        add: [...(agentOverride.add || []), mcpId].filter((v, i, a) => a.indexOf(v) === i),
      };
    }

    // Clean up empty arrays
    if (newOverride.add?.length === 0) delete newOverride.add;
    if (newOverride.remove?.length === 0) delete newOverride.remove;

    const newOverrides = { ...currentOverrides };
    if (Object.keys(newOverride).length === 0) {
      delete newOverrides[agentId];
    } else {
      newOverrides[agentId] = newOverride;
    }

    // Optimistic update
    setEnvConfig((prev) => prev ? { ...prev, agentMcpOverrides: newOverrides } : null);

    // Save to backend
    try {
      await window.electronAPI.updateProjectEnv(selectedProjectId, {
        agentMcpOverrides: newOverrides,
      });
    } catch (error) {
      console.error('Failed to update agent MCP config:', error);
      setEnvConfig((prev) => prev ? { ...prev, agentMcpOverrides: currentOverrides } : null);
    }
  }, [selectedProjectId, envConfig]);

  // Handle removing an MCP from an agent
  const handleRemoveMcp = useCallback(async (agentId: string, mcpId: string) => {
    if (!selectedProjectId || !envConfig) return;

    const agentConfig = AGENT_CONFIGS[agentId];
    const defaults = [...(agentConfig?.mcp_servers || []), ...(agentConfig?.mcp_optional || [])];
    const isDefault = defaults.includes(mcpId);

    const currentOverrides = envConfig.agentMcpOverrides || {};
    const agentOverride = currentOverrides[agentId] || {};

    let newOverride: AgentMcpOverride;
    if (isDefault) {
      // It's a default MCP - add to remove list
      newOverride = {
        ...agentOverride,
        remove: [...(agentOverride.remove || []), mcpId].filter((v, i, a) => a.indexOf(v) === i),
      };
    } else {
      // It's a custom addition - remove from add list
      newOverride = {
        ...agentOverride,
        add: (agentOverride.add || []).filter(m => m !== mcpId),
      };
    }

    // Clean up empty arrays
    if (newOverride.add?.length === 0) delete newOverride.add;
    if (newOverride.remove?.length === 0) delete newOverride.remove;

    const newOverrides = { ...currentOverrides };
    if (Object.keys(newOverride).length === 0) {
      delete newOverrides[agentId];
    } else {
      newOverrides[agentId] = newOverride;
    }

    // Optimistic update
    setEnvConfig((prev) => prev ? { ...prev, agentMcpOverrides: newOverrides } : null);

    // Save to backend
    try {
      await window.electronAPI.updateProjectEnv(selectedProjectId, {
        agentMcpOverrides: newOverrides,
      });
    } catch (error) {
      console.error('Failed to update agent MCP config:', error);
      setEnvConfig((prev) => prev ? { ...prev, agentMcpOverrides: currentOverrides } : null);
    }
  }, [selectedProjectId, envConfig]);

  // Handle saving a custom MCP server
  const handleSaveCustomServer = useCallback(async (server: CustomMcpServer) => {
    if (!selectedProjectId || !envConfig) return;

    const currentServers = envConfig.customMcpServers || [];
    const existingIndex = currentServers.findIndex(s => s.id === server.id);

    let newServers: CustomMcpServer[];
    if (existingIndex >= 0) {
      // Update existing
      newServers = [...currentServers];
      newServers[existingIndex] = server;
    } else {
      // Add new
      newServers = [...currentServers, server];
    }

    // Optimistic update
    setEnvConfig((prev) => prev ? { ...prev, customMcpServers: newServers } : null);

    // Save to backend
    try {
      await window.electronAPI.updateProjectEnv(selectedProjectId, {
        customMcpServers: newServers,
      });
    } catch (error) {
      console.error('Failed to save custom MCP server:', error);
      setEnvConfig((prev) => prev ? { ...prev, customMcpServers: currentServers } : null);
    }
  }, [selectedProjectId, envConfig]);

  // Handle deleting a custom MCP server
  const handleDeleteCustomServer = useCallback(async (serverId: string) => {
    if (!selectedProjectId || !envConfig) return;

    const currentServers = envConfig.customMcpServers || [];
    const newServers = currentServers.filter(s => s.id !== serverId);

    // Also remove from any agent overrides that reference it
    const currentOverrides = envConfig.agentMcpOverrides || {};
    const newOverrides = { ...currentOverrides };
    for (const agentId of Object.keys(newOverrides)) {
      const override = newOverrides[agentId];
      if (override.add?.includes(serverId)) {
        newOverrides[agentId] = {
          ...override,
          add: override.add.filter(m => m !== serverId),
        };
        if (newOverrides[agentId].add?.length === 0) {
          delete newOverrides[agentId].add;
        }
        if (Object.keys(newOverrides[agentId]).length === 0) {
          delete newOverrides[agentId];
        }
      }
    }

    // Optimistic update
    setEnvConfig((prev) => prev ? {
      ...prev,
      customMcpServers: newServers,
      agentMcpOverrides: newOverrides,
    } : null);

    // Save to backend
    try {
      await window.electronAPI.updateProjectEnv(selectedProjectId, {
        customMcpServers: newServers,
        agentMcpOverrides: newOverrides,
      });
    } catch (error) {
      console.error('Failed to delete custom MCP server:', error);
      setEnvConfig((prev) => prev ? { ...prev, customMcpServers: currentServers, agentMcpOverrides: currentOverrides } : null);
    }
  }, [selectedProjectId, envConfig]);

  // Check health of all custom MCP servers
  const checkAllServersHealth = useCallback(async () => {
    const servers = envConfig?.customMcpServers || [];
    if (servers.length === 0) return;

    for (const server of servers) {
      // Set checking status
      setServerHealthStatus(prev => ({
        ...prev,
        [server.id]: {
          serverId: server.id,
          status: 'checking',
          checkedAt: new Date().toISOString(),
        }
      }));

      try {
        const result = await window.electronAPI.checkMcpHealth(server);
        if (result.success && result.data) {
          setServerHealthStatus(prev => ({
            ...prev,
            [server.id]: result.data!,
          }));
        }
      } catch (_error) {
        setServerHealthStatus(prev => ({
          ...prev,
          [server.id]: {
            serverId: server.id,
            status: 'unknown',
            message: t('settings:mcp.healthCheckFailed'),
            checkedAt: new Date().toISOString(),
          }
        }));
      }
    }
  }, [envConfig?.customMcpServers, t]);

  // Check health when custom servers change
  useEffect(() => {
    if (envConfig?.customMcpServers && envConfig.customMcpServers.length > 0) {
      checkAllServersHealth();
    }
  }, [envConfig?.customMcpServers, checkAllServersHealth]);

  // Test a single server connection (full test)
  const handleTestConnection = useCallback(async (server: CustomMcpServer) => {
    setTestingServers(prev => new Set(prev).add(server.id));

    try {
      const result = await window.electronAPI.testMcpConnection(server);
      if (result.success && result.data) {
        // Update health status based on test result
        setServerHealthStatus(prev => ({
          ...prev,
          [server.id]: {
            serverId: server.id,
            status: result.data?.success ? 'healthy' : 'unhealthy',
            message: result.data?.message,
            responseTime: result.data?.responseTime,
            checkedAt: new Date().toISOString(),
          }
        }));
      }
    } catch (_error) {
      setServerHealthStatus(prev => ({
        ...prev,
        [server.id]: {
          serverId: server.id,
          status: 'unhealthy',
          message: t('settings:mcp.connectionTestFailed'),
          checkedAt: new Date().toISOString(),
        }
      }));
    } finally {
      setTestingServers(prev => {
        const next = new Set(prev);
        next.delete(server.id);
        return next;
      });
    }
  }, [t]);

  // Resolve agent settings using the centralized utility
  // Resolution order: custom overrides -> selected profile's config -> global defaults
  const { phaseModels, phaseThinking, featureModels, featureThinking } = useResolvedAgentSettings(settings);

  // Get MCP server states for display
  const mcpServers = envConfig?.mcpServers || {};

  // Count enabled MCP servers
  const enabledCount = [
    mcpServers.context7Enabled !== false,
    settings.memoryEnabled !== false,
    mcpServers.linearMcpEnabled !== false && envConfig?.linearEnabled,
    mcpServers.electronEnabled,
    mcpServers.puppeteerEnabled,
    true, // app tools always enabled
  ].filter(Boolean).length;

  // Resolve model and thinking for an agent based on its settings source
  const getAgentModelConfig = useMemo(() => {
    return (config: AgentConfig): { model: string; thinking: ThinkingLevel } => {
      return resolveAgentModelConfig(config.settingsSource, { phaseModels, phaseThinking, featureModels, featureThinking });
    };
  }, [phaseModels, phaseThinking, featureModels, featureThinking]);

  const toggleCategory = (category: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  // Group agents by category
  const agentsByCategory = Object.entries(AGENT_CONFIGS).reduce(
    (acc, [id, config]) => {
      const category = config.category;
      if (!acc[category]) {
        acc[category] = [];
      }
      acc[category].push({ id, config });
      return acc;
    },
    {} as Record<string, Array<{ id: string; config: typeof AGENT_CONFIGS[keyof typeof AGENT_CONFIGS] }>>
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="border-b border-border p-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-muted">
            <Server className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-foreground">
                {selectedProject
                  ? t('settings:mcp.titleWithProject', { projectName: selectedProject.name })
                  : t('settings:mcp.title')}
              </h1>
            </div>
            <p className="text-sm text-muted-foreground">
              {selectedProject
                ? t('settings:mcp.description')
                : t('settings:mcp.descriptionNoProject')}
            </p>
          </div>
          {envConfig && (
            <div className="text-right">
              <span className="text-sm text-muted-foreground">{t('settings:mcp.serversEnabled', { count: enabledCount })}</span>
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-6 space-y-6">
          {/* No project selected message */}
          {!selectedProject && (
            <div className="rounded-lg border border-border bg-card p-6 text-center">
              <AlertCircle className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
              <h2 className="text-sm font-medium text-foreground mb-1">{t('settings:mcp.noProjectSelected')}</h2>
              <p className="text-sm text-muted-foreground">
                {t('settings:mcp.noProjectSelectedDescription')}
              </p>
            </div>
          )}

          {/* Project not initialized message */}
          {selectedProject && !selectedProject.autoBuildPath && (
            <div className="rounded-lg border border-border bg-card p-6 text-center">
              <Info className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
              <h2 className="text-sm font-medium text-foreground mb-1">{t('settings:mcp.projectNotInitialized')}</h2>
              <p className="text-sm text-muted-foreground">
                {t('settings:mcp.projectNotInitializedDescription')}
              </p>
            </div>
          )}

          {/* MCP Server Configuration */}
          {envConfig && (
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-medium text-foreground">{t('settings:mcp.configuration')}</h2>
                <span className="text-xs text-muted-foreground">
                  {t('settings:mcp.configurationHint')}
                </span>
              </div>

              <div className="space-y-4">
                {/* Context7 */}
                <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div className="flex items-center gap-3">
                    <Search className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <span className="text-sm font-medium">{t('settings:mcp.servers.context7.name')}</span>
                      <p className="text-xs text-muted-foreground">{t('settings:mcp.servers.context7.description')}</p>
                    </div>
                  </div>
                  <Switch
                    checked={mcpServers.context7Enabled !== false}
                    onCheckedChange={(checked) => updateMcpServer('context7Enabled', checked)}
                  />
                </div>

                {/* Memory */}
                <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div className="flex items-center gap-3">
                    <Brain className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <span className="text-sm font-medium">{t('settings:mcp.servers.memory.name')}</span>
                      <p className="text-xs text-muted-foreground">
                        {settings.memoryEnabled !== false
                          ? t('settings:mcp.servers.memory.description')
                          : t('settings:mcp.servers.memory.off')}
                      </p>
                    </div>
                  </div>
                  {/* Built in: no switch here — one place to turn it on or off */}
                  <span className="text-xs text-muted-foreground shrink-0">
                    {t('settings:mcp.servers.memory.managedInSettings')}
                  </span>
                </div>

                {/* Linear */}
                <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div className="flex items-center gap-3">
                    <ClipboardList className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <span className="text-sm font-medium">{t('settings:mcp.servers.linear.name')}</span>
                      <p className="text-xs text-muted-foreground">
                        {envConfig.linearEnabled
                          ? t('settings:mcp.servers.linear.description')
                          : t('settings:mcp.servers.linear.notConfigured')}
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={mcpServers.linearMcpEnabled !== false && envConfig.linearEnabled}
                    onCheckedChange={(checked) => updateMcpServer('linearMcpEnabled', checked)}
                    disabled={!envConfig.linearEnabled}
                  />
                </div>

                {/* Browser Automation Section */}
                <div className="pt-2">
                  <div className="flex items-center gap-2 mb-3">
                    <Info className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">
                      {t('settings:mcp.browserAutomation')}
                    </span>
                  </div>

                  {/* Electron */}
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <div className="flex items-center gap-3">
                      <Monitor className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <span className="text-sm font-medium">{t('settings:mcp.servers.electron.name')}</span>
                        <p className="text-xs text-muted-foreground">{t('settings:mcp.servers.electron.description')}</p>
                      </div>
                    </div>
                    <Switch
                      checked={mcpServers.electronEnabled === true}
                      onCheckedChange={(checked) => updateMcpServer('electronEnabled', checked)}
                    />
                  </div>

                  {/* Puppeteer */}
                  <div className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-3">
                      <Globe className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <span className="text-sm font-medium">{t('settings:mcp.servers.puppeteer.name')}</span>
                        <p className="text-xs text-muted-foreground">{t('settings:mcp.servers.puppeteer.description')}</p>
                      </div>
                    </div>
                    <Switch
                      checked={mcpServers.puppeteerEnabled === true}
                      onCheckedChange={(checked) => updateMcpServer('puppeteerEnabled', checked)}
                    />
                  </div>
                </div>

                {/* Vibe Teamlead (always enabled) */}
                <div className="flex items-center justify-between py-2 border-t border-border opacity-60">
                  <div className="flex items-center gap-3">
                    <ListChecks className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <span className="text-sm font-medium">{t('settings:mcp.servers.appTools.name')}</span>
                      <p className="text-xs text-muted-foreground">{t('settings:mcp.servers.appTools.description')} ({t('settings:mcp.alwaysEnabled')})</p>
                    </div>
                  </div>
                  <Switch checked={true} disabled />
                </div>

                {/* Custom MCP Servers Section */}
                <div className="pt-4 border-t border-border">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Terminal className="h-3 w-3 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground uppercase tracking-wider">
                        {t('settings:mcp.customServers')}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setEditingCustomServer(null); setShowCustomMcpDialog(true); }}
                      className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
                    >
                      <Plus className="h-3 w-3" />
                      {t('settings:mcp.addCustomServer')}
                    </button>
                  </div>

                  {(envConfig.customMcpServers?.length ?? 0) > 0 ? (
                    <div className="space-y-2">
                      {envConfig.customMcpServers?.map((server) => {
                        const health = serverHealthStatus[server.id];
                        const isTesting = testingServers.has(server.id);
                        const isChecking = health?.status === 'checking';

                        // Status indicator component
                        const StatusIndicator = () => {
                          if (isTesting || isChecking) {
                            return <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />;
                          }
                          switch (health?.status) {
                            case 'healthy':
                              return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
                            case 'needs_auth':
                              return <Lock className="h-3.5 w-3.5 text-amber-500" />;
                            case 'unhealthy':
                              return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
                            default:
                              return <Circle className="h-3.5 w-3.5 text-muted-foreground" />;
                          }
                        };

                        return (
                          <div
                            key={server.id}
                            className="flex items-center justify-between py-2 px-3 bg-muted/50 rounded-lg group"
                          >
                            <div className="flex items-center gap-3">
                              {/* Status indicator */}
                              <StatusIndicator />
                              {server.type === 'command' ? (
                                <Terminal className="h-4 w-4 text-muted-foreground" />
                              ) : (
                                <Globe className="h-4 w-4 text-muted-foreground" />
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium">{server.name}</span>
                                  {health?.responseTime && (
                                    <span className="text-[10px] text-muted-foreground">
                                      {health.responseTime}ms
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground truncate">
                                  {health?.message || (server.type === 'command'
                                    ? `${server.command} ${server.args?.join(' ') || ''}`
                                    : server.url)}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              {/* Test button - always visible */}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleTestConnection(server)}
                                disabled={isTesting}
                                className="h-7 px-2 text-xs"
                                title={t('settings:mcp.testConnectionTitle')}
                              >
                                {isTesting ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-3 w-3" />
                                )}
                                <span className="ml-1">{t('settings:mcp.testConnection')}</span>
                              </Button>
                              {/* Edit/Delete - show on hover */}
                              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  type="button"
                                  onClick={() => { setEditingCustomServer(server); setShowCustomMcpDialog(true); }}
                                  className="p-1.5 text-muted-foreground hover:text-foreground transition-colors"
                                  title={t('common:buttons.edit')}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteCustomServer(server.id)}
                                  className="p-1.5 text-muted-foreground hover:text-destructive transition-colors"
                                  title={t('common:buttons.delete')}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-3">
                      {t('settings:mcp.noCustomServers')}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Agent Categories */}
          {Object.entries(CATEGORIES).map(([categoryId, category]) => {
            const agents = agentsByCategory[categoryId] || [];
            if (agents.length === 0) return null;

            const isExpanded = expandedCategories.has(categoryId);
            const CategoryIcon = category.icon;

            return (
              <div key={categoryId} className="space-y-3">
                {/* Category Header */}
                <button
                  type="button"
                  onClick={() => toggleCategory(categoryId)}
                  className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                  <CategoryIcon className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">
                    {t(`settings:agentCategories.${categoryId}`)}
                  </h2>
                  <span className="text-xs text-muted-foreground">
                    ({t('settings:mcp.agentCount', { count: agents.length })})
                  </span>
                </button>

                {/* Agent Cards */}
                {isExpanded && (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pl-6">
                    {agents.map(({ id, config }) => {
                      const { model, thinking } = getAgentModelConfig(config);
                      return (
                        <AgentCard
                          key={id}
                          id={id}
                          config={config}
                          modelLabel={getModelLabel(model)}
                          thinkingLabel={thinkingLabel(t, thinking)}
                          overrides={envConfig?.agentMcpOverrides?.[id]}
                          mcpServerStates={envConfig?.mcpServers}
                          customServers={envConfig?.customMcpServers || []}
                          onAddMcp={handleAddMcp}
                          onRemoveMcp={handleRemoveMcp}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Custom MCP Server Dialog */}
      <CustomMcpDialog
        open={showCustomMcpDialog}
        onOpenChange={setShowCustomMcpDialog}
        server={editingCustomServer}
        existingIds={(envConfig?.customMcpServers || []).map(s => s.id)}
        onSave={handleSaveCustomServer}
      />
    </div>
  );
}
