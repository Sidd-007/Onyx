-- Sample data for local development against the .dev MySQL (port 33069).
DROP DATABASE IF EXISTS onyx_dev;
CREATE DATABASE onyx_dev;
USE onyx_dev;

CREATE TABLE users (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(255) NOT NULL UNIQUE,
  name       VARCHAR(255),
  is_admin   BOOLEAN NOT NULL DEFAULT FALSE,
  profile    JSON,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  total_cents INT NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending',
  placed_at   DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

SET SESSION cte_max_recursion_depth = 1000000;

INSERT INTO users (email, name, is_admin, profile)
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 5000)
SELECT CONCAT('user', n, '@example.com'),
       IF(n % 7 = 0, NULL, CONCAT('User ', n)),
       n % 50 = 0,
       JSON_OBJECT('plan', IF(n % 3 = 0, 'pro', 'free'), 'logins', n % 97)
FROM g;

INSERT INTO orders (user_id, total_cents, status, placed_at)
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 50000)
SELECT 1 + (n % 5000), (n * 37) % 100000,
       ELT(1 + n % 4, 'pending', 'paid', 'shipped', 'refunded'),
       NOW() - INTERVAL n MINUTE
FROM g;

CREATE VIEW paid_orders AS SELECT * FROM orders WHERE status = 'paid';
CREATE FUNCTION user_revenue(uid BIGINT) RETURNS BIGINT READS SQL DATA
  RETURN (SELECT COALESCE(SUM(total_cents), 0) FROM orders WHERE user_id = uid);
CREATE PROCEDURE recent_orders(IN lim INT) SELECT * FROM orders ORDER BY placed_at DESC LIMIT lim;

-- 1M rows for grid scrolling tests.
CREATE TABLE events (id BIGINT PRIMARY KEY, hash CHAR(32), bucket INT, at DATETIME, kind VARCHAR(20));
INSERT INTO events
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 1000000)
SELECT n, MD5(n), n % 1000, NOW() - INTERVAL n SECOND, IF(n % 10 = 0, NULL, CONCAT('event-', n % 37)) FROM g;
ANALYZE TABLE users, orders, events;

-- A password user, like a real server (root has no password locally).
DROP USER IF EXISTS 'onyx'@'%';
CREATE USER 'onyx'@'%' IDENTIFIED BY 'onyx-dev-pass';
GRANT ALL ON onyx_dev.* TO 'onyx'@'%';
