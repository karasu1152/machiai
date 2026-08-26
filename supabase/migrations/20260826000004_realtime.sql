-- 出典: 04_データベース設計書.md より自動抽出
-- 内容: Realtime公開設定

-- ============================================================
-- 04_データベース設計書.md 第11章: Realtime の有効化
-- ============================================================
-- ============================================================
-- 11. Realtime 公開設定
-- ============================================================
alter publication supabase_realtime add table public.queue_states;
alter publication supabase_realtime add table public.tickets;
alter publication supabase_realtime add table public.queues;
alter publication supabase_realtime add table public.printers;

-- UPDATE イベントで旧値も取得できるようにする（差分判定用）
alter table public.queue_states replica identity full;
alter table public.tickets      replica identity full;
