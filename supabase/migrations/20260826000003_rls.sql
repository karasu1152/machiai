-- 出典: 04_データベース設計書.md より自動抽出
-- 内容: RLS・実行権限

-- ============================================================
-- 04_データベース設計書.md 第9章: Row Level Security
-- ============================================================
-- ============================================================
-- 9. RLS
-- ============================================================
alter table public.tenants            enable row level security;
alter table public.staff              enable row level security;
alter table public.queues             enable row level security;
alter table public.counters           enable row level security;
alter table public.printers           enable row level security;
alter table public.tickets            enable row level security;
alter table public.queue_states       enable row level security;
alter table public.print_jobs         enable row level security;
alter table public.ticket_events      enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.daily_stats        enable row level security;

-- ---- 匿名に許可する読み取り（個人情報を含まないものだけ）----
create policy anon_read_tenants on public.tenants
  for select to anon using (true);

create policy anon_read_queues on public.queues
  for select to anon using (true);

create policy anon_read_queue_states on public.queue_states
  for select to anon using (true);

create policy anon_read_counters on public.counters
  for select to anon using (is_active);

-- ★ tickets は匿名に一切開放しない。get_ticket_status RPC 経由のみ。

-- ---- スタッフ（認証済み）----
create policy staff_self on public.staff
  for select to authenticated using (tenant_id = public.current_tenant_id());

create policy staff_rw_tickets on public.tickets
  for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy staff_read_events on public.ticket_events
  for select to authenticated using (tenant_id = public.current_tenant_id());

create policy staff_read_printjobs on public.print_jobs
  for select to authenticated using (tenant_id = public.current_tenant_id());

create policy staff_read_stats on public.daily_stats
  for select to authenticated using (tenant_id = public.current_tenant_id());

create policy staff_read_printers on public.printers
  for select to authenticated using (tenant_id = public.current_tenant_id());

-- ---- 管理者のみ設定変更可 ----
create policy admin_write_queues on public.queues
  for all to authenticated
  using (tenant_id = public.current_tenant_id() and public.is_admin())
  with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy admin_write_counters on public.counters
  for all to authenticated
  using (tenant_id = public.current_tenant_id() and public.is_admin())
  with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy admin_write_printers on public.printers
  for all to authenticated
  using (tenant_id = public.current_tenant_id() and public.is_admin())
  with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy admin_write_tenants on public.tenants
  for update to authenticated
  using (id = public.current_tenant_id() and public.is_admin());

-- 一般スタッフでも受付開始/停止だけは行えるようにする
create policy staff_toggle_queue on public.queues
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- ============================================================
-- 04_データベース設計書.md 第10章: 実行権限
-- ============================================================
-- ============================================================
-- 10. GRANT（匿名に公開するRPCは4つだけ）
-- ============================================================
revoke all on function public.issue_ticket(uuid,int,text,text,text,text,text,text) from public;
grant execute on function public.issue_ticket(uuid,int,text,text,text,text,text,text) to anon, authenticated;

grant execute on function public.get_ticket_status(text)            to anon, authenticated;
grant execute on function public.get_public_queues(text)            to anon, authenticated;
grant execute on function public.register_push_subscription(text,text,text,text) to anon, authenticated;

-- 以下は認証済みのみ
grant execute on function public.call_next(uuid,uuid)               to authenticated;
grant execute on function public.call_ticket(uuid,uuid)             to authenticated;
grant execute on function public.set_ticket_status(uuid,ticket_status,text) to authenticated;
grant execute on function public.requeue_ticket(uuid,text)          to authenticated;
grant execute on function public.reprint_ticket(uuid,text)          to authenticated;

revoke execute on function public.call_next(uuid,uuid)              from anon;
revoke execute on function public.call_ticket(uuid,uuid)            from anon;
revoke execute on function public.set_ticket_status(uuid,ticket_status,text) from anon;
revoke execute on function public.requeue_ticket(uuid,text)         from anon;
revoke execute on function public.reprint_ticket(uuid,text)         from anon;
revoke execute on function public.build_ticket_markup(uuid,text)    from anon, authenticated;
