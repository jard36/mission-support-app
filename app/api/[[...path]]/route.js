import serverless from 'serverless-http';
import expressApp from '../../../server.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const expressHandler = serverless(expressApp, {
  binary: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
});

async function dispatch(request) {
  const url = new URL(request.url);
  const hasBody = !['GET', 'HEAD'].includes(request.method.toUpperCase());
  const rawBody = hasBody ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0);
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
