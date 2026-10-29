export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, "not_found", `${what} topilmadi`);
export const conflict = (code: string, message: string, details?: unknown) => new HttpError(409, code, message, details);
export const badRequest = (message: string, details?: unknown) => new HttpError(400, "bad_request", message, details);
export const forbidden = (message = "Bu amal uchun ruxsat yo'q") => new HttpError(403, "forbidden", message);
export const unauthorized = () => new HttpError(401, "unauthorized", "Tizimga kiring");
