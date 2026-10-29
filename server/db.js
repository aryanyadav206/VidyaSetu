import { MongoClient } from 'mongodb';
import { CATEGORY_VALUES } from '../shared/categories.js';

export async function initializeDatabase(db) {
  const string = { bsonType: 'string' };
  const schemas = {
    users: { required: ['email', 'name', 'passwordHash'], properties: { email: string, name: string, passwordHash: string } },
    courses: { required: ['title', 'description', 'ownerId', 'createdAt'], properties: { title: string, description: string, ownerId: string, createdAt: { bsonType: 'date' } } },
    courseSecrets: { required: ['courseId', 'passwordHash'], properties: { courseId: string, passwordHash: string } },
    memberships: { required: ['courseId', 'userId', 'role'], properties: { courseId: string, userId: string, role: { enum: ['admin', 'member'] } } },
    lessons: { required: ['courseId', 'title', 'body'], properties: { courseId: string, title: string, body: string } },
    materials: { required: ['courseId', 'title', 'filename', 'contentType', 'size', 'content', 'createdAt'], properties: { courseId: string, title: string, filename: string, category: { enum: CATEGORY_VALUES }, contentType: { enum: ['application/pdf', 'text/plain'] }, content: { bsonType: 'binData' }, size: { bsonType: ['int', 'long', 'double'] }, createdAt: { bsonType: 'date' } } },
    sessions: { required: ['_id', 'userId', 'expiresAt'], properties: { userId: string, expiresAt: { bsonType: 'date' } } },
    limits: { required: ['_id', 'count', 'expiresAt'], properties: { count: { bsonType: ['int', 'long', 'double'] }, expiresAt: { bsonType: 'date' } } }
  };
  for (const [name, schema] of Object.entries(schemas)) {
    const validator = { $jsonSchema: { bsonType: 'object', ...schema } };
    try { await db.createCollection(name, { validator }); }
    catch (error) {
      if (error.code !== 48) throw error;
      await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
    }
  }
  // Refuse accidental reuse of a legacy database. Never copy plaintext into this app.
  if (await db.collection('courses').findOne({ $or: [{ password: { $exists: true } }, { passwordHash: { $exists: true } }, { enrollmentPassword: { $exists: true } }] })) {
    throw new Error('Legacy password fields found. Complete the documented reset process before startup.');
  }
  await Promise.all([
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('memberships').createIndex({ courseId: 1, userId: 1 }, { unique: true }),
    db.collection('memberships').createIndex({ userId: 1 }),
    db.collection('courseSecrets').createIndex({ courseId: 1 }, { unique: true }),
    db.collection('lessons').createIndex({ courseId: 1, createdAt: 1 }),
    db.collection('materials').createIndex({ courseId: 1, createdAt: 1 }),
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('limits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
  ]);
}

export async function connectDatabase(uri, databaseName) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db(databaseName);
  try {
    const hello = await db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('MongoDB replica set or Atlas required for transactions.');
    await initializeDatabase(db);
    return { client, db };
  } catch (error) { await client.close(); throw error; }
}
