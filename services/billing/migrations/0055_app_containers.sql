-- Container apps on g1t.page (Docker deployments): what their parts cost
-- g1t, at Cloudflare Containers' list prices, sold at cost plus 20% like
-- everything else. The deployments service meters each app's container by
-- the started minute while it is awake and charges a month's time once
-- the month is over, under Deployments. CPU is charged for the instance's
-- whole vCPU while awake, the most Cloudflare can bill for it (it bills
-- CPU as used), so g1t never sells below cost.
INSERT INTO prices (meter, title, unit, cost_micros, markup_percent, source, updated_at) VALUES
  ('app_container_vcpu_second', 'Container apps: vCPU while awake', 'vCPU-second', 20, 20, 'list', '2026-10-12T00:00:00Z'),
  ('app_container_memory_gib_second', 'Container apps: memory while awake', 'GiB-second', 2.5, 20, 'list', '2026-10-12T00:00:00Z'),
  ('app_container_disk_gb_second', 'Container apps: disk while awake', 'GB-second', 0.07, 20, 'list', '2026-10-12T00:00:00Z'),
  ('app_container_second', 'Container apps: the Durable Object in front of each', 'second', 1.5625, 20, 'list', '2026-10-12T00:00:00Z'),
  ('app_container_egress_gb', 'Container apps: data sent', 'GB', 50000, 20, 'list', '2026-10-12T00:00:00Z')
ON CONFLICT (meter) DO NOTHING;

INSERT INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, reason, created_at) VALUES
  ('prc_new_app_container_vcpu', 'app_container_vcpu_second', 20, 20, 20, 'Now metered: container apps on g1t.page, at Cloudflare Containers'' price', '2026-10-12T00:00:00Z'),
  ('prc_new_app_container_memory', 'app_container_memory_gib_second', 2.5, 2.5, 20, 'Now metered: container apps on g1t.page, at Cloudflare Containers'' price', '2026-10-12T00:00:00Z'),
  ('prc_new_app_container_disk', 'app_container_disk_gb_second', 0.07, 0.07, 20, 'Now metered: container apps on g1t.page, at Cloudflare Containers'' price', '2026-10-12T00:00:00Z'),
  ('prc_new_app_container_do', 'app_container_second', 1.5625, 1.5625, 20, 'Now metered: the Durable Object in front of each container app, while it runs', '2026-10-12T00:00:00Z'),
  ('prc_new_app_container_egress', 'app_container_egress_gb', 50000, 50000, 20, 'Now metered: data container apps send, at the most Cloudflare charges for a GB anywhere', '2026-10-12T00:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT OR IGNORE INTO price_versions (id, meter, version, cost_micros, markup_percent, effective_at, reason, created_by, created_at, applied_at) VALUES
  ('pv_app_container_vcpu_second_1', 'app_container_vcpu_second', 1, 20, 20, '2026-10-12T00:00:00Z', 'Container apps', 'migration', '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z'),
  ('pv_app_container_memory_gib_second_1', 'app_container_memory_gib_second', 1, 2.5, 20, '2026-10-12T00:00:00Z', 'Container apps', 'migration', '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z'),
  ('pv_app_container_disk_gb_second_1', 'app_container_disk_gb_second', 1, 0.07, 20, '2026-10-12T00:00:00Z', 'Container apps', 'migration', '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z'),
  ('pv_app_container_second_1', 'app_container_second', 1, 1.5625, 20, '2026-10-12T00:00:00Z', 'Container apps', 'migration', '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z'),
  ('pv_app_container_egress_gb_1', 'app_container_egress_gb', 1, 50000, 20, '2026-10-12T00:00:00Z', 'Container apps', 'migration', '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z');
