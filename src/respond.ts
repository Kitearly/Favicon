/**
 * 与请求参数无关、但两个入口都要用的响应助手。
 */

/** 与网关共用的 CORS 头。 */
export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
  "access-control-expose-headers":
    "x-favicon-source, x-favicon-final-url, x-favicon-cache, x-favicon-reason",
};

/** Build a JSON error response. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
