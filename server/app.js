import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CATEGORY_VALUES } from '../shared/categories.js';

const hashOptions = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 };
export const hashPassword = password => argon2.hash(password, hashOptions);
const digest = value => createHash('sha256').update(value).digest('hex'); // random session tokens, never passwords
const id = z.string().uuid();
const password = z.string().min(10).max(128);
const credentials = z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(128) }).strict();
const safeUser = user => ({ id: user._id, name: user.name, email: user.email });
const safeCourse = course => ({ id: course._id, title: course.title, description: course.description, createdAt: course.createdAt });
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function createApp({ db, client, origin = 'http://localhost:5173', production = false, trustProxyHops = 0 }) {
  const app = express();
  const cookieName = production ? '__Host-vidyasetu' : 'vidyasetu';
  const cookieOptions = { httpOnly: true, secure: production, sameSite: 'strict', path: '/' };
  const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxyHops);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    styleSrc: ["'self'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com']
  } } }));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (req.get('origin') !== origin) return res.status(403).json({ error: 'Request origin is not allowed.' });
      const fileUpload = req.method === 'POST' && /^\/api\/courses\/[^/]+\/materials$/.test(req.path) && (req.is('application/pdf') || req.is('text/plain'));
      if (!req.is('application/json') && !fileUpload) return res.status(415).json({ error: 'Send JSON requests, or a supported PDF/notes file to the upload endpoint.' });
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());

  // MongoDB atomic counters are shared across processes. Count all attempts, not only failures.
  const limit = (scope, max, windowMs, key) => async (req, res, next) => {
    const now = Date.now();
    const bucket = Math.floor(now / windowMs);
    const _id = digest(`${scope}:${key(req)}:${bucket}`);
    const counters = db.collection('limits');
    let row;
    try {
      try {
        row = await counters.findOneAndUpdate({ _id }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 2) * windowMs) } }, { upsert: true, returnDocument: 'after' });
      } catch (error) {
        if (error.code !== 11000) throw error;
        row = await counters.findOneAndUpdate({ _id }, { $inc: { count: 1 } }, { returnDocument: 'after' });
      }
      if (!row) throw new Error('Counter unavailable');
      if (row.count > max) {
        res.set('Retry-After', String(Math.ceil(((bucket + 1) * windowMs - now) / 1000)));
        return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
      }
      next();
    } catch { next(new ApiError(503, 'Service temporarily unavailable. Please try again.')); }
  };
  app.use('/api', limit('api-ip', 300, 60000, req => req.ip));
  const authLimit = limit('auth-ip', 20, 900000, req => req.ip);
  const authenticate = async (req, res, next) => {
    const token = req.cookies[cookieName];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401, 'Please sign in to continue.');
    const session = await db.collection('sessions').findOne({ _id: digest(token), expiresAt: { $gt: new Date() } });
    const user = session && await db.collection('users').findOne({ _id: session.userId });
    if (!user) throw new ApiError(401, 'Your session has expired. Please sign in again.');
    req.user = safeUser(user);
    req.sessionId = session._id;
    next();
  };
  async function startSession(res, user) {
    const token = randomBytes(32).toString('hex');
    const maxAge = 7 * 86400000;
    await db.collection('sessions').insertOne({ _id: digest(token), userId: user._id, expiresAt: new Date(Date.now() + maxAge) });
    res.cookie(cookieName, token, { ...cookieOptions, maxAge });
  }
  app.post('/api/auth/register', authLimit, async (req, res) => {
    const data = credentials.extend({ name: z.string().trim().min(2).max(80), password }).parse(req.body);
    const user = { _id: randomUUID(), ...data, passwordHash: await hashPassword(data.password) };
    delete user.password;
    try { await db.collection('users').insertOne(user); }
    catch (error) { if (error.code === 11000) throw new ApiError(409, 'Unable to create this account. Try signing in.'); throw error; }
    await startSession(res, user);
    res.status(201).json({ user: safeUser(user) });
  });
  app.post('/api/auth/login', authLimit, async (req, res) => {
    const data = credentials.parse(req.body);
    const user = await db.collection('users').findOne({ email: data.email });
    const valid = await argon2.verify(user?.passwordHash || dummyHash, data.password);
    if (!user || !valid) throw new ApiError(401, 'Email or password is incorrect.');
    if (req.cookies[cookieName]) await db.collection('sessions').deleteOne({ _id: digest(req.cookies[cookieName]) });
    await startSession(res, user);
    res.json({ user: safeUser(user) });
  });
  app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: req.user }));
  app.post('/api/auth/logout', authenticate, async (req, res) => {
    z.object({}).strict().parse(req.body);
    await db.collection('sessions').deleteOne({ _id: req.sessionId });
    res.clearCookie(cookieName, cookieOptions).json({ ok: true });
  });
  app.use('/api/courses', authenticate);
  const enrollmentLimit = limit('enroll-user', 10, 900000, req => req.user.id);
  const courseLimit = limit('enroll-course', 100, 900000, req => req.body?.courseId);

  app.get('/api/courses', async (req, res) => {
    const memberships = await db.collection('memberships').find({ userId: req.user.id }).limit(200).toArray();
    const courses = await db.collection('courses').find({ _id: { $in: memberships.map(m => m.courseId) } }).sort({ createdAt: -1 }).toArray();
    res.json({ courses: courses.map(c => ({ ...safeCourse(c), role: memberships.find(m => m.courseId === c._id).role })) });
  });
  app.post('/api/courses', limit('create-user', 20, 3600000, req => req.user.id), async (req, res) => {
    const data = z.object({ title: z.string().trim().min(3).max(100), description: z.string().trim().max(500), password }).strict().parse(req.body);
    const course = { _id: randomUUID(), title: data.title, description: data.description, ownerId: req.user.id, createdAt: new Date() };
    const passwordHash = await hashPassword(data.password);
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await db.collection('courses').insertOne(course, { session });
        await db.collection('courseSecrets').insertOne({ courseId: course._id, passwordHash }, { session });
        await db.collection('memberships').insertOne({ courseId: course._id, userId: req.user.id, role: 'admin', createdAt: new Date() }, { session });
      });
    } finally { await session.endSession(); }
    res.status(201).json({ course: { ...safeCourse(course), role: 'admin' } });
  });
  app.post('/api/courses/enroll', enrollmentLimit, courseLimit, async (req, res) => {
    const data = z.object({ courseId: id, password: z.string().min(1).max(128) }).strict().parse(req.body);
    const course = await db.collection('courses').findOne({ _id: data.courseId });
    const secret = course && await db.collection('courseSecrets').findOne({ courseId: course._id });
    const valid = await argon2.verify(secret?.passwordHash || dummyHash, data.password);
    if (!course || !secret || !valid) throw new ApiError(403, 'Course ID or enrollment password is incorrect.');
    const memberships = db.collection('memberships');
    if (await memberships.findOne({ courseId: data.courseId, userId: req.user.id })) throw new ApiError(409, 'You have already joined this course.');
    try {
      await memberships.insertOne({ courseId: data.courseId, userId: req.user.id, role: 'member', createdAt: new Date() });
    } catch (error) {
      if (error.code === 11000) throw new ApiError(409, 'You have already joined this course.');
      throw error;
    }
    res.status(201).json({ course: { ...safeCourse(course), role: 'member' } });
  });
  const membership = async (req, res, next) => {
    id.parse(req.params.courseId);
    req.membership = await db.collection('memberships').findOne({ courseId: req.params.courseId, userId: req.user.id });
    if (!req.membership) throw new ApiError(403, 'Join this course to access its content.');
    next();
  };
  app.get('/api/courses/:courseId', membership, async (req, res) => {
    const course = await db.collection('courses').findOne({ _id: req.params.courseId });
    if (!course) throw new ApiError(404, 'Course not found.');
    const lessons = await db.collection('lessons').find({ courseId: course._id }).sort({ createdAt: 1 }).limit(200).toArray();
    const materials = await db.collection('materials').find({ courseId: course._id }, { projection: { content: 0 } }).sort({ createdAt: 1 }).limit(200).toArray();
    res.json({ course: { ...safeCourse(course), role: req.membership.role }, lessons: lessons.map(l => ({ id: l._id, title: l.title, body: l.body })), materials: materials.map(m => ({ id: m._id, title: m.title, filename: m.filename, contentType: m.contentType, size: m.size, category: m.category || 'notes' })) });
  });
  app.delete('/api/courses/:courseId/membership', membership, async (req, res) => {
    z.object({}).strict().parse(req.body);
    if (req.membership.role === 'admin') throw new ApiError(403, 'Course admins cannot leave their course.');
    const result = await db.collection('memberships').deleteOne({ courseId: req.params.courseId, userId: req.user.id, role: 'member' });
    if (!result.deletedCount) throw new ApiError(409, 'Your membership has changed. Refresh and try again.');
    res.json({ ok: true });
  });
  const admin = async (req, res, next) => {
    if (req.membership.role !== 'admin') throw new ApiError(403, 'Only course admins can do this.');
    next();
  };
  app.post('/api/courses/:courseId/materials', membership, admin,
    limit('upload-user', 30, 3600000, req => req.user.id),
    express.raw({ type: ['application/pdf', 'text/plain'], limit: '10mb' }), async (req, res) => {
      const category = z.enum(CATEGORY_VALUES).parse(req.get('x-material-category') ?? 'notes');
      let title, filename;
      try {
        title = z.string().trim().min(3).max(150).parse(decodeURIComponent(req.get('x-material-title') || ''));
        filename = z.string().min(1).max(180).regex(/^[^/\\\x00-\x1f\x7f]+\.(pdf|txt|md)$/i).parse(decodeURIComponent(req.get('x-file-name') || ''));
      } catch { throw new ApiError(400, 'Provide a title and a valid PDF, TXT, or MD filename.'); }
      const content = req.body;
      if (!Buffer.isBuffer(content) || !content.length) throw new ApiError(400, 'Choose a non-empty PDF or notes file.');
      const pdf = /\.pdf$/i.test(filename);
      if (pdf) {
        if (!req.is('application/pdf') || content.subarray(0, 5).toString() !== '%PDF-' || !content.subarray(-1024).includes(Buffer.from('%%EOF'))) throw new ApiError(400, 'This file does not look like a valid PDF.');
      } else {
        if (!req.is('text/plain') || content.includes(0)) throw new ApiError(400, 'Notes must be UTF-8 text files (.txt or .md).');
        try { new TextDecoder('utf-8', { fatal: true }).decode(content); }
        catch { throw new ApiError(400, 'Notes must use UTF-8 text encoding.'); }
      }
      const material = { _id: randomUUID(), courseId: req.params.courseId, title, filename, category, contentType: pdf ? 'application/pdf' : 'text/plain', size: content.length, content, createdAt: new Date() };
      await db.collection('materials').insertOne(material);
      res.status(201).json({ material: { id: material._id, title, filename, category, contentType: material.contentType, size: material.size } });
    });
  app.get('/api/courses/:courseId/materials/:materialId', membership, async (req, res) => {
    id.parse(req.params.materialId);
    const material = await db.collection('materials').findOne({ _id: req.params.materialId, courseId: req.params.courseId });
    if (!material) throw new ApiError(404, 'File not found.');
    res.attachment(material.filename).type(material.contentType);
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(material.content.buffer));
  });
  for (const collection of ['materials', 'lessons']) {
    app.delete(`/api/courses/:courseId/${collection}/:itemId`, membership, admin, async (req, res) => {
      const itemId = id.parse(req.params.itemId);
      z.object({}).strict().parse(req.body);
      const result = await db.collection(collection).deleteOne({ _id: itemId, courseId: req.params.courseId });
      if (!result.deletedCount) throw new ApiError(404, 'Course material not found.');
      res.json({ ok: true });
    });
  }
  app.post('/api/courses/:courseId/lessons', membership, admin, async (req, res) => {
    const data = z.object({ title: z.string().trim().min(3).max(150), body: z.string().trim().min(1).max(20000) }).strict().parse(req.body);
    const lesson = { _id: randomUUID(), courseId: req.params.courseId, ...data, createdAt: new Date() };
    await db.collection('lessons').insertOne(lesson);
    res.status(201).json({ lesson: { id: lesson._id, ...data } });
  });
  app.put('/api/courses/:courseId/password', membership, admin, async (req, res) => {
    const data = z.object({ password }).strict().parse(req.body);
    await db.collection('courseSecrets').updateOne({ courseId: req.params.courseId }, { $set: { passwordHash: await hashPassword(data.password) } }, { upsert: true });
    res.json({ ok: true });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint or method not found.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof z.ZodError || error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Please check the fields and try again. Unexpected fields are not accepted.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    const status = error instanceof ApiError ? error.status : 503;
    if (status >= 500) console.error(JSON.stringify({ event: 'request_failed', method: req.method, status }));
    res.status(status).json({ error: error instanceof ApiError ? error.message : 'Service temporarily unavailable. Please try again.' });
  });
  return app;
}
