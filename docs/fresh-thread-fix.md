# Poprawka świeżego wątku bez rolloutu

2026-09-08. Przyczyna: adapter wymagał thread/resume przed publikacją endpointu. Prawdziwy świeży TUI ma już loaded thread i thread/read(includeTurns:false), lecz niekoniecznie trwały rollout. Resume zwraca wtedy no rollout found. Błąd zatrzymywał całą synchronizację rosteru.

## Naprawa

- Discovery: loaded/list → read(false) → endpoint. Subskrypcja resume jest oddzielna; wyłącznie dokładny błąd braku rolloutu dla tego ID jest tolerowany. Retry następuje po rzeczywistej pierwszej turze, bez syntetycznej inicjalizacji.
- Błąd jednego wątku nie pomija zdrowych sąsiadów; uszkodzony znany endpoint oznaczany jest jako error.
- Idle delivery nie żąda historii: read(false) i prawdziwy turn/start. Historię aktywnego turnu pobieramy tylko dla active/steer.
- Bezimienny alias prezentacyjny nie generuje powiadomienia identity, które wcześniej uruchamiało model i zmieniało automatyczny tytuł. Tożsamość jest w metadanych pierwszej rzeczywistej wiadomości.
- Doctor porównuje wszystkie loaded thread IDs z osiągalnymi endpointami NAB. Inny działający Codex nie ukrywa braku świeżego wątku.

## Dowody

Unit regresje: świeży name:null, read(true) niedostępny, resume no rollout, pierwsze delivery, zdrowy sąsiad, brak identity turnu dla fallback i missing-thread health. Pełne build/test/lint wykonane.

Live: własny vanilla Codex na tej samej centralnej usłudze, bez operator prompt i bez ręcznej nazwy. Native ListAgents pokazało alias świeżej sesji. Pierwszy input w exact thread to wiadomość peera TEST NAB_FRESH_FIRST_MESSAGE wysłana prawdziwym SendMessage. Model wywołał MCP send_message z in_reply_to, a ACK wrócił do native Claude. Strukturalny thread/read potwierdza pierwszy input i completed tool call. Nie użyto klawiszy jako transportu wiadomości.

Podczas pierwszego testu poprawki wykryto uboczny efekt starego identity notifiera: powiadomienie dla aliasu uruchamiało model i prowadziło do automatycznej zmiany tytułu. Dlatego końcowy test wykonano na nowym pustym TUI już po wyłączeniu tego zachowania; wcześniejsze dowody zachowano. Natywny tytuł może nadal zmienić się po pierwszej rzeczywistej rozmowie — NAB odzwierciedla native thread.name.

Prywatne dowody w katalogu stanu native-agent-broker/fresh-thread-fix. Nie naprawiamy tym osobnego ograniczenia CLI resume pustego wątku utworzonego przez API; nie gwarantujemy attach bez zapisanej rozmowy.
