import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyHash, Store, StorageError } from '../src/store.js';
import { makeTempDir, request, startTestServer } from '../test-utils/temp-server.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('файла хранилища нет — создаётся при старте с пустой структурой', async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, 'nested', 'notes.json');

  const store = new Store(file);
  await store.load();

  assert.deepEqual(store.state, { version: 1, notes: [], idempotency: [] });
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(written.notes, [], 'файл создан на диске, а не только в памяти');
});

test('файл пустой (0 байт) — читается как пустая структура и переписывается', async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, 'notes.json');
  await writeFile(file, '', 'utf8');

  const store = new Store(file);
  await store.load();

  assert.deepEqual(store.state.notes, []);
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(written.version, 1);
});

test('файл испорчен — StorageError, содержимое не перезаписано', async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, 'notes.json');
  const broken = '{ "notes": [ это не json';
  await writeFile(file, broken, 'utf8');

  const store = new Store(file);
  await assert.rejects(() => store.load(), StorageError);
  assert.equal(await readFile(file, 'utf8'), broken, 'испорченный файл остался как был');
});

test('структура файла не та — StorageError', async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, 'notes.json');
  await writeFile(file, JSON.stringify({ version: 1, notes: 'не массив' }), 'utf8');

  const store = new Store(file);
  await assert.rejects(() => store.load(), StorageError);
});

test('сервис не стартует на испорченном хранилище и говорит, какой файл виноват', async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, 'notes.json');
  await writeFile(file, '{ сломано', 'utf8');

  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: projectRoot,
    env: { ...process.env, NOTES_FILE: file, PORT: '0' },
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const code = await new Promise((resolve) => child.on('close', resolve));

  assert.equal(code, 1, 'сервис обязан завершиться с ненулевым кодом');
  assert.match(stderr, /Хранилище не читается/);
  assert.ok(stderr.includes(file), 'в сообщении есть путь к файлу');
});

test('данные переживают перезапуск сервиса', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const created = await request(server.url, 'POST', '/notes', {
    body: { title: 'Переживёт перезапуск', tags: ['дом'] },
  });

  // Новый Store на том же файле — это и есть перезапуск сервиса.
  const reopened = new Store(server.file);
  await reopened.load();

  const note = reopened.get(created.body.id);
  assert.ok(note, 'заметка нашлась после перезапуска');
  assert.equal(note.title, 'Переживёт перезапуск');
  assert.deepEqual(note.tags, ['дом']);
});

test('после записи в папке хранилища не остаётся временных файлов', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  await request(server.url, 'POST', '/notes', { body: { title: 'Заметка' } });

  const files = await readdir(server.dir);
  assert.deepEqual(files, ['notes.json'], `лишние файлы: ${files.join(', ')}`);
});

test('запись о ключе идемпотентности лежит в файле, а не в памяти процесса', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  await request(server.url, 'POST', '/notes', {
    body: { title: 'С ключом' },
    headers: { 'idempotency-key': 'key-in-file' },
  });

  const written = JSON.parse(await readFile(server.file, 'utf8'));
  assert.equal(written.idempotency.length, 1);
  assert.equal(written.idempotency[0].key, 'key-in-file');
});

// Ниже — тесты на находки аудита (сессия 2).

test('в файле нет поля version — структура не та, StorageError', async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, 'notes.json');
  await writeFile(file, JSON.stringify({ notes: [], idempotency: [] }), 'utf8');

  const store = new Store(file);
  await assert.rejects(() => store.load(), StorageError);
});

test('ключ идемпотентности старше 24 часов не переиспользуется', async (t) => {
  const body = { title: 'Ретрай' };
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const existing = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Старая заметка',
    text: '',
    tags: [],
    createdAt: stale,
    updatedAt: stale,
  };

  const server = await startTestServer({
    fileContent: JSON.stringify({
      version: 1,
      notes: [existing],
      idempotency: [
        { key: 'stale', bodyHash: bodyHash(JSON.stringify(body)), noteId: existing.id, createdAt: stale },
      ],
    }),
  });
  t.after(() => server.close());

  const response = await request(server.url, 'POST', '/notes', {
    body,
    headers: { 'idempotency-key': 'stale' },
  });

  assert.equal(response.status, 201, 'ключ протух — создаётся новая заметка, а не возвращается старая');
  assert.notEqual(response.body.id, existing.id);
});

test('параллельные создания все доезжают до файла', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  await Promise.all(
    Array.from({ length: 20 }, (unused, index) =>
      request(server.url, 'POST', '/notes', { body: { title: `Заметка ${index}` } }),
    ),
  );

  const written = JSON.parse(await readFile(server.file, 'utf8'));
  assert.equal(written.notes.length, 20, 'ни одно сохранение не потерялось на диске');
});
