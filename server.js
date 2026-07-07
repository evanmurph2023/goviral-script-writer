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
    headings && `Key Headings: ${headings}`,
    bullets && `Bullet Points / Claims / Features: ${bullets}`,
    bodyText && `Page Copy Snippet: ${bodyText}`,
  ].filter(Boolean);

  if (!title.trim() && !description.trim() && bodyText.length < 50) {
    throw new Error('Could not extract meaningful product info from that page.');
  }

  return sections.join('\n\n');
}

function buildProductContext({ productName, scrapedInfo, extraDetails }) {
  const sections = [
    `Exact Product Name (this is the source of truth for what the product actually is, for your own understanding and accuracy — never substitute a different, generic, or category-level product when writing, even if other info below seems to point elsewhere. Do NOT repeat this full name out loud in the script itself; refer to it casually the way a real person would, like "this" or "this top"): ${productName}`,
    scrapedInfo &&
      `Scraped Product Page Info (only trust specific claims from this if they clearly match the exact product name above — ignore anything that looks like unrelated navigation, category, or boilerplate text): ${scrapedInfo}`,
    extraDetails && `Additional Details Provided By The User: ${extraDetails}`,
  ].filter(Boolean);

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// STEP 4 — Generate the 3 scripts with Claude.
// ---------------------------------------------------------------------------
const SCRIPT_PRINCIPLES = `- Hooks must trigger a pattern interrupt in the first 2 seconds — make the viewer stop scrolling before a single word is spoken
- Every script must pull on one of these core psychological levers: identity (who does buying this make me?), aspirational tribe (what group does this let me belong to?), sexual companionship/attraction (does this make me more attractive?), nostalgia (does this connect to something deeply familiar?), or desire pairing (attach the product to something already pleasurable)
- Script body follows: pattern interrupt hook → problem agitation → product as the solution → specific benefit with sensory detail → social proof signal (casual, not aggressive) → urgency-based CTA
- Never state a specific price or dollar amount anywhere in the script (hook, body, or CTA) — stating exact prices in organic TikTok Shop content risks a policy violation for the creator. Build CTA urgency the way real high-performing TikTok Shop videos actually do: reference the platform's real UI (e.g. "tap the orange cart", "it's linked right there", "swipe up", "shop now button"), scarcity/social proof ("it keeps selling out", "stock is moving"), or a casual imperative — never a manufactured "it's $X" line. Mirror the inspo transcript's own CTA phrasing and energy as closely as possible; if the transcript's own closing line doesn't mention a price either, that's the model to follow.
- Total script must be speakable in roughly 15-30 seconds at natural pace — tight and punchy, no padding or filler lines
- Language must sound like a real person leaving a voice note for a friend explaining why they like something: quick, a little messy, genuinely reactive. Never scripted, never corporate, never like a happy-go-lucky insurance commercial. Genuine, specific reactions beat generic hype every time; manufactured excitement reads as fake instantly.
- Never use the em dash character (—) anywhere in the output, in any field. Use a period, comma, or "and" instead. Em dashes are a dead giveaway of AI-written text and are strictly forbidden.
- Never use these words or phrases anywhere in the output, in any field, regardless of topic, they are permanent giveaways of AI-written text: delve, leverage, utilize, harness, streamline, underscore, navigate, elevate, empower, showcase, showcasing, boasts, pivotal, robust, seamless, cutting-edge, game-changer, groundbreaking, vibrant, renowned, multifaceted, meticulous, intricate, paramount, noteworthy, landscape, realm, tapestry, synergy, ecosystem, journey, testament, furthermore, moreover, "it's important to note", "in today's world", "at the end of the day". If a word or phrase sounds like it belongs in a LinkedIn post or corporate blog, it does not belong in a TikTok video script.
- You will be given the product's exact name and, in the product information, may also be given verified research findings about it. The exact product name is always the source of truth — if a scraped snippet or the selected niche conflicts with it, trust the product name. Never default to a generic description of the product's broad category (for example: a lash serum must always be written about as an eyelash-growth product — never described as if it were a general skincare/face product, even if "Skincare" is the closest niche option available). Every claim, benefit, and sensory detail must genuinely apply to this exact product.
- Before writing anything, identify the ONE specific core selling point, pain point, or "aha" moment that the inspo transcript is actually built around (for example: "these shoes make you look taller", "this makes your skin noticeably brighter", "this fixes lower back pain", "this covers gray roots instantly"). That exact core angle, not a different or more generic one, is what this script must be built around, adapted to the new product. Do not substitute a safer, more generic benefit of the new product for it, even if that other benefit is also true. If the new product has other genuine features or benefits that the transcript's core angle did not emphasize (for example the product also has anti-aging benefits, or is also machine washable, or also comes in other colors), leave those out entirely unless they directly support the same core angle; the transcript's specific selling point decides what the whole script is about, not a list of everything the product can do. Trust the transcript's own description of what its product actually does as real, usable information about that type of product, and carry that same specific function and claim into the new script for the new product, as long as it is a plausible, genuine claim for a product of that type.
- Before writing anything, run this exact check on the NICHE field: is the product ITSELF, by its own direct and literal function, an obvious member of that niche category, with zero reasoning or inference required (example: a protein powder is directly and obviously Fitness; a face serum is directly and obviously Skincare)? If yes, you may let that niche's natural context show up in the script. If answering requires ANY inference, reasoning, or "well, people who do X might also want Y" logic, the answer is NO, full stop, and you must write the entire script as if the NICHE field were blank, with zero reference to that niche's typical setting, props, or audience, anywhere in the script, overlays, or visual hook. Concretely: a phone case is not Fitness, even if gym-goers could use it; a sleep aid is not Fitness, even if athletes value sleep; a phone case is not Home & Kitchen, even if it sits on a kitchen counter. Do not invent a setting (a gym, a workout, an office, a kitchen) that is not already in the inspo transcript and is not the product's own direct, literal function.
- Know the full product name for accuracy, but never speak it out loud repeatedly. A real person says a long or formal product name at most once, if at all, then just calls it "this", "it", "this top", "this set", "this thing" for the rest of the video, exactly like they would if it were sitting in front of them. Never repeat a long, formal, or listing-style product name multiple times through the script; that is an instant giveaway that it was written by AI, not spoken by a person.
- Match the exact vocabulary, tone, energy, and slang level of the inspo transcript, nothing more and nothing less. Never invent generic trendy phrases, forced slang, or made-up "internet voice" descriptors (like a fabricated "it's giving ___" line) that are not actually reflected in the transcript's real language, even if you believe they are currently popular. Trending slang turns over every few weeks; forcing it in when it is not actually in the source material reads as dated and try-hard almost immediately. Real authenticity comes only from matching the actual person in the transcript, never from injecting whatever slang seems current. If the transcript's speaker is dry, casual, unpolished, or doesn't use slang, the new script should not use slang either. Sound like the specific real person in the transcript, not a generic influencer caricature layered on top.`;

const HOOK_TYPE_LABELS = {
  identity: 'Identity / Tribe Hook',
  problem: 'Problem / Pain Hook',
  curiosity: 'Pattern Interrupt / Curiosity Hook',
};

const HOOK_TYPE_INSTRUCTIONS = {
  identity: `Write this script using an Identity/Tribe hook — open by calling out who the viewer wants to become. This script must mirror the inspo transcript's structure as closely as possible: same sentence order, same sentence lengths, same transitions, same rhythm, essentially adapted line-by-line to the new product. Only change the words that must change to fit the new product and niche. This is the one version of this script that stays this close to the transcript's exact wording; that is intentional and unique to this version.`,
  problem: `Write this script using a Problem/Pain hook. This version's opening line MUST be phrased as a direct question aimed straight at the viewer (for example starting with "Do you ever...", "Have you noticed...", "Why does...", "Ever feel like..."), calling out their exact frustration before they even knew this product existed. Beyond that required question format, take noticeably more creative freedom with the exact wording and structure than a tight transcript mirror would, as long as it still follows the same overall pacing energy and the pattern interrupt → agitation → solution → benefit → proof → CTA arc.`,
  curiosity: `Write this script using a Pattern Interrupt/Curiosity hook. This version's opening line MUST be phrased as a specific personal moment or anecdote (for example starting with "I did...", "The other day I...", "So this happened...", or a bizarrely specific number or detail) — never a question, never a direct statement addressed at the viewer. It must be something so unexpected or specific they physically cannot scroll past it. Beyond that required anecdote format, take creative freedom with the exact structure, while still matching the inspo video's overall energy, pacing, and the same core arc.`,
};

const VIDEO_STYLE_RULES = `You will also be given a VIDEO STYLE, which changes how the hook, body, and cta text, the visual hook, and the overlays must be written:
- talking_head: the default. One creator speaks directly to camera the entire time, exactly as described above.
- skit: write the hook, body, and cta as a short back-and-forth dialogue between two people. Every line must start with "PERSON 1:" or "PERSON 2:", separated by line breaks (escaped as \\n in the JSON string). Give Person 1 and Person 2 distinct, consistent roles across the whole script (for example, one skeptical and one convincing them, or one asking and one answering, or a customer and a friend). All of the psychological hook framework, pacing, and CTA rules still apply, just delivered as dialogue instead of a monologue. The visualHook and overlays must describe the setup for both people (who is where, what each is doing) instead of a single person's action.
- faceless: the creator's face must never appear on camera and must never be referenced anywhere in the visualHook, overlays, or productionPointers (no "look at camera", "your face", "your expression", eye contact, or similar). The hook, body, and cta are still narrated by a single voiceover exactly like talking_head, but everything described in the visualHook, overlays, and productionPointers must be hands, product shots, screen recordings, text on screen, or b-roll footage only. Build every visual instruction around that constraint.`;

function buildSingleScriptSystemPrompt(hookType) {
  return `You are an expert TikTok Shop affiliate script writer trained on the buyer psychology framework of Dustin Davis, one of the top TikTok Shop educators. You understand that people do not buy products — they buy identity, status, belonging, attraction, and the resolution of deep biological desires.

Your script follows these principles:
${SCRIPT_PRINCIPLES}

${HOOK_TYPE_INSTRUCTIONS[hookType]}

${VIDEO_STYLE_RULES}

Respond with ONLY valid JSON — no markdown code fences, no commentary before or after — matching this exact schema for this one script:

{
  "hookType": "${hookType}",
  "hookTypeLabel": "${HOOK_TYPE_LABELS[hookType]}",
  "hook": string (the [HOOK] section — 1-3 sentences, the pattern-interrupt opener),
  "body": string (the [BODY] section — problem agitation, product as the solution, specific benefit with sensory detail, casual social proof),
  "cta": string (the [CTA] section — urgency-based close mirroring the inspo video's real CTA phrasing and the platform's actual UI, e.g. "tap the orange cart" — never a specific price or dollar amount),
  "speakTimeSeconds": number (estimated seconds to speak the full script at natural pace, between 15 and 30),
  "overlays": [ { "time": "0:00", "type": "text_hook" | "visual", "text": "..." } ] (3 to 4 items total. Exactly ONE item has type "text_hook": it must be first, timed at 0:00-0:02, and its text is bold on-screen text that reinforces the spoken hook, word for word or nearly so. Every other item, 2 to 3 of them, has type "visual": a specific reference photo, image, or footage cutaway to show at that exact moment, directly matching whatever specific visual comparison, feature, ingredient, or result is being spoken right then. Example: if the line says "if your skin looks like this," the visual overlay is a close-up reference photo of that exact described condition. If a line names an ingredient, the visual overlay is a close-up of that ingredient or its packaging. If a line describes a result or transformation, the visual overlay is a photo of that result. Never make a "visual" item a generic text callout, price graphic, or arrow graphic; it must describe an actual image or footage cutaway tied precisely to the words being spoken at that timestamp.),
  "visualHook": string (ONE short, plain, casual instruction describing what to visually show WHILE delivering the opening hook line, never a silent action before speaking; there must be zero dead air at the start of the video, so always phrase it starting with "While saying your first line, " followed by the specific action, e.g. "While saying your first line, zoom in close on your bare lashes, no mascara." or "While saying your first line, hold the box up next to your face." When it fits naturally, lead with the actual result or finished look rather than an abstract prop shot; showing the outcome first is what stops the scroll hardest. No more than about 18 words total. Do not write a cinematic, technical, or overly descriptive paragraph.),
  "productionPointers": [string, string] (exactly 2 specific tips to make this video perform better, based on the product and niche)
}

Output nothing but the JSON object.

Critical formatting rule: the output must be strictly valid, parseable JSON. Every string value must be on a single logical line — escape any line breaks inside a string as \\n and escape any double quote characters inside a string as \\". Never include a raw, unescaped newline or unescaped quote character inside a string value.`;
}

const VIDEO_STYLE_LABELS = {
  talking_head: 'Talking Head (one person, direct to camera)',
  skit: 'Skit (two people, dialogue)',
  faceless: 'Faceless (no face ever on camera)',
};

function buildUserPrompt({ transcript, productInfo, niche, videoStyle }) {
  return `INSPO VIDEO TRANSCRIPT (treat this as the template — mirror its exact structure, sentence order, and pacing as closely as possible, adapting it line-by-line to the product below rather than just taking inspiration from it):
"""
${transcript}
"""

PRODUCT INFORMATION:
"""
${productInfo}
"""

NICHE: ${niche}
VIDEO STYLE: ${videoStyle} — ${VIDEO_STYLE_LABELS[videoStyle] || videoStyle}

Write the script now, following the system instructions exactly, including the video-style-specific formatting rules for "${videoStyle}". Keep it tight and short — do not pad it out longer than the transcript above. Respond with ONLY the JSON object described in the schema.`;
}

const RESEARCH_SYSTEM_PROMPT = `You are a product researcher for a TikTok Shop affiliate script writer. You will be given a product name and whatever sparse information is already known about it. Use web search to find out what this exact product actually is, what it does, its real ingredients or features, and any real claims made about it.

Respond with a short, plain-text paragraph (4-6 sentences) of verified, specific facts about this exact product that a script writer could use. Do not write JSON. Do not write a script. Just the verified facts, written plainly. If you cannot find anything more specific than what was already given, say so honestly in one sentence rather than inventing details.`;

function buildResearchPrompt({ productInfo, niche }) {
  return `WHAT WE ALREADY KNOW:
"""
${productInfo}
"""

NICHE: ${niche}

Research this exact product and summarize verified facts as instructed.`;
}

async function researchProduct({ productInfo, niche }) {
  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: RESEARCH_SYSTEM_PROMPT,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
      messages: [{ role: 'user', content: buildResearchPrompt({ productInfo, niche }) }],
    });
    return message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text || '')
      .join('')
      .trim();
  } catch (err) {
    console.error('[Research] ', err.message);
    return '';
  }
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

// Backstop in case the model still slips one in despite the system prompt rule.
function stripEmDashes(scripts) {
  const clean = (s) => (typeof s === 'string' ? s.replace(/\s*—\s*/g, ', ').replace(/,\s*,/g, ',') : s);
  return scripts.map((s) => ({
    ...s,
    hookTypeLabel: clean(s.hookTypeLabel),
    hook: clean(s.hook),
    body: clean(s.body),
    cta: clean(s.cta),
    visualHook: clean(s.visualHook),
    productionPointers: Array.isArray(s.productionPointers) ? s.productionPointers.map(clean) : s.productionPointers,
    overlays: Array.isArray(s.overlays) ? s.overlays.map((o) => ({ ...o, text: clean(o.text) })) : s.overlays,
  }));
}

// Guards against Claude occasionally dropping a required field for one script
// (e.g. omitting "hook") without breaking the JSON itself.
function isValidScript(s) {
  return Boolean(
    s &&
      typeof s.hook === 'string' && s.hook.trim() &&
      typeof s.body === 'string' && s.body.trim() &&
      typeof s.cta === 'string' && s.cta.trim() &&
      typeof s.hookTypeLabel === 'string' && s.hookTypeLabel.trim() &&
      typeof s.visualHook === 'string' && s.visualHook.trim() &&
      Array.isArray(s.overlays) && s.overlays.length > 0 &&
      Array.isArray(s.productionPointers) && s.productionPointers.length > 0
  );
}

// Thrown when Claude declines to write scripts (e.g. the scraped product info
// was garbage, not a real product description) instead of a transient failure.
class BadProductInfoError extends Error {}

async function generateOneScript({ hookType, transcript, productInfo, niche, videoStyle }) {
  const maxAttempts = 3;
  let lastErr;
  const systemPrompt = buildSingleScriptSystemPrompt(hookType);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2200,
        system: systemPrompt,
        messages: [{ role: 'user', content: buildUserPrompt({ transcript, productInfo, niche, videoStyle }) }],
      });

      const raw = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text || '')
        .join('');
      const parsed = extractJson(raw);

      if (!isValidScript(parsed)) {
        console.error(`[Claude ${hookType} raw response, stop_reason=${message.stop_reason}]:`, raw.slice(0, 4000));

        if (!raw.trim().startsWith('{')) {
          // Claude wrote prose instead of JSON — almost always means it declined
          // because the scraped product info wasn't usable. Retrying with the
          // same bad input would just fail identically, so bail out immediately.
          throw new BadProductInfoError('The scraped product info was not usable.');
        }

        throw new Error(
          `Unexpected response format for the ${hookType} script (stop_reason: ${message.stop_reason}).`
        );
      }

      return stripEmDashes([parsed])[0];
    } catch (err) {
      if (err instanceof BadProductInfoError) throw err;
      lastErr = err;
      console.error(
        `[Claude ${hookType} attempt ${attempt}/${maxAttempts}] status=${err.status || 'n/a'} message=${err.message}`
      );
      if (attempt < maxAttempts) await sleep(1000 * attempt);
    }
  }

  throw lastErr;
}

async function generateScripts({ transcript, productInfo, niche, videoStyle, useWebSearch }) {
  // Only do the (slower) web-search-backed research pass when we don't
  // already have solid product info — then hand the same verified facts to
  // all 3 writers so they stay consistent with each other.
  let enrichedProductInfo = productInfo;
  if (useWebSearch) {
    const verifiedFacts = await researchProduct({ productInfo, niche });
    if (verifiedFacts) {
      enrichedProductInfo = productInfo + '\n\nVerified Research Findings: ' + verifiedFacts;
    }
  }

  const hookTypes = ['identity', 'problem', 'curiosity'];
  return Promise.all(
    hookTypes.map((hookType) =>
      generateOneScript({ hookType, transcript, productInfo: enrichedProductInfo, niche, videoStyle })
    )
  );
}

// ---------------------------------------------------------------------------
// STEP 5 — Revise a single already-generated script based on specific feedback.
// ---------------------------------------------------------------------------
const REVISION_SYSTEM_PROMPT = `You are revising one existing TikTok Shop affiliate script based on specific feedback from the creator.

Your job: apply ONLY the requested change, and preserve everything else about the script that already works — its structure, its specific claims, its length, its overall message. Do not rewrite it from scratch. Do not undo anything that the feedback didn't ask you to change.

All of these rules still apply to the revised version, with no exceptions:
- Never use the em dash character (—) anywhere in the output, in any field. Use a period, comma, or "and" instead.
- Never use these words or phrases anywhere in the output: delve, leverage, utilize, harness, streamline, underscore, navigate, elevate, empower, showcase, showcasing, boasts, pivotal, robust, seamless, cutting-edge, game-changer, groundbreaking, vibrant, renowned, multifaceted, meticulous, intricate, paramount, noteworthy, landscape, realm, tapestry, synergy, ecosystem, journey, testament, furthermore, moreover, "it's important to note", "in today's world", "at the end of the day".
- Never state a specific price or dollar amount anywhere in the script.
- Never repeat a long or formal product name multiple times; a real person says it once at most, then just says "this" or "it".
- Language must sound like a real person leaving a voice note for a friend, not a script.
- The visualHook must start with "While saying your first line, " followed by a specific, short action, no more than about 18 words.
- Exactly one overlay has type "text_hook" (always first, timed at 0:00), and every other overlay has type "visual" and describes a specific reference photo, image, or footage cutaway tied precisely to what's being said at that moment, never a generic text callout.

Respond with ONLY valid JSON matching this exact schema, no markdown code fences, no commentary before or after:

{
  "hookType": "identity" | "problem" | "curiosity",
  "hookTypeLabel": string,
  "hook": string,
  "body": string,
  "cta": string,
  "speakTimeSeconds": number,
  "overlays": [ { "time": "0:00", "type": "text_hook" | "visual", "text": "..." } ],
  "visualHook": string,
  "productionPointers": [string, string]
}

Output nothing but the JSON object.`;

function buildRevisionPrompt({ script, revisionNote }) {
  return `ORIGINAL SCRIPT (as JSON):
${JSON.stringify(script)}

REQUESTED CHANGE:
"${revisionNote}"

Apply this change and return the complete revised script as JSON, keeping everything else the same unless the change requires adjusting it too. Respond with ONLY the JSON object.`;
}

async function reviseScript({ script, revisionNote }) {
  const maxAttempts = 3;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        system: REVISION_SYSTEM_PROMPT,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
        messages: [{ role: 'user', content: buildRevisionPrompt({ script, revisionNote }) }],
      });

      const raw = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text || '')
        .join('');
      const parsed = extractJson(raw);

      if (!isValidScript(parsed)) {
        console.error(`[Revise raw response, stop_reason=${message.stop_reason}]:`, raw.slice(0, 4000));
        throw new Error(`Unexpected response format from the revision (stop_reason: ${message.stop_reason}).`);
      }

      return stripEmDashes([parsed])[0];
    } catch (err) {
      lastErr = err;
      console.error(`[Revise attempt ${attempt}/${maxAttempts}] status=${err.status || 'n/a'} message=${err.message}`);
      if (attempt < maxAttempts) await sleep(1000 * attempt);
    }
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
function buildMultiVideoTranscript({ resolvedTranscripts, hookSource, bodySource, ctaSource }) {
  if (resolvedTranscripts.length === 1) {
    return resolvedTranscripts[0];
  }

  const blocks = resolvedTranscripts
    .map((t, i) => `VIDEO ${i + 1} TRANSCRIPT:\n"""\n${t}\n"""`)
    .join('\n\n');

  return `${blocks}

SOURCE ASSIGNMENT (which video's real content and style to model each section on — blend these into one script that reads as one continuous, natural piece, not disconnected chunks stapled together):
- HOOK section: model it closely on VIDEO ${hookSource}'s transcript above — its opening style, energy, and pacing.
- BODY section: model it closely on VIDEO ${bodySource}'s transcript above — its structure, rhythm, and how it builds its case.
- CTA section: model it closely on VIDEO ${ctaSource}'s transcript above — its closing style and energy.`;
}

app.post('/api/generate', async (req, res) => {
  try {
    const {
      videos,
      hookSource,
      bodySource,
      ctaSource,
      productName,
      productUrl,
      price,
      niche,
      videoStyle,
      fallbackBenefits,
    } = req.body || {};

    if (!price || !niche) {
      return res.status(400).json({ success: false, error: 'Price and niche are required.' });
    }
    if (!productName || !productName.trim()) {
      return res.status(400).json({ success: false, error: 'Product name is required.' });
    }
    if (!videoStyle || !['talking_head', 'skit', 'faceless'].includes(videoStyle)) {
      return res.status(400).json({ success: false, error: 'A valid video style is required.' });
    }

    const providedVideos = (Array.isArray(videos) ? videos : []).filter(
      (v) => v && ((v.url && v.url.trim()) || (v.fallbackTranscript && v.fallbackTranscript.trim()))
    );
    if (providedVideos.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one inspo video is required.' });
    }

    // Run every provided video's transcription and the product page scrape
    // all concurrently — none of them depend on each other.
    const transcriptPromises = providedVideos.map((v) =>
      (async () => {
        const fb = (v.fallbackTranscript || '').trim();
        if (fb) return { transcript: fb, needsFallback: false };
        try {
          const transcript = await getTranscriptFromTikTok(v.url.trim());
          return { transcript, needsFallback: false };
        } catch (err) {
          console.error('[TikTok/Whisper] ', err.message);
          return { transcript: '', needsFallback: true };
        }
      })()
    );

    const scrapePromise = (async () => {
      if (!productUrl || !productUrl.trim()) return '';
      try {
        return await scrapeProduct(productUrl.trim());
      } catch (err) {
        console.error('[Product scrape] ', err.message);
        return '';
      }
    })();

    const [videoResults, scrapedInfo] = await Promise.all([
      Promise.all(transcriptPromises),
      scrapePromise,
    ]);

    const fallbackNeededIndices = videoResults
      .map((v, i) => (v.needsFallback ? i : -1))
      .filter((i) => i !== -1);

    if (fallbackNeededIndices.length > 0) {
      return res.json({
        success: false,
        needsTranscriptFallback: true,
        needsProductFallback: false,
        fallbackNeededIndices,
        transcriptMessage:
          "We couldn't pull that video directly — paste the transcript or describe the video style below",
      });
    }

    const resolvedTranscripts = videoResults.map((v) => v.transcript);
    const videoCount = resolvedTranscripts.length;
    const clampSource = (n) => Math.min(Math.max(parseInt(n, 10) || 1, 1), videoCount);
    const transcript = buildMultiVideoTranscript({
      resolvedTranscripts,
      hookSource: clampSource(hookSource),
      bodySource: clampSource(bodySource),
      ctaSource: clampSource(ctaSource),
    });

    const productInfo = buildProductContext({
      productName: productName.trim(),
      scrapedInfo,
      extraDetails: (fallbackBenefits || '').trim(),
    });

    // Skip the web search tool when we already have solid product info to
    // work with — it only needs to fill gaps, and skipping it when there's
    // nothing to fill saves several seconds of unnecessary search round-trips.
    const hasSubstantialProductInfo =
      Boolean(scrapedInfo && scrapedInfo.trim()) || (fallbackBenefits || '').trim().length > 20;

    try {
      const scripts = await generateScripts({
        transcript,
        productInfo,
        niche,
        videoStyle,
        useWebSearch: !hasSubstantialProductInfo,
      });
      return res.json({ success: true, scripts, transcripts: resolvedTranscripts });
    } catch (err) {
      if (err instanceof BadProductInfoError) {
        return res.json({
          success: false,
          needsTranscriptFallback: false,
          needsProductFallback: true,
          productMessage:
            "We couldn't pin down enough real detail on that exact product — double-check the product name spelling, or add specifics in the \"Additional details\" box below, then try again",
        });
      }
      throw err;
    }
  } catch (err) {
    console.error('[Generate] ', err);
    return res.status(500).json({
      success: false,
      error: 'Something went wrong generating your scripts. Please try again in a moment.',
    });
  }
});

app.post('/api/revise', async (req, res) => {
  try {
    const { script, revisionNote } = req.body || {};
    if (!script || typeof script !== 'object') {
      return res.status(400).json({ success: false, error: 'Original script is required.' });
    }
    if (!revisionNote || !revisionNote.trim()) {
      return res.status(400).json({ success: false, error: 'Please describe what you want changed.' });
    }

    const revised = await reviseScript({ script, revisionNote: revisionNote.trim() });
    return res.json({ success: true, script: revised });
  } catch (err) {
    console.error('[Revise] ', err);
    return res.status(500).json({
      success: false,
      error: 'Something went wrong revising this script. Please try again.',
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`GoViral Script Writer running at http://localhost:${PORT}`);
});
