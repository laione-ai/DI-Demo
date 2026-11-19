// Download .ics for a lesson
import { NextResponse } from 'next/server';
import { drivingAdmin } from '@/lib/driving/admin-client';
import { getLesson } from '@/lib/driving/lesson-service';
import { loadSchoolConfig } from '@/lib/driving/config';
import { generateIcs } from '@/lib/driving/calendar';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = drivingAdmin();

  const { data: lessonRec } = await db
    .from('lessons')
    .select('account_id')
    .eq('id', id)
    .single();

  if (!lessonRec) {
    return new NextResponse('Lesson not found', { status: 404 });
  }

  const lesson = await getLesson(db, lessonRec.account_id, id);
  if (!lesson) {
    return new NextResponse('Lesson not found', { status: 404 });
  }

  const config = await loadSchoolConfig(db, lessonRec.account_id);
  const ics = generateIcs(lesson, config);

  return new NextResponse(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="lesson-${id}.ics"`,
    },
  });
}
