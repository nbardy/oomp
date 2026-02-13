import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadAllConversations } from '../src/adapters/jsonl';

function writeJsonl(filePath: string, entries: unknown[]): void {
  const lines = entries.map((entry) => JSON.stringify(entry)).join('\n');
  fs.writeFileSync(filePath, `${lines}\n`, 'utf-8');
}

test('Codex spawned sub-agent session maps to parentConversationId', async () => {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cwv-codex-parent-'));
  const claudeProjectsDir = path.join(tmpRoot, 'claude-projects');
  const codexSessionsDir = path.join(tmpRoot, 'codex-sessions');
  const openCodeMessageDir = path.join(tmpRoot, 'opencode', 'message');
  const dayDir = path.join(codexSessionsDir, '2026', '02', '10');
  await fs.promises.mkdir(claudeProjectsDir, { recursive: true });
  await fs.promises.mkdir(dayDir, { recursive: true });
  await fs.promises.mkdir(openCodeMessageDir, { recursive: true });

  const parentSessionId = '11111111-1111-4111-8111-111111111111';
  const childSessionId = '22222222-2222-4222-8222-222222222222';
  const timestamp = '2026-02-10T12:27:33.000Z';

  const parentFile = path.join(dayDir, `rollout-2026-02-10T12-27-33-${parentSessionId}.jsonl`);
  writeJsonl(parentFile, [
    {
      timestamp,
      type: 'session_meta',
      payload: {
        id: parentSessionId,
        timestamp,
        cwd: '/tmp/project',
        originator: 'codex_cli_rs',
        cli_version: '0.98.0',
        source: 'cli',
        model_provider: 'openai',
      },
    },
    {
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Parent prompt',
      },
    },
    {
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'Parent response',
      },
    },
  ]);

  const childFile = path.join(dayDir, `rollout-2026-02-10T12-27-33-${childSessionId}.jsonl`);
  writeJsonl(childFile, [
    {
      timestamp,
      type: 'session_meta',
      payload: {
        id: childSessionId,
        timestamp,
        cwd: '/tmp/project',
        originator: 'codex_cli_rs',
        cli_version: '0.98.0',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentSessionId,
              depth: 1,
            },
          },
        },
        model_provider: 'openai',
      },
    },
    {
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Child prompt',
      },
    },
    {
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'Child response',
      },
    },
  ]);

  try {
    const { conversations } = await loadAllConversations(
      claudeProjectsDir,
      codexSessionsDir,
      openCodeMessageDir
    );

    const parentConversation = conversations.get(parentSessionId);
    const childConversation = conversations.get(childSessionId);

    assert.ok(parentConversation, 'expected parent conversation to load');
    assert.ok(childConversation, 'expected child conversation to load');
    assert.equal(parentConversation?.parentConversationId ?? null, null);
    assert.equal(childConversation?.parentConversationId, parentSessionId);
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
});
