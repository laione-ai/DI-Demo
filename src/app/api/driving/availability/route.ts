// Check instructor availability
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getAvailableSlots } from '@/lib/driving/availability-service';
import { loadSchoolConfig } from '@/lib/driving/config';

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

  const { searchParams } = new URL(request.url);
  const instructorId = searchParams.get('instructor_id');
  const fromDate = searchParams.get('from_date');
  const toDate = searchParams.get('to_date');
  const duration = searchParams.get('duration_minutes');

  if (!instructorId || !fromDate || !toDate) {
    return NextResponse.json(
      { error: 'instructor_id, from_date, and to_date are required' },
      { status: 400 },
    );
  }

  const config = await loadSchoolConfig(supabase, profile.account_id, user.id);
  const durationMinutes = duration ? parseInt(duration) : config.default_lesson_minutes || 60;

  try {
    const slots = await getAvailableSlots(
      supabase,
      profile.account_id,
      instructorId,
      fromDate,
      toDate,
      config.school_timezone,
      durationMinutes,
    );
    return NextResponse.json(slots);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get slots' },
      { status: 400 },
    );
  }
}
