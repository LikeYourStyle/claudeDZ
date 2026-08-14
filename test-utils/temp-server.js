import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

// Каждый тест получает собственный файл во временной папке ОС: рабочее
// data/notes.json тесты не трогают и в сеть не ходят. Лежит вне test/,
// чтобы тест-раннер не считал этот файл тестом.

export async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), 'notes-api-'));
}

export async function startTestServer({ fileContent } = {}) {
  const dir = await makeTempDir();
  const file = path.join(dir, 'notes.json');
  if (fileContent !== undefined) {
    await writeFile(file, fileContent, 'utf8');
  }

  const store = new Store(file);
  await store.load();

  const server = createServer(store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    file,
    dir,
    async close() {
      // fetch держит keep-alive соединение: без этого close() ждёт таймаута.
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function request(base, method, pathname, options = {}) {
  const { body, rawBody, headers = {} } = options;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === '' ? null : JSON.parse(text),
    raw: text,
  };
}
