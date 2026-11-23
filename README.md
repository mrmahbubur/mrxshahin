# M R S Auto Blog

An automated full-stack editorial blog platform that continuously monitors linked websites from `https://mrxshahin.ai.studio` and manually configured sites, detects meaningful updates and new releases, generates factual blog posts via Gemini (`gemini-4-hydrogen`), creates 16:9 editorial thumbnails with title overlays (`sharp`), and publishes automatically or into Draft review mode.

## Features

- **Automatic Hub Discovery**: Fetches `https://mrxshahin.ai.studio` on each monitoring run and extracts outbound links to keep monitored sites up to date.
- **Multi-Signal Website Monitoring**: Extracts page title, meta description, headings, navigation items, main text, links, images, `sitemap.xml`, RSS/Atom feeds, and optional GitHub repository commits/releases.
- **Noise-Filtered Change Detection**: Normalizes timestamps, visitor counters, cookie banners, and whitespace before hashing and diffing so trivial updates never trigger duplicate posts.
- **Gemini Authoring & 16:9 Thumbnails**: Generates grounded 800–1,500 word HTML articles (`gemini-4-hydrogen`), sanitizes all HTML before storage, and composites readable 16:9 PNG thumbnails (`/thumbnails/<slug>.png`) using Gemini image generation (`gemini-3.1-flash-lite-image`) with an automatic SVG-to-PNG fallback.
- **Persistent Storage**: Uses PostgreSQL via `DATABASE_URL` in production (including binary thumbnail storage so images survive ephemeral container redeploys) and falls back automatically to SQLite (`./data/autoblog.db`) for local development.
- **Public Blog & Feeds**: Responsive light/dark editorial frontend showing only published blog posts with category filtering, search, pagination, table of contents, related posts, Open Graph tags, `/rss.xml`, `/sitemap.xml`, `robots.txt`, and `/health`.
- **Hidden Rate-Limited Admin Console (`ADMIN_PATH`, default `/admin-mrs`)**: Password-protected dashboard (`noindex`) to add/pause/remove sites, run manual checks, toggle Draft vs. Auto-Publish mode, edit or regenerate posts/thumbnails, and inspect the Activity Log.

## Local Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment variables**

   Copy `.env.example` to `.env` and fill in your values:

   ```bash
   cp .env.example .env
   ```

   If `DATABASE_URL` is omitted locally, the server automatically creates a local SQLite database at `./data/autoblog.db`.

3. **Run in development mode**

   ```bash
   npm run dev
   ```

   The Express server with Vite middleware runs at `http://localhost:3000`.

4. **Build and run in production mode**

   ```bash
   npm run build
   npm start
   ```

## Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Yes | — | Server-side Gemini API key for post and thumbnail generation. |
| `DATABASE_URL` | Production | SQLite fallback | PostgreSQL connection string (persists sites, snapshots, posts, logs, and PNG thumbnails across redeploys). |
| `ADMIN_PASSWORD` | Recommended | First-run setup | Password for the hidden admin console. If omitted on first launch, the admin route shows a one-time setup form. |
| `ADMIN_PATH` | No | `/admin-mrs` | Hidden URL path for the admin console (disallowed in `robots.txt` and tagged `noindex`). |
| `GITHUB_TOKEN` | No | — | Optional GitHub token for higher API rate limits when monitoring GitHub repositories. |
| `CHECK_INTERVAL_MINUTES` | No | `10` | Monitoring interval in minutes for the `node-cron` scheduler. |
| `SITE_URL` | Production | Request origin | Canonical public URL (e.g. `https://blog.example.com`) used in `/rss.xml`, `/sitemap.xml`, and Open Graph meta tags. |
| `PORT` | No | `3000` | HTTP port bound by the Express server (`process.env.PORT`). |

## Deploying on Render

1. **Create a PostgreSQL Database on Render**
   - In the Render Dashboard, create a new **PostgreSQL** instance.
   - Copy its **Internal Database URL** (or External URL if connecting from outside Render).

2. **Create a Web Service on Render**
   - Connect your repository to a new **Web Service** (Runtime: **Node**, Node version `>= 22`).
   - **Build Command**:
     ```bash
     npm install && npm run build
     ```
   - **Start Command**:
     ```bash
     npm start
     ```
   - **Health Check Path**: `/health`

3. **Configure Environment Variables in Render**
   Add the following under **Environment**:
   - `NODE_ENV=production`
   - `GEMINI_API_KEY=<your-gemini-api-key>`
   - `DATABASE_URL=<render-postgres-internal-url>`
   - `ADMIN_PASSWORD=<strong-admin-password>`
   - `ADMIN_PATH=/admin-mrs` (or your preferred secret path)
   - `SITE_URL=https://<your-service>.onrender.com`
   - `CHECK_INTERVAL_MINUTES=10`
   - `GITHUB_TOKEN=<optional-github-pat>`

4. **Verify Deployment**
   - Visit `/health` to confirm `{"status":"ok"}`.
   - Open your configured `ADMIN_PATH` (default `/admin-mrs`), sign in with `ADMIN_PASSWORD`, and click **Check Now** to verify hub discovery and post generation.
