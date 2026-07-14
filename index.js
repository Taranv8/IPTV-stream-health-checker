'use strict';

require('dotenv').config();

const { connect, close } = require('./lib/db');
const { checkStream } = require('./lib/healthCheck');
const { isDue } = require('./lib/scheduler');
const { startServer, state } = require('./lib/statusServer');

const DELAY_BETWEEN_CHECKS_MS = parseInt(process.env.DELAY_BETWEEN_CHECKS_MS || '2000', 10);
const CYCLE_INTERVAL_MS = parseInt(process.env.CYCLE_INTERVAL_MS || '300000', 10);
const PORT = parseInt(process.env.PORT || '3000', 10);
// Default 1 = strictly one stream URL checked at a time, exactly as originally specified.
// Raise this to process multiple *channels* concurrently on large collections - each channel's
// own streamUrls[] is still always checked strictly sequentially either way.
const CHANNEL_CONCURRENCY = Math.max(1, parseInt(process.env.CHANNEL_CONCURRENCY || '1', 10));

let shuttingDown = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Checks every *due* streamUrls[] entry of a single channel doc, one URL at a time, then re-sorts. */
async function processChannel(collection, channelDoc) {
  const streamUrls = Array.isArray(channelDoc.streamUrls) ? channelDoc.streamUrls : [];
  if (streamUrls.length === 0) return;

  state.lastChannelChecked = channelDoc.name || String(channelDoc._id);

  let anyChecked = false;

  for (const entry of streamUrls) {
    if (shuttingDown) return;
    if (!entry.url) continue;

    if (!isDue(entry)) {
      // Adaptive scheduling: a confirmed-dead link backs off exponentially, a flaky one gets
      // checked more often, so cycles aren't wasted re-hammering something we already know the
      // state of. It's still re-checked eventually in case it recovers.
      state.urlsSkippedInCycle += 1;
      continue;
    }

    anyChecked = true;
    state.lastUrlChecked = entry.url;
    console.log(`[check] ${channelDoc.name || channelDoc._id} -> ${entry.url}`);

    let checkResult;
    try {
      checkResult = await checkStream(entry);
    } catch (err) {
      // checkStream already catches internally - this is just an extra guard so one bad
      // entry can never kill the whole loop.
      checkResult = {
        lastCheckedAt: new Date(),
        healthScore: 0,
        status: 'dead',
        lastError: err.message || String(err),
      };
    }

    console.log(
      `[result] ${entry.url} -> score=${checkResult.healthScore}` +
        (checkResult.rawScore !== undefined ? ` (raw ${checkResult.rawScore})` : '') +
        ` status=${checkResult.status}` +
        (checkResult.isFrozen ? ' FROZEN' : '') +
        (checkResult.keyUriReachable === false ? ' KEY_UNREACHABLE' : '') +
        (checkResult.lastError ? ` error=${checkResult.lastError}` : '')
    );

    state.urlsCheckedInCycle += 1;
    state.totals[checkResult.status] = (state.totals[checkResult.status] || 0) + 1;

    // Persist this entry's results immediately, so progress survives a mid-cycle restart
    // (Railway can restart/redeploy at any time). Matched by URL via arrayFilters.
    try {
      await collection.updateOne(
        { _id: channelDoc._id },
        {
          $set: Object.fromEntries(
            Object.entries(checkResult).map(([k, v]) => [`streamUrls.$[elem].${k}`, v])
          ),
        },
        { arrayFilters: [{ 'elem.url': entry.url }] }
      );
    } catch (dbErr) {
      console.error(`[db] failed to persist result for ${entry.url}:`, dbErr.message);
      state.lastError = dbErr.message;
    }

    await sleep(DELAY_BETWEEN_CHECKS_MS);
  }

  if (!anyChecked) {
    state.channelsProcessedInCycle += 1;
    return; // nothing changed, no need to re-sort or hit the DB again
  }

  // Re-fetch the fresh doc and re-sort streamUrls: best score first, dead ones last.
  try {
    const fresh = await collection.findOne({ _id: channelDoc._id }, { projection: { streamUrls: 1, name: 1 } });
    if (fresh && Array.isArray(fresh.streamUrls)) {
      const sorted = fresh.streamUrls.slice().sort((a, b) => {
        const scoreA = typeof a.healthScore === 'number' ? a.healthScore : -1;
        const scoreB = typeof b.healthScore === 'number' ? b.healthScore : -1;
        return scoreB - scoreA;
      });
      await collection.updateOne(
        { _id: channelDoc._id },
        { $set: { streamUrls: sorted, updatedAt: new Date() } }
      );

      const bestScore = sorted[0] && typeof sorted[0].healthScore === 'number' ? sorted[0].healthScore : null;
      if (bestScore === 0) {
        console.warn(`[alert] "${fresh.name || channelDoc._id}" has NO working stream URLs (all dead).`);
      }
    }
  } catch (err) {
    console.error(`[db] failed to re-sort streamUrls for ${channelDoc._id}:`, err.message);
    state.lastError = err.message;
  }

  state.channelsProcessedInCycle += 1;
}

/** Bounded-concurrency worker pool over an async cursor. Default concurrency 1 = fully sequential. */
async function runPool(cursor, worker, concurrency) {
  const workers = Array.from({ length: concurrency }, async () => {
    while (!shuttingDown) {
      let doc;
      // hasNext()/next() on a shared cursor are safe to call from multiple concurrent workers -
      // the driver serializes access - so this fans channels out without double-processing any.
      if (!(await cursor.hasNext())) break;
      doc = await cursor.next();
      if (!doc) break;
      await worker(doc);
    }
  });
  await Promise.all(workers);
}

async function runCycle(collection) {
  state.currentCycle += 1;
  state.cycleStartedAt = new Date().toISOString();
  state.cycleFinishedAt = null;
  state.channelsProcessedInCycle = 0;
  state.urlsCheckedInCycle = 0;
  state.urlsSkippedInCycle = 0;

  const channelCount = await collection.countDocuments();
  state.channelsInCycle = channelCount;

  console.log(`\n=== Cycle ${state.currentCycle} starting: ${channelCount} channels (concurrency=${CHANNEL_CONCURRENCY}) ===`);

  const cursor = collection.find({});
  await runPool(
    cursor,
    async (doc) => {
      try {
        await processChannel(collection, doc);
      } catch (err) {
        console.error(`[channel] unexpected error processing ${doc._id}:`, err.message);
        state.lastError = err.message;
      }
    },
    CHANNEL_CONCURRENCY
  );
  await cursor.close();

  state.cycleFinishedAt = new Date().toISOString();
  console.log(`=== Cycle ${state.currentCycle} finished: ${state.urlsCheckedInCycle} URLs checked ===\n`);
}

async function main() {
  startServer(PORT);
  const collection = await connect();

  while (!shuttingDown) {
    await runCycle(collection);
    if (shuttingDown) break;
    console.log(`[loop] sleeping ${CYCLE_INTERVAL_MS}ms before next cycle`);
    await sleep(CYCLE_INTERVAL_MS);
  }

  await close();
  process.exit(0);
}

function handleShutdown(signal) {
  console.log(`[shutdown] received ${signal}, finishing current URL check then exiting...`);
  shuttingDown = true;
}
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
