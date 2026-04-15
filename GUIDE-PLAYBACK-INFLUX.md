# Guide rapide - Playback SQLite vers InfluxDB

Ce guide explique comment rejouer la base brute SQLite vers InfluxDB avec le script standalone `scripts/playback-to-influx.js`.

## 1) Préchecks (sécurité)

- Vérifier que la base source existe.
- Vérifier le volume total pour estimer la durée.
- Démarrer avec une petite fenêtre de temps.

```bash
ls -l /Users/pierre/Documents/code-erabliere/ErabliCollecteur/Toute_la_Saison_2026.sq3
sqlite3 /Users/pierre/Documents/code-erabliere/ErabliCollecteur/Toute_la_Saison_2026.sq3 \
  "SELECT COUNT(*) AS total_rows, MIN(published_at) AS first_ts, MAX(published_at) AS last_ts FROM raw_events;"
```

## 2) Dry-run obligatoire (sans écriture Influx)

Valider le pipeline de traitement sans rien écrire dans InfluxDB:

```bash
npm --prefix /Users/pierre/Documents/code-erabliere/ErabliExport run playback:influx -- \
  --sqlite /Users/pierre/Documents/code-erabliere/ErabliCollecteur/Toute_la_Saison_2026.sq3 \
  --dry-run \
  --from 2026-04-10T23:45:00.000Z \
  --to 2026-04-10T23:59:59.999Z \
  --batch-size 200 \
  --delay-ms 50
```

## 3) Pilote d’écriture réel (petite fenêtre)

Une fois le dry-run validé, exécuter exactement la même fenêtre sans `--dry-run`:

```bash
npm --prefix /Users/pierre/Documents/code-erabliere/ErabliExport run playback:influx -- \
  --sqlite /Users/pierre/Documents/code-erabliere/ErabliCollecteur/Toute_la_Saison_2026.sq3 \
  --from 2026-04-10T23:45:00.000Z \
  --to 2026-04-10T23:59:59.999Z \
  --batch-size 200 \
  --delay-ms 50
```

## 4) Exécution complète

Après validation du pilote:

```bash
npm --prefix /Users/pierre/Documents/code-erabliere/ErabliExport run playback:influx -- \
  --sqlite /Users/pierre/Documents/code-erabliere/ErabliCollecteur/Toute_la_Saison_2026.sq3 \
  --batch-size 200 \
  --delay-ms 50
```

```bash
mkdir -p /Users/pierre/Documents/code-erabliere/ErabliExport/logs && nohup node /Users/pierre/Documents/code-erabliere/ErabliExport/scripts/playback-to-influx.js --sqlite /Users/pierre/Documents/code-erabliere/ErabliCollecteur/Toute_la_Saison_2026.sq3 --batch-size 200 --delay-ms 50 > /Users/pierre/Documents/code-erabliere/ErabliExport/logs/playback_full_$(date +%Y%m%d_%H%M%S).log 2>&1 &
```

## 4B) Exécution complète en arrière plan avec redirection des logs.

```bash
mkdir -p /Users/pierre/Documents/code-erabliere/ErabliExport/logs && nohup node /Users/pierre/Documents/code-erabliere/ErabliExport/scripts/playback-to-influx.js --sqlite /Users/pierre/Documents/code-erabliere/ErabliCollecteur/Toute_la_Saison_2026.sq3 --batch-size 200 --delay-ms 50 > /Users/pierre/Documents/code-erabliere/ErabliExport/logs/playback_full_$(date +%Y%m%d_%H%M%S).log 2>&1 &
```

## Pour suivre les logs:

```bash
tail -f /Users/pierre/Documents/code-erabliere/ErabliExport/logs/playback_full_*.log
```

## 5) Contrôle de charge

- Réduire `--batch-size` si la machine ou InfluxDB est sous pression.
- Augmenter `--delay-ms` pour lisser l’écriture.
- Commencer conservateur, puis accélérer graduellement.

## 6) Validation post-run

Vérifier dans le résumé du script:

- `failed=0` (ou proche de 0, puis investigation)
- `skipped` raisonnable (si présent, voir `Skip reasons`)
- Débit stable (`avg-rate`)

## 7) Options CLI disponibles

- `--sqlite <path>` (requis)
- `--batch-size <n>`
- `--delay-ms <n>`
- `--from <time>`
- `--to <time>`
- `--dry-run`
- `--help`
