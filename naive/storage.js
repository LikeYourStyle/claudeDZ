'use strict';

const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'notes.json');
const TMP_FILE = DATA_FILE + '.tmp';

// Все записи в файл выстраиваются в очередь, чтобы два параллельных
// запроса не перезаписали друг друга.
let writeChain = Promise.resolve();

async function ensureFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify({ notes: [] }, null, 2), 'utf8');
  }
}

async function readAll() {
  await ensureFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Файл данных повреждён: ${DATA_FILE}`);
  }

  if (!parsed || !Array.isArray(parsed.notes)) return [];
  return parsed.notes;
}

async function writeAll(notes) {
  // Пишем во временный файл и переименовываем — так файл не останется
  // наполовину записанным, если процесс упадёт посреди записи.
  writeChain = writeChain.then(async () => {
    await ensureFile();
    await fs.writeFile(TMP_FILE, JSON.stringify({ notes }, null, 2), 'utf8');
    await fs.rename(TMP_FILE, DATA_FILE);
  });
  return writeChain;
}

module.exports = { readAll, writeAll, DATA_FILE };
