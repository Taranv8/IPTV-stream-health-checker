'use strict';

const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'IPTV';
const COLLECTION = process.env.COLLECTION || 'channelinfo';

if (!MONGO_URI) {
  throw new Error('MONGO_URI environment variable is not set. Set it in your .env or Railway variables.');
}

let client = null;
let collectionRef = null;

async function connect() {
  if (collectionRef) return collectionRef;
  client = new MongoClient(MONGO_URI, {
    maxPoolSize: 5,
  });
  await client.connect();
  const db = client.db(DB_NAME);
  collectionRef = db.collection(COLLECTION);
  console.log(`[db] connected -> ${DB_NAME}.${COLLECTION}`);
  return collectionRef;
}

async function close() {
  if (client) {
    await client.close();
    client = null;
    collectionRef = null;
  }
}

module.exports = { connect, close };
