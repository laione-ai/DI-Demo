# Driving Instructor WhatsApp AI Booking Agent

## Overview

LessonDesk is a conversational WhatsApp AI booking agent specifically built for UK driving instructors and driving schools. It handles inbound enquiries from prospective learners, guides them through structured intake questions, checks instructor availability by service area and transmission type (manual / automatic), schedules lessons, manages cancellations and reschedules, sends reminder notifications, and enforces school policies (including the 5-lesson minimum prerequisite for driving test bookings).

---

## Typical Client Conversation Flow

The AI agent follows this friendly, structured conversation flow for new client enquiries:

```
Student:
Hi, I'm looking for driving lessons. Can you give me some information?

AI Agent:
Hey! Thanks for getting in touch 😊

I'd be happy to help you arrange your driving lessons.

Just a couple of quick questions so I can understand what you're looking for.

Is this your first time having driving lessons, or have you had lessons with another instructor before?

Student:
I've had a few lessons before, but I haven't driven for about six months.

AI Agent:
No problem at all! We can definitely help you get back into driving.

Before we go any further, what language would you prefer to communicate in? English, or another language?

Student:
English is fine.

AI Agent:
Perfect!

I'll just need to collect a few details from you before we discuss available lessons.

Could you tell me your:

Full name

Age

Postcode or area where you live

Whether you have a valid provisional or full driving licence

Your previous driving experience

Student:
My name is Ahmed. I'm 24, live in Ealing, and I have a provisional licence. I've had around 5 lessons before.

AI Agent:
Thanks, Ahmed!

Just a couple more things:

Are you looking to have manual or automatic driving lessons?

Do you have a particular goal? For example, are you preparing for your driving test, or just looking to build your confidence?

How many lessons would you ideally like per week?

Student:
Manual. I want to pass my test and probably two lessons a week.

AI Agent:
That's great. I've got all your details.

Let me check the instructor's availability for you.

Are there any particular days or times that work best? For example, weekday evenings, weekends or mornings?

Student:
Weekday evenings would be best, preferably Friday.

AI Agent:
Of course! I'll check whether Friday evenings are available and get back to you shortly.
```

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
| `src/lib/driving/agent/session.ts` | 30-minute sliding session management in `driving_agent_sessions` |
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
