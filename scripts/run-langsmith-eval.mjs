// 4W 평가 매트릭스(질문/기준답변)를 LangSmith 데이터셋에 올리고,
// gpt-4o-mini 채점자(correctness 0/0.5/1)로 평가하는 스크립트.
//
// 문항 기준판은 저장소의 scripts/eval/qode-4w-eval.csv 다. 시트는 편집용이고,
// 시트 갱신분을 쓰려면 SHEET_CSV_URL을 준다 (그때만 시트의 Qode 답변 열도 읽는다).
//
// 결과는 볼트 40-기록/측정/ 에 회차 노트로 남긴다 — 재현 조건(코드 SHA·threshold·top_k)을 함께 적을 것.
//
// 사용법:
//   라이브 모드 — 실서비스에 질문을 새로 던져 최신 답변을 채점 (기본 사용법):
//     LIVE=1 TOKEN=<액세스토큰> PROJECT_ID=<프로젝트uuid> BASE_URL=http://localhost:3000 \
//       LANGSMITH_API_KEY=<키> OPENAI_API_KEY=<키> node scripts/run-langsmith-eval.mjs
//   시트에 저장된 Qode 답변 채점:
//     SHEET_CSV_URL=<시트 export CSV URL> \
//       LANGSMITH_API_KEY=<키> OPENAI_API_KEY=<키> node scripts/run-langsmith-eval.mjs
//
// 결과: LangSmith 실험 링크(터미널 출력) + scripts/eval-results-<타임스탬프>.csv

import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "langsmith";
import { evaluate } from "langsmith/evaluation";

// 기준판은 저장소의 scripts/eval/qode-4w-eval.csv 다 — 문항이 바뀌면 커밋으로 남는다.
// 시트는 편집용이고, SHEET_CSV_URL을 주면 그쪽을 읽는다 (시트 갱신분을 내려받을 때).
const DATASET_CSV = new URL("./eval/qode-4w-eval.csv", import.meta.url);
const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
const DATASET_NAME = "qode-4w-eval";
// 시트 레이아웃: 영역별 시작 컬럼 (질문, 기준답변, AI답변, Qode답변, 일치율 순)
const AREAS = { What: 2, Why: 7, How: 12, Where: 17 };

const { LANGSMITH_API_KEY, OPENAI_API_KEY } = process.env;
if (!LANGSMITH_API_KEY || !OPENAI_API_KEY) {
  console.error("LANGSMITH_API_KEY, OPENAI_API_KEY 환경변수가 필요합니다.");
  process.exit(1);
}

// 기준판 CSV에는 Qode 답변이 없다. 빈 답으로 조용히 0점을 받는 대신 네트워크를 타기 전에 멈춘다.
if (process.env.LIVE !== "1" && !SHEET_CSV_URL) {
  console.error(
    "기준판 CSV에는 Qode 답변이 없습니다. LIVE=1 로 실서비스에 질문을 던지거나,\n" +
      "SHEET_CSV_URL 을 주어 시트의 답변 열을 읽으세요."
  );
  process.exit(1);
}

// --- 1. RFC4180 CSV 파서 (셀 안 줄바꿈/쉼표/따옴표 처리) ---
const parseCsv = (text) => {
  const rows = [[]];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") rows.at(-1).push(cell), (cell = "");
    else if (ch === "\n") rows.at(-1).push(cell), (cell = ""), rows.push([]);
    else if (ch !== "\r") cell += ch;
  }
  rows.at(-1).push(cell);
  return rows;
};

// --- 2. 데이터셋 로드 → 카드 80장 ---
const cards = [];
let skipped = 0;

if (SHEET_CSV_URL) {
  console.log("시트 다운로드 중...");
  const sheetRes = await fetch(SHEET_CSV_URL);
  if (!sheetRes.ok) throw new Error(`시트 다운로드 실패: ${sheetRes.status}`);
  for (const row of parseCsv(await sheetRes.text())) {
    if (!/^\d+$/.test(row[0]?.trim() ?? "")) continue; // 데이터 행만 (ID가 숫자)
    for (const [area, base] of Object.entries(AREAS)) {
      const question = row[base]?.trim();
      const reference = row[base + 1]?.trim();
      const qodeAnswer = row[base + 3]?.trim();
      if (!question || !reference || !qodeAnswer) {
        skipped++;
        continue;
      }
      cards.push({ id: `${row[0].trim()}-${area}`, area, question, reference, qodeAnswer });
    }
  }
} else {
  // 기준판 CSV: id,area,question,reference — Qode 답변은 측정 산출물이라 담지 않는다.
  const [header, ...rows] = parseCsv(readFileSync(DATASET_CSV, "utf-8")).filter((r) => r.length > 1);
  const col = Object.fromEntries(header.map((name, i) => [name.trim(), i]));
  for (const row of rows) {
    const question = row[col.question]?.trim();
    const reference = row[col.reference]?.trim();
    if (!question || !reference) {
      skipped++;
      continue;
    }
    cards.push({ id: row[col.id]?.trim(), area: row[col.area]?.trim(), question, reference });
  }
}
console.log(`카드 ${cards.length}장 생성 (빈 칸으로 건너뜀: ${skipped})`);
if (cards.length === 0) process.exit(1);

// --- 3. LangSmith 데이터셋 생성/재사용 ---
const client = new Client({ apiKey: LANGSMITH_API_KEY });
let dataset;
try {
  dataset = await client.readDataset({ datasetName: DATASET_NAME });
  console.log(`기존 데이터셋 재사용: ${DATASET_NAME} (시트를 바꿨다면 LangSmith에서 데이터셋 삭제 후 재실행)`);
} catch {
  dataset = await client.createDataset(DATASET_NAME, {
    description: "Qode 4W 평가 매트릭스 (질문 + 기준답변)",
  });
  await client.createExamples({
    datasetId: dataset.id,
    inputs: cards.map((c) => ({ question: c.question })),
    outputs: cards.map((c) => ({ reference: c.reference })),
    metadata: cards.map((c) => ({ id: c.id, area: c.area })),
  });
  console.log(`데이터셋 생성 및 예제 ${cards.length}개 업로드 완료`);
}

// --- 4. 타겟: 답안을 내는 함수 ---
// 기본: 시트에 이미 적힌 Qode 답변 제출. LIVE=1: 실서비스에 질문을 새로 던짐.
const byQuestion = new Map(cards.map((c) => [c.question, c]));
const LIVE = process.env.LIVE === "1";
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

const askLive = async (question) => {
  const headers = {
    Authorization: `Bearer ${process.env.TOKEN}`,
    "Content-Type": "application/json",
  };
  const chatRes = await fetch(`${BASE_URL}/api/chats/me`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      project_id: process.env.PROJECT_ID,
      chat_type: "PERSONAL",
      name: `eval-${Date.now() % 1e7}`,
    }),
  });
  if (!chatRes.ok) throw new Error(`채팅 생성 실패 ${chatRes.status}`);
  const chatId = (await chatRes.json()).data.id;

  const res = await fetch(`${BASE_URL}/api/chats/me/${chatId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: question }),
  });
  if (!res.ok) throw new Error(`메시지 전송 실패 ${res.status}`);

  let answer = "";
  let buffer = "";
  const handleEvent = (raw) => {
    const event = /^event: (.*)$/m.exec(raw)?.[1];
    const dataLine = /^data: (.*)$/m.exec(raw)?.[1];
    if (!event || dataLine === undefined) return;
    const data = JSON.parse(dataLine);
    if (event === "token") answer += data.token;
    else if (event === "error") throw new Error(data.message);
  };
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      handleEvent(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  return answer;
};

if (LIVE && (!process.env.TOKEN || !process.env.PROJECT_ID)) {
  console.error("LIVE=1 모드에는 TOKEN, PROJECT_ID 환경변수가 필요합니다.");
  process.exit(1);
}

const target = LIVE
  ? async (inputs) => ({ answer: await askLive(inputs.question) })
  : (inputs) => ({
      answer: byQuestion.get(inputs.question)?.qodeAnswer ?? "(시트에서 답변을 찾지 못함)",
    });

// --- 5. LLM 채점자 (gpt-4o-mini) ---
const judge = async ({ inputs, outputs, referenceOutputs, example }) => {
  const prompt = `당신은 채점자입니다. 질문에 대한 "제출된 답변"이 "기준 답변"과 사실관계가 일치하는지 채점하세요.

채점 기준:
- 1: 기준 답변의 핵심 내용과 사실관계가 일치 (표현이 달라도 됨)
- 0.5: 부분적으로 일치하나 핵심 일부가 빠지거나 부정확
- 0: 사실관계가 틀렸거나, "알 수 없다/정보가 없다"고 답함

[질문]
${inputs.question}

[기준 답변]
${referenceOutputs.reference}

[제출된 답변]
${outputs.answer}

JSON으로만 답하세요: {"score": 0 | 0.5 | 1, "reason": "판정 이유 한 문장"}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI 호출 실패 ${res.status}: ${await res.text()}`);
  const { score, reason } = JSON.parse((await res.json()).choices[0].message.content);

  const meta = example.metadata ?? {};
  localResults.push({
    id: meta.id ?? "?",
    area: meta.area ?? "?",
    question: inputs.question,
    score,
    reason,
  });
  console.log(`[${localResults.length}/${cards.length}] ${meta.id} → ${score} (${reason.slice(0, 40)})`);
  return { key: "correctness", score, comment: reason };
};

// --- 6. 평가 실행 ---
const localResults = [];
console.log("\n평가 실행 중 (gpt-4o-mini 채점)...");
await evaluate(target, {
  data: DATASET_NAME,
  evaluators: [judge],
  experimentPrefix: process.env.EXPERIMENT_PREFIX ?? (LIVE ? "qode-4w-live" : "qode-4w"),
  maxConcurrency: LIVE ? 3 : 5, // 라이브는 채팅 서버 부하를 고려해 낮춤
  client,
});

// --- 7. 로컬 CSV 저장 + 영역별 평균 ---
const csvCell = (v) => `"${String(v).replaceAll('"', '""')}"`;
const outFile = new URL(
  `./eval-results-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
  import.meta.url
).pathname;
localResults.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
writeFileSync(
  outFile,
  "﻿" +
    [["id", "area", "question", "score", "reason"], ...localResults.map((r) => [r.id, r.area, r.question, r.score, r.reason])]
      .map((r) => r.map(csvCell).join(","))
      .join("\n"),
  "utf8"
);

console.log("\n===== 영역별 일치율 (시트 상단에 붙여넣을 값) =====");
for (const area of Object.keys(AREAS)) {
  const scores = localResults.filter((r) => r.area === area).map((r) => r.score);
  const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length) * 100 : 0;
  console.log(`${area}: ${avg.toFixed(1)}% (${scores.length}문항)`);
}
const all = localResults.map((r) => r.score);
console.log(`종합: ${((all.reduce((a, b) => a + b, 0) / all.length) * 100).toFixed(1)}%`);
console.log(`\n로컬 결과 저장: ${outFile}`);
