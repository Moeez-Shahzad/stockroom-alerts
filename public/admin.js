const $ = id => document.getElementById(id);
let page = 1, total = 0, searchTimer;
function humanTime(t) {
  if (!t) return '—';
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function appendCell(row, text, cls = '') { const td = document.createElement('td'); td.textContent = text; td.className = cls; row.append(td); return td; }
function makeTag(status) { const tag = document.createElement('span'); tag.className = `badge ${status}`; tag.textContent = status === 'open' ? 'Watching' : status === 'queued' ? 'Queued' : 'Notified'; return tag; }
async function load() {
  const params = new URLSearchParams({ status: $('status-filter').value, q: $('search').value, page });
  try {
    const response = await fetch('/api/admin/overview?' + params);
    if (response.status === 401) { location.assign('/admin/login'); return; }
    if (!response.ok) throw new Error('Failed to load requests');
    const data = await response.json();
    for (const k of ['total', 'open', 'notified', 'queued', 'failed']) $(`count-${k}`).textContent = data.counts[k] || 0;
    total = data.total;
    $('result-count').textContent = `${total} requests`;
    $('pagination-label').textContent = total ? `Showing ${(page-1)*50+1}–${Math.min(total,page*50)} of ${total}` : 'No requests yet';
    $('current-page').textContent = String(page);
    $('prev-page').disabled = page === 1;
    $('next-page').disabled = page * 50 >= total;
    const body = $('requests-body'); body.replaceChildren();
    if (!data.rows.length) { const r = document.createElement('tr'); appendCell(r, 'No matching alerts. They will appear here as customers subscribe.', 'table-empty').colSpan = 6; body.append(r); }
    for (const item of data.rows) {
      const tr = document.createElement('tr');
      appendCell(tr, item.email, 'customer');
      appendCell(tr, item.sku, 'sku-cell');
      const statusCell = document.createElement('td'); statusCell.append(makeTag(item.status)); tr.append(statusCell);
      appendCell(tr, humanTime(item.created_at));
      appendCell(tr, humanTime(item.notified_at));
      const delivery = document.createElement('td');
      if (item.email_status === 'failed') {
        const error = document.createElement('div'); error.className = 'error-small'; error.textContent = 'Failed'; error.title = item.last_error || 'Email failed';
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'retry-button'; retry.textContent = 'Retry';
        retry.addEventListener('click', async () => { retry.disabled = true; await fetch(`/api/admin/retry/${item.job_id}`, { method: 'POST' }); load(); });
        delivery.append(error, retry);
      } else delivery.textContent = item.email_status === 'sent' ? '✓ Delivered' : item.email_status === 'sending' ? 'Sending…' : item.email_status === 'pending' ? 'Pending' : '—';
      tr.append(delivery); body.append(tr);
    }
    const activity = $('activity'); activity.replaceChildren();
    if (!data.activity.length) { const empty = document.createElement('div'); empty.className = 'activity-empty'; empty.textContent = 'Waiting for the first webhook…'; activity.append(empty); }
    for (const evt of data.activity) {
      const row = document.createElement('div'); row.className = 'activity-row';
      const dot = document.createElement('span'); dot.className = 'activity-dot ' + (evt.status === 'done' ? 'done' : '');
      const content = document.createElement('div'); content.className = 'activity-text';
      const name = document.createElement('strong'); name.textContent = `${evt.sku} · ${evt.status === 'done' ? 'Verified' : 'Checking stock'}`;
      const detail = document.createElement('small'); detail.textContent = evt.last_error ? 'Retrying: ' + evt.last_error : 'Stock webhook received';
      content.append(name, detail);
      const time = document.createElement('span'); time.className = 'activity-time'; time.textContent = humanTime(evt.received_at);
      row.append(dot,content,time); activity.append(row);
    }
  } catch (error) { console.warn('Dashboard refresh error:', error.message); }
}
$('status-filter').addEventListener('change', () => { page = 1; load(); });
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { page = 1; load(); }, 280); });
$('prev-page').addEventListener('click', () => { page = Math.max(1, page - 1); load(); });
$('next-page').addEventListener('click', () => { if (page * 50 < total) { page++; load(); } });
$('logout').addEventListener('click', async () => { await fetch('/admin/logout', { method: 'POST' }); location.assign('/admin/login'); });
load(); setInterval(load, 4000);
