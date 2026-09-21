import { $ } from './state.js';

let confirmResolve = null;
let promptResolve = null;
let alertResolve = null;

export function showConfirm({
  title = '确认操作',
  message = '',
  eyebrow = '确认操作',
  confirmText = '确定',
  cancelText = '取消',
  isDanger = true
} = {}) {
  return new Promise(resolve => {
    confirmResolve = resolve;
    const dialog = $('#confirm-dialog');
    if (!dialog) {
      resolve(false);
      return;
    }
    const eyebrowEl = $('#confirm-dialog-eyebrow') || dialog.querySelector('.eyebrow');
    const titleEl = $('#confirm-dialog-title');
    const messageEl = $('#confirm-dialog-message');
    const approveBtn = $('#approve-confirm');
    const cancelBtn = $('#cancel-confirm');

    if (eyebrowEl) eyebrowEl.textContent = eyebrow;
    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;
    if (approveBtn) {
      approveBtn.textContent = confirmText;
      approveBtn.className = isDanger ? 'button danger compact' : 'button primary compact';
    }
    if (cancelBtn) cancelBtn.textContent = cancelText;

    dialog.showModal();
  });
}

export function showPrompt({
  title = '请输入',
  message = '',
  eyebrow = '安全设置',
  placeholder = '',
  defaultValue = '',
  confirmText = '确定',
  cancelText = '取消',
  isDanger = false,
  validator = null
} = {}) {
  return new Promise(resolve => {
    promptResolve = resolve;
    const dialog = $('#prompt-dialog');
    if (!dialog) {
      resolve(null);
      return;
    }
    const eyebrowEl = $('#prompt-dialog-eyebrow');
    const titleEl = $('#prompt-dialog-title');
    const messageEl = $('#prompt-dialog-message');
    const inputEl = $('#prompt-dialog-input');
    const errorEl = $('#prompt-dialog-error');
    const approveBtn = $('#approve-prompt');
    const cancelBtn = $('#cancel-prompt');

    if (eyebrowEl) eyebrowEl.textContent = eyebrow;
    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;
    if (errorEl) errorEl.textContent = '';
    if (inputEl) {
      inputEl.placeholder = placeholder;
      inputEl.value = defaultValue;
    }
    if (approveBtn) {
      approveBtn.textContent = confirmText;
      approveBtn.className = isDanger ? 'button danger compact' : 'button primary compact';
    }
    if (cancelBtn) cancelBtn.textContent = cancelText;

    dialog._validator = validator;
    dialog.showModal();
    setTimeout(() => inputEl?.focus(), 60);
  });
}

export function showAlert({
  title = '提示',
  message = '',
  eyebrow = '系统提示',
  buttonText = '我知道了',
  isError = false
} = {}) {
  return new Promise(resolve => {
    alertResolve = resolve;
    const dialog = $('#alert-dialog');
    if (!dialog) {
      resolve();
      return;
    }
    const eyebrowEl = $('#alert-dialog-eyebrow');
    const titleEl = $('#alert-dialog-title');
    const messageEl = $('#alert-dialog-message');
    const btn = $('#close-alert');

    if (eyebrowEl) {
      eyebrowEl.textContent = eyebrow;
      eyebrowEl.style.color = isError ? 'var(--red)' : 'var(--teal)';
    }
    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;
    if (btn) btn.textContent = buttonText;

    dialog.showModal();
  });
}

export function initModalListeners() {
  // Confirm Dialog 事件响应
  const confirmDialog = $('#confirm-dialog');
  if (confirmDialog && !confirmDialog.dataset.bound) {
    confirmDialog.dataset.bound = 'true';
    $('#cancel-confirm')?.addEventListener('click', () => confirmDialog.close());
    $('#approve-confirm')?.addEventListener('click', () => {
      confirmDialog.close();
      if (confirmResolve) {
        const r = confirmResolve;
        confirmResolve = null;
        r(true);
      }
    });
    confirmDialog.addEventListener('close', () => {
      if (confirmResolve) {
        const r = confirmResolve;
        confirmResolve = null;
        r(false);
      }
    });
  }

  // Prompt Dialog 事件响应
  const promptDialog = $('#prompt-dialog');
  if (promptDialog && !promptDialog.dataset.bound) {
    promptDialog.dataset.bound = 'true';
    $('#cancel-prompt')?.addEventListener('click', () => promptDialog.close());
    $('#prompt-dialog-form')?.addEventListener('submit', e => {
      e.preventDefault();
      const inputEl = $('#prompt-dialog-input');
      const errorEl = $('#prompt-dialog-error');
      const val = inputEl ? inputEl.value.trim() : '';
      if (promptDialog._validator) {
        const err = promptDialog._validator(val);
        if (err) {
          if (errorEl) errorEl.textContent = err;
          inputEl?.focus();
          return;
        }
      }
      promptDialog.close();
      if (promptResolve) {
        const r = promptResolve;
        promptResolve = null;
        r(val);
      }
    });
    promptDialog.addEventListener('close', () => {
      if (promptResolve) {
        const r = promptResolve;
        promptResolve = null;
        r(null);
      }
    });
  }

  // Alert Dialog 事件响应
  const alertDialog = $('#alert-dialog');
  if (alertDialog && !alertDialog.dataset.bound) {
    alertDialog.dataset.bound = 'true';
    $('#close-alert')?.addEventListener('click', () => alertDialog.close());
    alertDialog.addEventListener('close', () => {
      if (alertResolve) {
        const r = alertResolve;
        alertResolve = null;
        r();
      }
    });
  }
}
