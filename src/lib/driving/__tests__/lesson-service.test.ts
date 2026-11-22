import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { countCompletedLessons } from '../lesson-service';

describe('countCompletedLessons — tests are not lessons', () => {
  it('excludes mock_test from the completed-lesson count', async () => {
    const orSpy = vi.fn();
    const lessonsQuery: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) lessonsQuery[m] = vi.fn(() => lessonsQuery);
    lessonsQuery.or = vi.fn((filter: string) => {
      orSpy(filter);
      return Promise.resolve({ count: 4, error: null });
    });

    const learnersQuery: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) learnersQuery[m] = vi.fn(() => learnersQuery);
    learnersQuery.maybeSingle = vi.fn(() => Promise.resolve({ data: { lessons_completed: 1 }, error: null }));

    const db = {
      from: vi.fn((table: string) => (table === 'learners' ? learnersQuery : lessonsQuery)),
    } as unknown as SupabaseClient;

    const result = await countCompletedLessons(db, 'acc', 'lrn');

    expect(orSpy).toHaveBeenCalledWith('lesson_type.is.null,lesson_type.neq.mock_test');
    expect(result).toEqual({ completedInDb: 4, baseCompleted: 1, totalCompleted: 4 });
  });
});
