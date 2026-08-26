-- 出典: 04_データベース設計書.md より自動抽出
-- 内容: 初期データ(シード)

-- ============================================================
-- 04_データベース設計書.md 第13章: 初期データ（シード）
-- ============================================================
-- ============================================================
-- 13. シード — ホテル1館 + 2キュー + 2窓口 + プリンタ1台
-- ============================================================
insert into public.tenants (id, slug, name, name_en, timezone)
values ('11111111-1111-1111-1111-111111111111',
        'grand-mercure-hamanako', 'グランドメルキュール浜名湖', 'Grand Mercure Hamanako', 'Asia/Tokyo')
on conflict (slug) do nothing;

insert into public.printers (id, tenant_id, name, mac_address, paper_width)
values ('33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111',
        'フロント発券機', '0011624A1B2C', 80)
on conflict do nothing;

insert into public.queues (
  id, tenant_id, name, description, prefix, color, icon, sort_order,
  ask_party_size, ask_room_number, default_service_seconds, max_counters, printer_id
) values
('22222222-2222-2222-2222-222222222221',
 '11111111-1111-1111-1111-111111111111',
 '{"ja":"フロント チェックイン","en":"Front Desk Check-in","zh":"前台入住登记","ko":"프런트 체크인"}',
 '{"ja":"ご宿泊のお客様","en":"For hotel guests","zh":"住宿客人","ko":"숙박 고객"}',
 'C', '#0f766e', 'concierge', 1,
 false, false, 240, 3, '33333333-3333-3333-3333-333333333333'),
('22222222-2222-2222-2222-222222222222',
 '11111111-1111-1111-1111-111111111111',
 '{"ja":"レストラン（朝食）","en":"Restaurant (Breakfast)","zh":"餐厅（早餐）","ko":"레스토랑 (조식)"}',
 '{"ja":"2F ダイニング","en":"2F Dining","zh":"2楼 餐厅","ko":"2층 다이닝"}',
 'R', '#b45309', 'restaurant', 2,
 true, true, 150, 2, '33333333-3333-3333-3333-333333333333')
on conflict do nothing;

update public.queues
set seat_options = '[
  {"code":"any","label":{"ja":"指定なし","en":"No preference","zh":"不指定","ko":"상관없음"}},
  {"code":"table","label":{"ja":"テーブル席","en":"Table","zh":"餐桌","ko":"테이블"}},
  {"code":"window","label":{"ja":"窓側希望","en":"Window seat","zh":"靠窗","ko":"창가"}}
]'::jsonb,
    ask_seat_preference = true
where id = '22222222-2222-2222-2222-222222222222';

insert into public.counters (tenant_id, queue_id, name, short_name, sort_order) values
('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221',
 '{"ja":"1番カウンター","en":"Counter 1","zh":"1号柜台","ko":"1번 카운터"}', '1', 1),
('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221',
 '{"ja":"2番カウンター","en":"Counter 2","zh":"2号柜台","ko":"2번 카운터"}', '2', 2),
('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
 '{"ja":"レストラン入口","en":"Restaurant Entrance","zh":"餐厅入口","ko":"레스토랑 입구"}', 'R', 3)
on conflict do nothing;

-- queue_states の初期行を作る
select public.refresh_queue_state(id, false) from public.queues;


-- 【手動対応が必要】このinsertはSupabaseダッシュボード > Authentication で
-- スタッフアカウントを作成した後、そのUUIDに置き換えて別途実行すること。
-- (04_データベース設計書.md 13章「スタッフアカウントの作り方」参照)
-- そのままではプレースホルダー <...> が不正なUUIDとしてエラーになるため、
-- このマイグレーションには含めずコメントアウトしてある。
-- insert into public.staff (id, tenant_id, display_name, role)
-- values ('<Authenticationで作成したユーザーのUUID>',
--         '11111111-1111-1111-1111-111111111111',
--         '支配人 山田', 'admin');
