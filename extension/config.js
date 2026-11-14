// Dropomat – konfiguracja wydania.
// Adres pliku version.json na stronie projektu (GitHub Pages). Rozszerzenie zagląda tam co 12 godzin
// i pokazuje baner, gdy jest nowsza wersja. Pusty adres = sprawdzanie wyłączone.
// Przykład: 'https://TWOJ-LOGIN.github.io/dropomat/version.json'
const DROPOMAT_UPDATE_URL = 'https://yasaiek.github.io/Dropomat-Auto-Twitch-Drops/version.json';

// Anonimowy licznik „farmi teraz” (pokazywany na stronie projektu). Gdy rozszerzenie działa, co 10 minut dolicza +1
// do publicznego licznika bieżącego okna pod tym adresem – nic o użytkowniku nie jest wysyłane, a w Ustawieniach
// można to wyłączyć. Pusty adres = licznik wyłączony.
const DROPOMAT_STATS_URL = 'https://abacus.jasoncameron.dev/hit/dropomat-yasaiek/';
