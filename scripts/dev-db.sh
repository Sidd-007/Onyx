#!/bin/sh
# Local dev databases, data in .dev/ (gitignored):
#   Postgres 17  on :54329  (.dev/pgdata)
#   MySQL 8.4    on :33069  (.dev/mysqldata)
#   Redis        on :63799  (.dev/redis), if redis-server is installed
#   ClickHouse   HTTP on :8124 (.dev/clickhouse), if clickhouse is installed
#   MongoDB      on :27019  (.dev/mongo), if mongod is installed
# Usage: scripts/dev-db.sh start|stop|status
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG=/opt/homebrew/opt/postgresql@17/bin
MY=/opt/homebrew/opt/mysql@8.4/bin
export LC_ALL=en_US.UTF-8

mysql_running() { "$MY/mysqladmin" -uroot -h127.0.0.1 -P33069 ping >/dev/null 2>&1; }
redis_running() { redis-cli -p 63799 ping >/dev/null 2>&1; }
clickhouse_running() { curl -s http://127.0.0.1:8124/ping >/dev/null 2>&1; }
mongo_running() { nc -z 127.0.0.1 27019 >/dev/null 2>&1; }

case "$1" in
  start)
    if "$PG/pg_ctl" -D "$ROOT/.dev/pgdata" status >/dev/null 2>&1; then
      echo "dev Postgres already running on :54329"
    else
      "$PG/pg_ctl" -D "$ROOT/.dev/pgdata" -o "-p 54329 -k /tmp" -l "$ROOT/.dev/pg.log" -w start
    fi
    if [ -d "$ROOT/.dev/mysqldata" ]; then
      if mysql_running; then
        echo "dev MySQL already running on :33069"
      else
        "$MY/mysqld" --daemonize --datadir="$ROOT/.dev/mysqldata" --port=33069 --mysqlx=OFF \
          --socket=/tmp/onyx-mysql.sock --pid-file="$ROOT/.dev/mysql.pid" --log-error="$ROOT/.dev/mysql.log"
        echo "dev MySQL started on :33069"
      fi
    fi
    if command -v redis-server >/dev/null; then
      if redis_running; then echo "dev Redis already running on :63799"; else
        mkdir -p "$ROOT/.dev/redis"
        redis-server --port 63799 --bind 127.0.0.1 --daemonize yes --dir "$ROOT/.dev/redis" \
          --pidfile "$ROOT/.dev/redis.pid" --logfile "$ROOT/.dev/redis.log" --save "" --appendonly no
        echo "dev Redis started on :63799"
      fi
    fi
    if command -v clickhouse >/dev/null; then
      if clickhouse_running; then echo "dev ClickHouse already running on :8124"; else
        mkdir -p "$ROOT/.dev/clickhouse/config.d"
        # The macOS build's JIT fails on repeated queries (CANNOT_COMPILE_CODE): keep it off.
        cat > "$ROOT/.dev/clickhouse/config.d/no-jit.xml" <<'XML'
<clickhouse><profiles><default>
  <compile_expressions>0</compile_expressions>
  <compile_aggregate_expressions>0</compile_aggregate_expressions>
  <compile_sort_description>0</compile_sort_description>
</default></profiles></clickhouse>
XML
        # (--daemon doesn't work on macOS: detach it ourselves)
        nohup sh -c 'cd "$1" && exec clickhouse server -- --path="$1/" --listen_host=127.0.0.1 --http_port=8124 \
          --tcp_port=9010 --mysql_port=9014 --postgresql_port=9015 --interserver_http_port=9019 --logger.console=0 \
          --logger.log="$2/clickhouse.log" --logger.errorlog="$2/clickhouse.err.log" --logger.level=warning' \
          _ "$ROOT/.dev/clickhouse" "$ROOT/.dev" < /dev/null > /dev/null 2>&1 &
        echo $! > "$ROOT/.dev/clickhouse.pid"
        for _ in 1 2 3 4 5 6 7 8 9 10; do clickhouse_running && break; sleep 0.5; done
        echo "dev ClickHouse started on :8124"
      fi
    fi
    if command -v mongod >/dev/null; then
      if mongo_running; then echo "dev MongoDB already running on :27019"; else
        mkdir -p "$ROOT/.dev/mongo"
        mongod --port 27019 --bind_ip 127.0.0.1 --dbpath "$ROOT/.dev/mongo" --fork --logpath "$ROOT/.dev/mongo.log" >/dev/null
        echo "dev MongoDB started on :27019"
      fi
    fi ;;
  stop)
    "$PG/pg_ctl" -D "$ROOT/.dev/pgdata" stop || true
    if mysql_running; then "$MY/mysqladmin" -uroot -h127.0.0.1 -P33069 shutdown; fi
    if redis_running; then redis-cli -p 63799 shutdown nosave; fi
    if [ -f "$ROOT/.dev/clickhouse.pid" ]; then kill "$(cat "$ROOT/.dev/clickhouse.pid")" 2>/dev/null || true; rm -f "$ROOT/.dev/clickhouse.pid"; fi
    if mongo_running; then mongod --dbpath "$ROOT/.dev/mongo" --shutdown >/dev/null 2>&1 || true; fi ;;
  status)
    "$PG/pg_ctl" -D "$ROOT/.dev/pgdata" status || true
    if mysql_running; then echo "MySQL running on :33069"; else echo "MySQL not running"; fi
    if redis_running; then echo "Redis running on :63799"; else echo "Redis not running"; fi
    if clickhouse_running; then echo "ClickHouse running on :8124"; else echo "ClickHouse not running"; fi
    if mongo_running; then echo "MongoDB running on :27019"; else echo "MongoDB not running"; fi ;;
  *) echo "usage: $0 start|stop|status"; exit 1 ;;
esac
