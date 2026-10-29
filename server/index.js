import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDatabase } from './db.js';
import { createApp } from './app.js';

const production = process.env.NODE_ENV === 'production';
const origin = process.env.APP_ORIGIN || 'http://localhost:5173';
if (production && !origin.startsWith('https://')) throw new Error('Production APP_ORIGIN must use HTTPS.');
if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI in .env first.');
const { client, db } = await connectDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB || 'vidyasetu');
const hops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (!Number.isInteger(hops) || hops < 0) throw new Error('Invalid TRUST_PROXY_HOPS.');
const app = await createApp({ db, client, origin, production, trustProxyHops: hops });
if (production) {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use(express.static(dist));
  app.get('/{*path}', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}
const server = app.listen(Number(process.env.PORT || 4000), () => console.log('VidyaSetu API ready.'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await client.close(); process.exit(0); }));
