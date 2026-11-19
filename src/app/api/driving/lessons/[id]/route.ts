// Lesson — get + update status
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getLesson, transitionLesson } from '@/lib/driving/lesson-service';
import type { LessonStatus } from '@/lib/driving/types';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single();
  if (!profile) return NextResponse.json({ error: 'No profile' }, { status: 403 });

  const lesson = await getLesson(supabase, profile.account_id, id);
  if (!lesson) return NextResponse.json({ error: 'Lesson not found' }, { status: 404 });
  return NextResponse.json(lesson);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single();
  if (!profile) return NextResponse.json({ error: 'No profile' }, { status: 403 });

  const body = await request.json();
  const { status, reason, ...details } = body;

  try {
    const updated = await transitionLesson(
      supabase,
      profile.account_id,
      id,
      status as LessonStatus,
      user.id,
      { reason, ...details },
    );
    return NextResponse.json(updated);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update lesson' },
      { status: 400 },
    );
  }
}
