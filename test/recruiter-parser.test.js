import test from "node:test";
import assert from "node:assert/strict";
import { parseBranches, parseDate, parsePackage, parseRecruiterText } from "../src/modules/portal/recruiter-parser.js";
import { readRecruiterNotice } from "../src/modules/portal/drive-intake.js";

// Synthetic notices in the three shapes recruiters send: labelled lines,
// tables (cells arrive separated by " | ") and plain prose.
const LABELLED = `Infosys Limited (INFY) Campus Recruitment Drive 2027
Company Name: Infosys Limited
Job Role: Systems Engineer
CTC: 3.6 LPA
Job Location: Bengaluru, Mysuru, Pune
Date of Drive: 22nd January 2027
Last date for registration: 15/01/2027
Number of openings: 50
Eligibility Criteria
B.E/B.Tech - CSE, ISE, ECE, AI & ML
Minimum 6.5 CGPA throughout, 60% in 10th and 12th
No active backlogs
Selection Process
1. Online Assessment
2. Technical Interview
3. HR Interview
Skills Required: Java, SQL, Problem solving
Documents to carry
- Updated resume
- College ID card
About Us
Infosys is a global leader in next-generation digital services and consulting.
Contact
Ms. Priya Sharma, HR, priya.sharma@infosys.com, +91 98450 12345
Placement Cell: placements@dsu.edu.in`;

const TABLE = `ACME ANALYTICS PVT LTD | OFF CAMPUS DRIVE
Role | Data Analyst | Package | 8 - 10 LPA
Location | Hyderabad | Batch | 2026
Drive date | 03-02-2027 | Registration deadline | 28 Jan 2027
Eligible Branches | All branches
Cut-off | 70% aggregate
Employment type | Full time
Rounds
Aptitude -> Technical -> HR
Contact: recruit@acmeanalytics.io | www.acmeanalytics.io`;

const PROSE = `Greetings from Zenith Fintech!
We are hiring for the role of Associate Software Engineer (internship with PPO).
Stipend: Rs. 25,000 per month during the internship.
Students from Computer Science and Engineering and Information Science and Engineering with a CGPA of 7.5 and above, with no backlogs, can apply.
The online test will be held on March 3.
Job Description
Work on payment platform APIs.
Write unit tests and review code.
For queries contact hiring@zenithfin.com`;

test("labelled notices fill role, eligibility, lists and the recruiter's contact", () => {
  const { drive, company, sources } = parseRecruiterText(LABELLED);
  assert.equal(drive.company_name, "Infosys Limited");
  assert.equal(drive.title, "Systems Engineer");
  assert.equal(drive.package_lpa, 3.6);
  assert.equal(drive.location, "Bengaluru, Mysuru, Pune");
  assert.equal(drive.drive_date, "2027-01-22");
  assert.equal(drive.registration_deadline, "2027-01-15"); // day first, as written in India
  assert.equal(drive.openings, 50);
  assert.equal(drive.min_cgpa, 6.5); // the 60% for school marks is not a CGPA
  assert.equal(drive.max_backlogs, 0);
  assert.deepEqual(drive.branches.sort(), ["AIML", "CSE", "ECE", "ISE"]);
  assert.deepEqual(drive.rounds, ["Online Assessment", "Technical Interview", "HR Interview"]);
  assert.equal(drive.skills, "Java, SQL, Problem solving");
  assert.equal(drive.required_documents, "Updated resume, College ID card");
  assert.equal(drive.job_category, "Software / IT");
  assert.equal(drive.employment_type, ""); // not stated, not guessed
  assert.deepEqual(drive.notes, []);
  assert.equal(company.short_name, "INFY");
  assert.equal(company.hr_name, "Priya Sharma");
  assert.equal(company.hr_email, "priya.sharma@infosys.com"); // never the campus placement cell
  assert.equal(company.hr_phone, "+91 98450 12345");
  assert.equal(company.website, "https://infosys.com");
  assert.equal(company.industry, "Information technology");
  assert.match(company.about, /global leader/);
  assert.equal(sources.package_lpa, "CTC: 3.6 LPA");
  assert.equal(sources.drive_date, "Date of Drive: 22nd January 2027");
});

test("table notices read label and value cells, ranges, percentages and all-branch rules", () => {
  const { drive, company } = parseRecruiterText(TABLE);
  assert.equal(drive.company_name, "Acme Analytics Pvt Ltd");
  assert.equal(drive.title, "Data Analyst");
  assert.equal(drive.package_lpa, 8);
  assert.equal(drive.location, "Hyderabad");
  assert.equal(drive.drive_date, "2027-02-03");
  assert.equal(drive.registration_deadline, "2027-01-28");
  assert.equal(drive.min_cgpa, null);
  assert.deepEqual(drive.branches, []);
  assert.deepEqual(drive.rounds, ["Aptitude", "Technical", "HR"]);
  assert.equal(drive.employment_type, "full-time");
  assert.ok(drive.notes.some((n) => /range \(8–10 LPA\)/.test(n)));
  assert.ok(drive.notes.some((n) => /70%, not a 10-point CGPA/.test(n)));
  assert.ok(drive.notes.some((n) => /all branches are eligible/.test(n)));
  assert.equal(company.hr_email, "recruit@acmeanalytics.io");
  assert.equal(company.website, "www.acmeanalytics.io");
});

test("prose notices: company from the greeting, branches from sentences, honest gaps", () => {
  const { drive, company } = parseRecruiterText(PROSE);
  assert.equal(drive.company_name, "Zenith Fintech");
  assert.equal(drive.title, "Associate Software Engineer");
  assert.equal(drive.package_lpa, null);
  assert.equal(drive.employment_type, "internship-ppo");
  assert.equal(drive.min_cgpa, 7.5);
  assert.equal(drive.max_backlogs, 0);
  assert.deepEqual(drive.branches, ["CSE", "ISE"]);
  assert.equal(drive.drive_date, "");
  assert.equal(drive.description, "Work on payment platform APIs.\nWrite unit tests and review code.");
  assert.ok(drive.notes.some((n) => /Only a stipend is given/.test(n)));
  assert.ok(drive.notes.some((n) => /no year/.test(n)));
  assert.equal(company.industry, "Financial technology");
});

test("several labels on one line are read separately", () => {
  const { drive } = parseRecruiterText(
    "Acme Systems campus drive\nRole: Graduate Engineer. CTC 8 LPA. Location: Bengaluru\nEligible branches: CSE, ISE. Rounds: Aptitude, Technical, HR\nContact: hr@acme.example",
  );
  assert.equal(drive.company_name, "Acme Systems");
  assert.equal(drive.title, "Graduate Engineer");
  assert.equal(drive.package_lpa, 8);
  assert.equal(drive.location, "Bengaluru");
  assert.deepEqual(drive.branches, ["CSE", "ISE"]);
  assert.deepEqual(drive.rounds, ["Aptitude", "Technical", "HR"]);
});

test("value helpers", () => {
  assert.deepEqual(parsePackage("₹6,00,000 per annum"), { value: 6, note: null });
  assert.equal(parsePackage("INR 12,50,000").value, 12.5);
  assert.equal(parsePackage("50,000 per month").value, 6);
  assert.equal(parsePackage("4.5 LPA").value, 4.5);
  assert.equal(parsePackage("Competitive"), null);
  assert.deepEqual(parseDate("15/01/2027"), { value: "2027-01-15", note: null });
  assert.equal(parseDate("2027-02-30").value, null); // not a real date
  assert.equal(parseDate("Jan 5, 2027").value, "2027-01-05");
  assert.equal(parseDate("5th of March 2027").value, "2027-03-05");
  assert.match(parseDate("12 Feb").note, /no year/);
  assert.deepEqual(parseBranches("Computer Science and Technology, Mechanical"), ["CST", "ME"]);
  assert.deepEqual(parseBranches("Open to all branches"), []);
});

test("validated output keeps sources only for values that survived validation", () => {
  const { drive, company, sources } = readRecruiterNotice(LABELLED);
  assert.equal(drive.fields.title, "Systems Engineer");
  assert.equal(company.fields.name, "Infosys Limited");
  assert.ok(sources.title && sources.name);
  assert.ok(!("description" in sources));
});

test("table rows whose cells merged into one run are split at known labels", () => {
  const { drive } = parseRecruiterText("Acme campus drive\nPackage 8 LPA\nJob Location Pune\nRole Data Analyst Drive date 03-02-2027\nWe value Location independence.");
  assert.equal(drive.package_lpa, 8);
  assert.equal(drive.location, "Pune");
  assert.equal(drive.title, "Data Analyst");
  assert.equal(drive.drive_date, "2027-02-03");
});
