import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import { tj } from '../../lib/i18n';
import { formatWaitSeconds } from '../../lib/format';
import type { QueueRow } from '../../lib/types';

interface QueueStateRow {
  queue_id: string;
  waiting_count: number;
  estimated_wait_seconds: number;
  now_serving_number: string | null;
}

export default function DashboardPage() {
  const { staff, signOut } = useAuth();
  const [queues, setQueues] = useState<QueueRow[]>([]);
  const [states, setStates] = useState<Record<string, QueueStateRow>>({});
  const [tenantName, setTenantName] = useState('');

  useEffect(() => {
    if (!staff) return;
    (async () => {
      const [{ data: qs }, { data: st }, { data: tn }] = await Promise.all([
        supabase
          .from('queues')
          .select(
            'id, tenant_id, name, color, is_open, long_wait_warn_minutes, ask_party_size, party_size_options, ask_room_number, ask_seat_preference, seat_options',
          )
          .eq('tenant_id', staff.tenant_id)
          .order('sort_order'),
        supabase
          .from('queue_states')
          .select('queue_id, waiting_count, estimated_wait_seconds, now_serving_number')
          .eq('tenant_id', staff.tenant_id),
        supabase.from('tenants').select('name').eq('id', staff.tenant_id).maybeSingle(),
      ]);
      setQueues((qs ?? []) as QueueRow[]);
      const map: Record<string, QueueStateRow> = {};
      ((st ?? []) as QueueStateRow[]).forEach((s) => {
        map[s.queue_id] = s;
      });
      setStates(map);
      setTenantName((tn as { name: string } | null)?.name ?? '');
    })();
  }, [staff]);

  return (
    <div className="min-h-screen p-6">
      <header className="flex items-center justify-between mb-8">
        <h1 className="text-xl font-bold">{tenantName || 'MACHIAI'}</h1>
        <div className="flex items-center gap-4 text-sm">
          <span>{staff?.display_name}</span>
          <button onClick={() => void signOut()} className="underline text-neutral-500">
            ログアウト
          </button>
        </div>
      </header>

      {queues.length === 0 && <p className="text-neutral-400">キューがまだありません。</p>}

      <div className="flex flex-wrap gap-6">
        {queues.map((q) => {
          const st = states[q.id];
          return (
            <Link
              key={q.id}
              to={`/staff/q/${q.id}`}
              className="w-72 rounded-xl border border-neutral-200 bg-white shadow-sm p-5 relative overflow-hidden block"
            >
              <span className="absolute left-0 top-0 bottom-0 w-2" style={{ backgroundColor: q.color }} />
              <div className="pl-2">
                <div className="text-lg font-bold mb-3">{tj(q.name, 'ja')}</div>
                <div className="text-sm text-neutral-600 space-y-1">
                  <div>待機 {st?.waiting_count ?? 0}組</div>
                  <div>目安 {formatWaitSeconds(st?.estimated_wait_seconds ?? 0, 'ja')}</div>
                  <div>呼出中 {st?.now_serving_number ?? '—'}</div>
                  <div>{q.is_open ? '● 受付中' : '● 受付停止中'}</div>
                </div>
                <div className="mt-4 text-sm font-semibold text-[var(--color-primary)]">管理画面へ →</div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
