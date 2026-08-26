-- 出典: 04_データベース設計書.md より自動抽出
-- 内容: 日次メンテナンス

-- ============================================================
-- 04_データベース設計書.md 第12章: 日次メンテナンス
-- ============================================================
-- ============================================================
-- 12. 日次メンテナンス（Edge Function から1日1回呼ぶ）
-- ============================================================
create or replace function public.daily_maintenance()
returns json
language plpgsql security definer set search_path = public as $$
declare v_stats int; v_purged int;
begin
  -- 12.1 前日分の集計を daily_stats に確定
  --      hourly は「時間帯ごとの発券数と平均待ち時間」を2段階で集計する。
  --      （1段階でjsonb_object_aggすると同一時間帯のキーが重複し、件数が1に潰れる）
  with per_hour as (
    select t.tenant_id, t.queue_id, t.business_date,
           to_char(t.issued_at at time zone tn.timezone, 'HH24') as hh,
           count(*) as issued,
           avg(t.wait_seconds)::int as avg_wait
    from public.tickets t
    join public.tenants tn on tn.id = t.tenant_id
    where t.business_date >= current_date - 2
    group by 1,2,3,4
  ),
  hourly_map as (
    select tenant_id, queue_id, business_date,
           jsonb_object_agg(hh, jsonb_build_object('issued', issued, 'avg_wait', avg_wait)) as hourly
    from per_hour
    group by 1,2,3
  )
  insert into public.daily_stats as ds
    (tenant_id, queue_id, business_date, issued_count, served_count,
     no_show_count, canceled_count, avg_wait_seconds, max_wait_seconds,
     p90_wait_seconds, avg_service_seconds, hourly, updated_at)
  select
    t.tenant_id, t.queue_id, t.business_date,
    count(*),
    count(*) filter (where t.status = 'done'),
    count(*) filter (where t.status = 'no_show'),
    count(*) filter (where t.status = 'canceled'),
    avg(t.wait_seconds)::int,
    max(t.wait_seconds),
    percentile_cont(0.9) within group (order by t.wait_seconds)::int,
    avg(t.service_seconds)::int,
    coalesce(hm.hourly, '{}'::jsonb),
    now()
  from public.tickets t
  left join hourly_map hm
    on hm.tenant_id = t.tenant_id
   and hm.queue_id  = t.queue_id
   and hm.business_date = t.business_date
  where t.business_date >= current_date - 2
  group by t.tenant_id, t.queue_id, t.business_date, hm.hourly
  on conflict (tenant_id, queue_id, business_date) do update set
    issued_count = excluded.issued_count,
    served_count = excluded.served_count,
    no_show_count = excluded.no_show_count,
    canceled_count = excluded.canceled_count,
    avg_wait_seconds = excluded.avg_wait_seconds,
    max_wait_seconds = excluded.max_wait_seconds,
    p90_wait_seconds = excluded.p90_wait_seconds,
    avg_service_seconds = excluded.avg_service_seconds,
    hourly = excluded.hourly,
    updated_at = now();
  get diagnostics v_stats = row_count;

  -- 12.2 個人情報の消去（90日）
  update public.tickets set room_number = null, note = null
  where room_number is not null and issued_at < now() - interval '90 days';

  -- 12.3 古いデータの削除
  delete from public.print_jobs   where created_at < now() - interval '7 days';
  delete from public.ticket_events where created_at < now() - interval '400 days';
  delete from public.push_subscriptions
    where ticket_id in (select id from public.tickets
                        where status in ('done','no_show','canceled')
                          and updated_at < now() - interval '24 hours');
  delete from public.tickets where issued_at < now() - interval '400 days';
  get diagnostics v_purged = row_count;

  -- 12.4 期限切れの印刷ジョブを failed に
  update public.print_jobs set status = 'expired'
  where status in ('queued','delivered') and expires_at < now();

  -- 12.5 取り残された waiting を自動クローズ（前業務日以前のもの）
  update public.tickets set status = 'canceled', canceled_at = now(),
         cancel_reason = 'auto_close_end_of_day'
  where status in ('waiting','called','serving')
    and issued_at < now() - interval '18 hours';

  return json_build_object('ok', true, 'stats_rows', v_stats, 'purged', v_purged);
end $$;

revoke execute on function public.daily_maintenance() from anon, authenticated;
