/**
 * Gemini CLI Provider
 *
 * Handles spawning the Google Gemini CLI. Data is read from disk, not stdout.
 *
 * Session behavior:
 * - Gemini manages sessions by working directory, not by session ID.
 * - Resume always uses `--resume latest` regardless of sessionId.
 * - The sessionId parameter is still used for server-side tracking.
 *
 * Persistence:
 * - Gemini CLI writes session files to ~/.gemini/tmp/{project}/chats/session-*.json
 * - The server's file poller reads these (see jsonl.ts Gemini adapter).
 * - parseOutput is minimal — stdout is not the primary data path.
 *
 * Prompt delivery:
 * - Prompt is read from stdin (server writes content + '\n' then closes).
 */

import type { ModelInfo } from '@claude-web-view/shared';
import { buildCommand } from '@nbardy/agent-cli';
import type { Provider, ProviderEvent, SpawnConfig } from './index';

const geminiProvider: Provider = {
  name: 'gemini',

  listModels(): ModelInfo[] {
    return [
      { id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview', isDefault: true },
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', isDefault: false },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', isDefault: false },
      { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', isDefault: false },
    ];
  },

  getSpawnConfig(
    sessionId: string,
    workingDir: string,
    resume = false,
    modelId?: string
  ): SpawnConfig {
    // Command building delegated to @nbardy/agent-cli.
    // Gemini resumes by CWD (--resume latest), not by session ID.
    // Prompt is delivered via stdin — server writes content + '\n' then closes.
    // No --output-format flag: data comes from disk, not stdout streaming.
    // -y: YOLO mode — auto-approve all tool confirmations.
    const spec = buildCommand('gemini', {
      model: modelId,
      sessionId,
      resume,
      extraArgs: ['-y'],
    });

    return {
      command: spec.argv[0],
      args: spec.argv.slice(1),
      options: {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    };
  },

  getSingleShotConfig(prompt: string): SpawnConfig {
    return {
      command: 'gemini',
      args: ['-p', prompt, '-y'],
      options: {},
    };
  },

  // Gemini data comes from disk polling, not stdout.
  // parseOutput exists only to satisfy the Provider interface.
  // The server may still pipe stdout; treat everything as a no-op.
  parseOutput(_json: unknown): ProviderEvent {
    return { type: 'message_start' };
  },
};

export default geminiProvider;
