'use strict';

/**
 * Внешний вид d3m3nk0: тема, акцент, шрифты, схема кода, размер текста,
 * ширина чата. Хранится в localStorage этого компьютера.
 *
 * Файл подключается в <head> ДО style.css-зависимой отрисовки: тема
 * применяется сразу, и светлая тема не мигает тёмным при запуске.
 */

(function () {
  const KEY = 'd3m3nk0.look';

  // Варианты для меню. value — то, что хранится; css — что попадает в стиль.
  const OPTIONS = {
    theme: [
      { value: 'system', label: 'Как в Windows' },
      { value: 'light', label: 'Светлая' },
      { value: 'dark', label: 'Тёмная' },
    ],
    accent: [
      { value: 'blue', label: 'Синий', dark: '#7aa2f7', light: '#3a6fd8' },
      { value: 'violet', label: 'Фиолетовый', dark: '#b392f0', light: '#7c4dcc' },
      { value: 'green', label: 'Зелёный', dark: '#6fcf97', light: '#1e8a4f' },
      { value: 'orange', label: 'Оранжевый', dark: '#f0a35e', light: '#c2620f' },
      { value: 'pink', label: 'Розовый', dark: '#f28fb5', light: '#c43c78' },
    ],
    fontUi: [
      { value: 'segoe', label: 'Segoe UI (как Windows)', css: '"Segoe UI", system-ui, sans-serif' },
      { value: 'calibri', label: 'Calibri', css: 'Calibri, "Segoe UI", sans-serif' },
      { value: 'verdana', label: 'Verdana — крупный и разборчивый', css: 'Verdana, "Segoe UI", sans-serif' },
      { value: 'georgia', label: 'Georgia — с засечками', css: 'Georgia, "Times New Roman", serif' },
    ],
    fontAnswer: [
      { value: 'ui', label: 'Как интерфейс', css: 'var(--font-ui)' },
      { value: 'georgia', label: 'Georgia — с засечками', css: 'Georgia, "Times New Roman", serif' },
      { value: 'cambria', label: 'Cambria — книжный', css: 'Cambria, Georgia, serif' },
      { value: 'verdana', label: 'Verdana — разборчивый', css: 'Verdana, "Segoe UI", sans-serif' },
    ],
    fontCode: [
      { value: 'cascadia', label: 'Cascadia Mono', css: '"Cascadia Mono", Consolas, monospace' },
      { value: 'consolas', label: 'Consolas', css: 'Consolas, "Cascadia Mono", monospace' },
      { value: 'courier', label: 'Courier New', css: '"Courier New", Courier, monospace' },
      { value: 'lucida', label: 'Lucida Console', css: '"Lucida Console", Consolas, monospace' },
    ],
    code: [
      { value: 'auto', label: 'Под тему окна' },
      { value: 'night', label: 'Ночная' },
      { value: 'paper', label: 'Бумага (светлая)' },
      { value: 'solar', label: 'Солнечная' },
      { value: 'forest', label: 'Лес' },
      { value: 'contrast', label: 'Высокий контраст' },
    ],
    fontSize: [
      { value: '13', label: 'Мелкий' },
      { value: '14', label: 'Обычный' },
      { value: '15.5', label: 'Крупный' },
      { value: '17', label: 'Очень крупный' },
    ],
    col: [
      { value: '720', label: 'Узкая' },
      { value: '820', label: 'Обычная' },
      { value: '1000', label: 'Широкая' },
      { value: '100%', label: 'Во всю ширину' },
    ],
  };

  const DEFAULTS = {
    theme: 'system',
    accent: 'blue',
    fontUi: 'segoe',
    fontAnswer: 'ui',
    fontCode: 'cascadia',
    code: 'auto',
    fontSize: '14',
    col: '820',
  };

  function load() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
    } catch {
      saved = {};
    }
    // Старые ключи прошлой версии (размер текста и ширина колонки).
    const oldFont = localStorage.getItem('d3m3nk0.fontSize');
    const oldCol = localStorage.getItem('d3m3nk0.chatColumn');
    if (oldFont && !saved.fontSize) saved.fontSize = oldFont;
    if (oldCol && !saved.col) saved.col = oldCol;
    const look = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (OPTIONS[k].some((o) => o.value === saved[k])) look[k] = saved[k];
    }
    return look;
  }

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const pick = (k, v) => OPTIONS[k].find((o) => o.value === v) || OPTIONS[k][0];

  /** Какая тема на самом деле: system → по Windows. */
  function effectiveTheme(look) {
    if (look.theme === 'system') return media.matches ? 'dark' : 'light';
    return look.theme;
  }

  function apply(look = load()) {
    const root = document.documentElement;
    const theme = effectiveTheme(look);
    root.dataset.theme = theme;
    if (look.code === 'auto') delete root.dataset.code;
    else root.dataset.code = look.code;
    const accent = pick('accent', look.accent);
    root.style.setProperty('--accent', theme === 'light' ? accent.light : accent.dark);
    root.style.setProperty('--font-ui', pick('fontUi', look.fontUi).css);
    root.style.setProperty('--font-answer', pick('fontAnswer', look.fontAnswer).css);
    root.style.setProperty('--font-code', pick('fontCode', look.fontCode).css);
    root.style.setProperty('--font-size', `${Number(look.fontSize) || 14}px`);
    root.style.setProperty('--col', look.col === '100%' ? '100%' : `${Number(look.col) || 820}px`);
    // Рамка окна и меню Windows — в тон теме (через главный процесс).
    window.d3?.setTheme?.(look.theme);
    return look;
  }

  function set(key, value) {
    const look = load();
    if (!OPTIONS[key]?.some((o) => o.value === value)) return look;
    look[key] = value;
    localStorage.setItem(KEY, JSON.stringify(look));
    return apply(look);
  }

  function reset() {
    localStorage.setItem(KEY, JSON.stringify(DEFAULTS));
    return apply({ ...DEFAULTS });
  }

  // Windows переключил день/ночь — тема «Как в Windows» следует за ним.
  media.addEventListener('change', () => {
    if (load().theme === 'system') apply();
  });

  window.Look = { OPTIONS, DEFAULTS, load, apply, set, reset, effectiveTheme };
  apply();
})();
