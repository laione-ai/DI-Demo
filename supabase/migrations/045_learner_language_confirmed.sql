-- ============================================================
-- Migration 045: learners.language_confirmed
--
-- The driving agent now asks one intake question per message and
-- works out the next question from what is on file. `preferred_language`
-- defaults to 'en', so "never asked" and "asked, said English" look the
-- same. This flag records that the learner actually answered.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE learners
  ADD COLUMN IF NOT EXISTS language_confirmed boolean NOT NULL DEFAULT false;

-- Anyone who already picked a non-default language has clearly answered.
UPDATE learners
SET language_confirmed = true
WHERE language_confirmed = false
  AND preferred_language IS NOT NULL
  AND lower(preferred_language) NOT IN ('en', '');
