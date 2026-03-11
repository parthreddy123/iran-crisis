#!/usr/bin/env node
/**
 * Visual QA Tool — Automated slide-by-slide critique + fix loop
 *
 * Usage:
 *   node visual-qa.js [options]
 *
 * Options:
 *   --file <path>        HTML file to review (default: index.html)
 *   --slides <range>     Slide range, e.g. "0-10" or "3,5,7" (default: all)
 *   --max-iterations <n> Max fix iterations per slide (default: 2)
 *   --output <dir>       Screenshot output dir (default: ./qa-screenshots)
 *   --critique-only      Only critique, don't fix
 *   --verbose            Show full LLM responses
 *
 * Requires: ANTHROPIC_API_KEY in environment or .env file
 */

const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk').default;
const fs = require('fs');
const path = require('path');

// Load .env if present
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const [key, ...val] = line.split('=');
      if (key && val.length) process.env[key.trim()] = val.join('=').trim();
    });
  }
} catch (e) {}

const CRITIQUE_PRINCIPLES = `
You are a senior visual design and content critic reviewing slides from a web-based strategic briefing.

Apply these 9 principles to EVERY slide screenshot:

1. **"So what" over description** — Every label, metric, text should tell the strategic implication, not just describe what happened.
2. **Map/chart legibility** — Labels can't overlap, can't be off-screen, can't be unreadable. Charts must have clear axes and legends.
3. **Visual aesthetics** — No ugly solid colored boxes, no clashing colors, no visual clutter. Clean, professional design.
4. **Clean information architecture** — Content should be logically organized. Don't cram too much into one view.
5. **Zoom/framing** — Maps should be zoomed appropriately. Charts should show the right time range. Nothing important should be cut off.
6. **Metrics should quantify impact** — Numbers that make someone sit up, not generic counts. "45,000 US troops in range" > "Multiple bases targeted".
7. **Strategic framing** — Every element earns its space by answering "why does this matter?"
8. **Avoid jargon** — NO consultant buzzwords like "paradigm shift", "synergies", "structural asymmetries", "cascading implications". Plain, sharp English.
9. **Verifiable data** — Every number must be sourceable. Flag any statistics that look fabricated or unverifiable.
10. **Charts need event markers** — Every time-series chart should have annotated markers for key events (strikes, sanctions, interventions). A bare line chart with no context is useless.
11. **Maps must tell the story** — Each map marker needs a "what happened here" callout, not just a dot. Zoom to the action, not the whole region.
12. **Decision-maker utility** — Would a VP of Strategy at an Indian refinery find this actionable? If not, what's missing? Add company names (RIL, BPCL, HPCL), sector-specific impacts, and decision trees where appropriate.
13. **Data must be pullable** — If a live widget or API isn't loading, flag it. Replace with static data + timestamp rather than showing a blank widget.

For each screenshot, respond in this EXACT JSON format:
{
  "score": <1-10>,
  "issues": [
    {
      "severity": "high|medium|low",
      "element": "<what element has the issue — be specific>",
      "problem": "<what's wrong>",
      "fix": "<exactly what to change — be specific enough to search/replace>"
    }
  ],
  "praise": "<what works well — 1 sentence>"
}

If the slide scores 8+ with no high-severity issues, return empty issues array.
Be ruthless. A McKinsey partner and a UI designer are both looking over your shoulder.
`;

const FIX_PROMPT = `
You are editing an HTML file to fix visual/content issues found by a design critic.
You will receive the current HTML content and a list of issues to fix.
Return ONLY the specific search-and-replace operations needed, in this JSON format:
{
  "fixes": [
    {
      "search": "<exact string to find in the HTML>",
      "replace": "<replacement string>"
    }
  ]
}

Rules:
- The "search" string must be EXACTLY as it appears in the HTML (including whitespace)
- Only fix the issues listed — don't make other changes
- Keep fixes minimal and targeted
- Don't change JavaScript functions, CSS, or page structure
- Only change text content, metrics, labels, descriptions
`;

async function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    file: 'index.html',
    slides: null,
    maxIterations: 2,
    output: './qa-screenshots',
    critiqueOnly: false,
    verbose: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--file': opts.file = args[++i]; break;
      case '--slides': opts.slides = args[++i]; break;
      case '--max-iterations': opts.maxIterations = parseInt(args[++i]); break;
      case '--output': opts.output = args[++i]; break;
      case '--critique-only': opts.critiqueOnly = true; break;
      case '--verbose': opts.verbose = true; break;
    }
  }
  return opts;
}

function parseSlideRange(rangeStr, total) {
  if (!rangeStr) return Array.from({ length: total }, (_, i) => i);
  if (rangeStr.includes('-')) {
    const [a, b] = rangeStr.split('-').map(Number);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  return rangeStr.split(',').map(Number);
}

async function captureSlides(htmlPath, outputDir, slideIndices) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 414, height: 896 } });

  const fileUrl = `file:///${htmlPath.replace(/\\/g, '/')}`;
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const cards = await page.$$('.card');
  const screenshots = [];

  for (const idx of slideIndices) {
    if (idx >= cards.length) continue;
    const card = cards[idx];
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500); // wait for maps/charts to render

    const screenshotPath = path.join(outputDir, `slide-${idx}.png`);
    await card.screenshot({ path: screenshotPath });
    screenshots.push({ index: idx, path: screenshotPath });
    console.log(`  📸 Captured slide ${idx}`);
  }

  await browser.close();
  return screenshots;
}

async function critiqueSlide(client, screenshotPath, slideIndex) {
  const imageData = fs.readFileSync(screenshotPath);
  const base64 = imageData.toString('base64');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `${CRITIQUE_PRINCIPLES}\n\nThis is slide ${slideIndex}. Critique it:` },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }
      ]
    }]
  });

  const text = response.content[0].text;
  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { score: 10, issues: [], praise: 'Could not parse response' };

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    return { score: 10, issues: [], praise: 'Could not parse JSON: ' + text.slice(0, 200) };
  }
}

async function generateFixes(client, htmlContent, issues, slideIndex) {
  const issueText = issues.map((iss, i) =>
    `${i + 1}. [${iss.severity}] ${iss.element}: ${iss.problem} → ${iss.fix}`
  ).join('\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `${FIX_PROMPT}\n\nIssues to fix on slide ${slideIndex}:\n${issueText}\n\nHTML content (relevant section — search for card${slideIndex} or nearby):\n\`\`\`html\n${htmlContent.slice(0, 50000)}\n\`\`\``
    }]
  });

  const text = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.fixes || [];
  } catch (e) {
    return [];
  }
}

function applyFixes(htmlContent, fixes) {
  let content = htmlContent;
  let applied = 0;

  for (const fix of fixes) {
    if (content.includes(fix.search)) {
      content = content.replace(fix.search, fix.replace);
      applied++;
    }
  }

  return { content, applied };
}

async function main() {
  const opts = await parseArgs();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY not set. Add it to .env or environment.');
    process.exit(1);
  }

  const client = new Anthropic();
  const htmlPath = path.resolve(opts.file);

  if (!fs.existsSync(htmlPath)) {
    console.error(`❌ File not found: ${htmlPath}`);
    process.exit(1);
  }

  // Create output dir
  if (!fs.existsSync(opts.output)) fs.mkdirSync(opts.output, { recursive: true });

  console.log(`\n🔍 Visual QA Tool`);
  console.log(`   File: ${htmlPath}`);
  console.log(`   Mode: ${opts.critiqueOnly ? 'Critique only' : 'Critique + Fix'}`);
  console.log(`   Max iterations: ${opts.maxIterations}\n`);

  // Count total slides
  let html = fs.readFileSync(htmlPath, 'utf8');
  const totalSlides = (html.match(/class="card"/g) || []).length;
  console.log(`   Total slides: ${totalSlides}\n`);

  const slideIndices = parseSlideRange(opts.slides, totalSlides);

  for (let iteration = 0; iteration < opts.maxIterations; iteration++) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📋 ITERATION ${iteration + 1}/${opts.maxIterations}`);
    console.log(`${'='.repeat(60)}\n`);

    // Capture screenshots
    console.log('📸 Capturing screenshots...');
    const iterDir = path.join(opts.output, `iter-${iteration + 1}`);
    if (!fs.existsSync(iterDir)) fs.mkdirSync(iterDir, { recursive: true });

    const screenshots = await captureSlides(htmlPath, iterDir, slideIndices);

    let totalIssues = 0;
    let highIssues = 0;
    const allFixes = [];

    // Critique each slide
    for (const ss of screenshots) {
      console.log(`\n--- Slide ${ss.index} ---`);

      const critique = await critiqueSlide(client, ss.path, ss.index);

      const scoreColor = critique.score >= 8 ? '🟢' : critique.score >= 5 ? '🟡' : '🔴';
      console.log(`  ${scoreColor} Score: ${critique.score}/10`);

      if (critique.praise) console.log(`  ✅ ${critique.praise}`);

      if (critique.issues && critique.issues.length > 0) {
        for (const issue of critique.issues) {
          const icon = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '🟡' : '⚪';
          console.log(`  ${icon} [${issue.severity}] ${issue.element}: ${issue.problem}`);
          if (opts.verbose) console.log(`     Fix: ${issue.fix}`);
          totalIssues++;
          if (issue.severity === 'high') highIssues++;
        }

        if (!opts.critiqueOnly) {
          allFixes.push({ slideIndex: ss.index, issues: critique.issues });
        }
      }
    }

    console.log(`\n📊 Iteration ${iteration + 1} Summary:`);
    console.log(`   Total issues: ${totalIssues} (${highIssues} high)`);

    // Apply fixes if not critique-only
    if (!opts.critiqueOnly && allFixes.length > 0 && iteration < opts.maxIterations - 1) {
      console.log(`\n🔧 Generating and applying fixes...`);

      html = fs.readFileSync(htmlPath, 'utf8');
      let totalApplied = 0;

      for (const { slideIndex, issues } of allFixes) {
        const highMedIssues = issues.filter(i => i.severity !== 'low');
        if (highMedIssues.length === 0) continue;

        const fixes = await generateFixes(client, html, highMedIssues, slideIndex);
        const { content, applied } = applyFixes(html, fixes);
        html = content;
        totalApplied += applied;
        console.log(`   Slide ${slideIndex}: ${applied}/${fixes.length} fixes applied`);
      }

      if (totalApplied > 0) {
        fs.writeFileSync(htmlPath, html);
        console.log(`\n   ✅ ${totalApplied} total fixes written to file`);
      } else {
        console.log(`\n   ⚠️  No fixes could be applied (search strings not found)`);
        break;
      }
    } else if (totalIssues === 0 || highIssues === 0) {
      console.log(`\n🎉 All slides pass! No high-severity issues.`);
      break;
    } else {
      break;
    }
  }

  console.log(`\n✅ Done. Screenshots in ${opts.output}/\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
