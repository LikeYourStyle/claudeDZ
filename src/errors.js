// Единый формат ошибки описан в CONTRACT.md. Наружу уходят только code, message
// и (если ошибка привязана к полю) field — ни стектрейсов, ни путей к файлам.

export class ApiError extends Error {
  constructor(status, code, message, field = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

export function errorBody(error) {
  const body = { code: error.code, message: error.message };
  // Сравнение с null, а не проверка на истинность: имя поля может быть
  // пустой строкой (ключ "" в теле запроса), и оно всё равно должно доехать.
  if (error.field !== null && error.field !== undefined) body.field = error.field;
  return { error: body };
}

export function notFound() {
  return new ApiError(404, 'not_found', 'запрошенный ресурс не найден');
}

export function methodNotAllowed(allow) {
  const error = new ApiError(405, 'method_not_allowed', `метод не поддерживается, допустимы: ${allow}`);
  error.headers = { allow };
  return error;
}
