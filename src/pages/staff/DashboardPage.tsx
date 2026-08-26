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
  const [togglingId, setTogglingId] = useState<string | null>(null);

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

  // FR-213: キューごとにワンタップで受付を開始・停止する。
  // queues.is_open への直接UPDATEは、一般スタッフでもRLSの staff_toggle_queue
  // ポリシー(supabase/migrations/20260826000003_rls.sql)で許可されている。
  // (tickets と違い、queuesの開閉トグルはRPC必須ルールの対象外)
  async function toggleOpen(q: QueueRow) {
    if (togglingId) return;
    setTogglingId(q.id);
    const nextOpen = !q.is_open;
    const { error } = await supabase.from('queues').update({ is_open: nextOpen }).eq('id', q.id);
    if (!error) {
      setQueues((prev) => prev.map((x) => (x.id === q.id ? { ...x, is_open: nextOpen } : x)));
    } else {
      window.alert(`受付状態の切り替えに失敗しました: ${error.message}`);
    }
    setTogglingId(null);
  }

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
            <div
              key={q.id}
              className="w-72 rounded-xl border border-neutral-200 bg-white shadow-sm p-5 relative overflow-hidden"
            >
              <span className="absolute left-0 top-0 bottom-0 w-2" style={{ backgroundColor: q.color }} />
              <div className="pl-2">
                <div className="text-lg font-bold mb-3">{tj(q.name, 'ja')}</div>
                <div className="text-sm text-neutral-600 space-y-1">
                  <div>待機 {st?.waiting_count ?? 0}組</div>
                  <div>目安 {formatWaitSeconds(st?.estimated_wait_seconds ?? 0, 'ja')}</div>
                  <div>呼出中 {st?.now_serving_number ?? '—'}</div>
                </div>

                <button
                  onClick={() => void toggleOpen(q)}
                  disabled={togglingId === q.id}
                  className={`mt-3 w-full rounded-lg px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ${
                    q.is_open
                      ? 'bg-green-50 text-green-700 hover:bg-green-100'
                      : 'bg-neutral-100 text-neutral-500 hover:bg-neutral-200'
                  }`}
                >
                  {togglingId === q.id ? '切替中…' : q.is_open ? '● 受付中（タップで停止）' : '● 受付停止中（タップで再開）'}
                </button>

                <Link
                  to={`/staff/q/${q.id}`}
                  className="mt-3 block text-sm font-semibold text-[var(--color-primary)]"
                >
                  管理画面へ →
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
