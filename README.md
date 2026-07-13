# IPTV Stream Health Checker

Continuously walks every channel document in your MongoDB `channelinfo` collection,
health-checks each entry in `streamUrls[]` **one at a time**, scores it 0–100, writes
technical metadata back to that entry, and reorders the array so the best stream is
at index `0` and dead streams sink to the end.

## What it checks per URL

1. Fetches the manifest (`.m3u8`). If it's a **master** playlist, it also drills into
   the highest-bitrate variant playlist. Both master and media playlist HTTP status/latency count.
2. Downloads a couple of real segments (`SEGMENT_SAMPLE_COUNT`) and measures actual
   throughput. This is compared against the encoded bitrate of those segments to get
   a **buffer health ratio** — will your player be able to download data faster than
   it plays it back, or will it stall?
3. Extracts metadata straight from the manifest text (no decoding needed):
   resolution, bandwidth, codecs, frame rate, audio tracks (name/language/group),
   live vs VOD, segment count, target duration, and `#EXT-X-KEY` DRM info
   (method / key format — not the key itself).
4. **Encrypted (clearkey/DRM) streams**: reachability and throughput checks work
   identically whether the segments are encrypted or not — downloading bytes to
   measure speed doesn't require decrypting them. The script never touches
   `licenseKey` for playback; it only notes in the DB that a license key is on file.

## Scoring (0–100)

| Component | Points |
|---|---|
| Manifest reachable & parseable | 30 |
| Test segment(s) downloaded successfully | 25 |
| Buffer health ratio (download speed vs required playback bitrate) | up to 30 |
| Latency (≤300ms best, ≥3000ms worst) | up to 15 |

Unreachable manifest → score `0`, `status: "dead"`. Score `< 50` → `"degraded"`.
Otherwise → `"alive"`. Tune the weights in `lib/scorer.js` if you want a different mix.

## Fields written back to each `streamUrls[]` entry

```
healthScore, status, lastCheckedAt, latencyMs, bufferHealthRatio,
resolution, bandwidth, codecs, frameRate, audioTracks[], isLive,
segmentCount, targetDuration, drm, lastError
```

Nothing else on the entry (url, originalName, source, userAgent, httpHeaders,
licenseKey, etc.) is touched.

## Setup

```bash
npm install
cp .env.example .env   # then edit values if needed
npm start
```

By default it reads `MONGO_URI` / `DB_NAME` / `COLLECTION` from environment
variables — set these in your Railway project's **Variables** tab rather than
committing them to git. See `.env.example` for every tunable knob (check delay,
cycle interval, timeouts, retry count, sample segment count).

> The connection string you shared is now sitting in this chat transcript. It's
> fine to use as-is, but since it's a live username/password pair, it's worth
> rotating it (Atlas → Database Access) once you've moved it into Railway's
> env vars, just as routine hygiene for any credential that's been pasted somewhere.

## Deploying to Railway

1. Push this folder to a GitHub repo (or use `railway up` from the CLI directly).
2. In Railway: **New Project → Deploy from GitHub repo**.
3. Add the environment variables from `.env.example` under **Variables**
   (at minimum `MONGO_URI`; the rest have sensible defaults).
4. Railway auto-detects Node via `package.json` and runs `npm start`.
5. The app also serves `GET /health` on `$PORT` (Railway sets `PORT`
   automatically) returning live progress as JSON — current cycle, channels
   processed, last URL checked, running totals of alive/degraded/dead. Point
   Railway's health check at `/health` if you want restarts on true crashes only.

## How "continuous, one at a time" works

The main loop (`index.js`) streams through every channel document with a cursor,
and for each channel, checks its `streamUrls[]` entries strictly sequentially
(`DELAY_BETWEEN_CHECKS_MS` between each — default 2s) so you're never hammering
multiple sources in parallel or overloading the DB. After all entries for a
channel are checked, it re-reads that channel and re-sorts `streamUrls[]` by
`healthScore` descending, so index `0` is always the current best. After every
channel has been swept, it sleeps `CYCLE_INTERVAL_MS` (default 5 min) and starts
the next full pass — forever, until the process receives `SIGTERM`/`SIGINT`
(handled gracefully so Railway redeploys don't corrupt an in-flight write).

## Notes / things you may want to adjust

- **Duplicate URLs within one channel**: the per-URL update matches by `url`
  via a Mongo `arrayFilter`. If a channel has two entries with the identical
  `url` string, both get the same result written. Fine for almost all real
  data, just worth knowing.
- **Very large playlists**: `SEGMENT_SAMPLE_COUNT` (default 2) controls how
  many segments get downloaded per check — raise it for a more accurate
  buffer-health read at the cost of more bandwidth/time per check, or lower
  it to check faster.
- **True DRM playback verification** (actually decrypting and decoding a
  frame) is out of scope here — that needs an ffmpeg/ffprobe-based decode
  pipeline. This script verifies *reachability and throughput*, which is
  normally what "is this stream dead or about to buffer" means for a
  channel list. Happy to add an ffprobe-based deeper check as a follow-up
  if you want frame-level verification too.
