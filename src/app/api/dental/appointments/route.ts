// Backward-compatible redirect/alias to driving lessons
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { drivingAdmin } from '@/lib/driving/admin-client';
import { listLessons, createLesson } from '@/lib/driving/lesson-service';
import type { LessonStatus } from '@/lib/driving/types';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single();
  if (!profile) return NextResponse.json({ error: 'No profile' }, { status: 403 });

  const db = drivingAdmin();

  const { searchParams } = new URL(request.url);
  const result = await listLessons(db, profile.account_id, {
    instructor_id: searchParams.get('doctor_id') ?? searchParams.get('instructor_id') ?? undefined,
    learner_id: searchParams.get('patient_id') ?? searchParams.get('learner_id') ?? undefined,
    status: (searchParams.get('status') as LessonStatus | null) ?? undefined,
    from_date: searchParams.get('from_date') ?? undefined,
    to_date: searchParams.get('to_date') ?? undefined,
    limit: searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : 50,
    offset: searchParams.get('offset') ? parseInt(searchParams.get('offset')!) : 0,
  });

  return NextResponse.json(result);
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single();
  if (!profile) return NextResponse.json({ error: 'No profile' }, { status: 403 });

  try {
    const body = await request.json();
    const lesson = await createLesson(
      supabase,
      profile.account_id,
      user.id,
      {
        learner_id: body.learner_id || body.patient_id,
        instructor_id: body.instructor_id || body.doctor_id,
        starts_at: body.starts_at,
        duration_minutes: body.duration_minutes,
        lesson_type: body.lesson_type || body.treatment_type,
        notes: body.notes,
      },
    );
    return NextResponse.json(lesson, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create' },
      { status: 400 },
    );
  }
}
