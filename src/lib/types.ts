// DBの型定義スタブ。
// 本来は `npx supabase gen types typescript` で生成したものに置き換える
// (Supabaseプロジェクト作成・DDL適用が完了済みであれば実行できる)。
// ここでは RPC の入出力(05_API仕様書.md)に沿って手書きしている。

export type TicketStatus =
  | 'waiting'
  | 'called'
  | 'serving'
  | 'done'
  | 'no_show'
  | 'canceled';

export interface Ticket {
  id: string;
  tenant_id: string;
  queue_id: string;
  display_number: string;
  status: TicketStatus;
  party_size: number | null;
  room_number: string | null;
  seat_preference: string | null;
  locale: string;
  sort_key: number;
  issued_at: string;
  called_at: string | null;
  called_count: number;
}

// get_public_queues の1件ぶん(05_API仕様書.md 2.1節)
export interface PublicQueue {
  id: string;
  name: Record<string, string>;
  description: Record<string, string>;
  prefix: string;
  color: string;
  icon: string;
  sort_order: number;
  ask_party_size: boolean;
  party_size_options: number[];
  ask_room_number: boolean;
  ask_seat_preference: boolean;
  seat_options: { code: string; label: Record<string, string> }[];
  acceptable: boolean;
  waiting_count: number;
  estimated_wait_seconds: number;
}

// issue_ticket の戻り値(05_API仕様書.md 2.2節)。成功/失敗どちらのフィールドも
// オプショナルにして、呼び出し側で ok を見て分岐する形にしている。
export interface IssueTicketResult {
  ok: boolean;
  error?: 'QUEUE_NOT_FOUND' | 'QUEUE_CLOSED' | 'OUT_OF_HOURS' | 'QUEUE_FULL';
  duplicated?: boolean;
  ticket_id?: string;
  display_number?: string;
  public_token?: string;
  queue_name?: Record<string, string>;
  ahead?: number;
  estimated_wait_seconds?: number;
  status_url?: string;
  issued_at?: string;
}

// queue_states のRealtimeペイロード(04_データベース設計書.md 3.7節)
export interface QueueStateRow {
  queue_id: string;
  tenant_id: string;
  now_serving_number: string | null;
  now_serving_counter: string | null;
  called_seq: number;
  waiting_count: number;
  last_issued_number: string | null;
  estimated_wait_seconds: number;
  is_open: boolean;
  updated_at: string;
}
