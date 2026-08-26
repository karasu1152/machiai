export type Locale = 'ja' | 'en' | 'zh' | 'ko';

// UI固定文言の辞書(06_画面仕様書.md 8.2節)。
// プロトタイプ段階では最小限のキーのみ。画面実装に合わせて追加していく。
export const dict = {
  ja: {
    chooseService: 'ご用件をお選びください',
    issue: '整理券を発行する',
    groupsAhead: 'お待ちの組数',
    estWait: '目安待ち時間',
  },
  en: {
    chooseService: 'Please select a service',
    issue: 'Get a ticket',
    groupsAhead: 'Groups ahead',
    estWait: 'Estimated wait',
  },
  zh: {
    chooseService: '请选择您的需求',
    issue: '领取号码牌',
    groupsAhead: '前面组数',
    estWait: '预计等待',
  },
  ko: {
    chooseService: '용건을 선택해 주세요',
    issue: '번호표 발급',
    groupsAhead: '앞 대기 팀',
    estWait: '예상 대기',
  },
} as const;

export const t = (locale: Locale, key: keyof typeof dict.ja) =>
  dict[locale]?.[key] ?? dict.ja[key];

// DBのJSONB(多言語カラム)から該当ロケールの文字列を取り出す
export const tj = (obj: Record<string, string> | null | undefined, locale: Locale) =>
  obj?.[locale] ?? obj?.ja ?? obj?.en ?? '';
