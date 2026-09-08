# Środowisko — wersja zanonimizowana

2026-09-08, Linux x86_64, Node 22.20.0, SQLite 3.50.4, pnpm 11.22.0, git 2.43.0, gh 2.45.0, tmux 3.4. systemd --user jest dostępny. Istniejące usługi i sesje pozostawiono nietknięte.

Claude Code 2.1.263 native binary; repo zawiera też starsze CLI jako zależność, dlatego launchery muszą używać pełnej ścieżki zweryfikowanego harnessu. Istniejące proxy modeli nie jest częścią transportu NAB.
Codex 0.153.4: --remote ws/wss/unix, App Server --listen i generator schematów dostępne. Istniejący App Server użytkownika nie jest automatycznie adoptowany.
Pi globalne jest customowe; dla NAB przygotowywana jest oddzielna czysta instalacja.
Antigravity 1.1.27 wykryty podczas wcześniejszego audytu, obecnie poza MVP i nie jest testowany w odbiorze LOCAL_3.

Instalacja zależności: pnpm install --frozen-lockfile --ignore-scripts. Brak globalnego upgrade. Baseline build exit 0; 376 testów w 48 plikach PASS; lint exit 0 z ostrzeżeniami upstream. CI upstream używa pnpm 10, lokalnie zweryfikowano pnpm 11.22.0.

Prywatne dowody i konfiguracje są poza repo. Nie opublikowano portów prywatnej infrastruktury ani logów użytkownika. Stan limitów jest odnawialnym ograniczeniem wykonania, nie cechą architektury.
