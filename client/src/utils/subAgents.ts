import type { Conversation, SubAgent } from '@claude-web-view/shared';
import { getProviderMetadata } from '@claude-web-view/shared';
import { getLastMessageTime } from './time';

const OOMPA_TAG_RE = /^\[oompa(?::[^\]]+)?\]\s*/;

function firstUserSummary(messages: Conversation['messages']): string | null {
  const firstUser = messages.find((message) => message.role === 'user');
  if (!firstUser) return null;

  const normalized = firstUser.content.replace(OOMPA_TAG_RE, '').trim().replace(/\s+/g, ' ');

  if (!normalized) return null;
  return normalized.length > 90 ? `${normalized.slice(0, 87)}...` : normalized;
}

function lastMessageSummary(messages: Conversation['messages']): string | undefined {
  if (messages.length === 0) return undefined;
  const last = messages[messages.length - 1]?.content?.trim();
  if (!last) return undefined;
  const normalized = last.replace(/\s+/g, ' ');
  return normalized.length > 90 ? `${normalized.slice(0, 87)}...` : normalized;
}

function projectChildConversationToSubAgent(child: Conversation): SubAgent {
  const startedAt = new Date(child.createdAt);
  const completedAt = child.isRunning
    ? undefined
    : (getLastMessageTime(child.messages) ?? startedAt);
  const roleLabel = getProviderMetadata(child.provider).label;
  const description = firstUserSummary(child.messages) ?? `${roleLabel} spawned session`;

  return {
    id: `session:${child.id}`,
    description: `[${roleLabel}] ${description}`,
    status: child.isRunning ? 'running' : 'completed',
    toolUses: 0,
    tokens: 0,
    currentAction: child.isRunning ? (lastMessageSummary(child.messages) ?? 'Running...') : 'Done',
    startedAt,
    completedAt,
  };
}

/**
 * Build one unified sub-agent list for header display.
 * Includes native provider sub-agents (Task tool stream) + Codex spawned child sessions.
 */
export function buildUnifiedSubAgents(
  conversation: Conversation,
  allConversations: Iterable<Conversation>
): SubAgent[] {
  const merged: SubAgent[] = [...conversation.subAgents];

  for (const candidate of allConversations) {
    if (candidate.parentConversationId !== conversation.id) continue;
    merged.push(projectChildConversationToSubAgent(candidate));
  }

  merged.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
  return merged;
}
