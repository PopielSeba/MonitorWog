import type { Handler, HandlerEvent } from "@netlify/functions";
import nodemailer from "nodemailer";
import { parseStringPromise } from "xml2js";

const {
  SMTP_HOST,
  SMTP_PORT = "587",
  SMTP_USER,
  SMTP_PASS,
  MAIL_FROM,
  MAIL_TO,
  MAIL_SUBJECT_PREFIX = "[WOG]",
  FRESH_WINDOW_MIN = "90"
} = process.env;

const FEED_URLS = process.env.FEED_URLS ?? [
  "https://ted.europa.eu/udl?uri=TED:NOTICE:feed:EN:RSS&searchText=camp%20OR%20tent%20OR%20container%20OR%20generator%20OR%20%22lighting%20mast%22%20OR%20HVAC%20OR%20%22air%20conditioning%22%20OR%20heater&country=DE&country=PL&country=CZ&country=SK&country=RO&country=LT",
  "https://api.sam.gov/opportunities/v2/search?limit=50&q=camp%20OR%20tent%20OR%20container%20OR%20generator%20OR%20%22lighting%20mast%22%20OR%20HVAC%20OR%20%22air%20conditioning%22%20OR%20heater&placeOfPerformanceLocations=PL%2CDE%2CCZ%2CSK%2CRO%2CLT"
].join(",");

const KEYWORDS = process.env.KEYWORDS ??
  "camp,base camp,tent,namiot,container,kontener,generator,agregat,power generator,lighting mast,maszt oświetleniowy,floodlight,hvac,air conditioning,klimatyzacja,heater,heating,nagrzewnica";

const FRESH_MIN = Number(FRESH_WINDOW_MIN) || 90;

const now = () => new Date();
const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000);

function normalize(str: string): string {
  return str.toLowerCase().normalize("NFKD").replace(/[^\p{Letter}\p{Number}\s]/gu, " ");
}
function matchesKeywords(text: string, keywords: string[]): boolean {
  if (!text) return false;
  const t = normalize(text);
  return keywords.some((k) => t.includes(normalize(k)));
}
function pick<T = string>(v?: T[] | T): T | "" {
  if (!v) return "" as unknown as T;
  if (Array.isArray(v)) return (v[0] ?? "") as unknown as T;
  return v ?? ("" as unknown as T);
}
function toDateSafe(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(+d) ? null : d;
}
function isFresh(pub?: string | Date): boolean {
  const dt = pub instanceof Date ? pub : toDateSafe(pub || "");
  if (!dt) return false;
  return dt >= minutesAgo(FRESH_MIN) && dt <= now();
}
async function fetchText(url: string): Promise<{ body: string; contentType: string | null }> {
  const res = await fetch(url, { headers: { "User-Agent": "wog-notifier/1.3 (+netlify)" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  const contentType = res.headers.get("content-type");
  const body = await res.text();
  return { body, contentType };
}
type RssItem = { title?: string[]; link?: string[]; guid?: string[]; pubDate?: string[]; description?: string[]; summary?: string[]; updated?: string[]; published?: string[]; id?: string[]; };
async function parseRssOrAtom(xml: string): Promise<RssItem[]> {
  const parsed = await parseStringPromise(xml, { explicitArray: true, trim: true });
  return parsed?.rss?.channel?.[0]?.item ?? parsed?.feed?.entry ?? [];
}
function itemToRecord(it: RssItem, source: string) {
  const title = String(pick(it.title) || "(bez tytułu)");
  const link = String(pick(it.link) || pick(it.id) || pick(it.guid) || "");
  const summary = String(pick(it.description) || pick(it.summary) || "");
  const pub = String(pick(it.pubDate) || pick(it.published) || pick(it.updated) || "") || "";
  const safeLink = /^https?:\/\//i.test(link) ? link : (summary.match(/https?:\/\/\S+/)?.[0] ?? "");
  return { title, link: safeLink, summary, pub, source };
}
function parseSamJson(jsonText: string, source: string) {
  let arr: any[] = [];
  try {
    const data = JSON.parse(jsonText);
    arr = data?.opportunitiesData ?? data?.data ?? [];
  } catch { return []; }
  return arr.map((x) => ({
    title: x.title || "(bez tytułu)",
    link: x.uiLink || x.url || "",
    pub: x.publishDate || x.postedDate || x.modifiedDate || "",
    summary: [x.description ?? "", x.placeOfPerformance?.country ?? ""].join(" "),
    source
  }));
}
async function sendMail(subject: string, html: string) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !MAIL_FROM || !MAIL_TO) {
    throw new Error("Brak konfiguracji SMTP/MAIL_* w zmiennych środowiskowych.");
  }
  const transport = nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT), secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  await transport.sendMail({ from: MAIL_FROM, to: MAIL_TO, subject, html });
}
function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#039;");
}

// === MAIN ===============================================================
export const handler: Handler = async (event: HandlerEvent) => {
  try {
    // tryby wywołania z przeglądarki:
    const qp = event.queryStringParameters ?? {};
    const wantJson = (qp["format"] ?? "").toLowerCase() === "json";
    const dryRun = (qp["dryRun"] ?? qp["dryrun"] ?? "0") === "1";

    const feeds = FEED_URLS.split(",").map(s => s.trim()).filter(Boolean);
    const kw = KEYWORDS.split(",").map(s => s.trim()).filter(Boolean);

    const results = await Promise.allSettled(feeds.map(fetchText));
    const items: { title: string; link: string; pub: string; summary: string; source: string }[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i]; const src = feeds[i];
      if (r.status !== "fulfilled") continue;
      const { body, contentType } = r.value;

      if ((contentType ?? "").includes("json") || body.trim().startsWith("{")) {
        items.push(
          ...parseSamJson(body, src)
            .filter(x => matchesKeywords(`${x.title} ${x.summary}`, kw) && isFresh(x.pub))
        );
      } else {
        const parsed = await parseRssOrAtom(body);
        for (const raw of parsed) {
          const rec = itemToRecord(raw as RssItem, src);
          if (matchesKeywords(`${rec.title} ${rec.summary}`, kw) && isFresh(rec.pub)) items.push(rec);
        }
      }
    }

    // dedup
    const seen = new Set<string>();
    const unique = items.filter(x => { const key = x.link || `${x.title}|${x.pub}`; if (seen.has(key)) return false; seen.add(key); return true; })
                        .sort((a,b)=> new Date(b.pub).getTime()-new Date(a.pub).getTime());

    // jeśli proszono o JSON – zwracamy dane i nie wysyłamy maila (dryRun domyślnie on w tym trybie)
    if (wantJson) {
      return {
        statusCode: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        },
        body: JSON.stringify({ updatedAt: new Date().toISOString(), count: unique.length, items: unique })
      };
    }

    // zwykły bieg: e-mail (chyba że dryRun=1)
    if (unique.length === 0) {
      return { statusCode: 200, body: "No fresh items." };
    }

    const li = unique.map(x => {
      const ts = toDateSafe(x.pub)?.toLocaleString("pl-PL") ?? x.pub;
      const link = x.link || "(brak linku)";
      return `<li><a href="${link}">${escapeHtml(x.title)}</a><br/><small>${escapeHtml(ts)} – ${escapeHtml(x.source)}</small></li>`;
    }).join("");

    const html = `<p>Nowe ogłoszenia:</p><ul>${li}</ul><p style="font-size:12px;color:#666">Automat – wog-notifier (Netlify)</p>`;

    if (!dryRun) {
      await sendMail(`${MAIL_SUBJECT_PREFIX} ${unique.length} nowych ogłoszeń`, html);
    }

    return { statusCode: 200, body: dryRun ? "Dry run OK." : `Sent ${unique.length} items` };
  } catch (err) {
    return { statusCode: 500, body: (err as Error).message };
  }
};
