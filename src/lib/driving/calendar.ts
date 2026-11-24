// ============================================================
// Driving School — Calendar Link & .ics Generator.
//
// Creates Google Calendar deep links and iCalendar (.ics) files
// for driving lessons.
// ============================================================

import type { Lesson, DrivingSchoolConfig } from './types';
import { formatInSchoolTimezone } from './config';

/**
 * Build a Google Calendar deep link for a driving lesson.
 */
export function buildGoogleCalendarLink(
  lesson: Lesson,
  config: DrivingSchoolConfig,
): string {
  const startIso = lesson.starts_at.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const endIso = lesson.ends_at.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const instructorName = lesson.instructor?.full_name ?? 'Instructor';
  const lessonType = lesson.lesson_type === 'mock_test' ? 'Driving Mock Test' : 'Driving Lesson';
  const title = encodeURIComponent(`${lessonType} with ${instructorName}`);
  const location = encodeURIComponent(config.school_address || config.school_name);

  return (
    `https://calendar.google.com/calendar/render?action=TEMPLATE` +
    // Kept short on purpose: the title already names the instructor, and a
    // long encoded URL is ugly in WhatsApp and the inbox.
    `&text=${title}&dates=${startIso}/${endIso}&location=${location}`
  );
}

/**
 * Generate a standard iCalendar (.ics) format string for a driving lesson.
 */
export function generateIcs(
  lesson: Lesson,
  config: DrivingSchoolConfig,
): string {
  const startIso = lesson.starts_at.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const endIso = lesson.ends_at.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const nowIso = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const instructorName = lesson.instructor?.full_name ?? 'Instructor';
  const lessonType = lesson.lesson_type === 'mock_test' ? 'Driving Mock Test' : 'Driving Lesson';
  const summary = `${lessonType} with ${instructorName}`;
  const description = `Driving lesson arranged with ${config.school_name}. Instructor: ${instructorName}.`;
  const location = config.school_address || config.school_name;
  const uid = lesson.calendar_uid || `driving-${lesson.id}@${config.school_name.replace(/\s+/g, '-').toLowerCase()}`;

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LessonDesk//Driving Booking Agent//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${nowIso}`,
    `DTSTART:${startIso}`,
    `DTEND:${endIso}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    `LOCATION:${location}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'BEGIN:VALARM',
    'TRIGGER:-PT1H', // 1 hour reminder
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder: Driving lesson in 1 hour',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

/**
 * Build calendar links (Google deep link and downloadable .ics URL).
 */
export function buildCalendarLinks(
  lesson: Lesson,
  config: DrivingSchoolConfig,
  baseUrl?: string,
): { googleUrl: string; icsUrl?: string } {
  const googleUrl = buildGoogleCalendarLink(lesson, config);
  const icsUrl = baseUrl
    ? `${baseUrl}/api/driving/lessons/${lesson.id}/ics`
    : undefined;
  return { googleUrl, icsUrl };
}

/**
 * Format calendar links for a WhatsApp message.
 */
export function formatCalendarLinksForWhatsApp(
  lesson: Lesson,
  config: DrivingSchoolConfig,
): string {
  const googleUrl = buildGoogleCalendarLink(lesson, config);
  return `Add it to your calendar: ${googleUrl}`;
}
