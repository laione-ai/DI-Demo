// ============================================================
// Driving Agent — Session management.
//
// CRUD operations for driving_agent_sessions. Handles creation,
// loading, updating, expiry detection, and cleanup.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AgentSession,
  AgentState,
  AgentIntent,
  AgentSessionSlots,
} from '../types';

/** Session timeout in milliseconds (30 minutes). */
const SESSION_TIMEOUT_MS = 30 * 60_000;

/** Maximum number of LLM conversation turns stored per session. */
const MAX_SESSION_MESSAGES = 20;

/**
 * Load the active (non-completed, non-expired) session for a phone+account.
 */
export async function loadActiveSession(
  db: SupabaseClient,
  accountId: string,
  phone: string,
): Promise<AgentSession | null> {
  const now = new Date().toISOString();

  const { data, error } = await db
    .from('driving_agent_sessions')
    .select('*')
    .eq('account_id', accountId)
    .eq('phone', phone)
    .is('completed_at', null)
    .gt('expires_at', now)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[driving agent] loadActiveSession error:', error);
    return null;
  }

  return data as AgentSession | null;
}

/**
 * Create a new agent session for this phone+account.
 * Automatically completes any prior active sessions.
 */
export async function createSession(
  db: SupabaseClient,
  accountId: string,
  phone: string,
  conversationId: string,
  learnerId: string | null,
): Promise<AgentSession> {
  // Complete any prior active sessions
  await db
    .from('driving_agent_sessions')
    .update({
      state: 'expired',
      completed_at: new Date().toISOString(),
    })
    .eq('account_id', accountId)
    .eq('phone', phone)
    .is('completed_at', null);

  const expiresAt = new Date(Date.now() + SESSION_TIMEOUT_MS).toISOString();

  const { data, error } = await db
    .from('driving_agent_sessions')
    .insert({
      account_id: accountId,
      phone,
      conversation_id: conversationId,
      learner_id: learnerId,
      state: 'awaiting_intent',
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create agent session: ${error.message}`);
  }

  return data as AgentSession;
}

/**
 * Update an existing session's state, intent, slots, messages, etc.
 */
export async function updateSession(
  db: SupabaseClient,
  sessionId: string,
  updates: {
    state?: AgentState;
    intent?: AgentIntent | null;
    slots?: AgentSessionSlots;
    messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    turn_count?: number;
    learner_id?: string;
    last_message_id?: string;
    completed_at?: string;
  },
): Promise<void> {
  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (!updates.completed_at) {
    payload.expires_at = new Date(Date.now() + SESSION_TIMEOUT_MS).toISOString();
  }

  if (updates.state !== undefined) payload.state = updates.state;
  if (updates.intent !== undefined) payload.intent = updates.intent;
  if (updates.slots !== undefined) payload.slots = updates.slots;
  if (updates.turn_count !== undefined) payload.turn_count = updates.turn_count;
  if (updates.learner_id !== undefined) payload.learner_id = updates.learner_id;
  if (updates.last_message_id !== undefined) payload.last_message_id = updates.last_message_id;
  if (updates.completed_at !== undefined) payload.completed_at = updates.completed_at;

  if (updates.messages !== undefined) {
    payload.messages = updates.messages.slice(-MAX_SESSION_MESSAGES);
  }

  const { error } = await db
    .from('driving_agent_sessions')
    .update(payload)
    .eq('id', sessionId);

  if (error) {
    console.error('[driving agent] updateSession error:', error);
  }
}

/**
 * Mark a session as completed with a terminal state.
 */
export async function completeSession(
  db: SupabaseClient,
  sessionId: string,
  terminalState: 'completed' | 'expired' | 'handed_off',
): Promise<void> {
  await updateSession(db, sessionId, {
    state: terminalState,
    completed_at: new Date().toISOString(),
  });
}

export function isSessionExpired(session: AgentSession): boolean {
  return new Date(session.expires_at).getTime() < Date.now();
}

export function isMessageAlreadyProcessed(
  session: AgentSession,
  messageId: string,
): boolean {
  return session.last_message_id === messageId;
}
