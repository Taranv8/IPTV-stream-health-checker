# IPTV Stream Health Checker

Continuously walks every channel document in your MongoDB `channelinfo` collection,
health-checks each entry in `streamUrls[]`, scores it 0–100, writes rich technical
metadata back to that entry, and reorders the array so the best stream is at index
`0` and dead streams sink to the end.

## What makes this "smart" (v2)

A naive checker just asks "did this URL return 200?" — that misses most of the ways
real IPTV links actually fail. This one specifically looks for:

| Problem | How it's caught |
|---|---|
| CDN/token-expiry page served with `200 OK` instead of real video | **Byte-sniffs every downloaded segment** (`lib/segmentSniff.js`) — checks for MPEG-TS sync bytes or an ISO-BMFF box header; an HTML/JSON error page doesn't count as a working segment even though the HTTP request "succeeded" |
| A "live" stream whose manifest is stuck (still returns 200, but stopped actually broadcasting) | **Freeze detection** — tracks `#EXT-X-MEDIA-SEQUENCE` / last segment (HLS) or computed segment number (DASH) across checks; if it hasn't advanced after enough time has passed for a new segment, it's flagged frozen |
| Segments download fine but the AES-128/SAMPLE-AES key URL is dead, or a DASH license URL is unreachable | **Key/license reachability check** — separately verifies the key/license delivery endpoint, not just the media segments |
| One-off network blip tanking a normally-great stream's ranking | **EMA-smoothed scoring** — the persisted score is an exponential moving average of recent checks, not just the latest one, so a single bad sample doesn't wreck a reliable stream's position |
| A stream that's been dead for hours still eating a full check every cycle | **Adaptive scheduling** — confirmed-dead streams back off exponentially (up to an hour between checks); flaky/degraded ones are checked *more* often since their ranking matters most while unresolved |
| A CDN with inconsistent throughput that "averages out" to a decent number but stutters in practice | **Jitter tracking** — measures per-segment download-speed variance, not just the aggregate average |
| Master playlist's top-quality stream works, but does ABR fallback (lower qualities) actually exist? | **Variant fallback check** — cheaply HEAD-checks every other quality variant, not just the one that gets fully tested |
| Content delivered as MPEG-DASH (`.mpd`) with ClearKey — very common for encrypted IPTV, and different from HLS | **Native DASH/MPD parser** (`lib/dash.js`) — auto-detects manifest format and extracts resolution/bandwidth/audio/DRM info from DASH the same way it does for HLS |
| Retrying a `404`/`401` over and over, wasting time on a URL that will never recover | **Retry logic distinguishes permanent vs. transient failures** — only timeouts/5xx/connection errors get retried (with exponential backoff + jitter); permanent HTTP errors fail fast |

## What it checks per URL

1. Fetches the manifest and **auto-detects HLS (`.m3u8`) vs DASH (`.mpd`)** by content
   sniffing (falls back to `Content-Type`/extension). For HLS master playlists, drills
   into the highest-bitrate variant. For DASH, parses `AdaptationSet`/`Representation`/
   `SegmentTemplate` to find the best video representation.
2. Downloads real sample segments and **sniffs their bytes** to confirm they're actual
   MPEG-TS or fMP4/CMAF media, not an error page. Measures throughput (buffer health)
   and per-segment jitter (consistency).
3. **Freeze/zombie detection** for live manifests: is the "live" edge actually moving?
4. **Key/license reachability**: HLS `#EXT-X-KEY` URI, or a DASH `dashif:Laurl`, gets an
   independent reachability check.
5. Extracts metadata straight from the manifest: resolution (+ human `qualityLabel` like
   `1080p (Full HD)` / `4K`), bandwidth, codecs, frame rate, audio tracks, live vs VOD,
   segment count, DRM scheme (ClearKey/Widevine/PlayReady/FairPlay/AES-128, by UUID or
   HLS method), and — for HLS masters — reachability of the *other* quality variants.
6. **Encrypted (ClearKey/DRM) streams**: reachability/throughput checks work identically
   whether segments are encrypted or not, since measuring speed only needs bytes, not
   decryption. The script never touches `licenseKey` for playback — it only records that
   a license is on file and (when the manifest itself exposes one) checks the license
   *delivery URL* is reachable.

## Scoring

**Per-check raw score (0–100):**

| Component | Points |
|---|---|
| Manifest reachable & parseable | 20 |
| Sample segment(s) downloaded **and byte-verified as real media** | 20 |
| Buffer health ratio (download speed vs. required playback bitrate) | up to 25 |
| Latency (≤300ms best, ≥3000ms worst) | up to 10 |
| Consistency across sampled segments (low jitter) | up to 10 (N/A → full marks) |
| Not frozen (a "live" manifest is actually advancing) | 10 (N/A for VOD/first check → full marks) |
| DRM key/license delivery reachable | 5 (N/A if nothing to check → full marks) |

**Persisted `healthScore` (what streams are sorted by):** an EMA of the raw score
(`EMA_ALPHA`, default 0.4) — smoothed against single-check noise, but force-reset to
`0` after `CONSECUTIVE_FAILURES_TO_CONFIRM_DEAD` (default 3) total failures in a row, so
a genuinely dead link doesn't linger near the top on residual memory of past good checks.

`status`: `dead` (score 0) / `degraded` (< 50) / `alive` (≥ 50).

## Fields written back to each `streamUrls[]` entry

```
healthScore, rawScore, status, lastCheckedAt, nextCheckAt, latencyMs,
bufferHealthRatio, jitterRatio, resolution, qualityLabel, bandwidth, codecs,
frameRate, audioTracks[], isLive, segmentCount, targetDuration, manifestFormat,
drm, isFrozen, freezeToken, keyUriReachable, variantHealth[], segmentFormat,
invalidSegmentReason, consecutiveFailures, consecutiveSuccesses, scoreHistory,
volatility, lastError
```

Nothing else on the entry (url, originalName, source, userAgent, httpHeaders,
licenseKey, etc.) is touched.

## Setup

```bash
npm install
cp .env.example .env   # then edit values if needed
npm start
```

Set env vars in Railway's **Variables** tab rather than committing them. See
`.env.example` for every tunable knob — timing, retries, scoring weights, and
adaptive-scheduling intervals are all configurable there.

> The connection string you shared is now sitting in this chat transcript. It's fine
> to use as-is, but since it's a live username/password pair, it's worth rotating it
> (Atlas → Database Access) once it's in Railway's env vars — routine hygiene for any
> credential pasted somewhere.

## Deploying to Railway

1. Push this folder to a GitHub repo (or `railway up` from the CLI directly).
2. Railway: **New Project → Deploy from GitHub repo**.
3. Add env vars from `.env.example` under **Variables** (only `MONGO_URI` is required;
   everything else has sensible defaults).
4. Railway auto-detects Node via `package.json` and runs `npm start`.
5. `GET /health` on `$PORT` returns live progress as JSON — current cycle, channels
   processed, URLs checked vs. skipped (adaptive backoff), last URL checked, running
   totals of alive/degraded/dead. Point Railway's health check at `/health`.

## How the loop works

The main loop streams through every channel with a cursor. For each channel, it
checks `streamUrls[]` entries **strictly sequentially** — `DELAY_BETWEEN_CHECKS_MS`
between each (default 2s) — skipping any entry whose adaptive `nextCheckAt` hasn't
arrived yet. After a channel's due entries are checked, it re-sorts `streamUrls[]` by
`healthScore` descending. After every channel is swept, it sleeps `CYCLE_INTERVAL_MS`
(default 5 min) and starts the next pass — forever, until `SIGTERM`/`SIGINT` (handled
gracefully so Railway redeploys don't corrupt an in-flight write).

`CHANNEL_CONCURRENCY` (default **1**) controls how many *channels* are processed in
parallel — default keeps the original "one URL at a time" behavior exactly as
specified. Raising it (e.g. 3–5) speeds up large collections; each channel's own
`streamUrls[]` is still always checked one-at-a-time regardless of this setting.

## Notes / known limitations

- **DASH parsing** covers the common `SegmentTemplate` (with `$Number$` or a
  `SegmentTimeline`) profile, which covers the large majority of live/VOD ClearKey
  streams. Exotic layouts (`SegmentList`, multi-`Period` manifests, unusual
  `$Time$`-only addressing without a timeline) are best-effort — the checker will
  fall back to "manifest reachable, no throughput sample" rather than crash.
- **Duplicate URLs within one channel**: the per-URL update matches by `url` via a
  Mongo `arrayFilter`. If a channel has two entries with the identical `url` string,
  both get the same result written.
- **True DRM playback verification** (actually decrypting and decoding a frame) is
  still out of scope — this verifies reachability, real byte-level media validity,
  throughput, and (where exposed) key-delivery reachability, which covers the vast
  majority of "is this stream actually dead/broken" cases without needing an
  ffmpeg/ffprobe decode pipeline. Happy to add that as a deeper follow-up layer if
  you want frame-level verification too.
