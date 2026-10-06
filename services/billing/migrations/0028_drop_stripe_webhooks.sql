-- The webhook's signing secret is the Worker secret STRIPE_WEBHOOK_SECRET,
-- copied from the destination made in Stripe's dashboard. Billing no
-- longer makes destinations or keeps their secrets.
DROP TABLE IF EXISTS stripe_webhooks;
