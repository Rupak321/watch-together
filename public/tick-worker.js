/**
 * Drives the sync loop from a worker thread.
 *
 * A background tab throttles setInterval to roughly once a second, which is
 * the same order as the error we are trying to correct — drift correction
 * would quietly stop working the moment someone switched tabs. Worker timers
 * are not throttled that way.
 */

let timer = null;

self.onmessage = (e) => {
  const { cmd, intervalMs } = e.data || {};

  if (cmd === 'start') {
    if (timer !== null) clearInterval(timer);
    timer = setInterval(() => self.postMessage('tick'), intervalMs || 250);
  }

  if (cmd === 'stop' && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
};
