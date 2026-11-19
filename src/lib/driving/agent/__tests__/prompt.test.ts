import { describe, it, expect } from 'vitest';
import { buildDrivingAgentPrompt } from '../prompt';
import type { DrivingSchoolConfig, Instructor, Learner } from '../../types';

describe('buildDrivingAgentPrompt', () => {
  const mockConfig: DrivingSchoolConfig = {
    id: 'cfg_1',
    account_id: 'acc_1',
    user_id: 'usr_1',
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
  };

  const mockInstructors: Instructor[] = [
    {
      id: 'inst_1',
      account_id: 'acc_1',
      user_id: 'usr_1',
      full_name: 'James Wilson',
      transmission_type: 'manual',
      phone: '+447700900101',
      email: null,
      avatar_url: null,
      is_active: true,
      default_hours: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null },
      lesson_duration_minutes: 60,
      badge_reference: 'ADI/123456',
      badge_verified: true,
      service_areas: ['W5', 'W13', 'Ealing'],
      booking_mode: 'auto',
      min_notice_hours: 12,
      booking_horizon_days: 42,
      max_lessons_per_day: 8,
      buffer_minutes: 15,
      payment_link: null,
      quiet_hours_start: null,
      quiet_hours_end: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  it('includes school name and UK timezone', () => {
    const prompt = buildDrivingAgentPrompt({
      config: mockConfig,
      learnerLessons: [],
      instructors: mockInstructors,
    });

    expect(prompt).toContain('LessonDesk Driving School');
    expect(prompt).toContain('Europe/London');
  });

  it('includes available instructors with transmission type and service areas', () => {
    const prompt = buildDrivingAgentPrompt({
      config: mockConfig,
      learnerLessons: [],
      instructors: mockInstructors,
    });

    expect(prompt).toContain('James Wilson');
    expect(prompt).toContain('manual');
    expect(prompt).toContain('Ealing');
    expect(prompt).toContain('DVSA Approved ADI');
  });

  it('includes the mandatory 5-lesson minimum rule for driving test booking', () => {
    const prompt = buildDrivingAgentPrompt({
      config: mockConfig,
      learnerLessons: [],
      instructors: mockInstructors,
      completedLessonsCount: 2,
    });

    expect(prompt).toContain('5-LESSON MINIMUM FOR TEST BOOKING');
    expect(prompt).toContain('check_test_eligibility');
    expect(prompt).toContain('at least 5 lessons');
  });

  it('includes the new client enquiry intake flow matching demo prompt', () => {
    const prompt = buildDrivingAgentPrompt({
      config: mockConfig,
      learnerLessons: [],
      instructors: mockInstructors,
    });

    expect(prompt).toContain('TYPICAL CONVERSATION FLOW — NEW CLIENT ENQUIRY');
    expect(prompt).toContain('Is this your first time having driving lessons');
    expect(prompt).toContain('what language would you prefer to communicate in');
    expect(prompt).toContain('Full name');
    expect(prompt).toContain('Postcode or area where you live');
    expect(prompt).toContain('valid provisional or full driving licence');
    expect(prompt).toContain('manual or automatic');
    expect(prompt).toContain('particular goal');
  });
});
