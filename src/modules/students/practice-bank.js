// Authored practice content and seeded question templates. These are
// questions, not sample student records. Every practice paper is drawn from a
// server-generated seed; the paper and its seed are stored, so a resumed
// attempt keeps its exact paper while new papers receive different numbers,
// items and option order.
export const CATEGORIES = {
  aptitude: {
    name: "Aptitude",
    focus: "Percentages, ratios and quantitative placement math",
  },
  reasoning: {
    name: "Reasoning",
    focus: "Patterns, arrangements and logical decisions",
  },
  "data-interpretation": {
    name: "Data Interpretation",
    focus: "Read tables, compare evidence and explain trends",
  },
  "business-communication": {
    name: "Business Communication",
    focus: "Clarity, professional tone and concise writing",
  },
  "case-analysis": {
    name: "Case Analysis",
    focus: "Market sizing, profitability and structured decisions",
  },
  "management-basics": {
    name: "Management Basics",
    focus: "Marketing, finance, operations, HR and strategy",
  },
};
export const LEVEL_LABELS = [
  "Foundation",
  "Core application",
  "Placement standard",
  "Advanced mixed set",
  "Interview challenge",
];
const WRITTEN_MARKS = 3;
const WRITTEN_LEVELS = {
  "business-communication": 3,
  "case-analysis": 3,
  "management-basics": 4,
};

// FNV-1a hash of the seed and paper identity feeding a mulberry32 generator.
function random(seed, salt) {
  const text = `${seed}|${salt}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r, min, max) => min + Math.floor(r() * (max - min + 1));
const pick = (r, list) => list[Math.floor(r() * list.length)];
function shuffle(r, list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
// Decimal-safe half-up rounding to two places (1.005 -> 1.01).
export function round2(value) {
  const sign = value < 0 ? -1 : 1;
  const scaled = Number(Number(Math.abs(value)).toPrecision(12) + "e2");
  return sign * Number(Math.round(scaled) + "e-2");
}
const grouped = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const fixed = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const n = (v) => grouped.format(round2(v) || 0);
const n2 = (v) => fixed.format(round2(v) || 0);
const rupees = (v) => "₹" + n(v);
const signedRupees = (v) => (v < 0 ? "−₹" + n(-v) : "₹" + n(v));
const pct = (v) => n(v) + "%";
const pct2 = (v) => n2(v) + "%";
const unit = (label) => (v) => n(v) + " " + label;
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
function ordinal(v) {
  if (v % 100 >= 11 && v % 100 <= 13) return v + "th";
  return v + ({ 1: "st", 2: "nd", 3: "rd" }[v % 10] || "th");
}
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function choice(r, section, question, correct, wrong, explanation) {
  const options = shuffle(r, [correct, ...wrong]);
  return {
    section,
    type: "mcq",
    question,
    options,
    correctIndex: options.indexOf(correct),
    expectedPoints: [],
    marks: 1,
    explanation,
  };
}
// Distinct options: plausible mistakes first, then honest neighbouring values.
function distinct(correct, candidates, fillers) {
  const options = [correct];
  for (const value of [...candidates, ...fillers]) {
    if (options.length === 4) break;
    if (value && !options.includes(value)) options.push(value);
  }
  if (options.length < 4) throw Error("Practice template needs more options");
  return options.slice(1);
}
function numeric(r, spec) {
  const { section, question, answer, wrong, format, step, explanation } = spec;
  const valid = (v) => Number.isFinite(v) && (answer < 0 || v >= 0);
  const fillers = [];
  for (let k = 1; k <= 12; k++)
    fillers.push(answer + step * k, answer - step * k);
  return choice(
    r,
    section,
    question,
    format(answer),
    distinct(
      format(answer),
      wrong.filter(valid).map(format),
      fillers.filter(valid).map(format),
    ),
    explanation,
  );
}
const written = (section, question, expectedPoints, explanation) => ({
  section,
  type: "short",
  question,
  options: [],
  correctIndex: null,
  expectedPoints,
  marks: WRITTEN_MARKS,
  explanation,
});
// Authored item: [section, question, correct answer, three wrong answers, explanation].
const authored = (r, [section, question, correct, wrong, explanation]) =>
  choice(r, section, question, correct, wrong, explanation);

const APTITUDE = {
  1: [
    (r) => {
      const p = pick(r, [5, 10, 12, 15, 20, 25, 30, 40]),
        base = int(r, 4, 60) * 50,
        answer = (base * p) / 100;
      return numeric(r, {
        section: "Percentages",
        question: `What is ${p}% of ${n(base)}?`,
        answer,
        wrong: [(base * p) / 1000, base + answer, base - answer],
        format: n,
        step: 5,
        explanation: `${p}% means ${p}/100, so ${p}/100 × ${n(base)} = ${n(answer)}.`,
      });
    },
    (r) => {
      const [a, b] = pick(r, [[1, 2], [2, 3], [3, 4], [2, 5], [3, 5], [4, 5], [3, 7], [5, 7]]);
      const [x, y] = r() < 0.5 ? [a, b] : [b, a];
      const k = int(r, 3, 40) * 10,
        total = (x + y) * k,
        answer = y * k;
      return numeric(r, {
        section: "Ratio & proportion",
        question: `₹${n(total)} is divided between Asha and Ben in the ratio ${x} : ${y}. How much does Ben receive?`,
        answer,
        wrong: [x * k, total / 2, total / y],
        format: rupees,
        step: k,
        explanation: `There are ${x + y} equal parts of ₹${n(k)}. Ben receives ${y} parts: ${y} × ${n(k)} = ₹${n(answer)}.`,
      });
    },
    (r) => {
      const P = int(r, 4, 40) * 500,
        R = pick(r, [4, 5, 6, 8, 10, 12]),
        T = int(r, 2, 5),
        answer = (P * R * T) / 100;
      return numeric(r, {
        section: "Interest",
        question: `What is the simple interest on ₹${n(P)} at ${R}% per year for ${T} years?`,
        answer,
        wrong: [(P * R) / 100, P + answer, answer / 10],
        format: rupees,
        step: (P * R) / 100,
        explanation: `Simple interest = P × R × T ÷ 100 = ${n(P)} × ${R} × ${T} ÷ 100 = ₹${n(answer)}.`,
      });
    },
    (r) => {
      const values = Array.from({ length: 5 }, () => int(r, 12, 95)),
        sum = values.reduce((s, v) => s + v, 0),
        sorted = [...values].sort((x, y) => x - y),
        answer = sum / 5;
      return numeric(r, {
        section: "Averages",
        question: `What is the average of ${values.join(", ")}?`,
        answer,
        wrong: [sum / 4, sorted[2], (sorted[0] + sorted[4]) / 2],
        format: n,
        step: 1,
        explanation: `Add the five values (${sum}) and divide by 5: ${n(answer)}.`,
      });
    },
  ],
  2: [
    (r) => {
      const p = pick(r, [5, 8, 10, 12, 15, 20, 25]),
        base = int(r, 4, 60) * 50,
        answer = (base * (100 + p)) / 100;
      return numeric(r, {
        section: "Percentages",
        question: `A value of ${n(base)} increases by ${p}%. What is the new value?`,
        answer,
        wrong: [(base * p) / 100, (base * (100 - p)) / 100, base + p],
        format: n,
        step: base / 20,
        explanation: `Multiply by (1 + ${p}/100): ${n(base)} × ${n(1 + p / 100)} = ${n(answer)}.`,
      });
    },
    (r) => {
      const p = pick(r, [10, 12.5, 20, 25, 40, 50]),
        C = int(r, 4, 40) * 40,
        S = (C * (100 + p)) / 100;
      return numeric(r, {
        section: "Profit & loss",
        question: `An item bought for ₹${n(C)} is sold for ₹${n(S)}. What is the profit percentage on cost?`,
        answer: p,
        wrong: [((S - C) / S) * 100, p / 2, p + 10],
        format: pct,
        step: 5,
        explanation: `Profit is ₹${n(S - C)}. Profit % on cost = ${n(S - C)} ÷ ${n(C)} × 100 = ${n(p)}%. Dividing by the selling price gives the margin, not the profit on cost.`,
      });
    },
    (r) => {
      const speed = pick(r, [36, 54, 72, 90, 108, 126]),
        answer = (speed * 5) / 18;
      return numeric(r, {
        section: "Speed & distance",
        question: `A vehicle travels at ${speed} km/h. What is its speed in metres per second?`,
        answer,
        wrong: [(speed * 18) / 5, (speed * 1000) / 60, speed / 60],
        format: unit("m/s"),
        step: 5,
        explanation: `1 km/h = 1000 m ÷ 3600 s = 5/18 m/s, so ${speed} × 5/18 = ${n(answer)} m/s.`,
      });
    },
    (r) => {
      const count = pick(r, [4, 5, 8, 10]),
        average = int(r, 25, 70),
        d = int(r, 1, 6),
        x = int(r, 10, average),
        y = x + count * d,
        answer = average + d;
      return numeric(r, {
        section: "Averages",
        question: `The average of ${count} numbers is ${average}. One number, ${x}, is replaced by ${y}. What is the new average?`,
        answer,
        wrong: [average + (y - x), average, average - d],
        format: n,
        step: 1,
        explanation: `The total rises by ${y} − ${x} = ${y - x}; spread over ${count} numbers that is ${d}, so the new average is ${answer}.`,
      });
    },
  ],
  3: [
    (r) => {
      const L = int(r, 10, 80) * 100,
        d1 = pick(r, [10, 20, 25]),
        d2 = pick(r, [5, 10, 20]),
        answer = (((L * (100 - d1)) / 100) * (100 - d2)) / 100;
      return numeric(r, {
        section: "Profit & loss",
        question: `A jacket listed at ₹${n(L)} gets successive discounts of ${d1}% and ${d2}%. What is the final price?`,
        answer,
        wrong: [(L * (100 - d1 - d2)) / 100, (L * (100 - d1)) / 100, (L * d1 * d2) / 10000],
        format: rupees,
        step: L / 20,
        explanation: `Apply each discount in turn: ${n(L)} × ${n(1 - d1 / 100)} × ${n(1 - d2 / 100)} = ₹${n(answer)}. Successive discounts do not simply add.`,
      });
    },
    (r) => {
      const P = int(r, 2, 40) * 1000,
        R = pick(r, [5, 10, 20]),
        answer = P * ((1 + R / 100) ** 2 - 1);
      return numeric(r, {
        section: "Interest",
        question: `What is the compound interest on ₹${n(P)} at ${R}% per year for 2 years, compounded annually?`,
        answer,
        wrong: [(2 * P * R) / 100, P * (1 + R / 100) ** 2, answer + (P * R) / 100],
        format: rupees,
        step: (P * R) / 200,
        explanation: `Amount = ${n(P)} × (1 + ${R}/100)² = ₹${n(P * (1 + R / 100) ** 2)}; interest = amount − principal = ₹${n(answer)}.`,
      });
    },
    (r) => {
      const [a, b] = pick(r, [[10, 15], [12, 24], [20, 30], [6, 12], [15, 30], [12, 36], [18, 36], [10, 40], [24, 40], [30, 60], [12, 60], [20, 80]]),
        answer = (a * b) / (a + b);
      return numeric(r, {
        section: "Time & work",
        question: `Anil can finish a job in ${a} days and Bina in ${b} days. Working together, how many days will they take?`,
        answer,
        wrong: [(a + b) / 2, a + b, b - a],
        format: unit("days"),
        step: 1,
        explanation: `Combined daily work = 1/${a} + 1/${b} = ${a + b}/${a * b}, so time = ${a * b} ÷ ${a + b} = ${n(answer)} days.`,
      });
    },
    (r) => {
      const [s1, s2] = pick(r, [[30, 60], [40, 60], [20, 30], [60, 90], [45, 90], [36, 45], [24, 40], [50, 75], [30, 45]]),
        answer = (2 * s1 * s2) / (s1 + s2);
      return numeric(r, {
        section: "Speed & distance",
        question: `A cyclist rides from A to B at ${s1} km/h and returns by the same route at ${s2} km/h. What is the average speed for the whole journey?`,
        answer,
        wrong: [(s1 + s2) / 2, s1 + s2, s2 - s1],
        format: unit("km/h"),
        step: 2,
        explanation: `For equal distances, average speed = 2 × ${s1} × ${s2} ÷ (${s1} + ${s2}) = ${n(answer)} km/h, not the simple mean.`,
      });
    },
  ],
  4: [
    (r) => {
      const base = int(r, 4, 60) * 50,
        p = pick(r, [10, 15, 20, 25, 30]),
        answer = base * (1 + p / 100) * (1 - p / 100);
      return numeric(r, {
        section: "Percentages",
        question: `A value of ${n(base)} rises ${p}% and then falls ${p}%. What is its final value?`,
        answer,
        wrong: [base, base * (1 + p / 100), base - p],
        format: n,
        step: base / 50,
        explanation: `Multiply ${n(base)} by ${n(1 + p / 100)} and then by ${n(1 - p / 100)}: ${n(answer)}. Equal percentage rises and falls do not cancel.`,
      });
    },
    (r) => {
      const v = pick(r, [15, 20, 25, 30]),
        t = int(r, Math.ceil(200 / v), Math.ceil(200 / v) + 10),
        total = v * t,
        L1 = 10 * int(r, 8, Math.floor(total / 10) - 8),
        L2 = total - L1,
        sum = (v * 18) / 5;
      let s1 = 9 * int(r, 2, sum / 9 - 2),
        s2 = sum - s1;
      if (s1 === s2) [s1, s2] = [s1 - 9, s2 + 9];
      return numeric(r, {
        section: "Speed & distance",
        question: `Two trains ${L1} m and ${L2} m long run towards each other on parallel tracks at ${s1} km/h and ${s2} km/h. How long do they take to cross each other completely?`,
        answer: t,
        wrong: [total / sum, total / ((Math.abs(s1 - s2) * 5) / 18), L1 / v],
        format: unit("seconds"),
        step: 2,
        explanation: `Relative speed = ${s1} + ${s2} = ${sum} km/h = ${v} m/s. Distance = ${L1} + ${L2} = ${total} m, so time = ${total} ÷ ${v} = ${t} seconds.`,
      });
    },
    (r) => {
      const P = int(r, 2, 30) * 1000,
        answer = (P * 331) / 1000;
      return numeric(r, {
        section: "Interest",
        question: `What is the compound interest on ₹${n(P)} at 10% per year for 3 years, compounded annually?`,
        answer,
        wrong: [(P * 3) / 10, (P * 1331) / 1000, (P * 21) / 100],
        format: rupees,
        step: P / 50,
        explanation: `Amount = ${n(P)} × 1.1³ = ${n(P)} × 1.331 = ₹${n((P * 1331) / 1000)}; interest = ₹${n(answer)}.`,
      });
    },
    (r) => {
      const [m, d] = pick(r, [[50, 20], [40, 25], [60, 25], [30, 10], [20, 10], [50, 10], [80, 25], [40, 10], [25, 12]]),
        answer = m - d - (m * d) / 100;
      return numeric(r, {
        section: "Profit & loss",
        question: `A shopkeeper marks goods ${m}% above cost and then offers a ${d}% discount on the marked price. What is the profit percentage on cost?`,
        answer,
        wrong: [m - d, m, (m + d) / 2],
        format: pct,
        step: 3,
        explanation: `Selling price = cost × ${n(1 + m / 100)} × ${n(1 - d / 100)} = cost × ${n((1 + m / 100) * (1 - d / 100))}, a profit of ${n(answer)}%.`,
      });
    },
  ],
  5: [
    (r) => {
      const [a, b] = pick(r, [[4, 6], [6, 12], [3, 4], [5, 10], [6, 9], [8, 12], [10, 15], [4, 12], [6, 10], [9, 18]]),
        answer = (a * b) / (b - a);
      return numeric(r, {
        section: "Time & work",
        question: `Pipe A fills a tank in ${a} hours and pipe B empties it in ${b} hours. If both are opened together on an empty tank, how long will it take to fill?`,
        answer,
        wrong: [(a * b) / (a + b), b - a, (a + b) / 2],
        format: unit("hours"),
        step: 2,
        explanation: `Net filling per hour = 1/${a} − 1/${b} = ${b - a}/${a * b}, so the tank fills in ${a * b} ÷ ${b - a} = ${n(answer)} hours.`,
      });
    },
    (r) => {
      const [a, b] = pick(r, [[3, 4], [2, 3], [4, 5], [5, 6], [3, 5], [5, 7]]),
        k = int(r, 4, 12),
        years = pick(r, [4, 5, 6, 8, 10]),
        A = a * k,
        B = b * k,
        g = gcd(A + years, B + years);
      return numeric(r, {
        section: "Ratio & proportion",
        question: `The present ages of Ravi and Meera are in the ratio ${a} : ${b}. After ${years} years the ratio will be ${(A + years) / g} : ${(B + years) / g}. What is Ravi's present age?`,
        answer: A,
        wrong: [B, A + years, a * years],
        format: unit("years"),
        step: a,
        explanation: `Let the ages be ${a}k and ${b}k. Solving (${a}k + ${years}) : (${b}k + ${years}) = ${(A + years) / g} : ${(B + years) / g} gives k = ${k}, so Ravi is ${A}.`,
      });
    },
    (r) => {
      const p1 = int(r, 3, 8) * 10,
        gap = int(r, 3, 6),
        p2 = p1 + gap * 10,
        steps = Array.from({ length: gap - 1 }, (_, i) => i + 1).filter((j) => 2 * j !== gap),
        m = p1 + 10 * pick(r, steps),
        g = gcd(p2 - m, m - p1),
        x = (p2 - m) / g,
        y = (m - p1) / g,
        h = gcd(p1, p2);
      return choice(
        r,
        "Ratio & proportion",
        `In what ratio must rice costing ₹${p1}/kg be mixed with rice costing ₹${p2}/kg to obtain a mixture worth ₹${m}/kg?`,
        `${x} : ${y}`,
        distinct(`${x} : ${y}`, [`${y} : ${x}`, `${p1 / h} : ${p2 / h}`, "1 : 1"], ["1 : 2", "2 : 1", "1 : 3", "3 : 1", "2 : 3", "3 : 2"]),
        `By alligation, cheaper : dearer = (${p2} − ${m}) : (${m} − ${p1}) = ${x} : ${y}.`,
      );
    },
    (r) => {
      const e = pick(r, [2, 3, 4]),
        t = e * int(r, 2, 8),
        answer = (t * (e + 1)) / e;
      return numeric(r, {
        section: "Time & work",
        question: `Asha is ${e} times as efficient as Bala. Working together they finish a job in ${t} days. How many days would Asha take alone?`,
        answer,
        wrong: [t * (e + 1), t * e, t + e],
        format: unit("days"),
        step: 1,
        explanation: `If Bala does 1 unit a day, Asha does ${e}; together ${e + 1} units a day for ${t} days = ${t * (e + 1)} units. Asha alone needs ${t * (e + 1)} ÷ ${e} = ${n(answer)} days.`,
      });
    },
  ],
};

const letter = (i) => LETTERS[((i % 26) + 26) % 26];
const shift = (word, k) => [...word].map((c) => letter(LETTERS.indexOf(c) + k)).join("");
const nearbyLetters = (i) => [i + 1, i - 1, i + 2, i - 2, i + 3, i - 3].filter((j) => j >= 0 && j < 26).map(letter);
const WORDS = ["COLD", "LAMP", "ROAD", "FISH", "GOLD", "BEAM", "DESK", "MILK", "NOTE", "PARK", "WIND", "SHIP"];
const NAMES = ["Arjun", "Divya", "Kiran", "Meera", "Nikhil", "Priya", "Rahul", "Sana", "Tara", "Vikram"];
const GROUPS = ["managers", "analysts", "engineers", "designers", "readers", "writers", "players", "painters", "singers", "traders", "doctors", "pilots"];
const series = (r, section, terms, answer, wrong, step, explanation) =>
  numeric(r, {
    section,
    question: `What comes next in the series ${terms.join(", ")}, ?`,
    answer,
    wrong,
    format: n,
    step,
    explanation,
  });
function syllogism(r, forms) {
  const [a, b, c] = shuffle(r, GROUPS).slice(0, 3);
  const [premises, correct, wrong, why] = pick(r, forms)(a, b, c);
  return choice(
    r,
    "Syllogisms",
    `Statements: ${premises} Which conclusion definitely follows?`,
    correct,
    wrong,
    why,
  );
}
const BASIC_SYLLOGISMS = [
  (a, b, c) => [`All ${a} are ${b}. All ${b} are ${c}.`, `All ${a} are ${c}.`, [`All ${c} are ${a}.`, `No ${a} are ${c}.`, `Some ${c} are not ${b}.`], `All ${a} are inside ${b}, and all ${b} are inside ${c}, so all ${a} are ${c}. The reverse does not follow.`],
  (a, b, c) => [`All ${a} are ${b}. Some ${c} are ${a}.`, `Some ${c} are ${b}.`, [`All ${c} are ${b}.`, `All ${b} are ${a}.`, `No ${c} are ${b}.`], `The ${c} who are ${a} must also be ${b}, so at least some ${c} are ${b}.`],
  (a, b, c) => [`No ${a} are ${b}. All ${c} are ${a}.`, `No ${c} are ${b}.`, [`Some ${c} are ${b}.`, `All ${b} are ${c}.`, `All ${a} are ${c}.`], `All ${c} are ${a}, and none of the ${a} are ${b}, so no ${c} are ${b}.`],
  (a, b, c) => [`Some ${a} are ${b}. All ${b} are ${c}.`, `Some ${a} are ${c}.`, [`All ${a} are ${c}.`, `All ${c} are ${a}.`, `No ${a} are ${c}.`], `The ${a} who are ${b} are also ${c}, so some ${a} are ${c}.`],
];
const HARD_SYLLOGISMS = [
  (a, b, c) => [`Some ${a} are ${b}. No ${b} are ${c}.`, `Some ${a} are not ${c}.`, [`No ${a} are ${c}.`, `Some ${c} are ${a}.`, `All ${a} are ${c}.`], `The ${a} who are ${b} cannot be ${c}, so some ${a} are not ${c}. Nothing is known about the remaining ${a}.`],
  ...BASIC_SYLLOGISMS.slice(2),
];
const MEN = ["Arjun", "Nikhil", "Rahul", "Vikram", "Rohan", "Karan"];
const WOMEN = ["Divya", "Meera", "Priya", "Sana", "Tara", "Ananya"];
// Each role has a fixed gender so the relation is unambiguous.
const RELATIONS = [
  ["MWA", (p, q, s) => [`${p} is the brother of ${q}. ${q} is the daughter of ${s}. How is ${p} related to ${s}?`, "Son", ["Brother", "Nephew", "Father"], `${p} is male and a sibling of ${s}'s daughter, so ${p} is ${s}'s son.`]],
  ["WMA", (p, q, s) => [`${p} is the sister of ${q}. ${q} is the father of ${s}. How is ${p} related to ${s}?`, "Aunt", ["Mother", "Sister", "Grandmother"], `${p} is the sister of ${s}'s father, so ${p} is ${s}'s aunt.`]],
  ["MMA", (p, q, s) => [`${p} is the son of ${q}. ${q} is the brother of ${s}. How is ${p} related to ${s}?`, "Nephew", ["Son", "Brother", "Cousin"], `${p} is the son of ${s}'s brother, so ${p} is ${s}'s nephew.`]],
  ["MWA", (p, q, s) => [`${p} is the father of ${q}. ${q} is the mother of ${s}. How is ${p} related to ${s}?`, "Grandfather", ["Father", "Uncle", "Brother"], `${p} is the father of ${s}'s mother, so ${p} is ${s}'s maternal grandfather.`]],
];
function relation(r) {
  const [roles, build] = pick(r, RELATIONS);
  const men = shuffle(r, MEN), women = shuffle(r, WOMEN), any = shuffle(r, [...MEN, ...WOMEN]);
  const used = new Set();
  const names = [...roles].map((role) => {
    const list = role === "M" ? men : role === "W" ? women : any;
    const name = list.find((item) => !used.has(item));
    used.add(name);
    return name;
  });
  const [question, correct, wrong, why] = build(...names);
  return choice(r, "Blood relations", question, correct, wrong, why);
}
const TRIPLES = [[3, 4, 5], [6, 8, 10], [5, 12, 13], [8, 15, 17], [9, 12, 15], [12, 16, 20]];
const DIRECTIONS = ["North", "East", "South", "West"];

const REASONING = {
  1: [
    (r) => {
      const start = int(r, 2, 40),
        step = int(r, 3, 15),
        terms = [0, 1, 2, 3, 4].map((i) => start + i * step),
        answer = start + 5 * step;
      return series(r, "Number series", terms, answer, [answer + step, answer - 1, answer + 2], 1, `Each term increases by ${step}.`);
    },
    (r) => {
      const skip = int(r, 2, 4),
        start = int(r, 0, 25 - 4 * skip),
        terms = [0, 1, 2, 3].map((i) => letter(start + i * skip)),
        index = start + 4 * skip;
      return choice(r, "Letter series", `What comes next in the series ${terms.join(", ")}, ?`, letter(index), distinct(letter(index), [], nearbyLetters(index)), `Each letter moves ${skip} places forward in the alphabet.`);
    },
    (r) => {
      const word = pick(r, ["CAT", "DOG", "PEN", "MAP", "SUN", "BOX", "CUP", "KEY", "JAR", "INK", "OWL", "FAN"]),
        answer = [...word].reduce((s, c) => s + LETTERS.indexOf(c) + 1, 0);
      return numeric(r, {
        section: "Coding-decoding",
        question: `If A = 1, B = 2, …, Z = 26, what is the value of ${word} (the sum of its letters)?`,
        answer,
        wrong: [answer - 3, answer + 1, answer + 3],
        format: n,
        step: 2,
        explanation: `${[...word].map((c) => `${c} = ${LETTERS.indexOf(c) + 1}`).join(", ")}; the sum is ${answer}.`,
      });
    },
  ],
  2: [
    (r) => {
      const a = int(r, 2, 20), b = int(r, 30, 60), d1 = int(r, 2, 6), d2 = -int(r, 2, 5);
      const terms = [a, b, a + d1, b + d2, a + 2 * d1, b + 2 * d2],
        answer = a + 3 * d1;
      return series(r, "Number series", terms, answer, [b + 3 * d2, answer + d1, terms[5] + d1], 1, `Two series alternate: ${a}, ${a + d1}, ${a + 2 * d1}… rises by ${d1}; ${b}, ${b + d2}, ${b + 2 * d2}… falls by ${-d2}. The 7th term continues the first series.`);
    },
    (r) => {
      const s = int(r, 2, 7), c = int(r, -3, 5),
        terms = [0, 1, 2, 3].map((i) => (s + i) ** 2 + c),
        answer = (s + 4) ** 2 + c;
      return series(r, "Number series", terms, answer, [(s + 4) ** 2, terms[3] + (terms[3] - terms[2]), answer + 1], 1, `The terms are consecutive squares${c > 0 ? " plus " + c : c < 0 ? " minus " + -c : ""}: ${s + 4}²${c > 0 ? " + " + c : c < 0 ? " − " + -c : ""} = ${answer}.`);
    },
    (r) => {
      const start = int(r, 0, 10),
        terms = [0, 1, 3, 6, 10].map((i) => letter(start + i)),
        index = start + 15;
      return choice(r, "Letter series", `What comes next in the series ${terms.join(", ")}, ?`, letter(index), distinct(letter(index), [letter(start + 14)], nearbyLetters(index)), "The gaps grow by one each time: +1, +2, +3, +4, so the next gap is +5.");
    },
    (r) => {
      const [w1, w2] = shuffle(r, WORDS).slice(0, 2), k = int(r, 1, 3), answer = shift(w2, k);
      return choice(r, "Coding-decoding", `If ${w1} is written as ${shift(w1, k)}, how is ${w2} written in the same code?`, answer, distinct(answer, [shift(w2, k + 1), shift(w2, -k), [...answer].reverse().join("")], [shift(w2, k + 2)]), `Each letter moves ${k} place${k > 1 ? "s" : ""} forward: ${w2} → ${answer}.`);
    },
  ],
  3: [
    (r) => {
      const ratio = pick(r, [2, 3]), start = int(r, 2, ratio === 2 ? 12 : 6),
        terms = [0, 1, 2, 3].map((i) => start * ratio ** i),
        answer = start * ratio ** 4;
      return series(r, "Number series", terms, answer, [terms[3] + (terms[3] - terms[2]), answer + start, answer * ratio], start, `Each term is multiplied by ${ratio}.`);
    },
    (r) => {
      const a = int(r, 2, 20), d = int(r, 1, 5), e = int(r, 2, 4),
        terms = [a];
      for (let i = 0; i < 4; i++) terms.push(terms[i] + d + i * e);
      const answer = terms[4] + d + 4 * e;
      return series(r, "Number series", terms, answer, [terms[4] + d + 3 * e, answer + e, answer - 1], 1, `The differences are ${d}, ${d + e}, ${d + 2 * e}, ${d + 3 * e}; they grow by ${e}, so the next difference is ${d + 4 * e}.`);
    },
    (r) => {
      const [w1, w2] = shuffle(r, WORDS).slice(0, 2), k = int(r, 1, 2), answer = shift(w2, -k);
      return choice(r, "Coding-decoding", `If ${w1} is coded as ${shift(w1, -k)}, how is ${w2} coded?`, answer, distinct(answer, [shift(w2, k), shift(w2, -k - 1), [...answer].reverse().join("")], [shift(w2, -k - 2)]), `Each letter moves ${k} place${k > 1 ? "s" : ""} back: ${w2} → ${answer}.`);
    },
    (r) => {
      const [a, b, c] = pick(r, TRIPLES), name = pick(r, NAMES);
      return numeric(r, {
        section: "Direction sense",
        question: `${name} walks ${a} km north, turns right and walks ${b} km. How far is ${name} from the starting point in a straight line?`,
        answer: c,
        wrong: [a + b, Math.abs(b - a), c + 2],
        format: unit("km"),
        step: 1,
        explanation: `The two legs are at right angles, so distance = √(${a}² + ${b}²) = ${c} km.`,
      });
    },
  ],
  4: [
    (r) => syllogism(r, BASIC_SYLLOGISMS),
    (r) => {
      const m = pick(r, [2, 3]), c = int(r, 1, 6), x = int(r, 2, m === 2 ? 9 : 5),
        terms = [x, x * m, x * m + c, (x * m + c) * m, (x * m + c) * m + c],
        answer = terms[4] * m;
      return series(r, "Number series", terms, answer, [terms[4] + c, answer + c, answer - c], 1, `The operations alternate: × ${m}, + ${c}. The next step is × ${m}.`);
    },
    (r) => {
      const startIndex = int(r, 0, 3), moves = Array.from({ length: int(r, 3, 4) }, () => pick(r, ["right", "left", "about"]));
      const turn = { right: 1, left: 3, about: 2 },
        final = moves.reduce((i, m) => (i + turn[m]) % 4, startIndex),
        words = moves.map((m) => (m === "about" ? "turns around" : `turns ${m}`));
      return choice(r, "Direction sense", `A person facing ${DIRECTIONS[startIndex]} ${words.slice(0, -1).join(", ")} and then ${words.at(-1)}. Which direction is the person facing now?`, DIRECTIONS[final], DIRECTIONS.filter((_, i) => i !== final), `Track each turn: right = 90° clockwise, left = 90° anticlockwise, around = 180°. The final direction is ${DIRECTIONS[final]}.`);
    },
    (r) => {
      const [a, b, c] = pick(r, TRIPLES), z = int(r, 2, 6), x = z + a, name = pick(r, NAMES);
      return numeric(r, {
        section: "Direction sense",
        question: `${name} walks ${x} km north, turns right and walks ${b} km, then turns right again and walks ${z} km. How far is ${name} from the start?`,
        answer: c,
        wrong: [x + b + z, x - z + b, c + 1],
        format: unit("km"),
        step: 1,
        explanation: `Net north–south displacement is ${x} − ${z} = ${a} km and east displacement is ${b} km, so distance = √(${a}² + ${b}²) = ${c} km.`,
      });
    },
  ],
  5: [
    (r) => syllogism(r, HARD_SYLLOGISMS),
    relation,
    (r) => {
      const k = pick(r, [2, 3]), c = int(r, 1, 4), x = int(r, c + 1, 9),
        terms = [x];
      for (let i = 0; i < 4; i++) terms.push(terms[i] * k - c);
      const answer = terms[4] * k - c;
      return series(r, "Number series", terms, answer, [terms[4] * k, terms[4] * k + c, terms[4] + (terms[4] - terms[3])], 1, `Each term is multiplied by ${k} and then reduced by ${c}.`);
    },
    (r) => {
      if (r() < 0.5) {
        const total = int(r, 30, 60), p = int(r, 5, total - 5), name = pick(r, NAMES), answer = total - p + 1;
        return numeric(r, {
          section: "Ranking",
          question: `In a row of ${total} students, ${name} is ${ordinal(p)} from the left. What is ${name}'s position from the right?`,
          answer,
          wrong: [total - p, total - p + 2, p],
          format: n,
          step: 1,
          explanation: `Position from the right = total − position from the left + 1 = ${total} − ${p} + 1 = ${answer}.`,
        });
      }
      const left = int(r, 8, 25), right = int(r, 8, 25), name = pick(r, NAMES), answer = left + right - 1;
      return numeric(r, {
        section: "Ranking",
        question: `${name} is ${ordinal(left)} from the left and ${ordinal(right)} from the right in a row. How many students are in the row?`,
        answer,
        wrong: [left + right, left + right + 1, left + right - 2],
        format: n,
        step: 1,
        explanation: `${name} is counted in both positions, so the total is ${left} + ${right} − 1 = ${answer}.`,
      });
    },
  ],
};

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];
const REGIONS = ["North", "South", "East", "West"];
const PRODUCTS = ["Alpha", "Beta", "Gamma", "Delta"];
const ratioText = (a, b) => `${a / gcd(a, b)} : ${b / gcd(a, b)}`;
const table = (labels, values, suffix = "") => labels.map((label, i) => `${label} ${n(values[i])}${suffix}`).join("; ");
function distinctValues(r, count, min, max, scale) {
  const values = new Set();
  while (values.size < count) values.add(int(r, min, max) * scale);
  return shuffle(r, [...values]);
}

const DATA = {
  1: [
    (r) => {
      const v = distinctValues(r, 4, 8, 40, 10), sum = v.reduce((s, x) => s + x, 0);
      return numeric(r, {
        section: "Totals & differences",
        question: `Quarterly sales (units): ${table(QUARTERS, v)}. What were total sales for the year?`,
        answer: sum,
        wrong: [sum - v[3], sum / 4, sum + 100],
        format: n,
        step: 10,
        explanation: `Add all four quarters: ${v.join(" + ")} = ${sum}.`,
      });
    },
    (r) => {
      const v = distinctValues(r, 4, 8, 40, 10), sorted = [...v].sort((a, b) => a - b), answer = sorted[3] - sorted[0];
      return numeric(r, {
        section: "Totals & differences",
        question: `Monthly enquiries by region: ${table(REGIONS, v)}. What is the difference between the highest and the lowest region?`,
        answer,
        wrong: [sorted[3] - sorted[1], sorted[3], sorted[2] - sorted[0]],
        format: n,
        step: 10,
        explanation: `Highest ${sorted[3]} − lowest ${sorted[0]} = ${answer}.`,
      });
    },
    (r) => {
      const v = distinctValues(r, 4, 8, 40, 10), top = v.indexOf(Math.max(...v)), low = r() < 0.5;
      const target = low ? v.indexOf(Math.min(...v)) : top;
      return choice(r, "Reading tables", `Website visits (thousands): ${table(QUARTERS, v)}. Which quarter had the ${low ? "fewest" : "most"} visits?`, QUARTERS[target], QUARTERS.filter((_, i) => i !== target), `Compare the four values; ${QUARTERS[target]} has ${n(v[target])} thousand visits.`);
    },
  ],
  2: [
    (r) => {
      const v = distinctValues(r, 4, 10, 60, 5), sum = v.reduce((s, x) => s + x, 0), answer = sum / 4;
      return numeric(r, {
        section: "Averages",
        question: `Daily orders over four days: ${table(["Mon", "Tue", "Wed", "Thu"], v)}. What is the average number of orders per day?`,
        answer,
        wrong: [sum / 3, (Math.max(...v) + Math.min(...v)) / 2, sum],
        format: n,
        step: 2.5,
        explanation: `Total ${sum} ÷ 4 days = ${n(answer)}.`,
      });
    },
    (r) => {
      const v = distinctValues(r, 4, 10, 60, 10), i = int(r, 0, 3), sum = v.reduce((s, x) => s + x, 0), answer = (v[i] / sum) * 100;
      return numeric(r, {
        section: "Share of total",
        question: `Annual revenue (₹ lakh) by region: ${table(REGIONS, v)}. What share of total revenue came from ${REGIONS[i]}? Round to two decimal places.`,
        answer,
        wrong: [(v[i] / Math.max(...v.filter((_, j) => j !== i))) * 100, (v[i] / (sum - v[i])) * 100, 25],
        format: pct2,
        step: 2,
        explanation: `${REGIONS[i]} ÷ total = ${v[i]} ÷ ${sum} × 100 = ${n2(answer)}%.`,
      });
    },
    (r) => {
      const a = int(r, 10, 40) * 10, b = a + int(r, 2, 12) * 10, answer = b - a;
      return numeric(r, {
        section: "Totals & differences",
        question: `Units sold were ${a} in Q1 and ${b} in Q4. By how many units did sales increase?`,
        answer,
        wrong: [a + b, ((b - a) / a) * 100, b],
        format: n,
        step: 10,
        explanation: `Increase = ${b} − ${a} = ${answer} units.`,
      });
    },
  ],
  3: [
    (r) => {
      const north = int(r, 2, 9) * 100, south = north + int(r, 1, 9) * 50, answer = ((south - north) / north) * 100;
      return numeric(r, {
        section: "Percentage change",
        question: `Quarterly revenue (units): North ${north}; South ${south}. By what percentage does South exceed North? Round to two decimal places.`,
        answer,
        wrong: [((south - north) / south) * 100, ((south - north) / (north + south)) * 100, south - north],
        format: pct2,
        step: 3,
        explanation: `Use (South − North) ÷ North × 100 = ${south - north} ÷ ${north} × 100 = ${n2(answer)}%. North is the base of the comparison.`,
      });
    },
    (r) => {
      const y1 = int(r, 20, 90) * 10, change = int(r, -15, 30) || 12, y2 = Math.round(y1 * (1 + change / 100)), answer = ((y2 - y1) / y1) * 100;
      return numeric(r, {
        section: "Percentage change",
        question: `A company's revenue was ₹${n(y1)} lakh in FY24 and ₹${n(y2)} lakh in FY25. What was the percentage change? Round to two decimal places (negative for a fall).`,
        answer,
        wrong: [((y2 - y1) / y2) * 100, y2 - y1, -answer],
        format: pct2,
        step: 2,
        explanation: `(FY25 − FY24) ÷ FY24 × 100 = ${n(y2 - y1)} ÷ ${n(y1)} × 100 = ${n2(answer)}%.`,
      });
    },
    (r) => {
      const v = distinctValues(r, 4, 10, 60, 10), sorted = [...v].sort((a, b) => b - a), sum = v.reduce((s, x) => s + x, 0), answer = ((sorted[0] + sorted[1]) / sum) * 100;
      return numeric(r, {
        section: "Share of total",
        question: `Market size (₹ crore) by region: ${table(REGIONS, v)}. What percentage of the total do the two largest regions account for? Round to two decimal places.`,
        answer,
        wrong: [(sorted[0] / sum) * 100, ((sorted[0] + sorted[1]) / (sorted[2] + sorted[3])) * 100, 50],
        format: pct2,
        step: 3,
        explanation: `(${sorted[0]} + ${sorted[1]}) ÷ ${sum} × 100 = ${n2(answer)}%.`,
      });
    },
  ],
  4: [
    (r) => {
      const a = int(r, 10, 35), b = a + (r() < 0.5 ? -1 : 1) * int(r, 2, 9), answer = Math.abs(b - a);
      return numeric(r, {
        section: "Percentage points",
        question: `A brand's market share moved from ${a}% to ${b}%. By how many percentage points did it ${b > a ? "rise" : "fall"}?`,
        answer,
        wrong: [(Math.abs(b - a) / a) * 100, a + b, b],
        format: unit("percentage points"),
        step: 1,
        explanation: `Percentage points compare the two shares directly: ${Math.max(a, b)} − ${Math.min(a, b)} = ${answer}. The relative change (${n2((Math.abs(b - a) / a) * 100)}%) is a different measure.`,
      });
    },
    (r) => {
      const growth = shuffle(r, [5, 9, 13, 17, 22, 28]).slice(0, 4),
        base = PRODUCTS.map(() => int(r, 10, 45) * 20),
        next = base.map((v, i) => Math.round(v * (1 + growth[i] / 100))),
        rates = base.map((v, i) => (next[i] - v) / v),
        best = rates.indexOf(Math.max(...rates));
      return choice(r, "Growth comparison", `Units sold in FY24 → FY25: ${PRODUCTS.map((p, i) => `${p} ${base[i]} → ${next[i]}`).join("; ")}. Which product grew fastest in percentage terms?`, PRODUCTS[best], PRODUCTS.filter((_, i) => i !== best), `Compare (FY25 − FY24) ÷ FY24 for each product; ${PRODUCTS[best]} grew ${n2(rates[best] * 100)}%. The largest absolute increase is not necessarily the fastest growth.`);
    },
    (r) => {
      const v = distinctValues(r, 3, 10, 50, 10), labels = REGIONS.slice(0, 3), i = int(r, 0, 2), j = (i + 1 + int(r, 0, 1)) % 3, g = gcd(v[i], v[j]);
      return choice(r, "Ratios", `Employees by office: ${table(labels, v)}. What is the ratio of ${labels[i]} to ${labels[j]} employees in simplest form?`, `${v[i] / g} : ${v[j] / g}`, distinct(`${v[i] / g} : ${v[j] / g}`, [`${v[j] / g} : ${v[i] / g}`, ratioText(v[i], v.reduce((s, x) => s + x, 0)), ratioText(v[j], v.reduce((s, x) => s + x, 0))], ["1 : 2", "2 : 1", "2 : 3", "3 : 2"]), `Divide both by their highest common factor ${g}: ${v[i] / g} : ${v[j] / g}.`);
    },
  ],
  5: [
    (r) => {
      const units = PRODUCTS.slice(0, 3).map(() => int(r, 2, 20) * 10), prices = distinctValues(r, 3, 4, 30, 10),
        total = units.reduce((s, u) => s + u, 0), revenue = units.reduce((s, u, i) => s + u * prices[i], 0), answer = revenue / total;
      return numeric(r, {
        section: "Weighted averages",
        question: `Units sold and price per unit: ${PRODUCTS.slice(0, 3).map((p, i) => `${p} ${units[i]} units at ₹${prices[i]}`).join("; ")}. What is the average price per unit sold? Round to two decimal places.`,
        answer,
        wrong: [prices.reduce((s, x) => s + x, 0) / 3, prices[units.indexOf(Math.max(...units))], (Math.max(...prices) + Math.min(...prices)) / 2],
        format: rupees,
        step: 3,
        explanation: `Weight each price by units: total revenue ₹${n(revenue)} ÷ ${total} units = ₹${n2(answer)}. A simple average of prices ignores the sales mix.`,
      });
    },
    (r) => {
      const before = distinctValues(r, 3, 10, 40, 10), labels = REGIONS.slice(0, 3),
        after = before.map((v) => v + int(r, 1, 8) * 5), i = int(r, 0, 2),
        t1 = before.reduce((s, x) => s + x, 0), t2 = after.reduce((s, x) => s + x, 0), answer = ((after[i] - before[i]) / (t2 - t1)) * 100;
      return numeric(r, {
        section: "Contribution to growth",
        question: `Revenue (₹ lakh) FY24 → FY25: ${labels.map((l, k) => `${l} ${before[k]} → ${after[k]}`).join("; ")}. What share of the total increase came from ${labels[i]}? Round to two decimal places.`,
        answer,
        wrong: [(after[i] / t2) * 100, ((after[i] - before[i]) / before[i]) * 100, ((after[i] - before[i]) / t1) * 100],
        format: pct2,
        step: 4,
        explanation: `${labels[i]} grew by ${after[i] - before[i]} of a total increase of ${t2 - t1}: ${after[i] - before[i]} ÷ ${t2 - t1} × 100 = ${n2(answer)}%.`,
      });
    },
    (r) => DATA[4][0](r),
    (r) => DATA[4][1](r),
  ],
};

const crore = (v) => "₹" + n(v) + " crore";
const lakh = (v) => "₹" + n(v) + " lakh";
const MARKET_SIZING = {
  1: (r) => {
    const H = int(r, 2, 9) * 10000, p = pick(r, [10, 20, 25, 30, 40]), s = int(r, 2, 12) * 500,
      answer = (H * p * s) / 100 / 100000;
    return numeric(r, {
      section: "Market sizing",
      question: `A town has ${n(H)} households. ${p}% own a car, and each car owner spends ₹${n(s)} a year on servicing. Estimate the annual car-servicing market.`,
      answer,
      wrong: [(H * s) / 100000, answer * 12, (answer * p) / 100],
      format: lakh,
      step: answer / 4,
      explanation: `${n(H)} households × ${p}% = ${n((H * p) / 100)} car owners × ₹${n(s)} = ₹${n((H * p * s) / 100)} = ₹${n(answer)} lakh a year.`,
    });
  },
  2: (r) => {
    const S = int(r, 10, 60) * 1000, c = pick(r, [20, 25, 40, 50]), cups = pick(r, [2, 3, 4, 5]), price = pick(r, [40, 50, 60, 80]),
      answer = (S * c * cups * price) / 100 / 100000;
    return numeric(r, {
      section: "Market sizing",
      question: `A college town has ${n(S)} students. ${c}% buy café coffee, averaging ${cups} cups a week at ₹${price} a cup. Estimate the weekly café-coffee market.`,
      answer,
      wrong: [(S * c * price) / 100 / 100000, answer * 52, (S * cups * price) / 100000],
      format: lakh,
      step: answer / 4,
      explanation: `${n(S)} × ${c}% = ${n((S * c) / 100)} buyers × ${cups} cups × ₹${price} = ₹${n((S * c * cups * price) / 100)} = ₹${n(answer)} lakh a week.`,
    });
  },
  3: (r) => {
    const P = pick(r, [20, 40, 50, 80, 100]), a = pick(r, [30, 40]), u = pick(r, [10, 20, 25]), c = pick(r, [5, 10]), m = pick(r, [100, 200, 250, 300]),
      payers = (P * 100000 * a * u * c) / 1000000, answer = (payers * m * 12) / 10000000;
    return numeric(r, {
      section: "Market sizing",
      question: `A city has ${P} lakh people. ${a}% are aged 18–35; ${u}% of them use a fitness app, and ${c}% of app users would pay ₹${m} a month for a premium plan. Estimate annual premium revenue.`,
      answer,
      wrong: [answer / 12, (answer * 100) / c, answer * 10],
      format: crore,
      step: answer / 4,
      explanation: `${P} lakh × ${a}% × ${u}% × ${c}% = ${n(payers)} paying users × ₹${m} × 12 months = ₹${n(payers * m * 12)} = ₹${n(answer)} crore.`,
    });
  },
  4: (r) => {
    const M = int(r, 2, 20) * 50, g = pick(r, [5, 10, 20]), s = pick(r, [2, 4, 5, 8]),
      answer = (M * (100 + g) * s) / 10000;
    return numeric(r, {
      section: "Market sizing",
      question: `An industry's annual market is ₹${n(M)} crore and is expected to grow ${g}% next year. A new entrant targets a ${s}% share next year. What revenue does that imply?`,
      answer,
      wrong: [(M * s) / 100, (M * (100 + g)) / 100, (M * (s + g)) / 100],
      format: crore,
      step: answer / 5,
      explanation: `Next year's market = ${n(M)} × ${n(1 + g / 100)} = ₹${n((M * (100 + g)) / 100)} crore; ${s}% of that is ₹${n(answer)} crore.`,
    });
  },
  5: (r) => {
    const T = int(r, 4, 40) * 250, a = pick(r, [20, 30, 40, 50]), b = pick(r, [5, 8, 10, 15]),
      answer = (T * a * b) / 10000;
    return numeric(r, {
      section: "Market sizing",
      question: `A total addressable market (TAM) is ₹${n(T)} crore. The serviceable market (SAM) is the ${a}% the company can reach with its channels, and it expects to capture ${b}% of SAM within three years. What is the serviceable obtainable market (SOM)?`,
      answer,
      wrong: [(T * b) / 100, (T * a) / 100, (T * (a + b)) / 100 / 10],
      format: crore,
      step: answer / 4,
      explanation: `SAM = ${n(T)} × ${a}% = ₹${n((T * a) / 100)} crore; SOM = SAM × ${b}% = ₹${n(answer)} crore.`,
    });
  },
};
const PROFITABILITY = {
  1: (r) => {
    const U = int(r, 5, 40) * 100, p = int(r, 10, 40) * 10, v = int(r, 3, p / 10 - 2) * 10,
      F = int(r, 1, Math.max(1, Math.floor((U * (p - v)) / 20000))) * 10000, answer = U * (p - v) - F;
    return numeric(r, {
      section: "Profitability",
      question: `A shop sells ${n(U)} units at ₹${p} each. Variable cost is ₹${v} per unit and fixed costs are ₹${n(F)}. What is the profit?`,
      answer,
      wrong: [U * p - F, U * (p - v), U * p - v - F],
      format: rupees,
      step: 5000,
      explanation: `Revenue ₹${n(U * p)} − variable costs ₹${n(U * v)} − fixed costs ₹${n(F)} = ₹${n(answer)}.`,
    });
  },
  2: (r) => {
    const R = int(r, 20, 90) * 10, C = Math.round((R * int(r, 40, 60)) / 100), O = Math.round((R * int(r, 15, 30)) / 100),
      answer = ((R - C - O) / R) * 100;
    return numeric(r, {
      section: "Profitability",
      question: `A firm reports revenue of ₹${R} lakh, cost of goods sold of ₹${C} lakh and operating expenses of ₹${O} lakh. What is its operating profit margin? Round to two decimal places.`,
      answer,
      wrong: [((R - C) / R) * 100, ((R - C - O) / (C + O)) * 100, 100 - answer],
      format: pct2,
      step: 3,
      explanation: `Operating profit = ${R} − ${C} − ${O} = ₹${R - C - O} lakh; margin = ${R - C - O} ÷ ${R} × 100 = ${n2(answer)}%. Gross margin would exclude operating expenses.`,
    });
  },
  3: (r) => {
    const V = int(r, 10, 50) * 100, p = int(r, 20, 40) * 10, v = int(r, 4, Math.floor((p * 0.6) / 20)) * 20,
      x = pick(r, [5, 10, 20]), y = pick(r, [5, 10, 20]),
      V2 = (V * (100 - x)) / 100, v2 = (v * (100 + y)) / 100,
      F = Math.max(10000, Math.floor((V2 * (p - v2) * int(r, 2, 4)) / 100000) * 10000),
      before = V * (p - v) - F, answer = V2 * (p - v2) - F;
    return numeric(r, {
      section: "Profitability",
      question: `A product sells ${n(V)} units at ₹${p} with variable cost ₹${v} per unit and fixed costs of ₹${n(F)}. Next year volume falls ${x}% and variable cost per unit rises ${y}%; price and fixed costs are unchanged. What will profit be?`,
      answer,
      wrong: [before, V2 * (p - v) - F, V * (p - v2) - F],
      format: rupees,
      step: 4000,
      explanation: `New volume ${n(V2)} × new contribution (₹${p} − ₹${n(v2)}) = ₹${n(V2 * (p - v2))}; minus fixed costs ₹${n(F)} = ₹${n(answer)} (was ₹${n(before)}).`,
    });
  },
  4: (r) => {
    // Isolate each driver's effect and keep only data where one driver clearly dominates.
    for (let tries = 0; tries < 40; tries++) {
      const p1 = int(r, 20, 40) * 10, V1 = int(r, 20, 60) * 100, v1 = int(r, 4, Math.floor(p1 / 20)) * 20, F1 = int(r, 2, 8) * 10000;
      const p2 = p1 - int(r, 0, 3) * 10, V2 = V1 - int(r, 0, 6) * 100, v2 = v1 + int(r, 0, 3) * 10, F2 = F1 + int(r, 0, 4) * 10000;
      const effects = [(p2 - p1) * V2, (V2 - V1) * (p1 - v1), -(v2 - v1) * V2, -(F2 - F1)];
      const order = [...effects].sort((a, b) => a - b);
      if (order[0] >= 0 || order[0] > order[1] * 1.25) continue;
      const labels = ["Lower price", "Lower volume", "Higher variable cost per unit", "Higher fixed costs"], worst = effects.indexOf(order[0]);
      return choice(r, "Profitability", `Year 1: price ₹${p1}, volume ${n(V1)} units, variable cost ₹${v1}/unit, fixed costs ₹${n(F1)}. Year 2: price ₹${p2}, volume ${n(V2)} units, variable cost ₹${v2}/unit, fixed costs ₹${n(F2)}. Which change reduced profit the most?`, labels[worst], labels.filter((_, i) => i !== worst), `Isolate each driver: price ${signedRupees(effects[0])}, volume ${signedRupees(effects[1])}, variable cost ${signedRupees(effects[2])}, fixed costs ${signedRupees(effects[3])}. The largest reduction comes from ${labels[worst].toLowerCase()}.`);
    }
    const p = int(r, 20, 40) * 10, V = int(r, 20, 60) * 100, v = int(r, 4, Math.floor(p / 20)) * 20, F = int(r, 2, 8) * 10000, rise = int(r, 3, 6) * 10000;
    const labels = ["Lower price", "Lower volume", "Higher variable cost per unit", "Higher fixed costs"];
    return choice(r, "Profitability", `Year 1: price ₹${p}, volume ${n(V)} units, variable cost ₹${v}/unit, fixed costs ₹${n(F)}. Year 2: price ₹${p}, volume ${n(V)} units, variable cost ₹${v}/unit, fixed costs ₹${n(F + rise)}. Which change reduced profit the most?`, labels[3], labels.slice(0, 3), `Price, volume and variable cost are unchanged; only fixed costs rose, by ₹${n(rise)}.`);
  },
  5: (r) => {
    const R = int(r, 40, 120) * 10, VC = Math.round((R * int(r, 45, 70)) / 100), A = Math.round((R - VC) * (1.2 + r() * 0.6)),
      avoidable = Math.round((A * int(r, 10, 60)) / 100), answer = avoidable - (R - VC),
      words = (v) => (v < 0 ? `Falls by ₹${n(-v)} lakh` : v > 0 ? `Rises by ₹${n(v)} lakh` : "No change");
    const correct = words(answer);
    return choice(r, "Profitability", `Segment B has revenue ₹${R} lakh, variable costs ₹${VC} lakh and allocated overheads ₹${A} lakh, so it reports a loss. Only ₹${avoidable} lakh of those overheads would disappear if B were closed. How would company profit change if B is closed?`, correct, distinct(correct, [words(A - (R - VC)), words(-(R - VC)), words(avoidable)], [words(answer - 10), words(answer + 10)]), `Closing B loses its contribution of ₹${R - VC} lakh and saves only the avoidable ₹${avoidable} lakh: ${avoidable} − ${R - VC} = ${answer}. Unavoidable overheads remain with the company.`);
  },
};
const PRICING = {
  1: (r) => {
    const p = int(r, 10, 60) * 10, v = int(r, 2, p / 10 - 1) * 10, answer = ((p - v) / p) * 100;
    return numeric(r, {
      section: "Pricing",
      question: `A product sells for ₹${p} and its variable cost is ₹${v} per unit. What is its contribution margin as a percentage of price? Round to two decimal places.`,
      answer,
      wrong: [((p - v) / v) * 100, (v / p) * 100, p - v],
      format: pct2,
      step: 4,
      explanation: `Contribution margin = (₹${p} − ₹${v}) ÷ ₹${p} × 100 = ${n2(answer)}%. Dividing by cost gives markup instead.`,
    });
  },
  2: (r) => {
    const m = pick(r, [20, 25, 40, 50, 60, 100]), c = int(r, 5, 40) * 20, answer = (m / (100 + m)) * 100;
    return numeric(r, {
      section: "Pricing",
      question: `A product costing ₹${c} is priced with a ${m}% markup on cost. What is the margin as a percentage of the selling price? Round to two decimal places.`,
      answer,
      wrong: [m, m / 2, 100 - m],
      format: pct2,
      step: 3,
      explanation: `Price = ₹${n((c * (100 + m)) / 100)}; profit ₹${n((c * m) / 100)} ÷ price × 100 = ${n2(answer)}%. Markup on cost and margin on price are different bases.`,
    });
  },
  3: (r) => {
    for (let tries = 0; tries < 40; tries++) {
      const p = int(r, 20, 80) * 10, v = int(r, 2, p / 10 - 4) * 10, d = pick(r, [5, 10, 15, 20]),
        c1 = p - v, c2 = (p * (100 - d)) / 100 - v;
      if (c2 <= 0) continue;
      const answer = (c1 / c2 - 1) * 100;
      return numeric(r, {
        section: "Pricing",
        question: `A product sells for ₹${p} with a variable cost of ₹${v}. If the price is cut by ${d}%, by what percentage must volume rise to keep total contribution unchanged? Round to two decimal places.`,
        answer,
        wrong: [d, ((c1 - c2) / c1) * 100, (d * p) / c1 / 2],
        format: pct2,
        step: 5,
        explanation: `Contribution per unit falls from ₹${c1} to ₹${n(c2)}. Volume must rise by ${c1} ÷ ${n(c2)} − 1 = ${n2(answer)}%.`,
      });
    }
    const p = int(r, 20, 80) * 10, v = 20, d = 10, c1 = p - v, c2 = (p * 90) / 100 - v, answer = (c1 / c2 - 1) * 100;
    return numeric(r, {
      section: "Pricing",
      question: `A product sells for ₹${p} with a variable cost of ₹${v}. If the price is cut by ${d}%, by what percentage must volume rise to keep total contribution unchanged? Round to two decimal places.`,
      answer,
      wrong: [d, ((c1 - c2) / c1) * 100, (d * p) / c1 / 2],
      format: pct2,
      step: 5,
      explanation: `Contribution per unit falls from ₹${c1} to ₹${n(c2)}. Volume must rise by ${c1} ÷ ${n(c2)} − 1 = ${n2(answer)}%.`,
    });
  },
  4: (r) => {
    const p1 = int(r, 10, 40) * 10, dp = pick(r, [5, 10, 20]), q1 = int(r, 10, 50) * 100, dq = pick(r, [2, 4, 6, 8, 15, 25, 30]),
      p2 = (p1 * (100 + dp)) / 100, q2 = (q1 * (100 - dq)) / 100, answer = dq / dp;
    return numeric(r, {
      section: "Pricing",
      question: `When the price rose from ₹${n(p1)} to ₹${n(p2)}, monthly units fell from ${n(q1)} to ${n(q2)}. Using percentage changes from the original values, what is the price elasticity of demand (absolute value)?`,
      answer,
      wrong: [dp / dq, dq, dq / dp + 1],
      format: n2,
      step: 0.25,
      explanation: `% change in quantity = ${dq}%; % change in price = ${dp}%. Elasticity = ${dq} ÷ ${dp} = ${n2(answer)} (${answer > 1 ? "elastic: revenue falls when price rises" : answer < 1 ? "inelastic: revenue rises when price rises" : "unit elastic"}).`,
    });
  },
  5: (r) => {
    const C = int(r, 4, 20) * 50000, S = int(r, 4, 12) * 25000, E = int(r, 1, 6) * 10000, K = int(r, 1, Math.floor((S + E) / 25000) - 1) * 20000, life = pick(r, [4, 5, 6]);
    const extra = Math.max(0, S + E - K);
    const answer = (C + extra * life) / 100000;
    return numeric(r, {
      section: "Pricing",
      question: `A competing machine costs ₹${n(C)} and saves a factory ₹${n(K)} a year. A new machine saves ₹${n(S)} a year in labour and ₹${n(E)} in energy over a ${life}-year life. Ignoring discounting, what is the economic value to the customer — the most a rational buyer would pay for the new machine?`,
      answer,
      wrong: [((S + E) * life) / 100000, C / 100000, (C + (S + E) * life) / 100000],
      format: lakh,
      step: 0.5,
      explanation: `Value = reference price ₹${n(C)} + extra savings (₹${n(S + E)} − ₹${n(K)}) × ${life} years = ₹${n(C + extra * life)} = ₹${n(answer)} lakh.`,
    });
  },
};

const CASE_CONCEPTS = {
  1: [
    ["Case structuring", "In a profitability case, profit is first broken into…", "Revenue and costs", ["Employees and offices", "Assets and liabilities only", "Marketing and HR"], "Profit = revenue − costs, so each branch can then be decomposed further."],
    ["Case structuring", "Revenue can be decomposed as…", "Price × number of units sold", ["Profit × tax rate", "Fixed cost + variable cost", "Assets − liabilities"], "Revenue changes through price, volume or mix."],
    ["Case structuring", "What does MECE stand for in case structuring?", "Mutually exclusive, collectively exhaustive", ["Measured, effective, complete, exact", "Most efficient cost estimate", "Market entry cost evaluation"], "Branches should not overlap and together should cover the problem."],
    ["Market sizing", "A top-down market-sizing estimate usually starts from…", "A broad population or market total, narrowed by relevant filters", ["A single customer's invoice", "The firm's organisation chart", "Last year's office expenses"], "Top-down sizing filters a large base to the relevant segment."],
  ],
  3: [
    ["Case structuring", "Profit is falling while revenue is stable. What should the structure examine next?", "Fixed and variable costs, and which cost lines changed", ["Only the price", "The firm's logo", "Revenue by month only"], "With flat revenue, the decline must come from costs or mix."],
    ["Market sizing", "Why should a market-sizing answer include a sanity check?", "To test whether the estimate is plausible against an independent reference", ["To make the number larger", "Because interviewers require a round number", "To avoid stating assumptions"], "A cross-check exposes unrealistic assumptions."],
    ["Pricing", "A client wants to raise prices. Which analysis matters most before deciding?", "Customer price sensitivity and likely competitor response", ["The number of office floors", "Last year's holiday calendar", "Employee age distribution"], "Volume response and competition determine whether a price rise increases profit."],
    ["Market sizing", "Bottom-up market sizing is built from…", "Unit-level drivers such as customers, purchase frequency and price", ["A published total for the whole economy", "The firm's share price", "A guess of the final answer"], "Bottom-up estimates multiply observable unit drivers."],
  ],
  5: [
    ["Pricing", "Value-based pricing for a B2B product sets the price ceiling at…", "The economic value it creates for the customer relative to the next-best alternative", ["Cost plus a fixed 10% margin", "The competitor's lowest price in every case", "The seller's annual salary costs"], "Customers will not pay more than the value they receive versus alternatives."],
    ["Profitability", "A segment has positive contribution but a loss after allocated overheads. Closing it would…", "Lose its contribution unless the allocated overheads are actually avoidable", ["Always increase total profit", "Eliminate all corporate overheads", "Have no effect on profit"], "Only avoidable costs disappear when a segment closes."],
    ["Case structuring", "A market-entry recommendation should end with…", "A clear go/no-go decision, key risks and next steps", ["A list of every data source", "An undecided summary", "Only the market-size figure"], "Decision-makers need the answer, its risks and what happens next."],
  ],
};
const CASE_WRITTEN = {
  3: ["Case structuring", "A regional bakery chain reports a 15% fall in profit while revenue is flat. Outline how you would structure the diagnosis.", ["Splits profit into revenue and costs and notes that flat revenue points to costs or mix", "Breaks costs into fixed and variable lines (ingredients, labour, rent, logistics) and checks which rose", "Checks product, store or channel mix shifts that lower margin despite flat revenue", "Compares with history or competitors to separate internal from industry-wide causes", "Names the data to collect next and how it would confirm the cause"], "A strong answer is structured (MECE), hypothesis-led and names the evidence needed."],
  4: ["Case structuring", "A two-wheeler maker is considering entering the electric-scooter market in Tier-2 cities. Outline the factors you would analyse before recommending entry.", ["Market size and growth, including adoption drivers and charging infrastructure", "Competition, differentiation and pricing", "Company capabilities: technology, supply chain and dealer network", "Economics: investment, unit economics and break-even timeline", "Key risks (regulation, subsidies, battery costs) and a recommendation with next steps"], "Cover market, competition, capabilities, economics and risk, then decide."],
  5: ["Pricing", "A software company charges one price per user. It is losing small customers to cheaper rivals while large customers keep renewing. Propose and justify a pricing approach.", ["Segments customers by value received and willingness to pay", "Considers tiered or value-based pricing, such as a basic tier for small customers", "Estimates the revenue impact, including cannibalisation of existing customers", "Considers competitor response and positioning", "Recommends a test or pilot with metrics to monitor"], "Link price to customer value by segment and validate before a full rollout."],
};
const COMMUNICATION = {
  1: [
    ["Email & tone", "Choose the clearest email subject.", "Action required: confirm interview slot by 4 PM", ["Hello", "URGENT!!!!!!", "Some information"], "A useful subject states the action and deadline."],
    ["Concise writing", "Which sentence is most concise?", "Please send the report by Friday.", ["It is hereby requested that the report may kindly be sent at a future point.", "Do the needful ASAP!!!", "Report. Friday. You know."], "Clarity names the action and time without unnecessary wording."],
    ["Email & tone", "Which greeting suits a first email to a recruiter you have not met?", "Dear Ms Rao,", ["Hey!!", "Yo Rao,", "Hi dear,"], "A formal greeting with the recipient's name is appropriate for a first contact."],
    ["Concise writing", "Which sentence uses the active voice?", "The team submitted the proposal on Monday.", ["The proposal was submitted by the team on Monday.", "The proposal has been submitted.", "On Monday, submission of the proposal was done."], "In the active voice the subject performs the action."],
    ["Email & tone", "Which closing line is most professional for a job-application email?", "Thank you for your time. I look forward to hearing from you.", ["Reply fast.", "Waiting!!!", "That is all, bye."], "A courteous close thanks the reader and signals the next step."],
    ["Email & tone", "You need to decline a meeting politely. Which reply is best?", "Thank you for the invitation. I have a prior commitment then; could we find another time?", ["Can't come.", "Why would I attend that?", "No."], "Thank, explain briefly and offer an alternative."],
    ["Concise writing", "Which is the plainest replacement for 'at this point in time'?", "Now", ["At this present moment in time", "Currently at this time", "As of the present point"], "Plain words communicate faster."],
  ],
  2: [
    ["Feedback", "A colleague missed a deadline. Which opening is most constructive?", "The draft was due yesterday. Can we agree a revised time and identify any blockers?", ["You always fail.", "Never mind, nothing matters.", "Everyone knows this is your fault."], "Specific facts and a practical next step support resolution."],
    ["Evidence", "Which summary best distinguishes fact from interpretation?", "Sales fell 8%; customer feedback suggests delivery delays may be a factor.", ["Sales fell because everyone is careless.", "All customers dislike us.", "Nothing can be learned from the data."], "State the measured result and qualify an unproven explanation."],
    ["Email & tone", "Which subject line best suits a thank-you note after an interview?", "Thank you – Graduate Analyst interview on 12 March", ["Following up!!!", "Hi", "Re: Re: Re: job"], "Name the purpose, role and date so the reader can place the message."],
    ["Status updates", "Your manager asks for a status update. Which reply is most useful?", "Two of three tasks are complete; the report is due Thursday and I need the sales data by Tuesday.", ["Working on it.", "Everything is fine, don't worry.", "I will let you know sometime."], "Give progress, the next milestone and any dependency."],
    ["Structure", "How should you structure a long email with several requests?", "State the purpose first, then list each request with its owner and deadline", ["Put all requests in one long paragraph", "Hide the main request at the end", "Send each sentence as a separate email"], "Readers act faster on clearly separated, owned requests."],
    ["Clarity", "A client's message is ambiguous. What should you do first?", "Restate your understanding and ask a specific clarifying question", ["Guess and proceed", "Forward it to everyone", "Wait for them to notice the problem"], "Confirming understanding early avoids rework."],
    ["Clarity", "Which sentence avoids jargon for a non-technical audience?", "The new system will cut invoice processing time from five days to two.", ["We will leverage synergistic paradigms to optimise throughput.", "The API refactor enables idempotent ingestion.", "Our KPIs will see a step-change via the new stack."], "Concrete outcomes in plain words suit a general audience."],
  ],
  3: [
    ["Executive writing", "A decision-maker has two minutes. What should an executive summary lead with?", "The recommendation, evidence and required decision", ["The full research diary", "Every raw data row", "A list of all meetings"], "Lead with what the reader needs to decide."],
    ["Evidence", "Which statement communicates uncertainty responsibly?", "The pilot suggests a 5–8% gain; a larger trial is needed before rollout.", ["The pilot guarantees success everywhere.", "Uncertainty should never be mentioned.", "Any positive pilot proves causation."], "Describe the evidence, range and remaining validation."],
    ["Presentations", "What should each presentation slide title ideally state?", "The key takeaway of the slide", ["Only the word 'Overview'", "The slide number", "The presenter's name"], "Action titles tell the audience what to conclude."],
    ["Structure", "What is the best way to present a comparison of three options?", "A table comparing options against the same criteria, with a recommendation", ["Three unrelated paragraphs", "A single sentence with no criteria", "Only the option the presenter prefers"], "Shared criteria make trade-offs visible."],
    ["Meetings", "What must meeting minutes record?", "Decisions taken, action items, owners and deadlines", ["Every joke shared", "Only the attendees' names", "Personal opinions about participants"], "Minutes exist to make follow-through clear."],
    ["Customer communication", "A customer complains publicly about a delayed order. The first written response should…", "Acknowledge the issue, apologise for the delay and state the next step with a time", ["Argue that the customer is wrong", "Ignore it until it disappears", "Promise compensation before checking the facts"], "Acknowledge, take ownership and commit to a concrete next step."],
    ["Executive writing", "Which sentence best suits an executive summary?", "We recommend expanding to Pune in Q3; the pilot showed 18% higher margins than Mumbai.", ["This report has many sections that will be explained.", "We looked at lots of things and found various results.", "Please read all appendices to understand our view."], "State the recommendation and its key evidence up front."],
  ],
  4: [
    ["Stakeholders", "Two teams disagree about a forecast. Which step best advances the decision?", "Compare assumptions, evidence and the effect on the decision", ["Vote on who speaks more confidently", "Remove all caveats", "Escalate without describing the disagreement"], "Make the material assumptions visible and decision-relevant."],
    ["Stakeholders", "A stakeholder raises a valid risk in a presentation. A strong response is…", "Acknowledge it, explain mitigation and state what remains unresolved", ["Dismiss the stakeholder", "Claim the risk is impossible", "Change the subject immediately"], "Credibility improves when limitations and mitigations are explicit."],
    ["Bad news", "You must tell a client about a project delay. Which order is most effective?", "State the delay and its impact, explain the cause briefly, then give the recovery plan and new date", ["Bury the delay in the final paragraph", "Blame a team member first", "Share a new date without explaining the impact"], "Lead with the news, then the plan."],
    ["Meetings", "Which practice best improves a cross-cultural virtual meeting?", "Share an agenda in advance, speak clearly and confirm decisions in writing", ["Use local idioms frequently", "Skip the summary to save time", "Assume silence means agreement"], "Shared structure and written confirmation reduce misunderstanding."],
    ["Stakeholders", "A stakeholder disagrees strongly by email. What is the best next step?", "Acknowledge the concern and propose a short call to resolve the specific points", ["Reply-all with a long rebuttal", "Copy their manager immediately", "Ignore the email"], "Move heated threads to a conversation focused on specific issues."],
    ["Evidence", "Which is the strongest way to support a recommendation in a business report?", "Evidence from data, explicit assumptions and the expected impact", ["Repeating the recommendation", "Vague references to 'industry experts'", "The writer's confidence alone"], "Recommendations persuade through evidence and transparent assumptions."],
    ["Structure", "When should you use bullet points in a business document?", "For parallel items such as steps, options or criteria that readers will scan", ["For every sentence of a persuasive argument", "Never, because they look informal", "Only for headings"], "Bullets help scanning; arguments need connected sentences."],
  ],
  5: [
    ["Executive writing", "A board update must explain a setback. Which structure is strongest?", "What happened, evidence, impact, corrective action and the next checkpoint", ["Only positive metrics", "A long apology without actions", "A list of people to blame"], "Decision-ready reporting combines accountability with a clear response."],
    ["Interviews", "Which STAR response is strongest?", "A specific situation, personal action, measurable result and honest learning", ["A hypothetical success presented as real", "A list of adjectives", "Only the team's result without personal contribution"], "Interview evidence should be specific and truthful about contribution."],
    ["Interviews", "How should you open your answer in a case interview?", "Clarify the objective, then outline a structured approach before analysing", ["Start calculating immediately without a plan", "State a final answer with no reasoning", "Repeat the question word for word"], "Clarifying and structuring first shows judgement."],
    ["Stakeholders", "A board member asks a question you cannot answer in a meeting. Best response?", "Acknowledge it, state what you know and commit to a specific follow-up time", ["Invent a plausible figure", "Change the subject", "Say the question is irrelevant"], "Never invent data; commit to a reliable follow-up."],
    ["Group discussion", "Which group-discussion behaviour do evaluators value most?", "Building on others' points with evidence and helping the group reach a conclusion", ["Speaking the most regardless of content", "Interrupting to dominate", "Staying silent throughout"], "Quality of contribution and facilitation matter more than airtime."],
    ["Negotiation", "When summarising a negotiation outcome in writing, what is essential?", "The agreed terms, open items, owners and the next deadline", ["Only the points you won", "A general statement that 'all is agreed'", "Emotional descriptions of the discussion"], "A written record prevents later disputes about what was agreed."],
    ["Interviews", "Which answer to 'Tell me about a failure' is strongest?", "A real example, your role, what you changed and the result afterwards", ["Claiming you have never failed", "Blaming teammates", "A hypothetical failure presented as real"], "Honest reflection and changed behaviour show learning."],
  ],
};
const COMMUNICATION_WRITTEN = {
  3: ["Rewriting", "Rewrite this message so it is clear, polite and actionable: “hey, the report thing is still not done?? need it asap, everyone is waiting”.", ["Uses a polite greeting and professional tone without blame", "Names the specific report", "Replaces 'asap' with a clear deadline", "Briefly explains the reason or impact", "Offers help or asks about blockers and closes courteously"], "A strong rewrite is specific, courteous and states exactly what is needed by when."],
  4: ["Bad news", "Write three to five sentences telling a client that a deliverable will be two days late.", ["States the delay and the new delivery date clearly at the start", "Briefly explains the cause without blaming individuals", "Describes the impact and any mitigation or interim deliverable", "Takes accountability and offers a contact or next step", "Keeps a professional, concise tone"], "Lead with the news, own it and give the recovery plan."],
  5: ["Executive writing", "Write a 60–100 word executive summary recommending whether a company should launch a premium product line. State the assumptions you use.", ["Leads with a clear recommendation", "States key evidence or assumptions such as demand, price and margin", "Notes the main risk and a mitigation", "Specifies a next step or decision checkpoint", "Is concise and structured for a senior reader"], "Executives need the decision, the reasons and the risk in a few lines."],
};

const MANAGEMENT = {
  1: [
    ["Finance", "Which statement defines working capital?", "Current assets minus current liabilities", ["Revenue minus all expenses", "Total assets minus cash", "Equity plus interest"], "Working capital measures short-term operating liquidity."],
    ["Finance", "Which of these is a variable cost?", "Raw material used for each unit", ["A fixed monthly office lease", "An annual software licence", "A fixed salary"], "Variable costs change with output."],
    ["Marketing", "Market segmentation groups customers by…", "Shared needs or characteristics", ["Alphabetical company names", "The firm's internal hierarchy", "Supplier invoice numbers"], "Segmentation identifies groups with similar needs."],
    ["Finance", "A balance sheet reports…", "Assets, liabilities and equity at a point in time", ["Only annual revenue", "Only employee attendance", "Daily stock prices"], "It is a snapshot of financial position."],
    ["Finance", "Which of these is a fixed cost for a small manufacturer?", "Monthly factory rent", ["Raw material per unit", "Packaging for each unit", "Sales commission per unit"], "Fixed costs do not change with output in the short run."],
    ["Marketing", "The 4Ps of the marketing mix are product, price, place and…", "Promotion", ["Profit", "People management", "Production"], "Promotion covers how the offer is communicated."],
    ["HR", "What does an organisation chart primarily show?", "Reporting relationships and roles", ["Monthly cash balances", "Product prices", "Customer satisfaction scores"], "It maps who reports to whom."],
  ],
  2: [
    ["Finance", "A firm has high profit but cannot pay suppliers. Which report should it inspect first?", "Cash flow statement", ["Brand style guide", "Organisation chart", "Product catalogue"], "Accounting profit and available cash differ."],
    ["HR", "Which metric best measures employee retention?", "Share of employees remaining over the period", ["Total website visitors", "Monthly sales revenue", "Average invoice size"], "Retention follows the same employee cohort over time."],
    ["Operations", "What is the purpose of a reorder point?", "Trigger replenishment before inventory runs out", ["Set the annual tax rate", "Measure interview readiness", "Remove all safety stock"], "Reorder points account for demand during replenishment lead time."],
    ["Marketing", "A premium brand cuts price without changing positioning. What risk should it examine?", "Erosion of perceived value", ["Guaranteed lower production cost", "Automatic patent expiry", "A mandatory change in ownership"], "Price can signal brand positioning and quality."],
    ["Finance", "Gross margin is calculated as…", "(Revenue − cost of goods sold) ÷ revenue", ["Net profit ÷ total assets", "Revenue ÷ number of employees", "(Revenue − all expenses) ÷ equity"], "Gross margin shows what remains after direct costs."],
    ["Strategy", "Which tool compares internal strengths and weaknesses with external opportunities and threats?", "SWOT analysis", ["Balance sheet", "Gantt chart", "Payroll register"], "SWOT links internal capabilities to the external environment."],
    ["HR", "A job description should primarily specify…", "The role's purpose, responsibilities and requirements", ["The employee's personal hobbies", "The company's share price", "The manager's salary"], "It defines what the role must achieve and what it needs."],
  ],
  3: [
    ["Finance", "A product has positive contribution but a loss after allocated corporate costs. The first decision step is…", "Identify avoidable costs and capacity opportunity cost", ["Discontinue it immediately", "Ignore all fixed costs forever", "Raise allocated costs"], "Relevant-cost decisions consider costs and benefits that change."],
    ["Marketing", "Customer acquisition cost is rising. What evidence best tests a targeting problem?", "Conversion and lifetime value by acquisition segment", ["Logo colour preference alone", "Employee birthdays", "The age of office furniture"], "Segment-level outcomes distinguish targeting from aggregate trends."],
    ["Operations", "A bottleneck limits output. Which measure guides product mix?", "Contribution per unit of the bottleneck resource", ["Sales price alone", "Allocated rent per employee", "The number of product colours"], "Scarce capacity should generate the most incremental contribution."],
    ["HR", "Which evaluation best supports a training programme decision?", "Compare a relevant outcome before and after with a suitable comparison group", ["Count slides only", "Use attendance as proof of learning", "Assume all later growth was caused by training"], "A comparison helps distinguish programme effects from other changes."],
    ["Marketing", "Which pricing approach sets price mainly from the value customers perceive?", "Value-based pricing", ["Cost-plus pricing", "Competitor-matching pricing", "Penetration pricing"], "Value-based pricing starts from customer willingness to pay."],
    ["Finance", "Days sales outstanding rising steadily most likely signals that…", "Customers are taking longer to pay", ["Inventory is selling faster", "Fixed costs have fallen", "Suppliers are being paid earlier"], "DSO measures how long receivables take to collect."],
    ["Strategy", "Which statement about Porter's five forces is correct?", "It assesses industry attractiveness through rivalry, entry threat, substitutes and buyer and supplier power", ["It ranks employees by performance", "It is a cash-flow forecasting method", "It measures brand awareness only"], "The five forces explain industry profit potential."],
  ],
  4: [
    ["Strategy", "A firm enters a new market with high uncertainty. What reduces irreversible risk?", "A staged pilot with explicit stop/expand criteria", ["Commit all capacity immediately", "Ignore competitor response", "Use revenue as the only measure"], "Staged investment preserves options while generating evidence."],
    ["Marketing", "A pricing experiment increases revenue but reduces retention. What should be assessed?", "Incremental lifetime contribution and segment effects", ["Revenue alone", "The number of campaign emails", "Only average order value"], "Short-term gains must be evaluated against longer-term value."],
    ["Operations", "A service promises faster delivery. Which operational trade-off matters most?", "Capacity, variability and cost of the promised service level", ["Font size in the annual report", "The CEO's travel history", "The number of legal entities alone"], "Reliable service depends on capacity and demand variability."],
    ["Operations", "Why can a high inventory turnover ratio still be problematic?", "Stockouts may be sacrificing sales and service", ["It proves demand is zero", "It guarantees maximum profit", "It means suppliers are never paid"], "Efficiency ratios need service-level context."],
    ["Finance", "A firm's return on capital employed is below its cost of capital. What does this indicate?", "The business is not creating economic value on the capital it uses", ["Profit must be negative", "The firm has no debt", "Market share must be falling"], "Value is created only when returns exceed the cost of capital."],
    ["HR", "When is a matrix organisation structure most likely to help?", "When projects need specialists from several functions to coordinate closely", ["When every decision must follow one chain of command", "When the firm sells a single product in one market", "When teams should avoid sharing resources"], "Matrix structures trade clarity for cross-functional coordination."],
    ["Operations", "A supplier offers a lower unit price but longer, less reliable lead times. What should a total-cost analysis include?", "Inventory holding, stockout risk and expediting costs alongside the price", ["Unit price only", "The supplier's logo", "Only the payment currency"], "Total cost of ownership includes the cost of unreliability."],
  ],
  5: [
    ["Finance", "Two projects have equal expected returns but different downside exposure. A sound recommendation should…", "Compare scenario cash flows, risk tolerance and strategic constraints", ["Choose the larger headline return rounded to an integer", "Ignore financing and timing", "Assume the expected outcome is guaranteed"], "Investment decisions need uncertainty, timing and constraints."],
    ["Strategy", "An acquisition's projected synergies depend on retaining key staff. The strongest due-diligence question is…", "Which retention and integration assumptions drive the valuation, and how sensitive is value to them?", ["Can the logo be changed tomorrow?", "Is the acquisition price a round number?", "How many pages are in the brochure?"], "Test the assumptions that materially determine value."],
    ["Strategy", "A recommendation performs well on average but fails under a plausible capacity shock. What should the answer include?", "A sensitivity analysis, mitigation and a decision trigger", ["Only the base-case profit", "A claim that forecasts are facts", "Removal of the shock from the analysis"], "Robust recommendations explain when they should change."],
    ["HR", "A workforce model improves efficiency but creates unequal impacts. Management should…", "Evaluate affected groups, constraints and alternatives before rollout", ["Ignore distributional effects", "Treat correlation as proof of individual performance", "Use the model without review"], "Responsible decisions evaluate both outcomes and assumptions."],
    ["Strategy", "A business unit has a high market share in a slow-growing market. In BCG-matrix terms it is a…", "Cash cow", ["Question mark", "Star", "Dog"], "High share in a low-growth market typically generates surplus cash."],
    ["Finance", "Why is NPV usually preferred to the payback period for investment decisions?", "NPV accounts for the time value of all cash flows over the project's life", ["Payback is always longer", "NPV ignores the discount rate", "Payback includes cash flows after recovery"], "Payback ignores timing within the period and everything after it."],
    ["HR", "A change programme meets resistance from experienced staff. Which response is most effective?", "Involve them in diagnosing problems, explain the rationale and address specific concerns", ["Announce the change and penalise objections", "Delay all communication until rollout", "Exclude experienced staff from the process"], "Participation and transparency reduce resistance."],
  ],
};
const MANAGEMENT_WRITTEN = {
  4: ["Operations", "A retail chain's inventory has grown 30% while sales are flat. Explain how you would diagnose the cause and two actions you would consider.", ["Compares inventory growth by category, store or SKU against sales to locate the build-up", "Checks forecasting accuracy, ordering policies, lead times or minimum order quantities", "Identifies slow-moving or obsolete stock and its ageing", "Proposes actions such as revising reorder points or forecasts, clearing slow stock or renegotiating order sizes", "Names a measure to track improvement, such as turnover or days of inventory"], "Diagnose where and why stock accumulated before acting."],
  5: ["Strategy", "Your company must choose between expanding an existing product line and entering a new market. Outline how you would structure the recommendation.", ["Defines the objective and decision criteria such as NPV, risk and strategic fit", "Compares market attractiveness and competitive position for both options", "Estimates investment, cash flows and the key assumptions", "Assesses risks, capabilities and mitigation, including sensitivity analysis", "States a clear recommendation with next steps or decision triggers"], "Compare both options on the same criteria and commit to a recommendation."],
};

const GENERATED = { aptitude: APTITUDE, reasoning: REASONING, "data-interpretation": DATA };
const band = (pools, level) => pools[Math.max(...Object.keys(pools).map(Number).filter((k) => k <= level))];

/**
 * Questions, written items and minutes for a practice level. Written items
 * need AI grading, so `written: false` (no AI provider configured) keeps every
 * level completable with objective questions only.
 */
export function practiceFormat(category, level, { written = true } = {}) {
  if (!CATEGORIES[category] || !Number.isInteger(level) || level < 1 || level > 5)
    throw Error("Unknown practice level");
  const writtenItems = written && WRITTEN_LEVELS[category] && level >= WRITTEN_LEVELS[category] ? 1 : 0;
  const questions = GENERATED[category] || category === "case-analysis" ? 8 : 6 + writtenItems;
  return { questions, written: writtenItems, durationMinutes: 5 + level * 3 + writtenItems * 5 };
}
function unique(r, makers, count) {
  const items = [], seen = new Set();
  let order = [];
  for (let guard = 0; items.length < count && guard < count * 25; guard++) {
    if (!order.length) order = shuffle(r, makers);
    const item = order.shift()(r);
    if (seen.has(item.question)) continue;
    seen.add(item.question);
    items.push(item);
  }
  if (items.length < count) throw Error("Practice templates could not fill a paper");
  return items;
}

/**
 * Build a practice paper. With this bank version the same (category, level,
 * seed, options) rebuilds the same paper; a different seed changes numbers,
 * sampled items and option order. Served papers are stored, not rebuilt.
 */
export function practiceQuestions(category, level, seed = 0, options = {}) {
  const format = practiceFormat(category, level, options);
  const r = random(seed, `${category}:${level}`);
  let items;
  if (GENERATED[category]) {
    // Higher levels mix in two earlier-level templates, so papers vary in kind as well as numbers.
    const earlier = level > 1 ? shuffle(r, GENERATED[category][level - 1]).slice(0, 2) : [];
    items = unique(r, [...GENERATED[category][level], ...earlier], format.questions);
  }
  else if (category === "case-analysis") {
    const drivers = [MARKET_SIZING[level], PROFITABILITY[level], PRICING[level]];
    const concepts = shuffle(r, band(CASE_CONCEPTS, level)).slice(0, format.written ? 1 : 2);
    items = [
      ...unique(r, drivers, 6),
      ...concepts.map((item) => authored(r, item)),
      ...(format.written ? [written(...CASE_WRITTEN[level])] : []),
    ];
  } else {
    const pool = category === "management-basics" ? MANAGEMENT : COMMUNICATION;
    const extra = category === "management-basics" ? MANAGEMENT_WRITTEN : COMMUNICATION_WRITTEN;
    items = [
      ...shuffle(r, pool[level]).slice(0, 6).map((item) => authored(r, item)),
      ...(format.written ? [written(...extra[level])] : []),
    ];
  }
  const ordered = format.written ? [...shuffle(r, items.filter((q) => q.type === "mcq")), ...items.filter((q) => q.type === "short")] : shuffle(r, items);
  return ordered.map((q, index) => ({ id: "q" + (index + 1), ...q }));
}
