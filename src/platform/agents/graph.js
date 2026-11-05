// Shared LangGraph helpers for the F.R.I.D.A.Y. assistants. Each assistant is a
// StateGraph; the Admin portal's architecture view is drawn from the compiled
// graph itself (graphWorkflow), so the diagram is the graph that runs.
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";

export { StateGraph, START, END };

/**
 * A graph state where every key keeps the last value written. Nodes return
 * only the keys they change. Key names must not repeat node names.
 */
export function plainState(keys) {
  return Annotation.Root(Object.fromEntries(keys.map((key) => [key, Annotation()])));
}

/**
 * Runs a compiled graph for one request. Per-request services (the tracer)
 * travel in config.configurable, never in state, so state stays plain data.
 */
export async function runGraph(graph, state, configurable) {
  return graph.invoke(state, { configurable, recursionLimit: 25 });
}

const ENDPOINTS = {
  [START]: { kind: "input", label: "Start", purpose: "LangGraph entry point. Steps recorded before the graph runs are listed here." },
  [END]: { kind: "output", label: "End", purpose: "LangGraph exit point. The run ends here." },
};

/**
 * Describes a compiled LangGraph for the Admin portal. Nodes and edges come
 * from graph.getGraph(); each node's description is the `metadata` passed to
 * addNode. metadata.steps lists the tracer steps recorded inside that node
 * (a step named like its node is the node's own step); they are shown nested
 * under it. Conditional edges carry their path-map key as the condition, and
 * an edge back to an earlier node is a loop.
 *
 * @param {object} compiled a compiled StateGraph
 * @param {object} meta { id, title, version, runtime, orchestration, start?: steps[], end?: steps[] }
 */
export function graphWorkflow(compiled, { start = [], end = [], ...meta }) {
  const drawn = compiled.getGraph();
  const graphNodes = Object.values(drawn.nodes);
  // An edge back to a node on the current path from START is a loop.
  const loops = new Set();
  const visited = new Set();
  const visit = (at, path) => {
    visited.add(at);
    path.add(at);
    for (const e of drawn.edges.filter((x) => x.source === at)) {
      if (path.has(e.target)) loops.add(e);
      else if (!visited.has(e.target)) visit(e.target, path);
    }
    path.delete(at);
  };
  visit(START, new Set());
  const nodes = [];
  for (const node of graphNodes) {
    const info = ENDPOINTS[node.id] ?? node.metadata ?? {};
    const steps = node.id === START ? start : node.id === END ? end : info.steps ?? [];
    // One recorded step is the node's own; several are listed under it.
    const others = steps.filter((s) => s.id !== node.id);
    const children = others.length > 1 || steps.length > others.length ? others : [];
    const records = others.length === 1 && !children.length ? [others[0].id] : [];
    nodes.push({
      id: node.id,
      kind: info.kind ?? "context",
      label: info.label ?? node.id,
      purpose: info.purpose ?? "",
      inputs: info.inputs ?? "graph state",
      outputs: info.outputs ?? "graph state",
      functions: ENDPOINTS[node.id] ? [`LangGraph ${node.id}`] : [`LangGraph node: ${node.id}`, ...(info.functions ?? [])],
      ...(children.length ? { children: children.map((s) => s.id) } : {}),
      ...(records.length ? { records } : {}),
    });
    for (const step of children)
      nodes.push({
        id: step.id, kind: step.kind, label: step.label, purpose: step.purpose ?? "",
        inputs: step.inputs ?? "", outputs: step.outputs ?? "", functions: step.functions ?? [], parent: node.id,
      });
  }
  const edges = drawn.edges.map((e) => ({
    from: e.source,
    to: e.target,
    ...(e.data ? { condition: String(e.data) } : {}),
    ...(loops.has(e) ? { kind: "loop" } : e.conditional ? { kind: "branch" } : {}),
  }));
  return { ...meta, nodes, edges };
}
