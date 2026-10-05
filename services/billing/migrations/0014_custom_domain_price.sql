-- Custom domains on deployed apps: each is a Cloudflare for SaaS custom
-- hostname, $0.10 a month to g1t. The Deployments plan includes some
-- (`deployments_allowance::CUSTOM_DOMAINS`); the deployments service
-- charges the rest at this cost plus the margin once a month is over.
INSERT INTO prices (meter, title, unit, cost_micros, markup_percent, source, updated_at) VALUES
  ('custom_domain_month', 'Custom domains past the plan', 'domain-month', 100000, 20, 'list', '2026-10-04T00:00:00Z')
ON CONFLICT (meter) DO NOTHING;
