(function attachAuthenticationFeature(global) {
  let sessionExpiryShown = false;
  let initialized = false;

  global.addEventListener('mission-support:session-expired', () => {
    if (sessionExpiryShown) return;
    sessionExpiryShown = true;
    showLoginScreen();
  });
function setupAuthListeners() {
  document.querySelectorAll('[data-theme-choice]').forEach((button) => {
    button.addEventListener('click', () => applyTheme(button.dataset.themeChoice));
  });
  applyTheme(document.documentElement.dataset.theme);
  const form = document.getElementById('login-form');
  if (form) form.addEventListener('submit', handleLogin);
  document.getElementById('btn-open-signup')?.addEventListener('click', () => openSignupModal(false));
  const togglePassword = document.getElementById('toggle-login-password');
  const loginPassword = document.getElementById('login-password');
  togglePassword?.addEventListener('click', () => {
    if (!loginPassword) return;
    const showing = loginPassword.type === 'text';
    loginPassword.type = showing ? 'password' : 'text';
    togglePassword.innerHTML = `<i class="fa-solid ${showing ? 'fa-eye' : 'fa-eye-slash'}"></i>`;
    togglePassword.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    togglePassword.setAttribute('title', showing ? 'Show password' : 'Hide password');
  });
  setupPasswordToggle('toggle-signup-password', 'signup-password');
  setupPasswordToggle('toggle-signup-confirm-password', 'signup-confirm-password');
  document.getElementById('modal-signup-close')?.addEventListener('click', closeSignupModal);
  document.getElementById('btn-signup-cancel')?.addEventListener('click', closeSignupModal);
  document.getElementById('signup-form')?.addEventListener('submit', handleSignup);
  document.getElementById('btn-pending-refresh')?.addEventListener('click', refreshMyAccount);
  const logout = document.getElementById('action-logout');
  if (logout) logout.addEventListener('click', async (e) => {
    e.preventDefault();
    await signOut();
  });
  const supporterLogout = document.getElementById('btn-supporter-logout');
  if (supporterLogout) supporterLogout.addEventListener('click', async () => {
    await signOut();
  });
}

function setupPasswordToggle(buttonId, inputId) {
  const button = document.getElementById(buttonId);
  const input = document.getElementById(inputId);
  if (!button || !input || button.dataset.bound === '1') return;
  button.dataset.bound = '1';
  button.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    button.innerHTML = `<i class="fa-solid ${showing ? 'fa-eye' : 'fa-eye-slash'}"></i>`;
    button.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    button.setAttribute('title', showing ? 'Show password' : 'Hide password');
  });
}

async function checkAuthSession() {
  try {
    const res = await apiRequest('/api/auth/me', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('not authenticated');
    const data = await res.json();
    if (!data.authenticated) throw new Error('not authenticated');
    enterAuthenticatedApp(data.user);
  } catch (err) {
    showLoginScreen();
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const username = form.username.value.trim();
  const password = form.password.value;
  const button = document.getElementById('btn-login');
  const error = document.getElementById('login-error');
  error.style.display = 'none';
  button.disabled = true;
  button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Signing in...';
  try {
    const res = await apiRequest('/api/auth/login', {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Invalid username or password.');
    form.reset();
    enterAuthenticatedApp(data.user);
  } catch (err) {
    error.textContent = err.message;
    error.style.display = 'block';
  } finally {
    button.disabled = false;
    button.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In';
  }
}

function showLoginScreen() {
  document.body.classList.add('auth-locked');
  const screen = document.getElementById('login-screen');
  if (screen) screen.style.display = 'flex';
}

function enterAuthenticatedApp(user) {
  sessionExpiryShown = false;
  window.MissionSupportState.currentUser = user;
  document.body.classList.remove('auth-locked');
  const screen = document.getElementById('login-screen');
  if (screen) screen.style.display = 'none';
  const name = document.getElementById('header-user-name');
  const role = document.getElementById('header-user-role');
  const badge = document.getElementById('header-user');
  if (name) name.textContent = user?.name || user?.username || 'User';
  if (role) role.textContent = String(user?.role || 'user').toUpperCase();
  if (badge) badge.style.display = 'flex';
  applyRoleUi();
  setupEventListeners();
  renderPendingChanges();
  if (user?.role === 'supporter' && user?.status !== 'active') {
    showSupporterPending(true);
  } else {
    showSupporterPending(false);
    loadQuartersList({ hydrateCache: true, resetView: true }).catch(err => console.error('Initial load failed:', err));
  }
}

function applyRoleUi() {
  const supporter = window.MissionSupportState.currentUser?.role === 'supporter';
  const staff = ['admin','staff'].includes(window.MissionSupportState.currentUser?.role);
  document.body.classList.toggle('supporter-mode', supporter);
  const management = document.getElementById('action-user-management');
  if (management) management.style.display = staff ? '' : 'none';
  const createUserBtn = document.getElementById('btn-create-user');
  if (createUserBtn) createUserBtn.style.display = window.MissionSupportState.currentUser?.role === 'admin' ? '' : 'none';
  ['action-add-quarter','action-audit-trail','action-hidden-pastors','action-notifications','btn-hidden-pastors'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = staff ? '' : 'none';
  });
  ['action-backup-json','action-reset-data'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = window.MissionSupportState.currentUser?.role === 'admin' ? '' : 'none';
  });
  const bell = document.getElementById('btn-notification-bell');
  if (bell) bell.style.display = staff ? '' : 'none';
  document.querySelector('.notification-tab[data-tab="settings"]')?.style.setProperty('display', window.MissionSupportState.currentUser?.role === 'admin' ? '' : 'none');
  const saveNotificationSettingsBtn = document.getElementById('btn-save-notification-settings');
  if (saveNotificationSettingsBtn) saveNotificationSettingsBtn.style.display = window.MissionSupportState.currentUser?.role === 'admin' ? '' : 'none';
  ['btn-add-pastor','btn-save-changes','btn-quick-save','btn-discard-changes','month-bulk-bar'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = supporter ? 'none' : '';
  });
  const report = document.getElementById('btn-report');
  if (report) report.style.display = supporter ? 'none' : '';
  const typeFilter = document.getElementById('pastor-type-filter');
  const status = document.getElementById('status-filter');
  const typeFilterGroup = typeFilter?.closest('.control-group');
  const statusFilterGroup = status?.closest('.control-group');
  const quarterControl = document.getElementById('quarter-select')?.closest('.control-group');
  const yearControl = document.getElementById('year-pills')?.closest('.control-group');
  const searchControl = document.getElementById('search-input')?.closest('.control-group');
  // Supporters may browse every year and quarter, but operational filters are
  // not useful to them. Hide the entire Pastor Type/Status controls, including labels.
  if (typeFilterGroup) typeFilterGroup.style.display = supporter ? 'none' : '';
  if (statusFilterGroup) statusFilterGroup.style.display = supporter ? 'none' : '';
  if (quarterControl) quarterControl.style.display = '';
  if (yearControl) yearControl.style.display = '';
  if (searchControl) searchControl.style.display = supporter ? 'none' : '';
  ['btn-present','btn-bulk-check-all','btn-bulk-clear-all','btn-exit-report','btn-add-pastor','btn-quick-save','btn-save-changes','btn-discard-changes','month-bulk-bar'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = supporter ? 'none' : '';
  });
  const toolbarTitle = document.getElementById('table-header-title');
  if (toolbarTitle && supporter) toolbarTitle.textContent = 'My Supported Pastors';
  // Supporters get a direct Sign Out button in the header. They do not need the three-dot menu.
  const moreOptions = document.getElementById('btn-more-options');
  if (moreOptions) moreOptions.style.display = supporter ? 'none' : '';
  const supporterLogout = document.getElementById('btn-supporter-logout');
  if (supporterLogout) supporterLogout.style.display = supporter ? 'inline-flex' : 'none';
  const supporterMenuIds = [
    'action-download-all','action-add-quarter','action-user-management',
    'action-audit-trail','action-hidden-pastors','action-notifications'
  ];
  supporterMenuIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = supporter ? 'none' : '';
  });
  const logoutAction = document.getElementById('action-logout');
  if (logoutAction) logoutAction.style.display = '';
  const menuDivider = document.querySelector('#dropdown-menu .divider');
  if (menuDivider) menuDivider.style.display = supporter ? 'none' : '';
}

function showSupporterPending(show) {
  const pending = document.getElementById('supporter-pending-screen');
  const main = document.querySelector('main.main-content');
  const header = document.querySelector('.app-header');
  if (pending) pending.style.display = show ? 'flex' : 'none';
  if (main) main.style.display = show ? 'none' : '';
  if (header) header.style.display = show ? 'flex' : '';
}

async function refreshMyAccount() {
  try {
    const res = await apiRequest('/api/auth/me', { credentials: 'same-origin' });
    const data = await res.json();
    if (data.authenticated) enterAuthenticatedApp(data.user);
  } catch (err) { console.error(err); }
}

async function signOut() {
  try { await apiRequest('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) {}
  window.MissionSupportState.currentUser = null;
  state.pendingChanges = {};
  const badge = document.getElementById('header-user');
  if (badge) badge.style.display = 'none';
  showLoginScreen();
}

  async function initializeAuth() {
    document.body.classList.add('auth-locked');
    if (!initialized) {
      setupAuthListeners();
      initialized = true;
    }
    await checkAuthSession();
  }

  global.MissionSupportFeatures = global.MissionSupportFeatures || {};
  global.MissionSupportFeatures.auth = Object.freeze({ initialize: initializeAuth });
})(window);
