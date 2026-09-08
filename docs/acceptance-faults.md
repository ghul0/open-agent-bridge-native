# LOCAL_3 — niezależna weryfikacja fault acceptance

Data: 2026-09-08. Wszystkie fixture używały izolowanych katalogów tymczasowych; nie otwierano ani nie modyfikowano bazy użytkownika, jego sesji ani usług systemd.

## Wykonane dowody

- `pnpm exec vitest run src/native/managed-processes.test.ts src/registry/native-acceptance.test.ts` — PASS, 2 pliki / 10 testów, 57.79 s.
  - realne `SQLITE_FULL`: osobne SQLite, `max_page_count` ustawione na bieżący `page_count`, kontrolny duży INSERT najpierw zwraca `database or disk is full`; zapis brokera następnie również musi jawnie zawieść, a wcześniejsza wiadomość pozostaje dostępna;
  - realne permissions readonly (`0400` pliku i `0500` katalogu): ponowne otwarcie odmawia zapisu i nie zastępuje ledgeru;
  - usunięta baza przy zachowanym markerze `.initialized`: restart odmawia startu i nie tworzy pustej bazy;
  - `ManagedProcesses`: test jednostkowy obejmuje SIGINT/SIGTERM/SIGHUP oraz TERM→KILL; dodatkowy izolowany parent i dwa rzeczywiste procesy Node potwierdzają, że SIGTERM kończy rzeczywisty owned child, podczas gdy rzeczywisty foreign child zachowuje PID i pozostaje żywy do jawnego cleanup fixture;
  - setup/reinstall/rollback na rzeczywistym izolowanym `home`: skopiowany build release, zachowany hostId, idempotentny reinstall, rollback usuwa własny release i zachowuje obco zmodyfikowany launcher.
- `pnpm exec vitest run src/registry/native-core.test.ts` — PASS, 1 plik / 19 testów, 9.40 s.
  - routing WS dwóch logicznych hostów bez broadcastu; reconnect/restart; disconnect podczas delivery przechodzi w `delivery_unknown` bez replay;
  - ACK z niewłaściwego połączenia jest odrzucony i nie zmienia stanu; późny/konfliktowy ACK także nie daje fałszywej akceptacji;
  - backup z aktywnym WAL przechodzi `PRAGMA integrity_check = ok`, odtwarza wiadomości, endpointy, ACK, marker i idempotencję.
- `pnpm run build` — PASS (`tsc` i kompletowanie dist).

## Minimalne pozostałe luki

- Uzupełnienie integratora: rzeczywisty test SIGTERM kompletnego launchera Codexa z App Server/TUI przeszedł — wszystkie 9 procesów jego drzewa wyszło, a sąsiednia sesja Codexa pozostała żywa. Dowód `acceptance-final/20260908local3d/real-codex-lifecycle.json`. Nie jest to gwarancja cleanup po SIGKILL launchera, którego proces nie może obsłużyć.
- Nie symulowano fizycznej awarii urządzenia blokowego ani corruption bit-level; użyto rzeczywistego mechanizmu page exhaustion SQLite i rzeczywistych praw filesystemu.
- Test setup używa aktualnego build drzewa projektu jako source release, nie mutuje zainstalowanego release użytkownika `0.1.0-6f5f41a`.
