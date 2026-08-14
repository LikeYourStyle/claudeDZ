import { ApiError } from './errors.js';

// Границы из CONTRACT.md. Меняются только вместе с контрактом.
export const LIMITS = {
  title: 200,
  text: 10_000,
  tag: 32,
  tags: 20,
  idempotencyKey: 128,
  body: 1024 * 1024,
  limit: 100,
  defaultLimit: 20,
};

const WRITABLE_FIELDS = ['title', 'text', 'tags'];

// Порядок важен и зафиксирован в контракте: trim → нижний регистр →
// выброс пустых → схлопывание дублей с сохранением первого вхождения.
export function normalizeTags(values) {
  const result = [];
  for (const value of values) {
    const tag = value.trim().toLowerCase();
    if (tag === '') continue;
    if (!result.includes(tag)) result.push(tag);
  }
  return result;
}

function assertObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_json', 'тело запроса должно быть JSON-объектом');
  }
}

function assertKnownFields(body) {
  for (const key of Object.keys(body)) {
    if (!WRITABLE_FIELDS.includes(key)) {
      throw new ApiError(400, 'unknown_field', `${key}: неизвестное поле`, key);
    }
  }
}

function readTitle(value) {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'validation_error', 'title: ожидается строка', 'title');
  }
  const title = value.trim();
  if (title.length === 0) {
    throw new ApiError(400, 'validation_error', 'title: не может быть пустым', 'title');
  }
  if (title.length > LIMITS.title) {
    throw new ApiError(400, 'validation_error', `title: не длиннее ${LIMITS.title} символов`, 'title');
  }
  return title;
}

function readText(value) {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'validation_error', 'text: ожидается строка', 'text');
  }
  if (value.length > LIMITS.text) {
    throw new ApiError(400, 'validation_error', `text: не длиннее ${LIMITS.text} символов`, 'text');
  }
  return value;
}

function readTags(value) {
  if (!Array.isArray(value)) {
    throw new ApiError(400, 'validation_error', 'tags: ожидается массив строк', 'tags');
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new ApiError(400, 'validation_error', 'tags: все элементы должны быть строками', 'tags');
    }
  }
  const tags = normalizeTags(value);
  for (const tag of tags) {
    if (tag.length > LIMITS.tag) {
      throw new ApiError(400, 'validation_error', `tags: тег не длиннее ${LIMITS.tag} символов`, 'tags');
    }
  }
  if (tags.length > LIMITS.tags) {
    throw new ApiError(400, 'validation_error', `tags: не больше ${LIMITS.tags} тегов`, 'tags');
  }
  return tags;
}

export function validateCreate(body) {
  assertObject(body);
  assertKnownFields(body);
  if (body.title === undefined) {
    throw new ApiError(400, 'validation_error', 'title: обязательное поле', 'title');
  }
  return {
    title: readTitle(body.title),
    text: body.text === undefined ? '' : readText(body.text),
    tags: body.tags === undefined ? [] : readTags(body.tags),
  };
}

export function validatePatch(body) {
  assertObject(body);
  assertKnownFields(body);
  if (Object.keys(body).length === 0) {
    throw new ApiError(400, 'empty_patch', 'тело не содержит ни одного изменяемого поля');
  }
  const changes = {};
  if ('title' in body) changes.title = readTitle(body.title);
  if ('text' in body) changes.text = readText(body.text);
  if ('tags' in body) changes.tags = readTags(body.tags);
  return changes;
}

export function validateIdempotencyKey(raw) {
  if (raw === undefined || raw === null) return null;
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (typeof key !== 'string' || key.length === 0 || key.length > LIMITS.idempotencyKey) {
    throw new ApiError(
      400,
      'validation_error',
      `Idempotency-Key: строка от 1 до ${LIMITS.idempotencyKey} символов`,
      'Idempotency-Key',
    );
  }
  return key;
}

const KNOWN_QUERY_PARAMS = ['tags', 'limit', 'offset'];

export function parseListQuery(searchParams) {
  // Строго, как и с телом запроса: лишний параметр — ошибка, а не «не заметим».
  // Плата известна и принята: ссылка с ?utm_source= получит 400.
  for (const name of searchParams.keys()) {
    if (!KNOWN_QUERY_PARAMS.includes(name)) {
      throw new ApiError(400, 'unknown_field', `${name}: неизвестный параметр запроса`, name);
    }
  }

  let limit = LIMITS.defaultLimit;
  const rawLimit = searchParams.get('limit');
  if (rawLimit !== null) {
    if (!/^-?\d+$/.test(rawLimit)) {
      throw new ApiError(400, 'validation_error', 'limit: ожидается целое число', 'limit');
    }
    limit = Number(rawLimit);
    if (limit < 1 || limit > LIMITS.limit) {
      throw new ApiError(400, 'validation_error', `limit: допустимо от 1 до ${LIMITS.limit}`, 'limit');
    }
  }

  let offset = 0;
  const rawOffset = searchParams.get('offset');
  if (rawOffset !== null) {
    if (!/^\d+$/.test(rawOffset)) {
      throw new ApiError(400, 'validation_error', 'offset: ожидается целое число не меньше 0', 'offset');
    }
    offset = Number(rawOffset);
    if (!Number.isSafeInteger(offset)) {
      throw new ApiError(400, 'validation_error', 'offset: слишком большое значение', 'offset');
    }
  }

  let tags = null;
  const rawTags = searchParams.get('tags');
  if (rawTags !== null) {
    tags = normalizeTags(rawTags.split(','));
    if (tags.length === 0) {
      throw new ApiError(400, 'validation_error', 'tags: после нормализации не осталось ни одного тега', 'tags');
    }
  }

  return { limit, offset, tags };
}
