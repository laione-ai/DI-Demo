// Trigger manual lesson reminder
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getLesson } from '@/lib/driving/lesson-service';
import { loadSchoolConfig } from '@/lib/driving/config';
import type { LessonWithLearner } from '@/lib/driving/types';
import { createWhatsAppService, sendLessonReminder } from '@/lib/driving/whatsapp-service';

export async function POST(
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
  if (!lesson.learner) {
    return NextResponse.json({ error: 'Lesson has no learner' }, { status: 422 });
  }

  const config = await loadSchoolConfig(supabase, profile.account_id, user.id);
  const waService = createWhatsAppService(supabase, config.demo_mode);

  const syntheticReminder = {
    id: `manual_${Date.now()}`,
    lesson_id: lesson.id,
    account_id: profile.account_id,
    reminder_type: 'initial_12h' as const,
    status: 'pending' as const,
    scheduled_at: new Date().toISOString(),
    sent_at: null,
    delivered_at: null,
    whatsapp_message_id: null,
    error_message: null,
    sequence_number: 1,
    created_at: new Date().toISOString(),
  };

  const res = await sendLessonReminder(
    supabase,
    waService,
    lesson as LessonWithLearner,
    syntheticReminder,
    config,
  );

  return NextResponse.json(res);
}
