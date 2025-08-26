// (same as previous cell) Updated crawler with robust link discovery + click-through fallback
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
    const buttons = await page.$$('button, a[role="button"]');
    for (const b of buttons) {
      const t = ((await b.innerText().catch(()=>'') ) || '').toLowerCase();
      if ((t.includes('show') || t.includes('view')) && (t.includes('phone') || t.includes('email') || t.includes('contact'))) {
        await b.click().catch(()=>{});
        await page.waitForTimeout(400);
      }
    }
  } catch {}

  try {
    const tel = await page.$('a[href^="tel:"], [data-testid*="phone"] a[href^="tel:"], a:has-text("+1")');
    if (tel) phone = (await tel.getAttribute('href'))?.replace('tel:', '') || '';
  } catch {}

  if (!phone) {
    const text = (await page.content() || '');
    const m = text.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
    if (m) phone = m[0];
  }

  try {
    const mail = await page.$('a[href^="mailto:"], [data-testid*="email"] a[href^="mailto:"]');
    if (mail) email = (await mail.getAttribute('href'))?.replace('mailto:', '') || '';
  } catch {}

  if (!email) {
    const html = await page.content();
    const m = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (m) email = m[0];
  }

  return { phone, email };
}

async function parseProfileOnCurrentPage(page) {
  await page.waitForTimeout(1800);
  let fullName = '';
  try {
    const h1 = await page.$('h1, h2, .agent-name, [data-testid="agent-name"]');
    fullName = h1 ? (await h1.innerText()).trim() : '';
  } catch {}
  if (!fullName) {
    try { fullName = (await page.title())?.trim() || ''; } catch {}
  }
  fullName = (fullName || '').replace(/\|\s*eXp\s*Realty.*/i, '').replace(/- eXp.*/i, '').trim();

  const { phone, email } = await extractContactFromProfile(page);
  const { first, last } = splitName(fullName);
  return { EMAIL: email || '', FIRSTNAME: first || '', LASTNAME: last || '', SMS: phone || '' };
}

async function autoScroll(page, maxSteps = 12) {
  for (let i = 0; i < maxSteps; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(400);
  }
}

function toAbs(pageUrl, href) {
  try { return new URL(href, pageUrl).toString(); } catch { return href; }
}

await Actor.init();

const input = await Actor.getInput() || {};
const {
  startPage = 1,
  maxResultsPages = 5,
  location = "Jacksonville, FL",
  country = "US",
  goOnePageDeep = true,
  outputCsv = "brevo_exp_agents.csv",
  debugSample = 0
} = input;

const baseSearch = (pageNum) => `https://www.exprealty.com/agents-search?page=${pageNum}&country=${encodeURIComponent(country)}&m=f&location=${encodeURIComponent(location)}`;

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
  requestHandlerTimeoutSecs: 120,
  navigationTimeoutSecs: 60,
  requestHandler: async ({ request, page }) => {
    if (request.userData.label === 'SEARCH') {
      log.info(`Search page: ${request.url}`);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1500);
      await autoScroll(page, 6);

      let profileLinks = await page.$$eval(
        'a[href*="/agent/"], a[href*="/agents/"], a[href*="/realtor"], a[href*="/real-estate-agent"]',
        as => as.map(a => a.href)
      ).catch(() => []);

      if (!profileLinks || profileLinks.length === 0) {
        profileLinks = await page.$$eval('a', as => as
          .filter(a => {
            const href = a.getAttribute('href') || '';
            const txt = (a.textContent || '').toLowerCase();
            const hasImg = !!a.querySelector('img');
            const looksLikeProfile = txt.includes('profile') || txt.includes('view') || hasImg;
            return href && !href.includes('agents-search') && looksLikeProfile;
          })
          .map(a => a.href)
        ).catch(() => []);
      }

      profileLinks = Array.from(new Set((profileLinks || []).map(h => toAbs(request.url, h))));
      log.info(`Found ${profileLinks.length} candidate links.`);

      let usedFallback = false;

      if (goOnePageDeep && profileLinks.length > 0) {
        const toQueue = (debugSample && profileLinks.length > debugSample) ? profileLinks.slice(0, debugSample) : profileLinks;
        await Actor.pushData({ type: 'profile_links_sample', count: toQueue.length });
        await crawler.addRequests(toQueue.map(url => ({ url, userData: { label: 'PROFILE' } })));
      }

      if (goOnePageDeep && profileLinks.length === 0) {
        usedFallback = true;
        log.warning('No hrefs found; entering fallback click-through mode.');
        const cardSelectors = [
          'a:has(img)',
          '[role="link"]:has(img)',
          '.card:has(img)',
          'article:has(img)',
          '[data-testid*="agent"] a, [data-testid*="card"] a'
        ];
        let cardHandles = [];
        for (const sel of cardSelectors) {
          const found = await page.$$(sel);
          if (found && found.length) { cardHandles = found; break; }
        }

        const limit = debugSample ? Math.min(debugSample, cardHandles.length) : cardHandles.length;
        for (let i = 0; i < limit; i++) {
          const el = cardHandles[i];
          try {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{}),
              el.click({ timeout: 8000 }).catch(()=>{})
            ]);
            const rec = await parseProfileOnCurrentPage(page);
            if (rec.EMAIL || rec.SMS) results.push(rec);
          } catch (e) {
            log.debug(`Fallback click failed on card ${i}: ${e}`);
          } finally {
            await Promise.race([
              page.goBack({ waitUntil: 'domcontentloaded' }),
              page.waitForTimeout(1500)
            ]).catch(()=>{});
          }
        }
      }

      const currentPage = Number(new URL(request.url).searchParams.get('page') || '1');
      if (currentPage < startPage + maxResultsPages - 1) {
        const nextUrl = baseSearch(currentPage + 1);
        await crawler.addRequests([{ url: nextUrl, userData: { label: 'SEARCH' } }]);
      }

      if (usedFallback && results.length === 0) {
        log.warning('Fallback mode collected 0 contacts; selectors may need updating.');
      }

    } else if (request.userData.label === 'PROFILE') {
      log.info(`Profile: ${request.url}`);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1200);
      const rec = await parseProfileOnCurrentPage(page);
      if (!rec.EMAIL && !rec.SMS) log.warning('No contact found on profile page.');
      results.push(rec);
    }
  },
});

await crawler.addRequests([{ url: baseSearch(startPage), userData: { label: 'SEARCH' } }]);
await crawler.run();

const seen = new Set();
const deduped = [];
for (const r of results) {
  const key = (r.EMAIL || '') + '|' + (r.SMS || '');
  if (key === '|') continue;
  if (!seen.has(key)) { seen.add(key); deduped.push(r); }
}

await csvWriter.writeRecords(deduped);
fs.writeFileSync(path.join(process.cwd(), 'brevo_exp_agents.json'), JSON.stringify(deduped, null, 2));

log.info(`Saved ${deduped.length} contacts to ${path.resolve(outputCsv)}`);
await Actor.exit();
