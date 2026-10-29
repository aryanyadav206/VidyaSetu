import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { temporaryDatabase } from '../temp-db.js';
import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { createApp, hashPassword } from '../app.js';
import { initializeDatabase } from '../db.js';
import { CATEGORY_VALUES } from '../../shared/categories.js';

const origin = 'http://localhost:5173';
const coursePassword = 'a-unique-course-password';
let mongo, client, db, app, admin, learner, stranger, adminId, learnerId, courseId;
const post = (agent, path, body) => agent.post(path).set('Origin', origin).send(body);
before(async () => {
  mongo = await temporaryDatabase();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('security-tests');
  await initializeDatabase(db);
  app = await createApp({ db, client, origin });
  admin = request.agent(app); learner = request.agent(app); stranger = request.agent(app);
  const register = (agent, email) => post(agent, '/api/auth/register', { name: 'Test Learner', email, password: 'account-password-unique' }).expect(201);
  adminId = (await register(admin, 'admin@example.test')).body.user.id;
  learnerId = (await register(learner, 'learner@example.test')).body.user.id;
  await register(stranger, 'stranger@example.test');
  const created = await post(admin, '/api/courses', { title: 'Secure classrooms', description: 'An isolated test course', password: coursePassword }).expect(201);
  courseId = created.body.course.id;
  await post(admin, `/api/courses/${courseId}/lessons`, { title: 'First lesson', body: 'Protected course content.' }).expect(201);
}, { timeout: 240000 });
beforeEach(async () => {
  await db.collection('limits').deleteMany({});
  await db.collection('memberships').deleteMany({ userId: learnerId });
});
after(async () => { await client?.close(); await mongo?.stop(); });
const enroll = (agent = learner, extra = {}) => post(agent, '/api/courses/enroll', { courseId, password: coursePassword, ...extra });

test('correct password creates exactly one server-assigned member', async () => {
  const response = await enroll().expect(201);
  assert.equal(response.body.course.role, 'member');
  const row = await db.collection('memberships').findOne({ userId: learnerId, courseId });
  assert.equal(row.role, 'member');
  await learner.get(`/api/courses/${courseId}`).expect(200);
});
test('incorrect password does not create membership', async () => {
  await enroll(learner, { password: 'incorrect' }).expect(403);
  assert.equal(await db.collection('memberships').countDocuments({ userId: learnerId }), 0);
});
test('unauthenticated enrollment is rejected', async () => { await enroll(request(app)).expect(401); });
test('unknown course and incorrect password produce the same safe response', async () => {
  const missing = await enroll(learner, { courseId: randomUUID() }).expect(403);
  const incorrect = await enroll(learner, { password: 'wrong' }).expect(403);
  assert.deepEqual(missing.body, incorrect.body);
});
test('repeat enrollment returns conflict', async () => { await enroll().expect(201); await enroll().expect(409); });
test('client cannot spoof user ID', async () => {
  await enroll(learner, { userId: adminId }).expect(400);
  assert.equal(await db.collection('memberships').countDocuments({ userId: learnerId }), 0);
});
test('client cannot request admin role', async () => { await enroll(learner, { role: 'admin' }).expect(400); });
test('concurrent enrollments produce one success and one conflict', async () => {
  const results = await Promise.all([enroll(), enroll()]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(await db.collection('memberships').countDocuments({ courseId, userId: learnerId }), 1);
});
test('MongoDB unique compound index rejects direct duplicate inserts', async () => {
  await enroll().expect(201);
  await assert.rejects(db.collection('memberships').insertOne({ courseId, userId: learnerId, role: 'member' }), { code: 11000 });
});
test('course creation rolls back metadata when secret insertion fails', async () => {
  const failingDb = { collection(name) {
    return name === 'courseSecrets' ? { insertOne: async () => { throw new Error('injected secret failure'); } } : db.collection(name);
  } };
  const broken = await createApp({ db: failingDb, client, origin });
  const login = await post(admin, '/api/auth/login', { email: 'admin@example.test', password: 'account-password-unique' }).expect(200);
  const before = await db.collection('memberships').countDocuments({ userId: adminId });
  await request(broken).post('/api/courses').set('Origin', origin).set('Cookie', login.headers['set-cookie']).send({ title: 'Must roll back', description: '', password: coursePassword }).expect(503);
  assert.equal(await db.collection('courses').countDocuments({ title: 'Must roll back' }), 0);
  assert.equal(await db.collection('memberships').countDocuments({ userId: adminId }), before);
});
test('rate-limit storage failure fails closed', async () => {
  const failingDb = { collection(name) {
    return name === 'limits' ? { findOneAndUpdate: async () => { throw new Error('injected limit failure'); } } : db.collection(name);
  } };
  const broken = await createApp({ db: failingDb, client, origin });
  await request(broken).get('/api/auth/me').expect(503);
});
test('database insert failure never reports success', async () => {
  const failingDb = { collection(name) {
    const collection = db.collection(name);
    return name !== 'memberships' ? collection : { findOne: collection.findOne.bind(collection), insertOne: async () => { throw new Error('private database failure'); } };
  } };
  const broken = await createApp({ db: failingDb, client, origin });
  const cookie = (await post(learner, '/api/auth/login', { email: 'learner@example.test', password: 'account-password-unique' }).expect(200)).headers['set-cookie'];
  const response = await request(broken).post('/api/courses/enroll').set('Cookie', cookie).set('Origin', origin).send({ courseId, password: coursePassword }).expect(503);
  assert.ok(!JSON.stringify(response.body).includes('private database'));
  assert.equal(await db.collection('memberships').countDocuments({ userId: learnerId }), 0);
});
test('hashes and plaintext passwords are never returned in course or account responses', async () => {
  await enroll().expect(201);
  for (const url of ['/api/courses', `/api/courses/${courseId}`, '/api/auth/me']) {
    const response = await learner.get(url).expect(200);
    assert.doesNotMatch(JSON.stringify(response.body), /password|argon2|Hash/i);
  }
  assert.equal((await db.collection('courses').findOne({ _id: courseId })).passwordHash, undefined);
});
test('direct membership writes and role changes have no public endpoint', async () => {
  await post(learner, '/api/memberships', { courseId, userId: learnerId, role: 'admin' }).expect(404);
  await learner.patch('/api/memberships/anything').set('Origin', origin).send({ role: 'admin' }).expect(404);
});
test('outsider cannot access course content', async () => { await stranger.get(`/api/courses/${courseId}`).expect(403); });
test('creator retains admin and existing valid memberships work', async () => {
  const row = await db.collection('memberships').findOne({ courseId, userId: adminId });
  assert.equal(row.role, 'admin');
  assert.equal((await admin.get(`/api/courses/${courseId}`).expect(200)).body.course.role, 'admin');
  await enroll().expect(201);
  assert.equal((await learner.get(`/api/courses/${courseId}`).expect(200)).body.lessons[0].body, 'Protected course content.');
});
test('ordinary members cannot publish lessons or reset enrollment password', async () => {
  await enroll().expect(201);
  await post(learner, `/api/courses/${courseId}/lessons`, { title: 'Malicious lesson', body: 'No' }).expect(403);
  await learner.put(`/api/courses/${courseId}/password`).set('Origin', origin).send({ password: 'new-password-secret' }).expect(403);
});
test('password reset keeps existing members and invalidates old enrollment password', async () => {
  const newCourse = (await post(admin, '/api/courses', { title: 'Reset test', description: '', password: coursePassword }).expect(201)).body.course.id;
  await enroll(learner, { courseId: newCourse }).expect(201);
  await admin.put(`/api/courses/${newCourse}/password`).set('Origin', origin).send({ password: 'replacement-password' }).expect(200);
  await learner.get(`/api/courses/${newCourse}`).expect(200);
  await enroll(stranger, { courseId: newCourse }).expect(403);
  await enroll(stranger, { courseId: newCourse, password: 'replacement-password' }).expect(201);
});
test('missing secret fails closed until course admin resets it', async () => {
  const newCourse = (await post(admin, '/api/courses', { title: 'Imported course', description: '', password: coursePassword }).expect(201)).body.course.id;
  await db.collection('courseSecrets').deleteOne({ courseId: newCourse });
  await enroll(learner, { courseId: newCourse }).expect(403);
  await admin.put(`/api/courses/${newCourse}/password`).set('Origin', origin).send({ password: coursePassword }).expect(200);
  await enroll(learner, { courseId: newCourse }).expect(201);
});
test('legacy plaintext fields block startup for controlled migration', async () => {
  const legacy = client.db('legacy-test');
  await legacy.collection('courses').insertOne({ title: 'Legacy', password: 'do-not-import' });
  await assert.rejects(initializeDatabase(legacy), /Legacy password fields/);
});
test('password hashing uses unique salts and Argon2id verification', async () => {
  const [a,b] = await Promise.all([hashPassword(coursePassword), hashPassword(coursePassword)]);
  assert.notEqual(a,b); assert.match(a,/^\$argon2id\$/);
  assert.ok(await argon2.verify(a, coursePassword));
});
test('cross-origin and non-JSON writes are rejected', async () => {
  await learner.post('/api/courses/enroll').set('Origin','https://evil.example').send({courseId,password:coursePassword}).expect(403);
  await learner.post('/api/courses/enroll').set('Origin',origin).type('form').send({courseId,password:coursePassword}).expect(415);
});
test('malformed course IDs, extra fields, and unsupported methods fail', async () => {
  await enroll(learner, {courseId:'../../secrets'}).expect(400);
  await learner.delete('/api/courses/enroll').set('Origin',origin).send({}).expect(404);
});
test('expired sessions cannot enroll even before TTL cleanup runs', async () => {
  const agent = request.agent(app);
  const login = await post(agent,'/api/auth/login',{email:'learner@example.test',password:'account-password-unique'}).expect(200);
  assert.match(login.headers['set-cookie'][0], /HttpOnly/);
  assert.match(login.headers['set-cookie'][0], /SameSite=Strict/);
  // Expire all learner sessions; later tests do not use this identity.
  await db.collection('sessions').updateMany({userId:learnerId},{$set:{expiresAt:new Date(0)}});
  await enroll(agent).expect(401);
});
test('shared server-side limiter rejects repeated guesses with Retry-After', async () => {
  const agent = request.agent(app);
  await post(agent,'/api/auth/login',{email:'learner@example.test',password:'account-password-unique'}).expect(200);
  for(let i=0;i<10;i++) await enroll(agent,{password:'wrong'}).expect(403);
  const response = await enroll(agent,{password:'wrong'}).expect(429);
  assert.ok(Number(response.headers['retry-after'])>0);
});

const pdfContent = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const upload = (agent, filename, content, type = 'application/pdf', target = courseId, category) => {
  const req = agent.post(`/api/courses/${target}/materials`).set('Origin', origin).set('Content-Type', type).set('X-File-Name', encodeURIComponent(filename)).set('X-Material-Title', encodeURIComponent('Chapter one notes'));
  if (category !== undefined) req.set('X-Material-Category', category);
  return req.send(content);
};
test('admin uploads PDF, metadata excludes bytes, and authorized download matches original', async () => {
  const result = await upload(admin, 'chapter.pdf', pdfContent).expect(201);
  const materialId = result.body.material.id;
  assert.equal(result.body.material.size, pdfContent.length);
  const listing = await admin.get(`/api/courses/${courseId}`).expect(200);
  assert.equal(listing.body.materials.find(m => m.id === materialId).filename, 'chapter.pdf');
  assert.equal(listing.body.materials.find(m => m.id === materialId).content, undefined);
  const download = await admin.get(`/api/courses/${courseId}/materials/${materialId}`).expect(200);
  assert.match(download.headers['content-disposition'], /^attachment;/);
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(download.body, pdfContent);
  await stranger.get(`/api/courses/${courseId}/materials/${materialId}`).expect(403);
  await request(app).get(`/api/courses/${courseId}/materials/${materialId}`).expect(401);
});
test('members can download notes but cannot upload materials', async () => {
  const notes = Buffer.from('UTF-8 study notes: learning together.');
  const uploaded = await upload(admin, 'notes.md', notes, 'text/plain').expect(201);
  await post(learner, '/api/auth/login', { email: 'learner@example.test', password: 'account-password-unique' }).expect(200);
  await enroll().expect(201);
  await upload(learner, 'notes.txt', notes, 'text/plain').expect(403);
  await upload(stranger, 'notes.txt', notes, 'text/plain').expect(403);
  await upload(request(app), 'notes.txt', notes, 'text/plain').expect(401);
  const downloaded = await learner.get(`/api/courses/${courseId}/materials/${uploaded.body.material.id}`).expect(200);
  assert.equal(downloaded.text, notes.toString());
});
test('upload validation rejects disguised PDFs, binary notes, traversal and oversized files', async () => {
  const before = await db.collection('materials').countDocuments({});
  await upload(admin, 'fake.pdf', Buffer.from('not a PDF')).expect(400);
  await upload(admin, 'notes.txt', Buffer.from([0,255]), 'text/plain').expect(400);
  await upload(admin, 'notes.md', Buffer.from([255]), 'text/plain').expect(400);
  await upload(admin, '../file.pdf', pdfContent).expect(400);
  await upload(admin, 'script.html', pdfContent).expect(400);
  await upload(admin, 'empty.pdf', Buffer.alloc(0)).expect(400);
  await upload(admin, 'large.pdf', Buffer.alloc(10 * 1024 * 1024 + 1)).expect(413);
  assert.equal(await db.collection('materials').countDocuments({}), before);
});
test('file IDs cannot be used to download from a different authorized course', async () => {
  const uploaded = await upload(admin, 'private.pdf', pdfContent).expect(201);
  const other = (await post(admin, '/api/courses', { title: 'Another classroom', description: '', password: coursePassword }).expect(201)).body.course.id;
  await admin.get(`/api/courses/${other}/materials/${uploaded.body.material.id}`).expect(404);
  await admin.get(`/api/courses/${courseId}/materials/${randomUUID()}`).expect(404);
});
test('all five content categories are persisted and returned in course content', async () => {
  for (const category of CATEGORY_VALUES) {
    const result = await upload(admin, 'categorized.pdf', pdfContent, 'application/pdf', courseId, category).expect(201);
    assert.equal(result.body.material.category, category);
    const stored = await db.collection('materials').findOne({ _id: result.body.material.id });
    assert.equal(stored.category, category);
    const listing = await admin.get(`/api/courses/${courseId}`).expect(200);
    assert.equal(listing.body.materials.find(m => m.id === stored._id).category, category);
  }
});
test('unknown and empty categories fail without storing files', async () => {
  const before = await db.collection('materials').countDocuments({});
  await upload(admin, 'invalid.pdf', pdfContent, 'application/pdf', courseId, 'unapproved').expect(400);
  await upload(admin, 'invalid.pdf', pdfContent, 'application/pdf', courseId, '').expect(400);
  assert.equal(await db.collection('materials').countDocuments({}), before);
  const existing = await db.collection('materials').findOne({});
  await assert.rejects(db.collection('materials').updateOne({ _id: existing._id }, { $set: { category: 'unapproved' } }), { code: 121 });
});
test('uploads without a category default to notes and legacy uploads stay readable', async () => {
  const result = await upload(admin, 'older-notes.txt', Buffer.from('Existing notes'), 'text/plain').expect(201);
  assert.equal(result.body.material.category, 'notes');
  await db.collection('materials').updateOne({ _id: result.body.material.id }, { $unset: { category: '' } });
  const listing = await admin.get(`/api/courses/${courseId}`).expect(200);
  assert.equal(listing.body.materials.find(m => m.id === result.body.material.id).category, 'notes');
  await admin.get(`/api/courses/${courseId}/materials/${result.body.material.id}`).expect(200);
});
const remove = (agent, itemId, collection = 'materials', target = courseId) => agent.delete(`/api/courses/${target}/${collection}/${itemId}`).set('Origin', origin).send({});
test('members can leave, lose content access, and rejoin with the password', async () => {
  await enroll().expect(201);
  await learner.delete(`/api/courses/${courseId}/membership`).set('Origin', origin).send({}).expect(200);
  assert.equal(await db.collection('memberships').countDocuments({ courseId, userId: learnerId }), 0);
  await learner.get(`/api/courses/${courseId}`).expect(403);
  const listing = await learner.get('/api/courses').expect(200);
  assert.ok(!listing.body.courses.some(c => c.id === courseId));
  await enroll().expect(201);
});
test('leave rejects admins, outsiders, unauthenticated requests and spoofed identities', async () => {
  const path = `/api/courses/${courseId}/membership`;
  await admin.delete(path).set('Origin', origin).send({}).expect(403);
  await stranger.delete(path).set('Origin', origin).send({}).expect(403);
  await request(app).delete(path).set('Origin', origin).send({}).expect(401);
  await enroll().expect(201);
  await learner.delete(path).set('Origin', origin).send({ userId: adminId }).expect(400);
  assert.ok(await db.collection('memberships').findOne({ courseId, userId: adminId, role: 'admin' }));
  assert.ok(await db.collection('memberships').findOne({ courseId, userId: learnerId }));
});
test('admin removes files in every category and removed files cannot be downloaded', async () => {
  for (const category of CATEGORY_VALUES) {
    const item = (await upload(admin, 'remove.pdf', pdfContent, 'application/pdf', courseId, category).expect(201)).body.material;
    await remove(admin, item.id).expect(200);
    assert.equal(await db.collection('materials').countDocuments({ _id: item.id }), 0);
    const listing = await admin.get(`/api/courses/${courseId}`).expect(200);
    assert.ok(!listing.body.materials.some(m => m.id === item.id));
    await admin.get(`/api/courses/${courseId}/materials/${item.id}`).expect(404);
    await remove(admin, item.id).expect(404);
  }
});
test('members, outsiders and unauthenticated callers cannot remove files', async () => {
  const item = (await upload(admin, 'protected.txt', Buffer.from('Keep this note'), 'text/plain').expect(201)).body.material;
  await enroll().expect(201);
  await remove(learner, item.id).expect(403);
  await remove(stranger, item.id).expect(403);
  await remove(request(app), item.id).expect(401);
  assert.equal(await db.collection('materials').countDocuments({ _id: item.id }), 1);
});
test('removal is scoped to the authorized course and rejects invalid IDs', async () => {
  const item = (await upload(admin, 'scoped.pdf', pdfContent).expect(201)).body.material;
  const other = (await post(admin, '/api/courses', { title: 'Removal scope', description: '', password: coursePassword }).expect(201)).body.course.id;
  await remove(admin, item.id, 'materials', other).expect(404);
  await remove(admin, 'bad-id').expect(400);
  await admin.delete(`/api/courses/${courseId}/materials/${item.id}`).set('Origin', 'https://evil.example').send({}).expect(403);
  assert.equal(await db.collection('materials').countDocuments({ _id: item.id }), 1);
});
test('admin can remove older text notes without deleting other lessons', async () => {
  const note = (await post(admin, `/api/courses/${courseId}/lessons`, { title: 'Old text notes', body: 'Remove only this lesson.' }).expect(201)).body.lesson;
  await enroll().expect(201);
  await remove(learner, note.id, 'lessons').expect(403);
  await remove(admin, note.id, 'lessons').expect(200);
  assert.equal(await db.collection('lessons').countDocuments({ _id: note.id }), 0);
  assert.ok(await db.collection('lessons').findOne({ courseId, title: 'First lesson' }));
});
