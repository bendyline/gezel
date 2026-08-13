import { type WorkspaceCommandIndex, visibleCatalogItems } from '@bendyline/gezel';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useShowWorkInProgressFeatures } from '../useShowWorkInProgressFeatures.js';
import {
  type CraftbookCompletionSpec,
  type McpToolCompletionSpec,
  clearTerminalCompletionData,
  setTerminalCompletionData,
} from './completion-data.js';

/**
 * Fetches + caches the terminal's completion sources for a project (workspace
 * command index, craftbooks, and — once wired — project-wide MCP tools) and
 * writes them into the module-level `completion-data` store keyed by projectId,
 * which the global monaco completion provider reads. Runs in the parent
 * (`TerminalComposer`) so it survives editor remounts and works even before the
 * monaco chunk lands. Mirrors `CommandsPanel`'s 30s status-poll pattern.
 */
export function useTerminalCompletionSources(projectId: string): void {
  const showWorkInProgressFeatures = useShowWorkInProgressFeatures();
  const [index, setIndex] = useState<WorkspaceCommandIndex | null>(null);
  const [craftbooks, setCraftbooks] = useState<CraftbookCompletionSpec[]>([]);
  const [mcpTools, setMcpTools] = useState<McpToolCompletionSpec[]>([]);
  const scannedAtRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    const loadIndex = async () => {
      try {
        const idx = await api.getProjectIndex(projectId);
        if (!cancelled) setIndex(idx);
      } catch {
        /* not indexed yet — a scan gets kicked below */
      }
    };

    const loadCraftbooks = async () => {
      try {
        const res = await api.listProjectCraftbooks(projectId);
        if (cancelled) return;
        setCraftbooks(
          visibleCatalogItems(res.items, showWorkInProgressFeatures).flatMap((it) => {
            const m = it.manifest as {
              kind?: string;
              id?: string;
              name?: string;
              description?: string;
              command?: string;
              paramSchema?: Record<string, unknown>;
            };
            if ((m.kind && m.kind !== 'craftbook-template') || !m.id) return [];
            return [
              {
                id: m.id,
                command: m.command ?? m.id,
                name: m.name,
                description: m.description,
                paramSchema: m.paramSchema,
              },
            ];
          }),
        );
      } catch {
        /* ignore */
      }
    };

    // Project-wide MCP tools (the full, non-role-filtered surface). Building the
    // bridge spawns gezel-mcp, so this can be slow on first call — degrade to
    // none on error / older daemons.
    const loadTools = async () => {
      try {
        const res = await api.listProjectTools(projectId);
        if (!cancelled) setMcpTools(res.tools);
      } catch {
        /* tools unavailable — leave empty */
      }
    };

    // Re-check craftbook applicability + index freshness every 30s; refetch the
    // full index only when scannedAt advances; kick a scan on cold projects.
    const tick = async () => {
      if (!cancelled) void loadCraftbooks();
      try {
        const status = await api.getProjectIndexStatus(projectId);
        if (cancelled) return;
        const next = status.meta?.scannedAt;
        if (next && next !== scannedAtRef.current) {
          scannedAtRef.current = next;
          await loadIndex();
        } else if (status.state === 'never') {
          await api.refreshProjectIndex(projectId).catch(() => {});
        }
      } catch {
        /* try again next tick */
      }
    };

    void loadIndex();
    void loadCraftbooks();
    void loadTools();
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [projectId, showWorkInProgressFeatures]);

  // Publish to the provider's store whenever a source changes.
  useEffect(() => {
    setTerminalCompletionData(projectId, { index, craftbooks, mcpTools });
  }, [projectId, index, craftbooks, mcpTools]);

  // Drop the slot on unmount / project switch.
  useEffect(() => () => clearTerminalCompletionData(projectId), [projectId]);
}
