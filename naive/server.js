'use strict';

const express = require('express');
const notes = require('./notes');
const { HttpError } = notes;

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Мелкая обёртка, чтобы не писать try/catch в каждом обработчике.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseTagsQuery(query) {
  const raw = [];
  if (query.tag !== undefined) raw.push(...[].concat(query.tag));
  if (query.tags !== undefined) raw.push(...[].concat(query.tags));
  return notes.normalizeTags(raw.flatMap((v) => String(v).split(',')));
}

function parseNumber(value, name) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new HttpError(400, `Параметр "${name}" должен быть целым неотрицательным числом`);
  }
  return n;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// GET /notes?tag=work&tag=urgent&match=all&q=текст&limit=10&offset=0
app.get(
  '/notes',
  wrap(async (req, res) => {
    const match = req.query.match === 'all' ? 'all' : 'any';
    const result = await notes.list({
      tags: parseTagsQuery(req.query),
      match,
      q: req.query.q ? String(req.query.q) : '',
      limit: parseNumber(req.query.limit, 'limit'),
      offset: parseNumber(req.query.offset, 'offset') || 0,
    });
    res.json(result);
  })
);

// Должен идти до /notes/:id, иначе "tags" будет прочитан как id.
app.get(
  '/tags',
  wrap(async (req, res) => {
    res.json({ items: await notes.listTags() });
  })
);

app.get(
  '/notes/:id',
  wrap(async (req, res) => {
    res.json(await notes.getById(req.params.id));
  })
);

app.post(
  '/notes',
  wrap(async (req, res) => {
    const note = await notes.create(req.body);
    res.status(201).json(note);
  })
);

app.put(
  '/notes/:id',
  wrap(async (req, res) => {
    res.json(await notes.update(req.params.id, req.body, { partial: false }));
  })
);

app.patch(
  '/notes/:id',
  wrap(async (req, res) => {
    res.json(await notes.update(req.params.id, req.body, { partial: true }));
  })
);

app.delete(
  '/notes/:id',
  wrap(async (req, res) => {
    await notes.remove(req.params.id);
    res.status(204).end();
  })
);

app.use((req, res) => {
  res.status(404).json({ error: `Маршрут ${req.method} ${req.path} не найден` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Битый JSON в теле запроса express помечает так.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Тело запроса — некорректный JSON' });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Notes API слушает http://localhost:${PORT}`);
  });
}

module.exports = app;
