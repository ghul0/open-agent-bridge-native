# Pomiar lokalnego routingu

2026-09-08, Linux x86_64, Node 22.20.0, izolowany RegistryServer w profilu native, dwaj logiczni host agenci WS, jedna SQLite na lokalnym filesystemie.

20 kolejnych syntetycznych wiadomości. Mierzono od rozpoczęcia POST HTTP, przez trwały zapis brokera, do odebrania `native.deliver` przez docelowy adapter WS. Bez modeli, bez czasu generacji, bez odrzucania pierwszej próbki:

| Metryka | Wynik |
|---|---:|
| p50 | 28,69 ms |
| p95 | 35,87 ms |
| maksimum | 36,60 ms |

To ograniczony pomiar lokalny, nie deklaracja SLA ani przepustowości wielu maszyn. Każdy adapter oddzielnie potwierdzał przyjęcie; nie użyto prawdziwych sesji użytkownika. Prywatny wynik maszynowy: katalog stanu `native-agent-broker/acceptance-final/benchmark/result.json`.
