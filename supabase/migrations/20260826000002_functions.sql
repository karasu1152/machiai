-- 出典: 04_データベース設計書.md より自動抽出
-- 内容: 共通関数・待ち時間推定・queue_states自動更新・券面マークアップ・主要RPC

-- ============================================================
-- 04_データベース設計書.md 第4章: 共通関数
-- ============================================================
-- ============================================================
-- 4. 共通関数
-- ============================================================

-- 4.1 業務日を求める
create or replace function public.business_date_of(
  p_ts timestamptz, p_tz text, p_cutoff int
) returns date
language sql immutable as $$
  select ((p_ts at time zone p_tz) - (p_cutoff || ' hours')::interval)::date;
$$;

-- 4.2 QR用の推測不可能トークン（22文字・URLセーフ・128bit）
create or replace function public.gen_public_token()
returns text
language sql volatile as $$
  select rtrim(
           translate(encode(extensions.gen_random_bytes(16), 'base64'), '+/', '-_'),
           '='
         );
$$;

-- 4.3 ログイン中スタッフのテナントID（RLSから呼ぶ。SECURITY DEFINERで再帰を防ぐ）
create or replace function public.current_tenant_id()
returns uuid
language sql stable security definer set search_path = public, auth as $$
  select tenant_id from public.staff where id = auth.uid() and is_active;
$$;

-- 4.4 管理者かどうか
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select coalesce((select role = 'admin' from public.staff
                   where id = auth.uid() and is_active), false);
$$;

-- 4.5 多言語JSONBから指定ロケールの文字列を取り出す（無ければ ja → en の順にフォールバック）
create or replace function public.i18n(p jsonb, p_locale text)
returns text
language sql immutable as $$
  select coalesce(p ->> p_locale, p ->> 'ja', p ->> 'en', '');
$$;

-- ============================================================
-- 04_データベース設計書.md 第5章: 待ち時間推定
-- ============================================================
-- ============================================================
-- 5. 待ち時間推定
-- ============================================================
create or replace function public.estimate_wait_seconds(
  p_queue_id uuid,
  p_ahead    int          -- 自分より前の待機組数
) returns int
language plpgsql stable security definer set search_path = public as $$
declare
  v_queue        public.queues%rowtype;
  v_sample_count int;
  v_service      numeric;
  v_counters     int;
  v_result       numeric;
begin
  select * into v_queue from public.queues where id = p_queue_id;
  if not found then return 0; end if;

  -- 手動上書きが設定されていればそれを返す
  if v_queue.manual_wait_minutes is not null then
    return v_queue.manual_wait_minutes * 60;
  end if;

  if p_ahead <= 0 then return 0; end if;

  -- 直近3時間の完了実績から1組あたり所要時間の中央値を取る
  with recent as (
    select extract(epoch from (finished_at - called_at)) as sec
    from public.tickets
    where queue_id = p_queue_id
      and status = 'done'
      and finished_at > now() - interval '3 hours'
      and called_at is not null
      and finished_at > called_at
    order by finished_at desc
    limit 20
  )
  select count(*), percentile_cont(0.5) within group (order by sec)
    into v_sample_count, v_service
  from recent;

  if coalesce(v_sample_count, 0) < 8 or v_service is null or v_service <= 0 then
    v_service := v_queue.default_service_seconds;
  end if;

  -- 直近30分に稼働した窓口数を実効並列数とする
  select greatest(count(distinct counter_id), 1) into v_counters
  from public.tickets
  where queue_id = p_queue_id
    and last_called_at > now() - interval '30 minutes'
    and counter_id is not null;

  v_counters := least(v_counters, greatest(v_queue.max_counters, 1));

  -- 待ち時間 = ceil(前の組数 / 窓口数) * 1組あたり時間 * 安全係数1.1
  v_result := ceil(p_ahead::numeric / v_counters) * v_service * 1.1;

  return least(v_result, 7200)::int;   -- 上限2時間でクリップ
end $$;

-- ============================================================
-- 04_データベース設計書.md 第6章: queue_states の自動更新
-- ============================================================
-- ============================================================
-- 6. queue_states の自動更新
-- ============================================================
create or replace function public.refresh_queue_state(p_queue_id uuid, p_bump_call boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid;
  v_waiting  int;
  v_serving_number text;
  v_serving_counter text;
  v_last_issued text;
  v_est      int;
  v_is_open  boolean;
begin
  select tenant_id, is_open into v_tenant, v_is_open
  from public.queues where id = p_queue_id;
  if not found then return; end if;

  select count(*) into v_waiting
  from public.tickets where queue_id = p_queue_id and status = 'waiting';

  -- 直近に呼び出されたチケット（called または serving のうち最終呼出が最も新しいもの）
  select t.display_number, c.short_name
    into v_serving_number, v_serving_counter
  from public.tickets t
  left join public.counters c on c.id = t.counter_id
  where t.queue_id = p_queue_id
    and t.status in ('called','serving')
    and t.last_called_at is not null
  order by t.last_called_at desc
  limit 1;

  select display_number into v_last_issued
  from public.tickets where queue_id = p_queue_id
  order by issued_at desc limit 1;

  v_est := public.estimate_wait_seconds(p_queue_id, v_waiting);

  insert into public.queue_states as qs
    (queue_id, tenant_id, now_serving_number, now_serving_counter,
     called_seq, waiting_count, last_issued_number, estimated_wait_seconds,
     is_open, updated_at)
  values
    (p_queue_id, v_tenant, v_serving_number, v_serving_counter,
     case when p_bump_call then 1 else 0 end, v_waiting, v_last_issued, v_est,
     v_is_open, now())
  on conflict (queue_id) do update set
    now_serving_number  = excluded.now_serving_number,
    now_serving_counter = excluded.now_serving_counter,
    called_seq          = qs.called_seq + case when p_bump_call then 1 else 0 end,
    waiting_count       = excluded.waiting_count,
    last_issued_number  = excluded.last_issued_number,
    estimated_wait_seconds = excluded.estimated_wait_seconds,
    is_open             = excluded.is_open,
    updated_at          = now();
end $$;

-- チケットの変更で自動更新
create or replace function public.trg_tickets_refresh_state()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.refresh_queue_state(coalesce(new.queue_id, old.queue_id), false);
  return null;
end $$;

drop trigger if exists tickets_refresh_state on public.tickets;
create trigger tickets_refresh_state
after insert or update or delete on public.tickets
for each row execute function public.trg_tickets_refresh_state();

-- キューの受付状態変更でも更新
create or replace function public.trg_queues_refresh_state()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.refresh_queue_state(new.id, false);
  return null;
end $$;

drop trigger if exists queues_refresh_state on public.queues;
create trigger queues_refresh_state
after insert or update of is_open, manual_wait_minutes on public.queues
for each row execute function public.trg_queues_refresh_state();

-- updated_at の自動更新
create or replace function public.trg_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists tickets_touch on public.tickets;
create trigger tickets_touch before update on public.tickets
for each row execute function public.trg_touch_updated_at();

drop trigger if exists queues_touch on public.queues;
create trigger queues_touch before update on public.queues
for each row execute function public.trg_touch_updated_at();

-- ============================================================
-- 04_データベース設計書.md 第7章: 券面マークアップ生成
-- ============================================================
-- ============================================================
-- 7. 券面マークアップ生成
-- ============================================================
create or replace function public.build_ticket_markup(
  p_ticket_id uuid,
  p_base_url  text        -- 例: 'https://machiai.pages.dev'
) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  t        public.tickets%rowtype;
  q        public.queues%rowtype;
  tn       public.tenants%rowtype;
  v_ahead  int;
  v_wait   text;
  v_note   text;
  v_qr     text;
  v_out    text;
  v_lead   text;
begin
  select * into t from public.tickets where id = p_ticket_id;
  select * into q from public.queues  where id = t.queue_id;
  select * into tn from public.tenants where id = t.tenant_id;

  select count(*) into v_ahead
  from public.tickets
  where queue_id = t.queue_id and status = 'waiting' and sort_key < t.sort_key;

  -- 待ち時間の文言
  v_wait := case
    when coalesce(t.estimated_wait_seconds_at_issue,0) < 60 then
      case t.locale when 'en' then 'Soon' when 'zh' then '即将' when 'ko' then '곧' else 'まもなく' end
    when t.estimated_wait_seconds_at_issue >= 3600 then
      case t.locale when 'en' then '60+ min' when 'zh' then '60分钟以上' when 'ko' then '60분 이상' else '60分以上' end
    else
      (ceil(t.estimated_wait_seconds_at_issue / 300.0) * 5)::text ||
      case t.locale when 'en' then ' min' when 'zh' then ' 分钟' when 'ko' then '분' else '分' end
  end;

  v_lead := case t.locale
    when 'en' then 'Groups ahead'
    when 'zh' then '前面组数'
    when 'ko' then '앞 대기 팀'
    else 'お待ちの組数' end;

  -- ⚠ 改行は必ず chr(10) で連結すること。SQLの単一引用符内では \n はエスケープされず、
  --    そのまま「\n」の2文字として券面に印字されてしまう。
  v_note := coalesce(nullif(public.i18n(q.ticket_note, t.locale), ''),
    case t.locale
      when 'en' then 'Scan the QR code to check your turn.'||chr(10)||'Please keep this screen open.'
      when 'zh' then '扫描二维码可查看叫号进度。'||chr(10)||'请保持页面开启。'
      when 'ko' then 'QR코드를 스캔하면 순번을 확인할 수 있습니다.'||chr(10)||'화면을 켜 둔 채 기다려 주세요.'
      else 'QRコードでお呼び出し状況を確認できます。'||chr(10)||'画面を開いたままお待ちください。'
    end);

  v_qr := p_base_url || '/t/' || t.public_token;

  v_out :=
      '[align: center]' || chr(10)
   || '[magnify: width 2; height 2]' || tn.name || '[plain]' || chr(10)
   || '[feed: 1]' || chr(10)
   || public.i18n(q.name, t.locale) || chr(10)
   || '[feed: 1]' || chr(10)
   || '[magnify: width 4; height 4]' || t.display_number || '[plain]' || chr(10)
   || '[feed: 1]' || chr(10)
   || '[align: left]' || chr(10)
   || v_lead || ' : ' || v_ahead::text || chr(10)
   || (case t.locale when 'en' then 'Est. wait' when 'zh' then '预计等待'
                     when 'ko' then '예상 대기' else '目安待ち時間' end)
      || ' : ' || v_wait || chr(10);

  if t.party_size is not null then
    v_out := v_out || (case t.locale when 'en' then 'Party' when 'zh' then '人数'
                                     when 'ko' then '인원' else 'ご人数' end)
                   || ' : ' || t.party_size::text || chr(10);
  end if;

  if t.room_number is not null then
    v_out := v_out || (case t.locale when 'en' then 'Room' when 'zh' then '房间号'
                                     when 'ko' then '객실' else 'お部屋番号' end)
                   || ' : ' || t.room_number || chr(10);
  end if;

  v_out := v_out
   || '[feed: 1]' || chr(10)
   || '[align: center]' || chr(10)
   || '[barcode: type qr; data "' || v_qr || '"; cell 6; error-correction medium]' || chr(10)
   || '[feed: 1]' || chr(10)
   || v_note || chr(10)
   || '[feed: 1]' || chr(10)
   || to_char(t.issued_at at time zone tn.timezone, 'YYYY/MM/DD HH24:MI') || chr(10)
   || '[feed: 3]' || chr(10)
   || '[cut: partial; feed]';

  return v_out;
end $$;

-- ============================================================
-- 04_データベース設計書.md 第8章: 主要RPC関数
-- ============================================================
-- ============================================================
-- 8.1 issue_ticket — 発券
-- ============================================================
create or replace function public.issue_ticket(
  p_queue_id        uuid,
  p_party_size      int    default null,
  p_room_number     text   default null,
  p_seat_preference text   default null,
  p_locale          text   default 'ja',
  p_source          text   default 'kiosk',
  p_client_nonce    text   default null,
  p_base_url        text   default null
) returns json
language plpgsql security definer set search_path = public as $$
declare
  q          public.queues%rowtype;
  tn         public.tenants%rowtype;
  v_bd       date;
  v_number   int;
  v_display  text;
  v_token    text;
  v_ahead    int;
  v_est      int;
  v_ticket   public.tickets%rowtype;
  v_printer  uuid;
  v_markup   text;
  v_waiting  int;
begin
  -- 既存nonceがあれば同じチケットを返す（二重発券防止）
  if p_client_nonce is not null then
    select * into v_ticket from public.tickets
    where queue_id = p_queue_id and client_nonce = p_client_nonce;
    if found then
      select count(*) into v_ahead from public.tickets
      where queue_id = p_queue_id and status='waiting' and sort_key < v_ticket.sort_key;
      return json_build_object(
        'ok', true, 'duplicated', true,
        'ticket_id', v_ticket.id,
        'display_number', v_ticket.display_number,
        'public_token', v_ticket.public_token,
        'ahead', v_ahead,
        'estimated_wait_seconds', v_ticket.estimated_wait_seconds_at_issue);
    end if;
  end if;

  -- キューをロックして採番の一貫性を担保
  select * into q from public.queues where id = p_queue_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'QUEUE_NOT_FOUND');
  end if;

  select * into tn from public.tenants where id = q.tenant_id;

  if not q.is_open then
    return json_build_object('ok', false, 'error', 'QUEUE_CLOSED');
  end if;

  -- 営業時間チェック
  if q.open_time is not null and q.close_time is not null then
    if (now() at time zone tn.timezone)::time not between q.open_time and q.close_time then
      return json_build_object('ok', false, 'error', 'OUT_OF_HOURS');
    end if;
  end if;

  select count(*) into v_waiting from public.tickets
  where queue_id = p_queue_id and status = 'waiting';

  if q.max_waiting is not null and v_waiting >= q.max_waiting then
    return json_build_object('ok', false, 'error', 'QUEUE_FULL');
  end if;

  -- 業務日と採番
  v_bd := public.business_date_of(now(), tn.timezone, tn.business_day_cutoff_hour);

  if q.last_reset_business_date is distinct from v_bd then
    v_number := 1;
  else
    v_number := q.last_number + 1;
    if v_number > q.max_number then v_number := 1; end if;
  end if;

  update public.queues
     set last_number = v_number,
         last_reset_business_date = v_bd
   where id = p_queue_id;

  v_display := q.prefix || '-' || lpad(v_number::text, 3, '0');
  v_token   := public.gen_public_token();
  v_ahead   := v_waiting;
  v_est     := public.estimate_wait_seconds(p_queue_id, v_ahead);

  insert into public.tickets (
    tenant_id, queue_id, number, display_number, public_token, business_date,
    status, sort_key, party_size, room_number, seat_preference, locale,
    source, issued_by, client_nonce, estimated_wait_seconds_at_issue
  ) values (
    q.tenant_id, p_queue_id, v_number, v_display, v_token, v_bd,
    'waiting', extract(epoch from clock_timestamp()),
    p_party_size, nullif(p_room_number,''), nullif(p_seat_preference,''),
    coalesce(p_locale,'ja'),
    coalesce(p_source,'kiosk'),
    case when p_source = 'staff' then auth.uid() else null end,
    p_client_nonce, v_est
  ) returning * into v_ticket;

  insert into public.ticket_events (tenant_id, ticket_id, from_status, to_status, actor_id, actor_kind)
  values (q.tenant_id, v_ticket.id, null, 'waiting',
          case when p_source='staff' then auth.uid() else null end,
          coalesce(p_source,'kiosk'));

  -- 印刷ジョブ投入（失敗しても発券は成功させる）
  v_printer := q.printer_id;
  if v_printer is not null then
    begin
      v_markup := public.build_ticket_markup(
        v_ticket.id, coalesce(p_base_url, 'https://machiai.pages.dev'));
      insert into public.print_jobs (tenant_id, printer_id, ticket_id, payload)
      values (q.tenant_id, v_printer, v_ticket.id, v_markup);
    exception when others then
      update public.tickets set print_status = 'failed' where id = v_ticket.id;
    end;
  else
    update public.tickets set print_status = 'skipped' where id = v_ticket.id;
  end if;

  return json_build_object(
    'ok', true,
    'duplicated', false,
    'ticket_id', v_ticket.id,
    'display_number', v_display,
    'public_token', v_token,
    'queue_name', q.name,
    'ahead', v_ahead,
    'estimated_wait_seconds', v_est,
    'status_url', coalesce(p_base_url,'https://machiai.pages.dev') || '/t/' || v_token,
    'issued_at', v_ticket.issued_at
  );
end $$;


-- ============================================================
-- 8.2 get_ticket_status — QRトークンから自分の状況を取得
-- ============================================================
create or replace function public.get_ticket_status(p_token text)
returns json
language plpgsql stable security definer set search_path = public as $$
declare
  t       public.tickets%rowtype;
  q       public.queues%rowtype;
  tn      public.tenants%rowtype;
  c       public.counters%rowtype;
  v_ahead int;
  v_est   int;
begin
  select * into t from public.tickets where public_token = p_token;
  if not found then
    return json_build_object('ok', false, 'error', 'NOT_FOUND');
  end if;

  -- 発行から24時間を超えたトークンは無効
  if t.issued_at < now() - interval '24 hours' then
    return json_build_object('ok', false, 'error', 'EXPIRED');
  end if;

  select * into q  from public.queues  where id = t.queue_id;
  select * into tn from public.tenants where id = t.tenant_id;
  if t.counter_id is not null then
    select * into c from public.counters where id = t.counter_id;
  end if;

  if t.status = 'waiting' then
    select count(*) into v_ahead from public.tickets
    where queue_id = t.queue_id and status = 'waiting' and sort_key < t.sort_key;
    v_est := public.estimate_wait_seconds(t.queue_id, v_ahead);
  else
    v_ahead := 0; v_est := 0;
  end if;

  return json_build_object(
    'ok', true,
    'display_number', t.display_number,
    'status', t.status,
    'queue_id', t.queue_id,
    'queue_name', q.name,
    'tenant_name', tn.name,
    'locale', t.locale,
    'party_size', t.party_size,
    'ahead', v_ahead,
    'estimated_wait_seconds', v_est,
    'called_count', t.called_count,
    'counter_name', case when c.id is not null then c.name else null end,
    'issued_at', t.issued_at,
    'called_at', t.last_called_at
  );
end $$;


-- ============================================================
-- 8.3 get_public_queues — キオスクに出すキュー一覧
-- ============================================================
create or replace function public.get_public_queues(p_tenant_slug text)
returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x order by x.sort_order), '[]'::json)
  from (
    select q.id, q.name, q.description, q.prefix, q.color, q.icon, q.sort_order,
           q.ask_party_size, q.party_size_options,
           q.ask_room_number, q.ask_seat_preference, q.seat_options,
           q.is_open
             and (q.open_time is null or
                  (now() at time zone tn.timezone)::time between q.open_time and q.close_time)
             and (q.max_waiting is null or coalesce(qs.waiting_count,0) < q.max_waiting)
             as acceptable,
           coalesce(qs.waiting_count, 0)          as waiting_count,
           coalesce(qs.estimated_wait_seconds, 0) as estimated_wait_seconds
    from public.queues q
    join public.tenants tn on tn.id = q.tenant_id
    left join public.queue_states qs on qs.queue_id = q.id
    where tn.slug = p_tenant_slug
  ) x;
$$;


-- ============================================================
-- 8.4 呼び出し・状態変更系（すべて認証必須）
-- ============================================================

-- 次を呼ぶ（FOR UPDATE SKIP LOCKED で二重呼出を防ぐ）
create or replace function public.call_next(p_queue_id uuid, p_counter_id uuid default null)
returns json
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_t public.tickets%rowtype;
begin
  if public.current_tenant_id() is null then
    return json_build_object('ok', false, 'error', 'UNAUTHORIZED');
  end if;

  select id into v_id
  from public.tickets
  where queue_id = p_queue_id and status = 'waiting'
  order by sort_key asc
  limit 1
  for update skip locked;

  if v_id is null then
    return json_build_object('ok', false, 'error', 'NO_WAITING');
  end if;

  update public.tickets set
    status         = 'called',
    called_at      = coalesce(called_at, now()),
    last_called_at = now(),
    called_count   = called_count + 1,
    counter_id     = coalesce(p_counter_id, counter_id),
    called_by      = auth.uid()
  where id = v_id
  returning * into v_t;

  insert into public.ticket_events(tenant_id,ticket_id,from_status,to_status,actor_id,actor_kind,counter_id)
  values (v_t.tenant_id, v_t.id, 'waiting', 'called', auth.uid(), 'staff', p_counter_id);

  perform public.refresh_queue_state(p_queue_id, true);

  return json_build_object('ok', true, 'ticket_id', v_t.id,
                           'display_number', v_t.display_number);
end $$;

-- 指定チケットを呼ぶ（順番を飛ばす／再呼出も兼ねる）
create or replace function public.call_ticket(p_ticket_id uuid, p_counter_id uuid default null)
returns json
language plpgsql security definer set search_path = public as $$
declare v_t public.tickets%rowtype; v_from ticket_status;
begin
  if public.current_tenant_id() is null then
    return json_build_object('ok', false, 'error', 'UNAUTHORIZED');
  end if;

  select status into v_from from public.tickets
  where id = p_ticket_id and tenant_id = public.current_tenant_id() for update;
  if not found then return json_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  if v_from in ('done','canceled') then
    return json_build_object('ok', false, 'error', 'ALREADY_CLOSED');
  end if;

  update public.tickets set
    status         = 'called',
    called_at      = coalesce(called_at, now()),
    last_called_at = now(),
    called_count   = called_count + 1,
    counter_id     = coalesce(p_counter_id, counter_id),
    called_by      = auth.uid()
  where id = p_ticket_id
  returning * into v_t;

  insert into public.ticket_events(tenant_id,ticket_id,from_status,to_status,actor_id,actor_kind,counter_id,detail)
  values (v_t.tenant_id, v_t.id, v_from, 'called', auth.uid(), 'staff', p_counter_id,
          json_build_object('call_count', v_t.called_count)::jsonb);

  perform public.refresh_queue_state(v_t.queue_id, true);
  return json_build_object('ok', true, 'display_number', v_t.display_number,
                           'called_count', v_t.called_count);
end $$;

-- 汎用の状態変更（案内開始・完了・不在・取消）
create or replace function public.set_ticket_status(
  p_ticket_id uuid,
  p_status    ticket_status,
  p_reason    text default null
) returns json
language plpgsql security definer set search_path = public as $$
declare v_t public.tickets%rowtype; v_from ticket_status;
begin
  if public.current_tenant_id() is null then
    return json_build_object('ok', false, 'error', 'UNAUTHORIZED');
  end if;

  select status into v_from from public.tickets
  where id = p_ticket_id and tenant_id = public.current_tenant_id() for update;
  if not found then return json_build_object('ok', false, 'error', 'NOT_FOUND'); end if;

  update public.tickets set
    status = p_status,
    served_at = case when p_status = 'serving' then coalesce(served_at, now()) else served_at end,
    finished_at = case when p_status = 'done' then now() else finished_at end,
    no_show_at  = case when p_status = 'no_show' then now() else no_show_at end,
    canceled_at = case when p_status = 'canceled' then now() else canceled_at end,
    cancel_reason = case when p_status = 'canceled' then p_reason else cancel_reason end,
    wait_seconds = case
      when p_status in ('serving','done') and wait_seconds is null
      then extract(epoch from (now() - issued_at))::int else wait_seconds end,
    service_seconds = case
      when p_status = 'done' and served_at is not null
      then extract(epoch from (now() - served_at))::int else service_seconds end
  where id = p_ticket_id
  returning * into v_t;

  insert into public.ticket_events(tenant_id,ticket_id,from_status,to_status,actor_id,actor_kind,detail)
  values (v_t.tenant_id, v_t.id, v_from, p_status, auth.uid(), 'staff',
          coalesce(json_build_object('reason', p_reason)::jsonb, '{}'::jsonb));

  perform public.refresh_queue_state(v_t.queue_id, false);
  return json_build_object('ok', true, 'status', p_status);
end $$;

-- 不在から列に戻す
create or replace function public.requeue_ticket(
  p_ticket_id uuid,
  p_position  text default 'head'    -- 'head' | 'tail'
) returns json
language plpgsql security definer set search_path = public as $$
declare v_t public.tickets%rowtype; v_key double precision; v_from ticket_status;
begin
  if public.current_tenant_id() is null then
    return json_build_object('ok', false, 'error', 'UNAUTHORIZED');
  end if;

  select * into v_t from public.tickets
  where id = p_ticket_id and tenant_id = public.current_tenant_id() for update;
  if not found then return json_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  v_from := v_t.status;

  if p_position = 'head' then
    select coalesce(min(sort_key), extract(epoch from now())) - 1 into v_key
    from public.tickets where queue_id = v_t.queue_id and status = 'waiting';
  else
    select coalesce(max(sort_key), extract(epoch from now())) + 1 into v_key
    from public.tickets where queue_id = v_t.queue_id and status = 'waiting';
  end if;

  update public.tickets set
    status = 'waiting', sort_key = v_key, requeued_at = now(),
    no_show_at = null, counter_id = null
  where id = p_ticket_id;

  insert into public.ticket_events(tenant_id,ticket_id,from_status,to_status,actor_id,actor_kind,detail)
  values (v_t.tenant_id, v_t.id, v_from, 'waiting', auth.uid(), 'staff',
          json_build_object('position', p_position)::jsonb);

  perform public.refresh_queue_state(v_t.queue_id, false);
  return json_build_object('ok', true);
end $$;

-- 再印刷
create or replace function public.reprint_ticket(p_ticket_id uuid, p_base_url text)
returns json
language plpgsql security definer set search_path = public as $$
declare v_t public.tickets%rowtype; v_printer uuid; v_markup text;
begin
  if public.current_tenant_id() is null then
    return json_build_object('ok', false, 'error', 'UNAUTHORIZED');
  end if;
  select * into v_t from public.tickets
  where id = p_ticket_id and tenant_id = public.current_tenant_id();
  if not found then return json_build_object('ok', false, 'error', 'NOT_FOUND'); end if;

  select printer_id into v_printer from public.queues where id = v_t.queue_id;
  if v_printer is null then return json_build_object('ok', false, 'error', 'NO_PRINTER'); end if;

  v_markup := public.build_ticket_markup(p_ticket_id, p_base_url);
  insert into public.print_jobs (tenant_id, printer_id, ticket_id, payload, job_kind)
  values (v_t.tenant_id, v_printer, p_ticket_id, v_markup, 'reprint');

  return json_build_object('ok', true);
end $$;

-- Web Push購読の登録（匿名可）
create or replace function public.register_push_subscription(
  p_token text, p_endpoint text, p_p256dh text, p_auth text
) returns json
language plpgsql security definer set search_path = public as $$
declare v_ticket uuid;
begin
  select id into v_ticket from public.tickets
  where public_token = p_token and status in ('waiting','called');
  if not found then return json_build_object('ok', false, 'error', 'NOT_FOUND'); end if;

  insert into public.push_subscriptions (ticket_id, endpoint, p256dh, auth)
  values (v_ticket, p_endpoint, p_p256dh, p_auth)
  on conflict (ticket_id, endpoint) do nothing;

  return json_build_object('ok', true);
end $$;
