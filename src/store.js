import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { ApiError } from './errors.js';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

// Отдельный тип, чтобы точка входа могла отличить «файл испорчен» от любой
// другой ошибки и не поднять сервис на пустом месте.
export class StorageError extends Error {
  constructor(file, reason) {
    super(`${file}: ${reason}`);
    this.file = file;
    this.reason = reason;
  }
}

function emptyState() {
  return { version: 1, notes: [], idempotency: [] };
}

function isValidState(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.version === 1 &&
    Array.isArray(value.notes) &&
    Array.isArray(value.idempotency)
  );
}

export function bodyHash(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

export class Store {
  // Все записи выстраиваются в одну цепочку: два одновременных сохранения
  // иначе могут переименовать свои временные файлы в обратном порядке,
  // и на диск ляжет состояние старее того, что уже в памяти.
  #writeChain = Promise.resolve();

  constructor(file) {
    this.file = file;
    this.state = emptyState();
  }

  #dropExpiredKeys(now) {
    this.state.idempotency = this.state.idempotency.filter(
      (record) => now - Date.parse(record.createdAt) < IDEMPOTENCY_TTL_MS,
    );
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new StorageError(this.file, `файл не читается (${error.code})`);
      }
      this.state = emptyState();
      await this.#persist();
      return;
    }

    if (raw.trim() === '') {
      this.state = emptyState();
      await this.#persist();
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StorageError(this.file, 'содержимое не разбирается как JSON');
    }
    if (!isValidState(parsed)) {
      throw new StorageError(this.file, 'структура файла не совпадает с ожидаемой');
    }
    this.state = parsed;
  }

  #persist() {
    // Ошибка одной записи не должна «залипнуть» в цепочке и уронить следующие,
    // но вызвавшему её обязана вернуться.
    const next = this.#writeChain.then(
      () => this.#writeNow(),
      () => this.#writeNow(),
    );
    this.#writeChain = next.catch(() => {});
    return next;
  }

  async #writeNow() {
    this.#dropExpiredKeys(Date.now());
    await mkdir(path.dirname(this.file), { recursive: true });
    // Пишем во временный файл рядом и переименовываем поверх рабочего: падение
    // посреди записи не оставит наполовину записанный JSON.
    const temporary = `${this.file}.tmp-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
  }

  list({ tags, limit, offset }) {
    // reverse() даёт «новые сверху» для одинаковых createdAt, сортировка в V8
    // стабильна и этот порядок сохраняет.
    let items = this.state.notes.slice().reverse();
    items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (tags) {
      items = items.filter((note) => tags.every((tag) => note.tags.includes(tag)));
    }
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset,
    };
  }

  get(id) {
    return this.state.notes.find((note) => note.id === id) ?? null;
  }

  async create(payload, key, hash) {
    // Чистим просроченные ключи до поиска, а не только при записи: иначе путь
    // «тот же ключ, то же тело» выходит раньше записи и ключ живёт вечно.
    this.#dropExpiredKeys(Date.now());

    if (key) {
      const record = this.state.idempotency.find((item) => item.key === key);
      if (record) {
        if (record.bodyHash !== hash) {
          throw new ApiError(
            409,
            'idempotency_key_conflict',
            'Idempotency-Key: этот ключ уже использован с другим телом запроса',
            'Idempotency-Key',
          );
        }
        const existing = this.get(record.noteId);
        if (existing) return { note: existing, created: false };
        // Заметку успели удалить, а запись о ключе осталась: освобождаем ключ
        // и создаём заново, иначе клиент навсегда упрётся в мёртвую ссылку.
        this.state.idempotency = this.state.idempotency.filter((item) => item.key !== key);
      }
    }

    const now = new Date().toISOString();
    const note = { id: randomUUID(), ...payload, createdAt: now, updatedAt: now };
    this.state.notes.push(note);
    if (key) {
      this.state.idempotency.push({ key, bodyHash: hash, noteId: note.id, createdAt: now });
    }
    await this.#persist();
    return { note, created: true };
  }

  async patch(id, changes) {
    const note = this.get(id);
    if (!note) return null;
    Object.assign(note, changes, { updatedAt: new Date().toISOString() });
    await this.#persist();
    return note;
  }

  async remove(id) {
    const index = this.state.notes.findIndex((note) => note.id === id);
    if (index === -1) return false;
    this.state.notes.splice(index, 1);
    await this.#persist();
    return true;
  }
}
