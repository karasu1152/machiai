import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { tj } from '../../lib/i18n';
import { formatWaitSeconds } from '../../lib/format';
import type { QueueStateRow } from '../../lib/types';

const CALL_PROCESS_INTERVAL_MS = 4000; // 複数呼出は4秒間隔で順に処理する
const BLINK_COUNT = 3;
const BLINK_INTERVAL_MS = 250;
const HEALTHCHECK_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 90_000;

interface QueueMeta {
  id: string;
  name: Record<string, string>;
  color: string;
  sort_order: number;
}

interface PendingCall {
  displayNumber: string;
  counterLabel: string;
}

interface HistoryItem {
  displayNumber: string;
  at: number;
}

export default function SignagePage() {
  const { tenantSlug } = useParams<{ tenantSlug: string }>();

  const [tenantId, setTenantId] = useState<string | null>(null);
  const [tenantName, setTenantName] = useState('');
  const [queues, setQueues] = useState<QueueMeta[]>([]);
  const [counterLabels, setCounterLabels] = useState<Record<string, string>>({});
  const counterLabelsRef = useRef(counterLabels);
  useEffect(() => {
    counterLabelsRef.current = counterLabels;
  }, [counterLabels]);
  const [queueStates, setQueueStates] = useState<Record<string, QueueStateRow>>({});

  // 呼出待ちキューはReact stateではなくrefで持つ。stateにすると
  // 「キューを処理する副作用」自身がキューを書き換えるたびにその副作用が
  // 再実行されてタイマーが壊れる問題が起きるため(点滅が一瞬で止まり、
  // 2件目以降が永久に処理されなくなるバグの原因だった)。
  const queueRef = useRef<PendingCall[]>([]);
  const [current, setCurrent] = useState<PendingCall | null>(null);
  const [blinkOn, setBlinkOn] = useState(true);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const lastUpdatedRef = useRef<number>(Date.now());

  // 呼出キューに新しい項目が入ったとき、処理ループへ「今すぐ確認して」と
  // 伝えるためのトリガー。実体は下の処理ループのuseEffect内で差し替える。
  const processTriggerRef = useRef<() => void>(() => {});

  // ---- 初期データ取得: テナントslug→id、キュー一覧、窓口名、queue_states ----
  useEffect(() => {
    if (!tenantSlug) return;
    (async () => {
      const { data: tenant } = await supabase
        .from('tenants')
        .select('id, name')
        .eq('slug', tenantSlug)
        .maybeSingle();
      if (!tenant) return;
      const tId = (tenant as { id: string; name: string }).id;
      setTenantId(tId);
      setTenantName((tenant as { id: string; name: string }).name);

      const [{ data: qs }, { data: cs }, { data: st }] = await Promise.all([
        supabase.from('queues').select('id, name, color, sort_order').eq('tenant_id', tId),
        supabase.from('counters').select('short_name, name').eq('tenant_id', tId),
        supabase.from('queue_states').select('*').eq('tenant_id', tId),
      ]);
      setQueues((qs ?? []) as QueueMeta[]);

      const labelMap: Record<string, string> = {};
      ((cs ?? []) as { short_name: string; name: Record<string, string> }[]).forEach((c) => {
        labelMap[c.short_name] = tj(c.name, 'ja');
      });
      setCounterLabels(labelMap);

      const stateMap: Record<string, QueueStateRow> = {};
      ((st ?? []) as QueueStateRow[]).forEach((s) => {
        stateMap[s.queue_id] = s;
      });
      setQueueStates(stateMap);
      lastUpdatedRef.current = Date.now();
    })();
  }, [tenantSlug]);

  // ---- queue_states のRealtime購読 (05_API仕様書.md 5.2節) ----
  useEffect(() => {
    if (!tenantId) return;
    const channel = supabase
      .channel(`signage:${tenantId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'queue_states', filter: `tenant_id=eq.${tenantId}` },
        (payload) => {
          const prev = payload.old as Partial<QueueStateRow> | null;
          const next = payload.new as QueueStateRow;
          lastUpdatedRef.current = Date.now();

          setQueueStates((s) => ({ ...s, [next.queue_id]: next }));

          if (next.called_seq > (prev?.called_seq ?? 0) && next.now_serving_number) {
            const label = counterLabelsRef.current[next.now_serving_counter ?? ''] ?? next.now_serving_counter ?? '窓口';
            queueRef.current.push({
              displayNumber: next.now_serving_number as string,
              counterLabel: label,
            });
            processTriggerRef.current();
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // counterLabelsRef経由で参照するため依存配列に含める必要はない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // ---- 呼出キューの処理: 4秒間隔で1件ずつ点滅表示 ----
  // マウント時に1本だけ自走するループとして実装する。setIntervalではなく
  // 「処理→4秒後に自分自身を呼び出す」setTimeoutの連鎖にすることで、
  // 前回の表示が多少長引いても次回の開始がズレて二重に走ることがないようにしている。
  useEffect(() => {
    let cancelled = false;
    let blinkTimer: number | null = null;
    let cooldownTimer: number | null = null;
    let coolingDown = false;

    function tryProcessNow() {
      if (cancelled || coolingDown) return; // クールダウン中なら、そのタイマー終了時に自動で再チェックされる
      const next = queueRef.current.shift();
      if (!next) return; // 何もキューにない間は何もしない(次にpushされた時にまた呼ばれる)

      coolingDown = true;
      setCurrent(next);
      setHistory((h) => [{ displayNumber: next.displayNumber, at: Date.now() }, ...h].slice(0, 5));

      // 点滅: BLINK_COUNT回、on/offを切り替える
      let toggles = 0;
      setBlinkOn(true);
      if (blinkTimer) window.clearInterval(blinkTimer);
      blinkTimer = window.setInterval(() => {
        toggles += 1;
        setBlinkOn((v) => !v);
        if (toggles >= BLINK_COUNT * 2) {
          if (blinkTimer) window.clearInterval(blinkTimer);
          setBlinkOn(true);
        }
      }, BLINK_INTERVAL_MS);

      // 1件処理したら4秒間は次を出さない。4秒経ったらキューに残りがないか
      // 自動で再チェックする(複数呼出が重なっていた場合はここで順番に捌かれる)。
      cooldownTimer = window.setTimeout(() => {
        coolingDown = false;
        tryProcessNow();
      }, CALL_PROCESS_INTERVAL_MS);
    }

    processTriggerRef.current = tryProcessNow;

    return () => {
      cancelled = true;
      processTriggerRef.current = () => {};
      if (blinkTimer) window.clearInterval(blinkTimer);
      if (cooldownTimer) window.clearTimeout(cooldownTimer);
    };
  }, []);

  // ---- 自動復旧: 90秒間更新がなければリロード (06_画面仕様書.md 4章) ----
  useEffect(() => {
    const id = window.setInterval(() => {
      if (Date.now() - lastUpdatedRef.current > STALE_THRESHOLD_MS) {
        window.location.reload();
      }
    }, HEALTHCHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-[var(--color-bg)]">
      <header className="flex items-center justify-between px-8 py-4">
        <h1 className="text-xl font-bold">{tenantName || 'MACHIAI'}</h1>
        <span className="text-xl tabular-nums">
          {new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center gap-8">
        <h2 className="text-2xl font-semibold">
          {current ? 'ただいまお呼び出し中' : 'ただいまお呼び出し中の番号はありません'}
        </h2>

        {current && (
          <div
            className="flex items-center gap-8 transition-opacity duration-150"
            style={{ opacity: blinkOn ? 1 : 0.25 }}
          >
            <div className="px-16 py-10 rounded-2xl border-8 border-[var(--color-primary)]">
              <div className="text-8xl md:text-9xl font-black tracking-wider">{current.displayNumber}</div>
            </div>
            <div className="text-3xl font-bold text-neutral-600">→ {current.counterLabel}</div>
          </div>
        )}

        {history.length > 1 && (
          <div className="text-neutral-500 text-lg">
            直前のお呼び出し{' '}
            {history
              .slice(1)
              .map((h) => h.displayNumber)
              .join('　')}
          </div>
        )}
      </main>

      <footer className="border-t border-neutral-200 px-8 py-4 flex gap-8 flex-wrap">
        {queues
          .slice()
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((q) => {
            const st = queueStates[q.id];
            return (
              <div key={q.id} className="flex items-center gap-2 text-sm">
                <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: q.color }} />
                <span className="font-medium">{tj(q.name, 'ja')}</span>
                <span className="text-neutral-500">
                  {st?.waiting_count ?? 0}組待ち ／ 約{formatWaitSeconds(st?.estimated_wait_seconds ?? 0, 'ja')}
                </span>
              </div>
            );
          })}
      </footer>
    </div>
  );
}
