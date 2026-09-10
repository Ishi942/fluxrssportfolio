// Met à jour archive.json : récupère les flux hardware, garde uniquement les news CPU,
// dédoublonne, fusionne avec l'historique existant depuis le 1er septembre 2026.
// Conçu pour tourner côté serveur (GitHub Actions) — pas de proxy CORS nécessaire ici,
// on peut lire les flux RSS directement.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_PATH = path.join(__dirname, "..", "archive.json");

const FEEDS = [
  { name: "Clubic Matériel", color: "#f28b82", url: "https://www.clubic.com/feed/materiel-informatique/rss" },
  { name: "Comptoir HW",     color: "#fdd663", url: "https://www.comptoir-hardware.com/home.xml" },
  { name: "Cowcotland",      color: "#81c995", url: "https://feeds.feedburner.com/cowcotland?format=xml" },
  { name: "Tom's Hardware",  color: "#8ab4f8", url: "https://www.tomshardware.fr/feed/" }
];

// On garde tout depuis cette date.
const START_DATE = new Date("2026-09-01T00:00:00Z");

const INCLUDE_KEYWORDS = [
  "processeur","cpu","core i","core ultra","ryzen","xeon","threadripper","epyc","snapdragon",
  "coeur","cœur","gravure","nanometre","nanomètre","architecture x86",
  "socket am4","socket am5","socket lga","nouveau socket cpu","changement de socket",
  "zen 5","zen 6","raptor lake","arrow lake","lunar lake","panther lake","nova lake",
  "tsmc","samsung foundry","gravure fine","finfet"
];
const EXCLUDE_KEYWORDS = [
  "bon plan","bons plans","code promo","promo ","soldes","reduction","réduction",
  "black friday","french days","prix casse","prix cassé","carte graphique","gpu ","rtx ","geforce",
  "routeur","hacker","hackers","pirate informatique","cybersecurite","cybersécurité",
  "cisco","ransomware","malware","vpn","espionnage","attaque informatique"
];

function normalize(str){
  return (str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function isCpuNews(title, desc){
  const text = normalize(title + " " + desc);
  const hasInclude = INCLUDE_KEYWORDS.some(k => text.includes(normalize(k)));
  const hasExclude = EXCLUDE_KEYWORDS.some(k => text.includes(normalize(k)));
  return hasInclude && !hasExclude;
}

function normalizeTitle(t){
  return normalize(t).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function titleSimilarity(a, b){
  const wa = new Set(normalizeTitle(a).split(" ").filter(w => w.length > 2));
  const wb = new Set(normalizeTitle(b).split(" ").filter(w => w.length > 2));
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  wa.forEach(w => { if (wb.has(w)) inter++; });
  const union = new Set([...wa, ...wb]).size;
  return inter / union;
}
const DUPLICATE_THRESHOLD = 0.55;
const DUPLICATE_WINDOW_MS = 4 * 24 * 3600 * 1000;

function isDuplicateOf(item, list){
  return list.some(existing => {
    if (existing.link === item.link) return true;
    const gap = Math.abs(new Date(existing.date) - new Date(item.date));
    if (gap > DUPLICATE_WINDOW_MS) return false;
    return titleSimilarity(existing.title, item.title) >= DUPLICATE_THRESHOLD;
  });
}

function stripCdata(str){
  const m = str.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return m ? m[1] : str;
}
function decodeEntities(str){
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function stripHtml(html){
  return decodeEntities(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
function extractTag(block, tag){
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  return m ? stripCdata(m[1].trim()) : "";
}

function parseRss(xml, feed){
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const raw of blocks){
    const block = raw.split(/<\/item>/i)[0];
    const title = decodeEntities(extractTag(block, "title"));
    let link = decodeEntities(extractTag(block, "link")).trim();
    if (!link) {
      const m = block.match(/<link[^>]*href="([^"]+)"/i);
      if (m) link = m[1];
    }
    const pubDate = extractTag(block, "pubDate") || extractTag(block, "dc:date") || extractTag(block, "pubdate");
    const description = extractTag(block, "description");
    if (!title || !link) continue;
    const date = pubDate ? new Date(pubDate) : new Date();
    items.push({
      title,
      link,
      date: isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
      desc: stripHtml(description).slice(0, 200),
      source: feed.name,
      color: feed.color
    });
  }
  return items;
}

async function fetchFeed(feed){
  try{
    const res = await fetch(feed.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; veille-cpu-bot/1.0)" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRss(xml, feed);
  } catch(e){
    console.error("Échec flux", feed.name, "-", e.message);
    return [];
  }
}

async function main(){
  let archive = [];
  try{
    archive = JSON.parse(await readFile(ARCHIVE_PATH, "utf-8"));
  } catch {
    archive = [];
  }

  // Revalide l'archive existante contre le filtre actuel (purge les faux positifs
  // enregistrés avant une correction de mots-clés) et contre la date de départ.
  archive = archive.filter(it => isCpuNews(it.title, it.desc) && new Date(it.date) >= START_DATE);

  const results = await Promise.all(FEEDS.map(fetchFeed));
  const fresh = results.flat().filter(it => isCpuNews(it.title, it.desc) && new Date(it.date) >= START_DATE);

  let added = 0;
  for (const item of fresh){
    if (!isDuplicateOf(item, archive)){
      archive.push(item);
      added++;
    }
  }

  archive.sort((a, b) => new Date(b.date) - new Date(a.date));

  await writeFile(ARCHIVE_PATH, JSON.stringify(archive, null, 2) + "\n");
  console.log(`Archive mise à jour : ${archive.length} articles au total (${added} nouveaux).`);
}

main();