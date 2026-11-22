import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentSession } from '../../types';
import type { ToolCallingMessage, ToolCallingResult } from '../types';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  session: null as unknown as Record<string, unknown> | null,
  generate: vi.fn(),
  completed: 0,
}));

vi.mock('@/lib/ai/config', () => ({
  loadAiConfig: vi.fn(async () => ({
    provider: 'openai',
    apiKey: 'k',
    model: 'm',
    handoffAgentId: null,
  })),
}));

vi.mock('../providers', () => ({ generateWithTools: h.generate }));

vi.mock('../../config', async () => {
  const actual = await vi.importActual<typeof import('../../config')>('../../config');
  return {
    ...actual,
    loadSchoolConfig: vi.fn(async () => ({
      id: 'cfg',
      account_id: 'acc',
      user_id: 'usr',
      school_name: 'LessonDesk Driving School',
      school_phone: null,
      school_address: 'Ealing, London',
      school_timezone: 'Europe/London',
      default_lesson_minutes: 60,
      demo_mode: true,
      agent_enabled: true,
    })),
  };
});

vi.mock('../../whatsapp-service', () => ({ createWhatsAppService: vi.fn(() => ({})) }));

vi.mock('../../lesson-service', async () => {
  const actual = await vi.importActual<typeof import('../../lesson-service')>('../../lesson-service');
  return {
    ...actual,
    countCompletedLessons: vi.fn(async () => ({ completedInDb: 0, baseCompleted: 0, totalCompleted: 0 })),
  };
});

// In-memory session store (the real session module talks to Supabase).
vi.mock('../session', () => ({
  loadActiveSession: vi.fn(async () => (h.session && !h.session.completed_at ? h.session : null)),
  createSession: vi.fn(async (_db: unknown, accountId: string, phone: string) => {
    h.session = {
      id: 'sess_1',
      account_id: accountId,
      phone,
      state: 'awaiting_intent',
      slots: {},
      messages: [],
      turn_count: 0,
      last_message_id: null,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      completed_at: null,
      learner_id: null,
    };
    return h.session;
  }),
  updateSession: vi.fn(async (_db: unknown, _id: string, updates: Record<string, unknown>) => {
    Object.assign(h.session as object, updates);
  }),
  completeSession: vi.fn(async (_db: unknown, _id: string, state: string) => {
    (h.session as Record<string, unknown>).state = state;
    (h.session as Record<string, unknown>).completed_at = new Date().toISOString();
  }),
  isSessionExpired: () => false,
  isMessageAlreadyProcessed: (s: { last_message_id: string | null }, id: string) => s.last_message_id === id,
}));

import { runAgentTurn } from '../engine';

/** In-memory learner + generic chainable Supabase mock. */
function makeDb(learner: Record<string, unknown>): SupabaseClient {
  const from = (table: string) => {
    const proxy: object = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            const data =
              table === 'learners' ? learner : table === 'instructors' || table === 'lessons' ? [] : null;
            return (resolve: (v: unknown) => void) => resolve({ data, error: null, count: 0 });
          }
          if (prop === 'update' || prop === 'insert') {
            return (payload: Record<string, unknown>) => {
              if (table === 'learners') Object.assign(learner, payload);
              return proxy;
            };
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  };
  return { from } as unknown as SupabaseClient;
}

const ctx = {
  accountId: 'acc',
  conversationId: 'conv',
  contactId: 'contact',
  phone: '+447700900301',
  configOwnerUserId: 'usr',
};

function freshLearner(): Record<string, unknown> {
  return {
    id: 'lrn_1',
    account_id: 'acc',
    phone: ctx.phone,
    full_name: ctx.phone, // WhatsApp-only: name is just the number
    name_confirmed: false,
    lessons_completed: 0,
    preferred_days: [],
    preferred_times: [],
    preferred_language: 'en',
  };
}

const text = (t: string): ToolCallingResult => ({ text: t, toolCalls: [], usage: null, done: true });
const toolCall = (name: string, args: Record<string, unknown>, id = 'call_1'): ToolCallingResult => ({
  text: '',
  toolCalls: [{ id, name, arguments: args }],
  usage: null,
  done: false,
});

const system = (m: ToolCallingMessage[]) => m[0].content ?? '';
const stepOf = (m: ToolCallingMessage[]) => Number(/CURRENT STEP: Step (\d)/.exec(system(m))?.[1] ?? 0);
const last = (m: ToolCallingMessage[]) => m[m.length - 1];

let n = 0;
const nextId = () => `wamid.${++n}`;

beforeEach(() => {
  h.session = null;
  h.generate.mockReset();
  n = 0;
});

// ---------------------------------------------------------------------------
// The script, end to end
// ---------------------------------------------------------------------------

describe("runAgentTurn — the Ahmed script, 9 messages in a row", () => {
  it('walks steps 1→6 in order, never repeats a step, and never hands off', async () => {
    // A stand-in for the model that does exactly what the prompt's CURRENT STEP says.
    // (This tests the engine + prompt plumbing, not the real LLM.)
    const savedFor: Array<[string, Record<string, unknown>]> = [
      ['My name is Ahmed', { full_name: 'Ahmed', age: 24, postcode: 'Ealing', licence_type: 'provisional', experience_level: 'around 5 lessons' }],
      ['Manual', { transmission_preference: 'manual', goal: 'pass my test', lessons_per_week: 2 }],
      ['Weekday evenings', { preferred_days: ['friday'], preferred_times: ['evening'] }],
    ];

    h.generate.mockImplementation(async (_provider: string, args: { messages: ToolCallingMessage[] }) => {
      const msgs = args.messages;
      const tail = last(msgs);
      if (tail.role === 'user') {
        const hit = savedFor.find(([needle]) => (tail.content ?? '').includes(needle));
        if (hit) return toolCall('update_learner_profile', hit[1]);
      }
      return text(`REPLY_FOR_STEP_${stepOf(msgs)}`);
    });

    const db = makeDb(freshLearner());

    const learnerMessages = [
      "Hi, I'm looking for driving lessons. Can you give me some information?",
      "I've had a few lessons before, but I haven't driven for about six months.",
      'English is fine.',
      "My name is Ahmed. I'm 24, live in Ealing, and I have a provisional licence. I've had around 5 lessons before.",
      'Manual. I want to pass my test and probably two lessons a week.',
      'Weekday evenings would be best, preferably Friday.',
      'Friday at 6pm works for me',
      'Yes please book it',
      'Thanks!',
    ];

    const replies: string[] = [];
    for (const msg of learnerMessages) {
      const res = await runAgentTurn(db, ctx, msg, nextId());
      expect(res.handedOff, `handed off on: "${msg}"`).toBeFalsy();
      replies.push(res.reply ?? '');
    }

    expect(replies).toEqual([
      'REPLY_FOR_STEP_1', // welcome + first question
      'REPLY_FOR_STEP_2', // language
      'REPLY_FOR_STEP_3', // name/age/postcode/licence/experience
      'REPLY_FOR_STEP_4', // manual/auto, goal, lessons per week
      'REPLY_FOR_STEP_5', // days/times
      'REPLY_FOR_STEP_6', // check availability + propose slots
      'REPLY_FOR_STEP_6', // stays on step 6 — never re-asks intake
      'REPLY_FOR_STEP_6',
      'REPLY_FOR_STEP_6',
    ]);
    expect(h.session?.turn_count).toBe(9);
    expect(h.session?.completed_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hand-offs
// ---------------------------------------------------------------------------

describe('runAgentTurn — hand-offs', () => {
  it('ignores a model-initiated transfer when the learner did not ask for a person', async () => {
    h.generate.mockImplementation(async (_p: string, args: { messages: ToolCallingMessage[] }) =>
      last(args.messages).role === 'user'
        ? toolCall('transfer_to_human', { reason: "can't find a slot" })
        : text('Let me keep helping — which evening works best?'),
    );

    const res = await runAgentTurn(makeDb(freshLearner()), ctx, 'Weekday evenings, preferably Friday', nextId());

    expect(res.handedOff).toBeFalsy();
    expect(res.reply).toBe('Let me keep helping — which evening works best?');
    expect(h.session?.completed_at).toBeNull();
  });

  it('does hand off when the learner explicitly asks for a person, and always sends a message', async () => {
    h.generate.mockImplementation(async () => toolCall('transfer_to_human', { reason: 'learner asked' }));

    const res = await runAgentTurn(makeDb(freshLearner()), ctx, 'Can I speak to a real person please?', nextId());

    expect(res.handedOff).toBe(true);
    expect(res.reply).toMatch(/passing you over/i);
    expect(h.session?.state).toBe('handed_off');
  });

  it('does not hand off when a learner asks for a test they are not eligible for', async () => {
    h.generate.mockImplementation(async (_p: string, args: { messages: ToolCallingMessage[] }) => {
      const prompt = system(args.messages);
      // The model sees the database verdict directly in its prompt.
      expect(prompt).toContain('NOT ELIGIBLE');
      expect(prompt).toContain("LATEST MESSAGE IS ABOUT A DRIVING TEST");
      return text('Our policy requires at least 5 lessons before a test — currently 0. Shall I book lessons?');
    });

    const res = await runAgentTurn(makeDb(freshLearner()), ctx, 'I want to book my driving test', nextId());
    expect(res.handedOff).toBeFalsy();
    expect(res.reply).toContain('at least 5 lessons');
  });
});

// ---------------------------------------------------------------------------
// Failures must not kill the conversation
// ---------------------------------------------------------------------------

describe('runAgentTurn — failures', () => {
  it('retries once on a transient LLM error and carries on normally', async () => {
    h.generate
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(text('Hey! Thanks for getting in touch 😊'));

    const res = await runAgentTurn(makeDb(freshLearner()), ctx, 'Hi', nextId());

    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(res.handedOff).toBeFalsy();
    expect(res.reply).toContain('Thanks for getting in touch');
  });

  it('apologises (no hand-off) when the LLM fails, and keeps the conversation intact for a retry', async () => {
    h.generate.mockRejectedValue(new Error('provider down'));

    const res = await runAgentTurn(makeDb(freshLearner()), ctx, 'Hi', nextId());

    expect(res.handedOff).toBeFalsy();
    expect(res.reply).toMatch(/hiccup/i);
    expect(h.session?.completed_at).toBeNull();
    expect(h.session?.messages).toEqual([]); // nothing half-saved
    expect((h.session?.slots as { llm_failures?: number }).llm_failures).toBe(1);
  });

  it('only hands off after 3 failed turns in a row — and a success resets the count', async () => {
    const db = makeDb(freshLearner());

    h.generate.mockRejectedValue(new Error('provider down'));
    expect((await runAgentTurn(db, ctx, 'Hi', nextId())).handedOff).toBeFalsy();
    expect((await runAgentTurn(db, ctx, 'Hi?', nextId())).handedOff).toBeFalsy();

    // success in between resets the counter
    h.generate.mockReset();
    h.generate.mockResolvedValue(text('Hey! 😊'));
    expect((await runAgentTurn(db, ctx, 'Hello', nextId())).handedOff).toBeFalsy();
    expect((h.session?.slots as { llm_failures?: number }).llm_failures).toBe(0);

    // three in a row now hands off
    h.generate.mockReset();
    h.generate.mockRejectedValue(new Error('provider down'));
    expect((await runAgentTurn(db, ctx, 'a', nextId())).handedOff).toBeFalsy();
    expect((await runAgentTurn(db, ctx, 'b', nextId())).handedOff).toBeFalsy();
    const third = await runAgentTurn(db, ctx, 'c', nextId());
    expect(third.handedOff).toBe(true);
    expect(third.reply).toMatch(/technical issue/i);
  });

  it('forces a plain-text reply instead of handing off when the model keeps calling tools', async () => {
    h.generate.mockImplementation(async (_p: string, args: { messages: ToolCallingMessage[] }) =>
      system(args.messages).includes('FINAL INSTRUCTION')
        ? text('Let me check Friday evenings for you 📅')
        : toolCall('list_instructors', {}, `call_${Math.random()}`),
    );

    const res = await runAgentTurn(makeDb(freshLearner()), ctx, 'Weekday evenings, preferably Friday', nextId());

    expect(res.handedOff).toBeFalsy();
    expect(res.reply).toBe('Let me check Friday evenings for you 📅');
  });

  it('forces a reply when the model returns an empty message (instead of staying silent)', async () => {
    h.generate
      .mockResolvedValueOnce(text(''))
      .mockResolvedValueOnce(text('Sorry about that — which days suit you best?'));

    const res = await runAgentTurn(makeDb(freshLearner()), ctx, 'Hi', nextId());

    expect(res.reply).toBe('Sorry about that — which days suit you best?');
    expect(res.handedOff).toBeFalsy();
  });

  it('never sends empty history to the model (Anthropic rejects empty text blocks)', async () => {
    h.session = {
      id: 'sess_1',
      account_id: 'acc',
      phone: ctx.phone,
      state: 'collecting_info',
      slots: {},
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: '' }, // a past empty reply
        { role: 'user', content: 'Hello?' },
        { role: 'assistant', content: 'Hey! 😊' },
      ],
      turn_count: 2,
      last_message_id: 'old',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      completed_at: null,
      learner_id: 'lrn_1',
    } satisfies Partial<AgentSession> as unknown as Record<string, unknown>;

    let seen: ToolCallingMessage[] = [];
    h.generate.mockImplementation(async (_p: string, args: { messages: ToolCallingMessage[] }) => {
      seen = args.messages;
      return text('ok');
    });

    await runAgentTurn(makeDb(freshLearner()), ctx, 'English is fine', nextId());

    expect(seen.filter((m) => m.role !== 'system').every((m) => (m.content ?? '').trim() !== '')).toBe(true);
  });
});
