import { escapeHtml } from './utils.js';

async function fetchJson(url, options, label) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  let body;
  try { body = await response.json(); }
  catch { throw new Error(`${label}: invalid JSON (HTTP ${response.status})`); }
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  return body;
}
export async function fetchStock(sku, config) {
  const data = await fetchJson(`${config.STOCK_API_URL.replace(/\/$/, '')}/${encodeURIComponent(sku)}`, {
    headers: { Authorization: `Bearer ${config.STOCK_API_KEY}`, Accept: 'application/json' }
  }, 'Stock API');
  const product = data?.product && typeof data.product === 'object' ? data.product : data;
  const quantity = Number(product?.quantity ?? data?.quantity);
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error('Stock API: quantity is missing or invalid');
  const title = [data?.name, data?.title, data?.product_name, product?.name, product?.title]
    .find(x => typeof x === 'string' && x.trim());
  return {
    quantity,
    inStock: quantity > 0 && data?.in_stock !== false && product?.in_stock !== false,
    title: title?.trim() ?? sku
  };
}
export async function fetchCatalogue(config) {
  const data = await fetchJson(config.STOCK_API_URL, {
    headers: { Authorization: `Bearer ${config.STOCK_API_KEY}`, Accept: 'application/json' }
  }, 'Catalogue');
  const items = Array.isArray(data) ? data : Array.isArray(data?.products) ? data.products : Array.isArray(data?.items) ? data.items : Array.isArray(data?.catalogue) ? data.catalogue : [];
  return items.slice(0, 120).filter(x => x && typeof x.sku === 'string').map(x => ({
    sku: x.sku,
    name: String(x.name ?? x.title ?? x.product ?? x.sku),
    quantity: Number(x.quantity ?? x.stock ?? 0),
    price: typeof x.price === 'number' || typeof x.price === 'string' ? x.price : null
  }));
}
export function renderRestockEmail({ email, sku }, title) {
  const name = escapeHtml(title);
  const code = escapeHtml(sku);
  const recipient = escapeHtml(email);
  const subject = `${title} is back in stock`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head><body style="margin:0;padding:0;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#172239">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f5f6f8"><tr><td align="center" style="padding:36px 14px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:580px;background:#fff;border:1px solid #e7eaf0;border-radius:20px;overflow:hidden">
        <tr><td style="padding:28px 34px;border-bottom:1px solid #edf0f3"><span style="font-size:18px;font-weight:800;letter-spacing:-.7px;color:#192b44">◈ &nbsp;STOCKROOM</span><span style="float:right;font-size:12px;color:#8995a8;padding-top:4px">RESTOCK ALERT</span></td></tr>
        <tr><td style="padding:38px 34px 10px"><div style="display:inline-block;background:#e6f5ef;color:#087d55;padding:8px 13px;border-radius:40px;font-size:11px;letter-spacing:1.2px;font-weight:800">● GOOD NEWS — IT'S BACK</div>
         <h1 style="font-size:36px;letter-spacing:-1.2px;line-height:1.12;margin:24px 0 14px;color:#192b44">Your wait is over.</h1>
         <p style="font-size:16px;color:#66758a;line-height:1.7;margin:0 0 28px">An item you asked us to watch is available again. Popular pieces can sell out quickly, so now is a great time to check.</p>
         <table role="presentation" width="100%" style="border:1px solid #e5eaf1;background:#f9fbfd;border-radius:14px"><tr><td style="padding:24px"><div style="font-size:11px;color:#8896aa;letter-spacing:1.3px;font-weight:700;margin-bottom:10px">BACK IN STOCK</div>
           <div style="font-size:20px;color:#172239;font-weight:800;line-height:1.4">${name}</div><div style="font-size:13px;color:#8d99ab;margin-top:12px">SKU &nbsp; ${code}</div></td></tr></table>
         <p style="font-size:14px;line-height:1.75;color:#68788c;margin:28px 0 4px">Return to the store where you discovered this item to see current availability and complete your order.</p></td></tr>
         <tr><td style="padding:32px 34px;border-top:1px solid #edf0f3;margin-top:22px"><div style="font-size:12px;color:#8290a4;line-height:1.7">Sent to ${recipient} because you signed up for this stock alert.<br>You won't receive another notification for this request.</div><div style="font-size:12px;color:#b2bdcb;margin-top:22px">STOCKROOM · THE THINGS YOU LOVE, BACK AGAIN.</div></td></tr>
      </table></td></tr></table></body></html>`;
  return { subject, html };
}
export async function sendEmail(job, config) {
  let response;
  try {
    response = await fetch(`${config.RESEND_BASE_URL.replace(/\/$/, '')}/emails`, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        'Idempotency-Key': job.idempotency_key
      },
      body: JSON.stringify({
        from: 'Stockroom <alerts@stockroom.store>',
        to: [job.email],
        subject: job.subject,
        html: job.html
      })
    });
  } catch (error) { throw new Error(`Email delivery network error: ${error.message}`); }
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* Non-JSON success is allowed */ }
  if (!response.ok) {
    const error = new Error(`Email API HTTP ${response.status}: ${String(data?.message ?? text).slice(0, 150)}`);
    error.permanent = response.status >= 400 && response.status < 500 && ![408, 409, 425, 429].includes(response.status);
    throw error;
  }
  return data?.id ?? data?.email_id ?? null;
}
