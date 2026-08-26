export type Locale = 'ja' | 'en' | 'zh' | 'ko';

// UI固定文言の辞書(06_画面仕様書.md 8.2節)。
// DBに入る文言(キュー名・席希望の選択肢など)は各テーブルのJSONBカラムから
// tj() で取り出す。こちらはボタンラベルなどUI側に固定の文言のみを持つ。
export const dict = {
  ja: {
    chooseService: 'ご用件をお選びください',
    groupsWaiting: '組待ち',
    estWaitLabel: '目安',
    statusStopped: '受付停止中',
    statusOutOfHours: '受付時間外',
    back: '戻る',
    partySizeQuestion: 'ご人数',
    seatPreferenceQuestion: 'お席のご希望(任意)',
    roomNumberQuestion: 'お部屋番号(任意)',
    issueButton: '整理券を発行する',
    submitting: '発行中…',
    ticketIssuedTitle: '整理券を発行しました',
    groupsAheadLabel: 'お待ちの組数',
    scanQrHint: 'スマートフォンでお呼び出し状況を確認できます',
    printedOk: '🖨 整理券をお取りください',
    printedFail: '恐れ入りますが、この番号をお控えください',
    autoReturnNotice: (n: number) => `${n}秒後に最初に戻ります`,
    offlineMessage: 'ただいま発券できません。スタッフにお声がけください',
    errQueueNotFound: 'システムエラー。スタッフにお声がけください',
    errQueueClosed: 'ただいま受付を停止しております',
    errOutOfHours: '受付時間外です',
    errQueueFull: '大変混み合っております。しばらくお待ちください',
    errNetwork: 'ただいま発券できません。スタッフにお声がけください',
  },
  en: {
    chooseService: 'Please select a service',
    groupsWaiting: 'waiting',
    estWaitLabel: 'Est.',
    statusStopped: 'Currently closed',
    statusOutOfHours: 'Outside hours',
    back: 'Back',
    partySizeQuestion: 'Party size',
    seatPreferenceQuestion: 'Seat preference (optional)',
    roomNumberQuestion: 'Room number (optional)',
    issueButton: 'Get a ticket',
    submitting: 'Issuing…',
    ticketIssuedTitle: 'Your ticket has been issued',
    groupsAheadLabel: 'Groups ahead',
    scanQrHint: 'Scan to check your status on your phone',
    printedOk: '🖨 Please take your ticket',
    printedFail: 'Please note down this number',
    autoReturnNotice: (n: number) => `Returning to start in ${n}s`,
    offlineMessage: 'Unable to issue a ticket right now. Please ask a staff member.',
    errQueueNotFound: 'System error. Please ask a staff member.',
    errQueueClosed: 'This queue is currently closed.',
    errOutOfHours: 'Outside of reception hours.',
    errQueueFull: 'Currently very busy. Please wait a moment.',
    errNetwork: 'Unable to issue a ticket right now. Please ask a staff member.',
  },
  zh: {
    chooseService: '请选择您的需求',
    groupsWaiting: '组等待中',
    estWaitLabel: '预计',
    statusStopped: '暂停受理',
    statusOutOfHours: '非受理时间',
    back: '返回',
    partySizeQuestion: '人数',
    seatPreferenceQuestion: '座位偏好(可选)',
    roomNumberQuestion: '房间号(可选)',
    issueButton: '领取号码牌',
    submitting: '处理中…',
    ticketIssuedTitle: '号码牌已发放',
    groupsAheadLabel: '前面组数',
    scanQrHint: '扫描二维码可在手机上查看叫号进度',
    printedOk: '🖨 请取走您的号码牌',
    printedFail: '请记下此号码',
    autoReturnNotice: (n: number) => `${n}秒后返回首页`,
    offlineMessage: '暂时无法发放号码牌，请联系工作人员。',
    errQueueNotFound: '系统错误，请联系工作人员。',
    errQueueClosed: '当前暂停受理。',
    errOutOfHours: '不在受理时间内。',
    errQueueFull: '目前非常拥挤，请稍候。',
    errNetwork: '暂时无法发放号码牌，请联系工作人员。',
  },
  ko: {
    chooseService: '용건을 선택해 주세요',
    groupsWaiting: '팀 대기 중',
    estWaitLabel: '예상',
    statusStopped: '접수 중지',
    statusOutOfHours: '접수 시간 외',
    back: '뒤로',
    partySizeQuestion: '인원수',
    seatPreferenceQuestion: '좌석 희망(선택)',
    roomNumberQuestion: '객실 번호(선택)',
    issueButton: '번호표 발급',
    submitting: '발급 중…',
    ticketIssuedTitle: '번호표가 발급되었습니다',
    groupsAheadLabel: '앞 대기 팀',
    scanQrHint: '스마트폰으로 QR을 스캔하면 대기 현황을 확인할 수 있습니다',
    printedOk: '🖨 번호표를 가져가 주세요',
    printedFail: '이 번호를 메모해 주세요',
    autoReturnNotice: (n: number) => `${n}초 후 처음 화면으로 돌아갑니다`,
    offlineMessage: '지금은 번호표를 발급할 수 없습니다. 직원에게 문의해 주세요.',
    errQueueNotFound: '시스템 오류입니다. 직원에게 문의해 주세요.',
    errQueueClosed: '현재 접수가 중지되었습니다.',
    errOutOfHours: '접수 시간이 아닙니다.',
    errQueueFull: '현재 매우 혼잡합니다. 잠시만 기다려 주세요.',
    errNetwork: '지금은 번호표를 발급할 수 없습니다. 직원에게 문의해 주세요.',
  },
} as const;

type StaticKey = {
  [K in keyof typeof dict.ja]: (typeof dict.ja)[K] extends string ? K : never;
}[keyof typeof dict.ja];

export const t = (locale: Locale, key: StaticKey): string => {
  const v = (dict[locale] as Record<string, unknown>)?.[key] ?? dict.ja[key as keyof typeof dict.ja];
  return v as string;
};

export const tf = (locale: Locale, key: 'autoReturnNotice', n: number): string =>
  (dict[locale]?.autoReturnNotice ?? dict.ja.autoReturnNotice)(n);

// issue_ticket / RPC が返すエラーコード用
export const errText = (locale: Locale, code: string): string => {
  const d = dict[locale] ?? dict.ja;
  switch (code) {
    case 'QUEUE_NOT_FOUND': return d.errQueueNotFound;
    case 'QUEUE_CLOSED': return d.errQueueClosed;
    case 'OUT_OF_HOURS': return d.errOutOfHours;
    case 'QUEUE_FULL': return d.errQueueFull;
    default: return d.errNetwork;
  }
};

// DBのJSONB(多言語カラム)から該当ロケールの文字列を取り出す
export const tj = (obj: Record<string, string> | null | undefined, locale: Locale) =>
  obj?.[locale] ?? obj?.ja ?? obj?.en ?? '';
