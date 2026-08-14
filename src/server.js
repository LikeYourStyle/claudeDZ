import http from 'node:http';
import { ApiError, errorBody, methodNotAllowed, notFound } from './errors.js';
import {
  LIMITS,
  parseListQuery,
  validateCreate,
  validateIdempotencyKey,
  validatePatch,
} from './validation.js';
import { bodyHash } from './store.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function send(res, status, payload) {
  if (payload === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, JSON_HEADERS).end(JSON.stringify(payload));
}

// Экспортируется ради теста: проверять лимит тела через реальный сокет
// ненадёжно — клиент успевает получить обрыв соединения раньше ответа.
export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMITS.body) {
      throw new ApiError(400, 'validation_error', 'тело запроса больше 1 МиБ', 'body');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(raw) {
  if (raw.trim() === '') {
    throw new ApiError(400, 'invalid_json', 'тело запроса пустое');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'invalid_json', 'тело запроса не разбирается как JSON');
  }
}

async function handle(req, res, store) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  if (pathname === '/notes') {
    if (req.method === 'GET') {
      return send(res, 200, store.list(parseListQuery(url.searchParams)));
    }
    if (req.method === 'POST') {
      const key = validateIdempotencyKey(req.headers['idempotency-key']);
      const raw = await readBody(req);
      const payload = validateCreate(parseJson(raw));
      const { note, created } = await store.create(payload, key, bodyHash(raw));
      return send(res, created ? 201 : 200, note);
    }
    throw methodNotAllowed('GET, POST');
  }

  const match = /^\/notes\/([^/]+)$/.exec(pathname);
  if (match) {
    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      throw notFound();
    }

    if (req.method === 'GET') {
      const note = store.get(id);
      if (!note) throw notFound();
      return send(res, 200, note);
    }
    if (req.method === 'PATCH') {
      const changes = validatePatch(parseJson(await readBody(req)));
      const note = await store.patch(id, changes);
      if (!note) throw notFound();
      return send(res, 200, note);
    }
    if (req.method === 'DELETE') {
      const removed = await store.remove(id);
      if (!removed) throw notFound();
      return send(res, 204);
    }
    throw methodNotAllowed('GET, PATCH, DELETE');
  }

  throw notFound();
}

export function createServer(store) {
  return http.createServer((req, res) => {
    handle(req, res, store).catch((error) => {
      if (error instanceof ApiError) {
        res.writeHead(error.status, { ...JSON_HEADERS, ...(error.headers ?? {}) });
        res.end(JSON.stringify(errorBody(error)));
        return;
      }
      // Непредвиденное пишем только в консоль сервиса: наружу уходит общая фраза.
      console.error('Непредвиденная ошибка:', error);
      res.writeHead(500, JSON_HEADERS);
      res.end(JSON.stringify(errorBody(new ApiError(500, 'internal_error', 'внутренняя ошибка сервиса'))));
    });
  });
}
