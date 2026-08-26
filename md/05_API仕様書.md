# MACHIAI API仕様書

版数: 1.0

本システムのAPIは3種類ある。

1. **RPC**（Supabase の `.rpc()` 経由でPostgres関数を呼ぶ）— 通常の業務処理はすべてこれ
2. **テーブル直接アクセス**（`.from()`）— スタッフ画面の一覧取得など、RLSで保護されたもの
3. **Edge Function** — 外部機器との連携（プリンタ・Web Push）のみ

> **設計原則：Edge Function は無料枠のボトルネックなので、極力使わない。**
> DBのRPCは呼び出し回数に制限がないため、業務ロジックはすべてRPCに置く。

---

## 1. クライアント初期化

`src/lib/supabase.ts`

```typescript
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: { persistSession: true, autoRefreshToken: true },
    realtime: { params: { eventsPerSecond: 5 } },
  },
);

export const BASE_URL = window.location.origin;
```

---

## 2. 匿名で呼べるRPC（4つのみ）

### 2.1 `get_public_queues` — キオスクのキュー一覧

```typescript
const { data, error } = await supabase.rpc('get_public_queues', {
  p_tenant_slug: 'grand-hotel',
});
```

**レスポンス**

```json
[
  {
    "id": "22222222-...-2221",
    "name": {"ja":"フロント チェックイン","en":"Front Desk Check-in","zh":"前台入住登记","ko":"프런트 체크인"},
    "description": {"ja":"ご宿泊のお客様","en":"For hotel guests"},
    "prefix": "C",
    "color": "#0f766e",
    "icon": "concierge",
    "sort_order": 1,
    "ask_party_size": false,
    "party_size_options": [1,2,3,4,5],
    "ask_room_number": false,
    "ask_seat_preference": false,
    "seat_options": [],
    "acceptable": true,
    "waiting_count": 4,
    "estimated_wait_seconds": 900
  }
]
```

`acceptable` が `false` のキューは、キオスクでグレーアウトして押せなくする。
（受付停止・営業時間外・上限到達のいずれか）

### 2.2 `issue_ticket` — 発券

```typescript
const nonce = crypto.randomUUID();   // 同一発券操作で使い回す

const { data } = await supabase.rpc('issue_ticket', {
  p_queue_id: queueId,
  p_party_size: 2,               // 不要なら null
  p_room_number: '805',          // 不要なら null
  p_seat_preference: 'window',   // 不要なら null
  p_locale: 'ja',
  p_source: 'kiosk',             // スタッフ代理発券なら 'staff'
  p_client_nonce: nonce,
  p_base_url: BASE_URL,
});
```

**成功レスポンス**

```json
{
  "ok": true,
  "duplicated": false,
  "ticket_id": "...",
  "display_number": "R-024",
  "public_token": "aB3xK9mZ7pQ2rT5vW8yC1e",
  "queue_name": {"ja":"レストラン（朝食）", "...": "..."},
  "ahead": 5,
  "estimated_wait_seconds": 1200,
  "status_url": "https://machiai.pages.dev/t/aB3xK9mZ7pQ2rT5vW8yC1e",
  "issued_at": "2026-08-26T07:42:11.234Z"
}
```

**エラーレスポンス**

| `error` | 意味 | キオスクの表示 |
|---|---|---|
| `QUEUE_NOT_FOUND` | キューIDが不正 | 「システムエラー。スタッフにお声がけください」 |
| `QUEUE_CLOSED` | 受付停止中 | 「ただいま受付を停止しております」 |
| `OUT_OF_HOURS` | 営業時間外 | 「受付時間外です（7:00〜9:30）」 |
| `QUEUE_FULL` | 待ち上限に到達 | 「大変混み合っております。しばらくお待ちください」 |

**冪等性**：同じ `p_client_nonce` で再送すると、新規発券せず既存チケットを `duplicated: true` で返す。
ネットワークが不安定な環境でも二重発券しない。リトライ時は**必ず同じnonceを使うこと**。

### 2.3 `get_ticket_status` — ゲストのステータス取得

```typescript
const { data } = await supabase.rpc('get_ticket_status', {
  p_token: tokenFromUrl,
});
```

**レスポンス**

```json
{
  "ok": true,
  "display_number": "R-024",
  "status": "waiting",
  "queue_id": "2222...",
  "queue_name": {"ja":"レストラン（朝食）"},
  "tenant_name": "グランドホテル横浜",
  "locale": "ja",
  "party_size": 2,
  "ahead": 3,
  "estimated_wait_seconds": 720,
  "called_count": 0,
  "counter_name": null,
  "issued_at": "2026-08-26T07:42:11.234Z",
  "called_at": null
}
```

| `error` | 意味 | 表示 |
|---|---|---|
| `NOT_FOUND` | トークンが存在しない | 「この整理券は見つかりません」 |
| `EXPIRED` | 発行から24時間経過 | 「この整理券は期限切れです」 |

### 2.4 `register_push_subscription` — Web Push購読

```typescript
await supabase.rpc('register_push_subscription', {
  p_token:    ticketToken,
  p_endpoint: sub.endpoint,
  p_p256dh:   btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh')!))),
  p_auth:     btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth')!))),
});
```

---

## 3. 認証済みで呼べるRPC

### 3.1 `call_next` — 次を呼ぶ

```typescript
const { data } = await supabase.rpc('call_next', {
  p_queue_id: queueId,
  p_counter_id: myCounterId,   // 省略可
});
// → { ok: true, ticket_id: "...", display_number: "R-024" }
// → { ok: false, error: "NO_WAITING" }  待機者がいない
```

複数端末から同時に呼んでも、`FOR UPDATE SKIP LOCKED` により**それぞれ別の番号**が返る。

### 3.2 `call_ticket` — 指定チケットを呼ぶ／再呼出

```typescript
await supabase.rpc('call_ticket', { p_ticket_id: id, p_counter_id: counterId });
// → { ok: true, display_number: "R-024", called_count: 2 }
```

すでに `called` のチケットに対して呼ぶと再呼出になり、`called_count` が増え、サイネージが再点滅する。

### 3.3 `set_ticket_status` — 状態変更

```typescript
await supabase.rpc('set_ticket_status', {
  p_ticket_id: id,
  p_status: 'serving',   // 'serving' | 'done' | 'no_show' | 'canceled'
  p_reason: null,        // canceled のときのみ理由を入れる
});
```

| `p_status` | 業務上の意味 | ボタンの文言 |
|---|---|---|
| `serving` | 到着・対応開始 | 「ご案内」 |
| `done` | 対応完了 | 「完了」 |
| `no_show` | 呼んでも来ない | 「不在」 |
| `canceled` | 取消 | 「取消」 |

### 3.4 `requeue_ticket` — 不在から列に戻す

```typescript
await supabase.rpc('requeue_ticket', {
  p_ticket_id: id,
  p_position: 'head',   // 'head'（先頭） | 'tail'（最後尾）
});
```

### 3.5 `reprint_ticket` — 再印刷

```typescript
await supabase.rpc('reprint_ticket', { p_ticket_id: id, p_base_url: BASE_URL });
```

---

## 4. テーブル直接アクセス

### 4.1 スタッフ画面の待機列取得

```typescript
const { data } = await supabase
  .from('tickets')
  .select('id, display_number, status, party_size, room_number, seat_preference, note, issued_at, called_at, last_called_at, called_count, counter_id, sort_key, print_status')
  .eq('queue_id', queueId)
  .in('status', ['waiting', 'called', 'serving'])
  .order('sort_key', { ascending: true });
```

### 4.2 不在リスト

```typescript
const { data } = await supabase
  .from('tickets')
  .select('*')
  .eq('queue_id', queueId)
  .eq('status', 'no_show')
  .gte('issued_at', startOfBusinessDay)
  .order('no_show_at', { ascending: false });
```

### 4.3 本日サマリ

```typescript
const { data } = await supabase
  .from('tickets')
  .select('status, wait_seconds, service_seconds')
  .eq('queue_id', queueId)
  .eq('business_date', todayBusinessDate);
// クライアント側で集計する（件数が少ないため）
```

### 4.4 プリンタ状態

```typescript
const { data } = await supabase
  .from('printers')
  .select('id, name, is_online, has_error, error_label, last_seen_at, device_token')
  .eq('is_active', true);

// 3分以上ポーリングがなければオフライン扱いにする
const offline = Date.now() - new Date(p.last_seen_at).getTime() > 180_000;
```

---

## 5. Realtime 購読

### 5.1 ゲストステータス画面

```typescript
const channel = supabase
  .channel(`guest:${queueId}`)
  .on('postgres_changes', {
    event: 'UPDATE',
    schema: 'public',
    table: 'queue_states',
    filter: `queue_id=eq.${queueId}`,
  }, () => {
    // 変化を検知したら自分の状況を取り直す（実データはRealtimeに乗せない）
    refetchStatus();
  })
  .subscribe();
```

### 5.2 サイネージ

```typescript
const channel = supabase
  .channel(`signage:${tenantId}`)
  .on('postgres_changes', {
    event: 'UPDATE', schema: 'public', table: 'queue_states',
    filter: `tenant_id=eq.${tenantId}`,
  }, (payload) => {
    const prev = payload.old as QueueState;
    const next = payload.new as QueueState;
    if (next.called_seq > (prev?.called_seq ?? 0)) {
      flashAndSpeak(next.now_serving_number, next.now_serving_counter);
    }
    updateBoard(next);
  })
  .subscribe();
```

`called_seq` の増加を「新しい呼び出しがあった」の判定に使う。
（`now_serving_number` の比較だと、同じ番号を再呼出したときに検知できない）

### 5.3 スタッフ画面

```typescript
const channel = supabase
  .channel(`staff:${queueId}`)
  .on('postgres_changes', {
    event: '*', schema: 'public', table: 'tickets',
    filter: `queue_id=eq.${queueId}`,
  }, (payload) => applyTicketChange(payload))
  .subscribe();
```

### 5.4 接続数の節約（必須実装）

```typescript
// 5分間バックグラウンドにあったら切断する
let hiddenSince: number | null = null;

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenSince = Date.now();
    setTimeout(() => {
      if (document.hidden && hiddenSince && Date.now() - hiddenSince >= 300_000) {
        channel.unsubscribe();
      }
    }, 300_000);
  } else {
    hiddenSince = null;
    if (channel.state !== 'joined') {
      channel.subscribe();
      refetchStatus();     // 復帰時は必ず1回取り直す
    }
  }
});

// 終端状態になったら即座に切断
if (['done', 'no_show', 'canceled'].includes(status)) channel.unsubscribe();
```

---

## 6. Edge Function

### 6.1 `POST/GET/DELETE /functions/v1/cloudprnt`

プリンタ専用。詳細は `07_印刷仕様書.md` を参照。
**デプロイ時に `--no-verify-jwt` が必須。**

### 6.2 `POST /functions/v1/send-push`

「あと2組」になったゲストにWeb Push通知を送る。
`tickets` の UPDATE を検知する Database Webhook から呼ぶ。

**リクエスト**

```json
{ "queue_id": "2222...-2222" }
```

**処理内容**

1. 当該キューの待機列で、先頭から3番目までのチケットを取得
2. `push_subscriptions` に購読があり、`notified_at` が NULL のものを抽出
3. VAPID鍵で署名してWeb Pushを送信
4. `notified_at` を更新

**通知の内容**

```json
{
  "title": "まもなくお呼び出しします",
  "body": "R-024 番 / あと2組です。レストラン入口までお越しください。",
  "icon": "/icon-192.png",
  "data": { "url": "/t/aB3xK9mZ7pQ2rT5vW8yC1e" }
}
```

**VAPID鍵の生成**

```bash
npx web-push generate-vapid-keys
# 公開鍵 → フロントの環境変数 VITE_VAPID_PUBLIC_KEY
# 秘密鍵 → npx supabase secrets set VAPID_PRIVATE_KEY=xxx
```

> ⚠️ iOSでは、ゲストがWebサイトを「ホーム画面に追加」していない限り購読できない。
> 購読に失敗しても機能全体を止めず、静かに無視すること。

### 6.3 `POST /functions/v1/daily-maintenance`

`daily_maintenance()` RPCを呼ぶだけの薄いラッパー。
GitHub Actions の日次ワークフローから、`SUPABASE_SERVICE_ROLE_KEY` を付けて叩く。

```yaml
- name: Daily maintenance
  run: |
    curl -X POST "${{ secrets.SUPABASE_URL }}/functions/v1/daily-maintenance" \
      -H "Authorization: Bearer ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}"
```

---

## 7. エラーハンドリング方針

| 状況 | 挙動 |
|---|---|
| RPCが `{ok:false, error:"..."}` を返した | エラーコードに応じた日本語メッセージを表示。ログには残す |
| RPCがネットワークエラー | 3回まで指数バックオフでリトライ（**同じnonceで**）。失敗したらオフライン扱い |
| `supabase.auth` のセッション切れ | ログイン画面へリダイレクト。編集中データは `sessionStorage` に退避 |
| Realtime の切断 | supabase-js が自動再接続する。UIには「再接続中」のインジケータを出し、復帰時に全件を取り直す |

```typescript
// リトライの実装例
async function rpcWithRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 300 * 2 ** i));  // 300, 600, 1200ms
    }
  }
  throw new Error('unreachable');
}
```
