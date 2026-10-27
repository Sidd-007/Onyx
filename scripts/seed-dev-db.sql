-- Sample data for local development against the .dev Postgres (port 54329).
DROP DATABASE IF EXISTS onyx_dev;
CREATE DATABASE onyx_dev;
\c onyx_dev

CREATE SCHEMA shop;

CREATE TABLE shop.users (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  name       text,
  is_admin   boolean NOT NULL DEFAULT false,
  profile    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop.orders (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES shop.users(id),
  total_cents integer NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  placed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_id_idx ON shop.orders(user_id);

INSERT INTO shop.users (email, name, is_admin, profile)
SELECT 'user' || g || '@example.com',
       CASE WHEN g % 7 = 0 THEN NULL ELSE 'User ' || g END,
       g % 50 = 0,
       jsonb_build_object('plan', CASE WHEN g % 3 = 0 THEN 'pro' ELSE 'free' END, 'logins', g % 97)
FROM generate_series(1, 5000) g;

INSERT INTO shop.orders (user_id, total_cents, status, placed_at)
SELECT 1 + (g % 5000), (g * 37) % 100000,
       (ARRAY['pending', 'paid', 'shipped', 'refunded'])[1 + g % 4],
       now() - (g || ' minutes')::interval
FROM generate_series(1, 50000) g;

CREATE VIEW shop.paid_orders AS SELECT * FROM shop.orders WHERE status = 'paid';
CREATE MATERIALIZED VIEW shop.revenue_by_user AS
  SELECT user_id, sum(total_cents) AS revenue_cents, count(*) AS orders FROM shop.orders GROUP BY user_id;
CREATE FUNCTION shop.user_revenue(uid bigint) RETURNS bigint LANGUAGE sql STABLE AS
  $$ SELECT coalesce(sum(total_cents), 0) FROM shop.orders WHERE user_id = uid $$;
CREATE SEQUENCE shop.invoice_number_seq;

-- 1M rows for grid scrolling tests.
CREATE TABLE public.events AS
SELECT g AS id, md5(g::text) AS hash, (g % 1000) AS bucket, now() - (g || ' seconds')::interval AS at,
       CASE WHEN g % 10 = 0 THEN NULL ELSE 'event-' || (g % 37) END AS kind
FROM generate_series(1, 1000000) g;
ALTER TABLE public.events ADD PRIMARY KEY (id);
ANALYZE;
