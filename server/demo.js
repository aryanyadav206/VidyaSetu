// Explicitly temporary development database; production must use server/index.js.
import { temporaryDatabase } from './temp-db.js';
import { MongoClient, BSON } from 'mongodb';
import { readFile, unlink } from 'node:fs/promises';
import { initializeDatabase } from './db.js';
import { createApp } from './app.js';
if (process.env.NODE_ENV === 'production') throw new Error('Temporary demo mode cannot run in production.');
const mongo = await temporaryDatabase();
const client = new MongoClient(mongo.getUri());
await client.connect();
const db = client.db('vidyasetu-demo');
await initializeDatabase(db);
// Optional one-time recovery when restarting a live demo after a backend edit.
// The ignored recovery file contains private database data; remove only after restore succeeds.
if (process.env.DEMO_RESTORE_PATH) {
  const snapshot = BSON.EJSON.parse(await readFile(process.env.DEMO_RESTORE_PATH, 'utf8'));
  for (const [name, documents] of Object.entries(snapshot)) {
    if (documents.length) await db.collection(name).insertMany(documents);
  }
  await unlink(process.env.DEMO_RESTORE_PATH);
}
const app = await createApp({ client, db });
const server = app.listen(4000, '127.0.0.1', () => console.log('Temporary MERN demo ready on port 4000. Data is deleted when stopped.'));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(async () => { await client.close(); await mongo.stop(); process.exit(0); }));
