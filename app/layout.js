import Script from 'next/script';

export const metadata = {
  title: 'Mission Support Tracker & PPT Generator',
  description: 'Living Hope Baptist Church mission support tracker.',
  icons: {
    icon: '/images/logo.png',
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" data-theme="current">
      <head>
        <Script src="/js/core/api.js" strategy="beforeInteractive" />
        <Script src="/js/core/dom.js" strategy="beforeInteractive" />
        <Script src="/js/core/state.js" strategy="beforeInteractive" />
        <Script src="/js/core/cache.js" strategy="beforeInteractive" />
        <Script src="/js/features/auth.js" strategy="beforeInteractive" />
        <Script src="/js/features/reports.js" strategy="beforeInteractive" />
        <Script src="/js/features/notifications.js" strategy="beforeInteractive" />
        <Script id="living-hope-theme-init" strategy="beforeInteractive">
          {`try { document.documentElement.dataset.theme = localStorage.getItem('livingHopeTheme') === 'light' ? 'light' : 'current'; } catch (_) {}`}
        </Script>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="/css/style.css" />
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"
        />
      </head>
      <body className="purple-theme">{children}</body>
    </html>
  );
}
