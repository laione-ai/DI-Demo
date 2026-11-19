"use client"

import { useCallback, useEffect, useState } from 'react'
import {
  CalendarDays,
  Clock,
  UserCheck,
  UserX,
  Plus,
  RefreshCw,
  Search,
  Filter,
  ChevronLeft,
  ChevronRight,
  Car,
} from 'lucide-react'
import type {
  Lesson,
  Instructor,
  Learner,
  LessonStatus,
} from '@/lib/driving/types'

// -------------------------------------------------------
// Status badge component
// -------------------------------------------------------
const STATUS_COLORS: Record<LessonStatus, string> = {
  scheduled: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  reminder_sent: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  confirmed: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  pending_approval: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  cancelled: 'bg-red-500/15 text-red-400 border-red-500/30',
  reschedule_requested: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  rescheduled: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
  completed: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  no_show: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
}

const STATUS_LABELS: Record<LessonStatus, string> = {
  scheduled: 'Scheduled',
  reminder_sent: 'Reminder Sent',
  confirmed: 'Confirmed',
  pending_approval: 'Pending Approval',
  cancelled: 'Cancelled',
  reschedule_requested: 'Reschedule Req.',
  rescheduled: 'Rescheduled',
  completed: 'Completed',
  no_show: 'No Show',
}

function StatusBadge({ status }: { status: LessonStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_COLORS[status] || 'bg-muted text-muted-foreground'}`}
    >
      {STATUS_LABELS[status] || status}
    </span>
  )
}

// -------------------------------------------------------
// Stat Card
// -------------------------------------------------------
function StatCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string
  value: number | string
  icon: typeof CalendarDays
  color: string
}) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/30">
      <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg ${color}`}>
        <Icon className="h-6 w-6" />
      </div>
      <div>
        <p className="text-2xl font-bold text-foreground">{value}</p>
        <p className="text-sm text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

// -------------------------------------------------------
// Create Lesson Dialog
// -------------------------------------------------------
function CreateLessonDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
}) {
  const [instructors, setInstructors] = useState<Instructor[]>([])
  const [learners, setLearners] = useState<Learner[]>([])
  const [loading, setLoading] = useState(false)
  const [isNewLearner, setIsNewLearner] = useState(false)
  const [newLearnerName, setNewLearnerName] = useState('')
  const [newLearnerPhone, setNewLearnerPhone] = useState('')
  const [form, setForm] = useState({
    learner_id: '',
    instructor_id: '',
    date: '',
    time: '',
    duration_minutes: 60,
    lesson_type: 'standard',
    notes: '',
  })

  useEffect(() => {
    if (!open) return
    Promise.all([
      fetch('/api/driving/instructors').then((r) => r.json()),
      fetch('/api/driving/learners').then((r) => r.json()),
    ]).then(([insts, lrns]) => {
      setInstructors(insts ?? [])
      setLearners(lrns ?? [])
    })
  }, [open])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      let learnerId = form.learner_id

      if (isNewLearner) {
        if (!newLearnerName.trim() || !newLearnerPhone.trim()) {
          alert('Please enter learner name and phone number')
          setLoading(false)
          return
        }
        const learnerRes = await fetch('/api/driving/learners', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            full_name: newLearnerName.trim(),
            phone: newLearnerPhone.trim(),
          }),
        })
        if (!learnerRes.ok) {
          const err = await learnerRes.json()
          alert(err.error || 'Failed to create learner')
          setLoading(false)
          return
        }
        const newLrn = await learnerRes.json()
        learnerId = newLrn.id
      }

      if (!learnerId) {
        alert('Please select or create a learner')
        setLoading(false)
        return
      }

      const startsAt = new Date(`${form.date}T${form.time}:00`).toISOString()
      const res = await fetch('/api/driving/lessons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          learner_id: learnerId,
          instructor_id: form.instructor_id,
          starts_at: startsAt,
          duration_minutes: form.duration_minutes,
          lesson_type: form.lesson_type || 'standard',
          notes: form.notes || undefined,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        alert(err.error || 'Failed to create lesson')
        return
      }
      onCreated()
      onClose()
      setForm({ learner_id: '', instructor_id: '', date: '', time: '', duration_minutes: 60, lesson_type: 'standard', notes: '' })
      setIsNewLearner(false)
      setNewLearnerName('')
      setNewLearnerPhone('')
    } catch {
      alert('Failed to create lesson')
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <h2 className="mb-6 text-xl font-bold text-foreground">🚗 Book Driving Lesson</h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-sm font-medium text-foreground">Learner</label>
              <button
                type="button"
                onClick={() => setIsNewLearner(!isNewLearner)}
                className="text-xs text-primary hover:underline"
              >
                {isNewLearner ? 'Select existing learner' : '+ New learner'}
              </button>
            </div>
            {isNewLearner ? (
              <div className="flex flex-col gap-2">
                <input
                  type="text"
                  placeholder="Full name"
                  value={newLearnerName}
                  onChange={(e) => setNewLearnerName(e.target.value)}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                  required
                />
                <input
                  type="tel"
                  placeholder="Phone number (+44...)"
                  value={newLearnerPhone}
                  onChange={(e) => setNewLearnerPhone(e.target.value)}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                  required
                />
              </div>
            ) : (
              <select
                value={form.learner_id}
                onChange={(e) => setForm({ ...form, learner_id: e.target.value })}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                required
              >
                <option value="">Select a learner...</option>
                {learners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name} ({p.phone})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">Instructor</label>
            <select
              value={form.instructor_id}
              onChange={(e) => setForm({ ...form, instructor_id: e.target.value })}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              required
            >
              <option value="">Select an instructor...</option>
              {instructors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.full_name} ({d.transmission_type || 'manual'})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">Date</label>
              <input
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">Time</label>
              <input
                type="time"
                value={form.time}
                onChange={(e) => setForm({ ...form, time: e.target.value })}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">Duration (mins)</label>
              <input
                type="number"
                min={30}
                max={240}
                step={15}
                value={form.duration_minutes}
                onChange={(e) => setForm({ ...form, duration_minutes: parseInt(e.target.value) || 60 })}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">Lesson Type</label>
              <select
                value={form.lesson_type}
                onChange={(e) => setForm({ ...form, lesson_type: e.target.value })}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="standard">Standard Lesson</option>
                <option value="intensive">Intensive</option>
                <option value="mock_test">Mock Driving Test</option>
                <option value="refresher">Refresher</option>
                <option value="first_lesson">First Lesson</option>
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">Pickup Location / Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              placeholder="e.g. Pickup at Ealing Broadway station..."
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <div className="mt-2 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? 'Booking...' : 'Book Lesson'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// -------------------------------------------------------
// Main Page Component
// -------------------------------------------------------
export default function LessonsPage() {
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [loading, setLoading] = useState(true)
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 15

  const [filterStatus, setFilterStatus] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [agentEnabled, setAgentEnabled] = useState(false)
  const [togglingAgent, setTogglingAgent] = useState(false)

  const [stats, setStats] = useState({
    total: 0,
    confirmed: 0,
    scheduled: 0,
    noShow: 0,
  })

  const loadLessons = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String((page - 1) * pageSize),
      })
      if (filterStatus) params.set('status', filterStatus)

      const res = await fetch(`/api/driving/lessons?${params}`)
      const data = await res.json()
      setLessons(data.data ?? [])
      setCount(data.count ?? 0)
    } catch (err) {
      console.error('Failed to load lessons:', err)
    } finally {
      setLoading(false)
    }
  }, [page, filterStatus])

  const loadStats = useCallback(async () => {
    try {
      const [totalRes, confirmedRes, scheduledRes, noShowRes] = await Promise.all([
        fetch('/api/driving/lessons?limit=0').then((r) => r.json()),
        fetch('/api/driving/lessons?status=confirmed&limit=0').then((r) => r.json()),
        fetch('/api/driving/lessons?status=scheduled&limit=0').then((r) => r.json()),
        fetch('/api/driving/lessons?status=no_show&limit=0').then((r) => r.json()),
      ])
      setStats({
        total: totalRes.count ?? 0,
        confirmed: confirmedRes.count ?? 0,
        scheduled: scheduledRes.count ?? 0,
        noShow: noShowRes.count ?? 0,
      })
    } catch (err) {
      console.error('Failed to load stats:', err)
    }
  }, [])

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/driving/config')
      if (res.ok) {
        const data = await res.json()
        setAgentEnabled(data.agent_enabled ?? false)
      }
    } catch (err) {
      console.error('Failed to load driving config:', err)
    }
  }, [])

  const toggleAgent = async () => {
    setTogglingAgent(true)
    try {
      const nextState = !agentEnabled
      const res = await fetch('/api/driving/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_enabled: nextState }),
      })
      if (res.ok) {
        setAgentEnabled(nextState)
      } else {
        alert('Failed to update agent status')
      }
    } catch {
      alert('Failed to update agent status')
    } finally {
      setTogglingAgent(false)
    }
  }

  useEffect(() => {
    loadLessons()
    loadStats()
    loadConfig()
  }, [loadLessons, loadStats, loadConfig])

  const handleSeed = async () => {
    setSeeding(true)
    try {
      const res = await fetch('/api/driving/seed', { method: 'POST' })
      const data = await res.json()
      if (res.ok) {
        alert(`Demo driving data seeded successfully! Created ${data.instructors} instructors, ${data.learners} learners, and ${data.lessons} lessons.`)
        loadLessons()
        loadStats()
      } else {
        alert(data.error || 'Seed failed')
      }
    } catch {
      alert('Failed to seed demo data')
    } finally {
      setSeeding(false)
    }
  }

  const handleStatusChange = async (lessonId: string, newStatus: LessonStatus) => {
    try {
      const res = await fetch(`/api/driving/lessons/${lessonId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (res.ok) {
        loadLessons()
        loadStats()
      } else {
        const err = await res.json()
        alert(err.error || 'Failed to update status')
      }
    } catch {
      alert('Failed to update status')
    }
  }

  const handleSendReminder = async (lessonId: string) => {
    try {
      const res = await fetch(`/api/driving/lessons/${lessonId}/remind`, {
        method: 'POST',
      })
      const data = await res.json()
      if (data.success) {
        alert('Reminder sent via WhatsApp!')
        loadLessons()
      } else {
        alert(data.error || 'Failed to send reminder')
      }
    } catch {
      alert('Failed to send reminder')
    }
  }

  const filteredLessons = lessons.filter((a) => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (
      a.learner?.full_name?.toLowerCase().includes(q) ||
      a.learner?.phone?.includes(q) ||
      a.instructor?.full_name?.toLowerCase().includes(q) ||
      a.lesson_type?.toLowerCase().includes(q)
    )
  })

  const totalPages = Math.ceil(count / pageSize)

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">🚗 Driving Lessons</h1>
          <p className="text-sm text-muted-foreground">
            Manage driving lessons, instructors & learner bookings
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={toggleAgent}
            disabled={togglingAgent}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
              agentEnabled
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                : 'border-border bg-card text-muted-foreground hover:bg-muted'
            }`}
            title="Click to toggle the WhatsApp AI booking agent"
          >
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                agentEnabled ? 'bg-emerald-400 animate-pulse' : 'bg-muted-foreground/40'
              }`}
            />
            {agentEnabled ? 'AI Agent: Active' : 'AI Agent: Inactive'}
          </button>
          {stats.total === 0 && (
            <button
              onClick={handleSeed}
              disabled={seeding}
              className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${seeding ? 'animate-spin' : ''}`} />
              {seeding ? 'Seeding...' : 'Seed Demo Driving Data'}
            </button>
          )}
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            Book Lesson
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total Lessons" value={stats.total} icon={CalendarDays} color="bg-primary/10 text-primary" />
        <StatCard label="Confirmed" value={stats.confirmed} icon={UserCheck} color="bg-emerald-500/10 text-emerald-400" />
        <StatCard label="Pending / Scheduled" value={stats.scheduled} icon={Clock} color="bg-amber-500/10 text-amber-400" />
        <StatCard label="No Shows" value={stats.noShow} icon={UserX} color="bg-orange-500/10 text-orange-400" />
      </div>

      {/* Filters & Search */}
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search learner, instructor, phone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-4 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <select
            value={filterStatus}
            onChange={(e) => {
              setFilterStatus(e.target.value)
              setPage(1)
            }}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">All Statuses</option>
            <option value="scheduled">Scheduled</option>
            <option value="reminder_sent">Reminder Sent</option>
            <option value="confirmed">Confirmed</option>
            <option value="pending_approval">Pending Approval</option>
            <option value="reschedule_requested">Reschedule Req.</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="no_show">No Show</option>
          </select>
          <button
            onClick={() => {
              loadLessons()
              loadStats()
            }}
            className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-muted"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {loading ? (
          <div className="flex h-64 items-center justify-center">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : filteredLessons.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-muted-foreground">
            <Car className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm">No driving lessons found</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-muted/30 text-xs font-semibold text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Learner</th>
                  <th className="px-4 py-3">Instructor</th>
                  <th className="px-4 py-3">Date & Time</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredLessons.map((l) => {
                  const startDate = new Date(l.starts_at)
                  return (
                    <tr key={l.id} className="transition-colors hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">
                          {l.learner?.full_name || 'Unknown Learner'}
                        </div>
                        <div className="text-xs text-muted-foreground">{l.learner?.phone}</div>
                      </td>
                      <td className="px-4 py-3 text-foreground">
                        {l.instructor?.full_name || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-foreground">
                          {startDate.toLocaleDateString('en-GB', {
                            weekday: 'short',
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {startDate.toLocaleTimeString('en-GB', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })} ({l.duration_minutes || 60}m)
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="capitalize text-foreground font-medium">
                          {l.lesson_type?.replace('_', ' ') || 'Standard'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={l.status} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {l.status === 'scheduled' && (
                            <button
                              onClick={() => handleSendReminder(l.id)}
                              className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                              title="Send WhatsApp Reminder"
                            >
                              Remind
                            </button>
                          )}
                          {['scheduled', 'reminder_sent', 'pending_approval'].includes(l.status) && (
                            <button
                              onClick={() => handleStatusChange(l.id, 'confirmed')}
                              className="rounded bg-emerald-500/15 border border-emerald-500/30 px-2 py-1 text-xs font-medium text-emerald-400 hover:bg-emerald-500/25"
                            >
                              Confirm
                            </button>
                          )}
                          {l.status === 'confirmed' && (
                            <button
                              onClick={() => handleStatusChange(l.id, 'completed')}
                              className="rounded bg-slate-500/15 border border-slate-500/30 px-2 py-1 text-xs font-medium text-slate-400 hover:bg-slate-500/25"
                            >
                              Complete
                            </button>
                          )}
                          {!['cancelled', 'completed', 'rescheduled'].includes(l.status) && (
                            <button
                              onClick={() => handleStatusChange(l.id, 'cancelled')}
                              className="rounded bg-red-500/15 border border-red-500/30 px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-500/25"
                            >
                              Cancel
                            </button>
                          )}
                          <a
                            href={`/api/driving/lessons/${l.id}/ics`}
                            className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                            title="Download .ics calendar"
                          >
                            .ics
                          </a>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
            <span className="text-xs text-muted-foreground">
              Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, count)} of {count}
            </span>
            <div className="flex gap-1">
              <button
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                className="rounded border border-border p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
                className="rounded border border-border p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      <CreateLessonDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={() => {
          loadLessons()
          loadStats()
        }}
      />
    </div>
  )
}
