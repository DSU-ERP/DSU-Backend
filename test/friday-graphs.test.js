import { test } from "node:test";
import assert from "node:assert/strict";
import { studentChatGraph } from "../src/modules/students/chat.js";
import { companyChatGraph } from "../src/modules/company/friday.js";
import { WORKFLOWS } from "../src/modules/ops/workflows.js";

// The Admin portal names the LangGraph node behind each traced step. These
// checks keep those names, and the branches, tied to the compiled graphs.
const generate = Object.assign(async () => ({}), { configured: true });
const shape = (compiled) => {
  const graph = compiled.getGraph();
  return {
    nodes: new Set(Object.keys(graph.nodes)),
    edges: graph.edges.map((e) => `${e.source}->${e.target}`).sort(),
  };
};
const named = (assistant) =>
  WORKFLOWS[assistant].nodes.flatMap((n) => n.functions.filter((f) => f.startsWith("LangGraph node: ")).map((f) => f.slice(16)));

test("the student graph branches to a no-AI reply or to research, competency and the model", () => {
  const { nodes, edges } = shape(studentChatGraph({ pool: null, generate, research: null }));
  for (const node of ["prepare", "route", "reply", "research", "competency", "model", "persist", "output"]) assert.ok(nodes.has(node), node);
  for (const edge of ["__start__->prepare", "prepare->route", "route->reply", "route->research", "reply->persist",
    "research->competency", "competency->model", "model->persist", "persist->output", "output->__end__"])
    assert.ok(edges.includes(edge), edge);
  assert.ok(!edges.includes("reply->model"), "a greeting never reaches the model");
});

test("the company graph runs prepare, model, persist and output in order", () => {
  const { edges } = shape(companyChatGraph({ pool: null, generate, member: async () => null }));
  assert.deepEqual(edges, ["__start__->prepare", "model->persist", "output->__end__", "persist->output", "prepare->model"]);
});

test("every graph node the Admin portal names exists in that assistant's graph", () => {
  const graphs = {
    student: shape(studentChatGraph({ pool: null, generate, research: null })).nodes,
    company: shape(companyChatGraph({ pool: null, generate, member: async () => null })).nodes,
  };
  for (const assistant of ["student", "company"]) {
    const names = named(assistant);
    assert.ok(names.length > 0, `${assistant} names its graph nodes`);
    for (const name of names) assert.ok(graphs[assistant].has(name), `${assistant}: ${name}`);
    assert.match(WORKFLOWS[assistant].orchestration, /^LangGraph state graph with LangChain ChatOpenAI/);
  }
});
