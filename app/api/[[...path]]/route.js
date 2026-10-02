import serverless from 'serverless-http';
import expressApp from '../../../server.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const expressHandler = serverless(expressApp, {
  binary: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
});

const MAX_API_BODY_BYTES = 2 * 1024 * 1024;

async function readBodyWithLimit(request) {
  if (!request.body) return Buffer.alloc(0);
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_API_BODY_BYTES) {
    throw new Error('Request body is too large.');
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_API_BODY_BYTES) {
        await reader.cancel();
        throw new Error('Request body is too large.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function dispatch(request) {
  const url = new URL(request.url);
  const hasBody = !['GET', 'HEAD'].includes(request.method.toUpperCase());
  let rawBody = Buffer.alloc(0);
  if (hasBody) {
    try {
      rawBody = await readBodyWithLimit(request);
    } catch {
      return Response.json({ error: 'Request body is too large.' }, { status: 413 });
    }
  }
  const userAgent = request.headers.get('user-agent') || '';
  const event = {
    version: '2.0',
    routeKey: '$default',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: Object.fromEntries(request.headers.entries()),
    requestContext: {
      http: {
        method: request.method.toUpperCase(),
        path: url.pathname,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent,
      },
    },
    body: rawBody.length ? rawBody.toString('base64') : null,
    isBase64Encoded: rawBody.length > 0,
  };

  const result = await expressHandler(event, {});
  const headers = new Headers();

  for (const [name, value] of Object.entries(result.headers || {})) {
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(name, String(item)));
    } else if (value !== undefined && value !== null) {
      headers.set(name, String(value));
    }
  }

  for (const [name, values] of Object.entries(result.multiValueHeaders || {})) {
    for (const value of values || []) headers.append(name, String(value));
  }

  for (const cookie of result.cookies || []) headers.append('set-cookie', cookie);

  const status = result.statusCode || 200;
  let responseBody = result.body ?? null;
  if (result.isBase64Encoded && responseBody !== null) {
    responseBody = Buffer.from(responseBody, 'base64');
  }
  if ([204, 205, 304].includes(status)) responseBody = null;

  return new Response(responseBody, { status, headers });
}

export const GET = dispatch;
export const HEAD = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
export const OPTIONS = dispatch;
