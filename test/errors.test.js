import test from 'node:test';
import assert from 'node:assert/strict';
import { request, startTestServer } from '../test-utils/temp-server.js';
import { readBody } from '../src/server.js';
import { LIMITS } from '../src/validation.js';

test('неизвестное поле в теле — 400 unknown_field с именем поля', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const response = await request(server.url, 'POST', '/notes', {
    body: { titel: 'Опечатка в имени поля' },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'unknown_field');
  assert.equal(response.body.error.field, 'titel');
});

test('id, createdAt и updatedAt клиент прислать не может', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const response = await request(server.url, 'POST', '/notes', {
    body: { title: 'Заметка', id: 'свой-id' },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'unknown_field');
  assert.equal(response.body.error.field, 'id');
});

test('title обязателен, пустой и слишком длинный не проходят', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const missing = await request(server.url, 'POST', '/notes', { body: { text: 'Только текст' } });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'validation_error');
  assert.equal(missing.body.error.field, 'title');

  const blank = await request(server.url, 'POST', '/notes', { body: { title: '     ' } });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error.field, 'title');

  const long = await request(server.url, 'POST', '/notes', { body: { title: 'я'.repeat(LIMITS.title + 1) } });
  assert.equal(long.status, 400);
  assert.equal(long.body.error.field, 'title');
});

test('tags: не массив, не строки внутри, слишком длинный тег — 400 с field tags', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const notArray = await request(server.url, 'POST', '/notes', { body: { title: 'Т', tags: 'дом' } });
  assert.equal(notArray.status, 400);
  assert.equal(notArray.body.error.field, 'tags');

  const notStrings = await request(server.url, 'POST', '/notes', { body: { title: 'Т', tags: [42] } });
  assert.equal(notStrings.status, 400);
  assert.equal(notStrings.body.error.field, 'tags');

  const tooLong = await request(server.url, 'POST', '/notes', {
    body: { title: 'Т', tags: ['т'.repeat(LIMITS.tag + 1)] },
  });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error.field, 'tags');
});

test('тело не разбирается как JSON — 400 invalid_json', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const broken = await request(server.url, 'POST', '/notes', { rawBody: '{ это не json' });
  assert.equal(broken.status, 400);
  assert.equal(broken.body.error.code, 'invalid_json');

  const notObject = await request(server.url, 'POST', '/notes', { rawBody: '[1,2,3]' });
  assert.equal(notObject.status, 400);
  assert.equal(notObject.body.error.code, 'invalid_json');
});

test('limit и offset за границами — 400 с именем параметра', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'limit=1.5', 'limit=']) {
    const response = await request(server.url, 'GET', `/notes?${query}`);
    assert.equal(response.status, 400, `ожидался 400 на ?${query}`);
    assert.equal(response.body.error.field, 'limit');
  }

  for (const query of ['offset=-1', 'offset=abc']) {
    const response = await request(server.url, 'GET', `/notes?${query}`);
    assert.equal(response.status, 400, `ожидался 400 на ?${query}`);
    assert.equal(response.body.error.field, 'offset');
  }
});

test('tags из одних пробелов и запятых — 400, а не «фильтра нет»', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const response = await request(server.url, 'GET', '/notes?tags=,,%20%20');

  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'tags');
});

test('неизвестный id — 404 not_found на GET, PATCH и DELETE', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const id = '00000000-0000-4000-8000-000000000000';

  const read = await request(server.url, 'GET', `/notes/${id}`);
  assert.equal(read.status, 404);
  assert.equal(read.body.error.code, 'not_found');

  const patched = await request(server.url, 'PATCH', `/notes/${id}`, { body: { title: 'Новое' } });
  assert.equal(patched.status, 404, 'PATCH на несуществующий id не создаёт запись');

  const removed = await request(server.url, 'DELETE', `/notes/${id}`);
  assert.equal(removed.status, 404);
});

test('повторное удаление того же id — 404', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const created = await request(server.url, 'POST', '/notes', { body: { title: 'Раз' } });
  assert.equal((await request(server.url, 'DELETE', `/notes/${created.body.id}`)).status, 204);
  assert.equal((await request(server.url, 'DELETE', `/notes/${created.body.id}`)).status, 404);
});

test('PATCH с пустым телом — 400 empty_patch', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const created = await request(server.url, 'POST', '/notes', { body: { title: 'Заметка' } });
  const response = await request(server.url, 'PATCH', `/notes/${created.body.id}`, { body: {} });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'empty_patch');
});

test('тот же Idempotency-Key с другим телом — 409', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const headers = { 'idempotency-key': 'key-1' };
  await request(server.url, 'POST', '/notes', { body: { title: 'Первое' }, headers });
  const conflict = await request(server.url, 'POST', '/notes', { body: { title: 'Другое' }, headers });

  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'idempotency_key_conflict');

  const list = await request(server.url, 'GET', '/notes');
  assert.equal(list.body.total, 1, 'конфликт ничего не создал');
});

test('пустой Idempotency-Key — 400', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const response = await request(server.url, 'POST', '/notes', {
    body: { title: 'Заметка' },
    headers: { 'idempotency-key': '' },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.field, 'Idempotency-Key');
});

test('неподдерживаемый метод — 405 с заголовком Allow', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const response = await request(server.url, 'PUT', '/notes', { body: { title: 'Т' } });

  assert.equal(response.status, 405);
  assert.equal(response.body.error.code, 'method_not_allowed');
  assert.equal(response.headers.get('allow'), 'GET, POST');
});

test('неизвестный маршрут — 404 в том же формате ошибки', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const response = await request(server.url, 'GET', '/notes/id/лишний/сегмент');

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'not_found');
});

test('в теле ошибки нет стектрейса и лишних полей', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const response = await request(server.url, 'POST', '/notes', { body: { titel: 'опечатка' } });

  assert.deepEqual(Object.keys(response.body), ['error']);
  assert.deepEqual(Object.keys(response.body.error).sort(), ['code', 'field', 'message']);
  assert.doesNotMatch(response.raw, /at .+\.js:\d+/, 'в ответе не должно быть строк стектрейса');
});

test('тело больше 1 МиБ отклоняется до разбора', async () => {
  // Через реальный сокет это проверять ненадёжно: сервер отвечает раньше,
  // чем клиент дописал тело. Поэтому дёргаем readBody напрямую.
  const oversized = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(LIMITS.body + 1);
    },
  };

  await assert.rejects(
    () => readBody(oversized),
    (error) => error.status === 400 && error.field === 'body',
  );
});

// Ниже — тесты на находки аудита (сессия 2).

test('неизвестный query-параметр — 400 unknown_field с его именем', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const response = await request(server.url, 'GET', '/notes?foo=bar');

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'unknown_field');
  assert.equal(response.body.error.field, 'foo');
});

test('имя поля доезжает в ответе, даже если оно пустая строка', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const response = await request(server.url, 'POST', '/notes', { rawBody: '{"":"x"}' });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'unknown_field');
  assert.equal(response.body.error.field, '', 'пустое имя поля — тоже имя поля');
});
