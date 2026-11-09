# Deploying DocuMind (AWS EC2 + Cloudflare)

The whole stack is one `docker compose` file: Caddy (HTTPS, static files, `/api` proxy),
the API, the ingestion worker, a one-shot migration job and Postgres with pgvector.

```
Browser ──HTTPS──> Cloudflare ──> EC2: Caddy :443 ──/api──> api :4000 ──> Postgres (pgvector)
                                                            worker ────────> Postgres, Gemini
```

## 1. Server
- EC2 **t4g.small** (2 vCPU ARM, 2 GB RAM) or t3.small, Ubuntu 24.04, 20 GB gp3 disk.
- Security group: inbound **22** (your IP only), **80** and **443** (anywhere). Postgres is never exposed.
- Attach an Elastic IP so the address survives restarts.

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/manak-gupta/documind.git && cd documind
```

## 2. Configuration
```bash
cp .env.example .env.production
nano .env.production
```
Set at least:

| Variable | Value |
|---|---|
| `GEMINI_API_KEY` | from https://aistudio.google.com |
| `POSTGRES_PASSWORD` | `openssl rand -base64 24` |
| `DOMAIN` | `documind.yourdomain.com` |
| `WEB_ORIGIN` | `https://documind.yourdomain.com` |
| `NODE_ENV` | `production` (secure cookies) |

## 3. DNS (Cloudflare)
1. Add an **A record** `documind` → the Elastic IP, **proxied** (orange cloud).
2. SSL/TLS mode: **Full (strict)**. Caddy obtains a real Let's Encrypt certificate on the origin.
3. Caching works out of the box: Caddy marks `/assets/*` as immutable for a year and `index.html` as `no-cache`.
   Cloudflare doesn't buffer `text/event-stream`, so answers stream normally.

## 4. Start
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production ps
curl https://documind.yourdomain.com/api/health
```
Startup order is enforced: `db` healthy → `migrate` completes → `api` healthy → `web`.

## 5. Update
```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```
Migrations run automatically, and the advisory lock makes concurrent runs safe.

## 6. Backups
Nightly `pg_dump` with 14 days retention (add with `crontab -e`):
```cron
0 3 * * * docker exec documind-db-1 pg_dump -U documind -Fc documind > ~/backups/documind-$(date +\%F).dump && find ~/backups -name '*.dump' -mtime +14 -delete
```
Restore: `docker exec -i documind-db-1 pg_restore -U documind -d documind --clean < backup.dump`.
Uploaded PDFs live in the `uploads` volume; back it up the same way, or move storage to S3.

## 7. Cost
| Item | Monthly |
|---|---|
| t4g.small (on-demand) | ~$12, or ~$0 on the AWS free tier |
| Elastic IP / public IPv4 | ~$3.6 |
| Gemini API (free tier) | $0 |
| Cloudflare (free plan) | $0 |

## Running the production stack locally
```bash
# .env.production with DOMAIN=:80 HTTP_PORT=8080 HTTPS_PORT=8443 POSTGRES_PASSWORD=...
docker compose -p documind-prod -f docker-compose.prod.yml --env-file .env.production up -d --build
open http://localhost:8080
```
