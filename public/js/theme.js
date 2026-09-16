import { $ } from './state.js';

export const THEMES = ['auto', 'light', 'dark'];

export function getSystemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(mode) {
  const resolved = mode === 'auto' ? getSystemTheme() : mode;
  document.documentElement.setAttribute('data-theme', resolved);
  const btn = $('#theme-toggle');
  if (btn) {
    if (mode === 'auto') {
      btn.textContent = '🌓';
      btn.title = `主题：跟随系统 (${resolved === 'dark' ? '深色' : '浅色'})，点击切换为浅色模式`;
    } else if (mode === 'light') {
      btn.textContent = '☀️';
      btn.title = '主题：浅色模式，点击切换为深色模式';
    } else {
      btn.textContent = '🌙';
      btn.title = '主题：深色模式，点击切换为跟随系统';
    }
  }
}

export function setTheme(mode) {
  const valid = THEMES.includes(mode) ? mode : 'auto';
  localStorage.setItem('cmcc_theme', valid);
  applyTheme(valid);
}

export function toggleTheme() {
  const current = localStorage.getItem('cmcc_theme') || 'auto';
  const idx = THEMES.indexOf(current);
  const next = THEMES[(idx + 1) % THEMES.length];
  setTheme(next);
}

export function initTheme() {
  const saved = localStorage.getItem('cmcc_theme') || 'auto';
  applyTheme(saved);
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      const current = localStorage.getItem('cmcc_theme') || 'auto';
      if (current === 'auto') {
        applyTheme('auto');
      }
    });
  }
}
