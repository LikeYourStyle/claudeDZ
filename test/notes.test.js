import test from 'node:test';
import assert from 'node:assert/strict';
import { request, startTestServer } from '../test-utils/temp-server.js';

// Названия повторяют формулировки из CONTRACT.md, чтобы расхождение
// контракта и кода было видно глазами.

test('GET /notes на пустом хранилище возвращает 200 и пустой список', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const response = await request(server.url, 'GET', '/notes');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { items: [], total: 0, limit: 20, offset: 0 });
});

test('POST /notes нормализует теги: trim, нижний регистр, без дублей и пустых', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const response = await request(server.url, 'POST', '/notes', {
    body: { title: 'Купить молоко', tags: ['  Работа ', 'работа', 'РАБОТА', ''] },
  });

  assert.equal(response.status, 201);
  assert.deepEqual(response.body.tags, ['работа']);
  assert.equal(response.body.text, '', 'text по умолчанию — пустая строка');
  assert.match(response.body.id, /^[0-9a-f-]{36}$/);
  assert.equal(response.body.createdAt, response.body.updatedAt);
});

test('GET /notes?tags=a,b возвращает только заметки, у которых есть оба тега', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  await request(server.url, 'POST', '/notes', { body: { title: 'Оба', tags: ['работа', 'срочное'] } });
  await request(server.url, 'POST', '/notes', { body: { title: 'Только работа', tags: ['работа'] } });
  await request(server.url, 'POST', '/notes', { body: { title: 'Без тегов' } });

  const response = await request(server.url, 'GET', '/notes?tags=работа,срочное');

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.deepEqual(
    response.body.items.map((note) => note.title),
    ['Оба'],
  );
});

test('GET /notes?tags= фильтрует регистронезависимо, как и при сохранении', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  await request(server.url, 'POST', '/notes', { body: { title: 'Заметка', tags: ['Дом'] } });

  const response = await request(server.url, 'GET', '/notes?tags=  ДОМ  ');

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
});

test('GET /notes отдаёт новые сверху и режет выборку через limit и offset', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  for (const title of ['Первая', 'Вторая', 'Третья']) {
    await request(server.url, 'POST', '/notes', { body: { title } });
  }

  const firstPage = await request(server.url, 'GET', '/notes?limit=2');
  assert.equal(firstPage.body.total, 3);
  assert.deepEqual(
    firstPage.body.items.map((note) => note.title),
    ['Третья', 'Вторая'],
  );

  const secondPage = await request(server.url, 'GET', '/notes?limit=2&offset=2');
  assert.deepEqual(
    secondPage.body.items.map((note) => note.title),
    ['Первая'],
  );

  const beyond = await request(server.url, 'GET', '/notes?offset=99');
  assert.equal(beyond.status, 200, 'offset за пределами выборки — не ошибка');
  assert.deepEqual(beyond.body.items, []);
  assert.equal(beyond.body.total, 3);
});

test('GET /notes/{id} возвращает заметку целиком', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const created = await request(server.url, 'POST', '/notes', { body: { title: 'Заметка' } });
  const response = await request(server.url, 'GET', `/notes/${created.body.id}`);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, created.body);
});

test('PATCH /notes/{id} меняет только переданные поля и обновляет updatedAt', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const created = await request(server.url, 'POST', '/notes', {
    body: { title: 'Было', text: 'Текст остаётся', tags: ['дом'] },
  });

  const response = await request(server.url, 'PATCH', `/notes/${created.body.id}`, {
    body: { title: 'Стало', tags: ['Работа', 'работа'] },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.title, 'Стало');
  assert.equal(response.body.text, 'Текст остаётся');
  assert.deepEqual(response.body.tags, ['работа'], 'теги заменяются целиком и нормализуются');
  assert.equal(response.body.createdAt, created.body.createdAt);
  assert.notEqual(response.body.updatedAt, created.body.updatedAt);
});

test('DELETE /notes/{id} отвечает 204 без тела', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const created = await request(server.url, 'POST', '/notes', { body: { title: 'На удаление' } });
  const response = await request(server.url, 'DELETE', `/notes/${created.body.id}`);

  assert.equal(response.status, 204);
  assert.equal(response.raw, '');

  const list = await request(server.url, 'GET', '/notes');
  assert.equal(list.body.total, 0);
});

test('повторный POST с тем же Idempotency-Key и тем же телом возвращает 200 и ту же заметку', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const payload = { body: { title: 'Ретрай', tags: ['дом'] }, headers: { 'idempotency-key': 'retry-1' } };

  const first = await request(server.url, 'POST', '/notes', payload);
  const second = await request(server.url, 'POST', '/notes', payload);

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.id, first.body.id);

  const list = await request(server.url, 'GET', '/notes');
  assert.equal(list.body.total, 1, 'вторая заметка не создалась');
});

test('POST без Idempotency-Key с тем же телом создаёт вторую заметку', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  await request(server.url, 'POST', '/notes', { body: { title: 'Дубль' } });
  await request(server.url, 'POST', '/notes', { body: { title: 'Дубль' } });

  const list = await request(server.url, 'GET', '/notes');
  assert.equal(list.body.total, 2);
});
