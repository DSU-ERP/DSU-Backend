// Competency taxonomy for topic rankings. A topic is ranked only when a v1
// source can genuinely evidence it: LeetCode topic tags for DSA, classified
// GitHub repositories for project areas. Everything else is listed as not yet
// assessed, ready for MSE, semester-end, lab and placement-test sources later.
// Keep in sync with the seed in supabase/migrations/202610270001_student_ranking.sql
// (test/ranking.integration.test.js compares them).

const dsa = (code, label, tags) => ({ code, family: "dsa", label, source: "leetcode", leetcodeTags: tags });
const area = (code, family, label) => ({ code, family, label, source: "github" });
const later = (code, family, label) => ({ code, family, label, source: null });

export const TOPICS = Object.freeze([
  dsa("dsa.arrays", "Arrays", ["array"]),
  dsa("dsa.strings", "Strings", ["string"]),
  dsa("dsa.hashing", "Hashing", ["hash-table"]),
  dsa("dsa.linked-lists", "Linked lists", ["linked-list"]),
  dsa("dsa.stacks", "Stacks", ["stack", "monotonic-stack"]),
  dsa("dsa.queues", "Queues", ["queue", "monotonic-queue"]),
  dsa("dsa.trees", "Trees", ["tree", "binary-tree", "binary-search-tree"]),
  dsa("dsa.graphs", "Graphs", ["graph", "breadth-first-search", "depth-first-search", "topological-sort", "shortest-path"]),
  dsa("dsa.dynamic-programming", "Dynamic programming", ["dynamic-programming", "memoization"]),
  dsa("dsa.greedy", "Greedy algorithms", ["greedy"]),
  dsa("dsa.binary-search", "Binary search", ["binary-search"]),
  dsa("dsa.recursion", "Recursion", ["recursion"]),
  dsa("dsa.backtracking", "Backtracking", ["backtracking"]),
  dsa("dsa.heaps", "Heaps", ["heap-priority-queue"]),
  dsa("dsa.sorting", "Sorting", ["sorting"]),
  dsa("dsa.sliding-window", "Sliding window", ["sliding-window"]),
  dsa("dsa.two-pointers", "Two pointers", ["two-pointers"]),
  dsa("dsa.bit-manipulation", "Bit manipulation", ["bit-manipulation"]),
  area("project.web", "software", "Web development"),
  area("project.backend", "software", "Backend development"),
  area("project.fullstack", "software", "Full-stack development"),
  area("project.python", "software", "Python development"),
  area("project.java", "software", "Java development"),
  area("project.cloud-devops", "software", "Cloud and DevOps"),
  area("project.mobile", "software", "Mobile development"),
  area("project.ml", "specialization", "Machine learning projects"),
  area("project.data-science", "specialization", "Data science projects"),
  area("project.cybersecurity", "specialization", "Cybersecurity projects"),
  area("project.embedded", "specialization", "Embedded systems projects"),
  area("project.robotics", "specialization", "Robotics projects"),
  later("core.oop", "software", "Object-oriented programming"),
  later("core.software-testing", "software", "Software testing"),
  later("core.dbms", "core-cs", "Database management systems"),
  later("core.os", "core-cs", "Operating systems"),
  later("core.networks", "core-cs", "Computer networks"),
  later("core.organization", "core-cs", "Computer organization"),
  later("core.software-engineering", "core-cs", "Software engineering"),
  later("spec.ai", "specialization", "Artificial intelligence"),
]);

export const TOPIC_CODES = new Set(TOPICS.map((t) => t.code));
