import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { t, tj, type Locale } from '../../lib/i18n';
import { formatWaitSeconds } from '../../lib/format';
import type { TicketStatusResult } from '../../lib/types';

const LOCALES: Locale[] = ['ja', 'en', 'zh', 'ko'];
const LOCALE_LABEL: Record<Locale, string> = { ja: '日本語', en: 'EN', zh: '中文', ko: '한국어' };
const BACKGROUND_UNSUB_MS = 5 * 60 * 1000; // 5分バックグラウンドで購読解除 (FR-309)
const BLINK_STOP_MS = 30_000; // 30秒で明滅を停止 (06_画面仕様書.md 3.2節)

export default function GuestStatusPage() {
  const { token } = useParams<{ token: string }>();

  const [data, setData] = useState<TicketStatusResult | null>(null);
  const [locale, setLocale] = useState<Locale>('ja');
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [blinkActive, setBlinkActive] = useState(false);
  const [connected, setConnected] = useState(true);

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const hiddenSinceRef = useRef<number | null>(null);
  const prevStatusRef = useRef<string | undefined>(undefined);
  const prevCalledCountRef = useRef<number>(0);
  const blinkTimerRef = useRef<number | null>(null);

  // ---- ステータス取得 (05_API仕様書.md 2.3節 get_ticket_status) ----
  const refetchStatus = useCallback(async () => {
    if (!token) return;
    const { data: res, error } = await supabase.rpc('get_ticket_status', { p_token: token });
    if (error) {
      setConnected(false);
      return;
    }
    setConnected(true);
    const result = res as TicketStatusResult;
    setData(result);

    if (result.ok && result.locale && prevStatusRef.current === undefined) {
      // 初回取得時だけ、券発行時に選択された言語を初期値にする
      setLocale((result.locale as Locale) ?? 'ja');
    }

    const becameCalled =
      result.ok &&
      result.status === 'called' &&
      (prevStatusRef.current !== 'called' || (result.called_count ?? 0) > prevCalledCountRef.current);

    if (becameCalled) {
      triggerCallAlert();
    }

    prevStatusRef.current = result.status;
    prevCalledCountRef.current = result.called_count ?? 0;

    // 終端状態になったら即座にRealtime購読を解除する (FR-309)
    if (result.ok && ['done', 'no_show', 'canceled'].includes(result.status ?? '')) {
      channelRef.current?.unsubscribe();
    }
  }, [token]);

  useEffect(() => {
    void refetchStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ---- queue_states のRealtime購読 (05_API仕様書.md 5.1節) ----
  // 個人情報を一切乗せず、変化検知は「取り直すきっかけ」としてのみ使う。
  useEffect(() => {
    if (!data?.ok || !data.queue_id) return;
    if (['done', 'no_show', 'canceled'].includes(data.status ?? '')) return;

    const channel = supabase
      .channel(`guest:${data.queue_id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'queue_states', filter: `queue_id=eq.${data.queue_id}` },
        () => {
          void refetchStatus();
        },
      )
      .subscribe();
    channelRef.current = channel;

    return () => {
      channel.unsubscribe();
    };
  }, [data?.ok, data?.queue_id, data?.status, refetchStatus]);

  // ---- バックグラウンド5分で購読解除、復帰時に再購読+再取得 ----
  useEffect(() => {
    function onVisibility() {
      if (document.hidden) {
        hiddenSinceRef.current = Date.now();
        window.setTimeout(() => {
          if (
            document.hidden &&
            hiddenSinceRef.current &&
            Date.now() - hiddenSinceRef.current >= BACKGROUND_UNSUB_MS
          ) {
            channelRef.current?.unsubscribe();
          }
        }, BACKGROUND_UNSUB_MS);
      } else {
        hiddenSinceRef.current = null;
        void refetchStatus();
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [refetchStatus]);

  // ---- 画面消灯の抑止 (FR-305) ----
  useEffect(() => {
    let sentinel: { release: () => Promise<void> } | null = null;
    async function requestLock() {
      try {
        const nav = navigator as Navigator & {
          wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
        };
        sentinel = (await nav.wakeLock?.request('screen')) ?? null;
      } catch {
        /* 失敗しても無視する(仕様通り) */
      }
    }
    void requestLock();
    return () => {
      void sentinel?.release();
    };
  }, []);

  function unlockAudio() {
    if (audioUnlocked) return;
    try {
      const audio = new Audio();
      audio.play().catch(() => {});
    } catch {
      /* ignore */
    }
    setAudioUnlocked(true);
  }

  function triggerCallAlert() {
    setBlinkActive(true);
    if (blinkTimerRef.current) window.clearTimeout(blinkTimerRef.current);
    blinkTimerRef.current = window.setTimeout(() => setBlinkActive(false), BLINK_STOP_MS);

    if (audioUnlocked) {
      const audio = new Audio('/sounds/guest-call.mp3');
      let played = 0;
      const playOnce = () => {
        audio.currentTime = 0;
        audio.play().catch(() => {});
      };
      audio.onended = () => {
        played += 1;
        if (played < 3) playOnce();
      };
      playOnce();
    }
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate([400, 200, 400, 200, 400]);
    }
  }

  // ---------------------------------------------------------------

  if (!data) {
    return <FullscreenMessage onTap={unlockAudio}>…</FullscreenMessage>;
  }

  if (!data.ok) {
    const msg = data.error === 'EXPIRED' ? 'この整理券は期限切れです。' : 'この整理券は見つかりません。QRコードをもう一度読み取ってください。';
    return <FullscreenMessage onTap={unlockAudio}>{msg}</FullscreenMessage>;
  }

  if (data.status === 'called') {
    return (
      <div
        onClick={() => {
          unlockAudio();
          setBlinkActive(false);
        }}
        className={
          'min-h-screen flex flex-col items-center justify-center gap-6 text-white text-center px-6 ' +
          (blinkActive ? 'animate-pulse' : '')
        }
        style={{ backgroundColor: '#dc2626' }}
      >
        <p className="text-2xl font-bold">お呼び出し中です</p>
        <div className="text-7xl font-black">{data.display_number}</div>
        {data.counter_name && (
          <p className="text-xl">{tj(data.counter_name, locale)}までお越しください</p>
        )}
        <button className="mt-4 px-6 h-12 rounded-lg bg-white/20 font-medium">確認しました</button>
      </div>
    );
  }

  if (data.status === 'serving') {
    return (
      <FullscreenMessage bg="#166534" onTap={unlockAudio}>
        ご案内中です。ごゆっくりどうぞ。
      </FullscreenMessage>
    );
  }
  if (data.status === 'done') {
    return <FullscreenMessage onTap={unlockAudio}>ありがとうございました。またのお越しをお待ちしております。</FullscreenMessage>;
  }
  if (data.status === 'no_show') {
    return (
      <FullscreenMessage bg="#d97706" onTap={unlockAudio}>
        お呼び出しいたしましたが、確認できませんでした。お手数ですが受付までお声がけください。
      </FullscreenMessage>
    );
  }
  if (data.status === 'canceled') {
    return (
      <FullscreenMessage bg="#78716c" onTap={unlockAudio}>
        この整理券は無効になりました。
      </FullscreenMessage>
    );
  }

  // waiting
  return (
    <div onClick={unlockAudio} className="min-h-screen flex flex-col items-center px-6 py-8 gap-6">
      <header className="w-full flex items-center justify-between">
        <div>
          <div className="font-bold">{data.tenant_name}</div>
          <div className="text-sm text-neutral-500">{tj(data.queue_name, locale)}</div>
        </div>
        <div className="flex gap-1">
          {LOCALES.map((l) => (
            <button
              key={l}
              onClick={(e) => {
                e.stopPropagation();
                setLocale(l);
              }}
              className={
                'px-2 py-1 rounded text-xs ' +
                (l === locale ? 'bg-[var(--color-primary)] text-white' : 'bg-neutral-100')
              }
            >
              {LOCALE_LABEL[l]}
            </button>
          ))}
        </div>
      </header>

      <div className="text-neutral-500">{t(locale, 'groupsAheadLabel')}</div>
      <div className="text-2xl font-bold">{data.display_number}</div>

      <div className="text-lg text-neutral-500">あと</div>
      <div className="text-8xl font-black" aria-live="polite">
        {data.ahead}
      </div>
      <div className="text-lg">組</div>

      <div className="text-neutral-500">目安 {formatWaitSeconds(data.estimated_wait_seconds ?? 0, locale)}</div>

      <div className="flex items-center gap-2 text-sm text-neutral-400">
        <span
          className={'inline-block w-2 h-2 rounded-full ' + (connected ? 'bg-green-500' : 'bg-neutral-400')}
        />
        {connected ? 'リアルタイム更新中' : '再接続中…'}
      </div>

      <p className="text-xs text-neutral-400 text-center max-w-xs">
        この画面を開いたままお待ちください。館内モニターでもお呼び出しいたします。
      </p>
    </div>
  );
}

function FullscreenMessage({
  children,
  bg,
  onTap,
}: {
  children: ReactNode;
  bg?: string;
  onTap?: () => void;
}) {
  return (
    <div
      onClick={onTap}
      className="min-h-screen flex items-center justify-center text-center px-8"
      style={bg ? { backgroundColor: bg, color: 'white' } : undefined}
    >
      <p className="text-xl font-medium max-w-sm">{children}</p>
    </div>
  );
}
