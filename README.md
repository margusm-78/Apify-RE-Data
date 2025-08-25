# eXp Agents → Brevo CSV (Apify Actor)

Scrapes **eXp Realty** agents in **Jacksonville, FL** (or any location you set) and produces a Brevo-ready CSV with columns:

- `EMAIL`
- `FIRSTNAME`
- `LASTNAME`
- `SMS` (phone)

## Run locally

```bash
npm install
node main.js
```

Default input is set via the Apify Console UI when deployed. Locally you can pass input via Key-Value Store or by editing defaults in `main.js`.

## Deploy to Apify (GitHub Actions)

This repo includes a GitHub Actions workflow that pushes the Actor to Apify using `apify/push-actor-action`.
**Setup once:** In your GitHub repo, go to **Settings → Secrets and variables → Actions** and add:

- `APIFY_TOKEN` — your Apify API token.

Then run the workflow manually (Actions → *Push to Apify*) or push a tag like `v1.0.0`.

## Apify input (UI)

The platform reads `INPUT_SCHEMA.json` and renders a form with:
- `startPage` (default: 1)
- `maxResultsPages` (default: 1)
- `location` (default: "Jacksonville, FL")
- `country` (default: "US")
- `goOnePageDeep` (default: true)
- `outputCsv` (default: "brevo_exp_agents.csv")

## Output

- CSV file written to Actor's working directory (download from the Run's *Files* tab): `brevo_exp_agents.csv`
- Debug JSON: `brevo_exp_agents.json`
- Dedupe by `(EMAIL|SMS)` is applied.

## Notes

- Some eXp profiles hide email behind contact forms; the Actor attempts both `mailto:` discovery and pattern matching.
- Increase `maxResultsPages` to crawl additional search pages.
- Respect website Terms and only use public business contact info.
