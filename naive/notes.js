'use strict';

const { randomUUID } = require('crypto');
const store = require('./storage');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Теги приводим к нижнему регистру и убираем дубли — иначе "Work" и "work"
// станут разными тегами, и фильтрация будет вести себя непредсказуемо.
function normalizeTags(tags) {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) {
    throw new HttpError(400, 'Поле "tags" должно быть массивом строк');
  }

  const result = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') {
      throw new HttpError(400, 'Поле "tags" должно быть массивом строк');
    }
    const clean = tag.trim().toLowerCase();
    if (!clean) continue;
    if (!result.includes(clean)) result.push(clean);
  }
  return result;
}

function validateTitle(title) {
  if (typeof title !== 'string' || !title.trim()) {
    throw new HttpError(400, 'Поле "title" обязательно и должно быть непустой строкой');
  }
  return title.trim();
}

function validateBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body !== 'string') {
    throw new HttpError(400, 'Поле "body" должно быть строкой');
  }
  return body;
}

async function list({ tags = [], match = 'any', q = '', limit, offset = 0 } = {}) {
  let notes = await store.readAll();

  if (tags.length > 0) {
    notes = notes.filter((note) =>
      match === 'all'
        ? tags.every((t) => note.tags.includes(t))
        : tags.some((t) => note.tags.includes(t))
    );
  }

  if (q) {
    const needle = q.toLowerCase();
    notes = notes.filter(
      (note) =>
        note.title.toLowerCase().includes(needle) ||
        note.body.toLowerCase().includes(needle)
    );
  }

  notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const total = notes.length;
  const from = offset;
  const to = limit === undefined ? undefined : offset + limit;
  return { total, items: notes.slice(from, to) };
}

async function getById(id) {
  const notes = await store.readAll();
  const note = notes.find((n) => n.id === id);
  if (!note) throw new HttpError(404, `Заметка ${id} не найдена`);
  return note;
}

async function create(payload = {}) {
  const now = new Date().toISOString();
  const note = {
    id: randomUUID(),
    title: validateTitle(payload.title),
    body: validateBody(payload.body),
    tags: normalizeTags(payload.tags),
    createdAt: now,
    updatedAt: now,
  };

  const notes = await store.readAll();
  notes.push(note);
  await store.writeAll(notes);
  return note;
}

async function update(id, payload = {}, { partial }) {
  const notes = await store.readAll();
  const index = notes.findIndex((n) => n.id === id);
  if (index === -1) throw new HttpError(404, `Заметка ${id} не найдена`);

  const current = notes[index];

  const updated = {
    ...current,
    // PUT заменяет заметку целиком, PATCH трогает только присланные поля.
    title: partial
      ? payload.title === undefined
        ? current.title
        : validateTitle(payload.title)
      : validateTitle(payload.title),
    body: partial
      ? payload.body === undefined
        ? current.body
        : validateBody(payload.body)
      : validateBody(payload.body),
    tags: partial
      ? payload.tags === undefined
        ? current.tags
        : normalizeTags(payload.tags)
      : normalizeTags(payload.tags),
    updatedAt: new Date().toISOString(),
  };

  notes[index] = updated;
  await store.writeAll(notes);
  return updated;
}

async function remove(id) {
  const notes = await store.readAll();
  const index = notes.findIndex((n) => n.id === id);
  if (index === -1) throw new HttpError(404, `Заметка ${id} не найдена`);

  const [deleted] = notes.splice(index, 1);
  await store.writeAll(notes);
  return deleted;
}

async function listTags() {
  const notes = await store.readAll();
  const counts = new Map();

  for (const note of notes) {
    for (const tag of note.tags) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

module.exports = {
  HttpError,
  normalizeTags,
  list,
  getById,
  create,
  update,
  remove,
  listTags,
};
