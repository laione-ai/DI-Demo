// ============================================================
// Driving Instructor & School — TypeScript type definitions.
//
// Mirrors the database schema from migration 044.
// All timestamps are ISO 8601 strings (UTC) — the presentation
// layer converts to Europe/London via the school timezone.
// ============================================================

// -------------------------------------------------------
// Enums
// -------------------------------------------------------

export type LessonStatus =
  | 'scheduled'
  | 'reminder_sent'
  | 'confirmed'
  | 'cancelled'
  | 'reschedule_requested'
  | 'rescheduled'
  | 'completed'
  | 'no_show'
  | 'pending_approval';

export type ReminderStatus =
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'cancelled'
  | 'failed';

export type ReminderType =
  | 'initial_12h'
  | 'follow_up'
  | 'final_1h';

export type TransmissionType = 'manual' | 'automatic' | 'both';

export type LicenceType = 'provisional' | 'full';

export type BookingMode = 'auto' | 'ask_first' | 'always_ask';

export type LessonType =
  | 'standard'
  | 'intensive'
  | 'mock_test'
  | 'refresher'
  | 'first_lesson';

// -------------------------------------------------------
// Driving School Configuration
// -------------------------------------------------------

export interface DrivingSchoolConfig {
  id: string;
  account_id: string;
  user_id: string;
  school_name: string;
  school_phone: string | null;
  school_address: string | null;
  school_timezone: string;
  reminder_initial_minutes: number;
  reminder_final_minutes: number;
  reminder_followup_interval: number;
  default_lesson_minutes: number;
  demo_mode: boolean;
  /** Master switch for the AI booking agent. */
  agent_enabled: boolean;
  created_at: string;
  updated_at: string;
}

// -------------------------------------------------------
// Instructor
// -------------------------------------------------------

export interface DayHours {
  start: string; // "09:00"
  end: string;   // "17:00"
}

export type WeeklyHours = {
  [key in 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun']: DayHours | null;
};

export interface Instructor {
  id: string;
  account_id: string;
  user_id: string;
  full_name: string;
  transmission_type: TransmissionType | null;
  phone: string | null;
  email: string | null;
  avatar_url: string | null;
  is_active: boolean;
  default_hours: WeeklyHours;
  lesson_duration_minutes: number;
  badge_reference: string | null;
  badge_verified: boolean;
  service_areas: string[];
  booking_mode: BookingMode;
  min_notice_hours: number;
  booking_horizon_days: number;
  max_lessons_per_day: number;
  buffer_minutes: number;
  payment_link: string | null;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  created_at: string;
  updated_at: string;
}

// -------------------------------------------------------
// Learner
// -------------------------------------------------------

export interface Learner {
  id: string;
  account_id: string;
  user_id: string;
  contact_id: string | null;
  full_name: string;
  /** True when the learner has explicitly confirmed their name. */
  name_confirmed: boolean;
  phone: string;
  email: string | null;
  date_of_birth: string | null;
  age: number | null;
  postcode: string | null;
  licence_type: LicenceType | null;
  transmission_preference: 'manual' | 'automatic' | null;
  experience_level: string | null;
  test_date: string | null;
  lessons_completed: number;
  goal: string | null;
  preferred_days: string[];
  preferred_times: string[];
  lessons_per_week: number | null;
  preferred_language: string;
  stop_status: boolean;
  booker_name: string | null;
  booker_phone: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// -------------------------------------------------------
// Instructor Availability Override
// -------------------------------------------------------

export interface BreakPeriod {
  start: string; // "12:00"
  end: string;   // "13:00"
}

export interface InstructorAvailability {
  id: string;
  instructor_id: string;
  account_id: string;
  available_date: string; // "YYYY-MM-DD"
  start_time: string | null;
  end_time: string | null;
  breaks: BreakPeriod[];
  reason: string | null;
  created_at: string;
}

// -------------------------------------------------------
// Lesson
// -------------------------------------------------------

export interface Lesson {
  id: string;
  account_id: string;
  user_id: string;
  learner_id: string;
  instructor_id: string;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  status: LessonStatus;
  lesson_type: string | null;
  notes: string | null;
  confirmed_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  completed_at: string | null;
  conversation_id: string | null;
  rescheduled_from_id: string | null;
  rescheduled_to_id: string | null;
  last_reminder_sent_at: string | null;
  reminder_count: number;
  learner_responded: boolean;
  learner_response_at: string | null;
  /** How this lesson was created: 'staff' | 'agent' | 'button'. */
  booked_via: string;
  /** Stable UID for .ics calendar events — survives reschedules. */
  calendar_uid: string | null;
  created_at: string;
  updated_at: string;

  // Joined fields
  learner?: Learner;
  instructor?: Instructor;
  reminders?: LessonReminder[];
}

/** A lesson loaded with its learner joined (needed to message the learner). */
export type LessonWithLearner = Lesson & { learner: Learner };

// -------------------------------------------------------
// Reminder
// -------------------------------------------------------

export interface LessonReminder {
  id: string;
  lesson_id: string;
  account_id: string;
  reminder_type: ReminderType;
  status: ReminderStatus;
  scheduled_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  whatsapp_message_id: string | null;
  error_message: string | null;
  sequence_number: number;
  created_at: string;
}

// -------------------------------------------------------
// Audit
// -------------------------------------------------------

export interface LessonAudit {
  id: string;
  lesson_id: string;
  account_id: string;
  action: string;
  old_status: string | null;
  new_status: string | null;
  actor: string;
  details: Record<string, unknown>;
  created_at: string;
}

// -------------------------------------------------------
// Reschedule Session
// -------------------------------------------------------

export type RescheduleStep =
  | 'date_selection'
  | 'time_selection'
  | 'confirmation'
  | 'completed';

export interface RescheduleSession {
  id: string;
  lesson_id: string;
  account_id: string;
  learner_id: string;
  step: RescheduleStep;
  offered_dates: string[] | null;
  selected_date: string | null;
  offered_slots: string[] | null;
  selected_slot: string | null;
  new_starts_at: string | null;
  expires_at: string;
  completed_at: string | null;
  created_at: string;
}

// -------------------------------------------------------
// Message Log
// -------------------------------------------------------

export interface MessageLog {
  id: string;
  account_id: string;
  lesson_id: string | null;
  learner_id: string | null;
  direction: 'outbound' | 'inbound';
  message_type: 'text' | 'interactive' | 'template';
  content: string | null;
  interactive_payload: Record<string, unknown> | null;
  whatsapp_message_id: string | null;
  mock_mode: boolean;
  created_at: string;
}

// -------------------------------------------------------
// API Request/Response types
// -------------------------------------------------------

export interface CreateLessonRequest {
  learner_id: string;
  instructor_id: string;
  starts_at: string;
  duration_minutes?: number;
  lesson_type?: string;
  notes?: string;
}

export interface AvailableSlot {
  time: string;     // "09:00"
  datetime: string;  // Full ISO string in UTC/local
  available: boolean;
}

export interface DayAvailability {
  date: string;      // "2026-03-20"
  day_name: string;  // "Friday"
  slots: AvailableSlot[];
}

// -------------------------------------------------------
// WhatsApp interactive button IDs
// Prefixed with 'driving_' for deterministic webhook routing.
// -------------------------------------------------------

export const DRIVING_BUTTON_PREFIX = 'driving_' as const;

export const DRIVING_BUTTON_IDS = {
  CONFIRM: 'driving_confirm',
  CANCEL: 'driving_cancel',
  RESCHEDULE: 'driving_reschedule',
  DATE_PREFIX: 'driving_date_',
  SLOT_PREFIX: 'driving_slot_',
  RESCHEDULE_CONFIRM: 'driving_resched_confirm',
  RESCHEDULE_CANCEL: 'driving_resched_cancel',
} as const;

// -------------------------------------------------------
// State machine — valid transitions
// -------------------------------------------------------

export const VALID_STATUS_TRANSITIONS: Record<
  LessonStatus,
  LessonStatus[]
> = {
  scheduled: ['reminder_sent', 'confirmed', 'cancelled', 'reschedule_requested', 'completed'],
  reminder_sent: ['confirmed', 'cancelled', 'reschedule_requested', 'completed', 'no_show'],
  confirmed: ['cancelled', 'reschedule_requested', 'completed', 'no_show'],
  pending_approval: ['confirmed', 'cancelled'],
  cancelled: [],
  reschedule_requested: ['rescheduled', 'cancelled'],
  rescheduled: [],
  completed: [],
  no_show: [],
};

// -------------------------------------------------------
// Agent Session
// -------------------------------------------------------

export type AgentIntent =
  | 'enquiry'
  | 'book_lesson'
  | 'book_test'
  | 'cancel'
  | 'reschedule'
  | 'check_status'
  | 'faq_or_other';

export type AgentState =
  | 'awaiting_intent'
  | 'intake_experience'
  | 'intake_language'
  | 'intake_details'
  | 'intake_preferences'
  | 'collecting_info'
  | 'checking_availability'
  | 'confirming'
  | 'executing'
  | 'completed'
  | 'expired'
  | 'handed_off';

export interface AgentSessionSlots {
  instructor_id?: string;
  instructor_name?: string;
  lesson_type?: string;
  transmission_preference?: 'manual' | 'automatic';
  preferred_date?: string;
  preferred_time?: string;
  preferred_days?: string[];
  preferred_times?: string[];
  lesson_id?: string;
  offered_options?: Array<{ id: string; label: string; value: string }>;
  /** Consecutive AI/LLM failures in this session (resets on success). */
  llm_failures?: number;
  candidate_starts_at?: string;
  new_instructor_id?: string;
  learner_details?: {
    full_name?: string;
    age?: number;
    postcode?: string;
    licence_type?: 'provisional' | 'full';
    experience_level?: string;
    transmission?: 'manual' | 'automatic';
    goal?: string;
    lessons_per_week?: number;
  };
}

export interface AgentSession {
  id: string;
  account_id: string;
  learner_id: string | null;
  conversation_id: string | null;
  phone: string;
  intent: AgentIntent | null;
  state: AgentState;
  slots: AgentSessionSlots;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  turn_count: number;
  last_message_id: string | null;
  expires_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}
