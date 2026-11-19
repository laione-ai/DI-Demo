-- ============================================================
-- Migration 044: Driving Instructor & School System
--
-- Transforms the dental clinic schema into a driving instructor
-- system:
--   - dental_clinic_config -> driving_school_config
--   - dental_doctors -> instructors
--   - dental_patients -> learners
--   - dental_doctor_availability -> instructor_availability
--   - dental_appointments -> lessons
--   - dental_appointment_reminders -> lesson_reminders
--   - dental_appointment_audit -> lesson_audit
--   - dental_reschedule_sessions -> reschedule_sessions
--   - dental_message_log -> driving_message_log
--   - dental_agent_sessions -> driving_agent_sessions
--
-- Preserves RLS, constraints, indexes and existing data.
-- ============================================================

-- Ensure pending_approval exists in the enum
ALTER TYPE dental_appointment_status ADD VALUE IF NOT EXISTS 'pending_approval';

-- 1. Rename tables
ALTER TABLE IF EXISTS dental_clinic_config RENAME TO driving_school_config;
ALTER TABLE IF EXISTS dental_doctors RENAME TO instructors;
ALTER TABLE IF EXISTS dental_patients RENAME TO learners;
ALTER TABLE IF EXISTS dental_doctor_availability RENAME TO instructor_availability;
ALTER TABLE IF EXISTS dental_appointments RENAME TO lessons;
ALTER TABLE IF EXISTS dental_appointment_reminders RENAME TO lesson_reminders;
ALTER TABLE IF EXISTS dental_appointment_audit RENAME TO lesson_audit;
ALTER TABLE IF EXISTS dental_reschedule_sessions RENAME TO reschedule_sessions;
ALTER TABLE IF EXISTS dental_message_log RENAME TO driving_message_log;
ALTER TABLE IF EXISTS dental_agent_sessions RENAME TO driving_agent_sessions;

-- 2. Rename columns & update defaults in driving_school_config
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'driving_school_config' AND column_name = 'clinic_name') THEN
    ALTER TABLE driving_school_config RENAME COLUMN clinic_name TO school_name;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'driving_school_config' AND column_name = 'clinic_phone') THEN
    ALTER TABLE driving_school_config RENAME COLUMN clinic_phone TO school_phone;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'driving_school_config' AND column_name = 'clinic_address') THEN
    ALTER TABLE driving_school_config RENAME COLUMN clinic_address TO school_address;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'driving_school_config' AND column_name = 'clinic_timezone') THEN
    ALTER TABLE driving_school_config RENAME COLUMN clinic_timezone TO school_timezone;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'driving_school_config' AND column_name = 'default_duration_minutes') THEN
    ALTER TABLE driving_school_config RENAME COLUMN default_duration_minutes TO default_lesson_minutes;
  END IF;
END $$;

ALTER TABLE driving_school_config 
  ALTER COLUMN school_name SET DEFAULT 'LessonDesk Driving School',
  ALTER COLUMN school_timezone SET DEFAULT 'Europe/London',
  ALTER COLUMN default_lesson_minutes SET DEFAULT 60;

-- 3. Rename columns & add driving instructor fields to instructors
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'instructors' AND column_name = 'specialization') THEN
    ALTER TABLE instructors RENAME COLUMN specialization TO transmission_type;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'instructors' AND column_name = 'slot_duration_minutes') THEN
    ALTER TABLE instructors RENAME COLUMN slot_duration_minutes TO lesson_duration_minutes;
  END IF;
END $$;

ALTER TABLE instructors
  ALTER COLUMN transmission_type SET DEFAULT 'manual',
  ALTER COLUMN lesson_duration_minutes SET DEFAULT 60,
  ADD COLUMN IF NOT EXISTS badge_reference text,
  ADD COLUMN IF NOT EXISTS badge_verified boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS service_areas text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS booking_mode text DEFAULT 'auto' CHECK (booking_mode IN ('auto', 'ask_first', 'always_ask')),
  ADD COLUMN IF NOT EXISTS min_notice_hours integer DEFAULT 12,
  ADD COLUMN IF NOT EXISTS booking_horizon_days integer DEFAULT 42,
  ADD COLUMN IF NOT EXISTS max_lessons_per_day integer DEFAULT 8,
  ADD COLUMN IF NOT EXISTS buffer_minutes integer DEFAULT 15,
  ADD COLUMN IF NOT EXISTS payment_link text,
  ADD COLUMN IF NOT EXISTS quiet_hours_start time,
  ADD COLUMN IF NOT EXISTS quiet_hours_end time;

-- 4. Add learner fields to learners
ALTER TABLE learners
  ADD COLUMN IF NOT EXISTS licence_type text CHECK (licence_type IS NULL OR licence_type IN ('provisional', 'full')),
  ADD COLUMN IF NOT EXISTS transmission_preference text CHECK (transmission_preference IS NULL OR transmission_preference IN ('manual', 'automatic')),
  ADD COLUMN IF NOT EXISTS experience_level text,
  ADD COLUMN IF NOT EXISTS test_date date,
  ADD COLUMN IF NOT EXISTS lessons_completed integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS goal text,
  ADD COLUMN IF NOT EXISTS preferred_days text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS preferred_times text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS lessons_per_week integer,
  ADD COLUMN IF NOT EXISTS stop_status boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS preferred_language text DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS booker_name text,
  ADD COLUMN IF NOT EXISTS booker_phone text,
  ADD COLUMN IF NOT EXISTS age integer,
  ADD COLUMN IF NOT EXISTS postcode text;

-- 5. Rename columns in instructor_availability
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'instructor_availability' AND column_name = 'doctor_id') THEN
    ALTER TABLE instructor_availability RENAME COLUMN doctor_id TO instructor_id;
  END IF;
END $$;

-- 6. Rename columns & update constraints in lessons
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'lessons' AND column_name = 'doctor_id') THEN
    ALTER TABLE lessons RENAME COLUMN doctor_id TO instructor_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'lessons' AND column_name = 'patient_id') THEN
    ALTER TABLE lessons RENAME COLUMN patient_id TO learner_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'lessons' AND column_name = 'treatment_type') THEN
    ALTER TABLE lessons RENAME COLUMN treatment_type TO lesson_type;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'lessons' AND column_name = 'patient_responded') THEN
    ALTER TABLE lessons RENAME COLUMN patient_responded TO learner_responded;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'lessons' AND column_name = 'patient_response_at') THEN
    ALTER TABLE lessons RENAME COLUMN patient_response_at TO learner_response_at;
  END IF;
END $$;

ALTER TABLE lessons
  ALTER COLUMN duration_minutes SET DEFAULT 60,
  ALTER COLUMN lesson_type SET DEFAULT 'standard';

-- Update status check constraint on lessons to include pending_approval
ALTER TABLE lessons DROP CONSTRAINT IF EXISTS dental_appointments_status_check;
ALTER TABLE lessons DROP CONSTRAINT IF EXISTS lessons_status_check;
ALTER TABLE lessons ADD CONSTRAINT lessons_status_check CHECK (
  status::text IN ('scheduled', 'reminder_sent', 'confirmed', 'cancelled', 'reschedule_requested', 'rescheduled', 'completed', 'no_show', 'pending_approval')
);

-- Update exclusion constraint on lessons
-- Drop old constraint if exists
ALTER TABLE lessons DROP CONSTRAINT IF EXISTS dental_appointments_exclude_overlap;
ALTER TABLE lessons DROP CONSTRAINT IF EXISTS lessons_exclude_overlap;
ALTER TABLE lessons ADD CONSTRAINT lessons_exclude_overlap EXCLUDE USING gist (
  instructor_id WITH =,
  tstzrange(starts_at, ends_at) WITH &&
) WHERE (status NOT IN ('cancelled', 'rescheduled'));

-- 7. Rename columns in reschedule_sessions, driving_message_log, driving_agent_sessions
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reschedule_sessions' AND column_name = 'patient_id') THEN
    ALTER TABLE reschedule_sessions RENAME COLUMN patient_id TO learner_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reschedule_sessions' AND column_name = 'appointment_id') THEN
    ALTER TABLE reschedule_sessions RENAME COLUMN appointment_id TO lesson_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'driving_message_log' AND column_name = 'patient_id') THEN
    ALTER TABLE driving_message_log RENAME COLUMN patient_id TO learner_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'driving_message_log' AND column_name = 'appointment_id') THEN
    ALTER TABLE driving_message_log RENAME COLUMN appointment_id TO lesson_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'driving_agent_sessions' AND column_name = 'patient_id') THEN
    ALTER TABLE driving_agent_sessions RENAME COLUMN patient_id TO learner_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'lesson_reminders' AND column_name = 'appointment_id') THEN
    ALTER TABLE lesson_reminders RENAME COLUMN appointment_id TO lesson_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'lesson_audit' AND column_name = 'appointment_id') THEN
    ALTER TABLE lesson_audit RENAME COLUMN appointment_id TO lesson_id;
  END IF;
END $$;

-- 8. Recreate / rename indexes for clarity
DROP INDEX IF EXISTS idx_dental_doctors_account;
CREATE INDEX IF NOT EXISTS idx_instructors_account ON instructors (account_id);

DROP INDEX IF EXISTS idx_dental_patients_account;
CREATE INDEX IF NOT EXISTS idx_learners_account ON learners (account_id);

DROP INDEX IF EXISTS idx_dental_appointments_account;
CREATE INDEX IF NOT EXISTS idx_lessons_account ON lessons (account_id);

DROP INDEX IF EXISTS idx_dental_appointments_doctor_date;
CREATE INDEX IF NOT EXISTS idx_lessons_instructor_date ON lessons (instructor_id, starts_at);

DROP INDEX IF EXISTS idx_dental_appointments_patient;
CREATE INDEX IF NOT EXISTS idx_lessons_learner ON lessons (learner_id);

DROP INDEX IF EXISTS idx_dental_agent_sessions_phone;
CREATE INDEX IF NOT EXISTS idx_driving_agent_sessions_phone ON driving_agent_sessions (account_id, phone) WHERE completed_at IS NULL;

-- 9. Recreate RLS Policies on renamed tables
-- driving_school_config
ALTER TABLE driving_school_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can view driving school config" ON driving_school_config;
CREATE POLICY "Members can view driving school config" ON driving_school_config
  FOR SELECT USING (account_id IN (SELECT account_id FROM profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Members can update driving school config" ON driving_school_config;
CREATE POLICY "Members can update driving school config" ON driving_school_config
  FOR UPDATE USING (account_id IN (SELECT account_id FROM profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Members can insert driving school config" ON driving_school_config;
CREATE POLICY "Members can insert driving school config" ON driving_school_config
  FOR INSERT WITH CHECK (account_id IN (SELECT account_id FROM profiles WHERE user_id = auth.uid()));

-- instructors
ALTER TABLE instructors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage instructors" ON instructors;
CREATE POLICY "Members can manage instructors" ON instructors
  FOR ALL USING (account_id IN (SELECT account_id FROM profiles WHERE user_id = auth.uid()));

-- learners
ALTER TABLE learners ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage learners" ON learners;
CREATE POLICY "Members can manage learners" ON learners
  FOR ALL USING (account_id IN (SELECT account_id FROM profiles WHERE user_id = auth.uid()));

-- lessons
ALTER TABLE lessons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage lessons" ON lessons;
CREATE POLICY "Members can manage lessons" ON lessons
  FOR ALL USING (account_id IN (SELECT account_id FROM profiles WHERE user_id = auth.uid()));

-- instructor_availability
ALTER TABLE instructor_availability ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage instructor availability" ON instructor_availability;
CREATE POLICY "Members can manage instructor availability" ON instructor_availability
  FOR ALL USING (account_id IN (SELECT account_id FROM profiles WHERE user_id = auth.uid()));

-- lesson_reminders
ALTER TABLE lesson_reminders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage lesson reminders" ON lesson_reminders;
CREATE POLICY "Members can manage lesson reminders" ON lesson_reminders
  FOR ALL USING (account_id IN (SELECT account_id FROM profiles WHERE user_id = auth.uid()));

-- lesson_audit
ALTER TABLE lesson_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can view lesson audit" ON lesson_audit;
CREATE POLICY "Members can view lesson audit" ON lesson_audit
  FOR SELECT USING (account_id IN (SELECT account_id FROM profiles WHERE user_id = auth.uid()));

-- reschedule_sessions
ALTER TABLE reschedule_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage reschedule sessions" ON reschedule_sessions;
CREATE POLICY "Members can manage reschedule sessions" ON reschedule_sessions
  FOR ALL USING (account_id IN (SELECT account_id FROM profiles WHERE user_id = auth.uid()));

-- driving_message_log
ALTER TABLE driving_message_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can view driving message log" ON driving_message_log;
CREATE POLICY "Members can view driving message log" ON driving_message_log
  FOR SELECT USING (account_id IN (SELECT account_id FROM profiles WHERE user_id = auth.uid()));

-- driving_agent_sessions
ALTER TABLE driving_agent_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage driving agent sessions" ON driving_agent_sessions;
CREATE POLICY "Members can manage driving agent sessions" ON driving_agent_sessions
  FOR ALL USING (account_id IN (SELECT account_id FROM profiles WHERE user_id = auth.uid()));
