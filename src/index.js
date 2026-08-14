import path from 'node:path';
import { Store, StorageError } from './store.js';
import { createServer } from './server.js';

// NOTES_FILE нужен тестам, чтобы не трогать рабочее хранилище.
const file = process.env.NOTES_FILE ?? path.join(process.cwd(), 'data', 'notes.json');
const port = Number(process.env.PORT ?? 3000);

const store = new Store(file);

try {
  await store.load();
} catch (error) {
  if (error instanceof StorageError) {
    console.error(`Хранилище не читается: ${error.file}`);
    console.error(`Причина: ${error.reason}`);
    console.error('Сервис не запущен. Файл не изменён — почините или удалите его вручную.');
    process.exit(1);
  }
  throw error;
}

createServer(store).listen(port, () => {
  console.log(`Сервис заметок слушает http://localhost:${port}`);
  console.log(`Хранилище: ${file}`);
});
