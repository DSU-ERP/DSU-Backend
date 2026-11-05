// The real F.R.I.D.A.Y. pipelines for the Admin portal's architecture view
// (docs/agent-workflow-visualization). Nothing here is drawn by hand: nodes
// and edges come from each assistant's compiled LangGraph (getGraph()), and
// node descriptions are the metadata given to addNode where the graph is built.
// Tests fail if a recorded step is not part of the graph, so the diagram
// cannot drift from the code.
//
// The officer assistant runs in the web app; its graph is described there
// from its own compiled LangGraph (DSU_ERP src/features/admin/lib/officer-workflow.ts).
import { WORKFLOW_VERSIONS } from "./tracer.js";
import { graphWorkflow } from "../../platform/agents/graph.js";
import { studentChatGraph, STUDENT_START_STEPS } from "../students/chat.js";
import { companyChatGraph, COMPANY_START_STEPS } from "../company/friday.js";

// Built without services: the shape is all that is read, nothing is run.
const describeOnly = { pool: null, generate: Object.assign(async () => ({}), { configured: false }), research: null, member: async () => null };

export const WORKFLOWS = Object.freeze({
  student: graphWorkflow(studentChatGraph(describeOnly), {
    id: "student",
    title: "Student F.R.I.D.A.Y.",
    version: WORKFLOW_VERSIONS.student,
    runtime: "DSU-Backend, POST /student/conversations/:id/message (one request, not streamed)",
    orchestration: "LangGraph state graph with LangChain ChatOpenAI. The server decides what data to load; the model cannot choose tools or data sources.",
    start: STUDENT_START_STEPS,
  }),
  company: graphWorkflow(companyChatGraph(describeOnly), {
    id: "company",
    title: "Company F.R.I.D.A.Y.",
    version: WORKFLOW_VERSIONS.company,
    runtime: "DSU-Backend, POST /company/friday/conversations/:id/message (one request, not streamed)",
    orchestration: "LangGraph state graph with LangChain ChatOpenAI. Context comes only from company.* database functions scoped to the member's own company.",
    start: COMPANY_START_STEPS,
  }),
});

// Every step name a run may record: graph nodes, nested steps and steps a node records as its own.
export const declaredNodes = (assistant) => new Set(WORKFLOWS[assistant].nodes.flatMap((n) => [n.id, ...(n.records ?? [])]));
