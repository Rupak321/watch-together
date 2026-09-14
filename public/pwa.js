// Shared by every page: register the service worker that makes the site
// installable to a home screen and gives it an offline page. After load, so it
// never competes with the page itself for the connection.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
