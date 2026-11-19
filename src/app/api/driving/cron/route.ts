// Driving School Cron — process reminders + auto-complete lessons
import { NextResponse } from 'next/server';
import { drivingAdmin } from '@/lib/driving/admin-client';
import { processDueReminders } from '@/lib/driving/reminder-service';
import { autoCompleteLessons } from '@/lib/driving/lesson-service';
import { loadSchoolConfig } from '@/lib/driving/config';

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const secret = process.env.DRIVING_CRON_SECRET ?? process.env.DENTAL_CRON_SECRET ?? process.env.AUTOMATION_CRON_SECRET;

  if (secret && authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = drivingAdmin();

  // 1. Auto-complete past lessons
  const completed = await autoCompleteLessons(db);

  // 2. Process due reminders for all driving accounts
  const { data: configs } = await db
    .from('driving_school_config')
    .select('*');

  let totalSent = 0;
  let totalFailed = 0;

  for (const config of configs ?? []) {
    const res = await processDueReminders(db, config);
    totalSent += res.sent;
    totalFailed += res.failed;
  }

  return NextResponse.json({
    ok: true,
    auto_completed_lessons: completed,
    reminders_sent: totalSent,
    reminders_failed: totalFailed,
  });
}
