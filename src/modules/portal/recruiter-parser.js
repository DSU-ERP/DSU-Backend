// Rule-based reading of a recruiter's drive notice or job description.
// No AI: labels, section headings and value patterns only, so the same text
// always gives the same answer, costs nothing and cannot "invent" a value.
// Output has the same raw shape the drive and company normalisers validate;
// anything not found is empty, and anything uncertain becomes a note.

/** Job categories as the officer UI lists them, with words that suggest each. */
const CATEGORY_WORDS = [
  ["Software / IT", /\b(software|developer|programm\w*|full[- ]?stack|front[- ]?end|back[- ]?end|devops|cloud|sde|it services|web|mobile app|qa|test(ing)? engineer|systems? engineer|digital services)\b/i],
  ["Data & analytics", /\b(data (analyst|scien\w*|engineer\w*)|analytics|business intelligence|machine learning|\bml\b|\bai\b)\b/i],
  ["Core engineering", /\b(mechanical|civil|manufactur\w*|automobile|automotive|production engineer|design engineer|structural)\b/i],
  ["Electronics & hardware", /\b(electronics|embedded|vlsi|semiconductor|hardware|pcb|firmware)\b/i],
  ["Consulting", /\b(consult\w*|advisory)\b/i],
  ["Finance & banking", /\b(bank\w*|financ\w*|nbfc|fintech|insurance|investment|audit\w*|accounting)\b/i],
  ["Sales & marketing", /\b(sales|marketing|business development|bde)\b/i],
  ["Operations & supply chain", /\b(operations|supply chain|logistics|procurement)\b/i],
  ["Product & design", /\b(product manag\w*|ui\/?ux|ux|ui designer|product design\w*)\b/i],
  ["Research & development", /\b(research|r&d|r & d)\b/i],
  ["Teaching & education", /\b(teach\w*|education|edtech|tutor\w*|faculty)\b/i],
];

/** Campus branch codes and the ways notices write them. */
// More specific names come first: "computer science and technology" is CST, not CSE.
const BRANCHES = [
  ["AIML", /\b(ai\s*(&|and|-|\/)?\s*ml|aiml|artificial intelligence\s*(&|and)\s*machine learning)\b/i],
  ["CST", /\b(cst|computer science\s*(&|and)\s*technology)\b/i],
  ["CSE", /\b(cse|computer science(\s*(&|and)\s*engineering)?|c\.s\.e)\b/i],
  ["ISE", /\b(ise|information science(\s*(&|and)\s*engineering)?)\b/i],
  ["ECE", /\b(ece|electronics\s*(&|and)\s*communication(\s*engineering)?)\b/i],
  ["EEE", /\b(eee|electrical\s*(&|and)\s*electronics(\s*engineering)?)\b/i],
  ["ME", /\b(mechanical(\s*engineering)?|mech)\b/i],
  ["CV", /\b(civil(\s*engineering)?)\b/i],
  ["DS", /\b(data science)\b/i],
  ["CY", /\b(cyber\s*security)\b/i],
];

/** Industries suggested from the company's own description when no label gives one. */
const INDUSTRY_WORDS = [
  ["Financial technology", /\b(fintech|payments?)\b/i],
  ["Banking and financial services", /\b(bank\w*|nbfc|financial services|insurance)\b/i],
  ["Information technology", /\b(it services|software|digital services|technology services|cloud|saas|tech company)\b/i],
  ["Consulting", /\b(consulting firm|management consult\w*|advisory)\b/i],
  ["Semiconductors", /\b(semiconductor\w*|chip design|vlsi)\b/i],
  ["Automotive", /\b(automotive|automobile)\b/i],
  ["Manufacturing", /\b(manufactur\w*)\b/i],
  ["E-commerce", /\b(e-?commerce|online retail)\b/i],
  ["Telecommunications", /\b(telecom\w*)\b/i],
  ["Healthcare", /\b(healthcare|pharma\w*|hospital\w*)\b/i],
  ["Education", /\b(edtech|education)\b/i],
];

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const FREE_MAIL = /@(gmail|yahoo|outlook|hotmail|live|rediffmail|icloud|proton(mail)?)\./i;
const CAMPUS_MAIL = /@([a-z0-9-]+\.)*dsu\.edu\.in\b/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE = /(?:\+?91[\s-]?)?(?:\(?0\d{2,4}\)?[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b|\+91[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{4}\b/g;
const URL = /\b(?:https?:\/\/|www\.)[^\s|,;()<>"]+/gi;
const ROLE_WORDS = /\b(engineer|analyst|developer|intern|trainee|associate|consultant|executive|manager|designer|scientist|specialist|officer|architect|administrator|programmer|tester|sde)\b/i;

// Field labels. Order matters: longer, more specific labels first.
const LABELS = {
  company_name: /^(name of (the )?(company|organi[sz]ation)|company name|organi[sz]ation|employer|company)$/i,
  title: /^(job role|job title|role|designation|position|post|profile|job profile|role offered|position offered)$/i,
  package: /^(ctc|package|salary|compensation|remuneration|annual ctc|ctc offered|salary package|pay|ctc \(per annum\))$/i,
  stipend: /^(stipend|internship stipend)$/i,
  location: /^(job location|work location|location|place of posting|posting|work place|base location)$/i,
  drive_date: /^(drive date|date of (the )?(drive|test|assessment|interview|recruitment|visit)|test date|interview date|recruitment date|date of campus drive)$/i,
  registration_deadline: /^((last|closing) date (for|of|to) (registration|application|apply(ing)?|register)|registration deadline|application deadline|apply by|register by|deadline|last date)$/i,
  openings: /^((no\.?|number) of (openings|positions|vacancies|hires|seats)|openings|vacancies|positions|headcount)$/i,
  job_category: /^(job category|category|function|job function|domain)$/i,
  employment_type: /^(employment type|job type|type of employment|nature of job|engagement)$/i,
  industry: /^(industry|sector)$/i,
  headquarters: /^(headquarters|head office|hq|headquartered (in|at)|corporate office)$/i,
  website: /^(website|web ?site|url|company website)$/i,
  hr_name: /^(hr|hr name|hr contact|contact person|recruiter|spoc|hr spoc|point of contact|coordinator|hr coordinator|contact name)$/i,
  hr_email: /^(e-?mail|email id|hr e-?mail|contact e-?mail|mail)$/i,
  hr_phone: /^(phone|mobile|contact (no\.?|number)|phone (no\.?|number)|mobile (no\.?|number)|tel(ephone)?)$/i,
  backlogs: /^((active |current |standing )?backlogs?|arrears|history of arrears)$/i,
  cgpa: /^(cgpa|minimum cgpa|cgpa cut[- ]?off|cut[- ]?off|academic criteria|aggregate|cpi|gpa)$/i,
  branches: /^(eligible (branches|streams|departments|disciplines)|branch(es)?|streams?|disciplines?|departments?|eligible degrees?)$/i,
  skills: /^(skills?( required)?|required skills|technical skills|skill ?set|key skills|must have)$/i,
  required_documents: /^((required )?documents( required| to carry| to be carried)?|carry|things to carry)$/i,
};

// Section headings: the text under them belongs to one field.
const SECTIONS = [
  ["about", /^(about( us| the company| company| the organi[sz]ation)?|company (profile|overview)|who we are|overview)$/i],
  ["description", /^(job description|jd|roles? (and|&) responsibilities|responsibilities|key responsibilities|about the role|job summary|role description|what you will do|job details)$/i],
  ["eligibility", /^(eligibility( criteria)?|who can apply|academic criteria|eligibility requirements|criteria)$/i],
  ["rounds", /^(selection (process|procedure|rounds)|recruitment process|hiring process|interview process|selection rounds|rounds|process)$/i],
  ["skills", /^(skills?( required)?|required skills|technical skills|skill ?set|key skills|requirements|qualifications|desired (skills|profile))$/i],
  ["documents", /^((required )?documents( required| to carry)?|things to carry)$/i],
  ["contact", /^(contact( details| us| information)?|hr contact|for (queries|more details)|point of contact)$/i],
  ["compensation", /^(compensation|salary|ctc|package|compensation (and|&) benefits|benefits)$/i],
  ["dates", /^(important dates|schedule|timeline|drive schedule)$/i],
];

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").replace(/^[\s:\-–—|•*·]+|[\s:\-–—|•*·]+$/g, "").trim();
const strip = (label) => clean(label).toLowerCase().replace(/[.*]+$/g, "").replace(/\s*\(.*?\)\s*$/, (m) => (/per annum/i.test(m) ? m : "")).trim();
const bullet = /^\s*(?:[-–—•*·▪●◦]|\(?\d{1,2}[.)]|\(?[a-z][.)]|round\s*\d+\s*[:.-]?|step\s*\d+\s*[:.-]?)\s*/i;

/** Splits text into lines, and each line into table cells (tabs became " | "). */
function readLines(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => ({ text: line.trim(), cells: line.split(/\s+\|\s+/).map((c) => c.trim()).filter(Boolean) }))
    .filter((l) => l.text);
}

/** A line that is only a heading (optionally ending in ":"), or null. */
function headingOf(line) {
  const t = strip(line.replace(/:\s*$/, ""));
  if (t.length > 60 || line.split(/\s+/).length > 7) return null;
  for (const [name, re] of SECTIONS) if (re.test(t)) return name;
  return null;
}

/**
 * Label/value pairs: "Label: value", "Label - value", a table row
 * "Label | value", or a label alone on a line with its value on the next.
 */
function readPairs(lines) {
  const pairs = [];
  const fieldOf = (label) => {
    const t = strip(label);
    for (const [field, re] of Object.entries(LABELS)) if (re.test(t)) return field;
    return null;
  };
  lines.forEach((line, i) => {
    const { text, cells } = line;
    // Table rows: label cell then value cell(s), possibly several pairs per row.
    if (cells.length >= 2) {
      for (let c = 0; c < cells.length - 1; c++) {
        const field = fieldOf(cells[c].replace(/:\s*$/, ""));
        if (field) {
          pairs.push({ field, value: clean(cells[c + 1]), line: text });
          c++;
        }
      }
    }
    // Table rows whose cells were merged into one run: "Job Location Pune",
    // "Role Data Analyst Package 8 LPA". Split at each known label.
    if (cells.length < 2 && !/[:：]/.test(text) && !headingOf(text)) {
      const words = text.split(/\s+/);
      if (words.length <= 16) {
        const starts = [];
        for (let w = 0; w < words.length; w++) {
          if (!/^[A-Z]/.test(words[w])) continue;
          for (let k = Math.min(5, words.length - w - 1); k >= 1; k--) {
            const field = fieldOf(words.slice(w, w + k).join(" "));
            if (field) {
              starts.push({ at: w, k, field });
              w += k - 1;
              break;
            }
          }
        }
        if (starts[0]?.at === 0)
          starts.forEach((s, n) => {
            const value = clean(words.slice(s.at + s.k, starts[n + 1]?.at ?? words.length).join(" ")).replace(/\.$/, "");
            if (value) pairs.push({ field: s.field, value, line: text });
          });
      }
    }
    const parts = segments(text);
    for (const part of parts) {
      const colon = /^([^:]{2,50}?)\s*[:：]\s*(.*)$/.exec(part) || /^([A-Za-z][A-Za-z .()/&]{1,45}?)\s+[-–—]\s+(.+)$/.exec(part);
      if (!colon) continue;
      const field = fieldOf(colon[1]);
      if (!field) continue;
      let value = clean(colon[2]).replace(/\.$/, "");
      let source = text;
      // "Label:" alone on its line, value on the next.
      if (!value && parts.length === 1 && lines[i + 1] && !headingOf(lines[i + 1].text)) {
        value = clean(lines[i + 1].text);
        source = `${text} ${lines[i + 1].text}`;
      }
      if (value) pairs.push({ field, value, line: source });
    }
  });
  return pairs;
}

/** "Role: Engineer. CTC: 8 LPA. Location: Pune" → one part per label. */
function segments(text) {
  // Split after "." or ";" before another "Label:", or before a common label
  // word that is often written without a colon ("CTC 8 LPA").
  return text.split(/(?<=[.;])\s+(?=[A-Z][A-Za-z ()/&.-]{1,40}?\s*:|(?:CTC|Package|Salary|Stipend|Location|Eligibility|Rounds|Contact|Deadline)\b)/);
}

/** Text under each section heading, until the next heading. */
function readSections(lines) {
  const sections = {};
  let current = null;
  for (const line of lines) {
    // "For queries, contact ..." starts the contact details, not part of the role.
    if (/^for (any )?(queries|query|more (details|information)|further (details|information)|clarifications?)\b/i.test(line.text)) {
      current = "contact";
      (sections.contact ??= []).push(line.text);
      continue;
    }
    const heading = headingOf(line.text);
    if (heading) {
      current = heading;
      sections[current] ??= [];
      continue;
    }
    // "Rounds: Aptitude, Technical, HR", possibly after other labels on the line.
    let inlineHeading = false;
    for (const part of segments(line.text)) {
      const inline = /^([^:]{2,60}?)\s*:\s*(.+)$/.exec(part);
      const name = inline && headingOf(inline[1]);
      if (!name) continue;
      inlineHeading = true;
      current = name;
      (sections[current] ??= []).push(inline[2].trim().replace(/\.$/, ""));
    }
    if (!inlineHeading && current) sections[current].push(line.text);
  }
  return sections;
}

const first = (pairs, field) => pairs.find((p) => p.field === field);

/** Lakhs per annum from a package phrase. Returns { value, note } or null. */
export function parsePackage(raw) {
  const text = String(raw ?? "").replace(/,(?=\d{2})/g, "").toLowerCase();
  if (!text.trim()) return null;
  const perMonth = /(per month|\/ ?month|p\.?m\.?\b|monthly)/.test(text);
  const range = /(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(lpa|l\.p\.a|lakhs?|lacs?|\bl\b)/.exec(text);
  if (range) return { value: Number(range[1]), note: `Package is stated as a range (${range[1]}–${range[2]} LPA); the lower value was used.` };
  const lpa = /(\d+(?:\.\d+)?)\s*(lpa|l\.p\.a|lakhs?|lacs?|\bl\b)/.exec(text);
  if (lpa) return { value: Number(lpa[1]) * (perMonth ? 12 : 1), note: perMonth ? "Package was given per month and converted to per annum." : null };
  const rupees = /(?:₹|rs\.?|inr)\s*(\d+(?:\.\d+)?)/.exec(text) || /\b(\d{5,8})\b/.exec(text);
  if (rupees) {
    const amount = Number(rupees[1]) * (perMonth ? 12 : 1);
    if (amount >= 10000) return { value: Math.round((amount / 100000) * 100) / 100, note: perMonth ? "Package was given per month and converted to per annum." : null };
  }
  const bare = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (bare && Number(bare[1]) <= 200) return { value: Number(bare[1]), note: null };
  return null;
}

/** YYYY-MM-DD from Indian-style dates. Returns { value, note }. */
export function parseDate(raw) {
  const text = String(raw ?? "").toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  const pad = (n) => String(n).padStart(2, "0");
  const ok = (y, m, d) => {
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
  };
  let m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(text);
  if (m) return { value: ok(+m[1], +m[2], +m[3]), note: null };
  // Numeric dates are day first, as written in India.
  m = /\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/.exec(text);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return { value: ok(year, +m[2], +m[1]), note: null };
  }
  const month = "(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?";
  m = new RegExp(`\\b(\\d{1,2})\\s*(?:of\\s+)?${month},?\\s*(\\d{4})?`).exec(text) ;
  let day, mon, year;
  if (m) [day, mon, year] = [+m[1], MONTHS[m[2]], m[3] && +m[3]];
  else {
    m = new RegExp(`\\b${month}\\s+(\\d{1,2}),?\\s*(\\d{4})?`).exec(text);
    if (m) [mon, day, year] = [MONTHS[m[1]], +m[2], m[3] && +m[3]];
  }
  if (!m) return { value: null, note: null };
  if (!year) return { value: null, note: `A date "${clean(m[0])}" has no year, so it was left blank.` };
  return { value: ok(year, mon, day), note: null };
}

/** Branch codes named in a phrase. "All branches" gives an empty list (no restriction). */
export function parseBranches(raw) {
  const text = String(raw ?? "");
  if (/\b(all|any) (branches|streams|disciplines|departments)\b|\bopen to all\b/i.test(text)) return [];
  const found = [];
  let rest = text;
  for (const [code, re] of BRANCHES) {
    const global = new RegExp(re.source, "gi");
    if (global.test(rest)) {
      found.push(code);
      rest = rest.replace(global, " ");
    }
  }
  return found;
}

/** A list from bullets, numbers, arrows or commas. */
function readList(lines, max = 20) {
  const items = [];
  for (const line of lines) {
    // One line: "a, b and c" or "a -> b -> c". Several lines: one item each.
    const parts = /→|->|>|»|\bthen\b/.test(line)
      ? line.split(/\s*(?:→|->|>|»|\bthen\b)\s*/i)
      : bullet.test(line) || lines.length > 1
        ? [line]
        : line.split(/\s*[,;]\s*|\s+(?:and|&)\s+(?=[^,]*$)/);
    for (const part of parts) {
      const item = clean(part.replace(bullet, "")).replace(/\.$/, "");
      if (item && item.length <= 100) items.push(item);
    }
  }
  return [...new Set(items)].slice(0, max);
}

function readCgpa(text) {
  const lower = String(text ?? "").toLowerCase();
  const values = [];
  for (const re of [/(\d{1,2}(?:\.\d{1,2})?)\s*(?:\/\s*10\s*)?(?:cgpa|cpi|gpa|sgpa|pointer)/g, /(?:cgpa|cpi|gpa|pointer)[^\d%]{0,25}(\d{1,2}(?:\.\d{1,2})?)/g])
    for (const m of lower.matchAll(re)) values.push(Number(m[1]));
  const cgpa = values.filter((v) => v > 0 && v <= 10);
  const percent = /(\d{2}(?:\.\d+)?)\s*%/.exec(lower);
  return {
    value: cgpa.length ? Math.max(...cgpa) : null,
    note: !cgpa.length && percent ? `Eligibility is given as ${percent[1]}%, not a 10-point CGPA, so the minimum CGPA was left blank.` : null,
  };
}

function readBacklogs(text) {
  const lower = String(text ?? "").toLowerCase();
  if (/\bno (active |current |standing |live )?(backlogs?|arrears)\b|\b(backlogs?|arrears)\s*[:-]?\s*(nil|none|not allowed|zero)\b/.test(lower)) return 0;
  const m = /(?:maximum|max\.?|up ?to|upto)?\s*(\d{1,2})\s*(?:active |current |standing )?(?:backlogs?|arrears)/.exec(lower) || /(?:backlogs?|arrears)\s*[:-]?\s*(\d{1,2})\b/.exec(lower);
  return m ? Number(m[1]) : null;
}

function employmentType(text) {
  const lower = String(text ?? "").toLowerCase();
  if (/\bppo\b|pre[- ]placement offer/.test(lower) && /\bintern/.test(lower)) return "internship-ppo";
  if (/\binternship\b|\bintern\b/.test(lower) && !/full[- ]time/.test(lower)) return "internship";
  if (/\bfull[- ]time\b|\bpermanent\b/.test(lower)) return "full-time";
  if (/\bcontract(ual)?\b/.test(lower)) return "contract";
  return "";
}

function categories(text) {
  return CATEGORY_WORDS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/**
 * Reads a recruiter notice. Returns the raw drive fields (company portal and
 * officer intake), the raw company details, notes for the officer, and the
 * line each value came from.
 */
export function parseRecruiterText(text) {
  const lines = readLines(text);
  const all = lines.map((l) => l.text).join("\n");
  const pairs = readPairs(lines);
  const sections = readSections(lines);
  const notes = [];
  const sources = {};
  const take = (field, value, line) => {
    if (value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && !value.length) && line) sources[field] = clean(line).slice(0, 240);
    return value;
  };
  const note = (n) => n && !notes.includes(n) && notes.push(n);
  const section = (name) => sections[name] ?? [];

  // Contacts: the recruiter's, never the university placement cell's.
  const emails = [...new Set((all.match(EMAIL) || []).map((e) => e.toLowerCase()))].filter((e) => !CAMPUS_MAIL.test(e));
  const contactText = [...section("contact"), ...pairs.filter((p) => /hr_/.test(p.field)).map((p) => p.line)].join("\n");
  // Prefer an address in the contact section; otherwise the first non-campus one.
  const contactEmail = (contactText.match(EMAIL) || []).map((e) => e.toLowerCase()).find((e) => !CAMPUS_MAIL.test(e));
  const email = contactEmail || emails[0] || "";
  const phone = clean((contactText.match(PHONE) || all.match(PHONE) || [])[0] || "");
  const urls = (all.match(URL) || []).map((u) => u.replace(/[.)]+$/, "")).filter((u) => !/dsu\.edu\.in|forms\.gle|docs\.google|bit\.ly|linkedin\.com/i.test(u));
  const corporateDomain = emails.find((e) => !FREE_MAIL.test(e))?.split("@")[1] || "";

  // Company name: a label, "<Name> campus drive/is hiring", then the email domain.
  let companyName = first(pairs, "company_name")?.value || "";
  let companyLine = first(pairs, "company_name")?.line;
  if (!companyName) {
    for (const line of lines.slice(0, 15)) {
      const m = /^(.{2,60}?)\s+(?:campus (?:recruitment|drive|hiring|placement)|is hiring|recruitment drive|hiring drive|off[- ]campus drive|placement drive|pool campus)/i.exec(line.text);
      if (m) {
        companyName = clean(m[1]);
        companyLine = line.text;
        break;
      }
    }
  }
  if (!companyName) {
    for (const line of lines.slice(0, 10)) {
      const m = /^(?:warm greetings from|greetings from|on behalf of)\s+(.{2,60}?)[!.,]*$/i.exec(line.text);
      if (m) {
        companyName = clean(m[1]);
        companyLine = line.text;
        break;
      }
    }
  }
  // "ACME ANALYTICS PVT LTD" reads as "Acme Analytics Pvt Ltd".
  if (companyName && companyName === companyName.toUpperCase() && /[A-Z]{4}/.test(companyName))
    companyName = companyName.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
  if (!companyName && corporateDomain) {
    const base = corporateDomain.split(".").slice(-2, -1)[0] || corporateDomain.split(".")[0];
    companyName = base.charAt(0).toUpperCase() + base.slice(1);
    companyLine = `Email domain ${corporateDomain}`;
    note(`The company name "${companyName}" was taken from the email domain ${corporateDomain}. Check the spelling.`);
  }

  // Role. A title is short and capitalised; "Role: build and test backend
  // services..." is a description of the work, so it goes there instead.
  const titlePair = first(pairs, "title");
  const looksLikeTitle = (v) => v && v.split(/\s+/).length <= 8 && /^[A-Z0-9]/.test(v);
  let title = looksLikeTitle(titlePair?.value) ? titlePair.value : "";
  let titleLine = title ? titlePair.line : undefined;
  const roleSentence = titlePair && !title ? titlePair.value : "";
  if (!title) {
    // "Acme campus hiring 2027: Graduate Engineer"
    for (const line of lines.slice(0, 8)) {
      const after = /:\s*([^:]{3,60})$/.exec(line.text)?.[1];
      if (after && looksLikeTitle(clean(after)) && ROLE_WORDS.test(after) && !/^(role|job role|designation|position)\s*:/i.test(line.text)) {
        [title, titleLine] = [clean(after).replace(/\.$/, ""), line.text];
        break;
      }
    }
  }
  if (!title) {
    const hiring = /(?:hiring|recruiting|opening|openings|vacancy|vacancies) for (?:the (?:role|position) of )?(?:an? )?([A-Z][\w /&+-]{2,60}?)(?:\s+(?:role|position)|[.,(]|$)/m.exec(all);
    if (hiring && ROLE_WORDS.test(hiring[1])) [title, titleLine] = [clean(hiring[1]), hiring[0]];
  }
  if (!title) {
    const line = lines.slice(0, 12).find((l) => l.text.length <= 70 && ROLE_WORDS.test(l.text) && !/[:@]/.test(l.text) && !headingOf(l.text));
    if (line) [title, titleLine] = [clean(line.text.replace(/^(role|position|hiring)\s*[-–:]\s*/i, "")), line.text];
  }

  // Package: a labelled value, the compensation section, or any line naming CTC/LPA.
  let pkg = null;
  let pkgLine;
  const pkgCandidates = [
    ...pairs.filter((p) => p.field === "package").map((p) => [p.value, p.line]),
    ...section("compensation").map((l) => [l, l]),
    ...lines.filter((l) => /\b(ctc|lpa|lakhs? per annum|package|salary)\b/i.test(l.text)).map((l) => [l.text, l.text]),
  ];
  for (const [value, line] of pkgCandidates) {
    pkg = parsePackage(value);
    if (pkg) {
      pkgLine = line;
      break;
    }
  }
  if (pkg?.note) note(pkg.note);
  const stipend = first(pairs, "stipend");
  if (!pkg && stipend) note(`Only a stipend is given (${stipend.value}); the package was left blank.`);

  // Dates.
  const dateFrom = (field, fallbackRe) => {
    const pair = first(pairs, field);
    const candidates = pair ? [[pair.value, pair.line]] : [];
    if (!pair && fallbackRe) for (const l of lines) if (fallbackRe.test(l.text)) candidates.push([l.text, l.text]);
    for (const [value, line] of candidates) {
      const d = parseDate(value);
      if (d.note) note(d.note);
      if (d.value) return [d.value, line];
    }
    return ["", undefined];
  };
  const [driveDate, driveLine] = dateFrom("drive_date", /\b(drive|test|assessment|interview|recruitment) (date|on|will be held)\b|\bdate of (the )?(drive|test)\b/i);
  const [deadline, deadlineLine] = dateFrom("registration_deadline", /\b(last date|deadline|register by|apply by|registration closes)\b/i);

  // Eligibility: CGPA, backlogs and branches from labels or the eligibility section.
  const eligibility = [...section("eligibility"), ...pairs.filter((p) => ["cgpa", "backlogs", "branches"].includes(p.field)).map((p) => p.line)].join("\n");
  const cgpaText = first(pairs, "cgpa")?.value ? `${first(pairs, "cgpa").value} cgpa` : eligibility || all;
  const cgpa = readCgpa(cgpaText);
  if (cgpa.note) note(cgpa.note);
  const backlogs = readBacklogs(first(pairs, "backlogs")?.value ? `${first(pairs, "backlogs").value} backlogs` : eligibility || all);
  const branchPair = first(pairs, "branches");
  // Without a label or eligibility section, look at sentences about who can apply.
  const branchText =
    branchPair?.value ||
    eligibility ||
    lines.filter((l) => /(eligib|can apply|branch|stream|students from|\bb\.?\s?e\b|b\.?\s?tech)/i.test(l.text)).map((l) => l.text).join("\n");
  const branches = branchText ? parseBranches(branchText) : [];
  const allBranches = branchText && /\b(all|any) (branches|streams|disciplines|departments)\b|\bopen to all\b/i.test(branchText);
  if (allBranches) note("The notice says all branches are eligible, so no branch is selected.");

  // Lists and free text.
  const rounds = readList(section("rounds"));
  const skillPair = first(pairs, "skills");
  const skills = skillPair ? skillPair.value : readList(section("skills"), 40).join(", ");
  const docPair = first(pairs, "required_documents");
  const documents = docPair ? docPair.value : readList(section("documents"), 30).join(", ");
  const description = section("description").join("\n") || roleSentence;
  const about = section("about").join("\n");
  const openingsText = first(pairs, "openings")?.value || "";
  const openings = /\d+/.test(openingsText) ? Number(/\d+/.exec(openingsText)[0]) : null;
  const typeText = first(pairs, "employment_type")?.value || `${title}\n${all.slice(0, 4000)}`;
  const contactLines = section("contact");

  // Categories describe the role, so the role comes first; the company's own
  // description is only a fallback. Industry is suggested from that description.
  const roleCategories = categories(`${title}\n${first(pairs, "job_category")?.value || ""}\n${description}\n${skills}`);
  const jobCategories = roleCategories.length ? roleCategories : categories(`${first(pairs, "industry")?.value || ""}\n${about}`);
  const suggestedIndustry = INDUSTRY_WORDS.find(([, re]) => re.test(`${about}\n${companyName}`))?.[0] || "";
  const industry = first(pairs, "industry")?.value || suggestedIndustry;
  const website = first(pairs, "website")?.value || urls[0] || (corporateDomain ? `https://${corporateDomain}` : "");
  const hrName = (() => {
    const pair = first(pairs, "hr_name");
    if (pair) return clean(pair.value.replace(EMAIL, "").replace(PHONE, "").replace(/[,|/]+/g, " "));
    // "Ms. Priya Sharma, HR, ..." gives "Priya Sharma".
    const named = contactLines
      .map((l) => /^(?:(?:mr|ms|mrs|dr|shri|smt)\.?\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z.]+){0,3})(?=\s*[,|(-]|$)/.exec(l.replace(/^(mr|ms|mrs|dr|shri|smt)\b/i, (h) => h.toLowerCase())))
      .find((m) => m && !/^(for|contact|email|phone|hr|placement)\b/i.test(m[1]));
    return named ? clean(named[1]) : "";
  })();
  const shortName =
    [companyLine, ...lines.slice(0, 5).map((l) => l.text)].map((t) => /\(([A-Z][A-Za-z0-9&]{1,10})\)/.exec(t || "")?.[1]).find(Boolean) || "";

  const drive = {
    company_name: take("company_name", companyName, companyLine),
    title: take("title", title, titleLine),
    package_lpa: take("package_lpa", pkg ? pkg.value : null, pkgLine),
    location: take("location", first(pairs, "location")?.value || "", first(pairs, "location")?.line),
    drive_date: take("drive_date", driveDate, driveLine),
    registration_deadline: take("registration_deadline", deadline, deadlineLine),
    min_cgpa: take("min_cgpa", cgpa.value, cgpa.value !== null ? first(pairs, "cgpa")?.line || eligibility.split("\n").find((l) => /cgpa|cpi|gpa|pointer/i.test(l)) : undefined),
    max_backlogs: take("max_backlogs", backlogs, backlogs !== null ? first(pairs, "backlogs")?.line || eligibility.split("\n").find((l) => /backlog|arrear/i.test(l)) || all.split("\n").find((l) => /backlog|arrear/i.test(l)) : undefined),
    branches: take("branches", branches, branchPair?.line || branchText.split("\n").find((l) => parseBranches(l).length)),
    skills: take("skills", skills, skillPair?.line || section("skills")[0]),
    description: take("description", description, section("description")[0]),
    rounds: take("rounds", rounds, section("rounds")[0]),
    required_documents: take("required_documents", documents, docPair?.line || section("documents")[0]),
    job_category: take("job_category", first(pairs, "job_category")?.value || jobCategories[0] || "", first(pairs, "job_category")?.line || (jobCategories[0] ? "Matched from the role and description" : undefined)),
    employment_type: take("employment_type", employmentType(typeText), first(pairs, "employment_type")?.line || "Matched from the notice wording"),
    openings: take("openings", openings && openings > 0 ? openings : null, first(pairs, "openings")?.line),
    contact: take("contact", [hrName, email, phone].filter(Boolean).join(", "), contactLines[0] || email),
  };
  const company = {
    short_name: shortName,
    industry: take("industry", industry, first(pairs, "industry")?.line || (suggestedIndustry ? "Matched from the company description" : undefined)),
    headquarters: take("headquarters", first(pairs, "headquarters")?.value || "", first(pairs, "headquarters")?.line),
    website: take("website", website, first(pairs, "website")?.line || urls[0] || (corporateDomain && `Email domain ${corporateDomain}`)),
    hr_name: take("hr_name", hrName, first(pairs, "hr_name")?.line || contactLines[0]),
    hr_email: take("hr_email", email, email),
    hr_phone: take("hr_phone", phone, phone),
    about: take("about", about, section("about")[0]),
    hiring_roles: take("hiring_roles", title, titleLine),
    job_categories: take("job_categories", jobCategories, jobCategories.length ? "Matched from the role and description" : undefined),
  };
  return { drive: { ...drive, notes }, company, sources };
}
