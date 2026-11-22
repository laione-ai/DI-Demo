// ============================================================
// Driving Agent — Tool definitions and server-side executors.
//
// Each tool:
//   1. Has a JSON Schema definition (for the LLM)
//   2. Has a server-side executor (calls real service functions)
//   3. Enforces ownership (learners can only view/modify their own data)
//   4. Enforces compliance rules (e.g., minimum 5 completed lessons
//      before booking a driving test/mock test)
//
// The LLM never writes to the database directly.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolDefinition, ToolResult, ToolCall } from './types';
import type { DrivingWhatsAppService } from '../whatsapp-service';
import type { DrivingSchoolConfig, Lesson } from '../types';
import {
  createLesson,
  transitionLesson,
  listLessons,
  countCompletedLessons,
} from '../lesson-service';
import {
  getAvailableSlots,
  getNextAvailableDates,
} from '../availability-service';
import { commitReschedule } from '../reschedule';
import { formatInSchoolTimezone, getDateInTimezone } from '../config';
import { REQUIRED_LESSONS_FOR_TEST, isTestBooking, wantsHuman } from './guards';

// -------------------------------------------------------
// Tool definitions (JSON Schemas for the LLM)
// -------------------------------------------------------

export const DRIVING_TOOLS: ToolDefinition[] = [
  {
    name: 'list_instructors',
    description:
      'List all active driving instructors at this school with their transmission type (manual/automatic/both) and service areas (postcodes).',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_instructor_availability',
    description:
      'Get available driving lesson slots for a specific instructor on upcoming dates. Always call this to check real availability before offering times to the learner.',
    parameters: {
      type: 'object',
      properties: {
        instructor_id: {
          type: 'string',
          description: "The instructor's ID",
        },
        from_date: {
          type: 'string',
          description: 'Start date YYYY-MM-DD (optional, defaults to tomorrow)',
        },
        to_date: {
          type: 'string',
          description: 'End date YYYY-MM-DD (optional, defaults to 7 days from from_date)',
        },
      },
      required: ['instructor_id'],
    },
  },
  {
    name: 'get_my_lessons',
    description:
      "Get the learner's own upcoming lessons. Only returns lessons belonging to the sending phone number.",
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'update_learner_profile',
    description:
      "Save or update the learner's details collected during intake (name, age, postcode, licence status, previous experience, transmission preference, goal, schedule preferences).",
    parameters: {
      type: 'object',
      properties: {
        full_name: { type: 'string', description: "The learner's full name" },
        age: { type: 'integer', description: "The learner's age" },
        postcode: { type: 'string', description: "Postcode or area where learner lives" },
        licence_type: {
          type: 'string',
          enum: ['provisional', 'full'],
          description: 'Type of driving licence held',
        },
        experience_level: {
          type: 'string',
          description: 'Summary of previous driving experience',
        },
        transmission_preference: {
          type: 'string',
          enum: ['manual', 'automatic'],
          description: 'Manual or automatic preference',
        },
        goal: {
          type: 'string',
          description: 'Learner goal (e.g., pass test, confidence building)',
        },
        preferred_days: {
          type: 'array',
          items: { type: 'string' },
          description: 'Preferred days of the week',
        },
        preferred_times: {
          type: 'array',
          items: { type: 'string' },
          description: 'Preferred times of day (mornings, evenings, weekends)',
        },
        lessons_per_week: {
          type: 'integer',
          description: 'Desired lessons per week',
        },
        preferred_language: {
          type: 'string',
          description: 'Preferred language of communication',
        },
      },
      required: [],
    },
  },
  {
    name: 'check_test_eligibility',
    description:
      'Look up the learner in the database and check whether they have completed at least 5 driving LESSONS (completed tests do not count) before they can book a driving test or mock test. Call this whenever the learner asks about a driving test or mock test.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_booking',
    description:
      "Book a driving LESSON (standard, intensive, refresher, first_lesson) or a driving TEST / mock test (lesson_type: mock_test). A test is NOT a lesson: for any driving test or mock test you MUST use lesson_type 'mock_test', and the system will refuse it unless the learner has completed at least 5 driving lessons.",
    parameters: {
      type: 'object',
      properties: {
        instructor_id: { type: 'string', description: "The instructor's ID" },
        starts_at: {
          type: 'string',
          description: 'ISO 8601 UTC datetime of the slot',
        },
        duration_minutes: {
          type: 'integer',
          description: 'Optional, defaults to 60 minutes',
        },
        lesson_type: {
          type: 'string',
          enum: ['standard', 'intensive', 'mock_test', 'refresher', 'first_lesson'],
          description: 'Type of lesson being booked',
        },
        notes: {
          type: 'string',
          description: 'Optional notes or pickup location details',
        },
      },
      required: ['instructor_id', 'starts_at'],
    },
  },
  {
    name: 'cancel_booking',
    description:
      'Cancel an existing driving lesson. The learner must confirm before calling this.',
    parameters: {
      type: 'object',
      properties: {
        lesson_id: { type: 'string', description: 'The lesson ID' },
        reason: {
          type: 'string',
          description: 'Optional cancellation reason',
        },
      },
      required: ['lesson_id'],
    },
  },
  {
    name: 'reschedule_booking',
    description:
      'Reschedule an existing driving lesson to a new date and time. Call get_instructor_availability first to verify the slot is open.',
    parameters: {
      type: 'object',
      properties: {
        lesson_id: { type: 'string', description: 'The lesson ID' },
        new_starts_at: {
          type: 'string',
          description: 'ISO 8601 UTC datetime of the new slot',
        },
        new_instructor_id: {
          type: 'string',
          description: 'Optional: only if the learner wants to switch instructors',
        },
      },
      required: ['lesson_id', 'new_starts_at'],
    },
  },
  {
    name: 'transfer_to_human',
    description:
      "Hand this conversation over to a human. ONLY use when the learner has explicitly asked to speak to a person, raised a formal complaint, or reported a safety issue. Never use it because the chat is long, you are unsure, no slots were found, or a tool failed — keep helping instead. The system rejects hand-offs the learner did not ask for.",
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Brief reason for the handoff',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'react_to_message',
    description:
      'React to the learner message with a single emoji. Use sparingly for quick acknowledgment (e.g. 👍, 🚗, ✅).',
    parameters: {
      type: 'object',
      properties: {
        emoji: {
          type: 'string',
          description: 'Emoji to react with',
        },
      },
      required: ['emoji'],
    },
  },
];

// -------------------------------------------------------
// Tool execution context
// -------------------------------------------------------

export interface ToolExecutionContext {
  db: SupabaseClient;
  accountId: string;
  userId: string;
  phone: string;
  learnerId: string | null;
  config: DrivingSchoolConfig;
  conversationId: string;
  waMessageId: string;
  waService: DrivingWhatsAppService;
  /** The learner's latest inbound message (used to validate hand-off requests). */
  inboundText?: string;
}

// -------------------------------------------------------
// Server-side tool executor
// -------------------------------------------------------

export async function executeTool(
  toolCall: ToolCall,
  ctx: ToolExecutionContext,
): Promise<{
  result: ToolResult;
  handoff?: boolean;
  handoffReason?: string;
  lesson?: Lesson;
}> {
  const { db, accountId, userId, phone, learnerId, config } = ctx;
  const args = toolCall.arguments;
  const tz = config.school_timezone || 'Europe/London';

  try {
    switch (toolCall.name) {
      // ====================================================
      // list_instructors
      // ====================================================
      case 'list_instructors': {
        const { data: instructors, error } = await db
          .from('instructors')
          .select('id, full_name, transmission_type, service_areas, badge_reference, badge_verified')
          .eq('account_id', accountId)
          .eq('is_active', true)
          .order('full_name');

        if (error) throw error;

        const annotated = await Promise.all(
          (instructors ?? []).map(async (inst) => {
            try {
              const nextDates = await getNextAvailableDates(
                db,
                accountId,
                inst.id,
                tz,
                1,
                config.default_lesson_minutes || 60,
              );
              return {
                id: inst.id,
                name: inst.full_name,
                transmission: inst.transmission_type,
                service_areas: inst.service_areas,
                badge: inst.badge_verified ? inst.badge_reference : undefined,
                next_available_date: nextDates[0] ?? null,
              };
            } catch {
              return {
                id: inst.id,
                name: inst.full_name,
                transmission: inst.transmission_type,
                service_areas: inst.service_areas,
                next_available_date: null,
              };
            }
          }),
        );

        return {
          result: {
            tool_call_id: toolCall.id,
            name: toolCall.name,
            content: JSON.stringify({ instructors: annotated }),
          },
        };
      }

      // ====================================================
      // get_instructor_availability
      // ====================================================
      case 'get_instructor_availability': {
        const instructorId = args.instructor_id as string;
        if (!instructorId) {
          return errorResult(toolCall, 'instructor_id is required');
        }

        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const fromDate = (args.from_date as string) ?? getDateInTimezone(tomorrow, tz);
        const toDateDefault = new Date(new Date(fromDate + 'T00:00:00Z'));
        toDateDefault.setDate(toDateDefault.getDate() + 6);
        const toDate = (args.to_date as string) ?? getDateInTimezone(toDateDefault, tz);

        const availability = await getAvailableSlots(
          db,
          accountId,
          instructorId,
          fromDate,
          toDate,
          tz,
          config.default_lesson_minutes || 60,
        );

        const summary = availability
          .map((day) => ({
            date: day.date,
            day_name: day.day_name,
            available_slots: day.slots
              .filter((s) => s.available)
              .map((s) => ({ time: s.time, datetime: s.datetime })),
          }))
          .filter((d) => d.available_slots.length > 0);

        return {
          result: {
            tool_call_id: toolCall.id,
            name: toolCall.name,
            content: JSON.stringify({
              instructor_id: instructorId,
              from_date: fromDate,
              to_date: toDate,
              timezone: tz,
              available_days: summary,
            }),
          },
        };
      }

      // ====================================================
      // get_my_lessons
      // ====================================================
      case 'get_my_lessons': {
        if (!learnerId) {
          return errorResult(toolCall, 'No learner record found on file for this phone number.');
        }

        const { data: lessons } = await listLessons(db, accountId, {
          learner_id: learnerId,
          status: ['scheduled', 'reminder_sent', 'confirmed', 'pending_approval'],
          from_date: new Date().toISOString(),
          limit: 10,
        });

        const formatted = lessons.map((l) => ({
          id: l.id,
          date: formatInSchoolTimezone(l.starts_at, tz, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          }),
          time: formatInSchoolTimezone(l.starts_at, tz, {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }),
          starts_at: l.starts_at,
          instructor: l.instructor?.full_name ?? 'Unknown',
          instructor_id: l.instructor_id,
          status: l.status,
          lesson_type: l.lesson_type,
          duration_minutes: l.duration_minutes,
        }));

        return {
          result: {
            tool_call_id: toolCall.id,
            name: toolCall.name,
            content: JSON.stringify({ lessons: formatted }),
          },
        };
      }

      // ====================================================
      // update_learner_profile
      // ====================================================
      case 'update_learner_profile': {
        if (!learnerId) {
          return errorResult(toolCall, 'No learner record found to update.');
        }

        const updates: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
        };

        if (args.full_name) {
          updates.full_name = (args.full_name as string).trim();
          updates.name_confirmed = true;
        }
        if (args.age) updates.age = args.age;
        if (args.postcode) updates.postcode = (args.postcode as string).trim().toUpperCase();
        if (args.licence_type) updates.licence_type = args.licence_type;
        if (args.experience_level) updates.experience_level = args.experience_level;
        if (args.transmission_preference) updates.transmission_preference = args.transmission_preference;
        if (args.goal) updates.goal = args.goal;
        if (args.preferred_days) updates.preferred_days = args.preferred_days;
        if (args.preferred_times) updates.preferred_times = args.preferred_times;
        if (args.lessons_per_week) updates.lessons_per_week = args.lessons_per_week;
        if (args.preferred_language) updates.preferred_language = args.preferred_language;

        const { error: updateErr } = await db
          .from('learners')
          .update(updates)
          .eq('id', learnerId)
          .eq('account_id', accountId);

        if (updateErr) {
          console.error('[driving agent] update_learner_profile error:', updateErr);
          return errorResult(toolCall, 'Failed to update learner profile.');
        }

        // Also sync contact name in CRM
        if (updates.full_name) {
          const { data: learnerRec } = await db
            .from('learners')
            .select('contact_id')
            .eq('id', learnerId)
            .maybeSingle();

          if (learnerRec?.contact_id) {
            await db
              .from('contacts')
              .update({ name: updates.full_name })
              .eq('id', learnerRec.contact_id);
          }
        }

        return {
          result: {
            tool_call_id: toolCall.id,
            name: toolCall.name,
            content: JSON.stringify({ success: true, updated_fields: Object.keys(updates) }),
          },
        };
      }

      // ====================================================
      // check_test_eligibility
      // ====================================================
      case 'check_test_eligibility': {
        if (!learnerId) {
          return errorResult(toolCall, 'No learner record found to verify test eligibility.');
        }

        const counts = await countCompletedLessons(db, accountId, learnerId);
        const REQUIRED_CLASSES = REQUIRED_LESSONS_FOR_TEST;
        const eligible = counts.totalCompleted >= REQUIRED_CLASSES;

        return {
          result: {
            tool_call_id: toolCall.id,
            name: toolCall.name,
            content: JSON.stringify({
              eligible,
              completed_lessons: counts.totalCompleted,
              required_lessons: REQUIRED_CLASSES,
              lessons_still_needed: Math.max(0, REQUIRED_CLASSES - counts.totalCompleted),
              note: 'Counts completed driving lessons only; completed tests/mock tests are not lessons.',
              message: eligible
                ? `Learner has completed ${counts.totalCompleted} lessons (minimum ${REQUIRED_CLASSES} required). Eligible to book a driving test/mock test!`
                : `Learner has only completed ${counts.totalCompleted} lessons. School policy requires at least ${REQUIRED_CLASSES} completed lessons before a driving test or mock test can be booked. Do NOT book the test; offer regular driving lessons instead.`,
            }),
          },
        };
      }

      // ====================================================
      // create_booking
      // ====================================================
      case 'create_booking': {
        const instructorId = args.instructor_id as string;
        const startsAt = args.starts_at as string;
        const lessonType = (args.lesson_type as string) || 'standard';

        if (!instructorId || !startsAt) {
          return errorResult(toolCall, 'instructor_id and starts_at are required');
        }

        if (!learnerId) {
          return errorResult(toolCall, 'Cannot book: no learner record found.');
        }

        // 5-lesson check for any driving test / mock test. A test is not a lesson, and the
        // gate must not depend on the model picking the right lesson_type, so notes that
        // describe a driving/mock test are treated as a test booking too.
        if (isTestBooking(lessonType, args.notes as string | undefined)) {
          const counts = await countCompletedLessons(db, accountId, learnerId);
          if (counts.totalCompleted < REQUIRED_LESSONS_FOR_TEST) {
            return errorResult(
              toolCall,
              `Cannot book a driving test or mock test: Learner has completed ${counts.totalCompleted} lesson(s), but a minimum of ${REQUIRED_LESSONS_FOR_TEST} completed lessons is required. Please offer a standard lesson first.`,
            );
          }
        }

        try {
          const lesson = await createLesson(db, accountId, userId, {
            learner_id: learnerId,
            instructor_id: instructorId,
            starts_at: startsAt,
            duration_minutes: (args.duration_minutes as number) || config.default_lesson_minutes || 60,
            lesson_type: lessonType,
            notes: args.notes as string | undefined,
          });

          // Mark booked_via as agent
          await db
            .from('lessons')
            .update({ booked_via: 'agent' })
            .eq('id', lesson.id);

          const calendarUid = `driving-${lesson.id}@${config.school_name.replace(/\s+/g, '-').toLowerCase()}`;
          await db
            .from('lessons')
            .update({ calendar_uid: calendarUid })
            .eq('id', lesson.id);

          lesson.booked_via = 'agent';
          lesson.calendar_uid = calendarUid;

          return {
            result: {
              tool_call_id: toolCall.id,
              name: toolCall.name,
              content: JSON.stringify({
                success: true,
                lesson: {
                  id: lesson.id,
                  date: formatInSchoolTimezone(lesson.starts_at, tz, {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  }),
                  time: formatInSchoolTimezone(lesson.starts_at, tz, {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  }),
                  instructor: lesson.instructor?.full_name,
                  lesson_type: lesson.lesson_type,
                  duration_minutes: lesson.duration_minutes,
                },
              }),
            },
            lesson,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('conflicts with an existing lesson')) {
            return errorResult(
              toolCall,
              'That time slot was just taken. Please check availability again and offer the learner an alternative slot.',
            );
          }
          return errorResult(toolCall, `Booking failed: ${message}`);
        }
      }

      // ====================================================
      // cancel_booking
      // ====================================================
      case 'cancel_booking': {
        const lessonId = args.lesson_id as string;
        if (!lessonId) {
          return errorResult(toolCall, 'lesson_id is required');
        }

        const isOwner = await verifyLessonOwnership(db, accountId, lessonId, learnerId);
        if (!isOwner) {
          return errorResult(toolCall, 'Lesson not found or does not belong to this learner.');
        }

        try {
          const lesson = await transitionLesson(
            db,
            accountId,
            lessonId,
            'cancelled',
            'learner_via_agent',
            { reason: (args.reason as string) ?? 'Learner cancelled via chat' },
          );

          return {
            result: {
              tool_call_id: toolCall.id,
              name: toolCall.name,
              content: JSON.stringify({
                success: true,
                cancelled_lesson: {
                  id: lesson.id,
                  date: formatInSchoolTimezone(lesson.starts_at, tz, {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  }),
                  time: formatInSchoolTimezone(lesson.starts_at, tz, {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  }),
                  instructor: lesson.instructor?.full_name,
                },
              }),
            },
            lesson,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errorResult(toolCall, `Cancellation failed: ${message}`);
        }
      }

      // ====================================================
      // reschedule_booking
      // ====================================================
      case 'reschedule_booking': {
        const lessonId = args.lesson_id as string;
        const newStartsAt = args.new_starts_at as string;
        if (!lessonId || !newStartsAt) {
          return errorResult(toolCall, 'lesson_id and new_starts_at are required');
        }

        const isOwner = await verifyLessonOwnership(db, accountId, lessonId, learnerId);
        if (!isOwner) {
          return errorResult(toolCall, 'Lesson not found or does not belong to this learner.');
        }

        const { data: oldLesson } = await db
          .from('lessons')
          .select('*, learner:learners(*), instructor:instructors(*)')
          .eq('id', lessonId)
          .eq('account_id', accountId)
          .single();

        if (!oldLesson) {
          return errorResult(toolCall, 'Lesson not found.');
        }

        try {
          const { newLesson } = await commitReschedule({
            db,
            accountId,
            oldLesson: oldLesson as Lesson,
            newStartsAt: new Date(newStartsAt),
            config,
            newInstructorId: args.new_instructor_id as string | undefined,
            actor: 'learner_via_agent',
            bookedVia: 'agent',
          });

          return {
            result: {
              tool_call_id: toolCall.id,
              name: toolCall.name,
              content: JSON.stringify({
                success: true,
                new_lesson: {
                  id: newLesson.id,
                  date: formatInSchoolTimezone(newLesson.starts_at, tz, {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  }),
                  time: formatInSchoolTimezone(newLesson.starts_at, tz, {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  }),
                  instructor: oldLesson.instructor?.full_name,
                  lesson_type: newLesson.lesson_type,
                },
              }),
            },
            lesson: newLesson,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errorResult(toolCall, `Reschedule failed: ${message}`);
        }
      }

      // ====================================================
      // transfer_to_human
      // ====================================================
      case 'transfer_to_human': {
        const reason = (args.reason as string) ?? 'Learner requested human assistance';

        // Only hand off when the learner actually asked for a person / complained.
        // Otherwise the model must keep helping and follow the conversation script.
        if (ctx.inboundText !== undefined && !wantsHuman(ctx.inboundText)) {
          return {
            result: {
              tool_call_id: toolCall.id,
              name: toolCall.name,
              content: JSON.stringify({
                success: false,
                error:
                  'Hand-off refused: the learner has not asked to speak to a person, complained, or reported a safety issue. ' +
                  'Do NOT transfer. Continue helping and follow the conversation flow for the current step.',
              }),
            },
          };
        }

        return {
          result: {
            tool_call_id: toolCall.id,
            name: toolCall.name,
            content: JSON.stringify({
              success: true,
              message: 'Conversation transferred to instructor / school staff.',
            }),
          },
          handoff: true,
          handoffReason: reason,
        };
      }

      // ====================================================
      // react_to_message
      // ====================================================
      case 'react_to_message': {
        const emoji = args.emoji as string;
        if (!emoji) return errorResult(toolCall, 'emoji is required');

        try {
          await ctx.waService.sendReaction({
            accountId,
            phone,
            targetMessageId: ctx.waMessageId,
            emoji,
          });
        } catch (err) {
          console.warn('[driving agent] react_to_message non-blocking warning:', err);
        }

        return {
          result: {
            tool_call_id: toolCall.id,
            name: toolCall.name,
            content: JSON.stringify({ success: true, emoji }),
          },
        };
      }

      default:
        return errorResult(toolCall, `Unknown tool: ${toolCall.name}`);
    }
  } catch (err) {
    console.error(`[driving agent] tool execution error (${toolCall.name}):`, err);
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(toolCall, `Error executing ${toolCall.name}: ${message}`);
  }
}

function errorResult(toolCall: ToolCall, message: string): { result: ToolResult } {
  return {
    result: {
      tool_call_id: toolCall.id,
      name: toolCall.name,
      content: JSON.stringify({ error: message }),
    },
  };
}

async function verifyLessonOwnership(
  db: SupabaseClient,
  accountId: string,
  lessonId: string,
  learnerId: string | null,
): Promise<boolean> {
  if (!learnerId) return false;

  const { data, error } = await db
    .from('lessons')
    .select('id')
    .eq('id', lessonId)
    .eq('account_id', accountId)
    .eq('learner_id', learnerId)
    .maybeSingle();

  return !error && !!data;
}
