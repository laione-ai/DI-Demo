import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DRIVING_TOOLS, executeTool, type ToolExecutionContext } from '../tools';
import type { DrivingSchoolConfig, Instructor, Learner } from '../../types';

/**
 * Chainable query-builder mock: every method (select/eq/or/...) returns the same
 * object, and awaiting it resolves to `result`. Keeps tests independent of the
 * exact filters the service chains onto a query.
 */
function chain(result: Record<string, unknown>): unknown {
  const proxy: object = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => void) => resolve(result);
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}

describe('Driving Agent Tools', () => {
  it('registers all required driving tools', () => {
    const toolNames = DRIVING_TOOLS.map((t) => t.name);
    expect(toolNames).toContain('list_instructors');
    expect(toolNames).toContain('get_instructor_availability');
    expect(toolNames).toContain('get_my_lessons');
    expect(toolNames).toContain('update_learner_profile');
    expect(toolNames).toContain('check_test_eligibility');
    expect(toolNames).toContain('create_booking');
    expect(toolNames).toContain('cancel_booking');
    expect(toolNames).toContain('reschedule_booking');
    expect(toolNames).toContain('transfer_to_human');
    expect(toolNames).toContain('react_to_message');
  });

  describe('check_test_eligibility', () => {
    it('returns ineligible when learner has completed fewer than 5 lessons', async () => {
      const mockDb = {
        from: vi.fn((table: string) => {
          if (table === 'learners') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { lessons_completed: 3 },
                error: null,
              }),
            };
          }
          if (table === 'lessons') {
            return chain({ count: 0 });
          }
          return {};
        }),
      } as unknown as ToolExecutionContext['db'];

      const mockCtx: ToolExecutionContext = {
        db: mockDb,
        accountId: 'acc_123',
        userId: 'usr_123',
        phone: '+447700900201',
        learnerId: 'lrn_123',
        config: {
          id: 'cfg_1',
          account_id: 'acc_123',
          user_id: 'usr_123',
          school_name: 'LessonDesk Driving School',
          school_phone: '+447700900000',
          school_address: 'London, UK',
          school_timezone: 'Europe/London',
          reminder_initial_minutes: 720,
          reminder_final_minutes: 60,
          reminder_followup_interval: 180,
          default_lesson_minutes: 60,
          demo_mode: true,
          agent_enabled: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        conversationId: 'conv_123',
        waMessageId: 'wam_123',
        waService: {
          sendInteractiveButtons: vi.fn(),
          sendTextMessage: vi.fn(),
          sendReaction: vi.fn(),
        },
      };

      const result = await executeTool(
        {
          id: 'call_test_1',
          name: 'check_test_eligibility',
          arguments: {},
        },
        mockCtx,
      );

      const parsed = JSON.parse(result.result.content);
      expect(parsed.eligible).toBe(false);
      expect(parsed.completed_lessons).toBe(3);
      expect(parsed.required_lessons).toBe(5);
      expect(parsed.message).toContain('at least 5 completed lessons');
    });

    it('returns eligible when learner has completed 5 or more lessons', async () => {
      const mockDb = {
        from: vi.fn((table: string) => {
          if (table === 'learners') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { lessons_completed: 6 },
                error: null,
              }),
            };
          }
          if (table === 'lessons') {
            return chain({ count: 6 });
          }
          return {};
        }),
      } as unknown as ToolExecutionContext['db'];

      const mockCtx: ToolExecutionContext = {
        db: mockDb,
        accountId: 'acc_123',
        userId: 'usr_123',
        phone: '+447700900202',
        learnerId: 'lrn_456',
        config: {
          id: 'cfg_1',
          account_id: 'acc_123',
          user_id: 'usr_123',
          school_name: 'LessonDesk Driving School',
          school_phone: '+447700900000',
          school_address: 'London, UK',
          school_timezone: 'Europe/London',
          reminder_initial_minutes: 720,
          reminder_final_minutes: 60,
          reminder_followup_interval: 180,
          default_lesson_minutes: 60,
          demo_mode: true,
          agent_enabled: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        conversationId: 'conv_123',
        waMessageId: 'wam_123',
        waService: {
          sendInteractiveButtons: vi.fn(),
          sendTextMessage: vi.fn(),
          sendReaction: vi.fn(),
        },
      };

      const result = await executeTool(
        {
          id: 'call_test_2',
          name: 'check_test_eligibility',
          arguments: {},
        },
        mockCtx,
      );

      const parsed = JSON.parse(result.result.content);
      expect(parsed.eligible).toBe(true);
      expect(parsed.completed_lessons).toBe(6);
      expect(parsed.required_lessons).toBe(5);
    });
  });

  describe('create_booking with mock_test', () => {
    it('blocks mock test booking if learner has fewer than 5 lessons completed', async () => {
      const mockDb = {
        from: vi.fn((table: string) => {
          if (table === 'learners') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { lessons_completed: 2 },
                error: null,
              }),
            };
          }
          if (table === 'lessons') {
            return chain({ count: 2 });
          }
          return {};
        }),
      } as unknown as ToolExecutionContext['db'];

      const mockCtx: ToolExecutionContext = {
        db: mockDb,
        accountId: 'acc_123',
        userId: 'usr_123',
        phone: '+447700900201',
        learnerId: 'lrn_123',
        config: {
          id: 'cfg_1',
          account_id: 'acc_123',
          user_id: 'usr_123',
          school_name: 'LessonDesk Driving School',
          school_phone: '+447700900000',
          school_address: 'London, UK',
          school_timezone: 'Europe/London',
          reminder_initial_minutes: 720,
          reminder_final_minutes: 60,
          reminder_followup_interval: 180,
          default_lesson_minutes: 60,
          demo_mode: true,
          agent_enabled: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        conversationId: 'conv_123',
        waMessageId: 'wam_123',
        waService: {
          sendInteractiveButtons: vi.fn(),
          sendTextMessage: vi.fn(),
          sendReaction: vi.fn(),
        },
      };

      const result = await executeTool(
        {
          id: 'call_book_mock',
          name: 'create_booking',
          arguments: {
            instructor_id: 'inst_1',
            starts_at: '2026-03-25T14:00:00Z',
            lesson_type: 'mock_test',
          },
        },
        mockCtx,
      );

      const parsed = JSON.parse(result.result.content);
      expect(parsed.error).toContain('minimum of 5 completed lessons is required');
    });
  });
});
