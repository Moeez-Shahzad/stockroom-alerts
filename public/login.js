const form = document.getElementById('login-form');
const status = document.getElementById('form-status');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true; status.textContent = ''; status.className = '';
  try {
    const response = await fetch('/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('password').value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Sign in failed.');
    location.assign('/admin');
  } catch (error) { status.textContent = error.message; status.className = 'notice error'; button.disabled = false; }
});
