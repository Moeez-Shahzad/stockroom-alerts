const $ = id => document.getElementById(id);
const form = $('subscribe-form');
const status = $('form-status');
const skuInput = $('sku');
const emailInput = $('email');
const submit = $('submit-button');
const fromUrl = new URLSearchParams(location.search).get('sku');
if (fromUrl) skuInput.value = fromUrl;
function message(text, type) { status.textContent = text; status.className = `notice ${type}`; }
form.addEventListener('submit', async event => {
  event.preventDefault();
  status.textContent = ''; status.className = '';
  const sku = skuInput.value.trim().toUpperCase();
  const email = emailInput.value.trim();
  if (!sku || !/^[A-Z0-9][A-Z0-9_-]{0,79}$/.test(sku) || !emailInput.checkValidity()) {
    message('Please enter a valid email address and product SKU.', 'error'); return;
  }
  submit.disabled = true;
  try {
    const response = await fetch('/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, sku }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Something went wrong.');
    message(result.message, 'success');
    if (!result.duplicate) form.reset();
  } catch (error) { message(error.message || 'Please try again.', 'error'); }
  finally { submit.disabled = false; }
});
$('browse-button').addEventListener('click', async () => {
  const panel = $('catalogue');
  panel.hidden = !panel.hidden;
  if (panel.hidden || panel.dataset.loaded) return;
  const list = $('catalogue-items');
  try {
    const response = await fetch('/api/catalogue');
    if (!response.ok) throw new Error('Could not load products.');
    const data = await response.json();
    const products = data.products || [];
    list.replaceChildren();
    if (!products.length) { list.textContent = 'No products available. Enter an SKU manually.'; return; }
    products.sort((a, b) => (a.quantity > 0) - (b.quantity > 0));
    for (const product of products) {
      const item = document.createElement('button');
      item.className = 'catalogue-item'; item.type = 'button';
      const info = document.createElement('span');
      const label = document.createElement('strong'); label.textContent = product.name;
      const code = document.createElement('small'); code.textContent = product.sku;
      info.append(label, code);
      const availability = document.createElement('span');
      availability.className = 'availability' + (product.quantity <= 0 ? ' sold' : '');
      availability.textContent = product.quantity <= 0 ? 'SOLD OUT' : 'IN STOCK';
      item.append(info, availability);
      item.addEventListener('click', () => { skuInput.value = product.sku; panel.hidden = true; skuInput.focus(); });
      list.append(item);
    }
    panel.dataset.loaded = 'true';
  } catch { list.textContent = 'Catalogue unavailable. You can still enter an SKU manually.'; }
});
$('close-catalogue').addEventListener('click', () => { $('catalogue').hidden = true; });
