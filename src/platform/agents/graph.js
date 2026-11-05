// Shared LangGraph helpers for the F.R.I.D.A.Y. assistants. Each assistant is a
// StateGraph whose nodes are the steps the tracer records, so the Admin portal's
// architecture view (src/modules/ops/workflows.js) shows the graph that runs.
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
