'use strict';

require('dotenv').config();

const { connect, close } = require('./lib/db');
const { checkStream } = require('./lib/healthCheck');
const { startServer, state } = require('./lib/statusServer');

const DELAY_BETWEEN_CHECKS_MS = parseInt(process.env.DELAY_BETWEEN_CHECKS_MS || '2000', 10);
const CYCLE_INTERVAL_MS = parseInt(process.env.CYCLE_INTERVAL_MS || '300000', 10);
const PORT = parseInt(process.env.PORT || '3000', 10);

let shuttingDown = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Checks every streamUrls[] entry of a single channel doc, one URL at a time, then re-sorts. */
async function processChannel(collection, channelDoc) {
  const streamUrls = Array.isArray(channelDoc.streamUrls) ? channelDoc.streamUrls : [];
  if (streamUrls.length === 0) return;

  state.lastChannelChecked = channelDoc.name || String(channelDoc._id);

  for (const entry of streamUrls) {
    if (shuttingDown) return;
    if (!entry.url) continue;

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
      `[result] ${entry.url} -> score=${checkResult.healthScore} status=${checkResult.status}` +
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

  // Re-fetch the fresh doc and re-sort streamUrls: best score first, dead ones last.
  try {
    const fresh = await collection.findOne({ _id: channelDoc._id }, { projection: { streamUrls: 1 } });
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
    }
  } catch (err) {
    console.error(`[db] failed to re-sort streamUrls for ${channelDoc._id}:`, err.message);
    state.lastError = err.message;
  }

  state.channelsProcessedInCycle += 1;
}

async function runCycle(collection) {
  state.currentCycle += 1;
  state.cycleStartedAt = new Date().toISOString();
  state.cycleFinishedAt = null;
  state.channelsProcessedInCycle = 0;
  state.urlsCheckedInCycle = 0;

  const channelCount = await collection.countDocuments();
  state.channelsInCycle = channelCount;

  console.log(`\n=== Cycle ${state.currentCycle} starting: ${channelCount} channels ===`);

  const cursor = collection.find({});
  while (await cursor.hasNext()) {
    if (shuttingDown) break;
    const doc = await cursor.next();
    try {
      await processChannel(collection, doc);
    } catch (err) {
      console.error(`[channel] unexpected error processing ${doc._id}:`, err.message);
      state.lastError = err.message;
    }
  }
  await cursor.close();

  state.cycleFinishedAt = new Date().toISOString();
  console.log(`=== Cycle ${state.currentCycle} finished ===\n`);
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
