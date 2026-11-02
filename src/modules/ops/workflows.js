// The real F.R.I.D.A.Y. pipelines as graphs, for the Admin portal's
// architecture view (docs/agent-workflow-visualization). Node ids are exactly
// the `node` names the tracer records, and tests fail if a recorded step is not
// declared here, so the diagram cannot drift from the code.
//
// The officer assistant runs in the web app; its graph is declared there next
// to its tool list (DSU_ERP src/features/admin/lib/officer-workflow.ts).
import { WORKFLOW_VERSIONS } from "./tracer.js";

const MODEL_NODES = [
  { id: "model.limit", kind: "limit", label: "AI request limit", purpose: "Reserves the caller's AI budget: 12 requests a minute, at most 2 running.",
    inputs: "actor, request kind", outputs: "reservation id", functions: ["reserveAiRequest", "student.ai_requests"] },
  { id: "model.call", kind: "model", label: "Model call", purpose: "One OpenRouter chat completion with a strict JSON schema. No tool calling.",
    inputs: "system rules, task, prepared context", outputs: "JSON answer", functions: ["createStudentAI.generate", "OpenRouter"] },
  { id: "model.validate", kind: "validate", label: "Response schema check", purpose: "Rejects incomplete or malformed answers; nothing is invented on failure.",
    inputs: "model JSON", outputs: "validated answer", functions: ["zod schema"] },
];

export const WORKFLOWS = Object.freeze({
  student: {
    id: "student",
    title: "Student F.R.I.D.A.Y.",
    version: WORKFLOW_VERSIONS.student,
    runtime: "DSU-Backend, POST /student/conversations/:id/message (one request, not streamed)",
    orchestration: "Custom pipeline. The server decides what data to load; the model cannot choose tools or data sources.",
    nodes: [
      { id: "input", kind: "input", label: "Student message", purpose: "Validated message (max 4,000 characters), optional attachment and web-search choice.",
        inputs: "message", outputs: "request", functions: ["zod"] },
      { id: "identity", kind: "auth", label: "Student identity", purpose: "Runs every query as the signed-in student under row-level security. Accounts without a student link are refused.",
        inputs: "verified JWT", outputs: "official student record", functions: ["runStudent", "withActor", "erp.actor_student()"] },
      { id: "context", kind: "context", label: "Load context", purpose: "The student's own conversation history, profile, resume and, for drive chats, the drive and official eligibility.",
        inputs: "conversation id", outputs: "prepared context", functions: ["owned()", "driveRecord", "opportunityEligibility"], children: ["context.placement"] },
      { id: "context.placement", kind: "retrieval", label: "Own placement and schedule", purpose: "Drives published to this student, their applications, offers, calendar, open assessments and unread notices.",
        inputs: "message", outputs: "myPlacement (summary or full)", functions: ["studentPlacementContext", "student.placement_record()"], parent: "context" },
      { id: "route", kind: "route", label: "Choose how to answer", purpose: "Greeting and missing-resume replies need no AI; otherwise a chat reply or a JD match.",
        inputs: "message, drive, resume", outputs: "greeting | ask_for_resume | chat_reply | jd_match", functions: ["isGreeting", "resumeRequest"] },
      { id: "research.web", kind: "retrieval", label: "Web search", purpose: "Optional Brave or Google search through the MCP search server. Counts against the AI budget.",
        inputs: "search query", outputs: "up to 5 results", functions: ["research.search", "MCP web-search"] },
      { id: "context.competency", kind: "retrieval", label: "Competency evidence", purpose: "Assessed competency context, only when competency testing is switched on.",
        inputs: "student", outputs: "competency summary", functions: ["studentCompetencyContext"] },
      ...MODEL_NODES,
      { id: "persist", kind: "persist", label: "Save conversation", purpose: "Stores the question and answer in the student's own conversation.",
        inputs: "answer, sources", outputs: "messages", functions: ["student.messages"] },
      { id: "output", kind: "output", label: "Answer returned", purpose: "Text, optional career card and cited sources.", inputs: "answer", outputs: "response", functions: [] },
    ],
    edges: [
      { from: "input", to: "identity" },
      { from: "identity", to: "context", condition: "student account" },
      { from: "identity", to: "denied", condition: "not a linked student", kind: "denied" },
      { from: "context", to: "route" },
      { from: "route", to: "persist", condition: "greeting or no resume for a drive", kind: "branch" },
      { from: "route", to: "research.web", condition: "chat reply or JD match", kind: "branch" },
      { from: "research.web", to: "context.competency" },
      { from: "context.competency", to: "model.limit" },
      { from: "model.limit", to: "model.call", condition: "budget available" },
      { from: "model.limit", to: "failed", condition: "rate limited", kind: "error" },
      { from: "model.call", to: "model.validate" },
      { from: "model.call", to: "failed", condition: "provider error or timeout", kind: "error" },
      { from: "model.validate", to: "persist", condition: "valid" },
      { from: "model.validate", to: "failed", condition: "invalid answer", kind: "error" },
      { from: "persist", to: "output" },
    ],
  },
  company: {
    id: "company",
    title: "Company F.R.I.D.A.Y.",
    version: WORKFLOW_VERSIONS.company,
    runtime: "DSU-Backend, POST /company/friday/conversations/:id/message (one request, not streamed)",
    orchestration: "Custom pipeline. Context comes only from company.* database functions scoped to the member's own company.",
    nodes: [
      { id: "input", kind: "input", label: "Company message", purpose: "Validated message (max 4,000 characters).", inputs: "message", outputs: "request", functions: ["zod"] },
      { id: "identity", kind: "auth", label: "Company membership", purpose: "Requires an active member of an active company. Everything after this is limited to that company.",
        inputs: "verified JWT", outputs: "company id", functions: ["company.actor_company()"] },
      { id: "context", kind: "context", label: "Load company context", purpose: "Own drive requests, live drives and, after release, consenting applicants. Names only when asked; contact only when asked.",
        inputs: "message", outputs: "company context", functions: ["companyContext"],
        children: ["db.company.session", "db.company.requests", "db.company.drives", "db.company.applicants"] },
      { id: "db.company.session", kind: "retrieval", label: "company.session()", purpose: "The member's company profile.", inputs: "actor", outputs: "company", functions: ["company.session()"], parent: "context" },
      { id: "db.company.requests", kind: "retrieval", label: "company.requests()", purpose: "The company's drive requests and review status.", inputs: "actor", outputs: "requests", functions: ["company.requests()"], parent: "context" },
      { id: "db.company.drives", kind: "retrieval", label: "company.drives()", purpose: "The company's live drives.", inputs: "actor", outputs: "drives", functions: ["company.drives()"], parent: "context" },
      { id: "db.company.applicants", kind: "retrieval", label: "company.applicants(drive)", purpose: "Released, consenting applicants of one drive. Runs once per released drive.",
        inputs: "drive id", outputs: "applicants", functions: ["company.applicants()"], parent: "context" },
      ...MODEL_NODES,
      { id: "persist", kind: "persist", label: "Save conversation", purpose: "Stores the exchange in the member's own conversation.", inputs: "answer", outputs: "messages", functions: ["company.messages"] },
      { id: "output", kind: "output", label: "Answer returned", purpose: "Plain-text answer.", inputs: "answer", outputs: "response", functions: [] },
    ],
    edges: [
      { from: "input", to: "identity" },
      { from: "identity", to: "context", condition: "active company member" },
      { from: "identity", to: "denied", condition: "not a company member", kind: "denied" },
      { from: "context", to: "model.limit" },
      { from: "model.limit", to: "model.call", condition: "budget available" },
      { from: "model.limit", to: "failed", condition: "rate limited", kind: "error" },
      { from: "model.call", to: "model.validate" },
      { from: "model.call", to: "failed", condition: "provider error or timeout", kind: "error" },
      { from: "model.validate", to: "persist", condition: "valid" },
      { from: "model.validate", to: "failed", condition: "invalid answer", kind: "error" },
      { from: "persist", to: "output" },
    ],
  },
});

export const declaredNodes = (assistant) => new Set(WORKFLOWS[assistant].nodes.map((n) => n.id));
