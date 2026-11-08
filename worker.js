import { claimEvent, finishEvent, retryEvent, claimEmail, finishEmail, retryEmail } from './store.js';
import { fetchStock, sendEmail, renderRestockEmail } from './provider.js';

export function startWorker(config) {
  let active = true;
  let busy = false;
  let soonTimer;
  async function tick() {
    if (!active || busy) return;
    busy = true;
    try {
      // Event processing verifies truth at the STOCK API; webhook quantity is NEVER trusted.
      for (let i = 0; i < 8; i++) {
        const event = claimEvent();
        if (!event) break;
        try {
          const stock = await fetchStock(event.sku, config);
          const created = finishEvent(event.event_id, event.sku, stock.inStock,
            request => renderRestockEmail(request, stock.title));
          if (created) console.info(`[worker] queued ${created} emails for ${event.sku}`);
        } catch (error) {
          console.warn(`[worker] stock check failed (${event.sku}): ${error.message}`);
          retryEvent(event.event_id, error.message, event.attempts);
        }
      }
      // Sequential sends stay well under the provider's typical rate limit.
      for (let i = 0; i < 8; i++) {
        const job = claimEmail();
        if (!job) break;
        try {
          const id = await sendEmail(job, config);
          finishEmail(job.id, job.request_id, id);
          console.info(`[worker] email delivered for ${job.sku}`);
        } catch (error) {
          console.warn(`[worker] email failed (${job.sku}): ${error.message}`);
          retryEmail(job.id, error.message, job.attempts, Boolean(error.permanent));
        }
      }
    } catch (error) {
      console.error('[worker] unexpected processing error:', error);
    } finally { busy = false; }
  }
  const interval = setInterval(tick, 1000);
  interval.unref();
  const wake = () => {
    clearTimeout(soonTimer);
    soonTimer = setTimeout(tick, 25);
    soonTimer.unref();
  };
  wake();
  return { wake, stop: () => { active = false; clearInterval(interval); clearTimeout(soonTimer); } };
}
