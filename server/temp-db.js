import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

// Prefer an installed executable over downloading another MongoDB distribution.
// Always launches a fresh isolated process/dbPath; never connects to a user's database.
export function temporaryDatabase() {
  let systemBinary = process.env.MONGOMS_SYSTEM_BINARY;
  const executable = process.platform === 'win32' ? 'mongod.exe' : 'mongod';
  if (!systemBinary) systemBinary = (process.env.PATH || '').split(path.delimiter).map(p => path.join(p, executable)).find(p => existsSync(p));
  if (!systemBinary && process.platform === 'win32') {
    const root = path.join(process.env.ProgramFiles || 'C:/Program Files', 'MongoDB', 'Server');
    if (existsSync(root)) systemBinary = readdirSync(root).sort((a,b) => b.localeCompare(a, undefined, { numeric: true })).map(v => path.join(root, v, 'bin', executable)).find(p => existsSync(p));
  }
  if (systemBinary) process.env.MONGOMS_SYSTEM_BINARY_VERSION_CHECK = 'false';
  return MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ launchTimeout: 60000 }], binary: systemBinary ? { systemBinary } : { version: '7.0.24' } });
}
