-- 出典: 04_データベース設計書.md より自動抽出
-- 内容: 拡張機能・ENUM・テーブル定義

-- ============================================================
-- 04_データベース設計書.md 第2章: 拡張機能とENUM
-- ============================================================
-- ============================================================
-- 2. 拡張機能・ENUM
-- ============================================================
create extension if not exists pgcrypto with schema extensions;

do $$ begin
  create type ticket_status as enum
    ('waiting', 'called', 'serving', 'done', 'no_show', 'canceled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type print_job_status as enum
    ('queued', 'delivered', 'confirmed', 'failed', 'expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type staff_role as enum ('admin', 'staff');
exception when duplicate_object then null; end $$;

-- ============================================================
-- 04_データベース設計書.md 第3章: テーブル定義
-- ============================================================
create table if not exists public.tenants (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,          -- URLに使う識別子 例: 'grand-mercure-hamanako'
  name          text not null,                 -- 券面・サイネージに出る施設名
  name_en       text,
  timezone      text not null default 'Asia/Tokyo',
  business_day_cutoff_hour int not null default 4,  -- 業務日の切替時刻(時)
  logo_enabled  boolean not null default false,     -- プリンタ内蔵ロゴを印字するか
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on column public.tenants.business_day_cutoff_hour is
  '統計の1日の切り替え時刻。4なら 04:00〜翌03:59 を1業務日とする';


create table if not exists public.staff (
  id          uuid primary key references auth.users(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  display_name text not null,
  role        staff_role not null default 'staff',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists idx_staff_tenant on public.staff(tenant_id);


create table if not exists public.queues (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  -- 表示名（4言語）
  name          jsonb not null,
  -- 例: {"ja":"フロントチェックイン","en":"Front Desk Check-in",
  --      "zh":"前台入住登记","ko":"프런트 체크인"}

  description   jsonb default '{}'::jsonb,   -- キオスクのボタン下に出る補足文
  prefix        text not null,               -- 表示番号のプレフィックス 例: 'C'
  color         text not null default '#0f766e',  -- サイネージ・キオスクの識別色
  icon          text default 'concierge',    -- キオスクボタンのアイコン識別子

  -- 受付制御
  is_open       boolean not null default true,
  open_time     time,                        -- NULLなら時間制限なし
  close_time    time,
  max_waiting   int,                         -- 同時待ち上限。NULLなら無制限

  -- 発券時の入力項目
  ask_party_size      boolean not null default false,
  party_size_options  int[]   not null default '{1,2,3,4,5}',
  ask_room_number     boolean not null default false,
  ask_seat_preference boolean not null default false,
  seat_options        jsonb   not null default '[]'::jsonb,
  -- 例: [{"code":"table","label":{"ja":"テーブル席","en":"Table"}},
  --      {"code":"counter","label":{"ja":"カウンター席","en":"Counter"}}]

  -- 採番
  last_number   int  not null default 0,
  max_number    int  not null default 999,
  last_reset_business_date date,

  -- 待ち時間推定
  default_service_seconds int not null default 180,
  max_counters            int not null default 3,
  manual_wait_minutes     int,              -- NULL以外なら自動推定を上書き
  long_wait_warn_minutes  int not null default 20,

  -- 券面
  printer_id    uuid,                        -- 既定の出力先プリンタ
  ticket_note   jsonb default '{}'::jsonb,   -- 券面下部の注意文言（言語別）

  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint queues_prefix_check check (prefix ~ '^[A-Z0-9]{1,3}$'),
  unique (tenant_id, prefix)
);

create index if not exists idx_queues_tenant on public.queues(tenant_id, sort_order);


create table if not exists public.counters (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  queue_id   uuid references public.queues(id) on delete set null,  -- NULLなら全キュー共通
  name       jsonb not null,   -- {"ja":"1番カウンター","en":"Counter 1"}
  short_name text not null,    -- サイネージ用の短縮表記 例: "1"
  is_active  boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_counters_tenant on public.counters(tenant_id, sort_order);


create table if not exists public.printers (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  name          text not null,                   -- 'フロント発券機'
  mac_address   text not null,                   -- CloudPRNTが送る printerMAC (大文字/コロン無し正規化)
  device_token  text not null default replace(gen_random_uuid()::text,'-',''),
  paper_width   int  not null default 80,        -- 80 or 58 (mm)
  chars_per_line int not null default 48,        -- 80mm/フォントA=48, 58mm=32
  is_active     boolean not null default true,
  poll_interval_seconds int not null default 10,

  -- 状態監視（ポーリングのたびに更新）
  last_seen_at  timestamptz,
  status_code   text,
  is_online     boolean not null default false,
  has_error     boolean not null default false,
  error_label   text,                            -- '用紙切れ' 等

  created_at    timestamptz not null default now(),
  unique (tenant_id, mac_address)
);

create unique index if not exists idx_printers_token on public.printers(device_token);

alter table public.queues
  add constraint queues_printer_fk
  foreign key (printer_id) references public.printers(id) on delete set null;


create table if not exists public.tickets (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  queue_id        uuid not null references public.queues(id) on delete cascade,

  number          int  not null,               -- 12
  display_number  text not null,               -- 'C-012'
  public_token    text not null unique,        -- QR用（22文字）
  business_date   date not null,

  status          ticket_status not null default 'waiting',
  sort_key        double precision not null,   -- 待機列の並び順

  -- ゲスト入力
  party_size      int,
  room_number     text,
  seat_preference text,
  locale          text not null default 'ja',

  -- 発券情報
  source          text not null default 'kiosk',  -- 'kiosk' | 'staff'
  issued_by       uuid references public.staff(id) on delete set null,
  client_nonce    text,                           -- 二重発券防止
  estimated_wait_seconds_at_issue int,            -- 券面に印字した目安

  -- 呼出情報
  counter_id      uuid references public.counters(id) on delete set null,
  called_count    int not null default 0,
  called_by       uuid references public.staff(id) on delete set null,

  -- タイムスタンプ
  issued_at       timestamptz not null default now(),
  called_at       timestamptz,       -- 初回呼出
  last_called_at  timestamptz,       -- 最終呼出（再呼出で更新）
  served_at       timestamptz,
  finished_at     timestamptz,
  no_show_at      timestamptz,
  requeued_at     timestamptz,
  canceled_at     timestamptz,

  -- 集計用（確定時に埋める）
  wait_seconds    int,
  service_seconds int,

  cancel_reason   text,
  note            text,
  print_status    text not null default 'pending',  -- pending|printed|failed|skipped

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 待機列の取得を高速化（最重要インデックス）
create index if not exists idx_tickets_queue_waiting
  on public.tickets(queue_id, sort_key)
  where status = 'waiting';

create index if not exists idx_tickets_queue_active
  on public.tickets(queue_id, status, sort_key)
  where status in ('waiting','called','serving');

create index if not exists idx_tickets_tenant_date
  on public.tickets(tenant_id, business_date desc);

create index if not exists idx_tickets_token
  on public.tickets(public_token);

-- 二重発券防止（同一nonceは1件しか通らない）
create unique index if not exists idx_tickets_nonce
  on public.tickets(queue_id, client_nonce)
  where client_nonce is not null;

-- 同一業務日・同一キューで番号の重複を禁止
create unique index if not exists idx_tickets_number_unique
  on public.tickets(queue_id, business_date, number);


create table if not exists public.queue_states (
  queue_id            uuid primary key references public.queues(id) on delete cascade,
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  now_serving_number  text,          -- 'C-012'
  now_serving_counter text,          -- '2'
  called_seq          bigint not null default 0,   -- 呼出のたびに+1（点滅トリガー）
  waiting_count       int  not null default 0,
  last_issued_number  text,
  estimated_wait_seconds int not null default 0,
  is_open             boolean not null default true,
  updated_at          timestamptz not null default now()
);

create index if not exists idx_queue_states_tenant on public.queue_states(tenant_id);

comment on table public.queue_states is
  '個人情報を一切含まない公開状況テーブル。匿名クライアントのRealtime購読対象はこれのみ。';


create table if not exists public.print_jobs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  printer_id   uuid not null references public.printers(id) on delete cascade,
  ticket_id    uuid references public.tickets(id) on delete set null,
  job_kind     text not null default 'ticket',   -- 'ticket' | 'test' | 'reprint'
  media_type   text not null default 'text/vnd.star.markup',
  payload      text not null,
  status       print_job_status not null default 'queued',
  attempts     int not null default 0,
  error_message text,
  created_at   timestamptz not null default now(),
  delivered_at timestamptz,
  confirmed_at timestamptz,
  expires_at   timestamptz not null default now() + interval '5 minutes'
);

create index if not exists idx_print_jobs_pending
  on public.print_jobs(printer_id, created_at)
  where status in ('queued','delivered');


create table if not exists public.ticket_events (
  id         bigserial primary key,
  tenant_id  uuid not null,
  ticket_id  uuid not null references public.tickets(id) on delete cascade,
  from_status ticket_status,
  to_status   ticket_status not null,
  actor_id    uuid,                 -- staff.id。匿名操作ならNULL
  actor_kind  text not null,        -- 'staff' | 'kiosk' | 'system'
  counter_id  uuid,
  detail      jsonb default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists idx_ticket_events_ticket
  on public.ticket_events(ticket_id, created_at);


create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  ticket_id  uuid not null references public.tickets(id) on delete cascade,
  endpoint   text not null,
  p256dh     text not null,
  auth       text not null,
  notified_at timestamptz,          -- 「あと2組」通知を送った時刻
  created_at timestamptz not null default now(),
  unique (ticket_id, endpoint)
);


create table if not exists public.daily_stats (
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  queue_id         uuid not null references public.queues(id) on delete cascade,
  business_date    date not null,
  issued_count     int not null default 0,
  served_count     int not null default 0,
  no_show_count    int not null default 0,
  canceled_count   int not null default 0,
  avg_wait_seconds int,
  max_wait_seconds int,
  p90_wait_seconds int,
  avg_service_seconds int,
  hourly           jsonb not null default '{}'::jsonb,
  -- 例: {"07":{"issued":12,"avg_wait":420}, "08":{"issued":45,"avg_wait":900}}
  updated_at       timestamptz not null default now(),
  primary key (tenant_id, queue_id, business_date)
);
