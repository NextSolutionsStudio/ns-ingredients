# Deploying

The service is one stateless container plus a PostgreSQL database that holds only API keys and usage
counters. The knowledge base ships inside the image.

Requirements: Docker with compose, PostgreSQL 15 or newer (CI tests 17), and a reverse proxy that terminates
TLS. The files in `deploy/` target Caddy on an external Docker network named `web`; adapt the network name,
env-file path and hostname to your host.

## 1. Database (once, as a superuser)

The application role needs no superuser rights and no extensions: it owns its database and runs its own
migrations at boot, under an advisory lock.

```sql
CREATE ROLE ns_ingredients LOGIN PASSWORD '<generated password>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE ns_ingredients OWNER ns_ingredients;
REVOKE ALL ON DATABASE ns_ingredients FROM PUBLIC;
```

Generate the password (for example `openssl rand -hex 24`) and keep it in your secret store.

## 2. Configuration

Create the env file referenced by `deploy/compose.yml` (mode `600`). Every variable is documented in
`.env.example`; production needs at least:

```
DATABASE_URL=postgresql://ns_ingredients:<password>@<db-host>:5432/ns_ingredients
```

At boot the configuration is validated, and the service exits with a readable message if anything is wrong.

## 3. Build and start

From a checkout of the release you are deploying:

```bash
docker compose -f deploy/compose.yml up -d --build
docker logs ns-ingredients --tail 20        # expect "migrations applied" (first boot) and "ready"
```

The image fetches all dependencies at build time and runs with `--cached-only`, as a non-root user, with read
access limited to `/app`. The container healthcheck calls `/ready`, which is a real database round trip.

## 4. Reverse proxy

Add `deploy/Caddyfile.snippet` to your Caddy configuration and reload Caddy. If the Caddyfile is a
single-file bind mount, append to it rather than replacing it (tools that write a new file and rename it,
such as `sed -i`, leave the container reading the old inode), then reload and confirm the container sees the
new block.

## 5. Keys

```bash
docker exec ns-ingredients deno run --cached-only --allow-net --allow-env --allow-read \
  src/cli/keys.ts create --label "<client>" --scopes "kb:read analyze" --owner "<contact>" --rate 60 --quota 10000
```

The key is printed **once**; store it in the client's secret store. `list` shows prefixes, scopes and last
use, and `revoke <prefix>` disables a key within the cache window (60 s).

## 6. Verify

```bash
SMOKE_BASE_URL=https://<your-host> deno task smoke                          # public checks
SMOKE_BASE_URL=https://<your-host> SMOKE_API_KEY=<key> deno task smoke       # + search, ETag, analyze
```

## Backups

The knowledge base is in git. The database holds keys and usage only; back it up with `pg_dump`:

```bash
pg_dump --format=custom --no-owner "$DATABASE_URL" > ns_ingredients-$(date +%F).dump
```

Losing it means reissuing keys, not losing knowledge.

## Upgrades and rollback

Deploy a new release with the same `up -d --build`. Migrations are additive and recorded in
`schema_migrations`, so an older release can run against a newer schema. To roll back, check out the previous
release and run `up -d --build` again. Each response names its `kb_version`, and `/v1/meta` confirms what is
live.

## Operating notes

- Logs are JSON lines on stdout: route template, status, latency and key prefix. No bodies.
- Rate-limit state is in memory, per process. With more than one replica, divide each key's rate across them
  or put the limit in the proxy.
- A self-hosted CI runner must not serve a public repository: it would run code from fork pull requests on
  your host. The workflow in `.github/workflows/ci.yml` says where to switch.
