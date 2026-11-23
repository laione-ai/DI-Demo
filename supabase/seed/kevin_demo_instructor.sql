-- ============================================================
-- DEMO DATA — instructor "Kevin" + 2 weeks of availability from TODAY.
--
-- Run this manually in the Supabase SQL editor (it is NOT a migration,
-- so it never runs automatically in production). Requires migration 044.
--
-- Safe to re-run: it deletes the previous Kevin demo data first and
-- rebuilds everything relative to today's date in Europe/London.
--
-- Uses the first driving_school_config row. If you have more than one
-- account, set v_account / v_user explicitly below.
--
-- Weekly hours:  Mon–Fri 09:00–19:00, Sat 09:00–14:00, Sun off
-- Day-by-day (d0 = today; dates shift with the day you run it):
--   d0   13:00–19:00                    morning admin
--   d1   09:00–19:00  breaks 12–13, 15–16   lunch + another pupil's test
--   d2   OFF                            training day
--   d3   09:00–19:00  break 12–14       long lunch
--   d4   09:00–19:00  break 12–13       + 17:00 and 18:00 already booked
--   d5   09:00–12:00                    short day
--   d6   weekly default
--   d7   OFF                            annual leave
--   d8   14:00–19:00                    afternoon only
--   d9   09:00–19:00  break 12–13
--   d10  09:00–19:00  break 10–13       car in for service
--   d11  09:00–19:00  break 12–13       + 18:00 already booked
--   d12  OFF                            family commitment
--   d13  weekly default
-- Lessons are 60 minutes, on the hour.
-- ============================================================
DO $$
DECLARE
  v_account uuid;
  v_user    uuid;
  v_kevin   uuid;
  v_pupil   uuid;
  tz        text := 'Europe/London';
  d0        date := (now() AT TIME ZONE 'Europe/London')::date;
BEGIN
  SELECT account_id, user_id INTO v_account, v_user
  FROM driving_school_config
  ORDER BY created_at
  LIMIT 1;

  IF v_account IS NULL THEN
    RAISE EXCEPTION 'No driving_school_config row found — open the Appointments page once to create it.';
  END IF;

  -- ---- Clean up any previous run ------------------------------------
  DELETE FROM lessons
  WHERE account_id = v_account
    AND learner_id IN (
      SELECT id FROM learners WHERE account_id = v_account AND phone = '+440000000001'
    );
  DELETE FROM learners    WHERE account_id = v_account AND phone = '+440000000001';
  DELETE FROM instructors WHERE account_id = v_account AND full_name = 'Kevin';

  -- ---- Kevin --------------------------------------------------------
  INSERT INTO instructors (
    account_id, user_id, full_name, transmission_type, is_active,
    default_hours, lesson_duration_minutes,
    badge_reference, badge_verified, service_areas
  ) VALUES (
    v_account, v_user, 'Kevin', 'both', true,
    '{"mon":{"start":"09:00","end":"19:00"},
      "tue":{"start":"09:00","end":"19:00"},
      "wed":{"start":"09:00","end":"19:00"},
      "thu":{"start":"09:00","end":"19:00"},
      "fri":{"start":"09:00","end":"19:00"},
      "sat":{"start":"09:00","end":"14:00"},
      "sun":null}'::jsonb,
    60, 'ADI-DEMO-0001', true,
    ARRAY['All London', 'SW17', 'SW18', 'SW19', 'SW20', 'KT1', 'KT2', 'KT3',
          'Tooting', 'Wimbledon', 'Kingston', 'Wandsworth', 'Ealing']
  )
  RETURNING id INTO v_kevin;

  -- ---- Day-by-day overrides (NULL start/end = day off) --------------
  INSERT INTO instructor_availability
    (instructor_id, account_id, available_date, start_time, end_time, breaks, reason)
  VALUES
    (v_kevin, v_account, d0,      '13:00', '19:00', '[]', 'Morning admin'),
    (v_kevin, v_account, d0 + 1,  '09:00', '19:00', '[{"start":"12:00","end":"13:00"},{"start":"15:00","end":"16:00"}]', 'Lunch + another pupil''s test'),
    (v_kevin, v_account, d0 + 2,  NULL,    NULL,    '[]', 'Training day'),
    (v_kevin, v_account, d0 + 3,  '09:00', '19:00', '[{"start":"12:00","end":"14:00"}]', 'Long lunch'),
    (v_kevin, v_account, d0 + 4,  '09:00', '19:00', '[{"start":"12:00","end":"13:00"}]', 'Lunch'),
    (v_kevin, v_account, d0 + 5,  '09:00', '12:00', '[]', 'Short day'),
    (v_kevin, v_account, d0 + 7,  NULL,    NULL,    '[]', 'Annual leave'),
    (v_kevin, v_account, d0 + 8,  '14:00', '19:00', '[]', 'Afternoon only'),
    (v_kevin, v_account, d0 + 9,  '09:00', '19:00', '[{"start":"12:00","end":"13:00"}]', 'Lunch'),
    (v_kevin, v_account, d0 + 10, '09:00', '19:00', '[{"start":"10:00","end":"13:00"}]', 'Car in for service'),
    (v_kevin, v_account, d0 + 11, '09:00', '19:00', '[{"start":"12:00","end":"13:00"}]', 'Lunch'),
    (v_kevin, v_account, d0 + 12, NULL,    NULL,    '[]', 'Family commitment');

  -- ---- Placeholder pupil whose lessons occupy some evening slots ----
  -- Inserted directly (not via the app), so no reminders are scheduled
  -- and nothing is ever sent to this fake number.
  INSERT INTO learners (account_id, user_id, full_name, phone, name_confirmed, notes)
  VALUES (v_account, v_user, 'Demo Pupil (blocks Kevin''s slots)', '+440000000001', true,
          'Placeholder that occupies demo slots. Not a real person.')
  RETURNING id INTO v_pupil;

  INSERT INTO lessons
    (account_id, user_id, learner_id, instructor_id, starts_at, ends_at,
     duration_minutes, lesson_type, status, booked_via, notes)
  VALUES
    (v_account, v_user, v_pupil, v_kevin,
     ((d0 + 4)  + time '17:00') AT TIME ZONE tz, ((d0 + 4)  + time '18:00') AT TIME ZONE tz,
     60, 'standard', 'confirmed', 'staff', 'Demo booking'),
    (v_account, v_user, v_pupil, v_kevin,
     ((d0 + 4)  + time '18:00') AT TIME ZONE tz, ((d0 + 4)  + time '19:00') AT TIME ZONE tz,
     60, 'standard', 'confirmed', 'staff', 'Demo booking'),
    (v_account, v_user, v_pupil, v_kevin,
     ((d0 + 11) + time '18:00') AT TIME ZONE tz, ((d0 + 11) + time '19:00') AT TIME ZONE tz,
     60, 'standard', 'confirmed', 'staff', 'Demo booking');

  RAISE NOTICE 'Kevin created (%), availability % → %', v_kevin, d0, d0 + 13;
END $$;

-- Quick check: Kevin's overrides for the next 2 weeks
SELECT a.available_date,
       to_char(a.available_date, 'Dy') AS day,
       COALESCE(a.start_time::text || '–' || a.end_time::text, 'OFF') AS hours,
       a.breaks,
       a.reason
FROM instructor_availability a
JOIN instructors i ON i.id = a.instructor_id
WHERE i.full_name = 'Kevin'
ORDER BY a.available_date;
