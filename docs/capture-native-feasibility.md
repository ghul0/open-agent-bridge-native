# Capture native — poza MVP

Aktualizacja LOCAL_3 usuwa transparentne proxy Claude↔Claude z odbioru MVP. Status: **NOT_RUN_OUT_OF_MVP**. Nie zmieniano registry ani socketów rzeczywistych sesji w celu przechwytywania ich bezpośredniego transportu.

Kontrola native Claude↔Claude przeszła na dwóch rzeczywistych sesjach. Ruch ten nie pojawia się w ledgerze NAB. Test helpera projekcji i testy hold/refuse nie są eksperymentem transparentnego capture.

Broker zapisuje tylko ruch zaakceptowany przez własne API/adaptery. Subagenci, teamy, natywne lokalne peer messages i cloud mogą omijać ten punkt. Osobny eksperyment pozostaje kierunkiem docelowym i wymaga osobnego raportu.
