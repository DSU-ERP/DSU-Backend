import { test } from "node:test";
import assert from "node:assert/strict";
import { studentChatGraph } from "../src/modules/students/chat.js";
import { companyChatGraph } from "../src/modules/company/friday.js";
import { WORKFLOWS } from "../src/modules/ops/workflows.js";
import { graphWorkflow, plainState, StateGraph, START, END } from "../src/platform/agents/graph.js";

// The Admin portal draws each assistant from its compiled LangGraph. These
// checks tie the published diagram, and the branches, to the graphs that run.
const generate = Object.assign(async () => ({}), { configured: true });
const graphs = {
  student: studentChatGraph({ pool: null, generate, research: null }),
  company: companyChatGraph({ pool: null, generate, member: async () => null }),
};
const shape = (compiled) => {
  const graph = compiled.getGraph();
  return {
    nodes: Object.keys(graph.nodes).sort(),
    edges: graph.edges.map((e) => `${e.source}->${e.target}`).sort(),
  };
};

test("the student graph branches to a no-AI reply or to research, competency and the model", () => {
  const { nodes, edges } = shape(graphs.student);
  assert.deepEqual(nodes, ["__end__", "__start__", "competency", "model", "output", "persist", "prepare", "reply", "research", "route"]);
  for (const edge of ["__start__->prepare", "prepare->route", "route->reply", "route->research", "reply->persist",
    "research->competency", "competency->model", "model->persist", "persist->output", "output->__end__"])
    assert.ok(edges.includes(edge), edge);
  assert.ok(!edges.includes("reply->model"), "a greeting never reaches the model");
});

test("the company graph runs prepare, model, persist and output in order", () => {
  assert.deepEqual(shape(graphs.company).edges, ["__start__->prepare", "model->persist", "output->__end__", "persist->output", "prepare->model"]);
});

for (const assistant of ["student", "company"]) {
  test(`the ${assistant} diagram is the compiled LangGraph, with recorded steps nested under real nodes`, () => {
    const workflow = WORKFLOWS[assistant];
    const { nodes, edges } = shape(graphs[assistant]);
    const top = workflow.nodes.filter((n) => !n.parent);
    assert.deepEqual(top.map((n) => n.id).sort(), nodes, "every box is a graph node");
    assert.deepEqual(workflow.edges.map((e) => `${e.from}->${e.to}`).sort(), edges, "every arrow is a graph edge");
    for (const node of workflow.nodes.filter((n) => n.parent))
      assert.ok(nodes.includes(node.parent), `${node.id} sits under a graph node`);
    for (const node of top.filter((n) => !n.id.startsWith("__"))) {
      assert.ok(node.label && node.purpose, `${node.id} carries its metadata`);
      assert.equal(node.functions[0], `LangGraph node: ${node.id}`);
    }
    assert.equal(new Set(workflow.nodes.map((n) => n.id)).size, workflow.nodes.length, "ids are unique");
    for (const node of top.filter((n) => n.records)) assert.equal(node.records.length, 1, `${node.id} owns one recorded step`);
    assert.match(workflow.orchestration, /^LangGraph state graph with LangChain ChatOpenAI/);
  });
}

test("a node that records one step under another name owns it instead of nesting a duplicate", () => {
  const own = Object.fromEntries(WORKFLOWS.student.nodes.filter((n) => n.records).map((n) => [n.id, n.records]));
  assert.deepEqual(own, { __start__: ["input"], research: ["research.web"], competency: ["context.competency"] });
});

test("branch labels come from the graph's path map", () => {
  const branches = WORKFLOWS.student.edges.filter((e) => e.kind === "branch").map((e) => [e.to, e.condition]).sort();
  assert.deepEqual(branches, [["reply", "greeting or no resume for a drive"], ["research", "chat reply or JD match"]]);
});

test("an edge back to an earlier node on the path is drawn as a loop, a rejoining branch is not", () => {
  const compiled = new StateGraph(plainState(["x"]))
    .addNode("agent", () => ({})).addNode("tools", () => ({})).addNode("side", () => ({})).addNode("join", () => ({}))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", () => END, { tools: "tools", side: "side", done: "join" })
    .addEdge("tools", "agent").addEdge("side", "join").addEdge("join", END)
    .compile();
  const kinds = Object.fromEntries(graphWorkflow(compiled, {}).edges.map((e) => [`${e.from}->${e.to}`, e.kind ?? "flow"]));
  assert.equal(kinds["tools->agent"], "loop");
  assert.equal(kinds["side->join"], "flow");
  assert.equal(kinds["agent->join"], "branch");
});
