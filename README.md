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

## Deploy to Apify (GitHub Actions)

Add `APIFY_TOKEN` as a repo secret and run the provided workflow or push a tag like `v1.0.1`.
