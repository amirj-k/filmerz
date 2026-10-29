# فیلمرز 🎬

وب‌سایت مرور، جستجو و تماشای آنلاین فیلم — فارسی و راست‌به‌چپ، با پنل مدیریت.

داده‌ها از خروجی خزنده (Scrapy → `links.db`) خوانده می‌شود، در قالب نرمال‌شده داخل
`data/app.db` (SQLite) می‌نشیند و با اصول رابط سیال اپل (شیشه‌ای، نرم، تخت) طراحی شده است.

## امکانات

- **خانه:** هیروی فیلم ویژه، ردیف «جدیدترین‌ها»، چیپ‌های ژانر و سال
- **فیلم‌ها:** فیلتر ژانر/سال/کشور/شخص، چهار ترتیب، صفحه‌بندی بازه‌ای
- **سریال‌ها:** داده‌ی واقعی سریال‌ها از `kind='series'` در `links.db` خوانده می‌شود — هر صفحه یک سریال، و هر ردیف یک لینک برای (فصل، قسمت) مشخص. صفحه `/series` فیلتر ژانر/سال/ترتیب دارد و صفحه هر سریال انتخاب فصل، شبکه قسمت‌ها و **لینک‌های مخصوص همان قسمت** را نشان می‌دهد (چند کیفیت/آینه برای هر قسمت).
- **Top 250:** فهرست ۲۵۰ فیلم برتر از `top 250.txt`، با لینک مستقیم به فیلم‌های موجود در کتابخانه و نمایش بی‌لینکِ فیلم‌های ناموجود (`/top250`). دسترسی سریع از بنر بالای صفحه اصلی و منوی سایت.
- **نشان‌ها:** فهرست شخصی فیلم و سریال با ستاره‌ی صفحه هر فیلم/سریال؛ در کوکی HttpOnly + SQLite ذخیره می‌شود و بعد از ری‌استارت هم می‌ماند (`/wishlist`).
- **صفحه فیلم:** مشخصات کامل (سال، کشور، رده سنی، کیفیت، زیرنویس چسبیده)، ستارگان و کارگردان لینک‌شده، جدول لینک‌ها، «فیلم‌های مشابه» بر پایه ژانر مشترک
- **پخش/دانلود لحظه‌ای:** اگر `play_url` موجود باشد با رِزالور لینک تازه گرفته می‌شود؛ در غیر این صورت لینک مستقیم دائمی (بدون `expire`) یا لینکی که هنوز منقضی نشده مستقیم تحویل داده می‌شود (۵۰۳ `LINK_EXPIRED` فقط برای لینک‌های واقعاً منقضی). در موبایل دکمه‌ی «پخش» همان لینک تازه را با deep link در **VLC** باز می‌کند (Intent در اندروید و `vlc-x-callback` در iOS) و دکمه‌ی «دانلود» لینک مستقیم را می‌دهد.
- **جستجو:** FTS5 روی عنوان فارسی/انگلیسی + پیشنهاد زنده با کیبورد
- **پروکسی پوستر:** فقط از هاست‌های مجاز، با کش دیسکی SHA1
- **پنل مدیریت:** ورود با چرخش شناسه نشست (ضد session fixation)، جستجو، ویرایش JSON، انتشار/ویژه، ادغام رکوردهای تکراری، سلامت لینک‌ها، و بخش مجزای سریال‌ها (`/admin/series`) با نمایش فصل/قسمت/لینک‌ها و ویرایش مشخصات
- **امنیت:** CSP با nonce در هر درخواست، هلمت‌ها، CSRF روی همه نوشته‌ها، Rate-limit روی ورود/پیشنهاد/رزالور/پوستر
- **ظاهر:** تم تیره/روشن با ذخیره انتخاب و بدون پرش رنگ، `prefers-reduced-motion`

## اجرا

```bash
npm install
node scripts/import.js            # links.db → data/app.db: فیلم‌ها + سریال‌ها/فصل‌ها/قسمت‌ها (قابل اجرای مجدد)
node scripts/import.js --series-only   # فقط سریال‌ها (سریع‌تر برای به‌روزرسانی)
node scripts/import.js --movies-only   # فقط فیلم‌ها
node scripts/cleanup.js           # پاک‌سازی ژانر/عنوان/افراد/کشور (فیلم‌ها)
node scripts/create-admin.js admin "گذرواژه-قوی-حداقل-۸-کاراکتر"
npm start                         # http://localhost:3000
```

پنل مدیریت: `http://localhost:3000/admin`

### متغیرهای محیطی (اختیاری)

| متغیر | پیش‌فرض | توضیح |
|---|---|---|
| `PORT` | `3000` | درگاه |
| `APP_DB_PATH` | `data/app.db` | پایگاه اپلیکیشن |
| `LINKS_DB_PATH` | `links.db` | پایگاه خزنده (فقط‌خواندنی) |
| `SESSION_SECRET` | تصادفی | کلید امضای کوکی نشست (در پروداکشن ست کنید) |
| `POSTER_HOSTS` | هاست‌های منبع | الگوی هاست‌های مجاز پوستر |
| `ALLOWED_DL_HOSTS` | هاست‌های منبع | الگوی هاست‌های مجاز دانلود |

## اسکریپت‌ها

| فرمان | کار |
|---|---|
| `npm run import` | ورود/به‌روزرسانی داده از `links.db` (`--fresh` برای پاک‌سازی، `--limit N` برای تست) |
| `npm run import:series` | فقط ورود/به‌روزرسانی سریال‌ها، فصل‌ها، قسمت‌ها و لینک هر قسمت |
| `npm run import:movies` | فقط ورود/به‌روزرسانی فیلم‌ها |
| `npm run create-admin -- user pass` | ساخت/به‌روزرسانی مدیر (bcrypt) |
| `npm run backup` | پشتیبان آنلاین با `VACUUM INTO` (نگه‌داشتن ۷ نسخه آخر) |
| `npm run fix:years` | پاک‌سازی سال‌های نامعتبر کراول (`--all` برای بازمحاسبه، `--movies-only`/`--series-only`) |
| `npm run remove:series-movies` | حذف رکوردهای فیلمی که در واقع صفحه سریال هستند (سریال‌ها دست نمی‌خورند) |
| `npm test` | تست‌های node:test |
| `npm run dev` | اجرا با `--watch` |

## معماری

```
links.db (خزنده) ──scripts/import.js──▶ data/app.db (نرمال)
                                          │
   src/server.js  ◀── src/routes/{public,admin}.js
   src/{catalog,queries,parser,normalizer,resolver,session,csrf,ratelimit,schema}.js
                                          │
                          views/*.ejs + public/{css,js}
```

- **import.js:** هر `page` خزنده با `kind='movie'` = یک فیلم (۱۵۲ صفحه دوبله به‌صورت خودکار ادغام شد)؛ لینک‌ها با `source_row_id` یکتا هستند و اجرای مجدد چیزی را دوباره نمی‌نویسد.
- **سریال‌ها:** هر `page` با `kind='series'` = یک سریال؛ ردیف‌های همان صفحه با `season` و `episode` به جدول‌های `seasons`، `episodes` و `episode_links` نرمال می‌شوند. `source_row_id` یکتا باعث می‌شود اجرای مجدد import تکراری نسازد و آینه‌های هر قسمت حفظ شوند.
- **resolver:** ترجیح `play_url` → در غیر این صورت لینک مستقیم ذخیره‌شده اگر پارامتر `expire` نداشته باشد (لینک دائمی) یا هنوز منقضی نشده باشد مستقیم استفاده می‌شود.
- **backup:** `VACUUM INTO` حین کارِ سایت امن است.

## داکر (Docker deployment)

The app runs in a single container. SQLite, the poster cache, uploads and
backups live in named Docker volumes; there is no separate database container
and no database port is published.

**Image contents:** Node.js 24.18.0 on Alpine, production dependencies
installed with `npm ci` from `package-lock.json`, application code, views,
static assets and `top 250.txt`. The container runs as the unprivileged
`node` user (UID 1000). `GET /healthz` (a real SQLite query) is the Docker
health check. A multi-stage build is deliberately not used: this project has
no build or bundling step.

### 1. Configure

```bash
cp .env.example .env
# Generate a session secret and put it in .env:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

On Windows PowerShell use `Copy-Item .env.example .env`. `SESSION_SECRET` is
required by Compose; without it Compose refuses to start. Set
`SOURCE_PHONE` / `SOURCE_PASSWORD` only if fresh play/download link resolution
is needed. Never commit `.env`.

### 2. Build and start

```bash
docker compose build
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:3000/healthz
```

Expected health response: `{"ok":true,"db":true}`. The site is at
`http://localhost:3000` and the admin panel at `/admin`. Follow startup logs
with `docker compose logs -f app`.

Without Compose, the equivalent is:

```bash
docker build -t filmerz .
docker run -d --name filmerz --restart unless-stopped \
  -p 3000:3000 --env-file .env \
  -v filmerz_data:/app/data -v filmerz_backups:/app/backups filmerz
```

### 3. First-run data

`data/`, `links.db` and `backups/` are intentionally excluded from Git and
from the image. The image starts with an empty schema, so seed one of these:

**A. Copy an existing normalized database** (recommended if you already ran
the importer on the source machine):

```bash
docker compose create
docker compose cp ./data/app.db app:/app/data/app.db
docker compose run --rm --user root app chown node:node /app/data/app.db
docker compose up -d
```

Use a consistent copy (stop the local app or copy the output of
`npm run backup`) so SQLite WAL data is not lost. The `chown` is needed because
Docker copies the file as root while the app runs as `node`.

**B. Import from `links.db`** (the crawler output is not in the repository):

```bash
docker compose create
docker compose cp ./links.db app:/app/data/links.db
docker compose run --rm -e LINKS_DB_PATH=/app/data/links.db app node scripts/import.js
docker compose run --rm app node scripts/create-admin.js admin 'choose-a-strong-password'
docker compose run --rm app rm -f /app/data/links.db
docker compose up -d
```

The import can take several minutes. Create or reset the admin user at any
time:

```bash
docker compose exec app node scripts/create-admin.js admin 'choose-a-strong-password'
```

**C. Empty catalog:** step 2 alone is enough for the health check, but browse,
search and admin pages will have no content until A or B is run.

### 4. Configuration and external services

All supported variables are listed in `.env.example`. The main ones:

| Variable | Default | Notes |
|---|---|---|
| `SESSION_SECRET` | — | Required by Compose; a stable value keeps admin sessions across restarts. |
| `APP_PORT` | `3000` | Host port published by Compose. |
| `PORT` | `3000` | Port the app listens on inside the container. |
| `DATA_DIR` | `/app/data` | Persistent data root (volume). |
| `APP_DB_PATH` | `/app/data/app.db` | SQLite database; keep inside the volume. |
| `UPLOADS_DIR` | `/app/data/uploads` | Uploaded files; inside the same volume. |
| `APP_DB` | `/app/data/app.db` | Used by `backup.js` / `create-admin.js`; keep in sync with `APP_DB_PATH`. |
| `LINKS_DB_PATH` | `/app/links.db` | Crawler DB, import only. |
| `TRUST_PROXY` | `0` | Set to `1` behind a trusted HTTPS reverse proxy. |
| `SOURCE_PHONE`, `SOURCE_PASSWORD` | empty | Upstream source credentials; needed for fresh links. |
| `SOURCE_BASE_URL` | `https://flzios.com` | Upstream source base URL. |
| `ALLOWED_DL_HOSTS`, `POSTER_HOSTS` | app defaults | Optional regex allowlists for download/poster hosts. |

External services: the upstream source site (login + link resolver) and the
allowed poster/download hosts, all over outbound HTTPS. There is no external
database, cache, queue or object storage. Without source credentials,
already-stored direct links may still work, but fresh link resolution returns
an error.

### 5. Persistence, backup, update

Compose creates the named volumes `filmerz_data` and `filmerz_backups`.
`docker compose down` keeps them; `docker compose down -v` deletes all
application data and backups.

```bash
# Online backup (VACUUM INTO) inside the container:
docker compose exec app node scripts/backup.js

# Copy backups out of the volume:
docker compose cp app:/app/backups/. ./backups
```

Restore by stopping the app and copying a backup over `/app/data/app.db`
(the same `cp` + `chown` sequence as step 3A), then start it again.

Update an existing deployment:

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
```

Volumes survive rebuilds. To roll back, check out the previous commit and run
`docker compose up -d --build`.

### 6. Troubleshooting

| Symptom | Check |
|---|---|
| Container is `unhealthy` | `docker compose ps`; `docker compose logs app`; `curl http://localhost:3000/healthz`. |
| Site is empty | Seed/import the database (step 3); the image contains no content. |
| `port is already allocated` | Change `APP_PORT` (host port) in `.env`, then `docker compose up -d`. |
| Admin is logged out after restart | Set a stable `SESSION_SECRET`; otherwise the app generates an ephemeral one. |
| `SQLITE_READONLY` / permission errors | Use the named volumes; for a bind mount make it writable by UID/GID `1000:1000`. |
| Fresh play/download links fail | Set `SOURCE_PHONE` / `SOURCE_PASSWORD`, allow outbound HTTPS, check `docker compose logs app`. |
| `npm ci` fails during rebuild | Rebuild from a commit where `package.json` and `package-lock.json` match; do not edit the lockfile by hand. |

Only the HTTP port is published; keep `.env` and the SQLite database private.

## تست

```bash
npm test
npm run smoke   # دود-تست زنده پنل (سرور باید بالا باشد)
```
