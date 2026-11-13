/**
 * One agent on the Agent Tools screen: its model, its tools and its MCP servers.
 * Moved here whole from AgentTools.tsx.
 */
import { CheckCircle2, ChevronDown, ChevronRight, Circle, Globe, Plus, RotateCcw, Server, Terminal, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AgentMcpOverride, CustomMcpServer, ProjectEnvConfig } from '../../../shared/types';
import { useSettingsStore } from '../../stores/settings-store';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { AGENT_CONFIGS, ALL_MCP_SERVERS, BUILT_IN_SERVERS, CATEGORIES, MCP_SERVERS, } from './catalog';

export interface AgentCardProps {
  id: string;
  config: typeof AGENT_CONFIGS[keyof typeof AGENT_CONFIGS];
  modelLabel: string;
  thinkingLabel: string;
  overrides: AgentMcpOverride | undefined;
  mcpServerStates: ProjectEnvConfig['mcpServers'];
  customServers: CustomMcpServer[];
  onAddMcp: (agentId: string, mcpId: string) => void;
  onRemoveMcp: (agentId: string, mcpId: string) => void;
}

export function AgentCard({ id, config, modelLabel, thinkingLabel, overrides, mcpServerStates, customServers, onAddMcp, onRemoveMcp }: AgentCardProps) {
  const memoryOn = useSettingsStore((state) => state.settings.memoryEnabled !== false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const { t } = useTranslation(['settings']);
  const category = CATEGORIES[config.category as keyof typeof CATEGORIES];
  const CategoryIcon = category.icon;
  const agentLabel = t(`agents.${id}.label`);

  // Build combined MCP server info including custom servers
  const allMcpServers = useMemo(() => {
    const servers: Record<string, { name: string; description: string; icon: React.ElementType }> = {};
    for (const [serverId, server] of Object.entries(MCP_SERVERS)) {
      servers[serverId] = {
        ...server,
        name: t(`mcp.serverNames.${serverId}`, { defaultValue: server.name }),
        description: t(`mcp.serverDescriptions.${serverId}`),
      };
    }
    for (const custom of customServers) {
      servers[custom.id] = {
        name: custom.name,
        description: custom.description || (custom.type === 'command' ? `${custom.command} ${custom.args?.join(' ') || ''}` : custom.url || ''),
        icon: custom.type === 'command' ? Terminal : Globe,
      };
    }
    return servers;
  }, [customServers, t]);

  // Calculate effective MCPs: defaults + adds - removes, then filter by project-level MCP states
  const effectiveMcps = useMemo(() => {
    const defaultMcps = [...config.mcp_servers, ...(config.mcp_optional || [])];
    const added = overrides?.add || [];
    const removed = overrides?.remove || [];
    const combinedMcps = [...new Set([...defaultMcps, ...added])].filter(mcp => !removed.includes(mcp));

    // Filter out MCPs that are disabled at project level (custom servers are always enabled)
    return combinedMcps.filter(mcp => {
      if (mcp === 'memory') return memoryOn;
      if (!mcpServerStates) return true; // No project config, show all
      // Custom servers are always available if they exist
      if (customServers.some(s => s.id === mcp)) return true;
      switch (mcp) {
        case 'context7': return mcpServerStates.context7Enabled !== false;
        case 'linear': return mcpServerStates.linearMcpEnabled !== false;
        case 'electron': return mcpServerStates.electronEnabled !== false;
        case 'puppeteer': return mcpServerStates.puppeteerEnabled !== false;
        default: return true;
      }
    });
  }, [config, overrides, mcpServerStates, customServers, memoryOn]);

  // Check if an MCP is a custom addition (not in defaults)
  const isCustomAdd = (mcpId: string) => {
    const defaults = [...config.mcp_servers, ...(config.mcp_optional || [])];
    return !defaults.includes(mcpId) && (overrides?.add || []).includes(mcpId);
  };

  // Get removed MCPs (from defaults)
  const removedMcps = useMemo(() => {
    const defaults = [...config.mcp_servers, ...(config.mcp_optional || [])];
    return defaults.filter(mcp => (overrides?.remove || []).includes(mcp));
  }, [config, overrides]);

  // Get MCPs that can be added (not already in effective list) - includes custom servers
  const customServerIds = customServers.map(s => s.id);
  const allAvailableMcpIds = [...ALL_MCP_SERVERS, ...customServerIds];
  const availableMcps = allAvailableMcpIds.filter(
    mcp => !effectiveMcps.includes(mcp) && !removedMcps.includes(mcp) && !BUILT_IN_SERVERS.has(mcp)
  );

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden">
      {/* Header - clickable to expand */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors text-left"
      >
        <div className="p-2 rounded-lg bg-muted">
          <CategoryIcon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-medium text-sm text-foreground">{agentLabel}</h3>
            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-secondary text-secondary-foreground">
              {modelLabel}
            </span>
            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-secondary text-secondary-foreground">
              {thinkingLabel}
            </span>
          </div>
          <p className="text-xs text-muted-foreground truncate">{t(`agents.${id}.description`)}</p>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="text-xs">
            {t('mcp.mcpCount', { count: effectiveMcps.length })}
          </span>
          {isExpanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </div>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-border p-4 space-y-4 bg-muted/30">
          {/* MCP Servers */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {t('mcp.mcpServersHeading')}
              </h4>
              {availableMcps.length > 0 && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowAddDialog(true); }}
                  className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
                >
                  <Plus className="h-3 w-3" />
                  {t('mcp.addServer')}
                </button>
              )}
            </div>
            {effectiveMcps.length > 0 || removedMcps.length > 0 ? (
              <div className="space-y-2">
                {/* Active MCPs */}
                {effectiveMcps.map((server) => {
                  const serverInfo = allMcpServers[server];
                  const ServerIcon = serverInfo?.icon || Server;
                  const isAdded = isCustomAdd(server);
                  const canRemove = !BUILT_IN_SERVERS.has(server);

                  return (
                    <div key={server} className="flex items-center justify-between group">
                      <div className="flex items-center gap-2 text-sm">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                        <ServerIcon className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-medium">{serverInfo?.name || server}</span>
                        {isAdded && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded">
                            {t('mcp.added')}
                          </span>
                        )}
                      </div>
                      {canRemove && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); onRemoveMcp(id, server); }}
                          className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-destructive transition-all"
                          title={t('mcp.remove')}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}

                {/* Removed MCPs (grayed out with restore option) */}
                {removedMcps.map((server) => {
                  const serverInfo = allMcpServers[server];
                  const ServerIcon = serverInfo?.icon || Server;

                  return (
                    <div key={server} className="flex items-center justify-between group opacity-50">
                      <div className="flex items-center gap-2 text-sm line-through">
                        <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                        <ServerIcon className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-medium">{serverInfo?.name || server}</span>
                        <span className="text-[10px] text-muted-foreground no-underline">
                          ({t('mcp.removed')})
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onAddMcp(id, server); }}
                        className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-primary transition-all"
                        title={t('mcp.restore')}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('mcp.noMcpServers')}</p>
            )}
          </div>

          {/* Tools */}
          <div>
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              {t('mcp.availableTools')}
            </h4>
            {config.tools.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {config.tools.map((tool) => (
                  <span
                    key={tool}
                    className="px-2 py-1 bg-muted rounded text-xs font-mono"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('mcp.textOnly')}</p>
            )}
          </div>
        </div>
      )}

      {/* Add MCP Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('mcp.addMcpTo', { agent: agentLabel })}</DialogTitle>
            <DialogDescription>{t('mcp.addMcpDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            {availableMcps.length > 0 ? (
              availableMcps.map((mcpId) => {
                const server = allMcpServers[mcpId];
                const ServerIcon = server?.icon || Server;
                return (
                  <button
                    type="button"
                    key={mcpId}
                    onClick={() => { onAddMcp(id, mcpId); setShowAddDialog(false); }}
                    className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-muted transition-colors text-left"
                  >
                    <ServerIcon className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="font-medium text-sm">{server?.name || mcpId}</div>
                      <div className="text-xs text-muted-foreground">{server?.description}</div>
                    </div>
                  </button>
                );
              })
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">
                {t('mcp.allMcpsAdded')}
              </p>
            )}
            {/* Also show removed MCPs that can be restored */}
            {removedMcps.length > 0 && (
              <>
                <div className="border-t border-border my-2 pt-2">
                  <p className="text-xs text-muted-foreground mb-2">{t('mcp.restore')}:</p>
                </div>
                {removedMcps.map((mcpId) => {
                  const server = allMcpServers[mcpId];
                  const ServerIcon = server?.icon || Server;
                  return (
                    <button
                      type="button"
                      key={mcpId}
                      onClick={() => { onAddMcp(id, mcpId); setShowAddDialog(false); }}
                      className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-muted transition-colors text-left opacity-60"
                    >
                      <ServerIcon className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="font-medium text-sm">{server?.name || mcpId}</div>
                        <div className="text-xs text-muted-foreground">{server?.description}</div>
                      </div>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
