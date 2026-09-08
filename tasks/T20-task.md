# T20 — Eksperyment natywnego capture Claude↔Claude

Stan początkowy: OUT_OF_MVP. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T20 — Eksperyment natywnego capture Claude↔Claude

Cel: rozstrzygnąć technicznie hipotezę transparentnego proxy.

Wykonaj: wyłącznie na sesjach testowych sprawdź wariant z proxy, kontrolami procesu, adresami zwrotnymi, receipt i restartami. Wykonaj rollback i porównaj z baseline bez brokera.

Dostarcz: capture-native-feasibility.md, prototyp za feature flag albo raport blokady, ślady testów i rollback.

Akceptacja zadania badawczego: wynik jest udowodniony, ograniczony do testowanych wersji i nie wymaga obejścia zabezpieczeń. Akceptacja samej funkcji capture wymaga dodatkowo wszystkich warunków rozdziału 12; raport blokady nie jest jej zaliczeniem.
