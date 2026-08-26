import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { supabase, BASE_URL } from '../../lib/supabase';
import { t, tf, tj, errText, type Locale } from '../../lib/i18n';
import { formatWaitSeconds } from '../../lib/format';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import type { IssueTicketResult, PublicQueue, QueueStateRow } from '../../lib/types';

const LOCALES: Locale[] = ['ja', 'en', 'zh', 'ko'];
const LOCALE_LABEL: Record<Locale, string> = { ja: '日本語', en: 'EN', zh: '中文', ko: '한국어' };
const LOCALE_AUTO_REVERT_MS = 60_000;
const RESULT_AUTO_RETURN_MS = 15_000;

type Step = 'select' | 'details' | 'done';

export default function KioskPage() {
  const { tenantSlug } = useParams<{ tenantSlug: string }>();
  const online = useOnlineStatus();

  const [locale, setLocale] = useState<Locale>('ja');
  const [queues, setQueues] = useState<PublicQueue[]>([]);
  const [loadingQueues, setLoadingQueues] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [step, setStep] = useState<Step>('select');
  const [selectedQueue, setSelectedQueue] = useState<PublicQueue | null>(null);

  const [partySize, setPartySize] = useState<number | null>(null);
  const [seatPreference, setSeatPreference] = useState<string | null>(null);
  const [roomNumber, setRoomNumber] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [result, setResult] = useState<IssueTicketResult | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(RESULT_AUTO_RETURN_MS / 1000);

  const nonceRef = useRef<string | null>(null);
  const localeTimerRef = useRef<number | null>(null);

  // ---- キュー一覧取得 (05_API仕様書.md 2.1節 get_public_queues) ----
  const fetchQueues = useCallback(async () => {
    if (!tenantSlug) return;
    const { data, error } = await supabase.rpc('get_public_queues', {
      p_tenant_slug: tenantSlug,
    });
    if (error) {
      setLoadError(true);
    } else {
      setLoadError(false);
      setQueues((data ?? []) as PublicQueue[]);
    }
    setLoadingQueues(false);
  }, [tenantSlug]);

  useEffect(() => {
    fetchQueues();
  }, [fetchQueues]);

  // ---- queue_states / queues のRealtime購読でライブ更新 ----
  // (03_システム設計書.md 4.3節。queue_statesは個人情報を含まない公開テーブルなので
  //  匿名クライアントでも安全に購読できる)
  useEffect(() => {
    const channel = supabase
      .channel(`kiosk:${tenantSlug ?? 'unknown'}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'queue_states' },
        (payload) => {
          const next = payload.new as QueueStateRow;
          setQueues((prev) =>
            prev.map((q) =>
              q.id === next.queue_id
                ? {
                    ...q,
                    waiting_count: next.waiting_count,
                    estimated_wait_seconds: next.estimated_wait_seconds,
                  }
                : q,
            ),
          );
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'queues' },
        () => {
          // 受付開始/停止・営業時間などキュー自体の設定変更は
          // acceptable の再計算が必要なので素直に取り直す
          fetchQueues();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [tenantSlug, fetchQueues]);

  // ---- 言語選択の60秒自動復帰 (FR-102) ----
  useEffect(() => {
    if (localeTimerRef.current) window.clearTimeout(localeTimerRef.current);
    if (locale !== 'ja') {
      localeTimerRef.current = window.setTimeout(() => setLocale('ja'), LOCALE_AUTO_REVERT_MS);
    }
    return () => {
      if (localeTimerRef.current) window.clearTimeout(localeTimerRef.current);
    };
  }, [locale]);

  // ---- 発券完了後、15秒でトップに自動復帰 (06_画面仕様書.md 2.4節) ----
  useEffect(() => {
    if (step !== 'done') return;
    setSecondsLeft(RESULT_AUTO_RETURN_MS / 1000);
    const interval = window.setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    const timeout = window.setTimeout(resetToTop, RESULT_AUTO_RETURN_MS);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function resetToTop() {
    setStep('select');
    setSelectedQueue(null);
    setPartySize(null);
    setSeatPreference(null);
    setRoomNumber('');
    setResult(null);
    setIssueError(null);
    nonceRef.current = null;
    setLocale('ja');
  }

  function handleSelectQueue(q: PublicQueue) {
    if (!q.acceptable || submitting) return;
    setSelectedQueue(q);
    setIssueError(null);
    // このキューでの一連の発券操作を通して使い回すnonce。
    // (issue_ticketはp_client_nonceで冪等性を担保するため、リトライ時も
    //  絶対に生成し直さないこと — 08_開発指示プロンプト.md 必須ルール2)
    nonceRef.current = crypto.randomUUID();

    const needsDetails = q.ask_party_size || q.ask_room_number || q.ask_seat_preference;
    if (needsDetails) {
      setStep('details');
    } else {
      void doIssue(q, null, null, '');
    }
  }

  async function doIssue(
    q: PublicQueue,
    party: number | null,
    seat: string | null,
    room: string,
  ) {
    if (submitting) return; // FR-109: 連打防止(ボタン無効化)
    if (!nonceRef.current) nonceRef.current = crypto.randomUUID();
    setSubmitting(true);
    setIssueError(null);
    try {
      const { data, error } = await supabase.rpc('issue_ticket', {
        p_queue_id: q.id,
        p_party_size: party,
        p_room_number: room ? room : null,
        p_seat_preference: seat,
        p_locale: locale,
        p_source: 'kiosk',
        p_client_nonce: nonceRef.current,
        p_base_url: BASE_URL,
      });
      if (error) throw error;
      const res = data as IssueTicketResult;
      if (!res.ok) {
        setIssueError(res.error ?? 'NETWORK_ERROR');
        return;
      }
      setResult(res);
      setStep('done');
    } catch {
      setIssueError('NETWORK_ERROR');
    } finally {
      setSubmitting(false);
    }
  }

  // ---------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------

  if (!online) {
    return (
      <FullscreenOverlay>
        <p className="text-2xl md:text-4xl font-bold text-center px-8">
          {t(locale, 'offlineMessage')}
        </p>
      </FullscreenOverlay>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex items-center justify-between px-6 py-4 border-b border-neutral-200">
        <div className="font-bold text-lg">MACHIAI</div>
        <div className="flex gap-2">
          {LOCALES.map((l) => (
            <button
              key={l}
              onClick={() => setLocale(l)}
              className={
                'px-3 py-2 rounded text-sm font-medium ' +
                (l === locale
                  ? 'bg-[var(--color-primary)] text-white'
                  : 'bg-neutral-100 text-neutral-700')
              }
            >
              {LOCALE_LABEL[l]}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        {step === 'select' && (
          <SelectStep
            locale={locale}
            queues={queues}
            loading={loadingQueues}
            loadError={loadError}
            onSelect={handleSelectQueue}
          />
        )}

        {step === 'details' && selectedQueue && (
          <DetailsStep
            locale={locale}
            queue={selectedQueue}
            partySize={partySize}
            setPartySize={setPartySize}
            seatPreference={seatPreference}
            setSeatPreference={setSeatPreference}
            roomNumber={roomNumber}
            setRoomNumber={setRoomNumber}
            submitting={submitting}
            error={issueError}
            onBack={() => {
              setStep('select');
              setSelectedQueue(null);
            }}
            onSubmit={() => void doIssue(selectedQueue, partySize, seatPreference, roomNumber)}
          />
        )}

        {step === 'done' && result?.ok && (
          <DoneStep locale={locale} result={result} secondsLeft={secondsLeft} onDismiss={resetToTop} />
        )}
      </main>
    </div>
  );
}

function FullscreenOverlay({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/85 text-white flex items-center justify-center z-50">
      {children}
    </div>
  );
}

function QueueCard({
  locale,
  queue,
  onSelect,
}: {
  locale: Locale;
  queue: PublicQueue;
  onSelect: (q: PublicQueue) => void;
}) {
  const disabled = !queue.acceptable;
  return (
    <button
      onClick={() => onSelect(queue)}
      disabled={disabled}
      className={
        'relative text-left w-64 h-80 rounded-xl border border-neutral-200 bg-white shadow-sm ' +
        'flex flex-col p-5 overflow-hidden ' +
        (disabled ? 'opacity-40 cursor-not-allowed' : 'active:scale-[0.98] transition-transform')
      }
    >
      <span className="absolute left-0 top-0 bottom-0 w-2" style={{ backgroundColor: queue.color }} />
      <div className="pl-2 flex-1 flex flex-col">
        <div className="text-xl font-bold mb-1">{tj(queue.name, locale)}</div>
        <div className="text-sm text-neutral-500 mb-4">{tj(queue.description, locale)}</div>
        <div className="mt-auto text-sm text-neutral-600">
          {disabled ? (
            <span className="font-semibold text-neutral-500">
              {/* acceptableがfalseの理由(停止/時間外/満席)はget_public_queuesのレスポンスに
                  含まれていないため、現状は一括りに表示している */}
              {t(locale, 'statusStopped')}
            </span>
          ) : (
            <>
              <div>
                {queue.waiting_count} {t(locale, 'groupsWaiting')}
              </div>
              <div>
                {t(locale, 'estWaitLabel')} {formatWaitSeconds(queue.estimated_wait_seconds, locale)}
              </div>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

function SelectStep({
  locale,
  queues,
  loading,
  loadError,
  onSelect,
}: {
  locale: Locale;
  queues: PublicQueue[];
  loading: boolean;
  loadError: boolean;
  onSelect: (q: PublicQueue) => void;
}) {
  if (loading) {
    return <p className="text-neutral-400">…</p>;
  }
  if (loadError) {
    return <p className="text-lg text-[var(--color-danger)]">{t(locale, 'offlineMessage')}</p>;
  }
  return (
    <div className="flex flex-col items-center gap-8">
      <h1 className="text-3xl font-bold">{t(locale, 'chooseService')}</h1>
      <div className="flex flex-wrap gap-6 justify-center">
        {queues
          .slice()
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((q) => (
            <QueueCard key={q.id} locale={locale} queue={q} onSelect={onSelect} />
          ))}
      </div>
    </div>
  );
}

function DetailsStep({
  locale,
  queue,
  partySize,
  setPartySize,
  seatPreference,
  setSeatPreference,
  roomNumber,
  setRoomNumber,
  submitting,
  error,
  onBack,
  onSubmit,
}: {
  locale: Locale;
  queue: PublicQueue;
  partySize: number | null;
  setPartySize: (n: number) => void;
  seatPreference: string | null;
  setSeatPreference: (s: string) => void;
  roomNumber: string;
  setRoomNumber: (s: string) => void;
  submitting: boolean;
  error: string | null;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const canSubmit = !submitting && (!queue.ask_party_size || partySize !== null);

  function pressDigit(d: string) {
    setRoomNumber((roomNumber + d).slice(0, 6));
  }
  function backspace() {
    setRoomNumber(roomNumber.slice(0, -1));
  }

  return (
    <div className="w-full max-w-2xl flex flex-col gap-8">
      <div className="flex items-center gap-4">
        <button onClick={onBack} className="text-sm text-neutral-500 underline">
          ← {t(locale, 'back')}
        </button>
        <h2 className="text-xl font-bold">{tj(queue.name, locale)}</h2>
      </div>

      {queue.ask_party_size && (
        <section>
          <h3 className="font-semibold mb-3">{t(locale, 'partySizeQuestion')}</h3>
          <div className="flex gap-3 flex-wrap">
            {queue.party_size_options.map((n, idx) => {
              const isLast = idx === queue.party_size_options.length - 1;
              const label = isLast ? `${n}+` : `${n}`;
              return (
                <button
                  key={n}
                  onClick={() => setPartySize(n)}
                  className={
                    'w-20 h-16 rounded-lg border text-lg font-bold ' +
                    (partySize === n
                      ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                      : 'bg-white border-neutral-300')
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {queue.ask_seat_preference && (
        <section>
          <h3 className="font-semibold mb-3">{t(locale, 'seatPreferenceQuestion')}</h3>
          <div className="flex gap-3 flex-wrap">
            {queue.seat_options.map((opt) => (
              <button
                key={opt.code}
                onClick={() => setSeatPreference(opt.code)}
                className={
                  'px-4 h-14 rounded-lg border text-base font-medium ' +
                  (seatPreference === opt.code
                    ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                    : 'bg-white border-neutral-300')
                }
              >
                {tj(opt.label, locale)}
              </button>
            ))}
          </div>
        </section>
      )}

      {queue.ask_room_number && (
        <section>
          <h3 className="font-semibold mb-3">{t(locale, 'roomNumberQuestion')}</h3>
          <div className="flex items-start gap-6">
            {/* OSのソフトウェアキーボードを出さないよう、inputMode="none" + readOnly にし
                自作のテンキーでのみ入力させる (06_画面仕様書.md 2.3節) */}
            <input
              type="text"
              inputMode="none"
              readOnly
              value={roomNumber}
              placeholder="—"
              className="w-40 h-16 text-2xl text-center border rounded-lg border-neutral-300"
            />
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button
                  key={d}
                  onClick={() => pressDigit(d)}
                  className="w-14 h-14 rounded-lg border border-neutral-300 text-lg font-bold bg-white"
                >
                  {d}
                </button>
              ))}
              <button
                onClick={backspace}
                className="w-14 h-14 rounded-lg border border-neutral-300 text-lg font-bold bg-white"
              >
                ←
              </button>
              <button
                onClick={() => pressDigit('0')}
                className="w-14 h-14 rounded-lg border border-neutral-300 text-lg font-bold bg-white"
              >
                0
              </button>
              <button
                onClick={() => setRoomNumber('')}
                className="w-14 h-14 rounded-lg border border-neutral-300 text-lg font-bold bg-white"
              >
                C
              </button>
            </div>
          </div>
        </section>
      )}

      {error && (
        <p className="text-[var(--color-danger)] font-semibold">{errText(locale, error)}</p>
      )}

      <button
        onClick={onSubmit}
        disabled={!canSubmit}
        className={
          'h-20 rounded-xl text-2xl font-bold text-white ' +
          (canSubmit ? 'bg-[var(--color-primary)]' : 'bg-neutral-300 cursor-not-allowed')
        }
      >
        {submitting ? t(locale, 'submitting') : t(locale, 'issueButton')}
      </button>
    </div>
  );
}

function DoneStep({
  locale,
  result,
  secondsLeft,
  onDismiss,
}: {
  locale: Locale;
  result: IssueTicketResult;
  secondsLeft: number;
  onDismiss: () => void;
}) {
  return (
    <div onClick={onDismiss} className="flex flex-col items-center gap-6 text-center cursor-pointer">
      <h1 className="text-2xl font-bold">{t(locale, 'ticketIssuedTitle')}</h1>

      <div className="px-12 py-8 rounded-2xl border-4 border-[var(--color-primary)]">
        <div className="text-8xl md:text-9xl font-black tracking-wider">
          {result.display_number}
        </div>
      </div>

      <div className="text-lg">
        {t(locale, 'groupsAheadLabel')} {result.ahead}
        {'　／　'}
        {t(locale, 'estWaitLabel')}{' '}
        {formatWaitSeconds(result.estimated_wait_seconds ?? 0, locale)}
      </div>

      {result.status_url && (
        <div className="flex flex-col items-center gap-2">
          <QRCodeSVG value={result.status_url} size={220} level="M" />
          <p className="text-sm text-neutral-500 max-w-xs">{t(locale, 'scanQrHint')}</p>
        </div>
      )}

      <p className="text-base font-medium">{t(locale, 'printedOk')}</p>

      <p className="text-xs text-neutral-400">{tf(locale, 'autoReturnNotice', secondsLeft)}</p>
    </div>
  );
}
