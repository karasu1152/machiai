-- 出典: 独自追加パッチ(04_データベース設計書.md からの自動抽出ではない)
--
-- 【発見した問題】
-- 04_データベース設計書.md 9章のRLS定義には、一般スタッフ(authenticated・非admin)が
-- tenants / queues / queue_states / counters をSELECTするためのポリシーが
-- 存在しなかった。存在するのは
--   - anon向けの各 anon_read_* ポリシー(匿名専用。authenticatedロールには適用されない)
--   - admin_write_* (ALLコマンド。ただし is_admin() 必須)
--   - staff_toggle_queue (queuesのUPDATEのみ。SELECTは含まない)
-- のみで、これではスタッフ画面(DashboardPage / QueueManagePage)が
-- 自テナントのキュー一覧や現在状況を取得できない(RLSにより0件になる)。
--
-- 【対応】
-- 一般スタッフでも自テナント分だけはSELECTできるよう、tenant_idスコープの
-- 読み取り専用ポリシーを追加する。admin_write_* とは競合しない
-- (PostgreSQLのRLSポリシーはOR結合のため、いずれか一つでも許可すれば読める)。

create policy staff_read_tenant on public.tenants
  for select to authenticated
  using (id = public.current_tenant_id());

create policy staff_read_queues on public.queues
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy staff_read_queue_states on public.queue_states
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy staff_read_counters on public.counters
  for select to authenticated
  using (tenant_id = public.current_tenant_id());
