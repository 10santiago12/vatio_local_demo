'use strict';
try {
  const theme = localStorage.getItem('vatio_theme');
  if (theme === 'light') document.documentElement.dataset.theme = theme;
} catch { /* Dark theme remains available without storage. */ }
