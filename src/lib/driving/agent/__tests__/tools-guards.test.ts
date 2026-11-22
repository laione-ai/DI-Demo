import { describe, it, expect, vi } from 'vitest';
import { executeTool, type ToolExecutionContext } from '../tools';
import type { DrivingSchoolConfig } from '../../types';

/** Chainable query mock: every method returns itself; awaiting resolves to `result`. */
function chain(result: Record<string, unknown>): unknown {
  const proxy: object = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result);
        return () => proxy;
      },
    },
  );
  return proxy;
}

const config: DrivingSchoolConfig = {
  id: 'cfg_1',
  account_id: 'acc_1',
  user_id: 'usr_1',
  school_name: 'LessonDesk Driving School',
  school_phone: null,
  school_address: null,
  school_timezone: 'Europe/London',
  reminder_initial_minutes: 720,
  reminder_final_minutes: 60,
  reminder_followup_interval: 180,
  default_lesson_minutes: 60,
  demo_mode: true,
  agent_enabled: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function ctxWith(completed: number, inboundText?: string): ToolExecutionContext {
  const db = {
    from: vi.fn((table: string) => {
      if (table === 'learners') return chain({ data: { lessons_completed: completed }, error: null });
      if (table === 'lessons') return chain({ count: 0, data: null, error: null });
      return chain({ data: null, error: null });
    }),
  } as unknown as ToolExecutionContext['db'];

  return {
    db,
    accountId: 'acc_1',
    userId: 'usr_1',
    phone: '+447700900201',
    learnerId: 'lrn_1',
    config,
    conversationId: 'conv_1',
    waMessageId: 'wam_1',
    waService: { sendInteractiveButtons: vi.fn(), sendTextMessage: vi.fn(), sendReaction: vi.fn() },
    inboundText,
  };
}

const slot = '2026-12-04T18:00:00.000Z';

describe('create_booking — the 5-lesson gate cannot be bypassed', () => {
  it('blocks lesson_type mock_test with < 5 lessons', async () => {
    const r = await executeTool(
      { id: 'c1', name: 'create_booking', arguments: { instructor_id: 'i1', starts_at: slot, lesson_type: 'mock_test' } },
      ctxWith(2),
    );
    expect(JSON.parse(r.result.content).error).toContain('minimum of 5 completed lessons');
    expect(r.lesson).toBeUndefined();
  });

  it('blocks a "standard" booking whose notes say it is for a driving test', async () => {
    const r = await executeTool(
      {
        id: 'c2',
        name: 'create_booking',
        arguments: { instructor_id: 'i1', starts_at: slot, lesson_type: 'standard', notes: 'this is for my driving test' },
      },
      ctxWith(2),
    );
    expect(JSON.parse(r.result.content).error).toContain('minimum of 5 completed lessons');
  });

  it('does not block an ordinary lesson for someone with 0 lessons (reaches the booking step)', async () => {
    const r = await executeTool(
      { id: 'c3', name: 'create_booking', arguments: { instructor_id: 'i1', starts_at: slot, lesson_type: 'standard' } },
      ctxWith(0),
    );
    // It gets past the gate; the mock DB then fails inside createLesson, which is not the gate error.
    expect(JSON.parse(r.result.content).error ?? '').not.toContain('minimum of 5 completed lessons');
  });
});

describe('check_test_eligibility', () => {
  it('reports how many more lessons are needed', async () => {
    const r = await executeTool({ id: 'e1', name: 'check_test_eligibility', arguments: {} }, ctxWith(3));
    const parsed = JSON.parse(r.result.content);
    expect(parsed.eligible).toBe(false);
    expect(parsed.lessons_still_needed).toBe(2);
    expect(parsed.message).toContain('Do NOT book the test');
  });

  it('is eligible at exactly 5', async () => {
    const r = await executeTool({ id: 'e2', name: 'check_test_eligibility', arguments: {} }, ctxWith(5));
    expect(JSON.parse(r.result.content).eligible).toBe(true);
  });
});

describe('transfer_to_human — only when the learner asks', () => {
  const call = { id: 't1', name: 'transfer_to_human', arguments: { reason: 'stuck' } };

  it.each([
    'Weekday evenings, preferably Friday',
    'English is fine.',
    'I want to book my driving test',
  ])('refuses to hand off on: %s', async (text) => {
    const r = await executeTool(call, ctxWith(0, text));
    expect(r.handoff).toBeUndefined();
    expect(JSON.parse(r.result.content).success).toBe(false);
  });

  it('hands off when the learner asks for a person', async () => {
    const r = await executeTool(call, ctxWith(0, 'Can I speak to a real person please?'));
    expect(r.handoff).toBe(true);
  });

  it('hands off on a complaint', async () => {
    const r = await executeTool(call, ctxWith(0, 'I want to make a complaint'));
    expect(r.handoff).toBe(true);
  });
});
