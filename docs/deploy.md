# Deploy and run

skillsgist is one Node.js process. It keeps accounts, projects, skills and download records in a SQLite file, and one zip per skill version in S3-compatible storage.

## Deploy with Docker Compose

You need a server with Docker and Docker Compose. [`compose.yaml`](../compose.yaml) runs two containers:

- `skillsgist`, the published image `ghcr.io/qsnh/skillsgist`, with its SQLite database in the `skillsgist-data` volume;
- `s3`, [SeaweedFS](https://github.com/seaweedfs/seaweedfs), an S3-compatible store, with its files in the `s3-data` volume.

```bash
mkdir skillsgist && cd skillsgist
curl -fsSLO https://raw.githubusercontent.com/Qsnh/skillsgist/main/compose.yaml
printf 'SESSION_SECRET=%s\nS3_ACCESS_KEY_ID=skillsgist\nS3_SECRET_ACCESS_KEY=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" > .env
docker compose up -d
```

`.env` holds the secrets Compose passes to both containers. Keep it: `SESSION_SECRET` signs everyone's sessions, and the S3 keys open the stored skills. Every other [setting](#settings) you add to `.env` reaches skillsgist too, except the storage settings, which `compose.yaml` fixes to the bundled SeaweedFS.

Then open `http://<your-server>:3000/setup` to create the first admin. The page switches itself off as soon as any user exists.

To pin a release instead of following `latest`, add `SKILLSGIST_VERSION=3.0.0` to `.env`. To serve on another port, add `SKILLSGIST_PORT=8080`.

### Build the image yourself

The Compose file uses the image from GitHub's registry. To build it from a checkout instead, tag your build with the same name, and Compose uses it:

```bash
git clone https://github.com/Qsnh/skillsgist.git
cd skillsgist
docker build -t ghcr.io/qsnh/skillsgist:latest .
docker compose up -d
```

## HTTPS and your own domain

Put a reverse proxy in front of port 3000 that terminates HTTPS, and tell skillsgist two things in `.env`:

```bash
PUBLIC_URL=https://skills.example.com
TRUST_PROXY=1
```

- `PUBLIC_URL` is the address people and the CLI use. skillsgist builds every absolute link from it, marks cookies `Secure` when it is `https`, and checks the `Origin` of form posts against it. Give the origin only, with no path: skillsgist cannot live under a subpath.
- `TRUST_PROXY` is the number of proxies in front of skillsgist. With it, skillsgist takes the visitor's address from the last entry those proxies added to `X-Forwarded-For` instead of from the connection. Leave it unset when nothing sits in front, or anyone could claim any address. If you also run a CDN in front of your proxy, count both.

With [Caddy](https://caddyserver.com), which fetches the certificate itself, the whole configuration is:

```
skills.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

With nginx:

```nginx
server {
    listen 443 ssl;
    server_name skills.example.com;
    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`client_max_body_size` must be a little above the upload limit (`MAX_UPLOAD_MB`, 50 MB by default), or nginx refuses large uploads before skillsgist sees them.

When the proxy runs on the same host, publish the port on the loopback address only, so nobody reaches skillsgist around it: set `SKILLSGIST_PORT=127.0.0.1:3000` in `.env`.

## Use other S3 storage

skillsgist works with any service that speaks the S3 API: AWS S3, Cloudflare R2, Backblaze B2, Wasabi, Alibaba Cloud OSS, Tencent COS, Garage, RustFS, or your own SeaweedFS. To use one with Docker Compose, edit `compose.yaml`: remove the `s3` service, the `s3-data` volume, the `depends_on` lines and the `S3_*` lines under the `skillsgist` service's `environment`. Then put these settings in `.env`:

| Setting | Meaning |
| --- | --- |
| `S3_ENDPOINT` | The service's address, such as `https://<account>.r2.cloudflarestorage.com`. Leave it out for AWS S3. |
| `S3_REGION` | The bucket's region. `us-east-1` by default; R2 uses `auto`. |
| `S3_BUCKET` | The bucket name. skillsgist creates the bucket at startup if it does not exist and the key is allowed to. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | The access key. It needs to read, write and delete objects in the bucket, and to check that the bucket exists. |
| `S3_FORCE_PATH_STYLE` | `true` addresses the bucket as `<endpoint>/<bucket>`, `false` as `<bucket>.<endpoint>`. It is `true` whenever `S3_ENDPOINT` is set, which suits self-hosted stores; set it to `false` for services that only accept the second form, such as Alibaba Cloud OSS. |

The bucket can stay private: every download goes through skillsgist, which checks who may read the skill and records the download.

## Run without Docker

You need Node.js 22.12 or later and an S3-compatible store.

```bash
git clone https://github.com/Qsnh/skillsgist.git
cd skillsgist
npm ci
npm run build
cp .env.example .env    # then fill in SESSION_SECRET and the S3 settings
npm start
```

`npm start` reads `.env` and keeps its data in `./data`. Run it under a service manager such as systemd so it restarts with the server, and stop it with `SIGTERM`: skillsgist finishes the requests in flight before it exits.

Behind a reverse proxy on the same server, also set `HOST=127.0.0.1`, so nobody reaches port 3000 around the proxy and forges the `X-Forwarded-For` header it trusts.

## Settings

skillsgist reads its settings from environment variables. It refuses to start, and names every problem, when a required one is missing or a value is not valid.

| Setting | Default | Meaning |
| --- | --- | --- |
| `SESSION_SECRET` | required | Signs session cookies. At least 32 characters, such as the output of `openssl rand -hex 32`. Changing it signs everyone out. |
| `PUBLIC_URL` | none | The public origin, such as `https://skills.example.com`. See [HTTPS and your own domain](#https-and-your-own-domain). |
| `TRUST_PROXY` | `0` | How many proxies in front of skillsgist to trust for the visitor's address and protocol. `true` means 1. |
| `PORT`, `HOST` | `3000`, `0.0.0.0` | Where the server listens. |
| `DATA_DIR` | `./data`, `/data` in the image | Where the database and the GeoIP database live. |
| `DATABASE_PATH` | `$DATA_DIR/skillsgist.db` | The SQLite database file. |
| `S3_*` | | See [Use other S3 storage](#use-other-s3-storage). |
| `DOWNLOAD_LOG_RETENTION_DAYS` | `90` | How many days download records are kept. |
| `MAX_UPLOAD_MB` | `50` | The largest upload. |
| `MAX_UNPACKED_MB` | `200` | The most an upload may unpack to. |
| `MAX_FILES` | `2000` | The most files an upload may hold. |
| `GEOIP_AUTO_UPDATE` | `true` | Whether to download and refresh the country database. |
| `GEOIP_DB_PATH` | `$DATA_DIR/dbip-country-lite.mmdb` | The country database. |

## Country lookup

The download log and the page that approves a CLI sign-in show the country each request came from. skillsgist looks it up in [DB-IP's free country database](https://db-ip.com/db/lite.php), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). It downloads the database into `DATA_DIR` the first time it starts, then checks every hour and fetches the new month's edition once the copy it has is 30 days old. Until the first download finishes, countries show as unknown.

If the server cannot reach `download.db-ip.com`, set `GEOIP_AUTO_UPDATE=false` and put a database at `GEOIP_DB_PATH` yourself. Any MaxMind DB format country database works, including MaxMind's GeoLite2 Country.

## Rate limits

skillsgist limits two requests per visitor address, in memory:

- `POST /api/oauth/device`, where `skillsgist login` starts, needs no credentials and writes a row, so it allows 5 requests per 10 seconds.
- `POST /login` allows 10 failed attempts a minute, which slows down password guessing. Successful sign-ins are not counted.

Both count the address skillsgist sees, and treat an IPv6 visitor's whole `/64` network as one address. Behind a proxy, set `TRUST_PROXY`; otherwise every visitor shares the proxy's address and its limits. Restarting the server resets the counts.

## Download log retention

`DOWNLOAD_LOG_RETENTION_DAYS` sets how many days download records and daily counts are kept. The default is 90; a job at 17 minutes past every hour deletes anything older. A skill's download count is not affected. The records include the visitor's IP address and user agent, so pick the shortest retention you need.

## Back up

Everything lives in two places: the SQLite database and the bucket.

To copy the database while skillsgist runs, write a consistent snapshot next to it and copy that off the server:

```bash
docker compose exec skillsgist node -e \
  "require('better-sqlite3')('/data/skillsgist.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker compose cp skillsgist:/data/backup.db ./skillsgist-backup.db
docker compose exec skillsgist rm /data/backup.db
```

Without Docker, `sqlite3 data/skillsgist.db ".backup skillsgist-backup.db"` does the same. For continuous backups to another bucket, [Litestream](https://litestream.io) can replicate the database file.

For the archives, copy the bucket with any S3 tool, such as `rclone sync` or `aws s3 sync`. With the bundled SeaweedFS, you can also stop the stack and archive the `s3-data` volume.

## Upgrade

With Docker Compose, pull the new image and recreate the container:

```bash
docker compose pull
docker compose up -d
```

Without Docker, pull, rebuild and restart:

```bash
git pull
npm ci
npm run build
```

skillsgist upgrades the database itself when it starts. Back it up first: a database that a newer release has upgraded does not open in an older one.

## Reset a forgotten password

An admin can set a new password for any account on that account's settings page. If no admin can sign in, reset the password from a terminal on the server instead:

```bash
docker compose exec skillsgist node dist/reset-password.js alice    # with Docker Compose
npm run reset-password -- alice                                      # without Docker
```

Leave out the username to be asked for it. The command asks for the new password twice, writes it straight to the database, and signs out every computer signed in to that account with `skillsgist login`. Sessions that are already signed in stay signed in; to sign everyone out, change `SESSION_SECRET`.
