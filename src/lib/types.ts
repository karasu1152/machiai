// DBの型定義スタブ。
// 本来は `npx supabase gen types typescript` で生成したものに置き換える
// (Supabaseプロジェクト作成・DDL適用が完了してから実行できる)。
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
