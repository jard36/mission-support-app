import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Script from 'next/script';

export const dynamic = 'force-static';

async function getLegacyMarkup() {
  const filePath = path.join(process.cwd(), 'public', 'index.html');
  const document = await readFile(filePath, 'utf8');
  const body = document.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];

  if (!body) {
    throw new Error('Could not load the existing Living Hope application markup.');
  }

  return body.replace(
    /<script\b(?=[^>]*\bsrc=["'](?:\/)?js\/app\.js["'])[^>]*>[\s\S]*?<\/script>/i,
    ''
  );
}

export default async function HomePage() {
  const markup = await getLegacyMarkup();

  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: markup }} />
      <Script src="/js/app.js" strategy="afterInteractive" />
    </>
  );
}
