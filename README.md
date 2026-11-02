# فیلمرز 🎬

وب‌سایت مرور، جستجو و تماشای آنلاین فیلم — فارسی و راست‌به‌چپ، با پنل مدیریت.

داده‌ها از خروجی خزنده (Scrapy → `links.db`) خوانده می‌شود، در قالب نرمال‌شده داخل `data/app.db` (SQLite) می‌نشیند و با اصول رابط سیال اپل (شیشه‌ای، نرم، تخت) طراحی شده است.

## امکانات

- **خانه:** هیروی فیلم ویژه، ردیف «جدیدترین‌ها»، چیپ‌های ژانر و سال
- **فیلم‌ها:** فیلتر ژانر/سال/کشور/شخص، چهار ترتیب، صفحه‌بندی بازه‌ای
- **سریال‌ها:** داده‌ی واقعی سریال‌ها از `kind='series'` در `links.db` خوانده می‌شود — هر صفحه یک سریال، و هر ردیف یک لینک برای (فصل، قسمت) مشخص. صفحه `/series` فیلتر ژانر/سال/ترتیب دارد و صفحه هر سریال انتخاب فصل، شبکه قسمت‌ها و **لینک‌های مخصوص همان قسمت** را نشان می‌دهد (چند کیفیت/آینه برای هر قسمت).
- **Top 250:** فهرست ۲۵۰ فیلم برتر از `top 250.txt`، با لینک مستقیم به فیلم‌های موجود در کتابخانه و نمایش بی‌لینکِ فیلم‌های ناموجود (`/top250`). دسترسی سریع از بنر بالای صفحه اصلی و منوی سایت.
- **حساب کاربری:** ثبت‌نام/ورود با ایمیل و رمز عبور، تأیید ایمیل، بازیابی رمز، پروفایل، تغییر رمز، خروج از همه دستگاه‌ها و حذف حساب (`/account`).
- **علاقه‌مندی‌ها و لیست تماشا:** برای اعضای واردشده در `app.db` و به‌ازای هر کاربر ذخیره می‌شود (ستاره‌ی صفحه فیلم/سریال + `/account/favorites` و `/account/watchlist`). مهمان‌ها همان نشان‌های کوکی قبلی را دارند (`/wishlist`).
- **تاریخچه تماشا:** هر بار پخش واقعی یک فیلم/قسمت ثبت می‌شود؛ «ادامه تماشا» فقط وقتی نمایش داده می‌شود که پخش‌کننده پیشرفت واقعی را گزارش کند (`/account/history`).
- **ورود با گوگل (اختیاری):** OAuth 2.0/OIDC با state، nonce و PKCE؛ اتصال/قطع اتصال از تنظیمات حساب. بدون پیکربندی، ورود با ایمیل/رمز کار می‌کند.
- **نشان‌ها (مهمان):** فهرست شخصی فیلم و سریال با ستاره‌ی صفحه هر فیلم/سریال؛ در کوکی HttpOnly + SQLite ذخیره می‌شود و بعد از ری‌استارت هم می‌ماند (`/wishlist`).
- **صفحه فیلم:** مشخصات کامل (سال، کشور، رده سنی، کیفیت، زیرنویس چسبیده)، ستارگان و کارگردان لینک‌شده، جدول لینک‌ها، «فیلم‌های مشابه» بر پایه ژانر مشترک
- **پخش/دانلود لحظه‌ای:** اگر `play_url` موجود باشد با رِزالور لینک تازه گرفته می‌شود؛ در غیر این صورت لینک مستقیم دائمی (بدون `expire`) یا لینکی که هنوز منقضی نشده مستقیم تحویل داده می‌شود (۵۰۳ `LINK_EXPIRED` فقط برای لینک‌های واقعاً منقضی). در موبایل دکمه‌ی «پخش» همان لینک تازه را با deep link در **VLC** باز می‌کند (Intent در اندروید و `vlc-x-callback` در iOS) و دکمه‌ی «دانلود» لینک مستقیم را می‌دهد.
- **جستجو:** FTS5 روی عنوان فارسی/انگلیسی + پیشنهاد زنده با کیبورد
- **پروکسی پوستر:** فقط از هاست‌های مجاز، با کش دیسکی SHA1
- **پنل مدیریت:** ورود با چرخش شناسه نشست (ضد session fixation)، جستجو، ویرایش JSON، انتشار/ویژه، ادغام رکوردهای تکراری، سلامت لینک‌ها، و بخش مجزای سریال‌ها (`/admin/series`) با نمایش فصل/قسمت/لینک‌ها و ویرایش مشخصات
- **امنیت:** CSP با nonce در هر درخواست، هلمت‌ها، CSRF روی همه نوشته‌ها، Rate-limit روی ورود/پیشنهاد/رزالور/پوستر، هش scrypt برای رمز کاربران، نشست‌های سمت‌سرور با کوکی HttpOnly، جلوگیری از IDOR/CSRF/XSS/SQLi/open-redirect
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
| `APP_BASE_URL` | `https://filmerz.ir` در پروداکشن | مبدأ مطلق برای canonical، sitemap و لینک ایمیل‌ها |
| `COOKIE_SECURE` | `1` در پروداکشن | کوکی‌های `Secure`/`__Host-` (فقط برای تست HTTP محلی `0` کنید) |
| `REQUIRE_EMAIL_VERIFICATION` | `1` | تا ایمیل تأیید نشود ورود ممکن نیست؛ بدون SMTP ثبت‌نام بسته است |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE` | — / `587` / `0` | سرور ایمیل تراکنشی |
| `SMTP_USER`/`SMTP_PASS`/`MAIL_FROM` | — | اعتبارنامه و فرستنده؛ `MAIL_FROM` الزامی است |
| `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` | — | فعال‌سازی ورود با گوگل |
| `GOOGLE_CALLBACK_URL` | `APP_BASE_URL/auth/google/callback` | باید دقیقاً در Google Cloud Console ثبت شود |
| `SCRYPT_N`/`SCRYPT_R`/`SCRYPT_P` | `65536`/`8`/`1` | هزینه‌ی هش رمز (هش‌های قدیمی خودشان ارتقا می‌یابند) |
| `LOGIN_IP_MAX`/`LOGIN_ACCOUNT_MAX` | `40`/`10` | سقف تلاش ورود در پنجره ۱۵ دقیقه |

> `TRUST_PROXY=1` را فقط وقتی تنظیم کنید که پشت پروکسی معتبر (Caddy/Nginx) هستید؛ در غیر این صورت rate-limit بر اساس IP واقعی کار نمی‌کند.

## حساب کاربری و احراز هویت

- **رمزها:** `crypto.scrypt` داخلی Node با salt تصادفی ۱۶ بایتی و قالب نسخه‌دار `scrypt$1$N$r$p$salt$hash`. هیچ رمزی به‌صورت متن ساده یا MD5/SHA1 ذخیره نمی‌شود. پارامترها با `SCRYPT_*` قابل افزایش‌اند و در اولین ورود موفق، هش قدیمی خودکار ارتقا می‌یابد.
- **نشست‌ها:** سمت سرور در جدول `user_sessions`؛ کوکی `fmz_auth` (یا `__Host-fmz_auth` با HTTPS) شامل ۲۵۶ بیت تصادفی است و در پایگاه داده فقط SHA-256 آن ذخیره می‌شود. `HttpOnly`، `SameSite=Lax`، `Path=/`، انقضا دارد و در ورود/تغییر رمز چرخش می‌کند. «خروج از همه دستگاه‌ها» همه‌ی نشست‌های کاربر را حذف می‌کند.
- **CSRF:** توکن synchronizer در کوکی `fmz_csrf` و در `<meta name="csrf-token">` / فیلد `_csrf`؛ همه‌ی درخواست‌های غیر GET بدون توکن با ۴۰۳ رد می‌شوند (پاسخ JSON برای `/api/*`).
- **تأیید ایمیل:** توکن یک‌بارمصرف ۲۵۶ بیتی، فقط هش آن ذخیره می‌شود، ۲۴ ساعت اعتبار؛ ارسال دوباره سقف دارد و پاسخ آن وجود/عدم وجود حساب را لو نمی‌دهد.
- **بازیابی رمز:** توکن یک‌بارمصرف ۳۰ دقیقه‌ای؛ پس از تغییر رمز همه‌ی نشست‌ها باطل می‌شوند.
- **گوگل:** جریان Authorization Code + OIDC؛ `state` یک‌بارمصرف (هش‌شده)، `nonce`، PKCE S256، بررسی امضا/issuer/audience/exp توسط `google-auth-library`، الزام `email_verified`، و شناسه‌ی پایدار `sub`. توکن‌های گوگل ذخیره نمی‌شوند و حساب هرگز بر اساس ایمیل به‌صورت خودکار ادغام نمی‌شود.

### راه‌اندازی SMTP

1. در `.env` مقدارهای `SMTP_HOST`، `SMTP_PORT`، `SMTP_SECURE`، `SMTP_USER`، `SMTP_PASS` و `MAIL_FROM` را ست کنید.
2. `MAIL_FROM` باید دامنه‌ای باشد که SPF/DKIM آن را تأیید می‌کند (مثلاً `no-reply@filmerz.ir`).
3. با `REQUIRE_EMAIL_VERIFICATION=1` تا وقتی SMTP پیکربندی نشده، ثبت‌نام با پیام واضح غیرفعال می‌ماند و هرگز «ایمیل ارسال شد» به‌دروغ نمایش داده نمی‌شود.
4. در محیط توسعه (بدون SMTP) لینک تأیید/بازیابی در لاگ سرور چاپ می‌شود تا جریان قابل تست باشد.

### راه‌اندازی ورود با گوگل

1. در Google Cloud Console یک OAuth Client از نوع Web Application بسازید.
2. Redirect URI را دقیقاً `https://filmerz.ir/auth/google/callback` ثبت کنید (یا مقدار `GOOGLE_CALLBACK_URL`).
3. `GOOGLE_CLIENT_ID` و `GOOGLE_CLIENT_SECRET` را در `.env` بگذارید و سرویس را ری‌استارت کنید.
4. بدون این مقادیر، دکمه‌ی گوگل نمایش داده نمی‌شود و مسیرهای آن ۴۰۴ امن برمی‌گردانند.
5. اگر سرور به `oauth2.googleapis.com` دسترسی ندارد (خطای `token exchange failed`)، یک HTTP(S) proxy بدهید و `GOOGLE_PROXY_URL` را ست کنید؛ فقط درخواست‌های گوگل از آن عبور می‌کنند. برای تشخیص: `docker compose exec app npm run diag:google`.

### مهاجرت پایگاه داده و پشتیبان‌گیری

```bash
npm run backup     # پشتیبان آنلاین با VACUUM INTO (۷ نسخه آخر)
npm run migrate    # پشتیبان + اعمال schema جدید (idempotent) + گزارش بررسی
```

در Docker همین کار را داخل کانتینر انجام دهید:

```bash
docker compose exec app node scripts/migrate.js
docker compose cp app:/app/backups/. ./backups
```

`applySchema` در هر بوت هم اجرا می‌شود و فقط `CREATE TABLE/INDEX IF NOT EXISTS` و افزودن ستون‌های جدید است؛ هیچ داده‌ی کاتالوگ حذف یا بازنویسی نمی‌شود. جدول‌های حساب کاربری فقط در `data/app.db` ساخته می‌شوند و به `links.db` دست نمی‌زنند.

### Sitemap و Search Console

- `/sitemap.xml` یک sitemap index معتبر (`application/xml`) است و فقط sitemapهای غیرخالی را معرفی می‌کند.
- `/sitemaps/movies-1.xml`، `series-1`، `genres-1`، `top250-1` و نام‌های کوتاه `movies.xml`/`movies` هم پاسخ XML می‌دهند.
- `/robots.txt` به‌صورت داینامیک از `APP_BASE_URL` ساخته می‌شود و همیشه خط `Sitemap:` دارد.
- در Search Console **دقیقاً** `https://filmerz.ir/sitemap.xml` را ثبت کنید (نه دامنه و نه یک فایل فرزند). اگر قبلاً آدرس اشتباهی ثبت شده، آن را حذف و همین آدرس را اضافه کنید.
- خطای «Start tag expected, '<' not found» یعنی پاسخ آن آدرس HTML/خالی بوده، نه XML. کد فعلی برای هر URL شبیه sitemap همیشه XML برمی‌گرداند و خطاهای تولید را با بدنه‌ی XML معتبر (۵۰۳) پاسخ می‌دهد تا این خطا تکرار نشود.


## اسکریپت‌ها

| فرمان | کار |
|---|---|
| `npm run import` | ورود/به‌روزرسانی داده از `links.db` (`--fresh` برای پاک‌سازی، `--limit N` برای تست) |
| `npm run import:series` | فقط ورود/به‌روزرسانی سریال‌ها، فصل‌ها، قسمت‌ها و لینک هر قسمت |
| `npm run import:movies` | فقط ورود/به‌روزرسانی فیلم‌ها |
| `npm run create-admin -- user pass` | ساخت/به‌روزرسانی مدیر (bcrypt) |
| `npm run backup` | پشتیبان آنلاین با `VACUUM INTO` (نگه‌داشتن ۷ نسخه آخر) |
| `npm run migrate` | پشتیبان + اعمال idempotent جدول‌های حساب و گزارش `quick_check` |
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

## داکر (نصب و اجرا)

```bash
# ساخت تصویر Docker
docker build -t filmz .

# اجرا کردن کانتینر (معمولاً در محیطی که Docker نصب باشد)
docker run -p 3000:3000 -v filmz-data:/app/data -e SESSION_SECRET="..." filmz

# نکات مهم:
# 1. یک‌بار باید واردات را اجرا کنید: node scripts/import.js
# 2. یک‌بار یک مدیر ادمین بسازید: node scripts/create-admin.js admin "گذرواژه-قوی-حداقل-۸-کاراکتر"
# 3. دیتابیس و پوشه‌های persistent (data/, uploads/, backups/) را به‌عنوان وولوم به کانتینر Monte کنید
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

`test/auth.test.js` روی یک پایگاه داده‌ی موقت، کل جریان حساب را تست می‌کند:
ثبت‌نام و اعتبارسنجی، نقش‌ربایی، ورود/رمز اشتباه/حساب غیرفعال، چرخش و انقضای
نشست، CSRF، open-redirect، جداسازی علاقه‌مندی‌های دو کاربر، مسدود بودن پنل
مدیر برای کاربر عادی، یک‌بارمصرف بودن و انقضای توکن‌ها، XSS/SQLi، مسیرهای
گوگل بدون پیکربندی و پاسخ XML سالم sitemap‌ها.