# Hetzner IP-Only Staging Deploy

This deployment is intentionally private. The web app binds to `127.0.0.1:8080` on the server, so it is reachable only through an SSH tunnel until a real domain and HTTPS are ready.

## 1. Server Bootstrap

From your local machine:

```bash
scp deploy/bootstrap_ubuntu.sh root@SERVER_IP:/root/bootstrap_ubuntu.sh
```

Then from a root SSH session on the new Ubuntu server:

```bash
bash /root/bootstrap_ubuntu.sh
```

Before closing the root session, add your SSH public key:

```bash
install -d -m 700 /home/deploy/.ssh
nano /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

Confirm a second terminal can log in as `deploy` before closing root.

## 2. Upload App And Data

From your local machine, copy the repo and market data:

```bash
rsync -av --exclude ".git" --exclude ".venv" --exclude "frontend/node_modules" ./ deploy@SERVER_IP:/opt/price-action/
rsync -av ./data/ deploy@SERVER_IP:/opt/price-action/data/
```

On the server:

```bash
cd /opt/price-action
cp .env.deploy.example .env
nano .env
chmod 600 .env
```

Change `POSTGRES_PASSWORD` to a long random value. Keep `COOKIE_SECURE=false` during IP-only staging.

## 3. Start The App

```bash
cd /opt/price-action
docker compose build
docker compose up -d
docker compose ps
```

The app should not listen publicly. Check:

```bash
ss -ltnp | grep 8080
```

Expected bind is `127.0.0.1:8080`.

## 4. Open Through SSH Tunnel

From your local machine:

```bash
ssh -L 8080:127.0.0.1:8080 deploy@SERVER_IP
```

Open:

```text
http://127.0.0.1:8080
```

Default staging login is `1` / `1`. Change this before public release.

## 5. Verification

On the server:

```bash
docker compose exec backend python - <<'PY'
from backend.main import app
print(app.title)
PY
docker compose logs --tail=100 backend
docker compose logs --tail=100 frontend-proxy
ls -lh backups
```

In the browser:

- Login works.
- Settings save after refresh.
- Chart templates save after refresh.
- Scoreboard persists after container restart.
- Quick Play loads a random session from the copied `data/` catalog.

## 6. Security Checks

```bash
sudo ufw status verbose
ss -ltnp
```

Only SSH should be reachable publicly. PostgreSQL, backend, and frontend proxy must not expose public ports.

## 7. Future Public Release

When a domain/subdomain is ready:

- open ports `80` and `443` in Hetzner Firewall and `ufw`;
- point DNS `A` records for `tradingsimulator.io` and `www.tradingsimulator.io` to the server IP;
- put Caddy or TLS-enabled Nginx in front of the app;
- set `COOKIE_SECURE=true`;
- replace or disable the default `1` / `1` account;
- add off-server encrypted backups.

For this repo, after DNS is pointed and the private Docker deployment is running, the prepared helper is:

```bash
sudo DOMAIN=tradingsimulator.io bash /opt/price-action/deploy/public_release_ubuntu.sh
```

Then verify:

```bash
bash /opt/price-action/deploy/check_public_release.sh
```
