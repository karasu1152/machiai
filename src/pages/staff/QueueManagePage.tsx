import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase, BASE_URL } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import { tj } from '../../lib/i18n';
import { formatElapsedMinutes } from '../../lib/format';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import type { CounterRow, NoShowTicket, QueueRow, TicketRow } from '../../lib/types';

const CALL_NEXT_COOLDOWN_MS = 2000; // FR-203: 連打防止

export default function QueueManagePage() {
  const { queueId } = useParams<{ queueId: string }>();
  const { staff } = useAuth();
  const online = useOnlineStatus();

  const [queue, setQueue] = useState<QueueRow | null>(null);
  const [counters, setCounters] = useState<CounterRow[]>([]);
  const [selectedCounterId, setSelectedCounterId] = useState<string | null>(null);
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const [callingNext, setCallingNext] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [showNoShowModal, setShowNoShowModal] = useState(false);
  const [noShowList, setNoShowList] = useState<NoShowTicket[]>([]);
  const [showProxyModal, setShowProxyModal] = useState(false);

  // ---- 初期データ取得 ----
  const fetchAll = useCallback(async () => {
    if (!queueId) return;
    const [{ data: q }, { data: cs }, { data: tix }] = await Promise.all([
      supabase.from('queues').select('*').eq('id', queueId).maybeSingle(),
      supabase
        .from('counters')
        .select('*')
        .or(`queue_id.eq.${queueId},queue_id.is.null`)
        .eq('is_active', true)
        .order('sort_order'),
      supabase
        .from('tickets')
        .select(
          'id, display_number, status, party_size, room_number, seat_preference, note, issued_at, called_at, last_called_at, called_count, counter_id, sort_key, print_status',
        )
        .eq('queue_id', queueId)
        .in('status', ['waiting', 'called', 'serving'])
        .order('sort_key', { ascending: true }),
    ]);
    setQueue((q as QueueRow) ?? null);
    setCounters((cs ?? []) as CounterRow[]);
    setTickets((tix ?? []) as TicketRow[]);
  }, [queueId]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  // ---- ticketsのRealtime購読 (05_API仕様書.md 5.3節) ----
  useEffect(() => {
    if (!queueId) return;
    const channel = supabase
      .channel(`staff:${queueId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tickets', filter: `queue_id=eq.${queueId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as { id: string };
            setTickets((prev) => prev.filter((t) => t.id !== oldRow.id));
            return;
          }
          const row = payload.new as TicketRow;
          const isActive = row.status === 'waiting' || row.status === 'called' || row.status === 'serving';
          setTickets((prev) => {
            const rest = prev.filter((t) => t.id !== row.id);
            if (!isActive) return rest; // done/no_show/canceledは一覧から外す
            return [...rest, row].sort((a, b) => a.sort_key - b.sort_key);
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queueId]);

  // ---- 経過時間表示用のタイマーは1本だけ (08_開発指示プロンプト.md 必須ルール7) ----
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const waiting = tickets.filter((t) => t.status === 'waiting');
  const activeCalls = tickets.filter((t) => t.status === 'called' || t.status === 'serving').slice(0, 3);
  const warnMinutes = queue?.long_wait_warn_minutes ?? 20;

  async function handleCallNext() {
    if (callingNext || !queueId) return;
    setCallingNext(true);
    setActionError(null);
    try {
      const { data, error } = await supabase.rpc('call_next', {
        p_queue_id: queueId,
        p_counter_id: selectedCounterId,
      });
      if (error) throw error;
      const res = data as { ok: boolean; error?: string };
      if (!res.ok) {
        setActionError(res.error === 'NO_WAITING' ? '待機中のお客様はいません' : `エラー: ${res.error}`);
      }
    } catch {
      setActionError('通信エラーが発生しました');
    } finally {
      window.setTimeout(() => setCallingNext(false), CALL_NEXT_COOLDOWN_MS);
    }
  }

  async function handleCallTicket(ticketId: string) {
    setActionError(null);
    const { error } = await supabase.rpc('call_ticket', {
      p_ticket_id: ticketId,
      p_counter_id: selectedCounterId,
    });
    if (error) setActionError('通信エラーが発生しました');
  }

  async function handleSetStatus(
    ticketId: string,
    status: 'serving' | 'done' | 'no_show' | 'canceled',
    confirmMessage?: string,
  ) {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setActionError(null);
    const { error } = await supabase.rpc('set_ticket_status', {
      p_ticket_id: ticketId,
      p_status: status,
      p_reason: null,
    });
    if (error) setActionError('通信エラーが発生しました');
  }

  async function openNoShowModal() {
    if (!queueId) return;
    const { data } = await supabase
      .from('tickets')
      .select('id, display_number, party_size, no_show_at')
      .eq('queue_id', queueId)
      .eq('status', 'no_show')
      .order('no_show_at', { ascending: false });
    setNoShowList((data ?? []) as NoShowTicket[]);
    setShowNoShowModal(true);
  }

  async function handleRequeue(ticketId: string, position: 'head' | 'tail') {
    const { error } = await supabase.rpc('requeue_ticket', { p_ticket_id: ticketId, p_position: position });
    if (error) {
      setActionError('通信エラーが発生しました');
      return;
    }
    setNoShowList((prev) => prev.filter((t) => t.id !== ticketId));
  }

  if (!queue) {
    return <div className="min-h-screen flex items-center justify-center text-neutral-400">…</div>;
  }

  return (
    <div className="min-h-screen flex flex-col">
      {!online && (
        <div className="bg-[var(--color-danger)] text-white text-center py-2 text-sm font-semibold">
          オフラインです。復旧をお待ちください
        </div>
      )}

      <header className="flex items-center justify-between px-6 py-4 border-b border-neutral-200">
        <div className="flex items-center gap-4">
          <Link to="/staff" className="text-sm text-neutral-500 underline">
            ←
          </Link>
          <h1 className="text-lg font-bold">{tj(queue.name, 'ja')}</h1>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span>窓口:</span>
          <select
            value={selectedCounterId ?? ''}
            onChange={(e) => setSelectedCounterId(e.target.value || null)}
            className="border border-neutral-300 rounded px-2 h-9"
          >
            <option value="">(未選択)</option>
            {counters.map((c) => (
              <option key={c.id} value={c.id}>
                {tj(c.name, 'ja')}
              </option>
            ))}
          </select>
          <span className="text-neutral-400">{staff?.display_name}</span>
        </div>
      </header>

      {actionError && (
        <div className="bg-amber-50 text-amber-800 text-sm px-6 py-2 border-b border-amber-200">
          {actionError}
        </div>
      )}

      <main className="flex-1 grid grid-cols-1 md:grid-cols-[320px_1fr] gap-6 p-6">
        {/* 左: 次を呼ぶ + 本日の状況 + 操作 */}
        <div className="flex flex-col gap-4">
          <button
            onClick={() => void handleCallNext()}
            disabled={callingNext || waiting.length === 0}
            className="h-40 rounded-xl bg-[var(--color-primary)] text-white font-bold text-2xl disabled:bg-neutral-300 disabled:cursor-not-allowed flex flex-col items-center justify-center gap-2"
          >
            <span>次を呼ぶ</span>
            <span className="text-lg font-normal">
              {waiting.length > 0 ? waiting[0].display_number : '待機なし'}
            </span>
          </button>

          <button
            onClick={() => setShowProxyModal(true)}
            className="h-12 rounded-lg border border-neutral-300 font-medium"
          >
            代理発券
          </button>
          <button
            onClick={() => void openNoShowModal()}
            className="h-12 rounded-lg border border-neutral-300 font-medium"
          >
            不在リスト
          </button>
        </div>

        {/* 右: 呼出中 + 待機列 */}
        <div className="flex flex-col gap-6">
          <section>
            <h2 className="font-semibold mb-2">呼出中</h2>
            {activeCalls.length === 0 && <p className="text-sm text-neutral-400">呼出中のお客様はいません</p>}
            <div className="flex flex-col gap-2">
              {activeCalls.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between border border-neutral-200 rounded-lg px-4 py-3"
                >
                  <div>
                    <span className="font-bold text-lg mr-3">{t.display_number}</span>
                    {t.party_size != null && <span className="text-sm text-neutral-500 mr-2">{t.party_size}名</span>}
                    <span className="text-sm text-neutral-500">
                      {formatElapsedMinutes(t.last_called_at ?? t.called_at ?? t.issued_at, now)}分経過
                    </span>
                    {t.status === 'serving' && (
                      <span className="ml-2 text-xs text-[var(--color-primary)] font-semibold">案内中</span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {t.status === 'called' && (
                      <button
                        onClick={() => void handleSetStatus(t.id, 'serving')}
                        className="px-3 h-9 rounded bg-[var(--color-primary)] text-white text-sm font-medium"
                      >
                        ご案内
                      </button>
                    )}
                    <button
                      onClick={() => void handleCallTicket(t.id)}
                      className="px-3 h-9 rounded border border-neutral-300 text-sm font-medium"
                    >
                      再呼出
                    </button>
                    <button
                      onClick={() => void handleSetStatus(t.id, 'done')}
                      className="px-3 h-9 rounded border border-neutral-300 text-sm font-medium"
                    >
                      完了
                    </button>
                    <button
                      onClick={() =>
                        void handleSetStatus(t.id, 'no_show', `${t.display_number} を不在にしますか?`)
                      }
                      className="px-3 h-9 rounded border border-neutral-300 text-sm font-medium text-[var(--color-danger)]"
                    >
                      不在
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="font-semibold mb-2">待機中 {waiting.length}組</h2>
            <div className="flex flex-col gap-1">
              {waiting.map((t) => {
                const elapsed = formatElapsedMinutes(t.issued_at, now);
                const warn = elapsed >= warnMinutes * 1.5 ? 'red' : elapsed >= warnMinutes ? 'yellow' : null;
                return (
                  <div
                    key={t.id}
                    className={
                      'flex items-center justify-between rounded-lg px-4 py-2 border ' +
                      (warn === 'red'
                        ? 'bg-red-50 border-red-200'
                        : warn === 'yellow'
                          ? 'bg-amber-50 border-amber-200'
                          : 'border-neutral-200')
                    }
                  >
                    <div className="flex items-center gap-4 text-sm">
                      <span className="font-bold text-base w-16">{t.display_number}</span>
                      {t.party_size != null && <span>{t.party_size}名</span>}
                      {t.seat_preference && <span className="text-neutral-500">{t.seat_preference}</span>}
                      {t.room_number && <span className="text-neutral-500">Room {t.room_number}</span>}
                      <span className={warn ? 'font-semibold' : 'text-neutral-500'}>
                        {elapsed}分 {warn && '⚠'}
                      </span>
                    </div>
                    <button
                      onClick={() => void handleCallTicket(t.id)}
                      className="px-3 h-8 rounded border border-neutral-300 text-xs font-medium"
                    >
                      この人を呼ぶ
                    </button>
                  </div>
                );
              })}
              {waiting.length === 0 && <p className="text-sm text-neutral-400">待機中のお客様はいません</p>}
            </div>
          </section>
        </div>
      </main>

      {showNoShowModal && (
        <NoShowModal
          list={noShowList}
          onClose={() => setShowNoShowModal(false)}
          onRequeue={(id, pos) => void handleRequeue(id, pos)}
        />
      )}

      {showProxyModal && queue && (
        <ProxyIssueModal
          queue={queue}
          onClose={() => setShowProxyModal(false)}
          onIssued={() => setShowProxyModal(false)}
        />
      )}
    </div>
  );
}

function NoShowModal({
  list,
  onClose,
  onRequeue,
}: {
  list: NoShowTicket[];
  onClose: () => void;
  onRequeue: (ticketId: string, position: 'head' | 'tail') => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-md max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200">
          <h3 className="font-bold">不在のお客様</h3>
          <button onClick={onClose} className="text-neutral-400">
            ✕
          </button>
        </div>
        <div className="divide-y divide-neutral-100">
          {list.length === 0 && <p className="p-5 text-sm text-neutral-400">不在のお客様はいません</p>}
          {list.map((t) => (
            <div key={t.id} className="p-4 flex flex-col gap-2">
              <div className="text-sm">
                <span className="font-bold mr-2">{t.display_number}</span>
                {t.party_size != null && <span className="mr-2">{t.party_size}名</span>}
                <span className="text-neutral-500">
                  {new Date(t.no_show_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}不在
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => onRequeue(t.id, 'head')}
                  className="px-3 h-9 rounded border border-neutral-300 text-sm"
                >
                  列の先頭に戻す
                </button>
                <button
                  onClick={() => onRequeue(t.id, 'tail')}
                  className="px-3 h-9 rounded border border-neutral-300 text-sm"
                >
                  最後尾に戻す
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProxyIssueModal({
  queue,
  onClose,
  onIssued,
}: {
  queue: QueueRow;
  onClose: () => void;
  onIssued: () => void;
}) {
  const [partySize, setPartySize] = useState<number | null>(null);
  const [seatPreference, setSeatPreference] = useState<string | null>(null);
  const [roomNumber, setRoomNumber] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('issue_ticket', {
      p_queue_id: queue.id,
      p_party_size: partySize,
      p_room_number: roomNumber || null,
      p_seat_preference: seatPreference,
      p_locale: 'ja',
      p_source: 'staff',
      p_client_nonce: crypto.randomUUID(),
      p_base_url: BASE_URL,
    });
    setSubmitting(false);
    if (rpcError) {
      setError('通信エラーが発生しました');
      return;
    }
    const res = data as { ok: boolean; error?: string };
    if (!res.ok) {
      setError(`エラー: ${res.error}`);
      return;
    }
    onIssued();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200">
          <h3 className="font-bold">代理発券</h3>
          <button onClick={onClose} className="text-neutral-400">
            ✕
          </button>
        </div>
        <div className="p-5 flex flex-col gap-4">
          {queue.ask_party_size && (
            <div>
              <p className="text-sm font-medium mb-2">ご人数</p>
              <div className="flex gap-2 flex-wrap">
                {queue.party_size_options.map((n, idx) => {
                  const isLast = idx === queue.party_size_options.length - 1;
                  return (
                    <button
                      key={n}
                      onClick={() => setPartySize(n)}
                      className={
                        'w-14 h-10 rounded border text-sm font-bold ' +
                        (partySize === n ? 'bg-[var(--color-primary)] text-white' : 'bg-white border-neutral-300')
                      }
                    >
                      {isLast ? `${n}+` : n}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {queue.ask_seat_preference && (
            <div>
              <p className="text-sm font-medium mb-2">席希望</p>
              <div className="flex gap-2 flex-wrap">
                {queue.seat_options.map((opt) => (
                  <button
                    key={opt.code}
                    onClick={() => setSeatPreference(opt.code)}
                    className={
                      'px-3 h-10 rounded border text-sm ' +
                      (seatPreference === opt.code
                        ? 'bg-[var(--color-primary)] text-white'
                        : 'bg-white border-neutral-300')
                    }
                  >
                    {tj(opt.label, 'ja')}
                  </button>
                ))}
              </div>
            </div>
          )}

          {queue.ask_room_number && (
            <label className="text-sm font-medium flex flex-col gap-1">
              お部屋番号
              <input
                value={roomNumber}
                onChange={(e) => setRoomNumber(e.target.value)}
                className="h-10 border border-neutral-300 rounded px-3 font-normal"
                inputMode="numeric"
              />
            </label>
          )}

          {/* メモ欄(06_画面仕様書.md 5.5節)は issue_ticket RPC に対応する引数が
              無いため、このプロトタイプでは未実装。DB側の対応が必要。 */}

          {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

          <button
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="h-12 rounded-lg bg-[var(--color-primary)] text-white font-bold disabled:opacity-50"
          >
            {submitting ? '発行中…' : '発券する'}
          </button>
        </div>
      </div>
    </div>
  );
}
