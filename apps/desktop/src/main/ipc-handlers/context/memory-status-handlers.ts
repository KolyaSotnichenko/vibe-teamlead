
import type { BrowserWindow } from 'electron';
import type { MemorySystemStatus } from '../../../shared/types';
import { getMemoryService, getEmbeddingProvider } from './memory-service-factory';

/**
 * Build memory system status by probing the libSQL database and embedding service.
 * Gracefully returns unavailable status if initialization fails.
 */
export async function buildMemoryStatus(): Promise<MemorySystemStatus> {
  try {
    await getMemoryService();
    // If we got a service instance the DB and embedding layer are up
    const embeddingProvider = getEmbeddingProvider() ?? 'unknown';

    return {
      enabled: true,
      available: true,
      embeddingProvider,
      ...(embeddingProvider === 'none' && {
        reason:
          'No embedding provider found. Install Ollama with an embedding model or set OPENAI_API_KEY.',
      }),
    };
  } catch {
    return {
      enabled: false,
      available: false,
      reason: 'Memory service initialization failed',
    };
  }
}

/**
 * Register memory status handlers
 */
export function registerMemoryStatusHandlers(
  _getMainWindow: () => BrowserWindow | null
): void {
}
