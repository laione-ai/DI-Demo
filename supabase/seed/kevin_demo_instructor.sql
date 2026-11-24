-- ============================================================
-- DEMO DATA — instructor "Kevin" + 2 weeks of availability from TODAY.
--
-- Run this manually in the Supabase SQL editor (it is NOT a migration,
-- so it never runs automatically in production). Requires migration 044.
--
-- Safe to re-run: Kevin is updated IN PLACE (never deleted, because
-- deleting an instructor cascades to every lesson booked with him), his
-- day-by-day overrides and the placeholder pupil's lessons are rebuilt
-- relative to today's date in Europe/London. Real bookings are kept.
--
-- WHICH ACCOUNT: Kevin is added to the account that owns the WhatsApp
-- conversation with the phone number in `v_test_phone` below (the number
-- you are testing from). If that number isn't found and there is exactly
-- one school account, that one is used. Otherwise the script stops and
-- lists the accounts, instead of guessing.
--
-- Weekly hours:  Mon–Fri 09:00–19:00, Sat 09:00–14:00, Sun off
-- Day-by-day, for THIS week and next (Mon = this week's Monday). Days
-- before today are simply in the past; the agent shows today onwards.
--   Mon   13:00–19:00                     morning admin
--   Tue   09:00–19:00  breaks 12–13, 15–16 lunch + another pupil's test
--   Wed   OFF                             training day
--   Thu   09:00–19:00  break 12–14        long lunch
--   Fri   09:00–19:00  break 12–13        + 17:00 and 18:00 already booked
--   Sat   09:00–12:00                     short day
--   Sun   off (weekly default)
--   Mon   OFF                             annual leave
--   Tue   14:00–19:00                     afternoon only
--   Wed   09:00–19:00  break 12–13
--   Thu   09:00–19:00  break 10–13        car in for service
--   Fri   09:00–19:00  break 12–13        + 18:00 already booked
--   Sat   OFF                             family commitment
--   Sun   off (weekly default)
-- Anything after that uses the weekly hours.
-- Lessons are 60 minutes, on the hour. Minimum notice: 2 hours.
-- ============================================================
DO $$
DECLARE
  -- Digits of the WhatsApp number you test from (any format is fine).
  v_test_phone text := '447448165366';
  v_account uuid;
  v_user    uuid;
  v_n       int;
  v_slot    record;
  v_kevin   uuid;
  v_pupil   uuid;
  tz        text := 'Europe/London';
  wk        date := date_trunc('week', (now() AT TIME ZONE 'Europe/London'))::date;  -- this week's Monday
BEGIN
  -- 1) The account that owns the test conversation
  SELECT c.account_id INTO v_account
  FROM contacts c
  WHERE regexp_replace(c.phone, '\D', '', 'g') LIKE '%' || right(regexp_replace(v_test_phone, '\D', '', 'g'), 10)
  ORDER BY c.created_at DESC
  LIMIT 1;

  -- 2) Otherwise, the only school account (if there is exactly one)
  IF v_account IS NULL THEN
    SELECT count(*) INTO v_n FROM driving_school_config;
    IF v_n = 1 THEN
      SELECT account_id INTO v_account FROM driving_school_config;
    ELSE
      RAISE EXCEPTION 'Could not pick an account: test phone % not found and there are % school accounts (%). Set v_test_phone to the number you message from.',
        v_test_phone, v_n,
        (SELECT string_agg(account_id::text || ' = ' || coalesce(school_name, '?'), ', ') FROM driving_school_config);
    END IF;
  END IF;

  SELECT user_id INTO v_user FROM driving_school_config WHERE account_id = v_account;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Account % has no driving_school_config row. Open the Appointments page once while logged in to that account, then re-run.', v_account;
  END IF;

  -- ---- Kevin (update in place, or create) ----------------------------
  SELECT id INTO v_kevin
  FROM instructors
  WHERE account_id = v_account AND full_name = 'Kevin'
  ORDER BY created_at
  LIMIT 1;

  IF v_kevin IS NULL THEN
    INSERT INTO instructors (account_id, user_id, full_name)
    VALUES (v_account, v_user, 'Kevin')
    RETURNING id INTO v_kevin;
  END IF;

  UPDATE instructors SET
    transmission_type       = 'both',
    is_active               = true,
    default_hours           = '{"mon":{"start":"09:00","end":"19:00"},
                                "tue":{"start":"09:00","end":"19:00"},
                                "wed":{"start":"09:00","end":"19:00"},
                                "thu":{"start":"09:00","end":"19:00"},
                                "fri":{"start":"09:00","end":"19:00"},
                                "sat":{"start":"09:00","end":"14:00"},
                                "sun":null}'::jsonb,
    lesson_duration_minutes = 60,
    min_notice_hours        = 2,
    badge_reference         = 'ADI-DEMO-0001',
    badge_verified          = true,
    service_areas           = ARRAY['All London', 'SW17', 'SW18', 'SW19', 'SW20', 'KT1', 'KT2', 'KT3',
                                    'Tooting', 'Wimbledon', 'Kingston', 'Wandsworth', 'Ealing'],
    updated_at              = now()
  WHERE id = v_kevin;

  -- ---- Clear previous demo data (never real learners' bookings) -------
  DELETE FROM instructor_availability WHERE instructor_id = v_kevin;
  DELETE FROM lessons
  WHERE account_id = v_account
    AND learner_id IN (
      SELECT id FROM learners WHERE account_id = v_account AND phone = '+440000000001'
    );
  DELETE FROM learners WHERE account_id = v_account AND phone = '+440000000001';

  -- ---- Day-by-day overrides (NULL start/end = day off) --------------
  INSERT INTO instructor_availability
    (instructor_id, account_id, available_date, start_time, end_time, breaks, reason)
  VALUES
    (v_kevin, v_account, wk,      '13:00', '19:00', '[]', 'Morning admin'),
    (v_kevin, v_account, wk + 1,  '09:00', '19:00', '[{"start":"12:00","end":"13:00"},{"start":"15:00","end":"16:00"}]', 'Lunch + another pupil''s test'),
    (v_kevin, v_account, wk + 2,  NULL,    NULL,    '[]', 'Training day'),
    (v_kevin, v_account, wk + 3,  '09:00', '19:00', '[{"start":"12:00","end":"14:00"}]', 'Long lunch'),
    (v_kevin, v_account, wk + 4,  '09:00', '19:00', '[{"start":"12:00","end":"13:00"}]', 'Lunch'),
    (v_kevin, v_account, wk + 5,  '09:00', '12:00', '[]', 'Short day'),
    (v_kevin, v_account, wk + 7,  NULL,    NULL,    '[]', 'Annual leave'),
    (v_kevin, v_account, wk + 8,  '14:00', '19:00', '[]', 'Afternoon only'),
    (v_kevin, v_account, wk + 9,  '09:00', '19:00', '[{"start":"12:00","end":"13:00"}]', 'Lunch'),
    (v_kevin, v_account, wk + 10, '09:00', '19:00', '[{"start":"10:00","end":"13:00"}]', 'Car in for service'),
    (v_kevin, v_account, wk + 11, '09:00', '19:00', '[{"start":"12:00","end":"13:00"}]', 'Lunch'),
    (v_kevin, v_account, wk + 12, NULL,    NULL,    '[]', 'Family commitment');

  -- ---- Placeholder pupil whose lessons occupy some evening slots ----
  -- Inserted directly (not via the app), so no reminders are scheduled
  -- and nothing is ever sent to this fake number.
  INSERT INTO learners (account_id, user_id, full_name, phone, name_confirmed, notes)
  VALUES (v_account, v_user, 'Demo Pupil (blocks Kevin''s slots)', '+440000000001', true,
          'Placeholder that occupies demo slots. Not a real person.')
  RETURNING id INTO v_pupil;

  -- Each placeholder lesson is skipped if a real learner already has that slot.
  FOR v_slot IN
    SELECT * FROM (VALUES (4, time '17:00'), (4, time '18:00'), (11, time '18:00')) AS t(day_offset, start_time)
    WHERE ((wk + day_offset) + start_time) AT TIME ZONE 'Europe/London' > now()   -- only future demo bookings
  LOOP
    BEGIN
      INSERT INTO lessons
        (account_id, user_id, learner_id, instructor_id, starts_at, ends_at,
         duration_minutes, lesson_type, status, booked_via, notes)
      VALUES
        (v_account, v_user, v_pupil, v_kevin,
         ((wk + v_slot.day_offset) + v_slot.start_time) AT TIME ZONE tz,
         ((wk + v_slot.day_offset) + v_slot.start_time + interval '1 hour') AT TIME ZONE tz,
         60, 'standard', 'confirmed', 'staff', 'Demo booking');
    EXCEPTION WHEN exclusion_violation THEN
      RAISE NOTICE 'Skipped demo booking on % % (slot already taken)', wk + v_slot.day_offset, v_slot.start_time;
    END;
  END LOOP;

  RAISE NOTICE 'Kevin ready (%) in account %, overrides % → %', v_kevin, v_account, wk, wk + 13;
END $$;

-- Quick check: Kevin's overrides for the next 2 weeks
SELECT i.account_id,
       a.available_date,
       to_char(a.available_date, 'Dy') AS day,
       COALESCE(a.start_time::text || '–' || a.end_time::text, 'OFF') AS hours,
       a.breaks,
       a.reason
FROM instructor_availability a
JOIN instructors i ON i.id = a.instructor_id
WHERE i.full_name = 'Kevin'
ORDER BY a.available_date;
