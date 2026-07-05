require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const os = require('os');
const path = require('path');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;

const REQUIRED_KEYS = ['RAPIDAPI_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
REQUIRED_KEYS.forEach((key) => {
  if (!process.env[key]) {
    console.warn(`[WARN] Missing ${key} in .env — requests that need it will fail until it is set.`);
  }
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(express.json({ limit: '2mb' }));

// Allow the frontend to call this API from a different origin (e.g. Netlify).
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(__dirname));

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// STEP 1 + 2 — Download the TikTok video via RapidAPI and transcribe it with
// OpenAI Whisper. Whisper accepts mp4 directly, so no separate audio
// extraction step is needed.
// ---------------------------------------------------------------------------
async function getTranscriptFromTikTok(tiktokUrl) {
  const rapidRes = await axios.get('https://tiktok-video-no-watermark2.p.rapidapi.com/', {
    params: { url: tiktokUrl },
    headers: {
      'x-rapidapi-host': 'tiktok-video-no-watermark2.p.rapidapi.com',
      'x-rapidapi-key': process.env.RAPIDAPI_KEY,
    },
    timeout: 15000,
  });

  const data = rapidRes.data && rapidRes.data.data;
  const videoUrl = data && (data.play || data.wmplay || data.hdplay);
  if (!videoUrl) {
    throw new Error('No downloadable video URL was returned for that TikTok link.');
  }

  const videoRes = await axios.get(videoUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': BROWSER_UA },
  });

  const tempPath = path.join(os.tmpdir(), `goviral-${Date.now()}-${Math.round(Math.random() * 1e6)}.mp4`);
  fs.writeFileSync(tempPath, Buffer.from(videoRes.data));

  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: 'whisper-1',
    });
    const text = (transcription.text || '').trim();
    if (!text) throw new Error('Transcription came back empty.');
    return text;
  } finally {
    fs.unlink(tempPath, () => {});
  }
}

// ---------------------------------------------------------------------------
// STEP 3 — Scrape the product page for name, benefits, claims, and price
// signals we can hand to Claude.
// ---------------------------------------------------------------------------
async function scrapeProduct(productUrl) {
  const { data: html } = await axios.get(productUrl, {
    timeout: 15000,
    maxRedirects: 5,
    headers: { 'User-Agent': BROWSER_UA },
  });

  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr('content') || $('title').text() || '';
  const description =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    '';
  const priceMeta =
    $('meta[property="product:price:amount"]').attr('content') ||
    $('meta[property="og:price:amount"]').attr('content') ||
    '';
  const headings = $('h1, h2')
    .map((i, el) => $(el).text().trim())
    .get()
    .filter(Boolean)
    .slice(0, 10)
    .join(' | ');
  const bullets = $('li')
    .map((i, el) => $(el).text().trim())
    .get()
    .filter((t) => t.length > 10 && t.length < 200)
    .slice(0, 15)
    .join(' | ');
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 3000);

  const sections = [
    title && `Product Name/Title: ${title.trim()}`,
    description && `Description: ${description.trim()}`,
    priceMeta && `Listed Price Signal: ${priceMeta}`,
    headings && `Key Headings: ${headings}`,
    bullets && `Bullet Points / Claims / Features: ${bullets}`,
    bodyText && `Page Copy Snippet: ${bodyText}`,
  ].filter(Boolean);

  if (!title.trim() && !description.trim() && bodyText.length < 50) {
    throw new Error('Could not extract meaningful product info from that page.');
  }

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// STEP 4 — Generate the 3 scripts with Claude.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are an expert TikTok Shop affiliate script writer trained on the buyer psychology framework of Dustin Davis, one of the top TikTok Shop educators. You understand that people do not buy products — they buy identity, status, belonging, attraction, and the resolution of deep biological desires.

Your scripts follow these principles:
- Hooks must trigger a pattern interrupt in the first 2 seconds — make the viewer stop scrolling before a single word is spoken
- Every script must pull on one of these core psychological levers: identity (who does buying this make me?), aspirational tribe (what group does this let me belong to?), sexual companionship/attraction (does this make me more attractive?), nostalgia (does this connect to something deeply familiar?), or desire pairing (attach the product to something already pleasurable)
- Script body follows: pattern interrupt hook → problem agitation → product as the solution → specific benefit with sensory detail → social proof signal (casual, not aggressive) → urgency-based CTA
- CTAs must reference the actual product price and create urgency without sounding salesy
- Total script must be speakable in roughly 15-30 seconds at natural pace — tight and punchy, no padding or filler lines
- Language must feel conversational and authentic — never scripted, never corporate, never like a happy-go-lucky insurance commercial
- The new scripts must closely mirror the transcribed inspo video — follow its sentence order, sentence lengths, transitions, and rhythm as closely as possible, essentially adapting it line-by-line to the user's product rather than just borrowing its general vibe. Only change the words that must change to fit the new product, price, and niche. Do not add extra beats, examples, or sentences that were not implied by the structure of the original.

Generate exactly 3 scripts, each with a genuinely different hook type:
- Script 1: Identity/Tribe hook — open by calling out who the viewer wants to become
- Script 2: Problem/Pain hook — open with the viewer's exact frustration before they even knew this product existed
- Script 3: Pattern Interrupt/Curiosity hook — open with something so unexpected or specific they physically cannot scroll past it

Respond with ONLY valid JSON — no markdown code fences, no commentary before or after — matching this exact schema:

{
  "scripts": [
    {
      "hookType": "identity" | "problem" | "curiosity",
      "hookTypeLabel": string (e.g. "Identity / Tribe Hook"),
      "hook": string (the [HOOK] section — 1-3 sentences, the pattern-interrupt opener),
      "body": string (the [BODY] section — problem agitation, product as the solution, specific benefit with sensory detail, casual social proof),
      "cta": string (the [CTA] section — urgency-based close that references the real product price),
      "speakTimeSeconds": number (estimated seconds to speak the full script at natural pace, between 15 and 30),
      "overlays": [ { "time": "0:04", "text": "what overlay text/graphic appears and why" } ] (3 to 4 items, timed across the script),
      "visualHook": string (one specific sentence describing exactly what to do in the first 2 seconds before a single word is spoken — wardrobe, prop, background, action — built on contrast, authority signals, and relatability cues that stop the scroll before words do),
      "productionPointers": [string, string] (exactly 2 specific tips to make this video perform better, based on the product and niche)
    }
  ]
}

Return exactly 3 scripts in the array, in the order specified above. Output nothing but the JSON object.`;

function buildUserPrompt({ transcript, productInfo, price, niche }) {
  return `INSPO VIDEO TRANSCRIPT (treat this as the template — mirror its exact structure, sentence order, and pacing as closely as possible, adapting it line-by-line to the product below rather than just taking inspiration from it):
"""
${transcript}
"""

PRODUCT INFORMATION:
"""
${productInfo}
"""

PRODUCT PRICE: $${price}
NICHE: ${niche}

Write the 3 scripts now, following the system instructions exactly. Keep each script tight and short — do not pad it out longer than the transcript above. Respond with ONLY the JSON object described in the schema.`;
}

function extractJson(text) {
  let cleaned = text
    .trim()
    .replace(/^```json/i, '')
    .replace(/^```/, '')
    .replace(/```$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // fall through to brace-matching below
  }

  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    try {
      return JSON.parse(cleaned.slice(first, last + 1));
    } catch (e) {
      // give up
    }
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateScripts({ transcript, productInfo, price, niche }) {
  const maxAttempts = 3;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 6000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt({ transcript, productInfo, price, niche }) }],
      });

      const raw = message.content.map((block) => block.text || '').join('');
      const parsed = extractJson(raw);

      if (!parsed || !Array.isArray(parsed.scripts) || parsed.scripts.length !== 3) {
        throw new Error(
          `Unexpected response format from the script generator (stop_reason: ${message.stop_reason}).`
        );
      }

      return parsed.scripts;
    } catch (err) {
      lastErr = err;
      console.error(`[Claude attempt ${attempt}/${maxAttempts}] status=${err.status || 'n/a'} message=${err.message}`);
      if (attempt < maxAttempts) await sleep(1000 * attempt);
    }
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
app.post('/api/generate', async (req, res) => {
  try {
    const {
      tiktokUrl,
      productUrl,
      price,
      niche,
      fallbackTranscript,
      fallbackBenefits,
    } = req.body || {};

    if (!price || !niche) {
      return res.status(400).json({ success: false, error: 'Price and niche are required.' });
    }

    let transcript = (fallbackTranscript || '').trim();
    if (!transcript) {
      if (!tiktokUrl) {
        transcript = '';
      } else {
        try {
          transcript = await getTranscriptFromTikTok(tiktokUrl);
        } catch (err) {
          console.error('[TikTok/Whisper] ', err.message);
          transcript = '';
        }
      }
    }

    let productInfo = (fallbackBenefits || '').trim();
    if (!productInfo) {
      if (!productUrl) {
        productInfo = '';
      } else {
        try {
          productInfo = await scrapeProduct(productUrl);
        } catch (err) {
          console.error('[Product scrape] ', err.message);
          productInfo = '';
        }
      }
    }

    if (!transcript || !productInfo) {
      return res.json({
        success: false,
        needsTranscriptFallback: !transcript,
        needsProductFallback: !productInfo,
        transcriptMessage:
          "We couldn't pull that video directly — paste the transcript or describe the video style below",
        productMessage: 'Paste your key product benefits below',
      });
    }

    const scripts = await generateScripts({ transcript, productInfo, price, niche });
    return res.json({ success: true, scripts, transcript });
  } catch (err) {
    console.error('[Generate] ', err);
    return res.status(500).json({
      success: false,
      error: 'Something went wrong generating your scripts. Please try again in a moment.',
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`GoViral Script Writer running at http://localhost:${PORT}`);
});
