/**
 * Gemini CLI Provider
 *
 * Handles spawning the Google Gemini CLI.
 *
 * Streaming:
 * - Uses `--output-format stream-json` for real-time stdout streaming.
 * - This provides immediate UI feedback while disk persistence runs in parallel.
 * - NOTE: Empirical testing confirms Gemini CLI only writes the session JSON
 *   to disk at the very end of a turn, making stdout streaming mandatory.
 *
 * Session behavior:
 * - Gemini manages sessions by working directory, not by session ID.
 * - Resume always uses `--resume latest` regardless of sessionId.
 * - The sessionId parameter is still used for server-side tracking.
 *
 * Persistence:
 * - Gemini CLI writes session files to ~/.gemini/tmp/{project}/chats/session-*.json
 * - The server's file poller also reads these (see jsonl.ts Gemini adapter).
 *
 * Prompt delivery:
 * - Delivered via CLI flag -p (headless mode).
 */

import type { ModelInfo } from '@claude-web-view/shared';
import { buildCommand } from '@nbardy/agent-cli';
import type { Provider, ProviderEvent, SpawnConfig } from './index';

const geminiProvider: Provider = {
  name: 'gemini',

  listModels(): ModelInfo[] {
    return [
      { id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview', isDefault: true },
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5-pro', isDefault: false },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5-flash', isDefault: false },
      { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0-flash', isDefault: false },
    ];
  },

  getSpawnConfig(
    sessionId: string,
    workingDir: string,
    resume = false,
    modelId?: string,
    prompt?: string
  ): SpawnConfig {
    // Command building delegated to @nbardy/agent-cli.
    // Gemini resumes by CWD (--resume latest), not by session ID.
    // harness uses --output-format stream-json by default now.
    const spec = buildCommand('gemini', {
      model: modelId,
      prompt,
      sessionId,
      resume,
      bypassPermissions: true, // adds --yolo
      extraArgs: ['--output-format', 'stream-json'],
    });

    return {
      command: spec.argv[0],
      args: spec.argv.slice(1),
      options: {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
      stdin: spec.stdin,
      stdout: spec.stdout,
    };
  },

  getSingleShotConfig(prompt: string): SpawnConfig {
    return {
      command: 'gemini',
      args: ['-p', prompt, '-y'],
      options: {},
      stdin: 'close',
      stdout: 'text',
    };
  },

  /**
   * Parse Gemini CLI --output-format stream-json output.
   * Format:
   *   {"type":"init", ...}
   *   {"type":"message","role":"assistant","content":"...", "delta":true}
   *   {"type":"result","status":"success", ...}
   */
  parseOutput(json: unknown): ProviderEvent {
    const obj = json as Record<string, unknown>;

    switch (obj.type) {
      case 'init':
        return { type: 'message_start' };

      case 'message':
        if (obj.role === 'assistant' && typeof obj.content === 'string') {
          return { type: 'text_delta', text: obj.content };
        }
        return { type: 'message_start' };

      case 'result':
        if (obj.status === 'success') {
          return { type: 'message_complete' };
        }
        return { type: 'message_start' };

      default:
        return { type: 'message_start' };
    }
  },
};

export default geminiProvider;
