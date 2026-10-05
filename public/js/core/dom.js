(function attachMissionSupportDom(global) {
  function escapeHtml(value) {
    if (!value) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    let icon = 'fa-info-circle';
    if (type === 'success') icon = 'fa-check-circle';
    if (type === 'error') icon = 'fa-exclamation-circle';

    toast.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i> <span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    global.setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      global.setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  Object.defineProperty(global, 'MissionSupportDom', {
    configurable: false,
    value: Object.freeze({ escapeHtml, showToast })
  });
})(window);
