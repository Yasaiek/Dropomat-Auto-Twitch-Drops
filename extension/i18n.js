// Dropomat – tłumaczenia: rdzeń (wspólny dla tła i okienka). Słowniki są w locales/*.js.
'use strict';
const LOCALES = {};
const LANGS = [{"code": "en", "name": "English", "locale": "en-GB"}, {"code": "pl", "name": "Polski", "locale": "pl-PL"}, {"code": "de", "name": "Deutsch", "locale": "de-DE"}, {"code": "fr", "name": "Français", "locale": "fr-FR"}, {"code": "es", "name": "Español", "locale": "es-ES"}, {"code": "pt", "name": "Português (BR)", "locale": "pt-BR"}, {"code": "it", "name": "Italiano", "locale": "it-IT"}, {"code": "ru", "name": "Русский", "locale": "ru-RU"}, {"code": "uk", "name": "Українська", "locale": "uk-UA"}, {"code": "tr", "name": "Türkçe", "locale": "tr-TR"}, {"code": "zh", "name": "简体中文", "locale": "zh-CN"}, {"code": "ja", "name": "日本語", "locale": "ja-JP"}];
const FLAGS = {"en": "<rect width=\"30\" height=\"20\" fill=\"#012169\"/><path d=\"M0,0 30,20M30,0 0,20\" stroke=\"#fff\" stroke-width=\"4\"/><path d=\"M0,0 30,20M30,0 0,20\" stroke=\"#C8102E\" stroke-width=\"1.5\"/><path d=\"M15,0v20M0,10h30\" stroke=\"#fff\" stroke-width=\"6.6\"/><path d=\"M15,0v20M0,10h30\" stroke=\"#C8102E\" stroke-width=\"4\"/>", "pl": "<rect width=\"30\" height=\"10\" fill=\"#fff\"/><rect y=\"10\" width=\"30\" height=\"10\" fill=\"#DC143C\"/>", "de": "<rect width=\"30\" height=\"6.67\" fill=\"#000\"/><rect y=\"6.67\" width=\"30\" height=\"6.67\" fill=\"#DD0000\"/><rect y=\"13.33\" width=\"30\" height=\"6.67\" fill=\"#FFCE00\"/>", "fr": "<rect width=\"10\" height=\"20\" fill=\"#0055A4\"/><rect x=\"10\" width=\"10\" height=\"20\" fill=\"#fff\"/><rect x=\"20\" width=\"10\" height=\"20\" fill=\"#EF4135\"/>", "es": "<rect width=\"30\" height=\"20\" fill=\"#AA151B\"/><rect y=\"5\" width=\"30\" height=\"10\" fill=\"#F1BF00\"/>", "pt": "<rect width=\"30\" height=\"20\" fill=\"#009C3B\"/><polygon points=\"15,2.6 27,10 15,17.4 3,10\" fill=\"#FFDF00\"/><circle cx=\"15\" cy=\"10\" r=\"4.3\" fill=\"#002776\"/>", "it": "<rect width=\"10\" height=\"20\" fill=\"#009246\"/><rect x=\"10\" width=\"10\" height=\"20\" fill=\"#fff\"/><rect x=\"20\" width=\"10\" height=\"20\" fill=\"#CE2B37\"/>", "ru": "<rect width=\"30\" height=\"6.67\" fill=\"#fff\"/><rect y=\"6.67\" width=\"30\" height=\"6.67\" fill=\"#0039A6\"/><rect y=\"13.33\" width=\"30\" height=\"6.67\" fill=\"#D52B1E\"/>", "uk": "<rect width=\"30\" height=\"10\" fill=\"#0057B7\"/><rect y=\"10\" width=\"30\" height=\"10\" fill=\"#FFD700\"/>", "tr": "<rect width=\"30\" height=\"20\" fill=\"#E30A17\"/><circle cx=\"11\" cy=\"10\" r=\"5\" fill=\"#fff\"/><circle cx=\"12.3\" cy=\"10\" r=\"4\" fill=\"#E30A17\"/><polygon points=\"19.68,9.26 18.27,10.28 18.81,11.94 17.40,10.92 15.99,11.94 16.53,10.28 15.12,9.26 16.86,9.26 17.40,7.60 17.94,9.26\" fill=\"#fff\"/>", "zh": "<rect width=\"30\" height=\"20\" fill=\"#DE2910\"/><polygon points=\"5.00,2.00 5.67,4.07 7.85,4.07 6.09,5.35 6.76,7.43 5.00,6.15 3.24,7.43 3.91,5.35 2.15,4.07 4.33,4.07\" fill=\"#FFDE00\"/><polygon points=\"10.00,1.00 10.22,1.69 10.95,1.69 10.36,2.12 10.59,2.81 10.00,2.38 9.41,2.81 9.64,2.12 9.05,1.69 9.78,1.69\" fill=\"#FFDE00\"/><polygon points=\"12.00,3.00 12.22,3.69 12.95,3.69 12.36,4.12 12.59,4.81 12.00,4.38 11.41,4.81 11.64,4.12 11.05,3.69 11.78,3.69\" fill=\"#FFDE00\"/><polygon points=\"12.00,6.00 12.22,6.69 12.95,6.69 12.36,7.12 12.59,7.81 12.00,7.38 11.41,7.81 11.64,7.12 11.05,6.69 11.78,6.69\" fill=\"#FFDE00\"/><polygon points=\"10.00,8.00 10.22,8.69 10.95,8.69 10.36,9.12 10.59,9.81 10.00,9.38 9.41,9.81 9.64,9.12 9.05,8.69 9.78,8.69\" fill=\"#FFDE00\"/>", "ja": "<rect width=\"30\" height=\"20\" fill=\"#fff\"/><circle cx=\"15\" cy=\"10\" r=\"6\" fill=\"#BC002D\"/>"};
function flagSvg(code) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20" width="21" height="14">' + (FLAGS[code] || '') + '</svg>';
}
// 'auto' → język przeglądarki, jeśli go mamy; inaczej angielski.
function resolveLang(pref) {
  if (pref && pref !== 'auto' && LOCALES[pref]) return pref;
  let ui = '';
  try { ui = (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || ''; } catch (e) {}
  if (!ui) { try { ui = navigator.language || ''; } catch (e) {} }
  const two = String(ui).toLowerCase().slice(0, 2);
  return LOCALES[two] ? two : 'en';
}
function langLocale(code) {
  const l = LANGS.find((x) => x.code === code);
  return l ? l.locale : 'en-GB';
}
function tr(lang, key, vars) {
  let s = (LOCALES[lang] && LOCALES[lang][key]);
  if (s == null) s = LOCALES.en && LOCALES.en[key];
  if (s == null) return key;
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, k) => {
      const v = vars[k];
      if (v == null) return m;
      // wartość zaczynająca się od @ to klucz do przetłumaczenia (np. powód zmiany streama)
      return typeof v === 'string' && v.charAt(0) === '@' ? tr(lang, v.slice(1)) : String(v);
    });
  }
  return s;
}
