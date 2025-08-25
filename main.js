import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import fs from 'fs';
import path from 'path';
import { createObjectCsvWriter as createCsvWriter } from 'csv-writer';

function splitName(full) {
  if (!full) return { first: '', last: '' };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts.slice(-1)[0] };
}

async function extractContactFromProfile(page) {
  let phone = '';
  let email = '';

  try {
    const buttons = await page.$$('button, a');
    for (const b of buttons) {
      const t = (await b.innerText().catch(()=>'') || '').toLowerCase();
      if (t.includes('show') && (t.includes('phone') || t.includes('email'))) {
        await b.click().catch(()=>{});
      }
    }
  } catch {}

  try {
    const tel = await page.$('a[href^="tel:"]');
    if (tel) phone = (await tel.getAttribute('href'))?.replace('tel:', '') || '';
  } catch {}

  if (!phone) {
    const text = (await page.content() || '');
    const m = text.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
    if (m) phone = m[0];
  }

  try {
    const mail = await page.$('a[href^="mailto:"]');
    if (mail) email = (await mail.getAttribute('href'))?.replace('mailto:', '') || '';
  } catch {}

  if (!email) {
    const html = await page.content();
    const m = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (m) email = m[0];
  }

  return { phone, email };
}

await Actor.init();

const input = await Actor.getInput() || {};
const {
  startPage = 1,
  maxResultsPages = 1,
  location = "Jacksonville, FL",
  country = "US",
  goOnePageDeep = true,
  outputCsv = "brevo_exp_agents.csv"
} = input;

const searchUrl = `https://www.exprealty.com/agents-search?page=${startPage}&country=${encodeURIComponent(country)}&m=f&location=${encodeURIComponent(location)}`;

const results = [];
const csvWriter = createCsvWriter({
  path: outputCsv,
  header: [
    {id: 'EMAIL', title: 'EMAIL'},
    {id: 'FIRSTNAME', title: 'FIRSTNAME'},
    {id: 'LASTNAME', title: 'LASTNAME'},
    {id: 'SMS', title: 'SMS'}
  ]
});

const crawler = new PlaywrightCrawler({
  maxConcurrency: 2,
  headless: true,
  requestHandlerTimeoutSecs: 90,
  requestHandler: async ({ request, page, enqueueLinks, log }) => {
    if (request.userData.label === 'SEARCH') {
      log.info(`Search page: ${request.url}`);
      await page.waitForTimeout(3000);

      const profileLinks = await page.$$eval('a', as => as
        .map(a => ({ href: a.href, text: (a.textContent||'').trim() }))
        .filter(a => a.href.includes('/agents/') && !a.href.includes('/agents-search'))
        .map(a => a.href)
      );
      const unique = Array.from(new Set(profileLinks));
      log.info(`Found ${unique.length} agent links.`);

      if (goOnePageDeep) {
        for (const url of unique) {
          await Actor.pushData({ type: 'profile_link', url });
          await crawler.addRequests([{ url, userData: { label: 'PROFILE' } }]);
        }
      }

      const currentPage = Number(new URL(request.url).searchParams.get('page') || '1');
      if (currentPage < startPage + maxResultsPages - 1) {
        const nextUrl = `https://www.exprealty.com/agents-search?page=${currentPage+1}&country=${encodeURIComponent(country)}&m=f&location=${encodeURIComponent(location)}`;
        await crawler.addRequests([{ url: nextUrl, userData: { label: 'SEARCH' } }]);
      }
    } else if (request.userData.label === 'PROFILE') {
      log.info(`Profile: ${request.url}`);
      await page.waitForTimeout(2500);
      let fullName = await page.title();
      try {
        const h1 = await page.$('h1, h2, .agent-name, [data-testid="agent-name"]');
        if (h1) fullName = (await h1.innerText()).trim();
      } catch {}
      fullName = fullName.replace(/\|\s*eXp\s*Realty.*/i, '').replace(/- eXp.*/i, '').trim();

      const { phone, email } = await extractContactFromProfile(page);
      const { first, last } = splitName(fullName);

      if (!email && !phone) {
        log.warning(`No contact found for ${fullName} (${request.url})`);
      }

      results.push({
        EMAIL: email || '',
        FIRSTNAME: first || '',
        LASTNAME: last || '',
        SMS: phone || ''
      });
    }
  },
});

await crawler.addRequests([{ url: searchUrl, userData: { label: 'SEARCH' } }]);
await crawler.run();

const seen = new Set();
const deduped = [];
for (const r of results) {
  const key = (r.EMAIL || '') + '|' + (r.SMS || '');
  if (key === '|') continue;
  if (!seen.has(key)) {
    seen.add(key);
    deduped.push(r);
  }
}

await csvWriter.writeRecords(deduped);

const jsonPath = path.join(process.cwd(), 'brevo_exp_agents.json');
fs.writeFileSync(jsonPath, JSON.stringify(deduped, null, 2));

log.info(`Saved ${deduped.length} contacts to ${path.resolve(outputCsv)}`);
await Actor.exit();
