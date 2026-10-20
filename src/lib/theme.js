/** Light / dark appearance, remembered per device. app.html applies it before first paint. */
export const THEME_STORAGE_KEY = 'docuflex-theme';

/** @returns {'light' | 'dark'} */
export function currentTheme() {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** @param {'light' | 'dark'} theme */
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {}
}
