'use strict';

const http = require('http');

// Shared mutable state the main loop updates as it runs.
const state = {
  startedAt: new Date().toISOString(),
  currentCycle: 0,
  cycleStartedAt: null,
  cycleFinishedAt: null,
  channelsInCycle: 0,
  channelsProcessedInCycle: 0,
  urlsCheckedInCycle: 0,
  urlsSkippedInCycle: 0,
  lastChannelChecked: null,
  lastUrlChecked: null,
  lastError: null,
  totals: { alive: 0, degraded: 0, dead: 0 },
};

function startServer(port) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...state }, null, 2));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port, () => {
    console.log(`[status] listening on :${port} (/health)`);
  });
  return server;
}

module.exports = { startServer, state };
