import type { Locale } from './i18n';

// 待ち時間(秒) → 画面表示用の文字列変換
// (03_システム設計書.md 3.2節「表示への変換」のロジックをそのまま踏襲)
//   T < 60          → 「まもなく」
//   60 <= T < 3600   → 5分単位に切り上げて「約 N 分」
//   T >= 3600        → 「60分以上」
export function formatWaitSeconds(seconds: number, locale: Locale): string {
  if (seconds < 60) {
    return { ja: 'まもなく', en: 'Soon', zh: '即将', ko: '곧' }[locale];
  }
  if (seconds >= 3600) {
    return { ja: '60分以上', en: '60+ min', zh: '60分钟以上', ko: '60분 이상' }[locale];
  }
  const minutes = Math.ceil(seconds / 300) * 5;
  return {
    ja: `約 ${minutes} 分`,
    en: `About ${minutes} min`,
    zh: `约 ${minutes} 分钟`,
    ko: `약 ${minutes}분`,
  }[locale];
}

// 発券からの経過時間(秒) → 「3分」のような簡易表示。スタッフ画面の待機列で使う想定。
export function formatElapsedMinutes(issuedAtIso: string, nowMs: number): number {
  const issuedMs = new Date(issuedAtIso).getTime();
  return Math.max(0, Math.floor((nowMs - issuedMs) / 60000));
}
