/**
 * Schedule Trend — Apps Script backend
 *
 * Parses weekly trim/paint/meter (and eventually foundation/framing/etc.)
 * schedule PDFs into structured per-house records and stores one snapshot
 * row per house per week, so trends can be queried across weeks later.
 * The PDF itself is sent straight to Claude (native PDF reading) — no
 * client-side text extraction needed. Claude also reads the schedule's own
 * date off the document and returns it, so no manual week-date entry.
 *
 * SETUP:
 * 1. Create a new Google Sheet. Add one tab named exactly "Snapshots" with
 *    this header row (row 1):
 *      weekDate | address | subdivision | stage | statusDate | matlArrivalDate | matl | labor | notes
 * 2. Extensions > Apps Script from inside that Sheet, paste this whole file in.
 * 3. Project Settings > Script Properties, add:
 *      ANTHROPIC_API_KEY   = your real key from platform.claude.com
 *      APP_TOKEN           = a fresh long random string (don't reuse the Scope
 *                            Deviation one — keep tools on separate tokens so a
 *                            leak in one doesn't touch the other)
 * 4. Update SHEET_ID below to this new sheet's ID (from its URL).
 * 5. Deploy > New deployment > "Web app". Execute as: Me. Who has access: Anyone.
 *    Copy the Web app URL for the front-end.
 *
 * Same rate-limit pattern as the Scope Deviation backend: reads are cheap,
 * writes are tighter, AI parsing calls are strictest since each one costs
 * real Anthropic API spend, plus a per-day ceiling on top of the per-minute one.
 */

const SHEET_ID = '1v3uaSxTQI6VApd3t80XcmAJtyMG8e3ofQ1mUbsMp6qw';
const SNAPSHOTS_SHEET = 'Snapshots';
const CLAUDE_MODEL = 'claude-sonnet-5';

// Canonical stage order, furthest-along first — matches how the sheet itself
// is laid out top (most complete) to bottom (least far along).
const STAGE_ORDER = [
  'HOLD PAINT', 'Paint Ready/Painting', "Trimm'd", 'Triming', 'Trim Ready-HOLD', 'Trim Rdy',
  "Tape'g", 'Hung', 'Batts', 'RI Passed', 'ReRI Inspect', 'RI Inspect',
  'E-Mech', 'Furdown', 'P-Mech', 'M-Mech', 'Roof',
];

// ---------- Rate limiting (same pattern as Scope Deviation backend) ----------

const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_MAX_READS = 60;
const RATE_LIMIT_MAX_WRITES = 20;
const RATE_LIMIT_MAX_AI = 10;
const AI_DAILY_CAP = 50; // this tool parses ~once/week per source doc, 50/day is a generous ceiling

function checkRateLimit(bucket, max) {
  const cache = CacheService.getScriptCache();
  const key = 'rl_' + bucket;
  const count = Number(cache.get(key) || 0);
  if (count >= max) throw new Error('Rate limit exceeded — too many requests, try again in a minute.');
  cache.put(key, String(count + 1), RATE_LIMIT_WINDOW_SEC);
}

function checkDailyAiCap() {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const key = 'ai_count_' + today;
  const count = Number(props.getProperty(key) || 0);
  if (count >= AI_DAILY_CAP) throw new Error('Daily AI request limit reached — resets tomorrow.');
  props.setProperty(key, String(count + 1));
}

// ---------- Entry points ----------

function doGet(e) {
  if (e.parameter.action === 'debugToken') {
    return respond({ raw: '[' + PropertiesService.getScriptProperties().getProperty('APP_TOKEN') + ']' });
  }
  if (e.parameter.action === 'version') {
    return respond({ version: 'effort-fix-v2' });
  }
  try {
    checkToken(e.parameter.token);
    checkRateLimit('read', RATE_LIMIT_MAX_READS);
    const action = e.parameter.action;
    if (action === 'listWeeks') return respond(listWeeks());
    if (action === 'getWeek') return respond(getWeek(e.parameter.weekDate));
    return respond({ error: 'Unknown action' });
  } catch (err) {
    return respond({ error: err.message });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    checkToken(body.token);
    const action = body.action;

    if (action === 'parseWeek') {
      checkRateLimit('ai', RATE_LIMIT_MAX_AI);
      checkDailyAiCap();
      return respond(parseWeek(body.pdfBase64));
    }
    if (action === 'saveWeek') {
      checkRateLimit('write', RATE_LIMIT_MAX_WRITES);
      return respond(saveWeek(body.weekDate, body.houses));
    }
    if (action === 'deleteWeek') {
      checkRateLimit('write', RATE_LIMIT_MAX_WRITES);
      return respond(deleteWeek(body.weekDate));
    }
    if (action === 'askQuestion') {
      checkRateLimit('ai', RATE_LIMIT_MAX_AI);
      checkDailyAiCap();
      return respond({ answer: askQuestion(body.question) });
    }
    return respond({ error: 'Unknown action' });
  } catch (err) {
    return respond({ error: err.message });
  }
}

function checkToken(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('APP_TOKEN');
  if (!token || token !== expected) throw new Error('Invalid or missing token');
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- Sheet helpers ----------

function getSheet() {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(SNAPSHOTS_SHEET);
}

// Sheets silently auto-converts date-looking text ("2026-08-13") into a real
// Date object on write, even though we send it as a string. This normalizes
// whatever comes back out — Date object or already-a-string — into one
// consistent "YYYY-MM-DD" string, so the front end never sees a mismatch.
function normalizeDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v;
}

const DATE_FIELDS = ['weekDate', 'statusDate', 'matlArrivalDate'];

function listWeeks() {
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  const weeks = new Set();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0]) weeks.add(normalizeDate(values[i][0]));
  }
  return Array.from(weeks).sort().reverse();
}

function getWeek(weekDate) {
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  return values.slice(1)
    .filter((row) => normalizeDate(row[0]) === weekDate)
    .map((row) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = DATE_FIELDS.includes(h) ? normalizeDate(row[i]) : row[i];
      });
      return obj;
    });
}

// ---------- Subdivision lookup ----------
// Deterministic street-name matching, confirmed against real schedule data.
// Kept out of the AI parsing step entirely — this doesn't need judgment,
// just a lookup, so it stays free and 100% consistent. Ranch Villas of
// Prairie Farms is deliberately absent: Chris tracks that one by building
// number, no street data exists to match against.
const SUBDIVISION_STREETS = {
  'Woodland Hills': ['EMERALD', 'LANGLEY', '114 TER', '114 PL', '114 ST'],
  'Canyon Lakes': ['59 TER', 'CLEAR CREEK', '60 TER', 'MCCORMICK', 'BELMONT', 'APACHE', 'ARAPAHOE', 'BARTH'],
  'Prairie Farms': ['PARK ST', 'ELM TER', 'WABASH', '164', 'ELMRIDGE', 'PENROSE'],
};

function lookupSubdivision(address) {
  if (!address) return '';
  // Strip the leading house number so a street fragment never accidentally
  // matches digits that happen to appear in a house number instead.
  const streetPart = address.replace(/^\d+\s*/, '').toUpperCase();
  for (const [subdivision, fragments] of Object.entries(SUBDIVISION_STREETS)) {
    if (fragments.some((f) => streetPart.indexOf(f) !== -1)) return subdivision;
  }
  return '';
}

function saveWeek(weekDate, houses) {
  const sheet = getSheet();
  // Remove any existing rows for this week first, so re-uploading a
  // corrected week overwrites rather than duplicates.
  const values = sheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (normalizeDate(values[i][0]) === weekDate) sheet.deleteRow(i + 1);
  }
  houses.forEach((h) => {
    sheet.appendRow([
      weekDate,
      h.address || '',
      h.subdivision || lookupSubdivision(h.address),
      h.stage || '',
      h.statusDate || '',
      h.matlArrivalDate || '',
      h.matl || '',
      h.labor || '',
      h.notes || '',
    ]);
  });
  return { ok: true, saved: houses.length };
}

function deleteWeek(weekDate) {
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  let removed = 0;
  for (let i = values.length - 1; i >= 1; i--) {
    if (normalizeDate(values[i][0]) === weekDate) {
      sheet.deleteRow(i + 1);
      removed++;
    }
  }
  return { ok: true, removed };
}

// ---------- Claude parsing ----------

function callClaudeWithPdf(systemPrompt, pdfBase64) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 20000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: 'Parse this schedule per your instructions.' },
        ],
      }],
    }),
    muteHttpExceptions: true,
  });
  const data = JSON.parse(response.getContentText());
  if (data.type === 'error') {
    throw new Error('Claude API error: ' + (data.error && data.error.message ? data.error.message : JSON.stringify(data.error)));
  }
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) {
    const reason = data.stop_reason ? ` (stop_reason: ${data.stop_reason})` : '';
    throw new Error('Claude did not return a usable answer' + reason + ' — try again, or the PDF may be too large for one request.');
  }
  let clean = textBlock.text.trim();
  clean = clean.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(clean);
}

// Plain-text version of the Claude call, for question-answering rather than
// structured extraction — no PDF, no JSON parsing of the response.
function callClaudeText(systemPrompt, userText) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    }),
    muteHttpExceptions: true,
  });
  const data = JSON.parse(response.getContentText());
  if (data.type === 'error') {
    throw new Error('Claude API error: ' + (data.error && data.error.message ? data.error.message : JSON.stringify(data.error)));
  }
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) {
    const reason = data.stop_reason ? ` (stop_reason: ${data.stop_reason})` : '';
    throw new Error('Claude did not return a usable answer' + reason + '.');
  }
  return textBlock.text.trim();
}

// Reads every saved snapshot row across every week, as compact CSV, and asks
// Claude to answer a plain-language question against it. This is the whole
// "query layer" for now — no pre-built filter translation, just the raw
// data handed over each time. Fine at this scale; would need rethinking if
// the sheet grows to many thousands of rows (token cost, mostly).
function askQuestion(question) {
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const rows = values.slice(1).filter((r) => r[0]);
  const csvLines = rows.map((row) => {
    return headers.map((h, i) => {
      const v = DATE_FIELDS.includes(h) ? normalizeDate(row[i]) : row[i];
      return v === '' || v === null || v === undefined ? '' : String(v).replace(/,/g, ';');
    }).join(',');
  });
  const csv = headers.join(',') + '\n' + csvLines.join('\n');

  const system = `You are helping a residential home builder superintendent answer questions about his weekly trim/paint/meter schedule tracking data. You'll be given the full dataset as CSV — one row per house per week snapshot (the same house appears multiple times across different weekDates as it progresses).

Stage progression, MOST progressed to LEAST progressed: ${STAGE_ORDER.join(', ')}.

Answer the question directly and conversationally in a few sentences — not a report, not bullet points unless genuinely needed for a list of several houses. Reference specific addresses and dates from the data to back up your answer. If the data doesn't contain enough weeks or enough information to answer confidently, say so plainly rather than guessing — for example, if asked which house has been stuck longest but there's only one week of data for it, say you can't tell yet rather than picking one.`;

  return callClaudeText(system, `DATA:\n${csv}\n\nQUESTION: ${question}`);
}

function parseWeek(pdfBase64) {
  const system = `You are helping a residential home builder superintendent turn a weekly trim/paint/meter schedule PDF into clean structured data, one record per house, plus the schedule's own date.

FORMAT NOTES ABOUT THE SOURCE:
- The sheet is laid out as two side-by-side columns on the printed page.
- Page titles, section labels, and footnotes (e.g. "PRIEB HOMES - TRIM/PAINT & METER SCHEDULE", "Trim Labor", "TRIM STAGE - Avg 5 Days to trim a house", "PAINT STAGE - Hold off releasing Paint Sheets until time to paint") are page furniture, not house rows — exclude them.
- Rows are ordered top-to-bottom from MOST progressed (e.g. Paint Ready/Painting) to LEAST progressed (e.g. Roof, the earliest stage) — this is intentional, not alphabetical.
- The document has a date near the top (e.g. "TRIM 8/13/2026") — this is the schedule's own date. Extract it as "weekDate" in YYYY-MM-DD format at the top level of your response.

STAGE VOCABULARY — normalize every stage to exactly one of these canonical names, ordered furthest-along to least-progressed:
  "Paint Ready/Painting", "HOLD PAINT" (paint-stage hold, parallel to Trim Ready-HOLD),
  "Trimm'd", "Trim Rdy" (aliases: "Trim Ready"), "Trim Ready-HOLD",
  "Triming" (aliases: "Trim'g" — labor actively working on site),
  "Tape'g" (drywall taping, happens after drywall is hung and before Trim Ready),
  "Hung" (drywall hung), "Batts" (insulation),
  "RI Passed" (rough inspection completed and passed — this is an UNCOMMON status; only use it when the row explicitly indicates the inspection passed but the house hasn't yet moved to a Batts/Hung date, i.e. it's being held there. Most rows that are past rough inspection will already show a Batts or Hung stage instead — don't use "RI Passed" just because a house is further along, only when the row itself indicates this specific held status),
  "RI Inspect" (awaiting or scheduled for rough inspection — this is the common/default status when an inspection is referenced without a pass indicated),
  "ReRI Inspect", "E-Mech" (electrical rough-in), "Furdown" (aliases: "Fur" — a carpentry/framing step that boxes in clearance for ductwork; happens after plumbing rough-in and before electrical rough-in), "P-Mech" (plumbing rough-in), "M-Mech" (mechanical/HVAC rough-in), "Roof"
If you encounter a stage name not in this list, keep it as written and flag it in "notes" as "unrecognized stage — verify".

STALE-STATUS CORRECTION RULE (important — this fixes a real, common data-entry lag): the Mat'l/Décor flag column (see "matl" below) only ever gets filled in once a house is genuinely ready for paint. But the person maintaining this sheet doesn't always update the Status text at the same time they add that flag, so a row can literally say a trim-tier stage while the house has actually already moved on to paint. Apply this correction:
- If a row's literal stage text is "Trim Rdy"/"Trim Ready", "Triming"/"Trim'g", or "Trimm'd" (any trim-tier stage), AND the Mat'l/Décor flag column has ANY value filled in (Have, NEED, or HOLD) — the stage text is stale. Override "stage" to "Paint Ready/Painting" (or "HOLD PAINT" specifically if the flag value is "HOLD"), NOT the literal trim-tier text.
- Always still capture the actual flag value in "matl" as normal — don't repeat it in the note, it's already visible in that field.
- Add a brief note flagging that a correction happened, e.g. "auto-corrected from stale status" — keep it short, don't restate the original stage text or flag value since those are redundant with other fields in the row.
- This rule does NOT apply to rows earlier in the pipeline (Hung, Batts, mechanical stages, etc.) — only to the trim-tier stages listed above, since that's specifically where this lag happens.

DATE COLUMN RULES (this is the part that's easy to get wrong):
- The date printed immediately next to/after the stage name is the STATUS DATE — the date the house reached that stage. Map this to "statusDate".
- A second date, when present, sits near/under the Mat'l column and is the MATERIAL ARRIVAL DATE — when trim material physically arrived on site. Map this to "matlArrivalDate". Do NOT confuse it with statusDate even when the two are close together or identical.
- Dates are written M.D. with no year. Use the same year as the schedule's own date (weekDate) unless the month would put it clearly in a different year given the context — do not guess a different year without strong evidence.

OTHER FIELDS:
- "matl": the material/paint-sheet flag in that column. Common values are "Have", "NEED", and "HOLD" — use whatever short flag word literally appears, don't invent one. Only set it if explicitly present in the row. (See the stale-status correction rule above — this flag's presence can override the stage.)
- "labor": the assigned trim carpenter. The sheet uses shorthand codes — decode them to the actual name: any code starting with "R" (e.g. "R-1", "R-2") means the carpenter Randy; any code starting with "X" (e.g. "X-1", "X-2") means the carpenter Rod. Set "labor" to the decoded name ("Randy" or "Rod"), not the raw code.
  - If the code has a "?" in place of the sequence number (e.g. "R-?", "X-?"): this is a KNOWN, EXPECTED pattern meaning genuine real-world scheduling uncertainty (not a parsing problem). Keep the raw code as written and add "labor assignment uncertain (?)" to notes — do NOT use the word "verify" here, since this doesn't need anyone's review, it's just accurately reflecting a normal, already-understood situation.
  - If the code uses some other character or format you don't recognize at all (something other than the "?" pattern above): that's a genuine parsing gap. Keep the raw code as written and add "labor code unclear — verify" to notes, since this one DOES need a human to look at it and possibly teach the parser something new.
- "note": short freeform tag like "PUMP HOUSE" or a unit/lot marker if present right after the address, otherwise omit.
- "subdivision": leave blank/omit — this source document doesn't contain it; do not guess.

Return ONLY a JSON object, no prose, no markdown fences:
{"weekDate": "YYYY-MM-DD", "houses": [{"address": string, "note": string or omit, "stage": string, "statusDate": "YYYY-MM-DD" or omit, "matlArrivalDate": "YYYY-MM-DD" or omit, "matl": string or omit, "labor": string or omit, "notes": string or omit}]}`;

  return callClaudeWithPdf(system, pdfBase64);
}
