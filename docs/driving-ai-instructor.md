# Driving Instructor WhatsApp AI Booking Agent

## Overview

LessonDesk is a conversational WhatsApp AI booking agent specifically built for UK driving instructors and driving schools. It handles inbound enquiries from prospective learners, guides them through structured intake questions, checks instructor availability by service area and transmission type (manual / automatic), schedules lessons, manages cancellations and reschedules, sends reminder notifications, and enforces school policies (including the 5-lesson minimum prerequisite for driving test bookings).

---

## Typical Client Conversation Flow

The agent texts like a person on the team: short messages, **one question per message**, no lists or bold, at most one emoji. It works through the intake one question at a time and skips anything already on file:

```
Learner:  Hi, I'm looking for driving lessons. Can you give me some information?
Agent:    Hey, thanks for getting in touch! Have you had any lessons before, or would this be your first time?
Learner:  I've had a few, but I haven't driven for about six months.
Agent:    No problem, we can get you back into it. Are you happy chatting in English?
Learner:  English is fine.
Agent:    Perfect. What's your full name?
Learner:  Ahmed Khan
Agent:    Thanks Ahmed. How old are you?
Learner:  24
Agent:    And whereabouts are you based? Postcode or area is fine.
...       (licence → manual/automatic → goal → lessons per week → days/times)
Learner:  Weekday evenings, preferably Friday.
Agent:    Kevin's free Friday at 3 or 4pm, or Thursday at 6pm. Would any of those work?
```

How it is enforced:

| Piece | File | What it does |
|---|---|---|
| Question queue | `agent/intake-flow.ts` | Works out the single next question from the learner row; skips a question after it has been asked twice in a session (no loops) |
| Texting style | `agent/prompt.ts` | Tells the model how a person texts: one question, short, plain, honest if sincerely asked whether it's a bot |
| Style guard | `agent/style.ts` | Runs on every reply: drops anything after the first question, strips markdown |
| Language | `agent/prompt.ts`, migration `045` | Once the learner picks a language (`language_confirmed`), every reply is written in it |
| Instructor lookup | `agent/tools.ts` `resolveInstructor` | Tools accept the instructor's id *or name*; the prompt lists ids. Fixes "Instructor not found" on follow-up turns |
| Slot memory | `agent/availability-memory.ts` | Availability looked up in one turn is saved in the session and shown in later turns, so "Thursday at 10 please" books the exact slot |
| Booking guard | `availability-service.ts` `checkSlotBookable` | `create_booking` / `reschedule_booking` only accept a genuinely open slot (hours, breaks, days off, other lessons, `min_notice_hours`); otherwise they return the real open times |
| Plain date + time | `agent/tools.ts` `resolveStart` | The model books with `date` + `time` in UK time; the server converts to UTC (handles BST) |

## Demo instructor (Kevin)

`supabase/seed/kevin_demo_instructor.sql` adds a test instructor, Kevin (manual + automatic, ADI-verified, all London), with a 2-hour minimum notice and a fixed pattern for this week and next (anchored to Monday): two days off, a short Saturday, afternoon-only and morning-only days, lunch breaks, a 3-hour block, and three already-booked evening slots. Run it in the Supabase SQL editor. Set `v_test_phone` to the number you test from. It's safe to re-run: Kevin is updated in place (never deleted, which would cascade-delete real bookings). The agent's `get_instructor_availability` now defaults to the same 2-week window starting today.

---

## 5-Lesson Minimum Rule for Driving Tests

Anyone attempting to book a **driving test** or **mock driving test** (`mock_test`) is checked against the database:

1. **`check_test_eligibility` Tool**:
   - Queries the database for completed lessons (`status = 'completed'` in `lessons` table, plus base `lessons_completed` on the learner profile).
   - If `totalCompleted < 5`: The agent politely informs the learner that school policy requires at least 5 completed lessons with an instructor before a test or mock test can be booked. It offers standard practice lessons to reach the 5-lesson requirement.
   - If `totalCompleted >= 5`: The agent confirms eligibility and proceeds with slot booking.
2. **Server-Side Enforcement**:
   - `create_booking` enforces this check on the server side: any attempt to book a `mock_test` with `< 5` completed lessons fails with a clear validation error, preventing hallucinated bookings.

---

## Architecture & File Layout

| Path | Purpose |
|---|---|
| `supabase/migrations/044_driving_instructor.sql` | Migration transforming dental schema to driving school schema |
| `src/lib/driving/types.ts` | TypeScript types for instructors, learners, lessons, slots, and reminders |
| `src/lib/driving/config.ts` | Config loader (defaults: `Europe/London`, `en-GB`, 60-min default lesson) |
| `src/lib/driving/admin-client.ts` | Service-role Supabase client (`drivingAdmin()`) |
| `src/lib/driving/lesson-service.ts` | Lesson CRUD, state machine, and `countCompletedLessons()` |
| `src/lib/driving/availability-service.ts` | Pure slot engine respecting instructor hours, breaks, and existing lessons |
| `src/lib/driving/reminder-service.ts` | 12-hour and 1-hour pre-lesson reminders |
| `src/lib/driving/whatsapp-service.ts` | WhatsApp integration for text, interactive buttons, and reactions |
| `src/lib/driving/calendar.ts` | Google Calendar deep link and `.ics` download with 1h alarm |
| `src/lib/driving/reschedule.ts` | Atomic reschedule transaction for both buttons and agent |
| `src/lib/driving/seed.ts` | Demo seed data with realistic UK instructors and learners |
| `src/lib/driving/webhook-handler.ts` | WhatsApp interactive button router (`driving_confirm`, `driving_reschedule`, etc.) |
| `src/lib/driving/agent/dispatch.ts` | Inbound webhook dispatch for driving conversations |
| `src/lib/driving/agent/engine.ts` | Core agent tool-calling loop with deterministic confirmations |
| `src/lib/driving/agent/tools.ts` | 10 driving tools including `check_test_eligibility` and `update_learner_profile` |
| `src/lib/driving/agent/prompt.ts` | Multi-step system prompt builder matching the enquiry flow |
| `src/lib/driving/agent/session.ts` | 24-hour sliding session management in `driving_agent_sessions` |
| `src/lib/driving/agent/providers.ts` | Provider-agnostic tool calling (OpenAI + Anthropic) |
| `src/app/api/driving/*` | REST API routes for config, instructors, learners, lessons, cron, seed |
| `src/app/(dashboard)/appointments/page.tsx` | Dashboard UI for viewing driving lessons and instructor schedule |

---

## Driving Agent Tools

| Tool | Purpose |
|---|---|
| `list_instructors` | List instructors, transmission types (manual/automatic/both), and service postcode areas |
| `get_instructor_availability` | Fetch live available lesson slots for an instructor |
| `get_my_lessons` | Retrieve upcoming lessons for the learner's phone number |
| `update_learner_profile` | Persist intake info (name, age, postcode, licence type, experience, goal, preferred times) |
| `check_test_eligibility` | Query DB to confirm whether learner has completed >= 5 lessons for test booking |
| `create_booking` | Book a lesson; enforces 5-lesson requirement if `lesson_type === 'mock_test'` |
| `cancel_booking` | Cancel a lesson with ownership verification |
| `reschedule_booking` | Reschedule to an open slot with ownership verification |
| `transfer_to_human` | Handoff conversation to human instructor |
| `react_to_message` | Non-blocking emoji reactions for quick acknowledgments |

---

## Interactive WhatsApp Buttons

Reminders and reschedule messages use interactive buttons prefixed with `driving_`:
- `driving_confirm`: Confirms the upcoming lesson immediately
- `driving_cancel`: Cancels the lesson and logs audit event
- `driving_reschedule`: Starts a 3-step date and time slot picker in chat
